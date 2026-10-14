import assert from "node:assert/strict";
import fs, { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSessionOwnershipIndex, sessionIdFromRolloutFilename, sessionIdFromThreadKey } from "#codex";
import type { MicroSnapshot } from "#agents";

const owned = "019f7336-04a2-72f1-af41-2f216ccdc3d0";
const mirrored = "019f6de7-44c2-7fe2-9d17-9322c952e626";

test("session ownership is derived from exact rollout filenames, not message references", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-ownership-"));
  try {
    const dated = join(root, "2026", "07", "18");
    await mkdir(dated, { recursive: true });
    await writeFile(join(dated, `rollout-2026-07-18T00-00-00-${owned}.jsonl`), "{}\n");
    await writeFile(join(dated, "rollout-containing-another-thread-reference.jsonl"), mirrored);
    const index = new CodexSessionOwnershipIndex([root], 60_000);
    const annotated = await index.annotate(snapshot());
    assert.equal(annotated.slots[0]!.ownedByHost, true);
    assert.equal(annotated.slots[1]!.ownedByHost, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout and prefixed thread identities use the same UUID", () => {
  assert.equal(sessionIdFromRolloutFilename(`rollout-time-${owned}.jsonl`), owned);
  assert.equal(sessionIdFromThreadKey(`local:${owned}`), owned);
  assert.equal(sessionIdFromThreadKey("local:../../secret"), null);
});

test("recent local rollout tails expose structural working and completion state without task contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-presence-"));
  try {
    const activeId = "10000000-0000-4000-8000-000000000001";
    const completeId = "10000000-0000-4000-8000-000000000002";
    await writeFile(
      join(root, `rollout-now-${activeId}.jsonl`),
      '{"type":"event_msg","payload":{"type":"agent_reasoning"}}\n',
    );
    await writeFile(
      join(root, `rollout-now-${completeId}.jsonl`),
      '{"type":"event_msg","payload":{"type":"agent_reasoning"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n',
    );
    const annotated = await new CodexSessionOwnershipIndex([root], 60_000).annotate(snapshot());
    const states = new Map(annotated.hostSessions?.map((session) => [session.threadId, session.status]));
    assert.equal(states.get(activeId), "working");
    assert.equal(states.get(completeId), "complete");
    const index = new CodexSessionOwnershipIndex([root], 60_000);
    const beforeOpen = await index.annotate(snapshot());
    assert.equal(beforeOpen.hostSessions?.find((session) => session.threadId === completeId)?.status, "complete");
    index.markOpened(`local:${completeId}`);
    const afterOpen = await index.annotate(snapshot());
    assert.equal(afterOpen.hostSessions?.find((session) => session.threadId === completeId)?.status, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current response_item records keep a long-running Codex task working after task_started leaves the tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-current-presence-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000009";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(
      path,
      '{"type":"event_msg","payload":{"type":"task_started"}}\n' +
        `${"x".repeat(520 * 1024)}\n` +
        '{"timestamp":"2026-07-21T20:00:00.000Z","type":"response_item","payload":{"type":"reasoning"}}\n' +
        '{"timestamp":"2026-07-21T20:00:01.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec"}}\n',
    );
    const now = Date.parse("2026-07-21T20:00:02.000Z");
    const annotated = await new CodexSessionOwnershipIndex([root], 0).annotate(snapshotFor(threadId, false), now);
    const session = annotated.hostSessions?.find((candidate) => candidate.threadId === threadId);
    assert.equal(session?.status, "working");
    assert.equal(session?.activityAt, Date.parse("2026-07-21T20:00:01.000Z"));
    assert.equal(annotated.slots[0]!.status, "working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only structural user_message records advance the content-free work-start pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-work-start-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000011";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    const first =
      '{"timestamp":"2026-07-21T20:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"private"}}\n';
    await writeFile(
      path,
      first +
        '{"timestamp":"2026-07-21T20:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}\n' +
        '{"timestamp":"2026-07-21T20:00:02.000Z","type":"event_msg","payload":{"type":"agent_reasoning"}}\n' +
        '{"timestamp":"2026-07-21T20:00:03.000Z","type":"event_msg","payload":{"type":"thread_name_updated"}}\n' +
        '{"timestamp":"2026-07-21T20:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant"}}\n',
    );
    const index = new CodexSessionOwnershipIndex([root], 0);
    let annotated = await index.annotate(snapshotFor(threadId, true), Date.parse("2026-07-21T20:00:05.000Z"));
    let session = annotated.hostSessions?.find((candidate) => candidate.threadId === threadId);
    assert.equal(session?.workStartedAt, Date.parse("2026-07-21T20:00:00.000Z"));
    assert.equal(session?.workStartRevision, 0);
    assert.equal(annotated.slots[0]!.workStartedAt, session?.workStartedAt);
    assert.equal(annotated.slots[0]!.workStartRevision, session?.workStartRevision);

    const second =
      '{"timestamp":"2026-07-21T20:01:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"more private"}}\n';
    await appendFile(path, second);
    annotated = await index.annotate(snapshotFor(threadId, false), Date.parse("2026-07-21T20:01:01.000Z"));
    session = annotated.hostSessions?.find((candidate) => candidate.threadId === threadId);
    assert.equal(session?.workStartedAt, Date.parse("2026-07-21T20:01:00.000Z"));
    assert.equal(
      session?.workStartRevision,
      Buffer.byteLength(
        first +
          '{"timestamp":"2026-07-21T20:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}\n' +
          '{"timestamp":"2026-07-21T20:00:02.000Z","type":"event_msg","payload":{"type":"agent_reasoning"}}\n' +
          '{"timestamp":"2026-07-21T20:00:03.000Z","type":"event_msg","payload":{"type":"thread_name_updated"}}\n' +
          '{"timestamp":"2026-07-21T20:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant"}}\n',
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("work-start retention survives tail rollover only in the observing process", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-work-start-tail-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000012";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    const startedAt = Date.parse("2026-07-21T20:00:00.000Z");
    await writeFile(
      path,
      '{"timestamp":"2026-07-21T20:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"private"}}\n' +
        '{"timestamp":"2026-07-21T20:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}\n',
    );
    const index = new CodexSessionOwnershipIndex([root], 0);
    let annotated = await index.annotate(snapshotFor(threadId, false), startedAt + 2_000);
    assert.equal(annotated.hostSessions?.find((session) => session.threadId === threadId)?.workStartedAt, startedAt);

    await appendFile(
      path,
      `${"x".repeat(520 * 1024)}\n` +
        '{"timestamp":"2026-07-21T20:01:00.000Z","type":"response_item","payload":{"type":"reasoning"}}\n',
    );
    annotated = await index.annotate(snapshotFor(threadId, false), startedAt + 61_000);
    const retained = annotated.hostSessions?.find((session) => session.threadId === threadId);
    assert.deepEqual(
      { workStartedAt: retained?.workStartedAt, workStartRevision: retained?.workStartRevision },
      { workStartedAt: startedAt, workStartRevision: 0 },
    );

    const expired = await index.annotate(snapshotFor(threadId, false), startedAt + 61_001 + 24 * 60 * 60_000);
    assert.equal(expired.hostSessions?.find((session) => session.threadId === threadId)?.workStartedAt, undefined);

    const cold = await new CodexSessionOwnershipIndex([root], 0).annotate(
      snapshotFor(threadId, false),
      startedAt + 62_000,
    );
    const coldSession = cold.hostSessions?.find((session) => session.threadId === threadId);
    assert.equal(coldSession?.workStartedAt, undefined);
    assert.equal(coldSession?.workStartRevision, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked off-six catalog candidates receive the exact owner's work-start pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-work-start-catalog-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000013";
    await writeFile(
      join(root, `rollout-now-${threadId}.jsonl`),
      '{"timestamp":"2026-07-21T20:00:00.000Z","type":"event_msg","payload":{"type":"user_message"}}\n',
    );
    const value = snapshot();
    value.activeCatalog = {
      complete: true,
      candidates: [
        {
          threadKey: `local:${threadId}`,
          conversationId: threadId,
          title: "Off six",
          status: "working",
          selected: false,
          catalogIndex: 9,
        },
      ],
    };
    const annotated = await new CodexSessionOwnershipIndex([root], 0).annotate(
      value,
      Date.parse("2026-07-21T20:00:01.000Z"),
    );
    assert.equal(annotated.activeCatalog?.candidates[0]?.workStartedAt, Date.parse("2026-07-21T20:00:00.000Z"));
    assert.equal(annotated.activeCatalog?.candidates[0]?.workStartRevision, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old completion uses its event timestamp and cannot flash as newly complete after a file touch", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-stale-completion-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000010";
    await writeFile(
      join(root, `rollout-now-${threadId}.jsonl`),
      '{"timestamp":"2026-07-21T19:00:00.000Z","type":"event_msg","payload":{"type":"task_started"}}\n' +
        '{"timestamp":"2026-07-21T19:01:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}\n' +
        '{"timestamp":"2026-07-21T20:00:00.000Z","type":"event_msg","payload":{"type":"thread_settings_applied"}}\n',
    );
    const now = Date.parse("2026-07-21T20:00:01.000Z");
    const annotated = await new CodexSessionOwnershipIndex([root], 0).annotate(snapshotFor(threadId, false), now);
    const session = annotated.hostSessions?.find((candidate) => candidate.threadId === threadId);
    assert.equal(session?.status, "idle");
    assert.equal(session?.activityAt, Date.parse("2026-07-21T19:01:00.000Z"));
    assert.equal(annotated.slots[0]!.status, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged rollout parsing keeps freshness and invalidates on append, replacement, truncation and removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-rollout-invalidation-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000015";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    const now = Date.parse("2026-07-21T20:00:00.000Z");
    let complete = '{"timestamp":"2026-07-21T20:00:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}\n';
    const working = '{"timestamp":"2026-07-21T20:00:00.000Z","type":"event_msg","payload":{"type":"task_started" }}\n';
    assert.equal(Buffer.byteLength(complete), Buffer.byteLength(working));
    await writeFile(path, complete);
    const index = new CodexSessionOwnershipIndex([root], 0);
    const value = snapshotFor(threadId, false);
    assert.equal((await index.annotate(value, now + 1)).slots[0]!.status, "complete");
    assert.equal((await index.annotate(value, now + 2)).slots[0]!.status, "complete");
    assert.equal((await index.annotate(value, now + 300_001)).slots[0]!.status, "idle");

    await appendFile(path, working);
    assert.equal((await index.annotate(value, now + 300_002)).slots[0]!.status, "working");
    complete = complete.replace("20:00:00", "20:05:00");
    await writeFile(path, complete);
    assert.equal((await index.annotate(value, now + 300_003)).slots[0]!.status, "complete");

    // Replacing a file may preserve its length and modification time. Its
    // identity must still invalidate the old parsed completion.
    const previous = await stat(path);
    const replacement = join(root, "replacement.jsonl");
    await writeFile(replacement, working);
    await utimes(replacement, previous.atime, previous.mtime);
    await rename(replacement, path);
    assert.equal((await index.annotate(value, now + 300_004)).slots[0]!.status, "working");
    await writeFile(path, "{}\n");
    assert.equal((await index.annotate(value, now + 300_005)).slots[0]!.status, "idle");
    await rm(path);
    const removed = await index.annotate(value, now + 300_006);
    assert.equal(removed.slots[0]!.ownedByHost, false);
    assert.equal(
      removed.hostSessions?.some((session) => session.threadId === threadId),
      false,
    );
    await writeFile(path, complete);
    assert.equal((await index.annotate(value, now + 300_007)).slots[0]!.status, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["open error", "short read"] as const) {
  test(`an unchanged rollout is retried after a transient ${failure}`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "codex-deck-rollout-read-retry-"));
    const originalOpen = fs.open;
    let failNextRead = true;
    const mockedOpen = context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (failNextRead && failure === "open error") {
        failNextRead = false;
        throw new Error("Synthetic transient read failure");
      }
      const handle = await originalOpen(...args);
      if (failNextRead) {
        failNextRead = false;
        const originalRead = handle.read.bind(handle);
        context.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) =>
          originalRead(buffer, offset, Math.floor(length / 2), position),
        );
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const threadId = "10000000-0000-4000-8000-000000000016";
      await writeFile(
        join(root, `rollout-now-${threadId}.jsonl`),
        '{"type":"event_msg","payload":{"type":"task_started"}}\n',
      );
      const index = new CodexSessionOwnershipIndex([root], 0);
      const value = snapshotFor(threadId, false);
      assert.equal((await index.annotate(value, 1_000)).slots[0]!.status, "idle");
      assert.equal((await index.annotate(value, 1_001)).slots[0]!.status, "working");
    } finally {
      mockedOpen.mock.restore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const change of ["replacement", "append"] as const) {
  test(`a rollout ${change} between scan and open is retried before successful reuse`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "codex-deck-rollout-scan-race-"));
    const threadId = "10000000-0000-4000-8000-000000000017";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    const originalOpen = fs.open;
    let changeBeforeOpen = true;
    let reads = 0;
    const complete = '{"type":"event_msg","payload":{"type":"task_complete"}}\n';
    const mockedOpen = context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (changeBeforeOpen) {
        changeBeforeOpen = false;
        if (change === "replacement") {
          await writeFile(`${path}.replacement`, complete);
          await rename(`${path}.replacement`, path);
        } else {
          await appendFile(path, complete);
        }
      }
      const handle = await originalOpen(...args);
      const originalRead = handle.read.bind(handle);
      context.mock.method(handle, "read", async (...values: Parameters<typeof handle.read>) => {
        reads += 1;
        return originalRead(...values);
      });
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await writeFile(path, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
      const index = new CodexSessionOwnershipIndex([root], 0);
      const value = snapshotFor(threadId, false);
      assert.equal((await index.annotate(value, Date.now())).slots[0]!.status, "complete");
      assert.equal((await index.annotate(value, Date.now() + 1)).slots[0]!.status, "complete");
      // The scan did not describe the opened file. Retry once instead of
      // retaining that raced observation, then reuse the stable successful read.
      assert.equal(reads, 2);
      assert.equal((await index.annotate(value, Date.now() + 2)).slots[0]!.status, "complete");
      assert.equal(reads, 2);
    } finally {
      mockedOpen.mock.restore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("rollout token counts expose bounded per-thread context usage without task content", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-context-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000006";
    const tokenCount = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 99_999_999 },
          last_token_usage: { total_tokens: 80_000 },
          model_context_window: 100_000,
        },
      },
    });
    await writeFile(join(root, `rollout-now-${threadId}.jsonl`), `${tokenCount}\n`);
    const value = snapshotFor(threadId, false);
    const annotated = await new CodexSessionOwnershipIndex([root], 60_000).annotate(value);
    assert.equal(annotated.slots[0]!.contextUsedPercent, 80);
    assert.equal(annotated.hostSessions?.find((session) => session.threadId === threadId)?.contextUsedPercent, 80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a renderer turn_context after task_complete does not resurrect a finished task", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-lifecycle-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000007";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(
      path,
      '{"type":"event_msg","payload":{"type":"task_started"}}\n' +
        '{"type":"event_msg","payload":{"type":"task_complete"}}\n' +
        '{"type":"turn_context","payload":{"type":"turn_context"}}\n',
    );
    const index = new CodexSessionOwnershipIndex([root], 0);
    let state = await index.annotate(snapshotFor(threadId, false), Date.now());
    assert.equal(state.hostSessions?.find((session) => session.threadId === threadId)?.status, "complete");

    await appendFile(path, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    state = await index.annotate(snapshotFor(threadId, false), Date.now() + 1);
    assert.equal(state.hostSessions?.find((session) => session.threadId === threadId)?.status, "working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn_aborted returns an owned task to idle until the next task_started", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-aborted-turn-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000014";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(
      path,
      '{"type":"event_msg","payload":{"type":"task_started"}}\n' +
        '{"type":"event_msg","payload":{"type":"turn_aborted"}}\n',
    );
    const index = new CodexSessionOwnershipIndex([root], 0);
    let state = await index.annotate(snapshotFor(threadId, false), Date.now());
    assert.equal(state.hostSessions?.find((session) => session.threadId === threadId)?.status, "idle");
    assert.equal(state.slots[0]!.status, "idle");

    await appendFile(path, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    state = await index.annotate(snapshotFor(threadId, false), Date.now() + 1);
    assert.equal(state.hostSessions?.find((session) => session.threadId === threadId)?.status, "working");
    assert.equal(state.slots[0]!.status, "working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acknowledging a completion survives later file touches but a new completion becomes unread", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-completion-ack-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000003";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(path, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    const index = new CodexSessionOwnershipIndex([root], 0);
    const first = await index.annotate(snapshotFor(threadId, false), Date.now());
    assert.equal(first.hostSessions?.find((session) => session.threadId === threadId)?.status, "complete");

    const selected = await index.annotate(snapshotFor(threadId, true), Date.now() + 1);
    assert.equal(selected.hostSessions?.find((session) => session.threadId === threadId)?.status, "idle");
    await appendFile(path, '{"type":"event_msg","payload":{"type":"thread_opened"}}\n');
    const afterTouch = await index.annotate(snapshotFor(threadId, false), Date.now() + 2);
    assert.equal(afterTouch.hostSessions?.find((session) => session.threadId === threadId)?.status, "idle");

    await appendFile(
      path,
      '{"type":"event_msg","payload":{"type":"agent_reasoning"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n',
    );
    const nextCompletion = await index.annotate(snapshotFor(threadId, false), Date.now() + 3);
    assert.equal(nextCompletion.hostSessions?.find((session) => session.threadId === threadId)?.status, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the active renderer task acknowledges completion outside the six Micro slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-active-thread-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000004";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(path, '{"type":"event_msg","payload":{"type":"agent_reasoning"}}\n');
    const index = new CodexSessionOwnershipIndex([root], 0);
    const value = snapshot();
    value.activeThreadKey = `local:${threadId}`;
    assert.equal(
      (await index.annotate(value, Date.now())).hostSessions?.find((session) => session.threadId === threadId)?.status,
      "working",
    );
    await appendFile(path, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    assert.equal(
      (await index.annotate(value, Date.now() + 1)).hostSessions?.find((session) => session.threadId === threadId)
        ?.status,
      "idle",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned rollout lifecycle clears stale native working and unread colors", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-native-status-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000008";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(path, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    const index = new CodexSessionOwnershipIndex([root], 0);
    const value = snapshotFor(threadId, false);
    value.slots[0]!.status = "working";
    assert.equal((await index.annotate(value, Date.now())).slots[0]!.status, "complete");

    value.activeThreadKey = `local:${threadId}`;
    value.slots[0]!.status = "unread";
    const active = await index.annotate(value, Date.now() + 1);
    assert.equal(active.hostSessions?.find((session) => session.threadId === threadId)?.status, "idle");
    assert.equal(active.slots[0]!.status, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog ownership uses only trusted conversation ids and selected catalog tasks acknowledge completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-catalog-ownership-"));
  try {
    const conversationId = "10000000-0000-4000-8000-000000000088";
    const temporarySuffix = "10000000-0000-4000-8000-000000000089";
    await writeFile(
      join(root, `rollout-now-${conversationId}.jsonl`),
      '{"type":"event_msg","payload":{"type":"task_complete"}}\n',
    );
    await writeFile(
      join(root, `rollout-now-${temporarySuffix}.jsonl`),
      '{"type":"event_msg","payload":{"type":"task_complete"}}\n',
    );
    const index = new CodexSessionOwnershipIndex([root], 0);
    const value = snapshot();
    value.activeCatalog = {
      complete: true,
      candidates: [
        {
          threadKey: `local:${conversationId}`,
          conversationId,
          title: "Owned",
          status: "unread",
          selected: true,
          catalogIndex: 7,
        },
        {
          threadKey: `local:client-new-thread:${temporarySuffix}`,
          title: "Temporary",
          status: "working",
          selected: true,
          catalogIndex: 8,
        },
      ],
    };

    const annotated = await index.annotate(value, Date.now());
    assert.equal(annotated.activeCatalog!.candidates[0]!.ownedByHost, true);
    assert.equal(annotated.activeCatalog!.candidates[0]!.status, "idle");
    assert.equal(annotated.activeCatalog!.candidates[1]!.ownedByHost, false);
    assert.equal(annotated.hostSessions!.find((session) => session.threadId === temporarySuffix)!.status, "complete");
    index.markOpened(`local:client-new-thread:${temporarySuffix}`, null);
    const afterDirectOpen = await index.annotate(value, Date.now() + 1);
    assert.equal(
      afterDirectOpen.hostSessions!.find((session) => session.threadId === temporarySuffix)!.status,
      "complete",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing tracked catalog identity is negatively cached until the planned refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-negative-cache-"));
  try {
    const index = new CodexSessionOwnershipIndex([root], 60_000);
    const internal = index as unknown as {
      refresh: (now: number, tracked: Set<string>) => Promise<void>;
    };
    const originalRefresh = internal.refresh.bind(index);
    let scans = 0;
    internal.refresh = async (now, tracked) => {
      scans += 1;
      await originalRefresh(now, tracked);
    };
    const value = snapshot();
    value.activeCatalog = {
      complete: true,
      candidates: [
        {
          threadKey: "remote:10000000-0000-4000-8000-000000000090",
          conversationId: "10000000-0000-4000-8000-000000000090",
          title: "Remote only",
          status: "working",
          selected: false,
          catalogIndex: 0,
        },
      ],
    };

    await index.annotate(value, 1_000);
    await index.annotate(value, 1_001);
    assert.equal(scans, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked catalogs beyond the cache bound keep all outcomes and the newest duplicate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-tracked-old-"));
  const originalOpen = fs.open;
  let reads = 0;
  const mockedOpen = context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    context.mock.method(handle, "read", async (...values: Parameters<typeof handle.read>) => {
      reads += 1;
      return originalRead(...values);
    });
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const now = Date.parse("2026-07-21T20:00:00.000Z");
    const ids = Array.from({ length: 520 }, (_, index) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    for (const [index, id] of ids.entries()) {
      const path = join(root, `rollout-now-${id}.jsonl`);
      await writeFile(
        path,
        `{"timestamp":"2026-07-21T20:00:00.000Z","type":"event_msg","payload":{"type":"${index % 2 ? "task_complete" : "task_started"}"}}\n`,
      );
      await utimes(path, now / 1000, index === 0 ? 1 : (now - 520 + index) / 1000);
    }
    const duplicate = join(root, `rollout-old-${ids[0]}.jsonl`);
    await writeFile(duplicate, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    await utimes(duplicate, 0.5, 0.5);
    const value = snapshot();
    value.activeCatalog = {
      complete: true,
      candidates: ids.map((id, catalogIndex) => ({
        threadKey: `local:${id}`,
        conversationId: id,
        title: "Tracked",
        status: "working",
        selected: false,
        catalogIndex,
      })),
    };

    const index = new CodexSessionOwnershipIndex([root], 0);
    const annotated = await index.annotate(value, now + 1);
    assert.deepEqual(
      annotated.hostSessions?.map((session) => session.threadId),
      ids.slice(-128).reverse(),
    );
    assert.deepEqual(
      annotated.activeCatalog?.candidates.map((candidate) => [candidate.ownedByHost, candidate.status]),
      ids.map((_, index) => [true, index % 2 ? "complete" : "working"]),
    );
    assert.equal(reads, 520);
    reads = 0;
    assert.deepEqual(await index.annotate(value, now + 2), annotated);
    // At most 512 successful tails may be retained, regardless of which
    // concurrent reads finish first. Unchanged retained tails must be reused.
    assert.ok(reads >= 8 && reads < 520, `expected bounded successful reuse, observed ${reads} reads`);
  } finally {
    mockedOpen.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

function snapshot(): MicroSnapshot {
  return {
    slots: Array.from({ length: 6 }, (_, id) => ({
      id,
      threadKey: `local:${id === 0 ? owned : id === 1 ? mirrored : `00000000-0000-4000-8000-00000000000${id}`}`,
      title: `Task ${id + 1}`,
      status: "idle",
      selected: false,
    })),
    layout: {
      version: 1,
      slots: {
        ACT06: { keycapId: "FAST" },
        ACT07: { keycapId: "APPR" },
        ACT08: { keycapId: "REJ" },
        ACT09: { keycapId: "SPLIT" },
        ACT10_ACT11: { keycapId: "CODEX" },
        ACT12: { keycapId: "CODEX" },
      },
      analogStick: { up: {}, right: {}, down: {}, left: {} },
    },
    agentSource: "recent",
    lightingAutoOff: "3-minutes",
    theme: "dark",
  };
}

function snapshotFor(threadId: string, selected: boolean): MicroSnapshot {
  const value = snapshot();
  value.slots[0] = { ...value.slots[0]!, threadKey: `local:${threadId}`, selected };
  return value;
}

test("fork retains committed acknowledgements, work starts and parsed tails without sharing mutable maps", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "deck-ownership-fork-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(syncBuiltinESMExports);
  const thread = "10000000-0000-4000-8000-000000000002";
  const path = join(root, `rollout-now-${thread}.jsonl`);
  const now = Date.now();
  const started = now - 1_000;
  await writeFile(
    path,
    JSON.stringify({
      timestamp: new Date(started).toISOString(),
      type: "event_msg",
      payload: { type: "user_message" },
    }) +
      "\n" +
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        type: "event_msg",
        payload: { type: "task_complete" },
      }) +
      "\n",
  );
  let opens = 0;
  const original = fs.open;
  context.mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
    opens++;
    return original(...args);
  }) as typeof fs.open);
  syncBuiltinESMExports();
  const index = new CodexSessionOwnershipIndex([root], 0);
  await index.annotate(snapshotFor(thread, false), now);
  const unacknowledged = index.fork();
  index.markOpened(thread);
  const sibling = await unacknowledged.annotate(snapshotFor(thread, false), now + 1);
  assert.equal(
    sibling.hostSessions?.find((item) => item.threadId === thread)?.status,
    "complete",
    "late old acknowledgements do not mutate a fork",
  );
  const retained = index.fork();
  const result = await retained.annotate(snapshotFor(thread, false), now + 2);
  assert.equal(result.hostSessions?.find((item) => item.threadId === thread)?.status, "idle");
  assert.equal(result.hostSessions?.find((item) => item.threadId === thread)?.workStartedAt, started);
  assert.equal(opens, 1, "unchanged tail is cached across both forks and rescans");
  await appendFile(
    path,
    "x".repeat(520 * 1024) +
      "\n" +
      JSON.stringify({
        timestamp: new Date(now + 3).toISOString(),
        type: "response_item",
        payload: { type: "reasoning" },
      }) +
      "\n",
  );
  const rollover = await retained.annotate(snapshotFor(thread, false), now + 4);
  assert.equal(rollover.hostSessions?.find((item) => item.threadId === thread)?.workStartedAt, started);
  assert.equal(rollover.hostSessions?.find((item) => item.threadId === thread)?.workStartRevision, 0);
});

test("fork during a newly discovered rollout read inherits only committed ownership and cached metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "deck-ownership-pending-fork-"));
  const committed = "10000000-0000-4000-8000-000000000002";
  const discovered = "10000000-0000-4000-8000-000000000003";
  const committedPath = join(root, `rollout-now-${committed}.jsonl`);
  const discoveredPath = join(root, `rollout-now-${discovered}.jsonl`);
  const now = Date.now();
  const started = now - 1_000;
  await writeFile(
    committedPath,
    JSON.stringify({
      timestamp: new Date(started).toISOString(),
      type: "event_msg",
      payload: { type: "user_message" },
    }) +
      "\n" +
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        type: "event_msg",
        payload: { type: "task_complete" },
      }) +
      "\n",
  );
  let releaseRead!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readReached!: () => void;
  const reading = new Promise<void>((resolve) => {
    readReached = resolve;
  });
  let committedReads = 0;
  const originalOpen = fs.open;
  const mockedOpen = context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    context.mock.method(handle, "read", async (...values: Parameters<typeof handle.read>) => {
      if (String(args[0]) === committedPath) committedReads++;
      if (String(args[0]) === discoveredPath) {
        readReached();
        await held;
      }
      return originalRead(...values);
    });
    return handle;
  });
  syncBuiltinESMExports();
  let pending: Promise<MicroSnapshot> | undefined;
  context.after(async () => {
    releaseRead();
    await pending;
    mockedOpen.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const index = new CodexSessionOwnershipIndex([root], 60_000);
  await index.annotate(snapshotFor(committed, true), now);
  await writeFile(discoveredPath, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
  pending = index.annotate(snapshotFor(discovered, false), now + 1);
  await reading;
  const fork = index.fork();
  const value = snapshotFor(committed, false);
  // An idle catalog candidate asks for ownership without forcing a new scan.
  value.activeCatalog = {
    complete: true,
    candidates: [
      {
        threadKey: `local:${discovered}`,
        conversationId: discovered,
        title: "Discovered but uncommitted",
        status: "idle",
        selected: false,
        catalogIndex: 0,
      },
    ],
  };
  const inherited = await fork.annotate(value, now + 2);
  assert.equal(
    inherited.activeCatalog?.candidates[0]?.ownedByHost,
    false,
    "a discovered filename cannot become owned before its metadata read commits",
  );
  assert.equal(inherited.slots[0]?.ownedByHost, true);
  const session = inherited.hostSessions?.find((item) => item.threadId === committed);
  assert.equal(session?.status, "idle", "the exact committed completion remains acknowledged");
  assert.equal(session?.workStartedAt, started);
  assert.equal(session?.workStartRevision, 0);
  assert.equal(
    inherited.hostSessions?.some((item) => item.threadId === discovered),
    false,
  );
  releaseRead();
  assert.equal((await pending).slots[0]?.ownedByHost, true, "the retired index finishes its own discovered session");
  assert.deepEqual(
    await fork.annotate(value, now + 3),
    inherited,
    "late file reads cannot alter the fork's committed observations",
  );
  await rm(discoveredPath);
  const rescanned = await fork.annotate(value, now + 60_001);
  assert.equal(rescanned.hostSessions?.find((item) => item.threadId === committed)?.status, "idle");
  assert.equal(rescanned.hostSessions?.find((item) => item.threadId === committed)?.workStartedAt, started);
  assert.equal(rescanned.hostSessions?.find((item) => item.threadId === committed)?.workStartRevision, 0);
  assert.equal(rescanned.activeCatalog?.candidates[0]?.ownedByHost, false);
  assert.equal(committedReads, 1, "the fork reuses the fully committed successful tail after a real rescan");
});
