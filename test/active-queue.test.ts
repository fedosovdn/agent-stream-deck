import assert from "node:assert/strict";
import test from "node:test";
import { ActiveQueueRankIndex, projectActiveQueue } from "#agents";
import { LocalActivityIndex, type HostSnapshot } from "#agents";
import type { CodexHost, MicroSnapshot, RoutedAgentSlot } from "#agents";

const mac: CodexHost = {
  hostId: "56fd97ad-7073-42cc-85ce-befa17546d7c",
  hostName: "Test Mac",
  platform: "darwin",
};
const windows: CodexHost = {
  hostId: "11111111-1111-4111-8111-111111111111",
  hostName: "Test Windows",
  platform: "win32",
};

function thread(id: number): string {
  return `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`;
}

function routed(
  sourceSlot: number,
  status: string,
  activityAt?: number,
  host = mac,
  threadKey = thread(sourceSlot + 1),
): RoutedAgentSlot {
  return {
    id: sourceSlot,
    sourceSlot,
    status,
    activityAt,
    host,
    threadKey,
    title: `Task ${sourceSlot}`,
    selected: false,
    observedAt: 10_000,
  };
}

function trusted(
  slot: RoutedAgentSlot,
  startedAt: number,
  revision: number,
  conversationId = slot.threadKey!,
): RoutedAgentSlot {
  return { ...slot, conversationId, workStartedAt: startedAt, workStartRevision: revision };
}

function keys(slots: readonly RoutedAgentSlot[]): string[] {
  return slots.map((slot) => slot.threadKey!);
}

