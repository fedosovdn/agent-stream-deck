import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { setImmediate as yieldIO } from "node:timers/promises";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { T3CodeSource } from "#t3code";
import type { CodexHost } from "#agents";

const host: CodexHost = { hostId: "local", hostName: "Mac", platform: "darwin" };

test("authenticated T3 shell becomes a queue, acknowledges only the displayed revision and clears on failure", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-t3-"));
  const now = Date.now();
  const iso = (n: number) => new Date(n).toISOString();
  const thread = (id: string, status: string, completedAt: number | null = null) => ({
    id,
    title: `Task ${id}`,
    projectId: "project",
    archivedAt: null,
    settledAt: null,
    status,
    latestRunRequestedAt: iso(now - 1000),
    activityRunStartedAt: iso(now - 1000),
    latestRunCompletedAt: completedAt ? iso(completedAt) : null,
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
  });
  const working = thread("Case", "running");
  const done = thread("case", "completed", now);
  const approval = { ...thread("approval", "waiting"), pendingRuntimeRequest: { kind: "approval" } };
  let payload = {
    schemaVersion: 2,
    threads: [
      working,
      done,
      approval,
      thread("failed", "failed", now),
      { ...thread("viewed", "completed", now), lastVisitedAt: iso(now) },
      thread("old", "completed", now - 600000),
    ],
  };
  let fail = false;
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    assert.equal(req.url, "/api/orchestration/shell");
    assert.equal(req.headers["x-t3-orchestration-protocol"], "2");
    res.writeHead(fail ? 401 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const configPath = join(root, "config.json");
  const runtimePath = join(root, "runtime.json");
  await writeFile(configPath, JSON.stringify({ origin, token: "fixture-token" }), { mode: 0o600 });
  await writeFile(runtimePath, JSON.stringify({ version: 1, pid: process.pid, origin, port: address.port }));
  let opened = 0;
  const source = new T3CodeSource(() => {}, {
    configPath,
    runtimePath,
    foreground: async () => {
      opened++;
    },
  });
  try {
    source.syncDemand("Codex", host, false);
    await source.refresh();
    assert.equal(requests, 0);
    source.syncDemand("T3 Code", host, false);
    await refreshSnapshot(source);
    assert.equal(source.health.state, "ready");
    assert.deepEqual(
      source.slots.map((s) => [s.threadKey, s.status]),
      [
        ["Case", "working"],
        ["case", "unread"],
        ["approval", "approval"],
        ["failed", "error"],
      ],
    );
    await writeFile(
      configPath,
      JSON.stringify({ origin, token: "fixture-token", sshConnections: [{ host: "-invalid" }] }),
    );
    await refreshSnapshot(source);
    assert.equal(source.health.state, "degraded");
    assert.equal(source.slots.length, 4, "an unavailable SSH source must preserve the successful local snapshot");
    await writeFile(configPath, JSON.stringify({ origin, token: "fixture-token" }));
    await refreshSnapshot(source);
    const assignment = source.slots[1]!;
    assert.equal(await source.open(assignment, new AbortController().signal), true);
    assert.equal(opened, 1);
    assert.equal(
      source.slots.some((s) => s.threadKey === "case"),
      false,
    );
    done.latestRunCompletedAt = iso(now + 1);
    await refreshSnapshot(source);
    assert.equal(
      source.slots.some((s) => s.threadKey === "case"),
      true,
    );
    assert.equal(await source.open(assignment, new AbortController().signal), false);
    assert.equal(
      source.slots.some((s) => s.threadKey === "case"),
      true,
    );
    payload = { schemaVersion: 2, threads: [working] };
    fail = true;
    await refreshSnapshot(source);
    assert.equal(source.health.state, "degraded");
    assert.deepEqual([...source.slots], []);
    fail = false;
    await chmod(configPath, 0o644);
    const protectedRequests = requests;
    await refreshSnapshot(source);
    assert.equal(requests, protectedRequests);
    assert.equal(source.health.state, "degraded");
    await chmod(configPath, 0o600);
    await writeFile(configPath, JSON.stringify({ origin: "http://192.0.2.1:3773", token: "fixture-token" }));
    await refreshSnapshot(source);
    assert.equal(requests, protectedRequests);
    assert.equal(source.health.state, "degraded");
    source.syncDemand("OpenCode", host, false);
    fail = false;
    const previous = requests;
    await source.refresh();
    assert.equal(requests, previous);
  } finally {
    source.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function refreshSnapshot(source: T3CodeSource): Promise<void> {
  const previous = source.slots[0];
  const committed = new Promise<void>((resolve) => {
    const unsubscribe = source.subscribe(() => {
      if (
        source.health.state !== "connecting" &&
        (source.slots[0] !== previous || (source.health.state === "degraded" && !source.slots.length))
      ) {
        unsubscribe();
        resolve();
      }
    });
  });
  await source.refresh();
  await committed;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function shell(id: string, title: string, completedAt?: number) {
  return {
    schemaVersion: 2,
    threads: [
      {
        id,
        title,
        status: completedAt ? "completed" : "running",
        activityRunStartedAt: new Date(Date.now() - 1000).toISOString(),
        latestRunCompletedAt: completedAt ? new Date(completedAt).toISOString() : null,
      },
    ],
  };
}

test("T3 publishes and repeats local cycles while SSH is held without cancelling the remote request", {
  skip: process.platform === "win32",
}, async (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const root = await mkdtemp(join(tmpdir(), "deck-t3-independent-"));
  const configPath = join(root, "config.json");
  const runtimePath = join(root, "runtime.json");
  const origin = "http://127.0.0.1:3773";
  await writeFile(
    configPath,
    JSON.stringify({
      origin,
      token: "fixture-token",
      sshConnections: [{ host: "fixture-host", environmentId: "remote", token: "fixture-token" }],
    }),
    { mode: 0o600 },
  );
  await writeFile(runtimePath, JSON.stringify({ version: 1, pid: process.pid, origin }));
  let revision = 0;
  let aborted = false;
  let remoteRequests = 0;
  const localReturned = deferred<void>();
  const remoteStarted = deferred<void>();
  const release = deferred<void>();
  context.mock.method(globalThis, "fetch", async () => {
    localReturned.resolve();
    return Response.json(shell("local", `Local ${revision}`));
  });
  context.mock.method(childProcess, "spawn", (command: string, args: string[], options: { signal: AbortSignal }) => {
    assert.equal(command, "/usr/bin/ssh");
    assert.equal(args.includes("StrictHostKeyChecking=yes"), true);
    remoteRequests++;
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => void };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {};
    child.stdin.on("finish", async () => {
      remoteStarted.resolve();
      await release.promise;
      child.stdout.end(JSON.stringify(shell("remote-task", "Remote")));
      child.emit("close", 0);
    });
    options.signal.addEventListener("abort", () => {
      aborted = true;
      child.emit("error", new Error("aborted"));
    });
    return child;
  });
  syncBuiltinESMExports();
  const source = new T3CodeSource(() => {}, { configPath, runtimePath, foreground: async () => {} });
  let preparation: Promise<void> | undefined;
  try {
    source.syncDemand("T3 Code", host, false);
    preparation = source.refresh();
    await Promise.all([localReturned.promise, remoteStarted.promise]);
    for (let turn = 0; turn < 8; turn++) await yieldIO();
    assert.equal(source.slots[0]?.title, "Local 0", "ready local snapshot must publish before the held SSH response");
    await preparation;
    assert.equal(source.health.state, "connecting");
    const waitForTitle = (title: string) =>
      new Promise<void>((resolve) => {
        const unsubscribe = source.subscribe(() => {
          if (source.slots.some((slot) => slot.title === title)) {
            unsubscribe();
            resolve();
          }
        });
      });
    for (revision = 1; revision <= 3; revision++) {
      const published = waitForTitle(`Local ${revision}`);
      context.mock.timers.tick(1200);
      await source.refresh();
      await published;
    }
    assert.equal(aborted, false);
    assert.equal(remoteRequests, 1, "pending work must not overlap");
    const ready = new Promise<void>((resolve) => {
      const unsubscribe = source.subscribe(() => {
        if (source.health.state === "ready") {
          unsubscribe();
          resolve();
        }
      });
    });
    release.resolve();
    await ready;
    assert.deepEqual(
      source.slots.map((slot) => slot.threadKey),
      ["local", "ssh:remote:remote-task"],
    );
  } finally {
    source.stop();
    release.resolve();
    await preparation;
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

type RemoteJob = {
  input: { host: string; environmentId: string; token: string };
  signal: AbortSignal;
  finish: (payload: unknown, code?: number) => void;
};

async function t3Fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "deck-t3-lifecycle-"));
  const configPath = join(root, "config.json");
  const runtimePath = join(root, "runtime.json");
  const origin = "http://127.0.0.1:3773";
  const config = {
    origin,
    token: "fixture-token",
    sshConnections: [{ host: "fixture-host", environmentId: "remote", token: "fixture-token" }],
  };
  const save = async () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await save();
  await writeFile(runtimePath, JSON.stringify({ version: 1, pid: process.pid, origin }));
  const jobs: RemoteJob[] = [];
  const watchers = new Set<() => void>();
  const local = {
    payload: shell("local", "Local") as { schemaVersion: number; threads: unknown[] },
    status: 200,
    gate: undefined as Promise<Response> | undefined,
    requests: 0,
  };
  const localSignals: AbortSignal[] = [];
  context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    localSignals.push(init.signal!);
    local.requests++;
    return local.gate ?? Response.json(local.payload, { status: local.status });
  });
  context.mock.method(childProcess, "spawn", (command: string, args: string[], options: { signal: AbortSignal }) => {
    assert.equal(command, "/usr/bin/ssh");
    assert.equal(args.includes("StrictHostKeyChecking=yes"), true);
    assert.equal(args.includes("ClearAllForwardings=yes"), true);
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => void };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {};
    child.stdin.on("finish", () => {
      const input = JSON.parse(child.stdin.read().toString());
      jobs.push({
        input,
        signal: options.signal,
        finish(payload, code = 0) {
          child.stdout.end(JSON.stringify(payload));
          child.emit("close", code);
        },
      });
      for (const watcher of watchers) watcher();
    });
    options.signal.addEventListener("abort", () => child.emit("error", new Error("aborted")));
    return child;
  });
  syncBuiltinESMExports();
  const source = new T3CodeSource(() => {}, { configPath, runtimePath, foreground: async () => {} });
  const waitJob = (count: number) =>
    new Promise<RemoteJob>((resolve) => {
      const check = () => {
        if (jobs.length >= count) {
          watchers.delete(check);
          resolve(jobs[count - 1]!);
        }
      };
      watchers.add(check);
      check();
    });
  const wait = (predicate: () => boolean) =>
    new Promise<void>((resolve) => {
      const unsubscribe = source.subscribe(() => {
        if (predicate()) {
          unsubscribe();
          resolve();
        }
      });
      if (predicate()) {
        unsubscribe();
        resolve();
      }
    });
  return {
    source,
    config,
    save,
    configPath,
    runtimePath,
    jobs,
    local,
    localSignals,
    waitJob,
    wait,
    async close() {
      source.stop();
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("T3 pending snapshots keep observation time; empty success and failure clear only their environment", {
  skip: process.platform === "win32",
}, async (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const fixture = await t3Fixture(context);
  const { source, wait, waitJob, local } = fixture;
  try {
    source.syncDemand("All", host, false);
    const first = await waitJob(1);
    first.finish(shell("task", "Remote"));
    await wait(() => source.health.state === "ready");
    const remote = source.slots.find((slot) => slot.threadKey === "ssh:remote:task")!;
    const oldChangedAt = source.health.changedAt;
    context.mock.timers.tick(1200);
    await source.refresh();
    const second = await waitJob(2);
    await wait(() => source.slots[0]?.observedAt !== 0);
    assert.equal(
      source.slots.find((slot) => slot.threadKey === "ssh:remote:task"),
      remote,
    );
    assert.equal(remote.observedAt, 0);
    assert.equal(source.health.changedAt, oldChangedAt);
    assert.equal(source.health.state, "ready");
    second.finish({}, 1);
    await wait(() => source.health.state === "degraded");
    assert.deepEqual(
      source.slots.map((slot) => slot.threadKey),
      ["local"],
    );
    context.mock.timers.tick(1200);
    await source.refresh();
    (await waitJob(3)).finish(shell("task", "Recovered"));
    await wait(() => source.health.state === "ready");
    local.payload = { schemaVersion: 2, threads: [] };
    context.mock.timers.tick(1200);
    await source.refresh();
    const fourth = await waitJob(4);
    await wait(() => !source.slots.some((slot) => slot.threadKey === "local"));
    assert.deepEqual(
      source.slots.map((slot) => slot.title),
      ["Recovered"],
    );
    fourth.finish({ schemaVersion: 2, threads: [] });
    await wait(() => source.slots.length === 0);
    assert.equal(source.health.state, "ready");
  } finally {
    await fixture.close();
  }
});

test("T3 acknowledges the exact remote revision during a pending cycle without resurrecting it", {
  skip: process.platform === "win32",
}, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const fixture = await t3Fixture(context);
  const { source, wait, waitJob } = fixture;
  fixture.local.payload = shell("task", "Local done", 100_000);
  try {
    source.syncDemand("T3 Code", host, false);
    (await waitJob(1)).finish(shell("task", "Done", 100_000));
    await wait(() => source.health.state === "ready");
    const assignment = source.slots.find((slot) => slot.threadKey === "ssh:remote:task")!;
    context.mock.timers.tick(1200);
    await source.refresh();
    const pending = await waitJob(2);
    assert.equal(await source.open(assignment, new AbortController().signal), true);
    const committed = deferred<void>();
    const unsubscribe = source.subscribe(() => {
      unsubscribe();
      committed.resolve();
    });
    pending.finish(shell("task", "Done", 100_000));
    await committed.promise;
    for (let turn = 0; turn < 4; turn++) await yieldIO();
    assert.equal(
      source.slots.some((slot) => slot.threadKey === "ssh:remote:task"),
      false,
    );
    context.mock.timers.tick(1200);
    await source.refresh();
    (await waitJob(3)).finish(shell("task", "Done again", 100_001));
    await wait(() => source.slots.some((slot) => slot.title === "Done again"));
    assert.equal(await source.open(assignment, new AbortController().signal), false);
    assert.equal(source.slots.find((slot) => slot.title === "Done again")?.activityAt, 100_001);
  } finally {
    await fixture.close();
  }
});

test("T3 replacement, removal, disable and stop retire only their own pending generations", {
  skip: process.platform === "win32",
}, async (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const fixture = await t3Fixture(context);
  const { source, wait, waitJob, config, save } = fixture;
  try {
    source.syncDemand("T3 Code", host, false);
    const original = await waitJob(1);
    config.sshConnections[0]!.token = "new-token";
    await save();
    await source.refresh();
    const replacement = await waitJob(2);
    assert.equal(original.signal.aborted, true);
    assert.equal(replacement.signal.aborted, false);
    assert.equal(replacement.input.token, "new-token");
    original.finish(shell("task", "Obsolete"));
    await source.refresh();
    assert.equal(fixture.jobs.length, 2, "old finally must not clear the replacement's pending work");
    replacement.finish(shell("task", "Current"));
    await wait(() => source.slots.some((slot) => slot.title === "Current"));
    assert.equal(
      source.slots.some((slot) => slot.title === "Obsolete"),
      false,
    );
    config.sshConnections[0]!.host = "replacement-host";
    config.sshConnections[0]!.environmentId = "replacement";
    await save();
    await source.refresh();
    const renamed = await waitJob(3);
    assert.equal(
      source.slots.some((slot) => slot.threadKey === "ssh:remote:task"),
      false,
    );
    config.sshConnections = [];
    await save();
    await source.refresh();
    assert.equal(renamed.signal.aborted, true);
    assert.equal(
      source.slots.some((slot) => slot.taskSource === "t3code" && slot.threadKey?.startsWith("ssh:")),
      false,
    );
    config.sshConnections = [{ host: "fixture-host", environmentId: "remote", token: "fixture-token" }];
    await save();
    await source.refresh();
    const disabled = await waitJob(4);
    source.syncDemand("Codex", host, false);
    assert.equal(disabled.signal.aborted, true);
    assert.deepEqual([...source.slots], []);
    source.syncDemand("All", host, false);
    const stopped = await waitJob(5);
    source.stop();
    assert.equal(stopped.signal.aborted, true);
    source.syncDemand("All", host, false);
    const restarted = await waitJob(6);
    disabled.finish(shell("task", "Disabled"));
    stopped.finish(shell("task", "Stopped"));
    await source.refresh();
    assert.equal(fixture.jobs.length, 6);
    assert.equal(restarted.signal.aborted, false);
    restarted.finish(shell("task", "Restarted"));
    await wait(() => source.slots.some((slot) => slot.title === "Restarted"));
    assert.equal(
      source.slots.some((slot) => slot.title === "Disabled" || slot.title === "Stopped"),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("T3 admits eight SSH environments concurrently and rejects excess and duplicate registrations", {
  skip: process.platform === "win32",
}, async (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const fixture = await t3Fixture(context);
  const { source, wait, waitJob, config, save } = fixture;
  try {
    config.sshConnections = Array.from({ length: 8 }, (_, index) => ({
      host: `fixture-${index}`,
      environmentId: `remote-${index}`,
      token: "fixture-token",
    }));
    await save();
    source.syncDemand("All", host, false);
    await waitJob(8);
    assert.equal(fixture.jobs.length, 8);
    assert.ok(fixture.jobs.every((job) => !job.signal.aborted));
    await wait(() => source.slots[0]?.title === "Local");
    config.sshConnections.push({ host: "fixture-9", environmentId: "remote-9", token: "fixture-token" });
    await save();
    await source.refresh();
    assert.ok(fixture.jobs.every((job) => job.signal.aborted));
    assert.equal(source.health.state, "degraded");
    assert.deepEqual(
      source.slots.map((slot) => slot.threadKey),
      ["local"],
    );
    config.sshConnections = [
      { host: "fixture-host", environmentId: "remote", token: "fixture-token" },
      { host: "duplicate-host", environmentId: "remote", token: "fixture-token" },
    ];
    await save();
    await source.refresh();
    const admitted = await waitJob(9);
    assert.equal(fixture.jobs.length, 9);
    admitted.finish(shell("task", "Admitted"));
    await wait(() => source.slots.some((slot) => slot.title === "Admitted"));
    assert.equal(source.health.state, "degraded");
    context.mock.timers.tick(1200);
    await source.refresh();
    const cancelled = await waitJob(10);
    await chmod(fixture.configPath, 0o644);
    await source.refresh();
    assert.equal(cancelled.signal.aborted, true);
    assert.deepEqual([...source.slots], []);
    assert.equal(source.health.state, "degraded");
    assert.equal(fixture.jobs.length, 10);
  } finally {
    await fixture.close();
  }
});

test("T3 runtime disappearance retires a held local response without cancelling SSH", {
  skip: process.platform === "win32",
}, async (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const fixture = await t3Fixture(context);
  const { source, wait, waitJob, local } = fixture;
  const gate = deferred<Response>();
  try {
    local.gate = gate.promise;
    source.syncDemand("T3 Code", host, false);
    const remote = await waitJob(1);
    await source.refresh();
    for (let turn = 0; turn < 4; turn++) await yieldIO();
    assert.equal(fixture.localSignals.length, 1);
    await rm(fixture.runtimePath);
    await source.refresh();
    await wait(() => source.health.state === "degraded");
    assert.equal(fixture.localSignals[0]!.aborted, true);
    assert.equal(remote.signal.aborted, false);
    gate.resolve(Response.json(shell("local", "Obsolete local")));
    remote.finish(shell("task", "Remote survives"));
    await wait(() => source.slots.some((slot) => slot.title === "Remote survives"));
    assert.deepEqual(
      source.slots.map((slot) => slot.title),
      ["Remote survives"],
    );
    assert.equal(source.health.state, "degraded");
  } finally {
    gate.resolve(Response.json({ schemaVersion: 2, threads: [] }));
    await fixture.close();
  }
});

test("T3 rejects an oversized local response without erasing an authenticated remote snapshot", {
  skip: process.platform === "win32",
}, async (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const fixture = await t3Fixture(context);
  const { source, wait, waitJob, local } = fixture;
  try {
    source.syncDemand("All", host, false);
    (await waitJob(1)).finish(shell("task", "Remote"));
    await wait(() => source.health.state === "ready");
    const remote = source.slots.find((slot) => slot.threadKey === "ssh:remote:task");
    local.payload = shell("local", "x".repeat(2 * 1024 * 1024));
    context.mock.timers.tick(1200);
    await source.refresh();
    const pending = await waitJob(2);
    await wait(() => source.health.state === "degraded");
    assert.deepEqual(
      source.slots.map((slot) => slot.threadKey),
      ["ssh:remote:task"],
    );
    assert.equal(source.slots[0], remote);
    assert.equal(pending.signal.aborted, false);
  } finally {
    await fixture.close();
  }
});

test("T3 repeats a ready SSH environment while another SSH environment keeps its first request", {
  skip: process.platform === "win32",
}, async (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const fixture = await t3Fixture(context);
  const { source, config, save, wait, waitJob } = fixture;
  try {
    config.sshConnections.push({ host: "fast-host", environmentId: "fast", token: "fixture-token" });
    await save();
    source.syncDemand("All", host, false);
    const held = await waitJob(1);
    (await waitJob(2)).finish(shell("task", "Fast 0"));
    await wait(() => source.slots.some((slot) => slot.title === "Fast 0"));
    for (let revision = 1; revision <= 3; revision++) {
      context.mock.timers.tick(1200);
      await source.refresh();
      const fast = await waitJob(revision + 2);
      assert.equal(fast.input.environmentId, "fast");
      fast.finish(shell("task", `Fast ${revision}`));
      await wait(() => source.slots.some((slot) => slot.title === `Fast ${revision}`));
    }
    assert.equal(held.signal.aborted, false);
    assert.equal(fixture.jobs.filter((job) => job.input.environmentId === "remote").length, 1);
    assert.equal(source.health.state, "connecting");
    held.finish(shell("task", "Released"));
    await wait(() => source.health.state === "ready");
    assert.deepEqual(
      source.slots.map((slot) => slot.threadKey),
      ["local", "ssh:remote:task", "ssh:fast:task"],
    );
  } finally {
    await fixture.close();
  }
});

test("T3 starts on demand using caller cadence without registering another repeating clock", {
  skip: process.platform === "win32",
}, async (context) => {
  const fixture = await t3Fixture(context);
  const clock = context.mock.method(globalThis, "setInterval");
  try {
    fixture.source.syncDemand("All", host, false);
    await fixture.source.refresh();
    await fixture.waitJob(1);
    await fixture.wait(() => fixture.source.slots.some((slot) => slot.threadKey === "local"));
    assert.equal(clock.mock.calls.length, 0, "T3 must reuse the caller's existing cadence to preserve the wake budget");
  } finally {
    await fixture.close();
  }
});