function snapshot(host: CodexHost, hostSessions: MicroSnapshot["hostSessions"] = []): HostSnapshot {
  return {
    host,
    observedAt: 10_000,
    snapshot: {
      slots: Array.from({ length: 6 }, (_, id) => ({
        id,
        threadKey: thread(id + 1),
        title: `Task ${id}`,
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
      hostSessions,
    },
  };
}

test("active queue omits irrelevant states and compacts native slots two and five", () => {
  assert.deepEqual(projectActiveQueue([], []), []);
  const slots = [
    routed(0, "idle"),
    routed(1, "working", 100),
    routed(2, "off"),
    routed(3, "future-state"),
    routed(4, "thinking", 200),
    routed(5, "idle"),
  ];

  const projected = projectActiveQueue(slots, [snapshot(mac)]);

  assert.deepEqual(
    projected.map((slot) => slot.id),
    [0, 1],
  );
  assert.deepEqual(
    projected.map((slot) => slot.sourceSlot),
    [1, 4],
  );
});

test("active queue remains an explicit projection and does not mutate native routing order", () => {
  const input = snapshot(mac);
  input.snapshot.slots[0]!.status = "idle";
  input.snapshot.slots[1]!.status = "working";
  input.snapshot.slots[4]!.status = "working";
  const merged = new LocalActivityIndex().merge(input);

  const projected = projectActiveQueue(merged, [input]);

  assert.deepEqual(
    merged.map((slot) => slot.id),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    merged.map((slot) => slot.sourceSlot),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    projected.map((slot) => slot.sourceSlot),
    [1, 4],
  );
});

test("OpenCode opaque task identities preserve case", () => {
  const older = trusted({ ...routed(0, "working", 100, mac, "connection:SessionA"), taskSource: "opencode" }, 100, 1);
  const newer = trusted({ ...routed(1, "working", 200, mac, "connection:sessiona"), taskSource: "opencode" }, 200, 2);
  const projected = projectActiveQueue([older, newer], [snapshot(mac)], new ActiveQueueRankIndex());
  assert.deepEqual(keys(projected), ["connection:sessiona", "connection:SessionA"]);
});

test("active queue orders attention and completion as before, then seeds trusted working starts newest first", () => {
  const slots = [
    trusted(routed(0, "working", 400), 400, 1),
    routed(1, "completed", 200),
    routed(2, "error", 150),
    routed(3, "awaiting-response", 100),
    routed(4, "unread", 300),
    trusted(routed(5, "thinking", 500), 500, 1),
  ];

  const projected = projectActiveQueue(slots, [snapshot(mac)]);

  assert.deepEqual(
    projected.map((slot) => slot.sourceSlot),
    [3, 2, 1, 4, 5, 0],
  );
});

test("active queue uses owning host session activity only for completion FIFO", () => {
  const completedLater = thread(21);
  const completedEarlier = "abcdef00-abcd-4000-8000-000000000022";
  const workingOlder = thread(23);
  const workingNewer = thread(24);
  const slots = [
    routed(0, "complete", 10, windows, completedLater),
    routed(1, "complete", 900, mac, completedEarlier),
    trusted(routed(2, "working", 990, windows, workingOlder), 300, 1),
    trusted(routed(3, "working", 20, mac, workingNewer), 400, 1),
  ];
  const inputs = [
    snapshot(mac, [{ threadId: completedEarlier, activityAt: 5_000, status: "complete" }]),
    snapshot(mac, [
      { threadId: `local:${completedEarlier.toUpperCase()}`, activityAt: 100, status: "complete" },
      { threadId: completedEarlier, activityAt: Number.NaN, status: "complete" },
      { threadId: completedEarlier, activityAt: Number.POSITIVE_INFINITY, status: "complete" },
      { threadId: completedEarlier, activityAt: 0, status: "complete" },
      { threadId: completedEarlier, activityAt: -1, status: "complete" },
      { threadId: completedLater, activityAt: 50, status: "complete" },
      { threadId: workingNewer, activityAt: 400, status: "working" },
    ]),
    snapshot(windows, [
      { threadId: completedLater, activityAt: 200, status: "complete" },
      { threadId: completedLater, activityAt: 50, status: "complete" },
      { threadId: completedEarlier, activityAt: 500, status: "complete" },
      { threadId: workingOlder, activityAt: 300, status: "working" },
    ]),
  ];

  const projected = projectActiveQueue(slots, inputs);

  assert.deepEqual(
    projected.map((slot) => slot.threadKey),
    [completedEarlier, completedLater, workingNewer, workingOlder],
  );
  assert.equal(projected[0]!.host.hostId, mac.hostId);
  assert.equal(projected[1]!.host.hostId, windows.hostId);
});

test("completion FIFO keeps OpenCode and T3 activity independent of Codex sessions", () => {
  const slots = [
    { ...routed(0, "complete", 75, mac, "Connection:SessionA"), taskSource: "opencode" as const },
    { ...routed(1, "complete", 85, mac, "Connection:sessiona"), taskSource: "t3code" as const },
    routed(2, "complete", 500, mac, thread(25)),
    routed(3, "complete", 80, mac, thread(26)),
  ];
  const inputs = [
    snapshot(mac, [
      { threadId: "Connection:SessionA", activityAt: 900, status: "complete" },
      { threadId: "Connection:sessiona", activityAt: 10, status: "complete" },
      { threadId: thread(25), activityAt: 90, status: "complete" },
      { threadId: thread(26), activityAt: Number.POSITIVE_INFINITY, status: "complete" },
    ]),
  ];

  const projected = projectActiveQueue(slots, inputs);

  assert.deepEqual(keys(projected), ["Connection:SessionA", thread(26), "Connection:sessiona", thread(25)]);
});

test("active queue puts trusted structural starts before unknown work and resolves stable ties", () => {
  const sameSlotA = routed(4, "working", undefined, mac, thread(42));
  const sameSlotB = routed(4, "working", Number.NaN, windows, thread(41));
  const slots = [
    sameSlotA,
    trusted(routed(5, "working", 250, mac, thread(43)), 250, 1),
    routed(2, "working", 0, mac, thread(44)),
    sameSlotB,
  ];

  const first = projectActiveQueue(slots, [snapshot(mac), snapshot(windows)]);
  const second = projectActiveQueue(slots, [snapshot(mac), snapshot(windows)]);

  assert.deepEqual(
    first.map((slot) => slot.threadKey),
    [thread(43), thread(42), thread(44), thread(41)],
  );
  assert.deepEqual(
    second.map((slot) => slot.threadKey),
    first.map((slot) => slot.threadKey),
  );
});

test("equal trusted starts use stable global task identity ties", () => {
  const laterIdentity = trusted(routed(0, "working", undefined, windows, thread(46)), 500, 1);
  const earlierIdentity = trusted(routed(1, "working", undefined, mac, thread(45)), 500, 1);
  assert.deepEqual(keys(projectActiveQueue([laterIdentity, earlierIdentity], [])), [thread(45), thread(46)]);
});

test("active queue caps at six and preserves routed command identity while replacing display ids", () => {
  const remoteKey = `local:${thread(61)}`;
  const four = [0, 1, 2, 3].map((id) => routed(id + 2, "working", id + 1));
  assert.deepEqual(
    projectActiveQueue(four, [snapshot(mac)]).map((slot) => slot.id),
    [0, 1, 2, 3],
  );

  const remote = routed(5, "error", 1, windows, remoteKey);
  const projected = projectActiveQueue(
    [...Array.from({ length: 5 }, (_, id) => routed(id, "working", id + 1)), remote],
    [snapshot(mac), snapshot(windows)],
  );

  assert.equal(projected.length, 6);
  assert.equal(projected[0]!.id, 0);
  assert.equal(projected[0]!.host, windows);
  assert.equal(projected[0]!.sourceSlot, 5);
  assert.equal(projected[0]!.threadKey, remoteKey);
});

test("active queue does not retain completion after upstream routing stops reporting it", () => {
  const key = thread(71);
  const inputs = [snapshot(mac, [{ threadId: key, activityAt: 100, status: "complete" }])];

  assert.equal(projectActiveQueue([routed(0, "complete", 50, mac, key)], inputs).length, 1);
  assert.deepEqual(projectActiveQueue([routed(0, "idle", 50, mac, key)], inputs), []);
});

test("full active catalog assigns projected transport slots to tasks outside the native six", () => {
  const input = snapshot(mac);
  input.snapshot.activeCatalog = {
    complete: true,
    candidates: [
      {
        threadKey: thread(81),
        conversationId: thread(81),
        title: "Pinned",
        status: "working",
        selected: false,
        activityAt: 200,
        catalogIndex: 0,
        ownedByHost: true,
        workStartedAt: 200,
        workStartRevision: 1,
      },
      {
        threadKey: thread(82),
        conversationId: thread(82),
        title: "Unpinned",
        status: "working",
        selected: false,
        activityAt: 300,
        catalogIndex: 9,
        ownedByHost: true,
        workStartedAt: 300,
        workStartRevision: 1,
      },
    ],
  };

  const merged = new LocalActivityIndex().mergeActiveCatalog(input);
  const projected = projectActiveQueue(merged, [input]);

  assert.deepEqual(
    projected.map((slot) => slot.threadKey),
    [thread(82), thread(81)],
  );
  assert.deepEqual(
    projected.map((slot) => slot.sourceSlot),
    [0, 1],
  );
});

test("full active catalog preserves native transport slots after queue reordering", () => {
  const input = snapshot(mac);
  input.snapshot.activeCatalog = {
    complete: true,
    candidates: [
      {
        threadKey: thread(83),
        conversationId: thread(83),
        title: "Native five",
        status: "working",
        selected: false,
        activityAt: 200,
        catalogIndex: 0,
        nativeSlot: 4,
        ownedByHost: true,
        workStartedAt: 200,
        workStartRevision: 1,
      },
      {
        threadKey: thread(84),
        conversationId: thread(84),
        title: "Native two",
        status: "working",
        selected: false,
        activityAt: 300,
        catalogIndex: 1,
        nativeSlot: 1,
        ownedByHost: true,
        workStartedAt: 300,
        workStartRevision: 1,
      },
    ],
  };

  const merged = new LocalActivityIndex().mergeActiveCatalog(input);
  const projected = projectActiveQueue(merged, [input]);

  assert.deepEqual(
    projected.map((slot) => slot.threadKey),
    [thread(84), thread(83)],
  );
  assert.deepEqual(
    projected.map((slot) => slot.sourceSlot),
    [1, 4],
  );
});

test("full active catalog distinguishes unavailable fallback from authoritative empty", () => {
  const fallback = snapshot(mac);
  fallback.snapshot.slots[0]!.status = "working";
  assert.equal(new LocalActivityIndex().mergeActiveCatalog(fallback).length, 6);

  const empty = snapshot(mac);
  empty.snapshot.activeCatalog = { complete: true, candidates: [] };
  assert.deepEqual(new LocalActivityIndex().mergeActiveCatalog(empty), []);
});

test("full active catalog keeps temporary keys separate without trusted conversation ids", () => {
  const input = snapshot(mac);
  const suffix = "10000000-0000-4000-8000-000000000091";
  input.snapshot.activeCatalog = {
    complete: true,
    candidates: [
      {
        threadKey: `local:client-new-thread:${suffix}`,
        title: "A",
        status: "working",
        selected: false,
        catalogIndex: 0,
      },
      {
        threadKey: `remote:client-new-thread:${suffix}`,
        title: "B",
        status: "working",
        selected: false,
        catalogIndex: 1,
      },
    ],
  };
  assert.equal(new LocalActivityIndex().mergeActiveCatalog(input).length, 2);
});

test("full active catalog de-duplicates local descriptors by trusted identity and keeps the owner's exact key", () => {
  const conversationId = thread(92);
  const local = snapshot(mac);
  local.snapshot.activeCatalog = {
    complete: true,
    candidates: [
      {
        threadKey: `remote:${conversationId}`,
        conversationId,
        title: "Mirror",
        status: "idle",
        selected: false,
        catalogIndex: 4,
      },
      {
        threadKey: `local:${conversationId}`,
        conversationId,
        title: "Owner",
        status: "working",
        selected: false,
        activityAt: 500,
        catalogIndex: 1,
        ownedByHost: true,
      },
    ],
  };
  local.snapshot.hostSessions = [{ threadId: conversationId, activityAt: 500, status: "working" }];
  const merged = new LocalActivityIndex().mergeActiveCatalog(local, 1_000);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.host.hostId, mac.hostId);
  assert.equal(merged[0]!.threadKey, `local:${conversationId}`);
  assert.equal(merged[0]!.status, "working");
});

test("custom source keeps the fixed native six instead of pooling the full catalog", () => {
  const input = snapshot(mac);
  input.snapshot.agentSource = "custom";
  input.snapshot.activeCatalog = {
    complete: true,
    candidates: [
      {
        threadKey: thread(99),
        conversationId: thread(99),
        title: "Off six",
        status: "working",
        selected: false,
        catalogIndex: 10,
      },
    ],
  };
  assert.deepEqual(
    new LocalActivityIndex().mergeActiveCatalog(input).map((slot) => slot.threadKey),
    input.snapshot.slots.map((slot) => slot.threadKey),
  );
});

test("custom source active queue advances only on a higher trusted native work revision", () => {
  const input = snapshot(mac);
  input.snapshot.agentSource = "custom";
  input.snapshot.slots.forEach((slot) => {
    slot.status = "idle";
    slot.selected = false;
  });
  Object.assign(input.snapshot.slots[0]!, {
    status: "working",
    activityAt: 300,
    ownedByHost: true,
    workStartedAt: 300,
    workStartRevision: 1,
  });
  Object.assign(input.snapshot.slots[1]!, {
    status: "working",
    activityAt: 200,
    ownedByHost: true,
    workStartedAt: 200,
    workStartRevision: 1,
  });
  Object.assign(input.snapshot.slots[2]!, {
    status: "working",
    activityAt: 100,
    ownedByHost: true,
    workStartedAt: 100,
    workStartRevision: 1,
  });
  const activityIndex = new LocalActivityIndex();
  const rankIndex = new ActiveQueueRankIndex();
  const project = (now: number) =>
    projectActiveQueue(activityIndex.mergeActiveCatalog(input, now), [input], rankIndex, now);

  assert.deepEqual(
    project(1_000).map((slot) => slot.sourceSlot),
    [0, 1, 2],
  );
  Object.assign(input.snapshot.slots[2]!, {
    selected: true,
    title: "Opened",
    activityAt: 9_000,
  });
  assert.deepEqual(
    project(2_000).map((slot) => slot.sourceSlot),
    [0, 1, 2],
  );
  Object.assign(input.snapshot.slots[2]!, { workStartedAt: 400, workStartRevision: 2 });
  assert.deepEqual(
    project(3_000).map((slot) => slot.sourceSlot),
    [2, 0, 1],
  );
});

test("custom source derives only stable conversation identities from native thread keys", () => {
  const input = snapshot(mac);
  input.snapshot.agentSource = "custom";
  const suffix = thread(99);
  input.snapshot.slots[1]!.threadKey = `local:${thread(98)}`;
  input.snapshot.slots[2]!.threadKey = `local:client-new-thread:${suffix}`;

  const merged = new LocalActivityIndex().mergeActiveCatalog(input);

  assert.equal(merged[0]!.conversationId, thread(1));
  assert.equal(merged[1]!.conversationId, thread(98));
  assert.equal(merged[2]!.conversationId, undefined);
  assert.deepEqual(
    merged.map((slot) => slot.threadKey),
    input.snapshot.slots.map((slot) => slot.threadKey),
  );
});

test("working rank is stable across selection, title, activity, catalog reorder, and identical refresh", () => {
  const index = new ActiveQueueRankIndex();
  const a = trusted(routed(0, "working", 300, mac, thread(101)), 300, 1);
  const b = trusted(routed(1, "working", 200, mac, thread(102)), 200, 1);
  const c = trusted(routed(2, "working", 100, mac, thread(103)), 100, 1);
  assert.deepEqual(keys(projectActiveQueue([a, b, c], [], index, 1_000)), [a.threadKey, b.threadKey, c.threadKey]);

  const refreshed = [
    { ...c, selected: true, title: "Opened C", activityAt: 9_000, catalogIndex: 0 },
    { ...a, selected: true, title: "Opened A", activityAt: 8_000, catalogIndex: 2 },
    { ...b, title: "Background output", activityAt: 10_000, catalogIndex: 1 },
  ];
  assert.deepEqual(keys(projectActiveQueue(refreshed, [], index, 2_000)), [a.threadKey, b.threadKey, c.threadKey]);
  assert.deepEqual(keys(projectActiveQueue(refreshed, [], index, 3_000)), [a.threadKey, b.threadKey, c.threadKey]);
});

test("trusted revisions are immutable across shifted timestamps and only a higher same-owner revision advances", () => {
  const index = new ActiveQueueRankIndex();
  const a = trusted(routed(0, "working", 1, mac, thread(111)), 300, 10);
  const b = trusted(routed(1, "working", 2, mac, thread(112)), 200, 20);
  const c = trusted(routed(2, "working", 3, mac, thread(113)), 100, 30);
  projectActiveQueue([a, b, c], [], index, 1_000);

  assert.deepEqual(keys(projectActiveQueue([{ ...c, workStartedAt: 999 }, a, b], [], index, 2_000)), [
    a.threadKey,
    b.threadKey,
    c.threadKey,
  ]);
  assert.deepEqual(
    keys(projectActiveQueue([{ ...c, workStartedAt: 1_000, workStartRevision: 31 }, a, b], [], index, 3_000)),
    [c.threadKey, a.threadKey, b.threadKey],
  );
  assert.deepEqual(
    keys(projectActiveQueue([{ ...b, workStartedAt: 2_000, workStartRevision: 19 }, a, c], [], index, 4_000)),
    [c.threadKey, a.threadKey, b.threadKey],
  );
});

test("a newer first-known trusted start advances ahead of an already promoted task", () => {
  const index = new ActiveQueueRankIndex();
  const a = trusted(routed(0, "working", 1, mac, thread(114)), 100, 1);
  projectActiveQueue([a], [], index, 1_000);
  const promotedA = { ...a, workStartedAt: 200, workStartRevision: 2 };
  projectActiveQueue([promotedA], [], index, 2_000);

  const b = trusted(routed(1, "working", 1, mac, thread(115)), 300, 1);
  assert.deepEqual(keys(projectActiveQueue([promotedA, b], [], index, 3_000)), [b.threadKey, a.threadKey]);
});

test("an older first-known trusted start does not advance ahead of an already promoted task", () => {
  const index = new ActiveQueueRankIndex();
  const a = trusted(routed(0, "working", 1, mac, thread(116)), 100, 1);
  projectActiveQueue([a], [], index, 1_000);
  const promotedA = { ...a, workStartedAt: 300, workStartRevision: 2 };
  projectActiveQueue([promotedA], [], index, 2_000);

  const b = trusted(routed(1, "working", 1, mac, thread(117)), 200, 1);
  assert.deepEqual(keys(projectActiveQueue([b, promotedA], [], index, 3_000)), [a.threadKey, b.threadKey]);
});

test("simultaneous higher trusted revisions sort newest first independent of catalog order", () => {
  const run = (reversed: boolean): string[] => {
    const index = new ActiveQueueRankIndex();
    const a = trusted(routed(0, "working", 1, mac, thread(118)), 100, 1);
    const b = trusted(routed(1, "working", 1, mac, thread(119)), 200, 1);
    projectActiveQueue([a, b], [], index, 1_000);
    const promotedA = { ...a, workStartedAt: 400, workStartRevision: 2 };
    const promotedB = { ...b, workStartedAt: 300, workStartRevision: 2 };
    return keys(projectActiveQueue(reversed ? [promotedB, promotedA] : [promotedA, promotedB], [], index, 2_000));
  };

  assert.deepEqual(run(false), [thread(118), thread(119)]);
  assert.deepEqual(run(true), [thread(118), thread(119)]);
});

test("clear resets the observed trusted maximum for a fresh epoch", () => {
  const index = new ActiveQueueRankIndex();
  const a = trusted(routed(0, "working", 1, mac, thread(126)), 1_000, 1);
  projectActiveQueue([a], [], index, 1_000);
  index.clear();

  const b = trusted(routed(1, "working", 1, mac, thread(127)), 100, 1);
  projectActiveQueue([b], [], index, 2_000);
  const c = trusted(routed(2, "working", 1, mac, thread(128)), 200, 1);
  assert.deepEqual(keys(projectActiveQueue([b, c], [], index, 3_000)), [c.threadKey, b.threadKey]);
});

test("unknown work uses stable first-seen order and infers only idle or completion to working", () => {
  const index = new ActiveQueueRankIndex();
  const a = routed(0, "working", 100, mac, thread(121));
  const b = routed(1, "working", 900, mac, thread(122));
  assert.deepEqual(keys(projectActiveQueue([a, b], [], index, 1_000)), [a.threadKey, b.threadKey]);
  assert.deepEqual(
    keys(
      projectActiveQueue(
        [
          { ...b, catalogIndex: 0 },
          { ...a, catalogIndex: 9 },
        ],
        [],
        index,
        2_000,
      ),
    ),
    [a.threadKey, b.threadKey],
  );

  const midEpoch = routed(2, "working", 5_000, mac, thread(123));
  assert.deepEqual(keys(projectActiveQueue([midEpoch, b, a], [], index, 3_000)), [
    a.threadKey,
    b.threadKey,
    midEpoch.threadKey,
  ]);
  projectActiveQueue([{ ...midEpoch, status: "idle" }, b, a], [], index, 4_000);
  assert.deepEqual(keys(projectActiveQueue([{ ...midEpoch, status: "working" }, b, a], [], index, 5_000)), [
    midEpoch.threadKey,
    a.threadKey,
    b.threadKey,
  ]);

  const approval = routed(3, "approval", 6_000, mac, thread(124));
  const error = routed(4, "error", 7_000, mac, thread(125));
  projectActiveQueue([approval, error, midEpoch, a, b], [], index, 6_000);
  assert.deepEqual(
    keys(
      projectActiveQueue(
        [{ ...approval, status: "working" }, { ...error, status: "working" }, midEpoch, a, b],
        [],
        index,
        7_000,
      ),
    ),
    [midEpoch.threadKey, a.threadKey, b.threadKey, approval.threadKey, error.threadKey],
  );
});

test("completion to working infers a new unknown rank and observes candidates beyond the six-item cap", () => {
  const index = new ActiveQueueRankIndex();
  const working = Array.from({ length: 6 }, (_, id) => routed(id, "working", 10_000 - id, mac, thread(150 + id)));
  const seventh = routed(6, "complete", 1, mac, thread(156));
  assert.equal(projectActiveQueue([...working, seventh], [], index, 1_000).length, 6);
  const projected = projectActiveQueue([...working, { ...seventh, status: "working" }], [], index, 2_000);
  assert.equal(projected.length, 6);
  assert.equal(projected[0]!.threadKey, seventh.threadKey);
});

test("rank survives short disappearance, prunes after 24 hours, and clear starts a fresh epoch", () => {
  const day = 24 * 60 * 60 * 1_000;
  const index = new ActiveQueueRankIndex();
  const a = routed(0, "working", undefined, mac, thread(131));
  const b = routed(1, "working", undefined, mac, thread(132));
  projectActiveQueue([a, b], [], index, 0);
  projectActiveQueue([b], [], index, day - 1);
  assert.deepEqual(keys(projectActiveQueue([b, a], [], index, day)), [a.threadKey, b.threadKey]);
  projectActiveQueue([b], [], index, day + 1);
  assert.deepEqual(keys(projectActiveQueue([b, a], [], index, day * 2 + 1)), [b.threadKey, a.threadKey]);
  index.clear();
  assert.deepEqual(keys(projectActiveQueue([a, b], [], index, day * 2 + 2)), [a.threadKey, b.threadKey]);

  const continuouslyPresent = new ActiveQueueRankIndex();
  projectActiveQueue([a, b], [], continuouslyPresent, 0);
  assert.deepEqual(keys(projectActiveQueue([b, a], [], continuouslyPresent, day * 2)), [a.threadKey, b.threadKey]);
});

test("trusted owner change preserves rank and baselines its revision; temporary host-local keys stay separate", () => {
  const index = new ActiveQueueRankIndex();
  const identity = thread(141);
  const a = trusted(routed(0, "working", 1, mac, `local:${identity}`), 200, 10, identity);
  const b = trusted(routed(1, "working", 1, mac, thread(142)), 300, 5);
  assert.deepEqual(keys(projectActiveQueue([a, b], [], index, 1_000)), [b.threadKey, a.threadKey]);
  const movedOwner = {
    ...a,
    host: windows,
    threadKey: `remote:${identity}`,
    workStartedAt: 900,
    workStartRevision: 50,
  };
  assert.deepEqual(keys(projectActiveQueue([b, movedOwner], [], index, 2_000)), [b.threadKey, movedOwner.threadKey]);
  assert.deepEqual(keys(projectActiveQueue([b, { ...movedOwner, workStartRevision: 51 }], [], index, 3_000)), [
    movedOwner.threadKey,
    b.threadKey,
  ]);

  const suffix = thread(143);
  const localTemp = routed(2, "working", undefined, mac, `local:client-new-thread:${suffix}`);
  const remoteTemp = routed(3, "working", undefined, mac, `remote:client-new-thread:${suffix}`);
  assert.equal(projectActiveQueue([localTemp, remoteTemp], [], new ActiveQueueRankIndex(), 4_000).length, 2);
});
