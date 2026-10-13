import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import streamDeck, { type KeyAction, type TitleParametersDidChangeEvent } from "@elgato/streamdeck";
import type { HostHealth, HostSnapshot, TaskSource } from "#agents";
import { CodexMicroRendererBridge, type CodexSource } from "#codex";
import { type OpenCodeCollector, type OpenCodeCollectorSnapshot, OpenCodeSource, type OpenCodeTask } from "#opencode";
import { Agent1, type AgentDisplaySettings, DeckController, RateLimitReset, ReasoningUp } from "#stream-deck";
import { T3CodeSource } from "#t3code";
import { CODEX_BAR_FRESH_MS } from "#usage";
import { codexDeckStateRoot } from "../src/runtime/paths.js";
import { createMicroSnapshot, host } from "./support/micro-snapshot.js";

const snapshot = createMicroSnapshot();

/** Stands in for the Codex source boundary; the controller only sees its public surface. */
type CodexStub = {
  localHost?: typeof host;
  localSnapshot?: HostSnapshot;
  localHealth: HostHealth;
  refreshes: number;
  refreshGate?: Promise<void>;
  sends: unknown[][];
  reasoning: string[];
  consumed: number;
  microBridge: {
    sendAgent: CodexMicroRendererBridge["sendAgent"];
    adjustReasoning: CodexMicroRendererBridge["adjustReasoning"];
    consumeRateLimitReset?: () => Promise<void>;
  };
  start(): Promise<void>;
  refresh(): Promise<void>;
  stop(): void;
};

function createCodexStub(): CodexStub {
  const stub: CodexStub = {
    localHost: host,
    localSnapshot: undefined,
    localHealth: { state: "connecting", reason: "awaiting-snapshot", changedAt: 1 },
    refreshes: 0,
    sends: [],
    reasoning: [],
    consumed: 0,
    microBridge: {
      sendAgent: async (...args) => {
        stub.sends.push(args.slice(0, 3));
      },
      adjustReasoning: async (direction) => {
        stub.reasoning.push(direction);
      },
      consumeRateLimitReset: async () => {
        stub.consumed++;
      },
    },
    async start() {},
    async refresh() {
      stub.refreshes++;
      await stub.refreshGate;
    },
    stop() {},
  };
  return stub;
}

/** Real OpenCode source logic, but a demand change never starts a real collector or reads the secret store. */
class OfflineOpenCodeSource extends OpenCodeSource {
  override syncDemand(_source: TaskSource, hostIdentity: typeof host | undefined, stopped: boolean): Promise<void> {
    return super.syncDemand("Codex", hostIdentity, stopped);
  }
}

/** Real T3 source logic, but a refresh never reads the private configuration or contacts a server. */
class OfflineT3CodeSource extends T3CodeSource {
  override async refresh(): Promise<void> {}
}

type Deck = {
  controller: DeckController;
  codex: CodexStub;
  openCode: OfflineOpenCodeSource;
  t3Code: OfflineT3CodeSource;
};

function createDeck(
  options: { foregroundOpenCode?: () => Promise<void>; foregroundT3Code?: () => Promise<void> } = {},
): Deck {
  const codex = createCodexStub();
  const openCode = new OfflineOpenCodeSource(() => {}, options.foregroundOpenCode);
  const t3Code = new OfflineT3CodeSource(() => {}, { foreground: options.foregroundT3Code });
  const controller = new DeckController({ codex: codex as unknown as CodexSource, openCode, t3Code });
  return { controller, codex, openCode, t3Code };
}

async function isolateHome(context: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "codex-deck-home-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  context.after(async () => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

/** Starts the controller through its public lifecycle with persisted global settings and an isolated home. */
async function startDeck(
  context: TestContext,
  deck: Deck,
  options: { settings?: AgentDisplaySettings; mockTimers?: boolean; codexBarAge?: number } = {},
): Promise<void> {
  if (options.mockTimers) context.mock.timers.enable({ apis: ["setTimeout"] });
  context.mock.method(streamDeck.settings, "getGlobalSettings", (async () => options.settings ?? {}) as never);
  const home = await isolateHome(context);
  if (options.codexBarAge !== undefined) {
    // The macOS poll reads CodexBar's widget snapshot from the home directory.
    const directory = join(home, "Library", "Application Support", "CodexBar");
    await mkdir(directory, { recursive: true });
    const entry = {
      provider: "codex",
      updatedAt: Date.now() - options.codexBarAge,
      primary: { usedPercent: 41, windowMinutes: 300 },
    };
    await writeFile(join(directory, "widget-snapshot.json"), JSON.stringify({ entries: [entry] }), { mode: 0o600 });
  }
  context.after(() => deck.controller.stop());
  await deck.controller.start();
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Lets any fire-and-forget work queued by a call reach the source before a negative assertion. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await settle();
}

async function eventually(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return check();
    } catch {
      await sleep(5);
    }
  }
  check();
}

/** One poll interval of the started controller; resolves once the source poll has been reached and drained. */
async function poll(context: TestContext, deck: Deck): Promise<void> {
  const before = deck.codex.refreshes;
  context.mock.timers.tick(1_200);
  await eventually(() => assert.equal(deck.codex.refreshes, before + 1));
  await settle();
}

type FakeKey = {
  images: string[];
  titles: string[];
  alerts: () => number;
  action: KeyAction<Record<string, never>>;
  event: never;
};

function fakeKey(id: string, options: { onAlert?: () => void } = {}): FakeKey {
  const images: string[] = [];
  const titles: string[] = [];
  let alerts = 0;
  const action = {
    id,
    isKey: () => true,
    setImage: async (image: string) => {
      images.push(decodeURIComponent(image));
    },
    setTitle: async (title: string) => {
      titles.push(title);
    },
    showAlert: async () => {
      alerts++;
      options.onAlert?.();
    },
    showOk: async () => assert.fail("no Agent or reset key acknowledges with showOk"),
  };
  return {
    images,
    titles,
    alerts: () => alerts,
    action: action as unknown as KeyAction<Record<string, never>>,
    event: { action } as never,
  };
}

function registerAgents(controller: DeckController, count: number): FakeKey[] {
  return Array.from({ length: count }, (_, slot) => {
    const key = fakeKey(`agent-${slot}`);
    controller.registerAgent(slot, key.action);
    return key;
  });
}

/** What a rendered Agent key shows: its wrapped title lines, or "black" for an intentionally blank key. */
function keyLabel(image: string | undefined): string {
  if (image === undefined) return "<never rendered>";
  if (/<rect width="144" height="144" fill="#000000"\/>/.test(image)) return "black";
  const lines = [...image.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)]
    .filter((line) => !line[1]!.includes('font-size="11"'))
    .map((line) => line[2]!);
  return lines.join(" ") || "<no title>";
}

const labels = (keys: FakeKey[]) => keys.map((key) => keyLabel(key.images.at(-1)));

const BLACK = ["black", "black", "black", "black"];

function openCodeCollector(handlers: {
  tasks: () => OpenCodeTask[];
  acknowledgeTask?: OpenCodeCollector["acknowledgeTask"];
  publishTaskViewed?: OpenCodeCollector["publishTaskViewed"];
}): OpenCodeCollector {
  const collector = {
    acknowledgeTask: handlers.acknowledgeTask ?? (() => true),
    publishTaskViewed: handlers.publishTaskViewed ?? (async () => true),
    snapshot: (): OpenCodeCollectorSnapshot => ({
      version: 1,
      observedAt: Date.now(),
      connections: [
        {
          connectionId: "opaque-connection",
          health: "ready",
          complete: true,
          observedAt: Date.now(),
          tasks: handlers.tasks(),
        },
      ],
    }),
    stop: async () => {},
  };
  return collector as unknown as OpenCodeCollector;
}

test("active queue empty press stays a no-op across queue disable and a filled release", async () => {
  const deck = createDeck();
  const first = fakeKey("first-key", { onAlert: () => assert.fail("an empty press must not alert") });

  await assert.rejects(deck.controller.sendAgent(0, 1, { id: "first-key" }), /No Codex task is assigned/);
  deck.controller.setAgentDisplaySettings({ activeQueueEnabled: true });
  await settle();

  const action = new Agent1(deck.controller);
  await action.onKeyDown(first.event);
  deck.codex.localSnapshot = { host, snapshot: createMicroSnapshot(), observedAt: Date.now() };
  deck.controller.registerAgent(0, first.action);
  deck.controller.setAgentDisplaySettings({ activeQueueEnabled: false });
  await settle();
  assert.equal(keyLabel(first.images.at(-1)), "Task 1", "the key is filled by the time of the release");
  await action.onKeyUp(first.event);

  assert.deepEqual(deck.codex.sends, []);
  assert.equal(first.alerts(), 0);
});

test("active queue black empty press stays a no-op for an empty slot", async () => {
  const deck = createDeck();
  deck.controller.setAgentDisplaySettings({ activeQueueEnabled: true });
  await settle();

  await deck.controller.sendAgent(0, 1, { id: "first-key" });
  await deck.controller.sendAgent(0, 0, { id: "first-key" });

  assert.deepEqual(deck.codex.sends, []);
});

test("controller applies the active queue only after host routing and preserves native order by default", async (context) => {
  const input = createMicroSnapshot();
  input.slots.forEach((slot) => {
    slot.status = "idle";
    slot.selected = false;
  });
  input.slots[1]!.status = "working";
  input.slots[4]!.status = "working";
  input.slots[1]!.activityAt = 100;
  input.slots[4]!.activityAt = 200;
  const deck = createDeck();
  deck.codex.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  const keys = registerAgents(deck.controller, 6);

  await startDeck(context, deck);
  assert.deepEqual(labels(keys), ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5", "Task 6"]);

  deck.controller.setAgentDisplaySettings({ activeQueueEnabled: true });
  await settle();
  assert.deepEqual(labels(keys), ["Task 2", "Task 5", "black", "black", "black", "black"]);
});

test("All queue drops stopped local Codex tasks before assigning the first key to OpenCode", async () => {
  const foregroundCalls: string[] = [];
  const deck = createDeck({
    foregroundOpenCode: async () => {
      foregroundCalls.push("foreground");
    },
  });
  deck.controller.setAgentDisplaySettings({ taskSource: "All" });
  await settle();
  const staleSnapshot = createMicroSnapshot();
  staleSnapshot.slots[0]!.status = "complete";
  staleSnapshot.slots[0]!.activityAt = 100;
  deck.codex.localSnapshot = { host, snapshot: staleSnapshot, observedAt: Date.now() };
  deck.codex.localHealth = { state: "degraded", reason: "codex-not-running", changedAt: Date.now() };
  deck.openCode.openCodeHealth = { state: "ready", changedAt: Date.now() };
  deck.openCode.openCodeSlots = [
    {
      id: 0,
      sourceSlot: 0,
      taskSource: "opencode",
      host,
      threadKey: "connection\0session",
      title: "OpenCode task",
      status: "complete",
      selected: false,
      activityAt: 200,
      observedAt: Date.now(),
    },
  ];
  deck.codex.microBridge.sendAgent = async () => {
    throw new Error("Stopped Codex must not receive a press");
  };
  const first = fakeKey("first-key");
  const second = fakeKey("second-key");
  deck.controller.registerAgent(1, second.action);
  const action = new Agent1(deck.controller);
  action.onWillAppear(first.event);
  deck.controller.setAgentDisplaySettings({ taskSource: "All", activeQueueEnabled: true });
  await settle();

  await action.onKeyDown(first.event);
  await action.onKeyUp(first.event);

  assert.match(first.images.at(-1)!, /data-agent-host="O"/);
  assert.equal(keyLabel(first.images.at(-1)), "OpenCode task");
  assert.equal(keyLabel(second.images.at(-1)), "black", "the stopped Codex task is not shown behind OpenCode");
  assert.equal(first.alerts(), 0);
  assert.deepEqual(foregroundCalls, ["foreground"]);
});

test("controller keeps one working-rank epoch, advances on a higher revision, and resets it on disable", async (context) => {
  const input = createMicroSnapshot();
  input.slots.forEach((slot) => {
    slot.status = "idle";
    slot.selected = false;
  });
  Object.assign(input.slots[0]!, {
    status: "working",
    activityAt: 300,
    ownedByHost: true,
    workStartedAt: 300,
    workStartRevision: 1,
  });
  Object.assign(input.slots[1]!, {
    status: "working",
    activityAt: 200,
    ownedByHost: true,
    workStartedAt: 200,
    workStartRevision: 1,
  });
  Object.assign(input.slots[2]!, {
    status: "working",
    activityAt: 100,
    ownedByHost: true,
    workStartedAt: 100,
    workStartRevision: 1,
  });
  const deck = createDeck();
  deck.codex.localSnapshot = { host, snapshot: input, observedAt: 1_000 };
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  const keys = registerAgents(deck.controller, 3);
  await startDeck(context, deck, { settings: { activeQueueEnabled: true }, mockTimers: true });

  assert.deepEqual(labels(keys), ["Task 1", "Task 2", "Task 3"]);
  Object.assign(input.slots[2]!, { selected: true, title: "Opened", activityAt: 9_000 });
  await poll(context, deck);
  assert.deepEqual(labels(keys), ["Task 1", "Task 2", "Opened"]);
  Object.assign(input.slots[2]!, { workStartedAt: 400, workStartRevision: 2 });
  await poll(context, deck);
  assert.deepEqual(labels(keys), ["Opened", "Task 1", "Task 2"]);

  for (const slot of input.slots.slice(0, 3)) {
    delete slot.workStartedAt;
    delete slot.workStartRevision;
  }
  deck.controller.setAgentDisplaySettings({ activeQueueEnabled: false });
  await settle();
  deck.controller.setAgentDisplaySettings({ activeQueueEnabled: true });
  await settle();
  assert.deepEqual(labels(keys), ["Task 1", "Task 2", "Opened"]);
});

test("active queue settings default off and a change immediately reprojects registered agents", async (context) => {
  const input = createMicroSnapshot();
  input.slots.forEach((slot) => {
    slot.status = "idle";
    slot.selected = false;
  });
  input.slots[0]!.contextUsedPercent = 42;
  input.slots[2]!.status = "working";
  const deck = createDeck();
  deck.codex.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  const keys = registerAgents(deck.controller, 2);
  await startDeck(context, deck);

  assert.deepEqual(labels(keys), ["Task 1", "Task 2"], "the queue is off by default");
  assert.match(keys[0]!.images.at(-1)!, /data-context-used="42"/);

  const futureSettings = { showContextRings: false, futureSetting: "preserved" };
  deck.controller.setAgentDisplaySettings(futureSettings);
  await settle();
  assert.deepEqual(labels(keys), ["Task 1", "Task 2"], "an unrelated option change does not enable the queue");
  assert.doesNotMatch(keys[0]!.images.at(-1)!, /data-context-used/, "the ring option rerenders registered keys");

  deck.controller.setAgentDisplaySettings({ ...futureSettings, activeQueueEnabled: true });
  await settle();
  assert.deepEqual(labels(keys), ["Task 3", "black"]);
});

test("OpenCode task titles render locally and fall back to their content-free alias", async () => {
  const deck = createDeck();
  deck.controller.setAgentDisplaySettings({ taskSource: "OpenCode" });
  await settle();
  const task: OpenCodeTask = {
    source: "opencode",
    connectionId: "opaque-connection",
    sessionId: "opaque-session",
    label: "OpenCode 7",
    displayTitle: "Live chat",
    status: "working",
  };
  deck.openCode.openCodeCollector = openCodeCollector({ tasks: () => [task] });
  const key = fakeKey("opencode-title");
  deck.controller.registerAgent(0, key.action);

  deck.controller.setAgentDisplaySettings({ taskSource: "OpenCode", activeQueueEnabled: true });
  await settle();
  const titled = key.images.at(-1)!;
  assert.match(titled, /Live chat/);
  assert.match(titled, /data-agent-host="O"/);
  assert.match(titled, /data-theme="light"/);

  delete task.displayTitle;
  deck.controller.setAgentDisplaySettings({ taskSource: "OpenCode", activeQueueEnabled: false });
  await settle();
  assert.match(key.images.at(-1)!, /OpenCode 7/);
  assert.doesNotMatch(key.images.at(-1)!, /Live chat/);
});

test("usage keys use the light theme when Codex has no renderer snapshot", async () => {
  const deck = createDeck();
  deck.codex.localHealth = { state: "degraded", reason: "codex-not-running", changedAt: 1 };
  const limit = fakeKey("usage-limit");

  deck.controller.registerUsageLimit(limit.action, "five-hour");
  await settle();

  assert.match(limit.images.at(-1)!, /data-theme="light"/);
});

test("pressing a terminal OpenCode task acknowledges that result after foregrounding", async () => {
  const order: string[] = [];
  const foregrounded: string[] = [];
  const acknowledged: string[] = [];
  const published: string[] = [];
  const deck = createDeck({
    foregroundOpenCode: async () => {
      order.push("foreground");
      foregrounded.push("foregrounded");
    },
  });
  deck.controller.setAgentDisplaySettings({ taskSource: "OpenCode" });
  await settle();
  const terminalAt = Date.now();
  let visible = true;
  deck.openCode.openCodeCollector = openCodeCollector({
    tasks: () =>
      visible
        ? [
            {
              source: "opencode",
              connectionId: "opaque-connection",
              sessionId: "opaque-session",
              label: "Finished task",
              status: "complete",
              terminalAt,
            },
          ]
        : [],
    acknowledgeTask(connectionId, sessionId, at) {
      order.push("acknowledge");
      acknowledged.push(`${connectionId}:${sessionId}:${at}`);
      visible = false;
      return true;
    },
    async publishTaskViewed(connectionId, sessionId) {
      order.push("publish");
      published.push(`${connectionId}:${sessionId}`);
      throw new Error("API unavailable");
    },
  });
  const key = fakeKey("first-key", { onAlert: () => assert.fail("API failure must remain best-effort") });
  const action = new Agent1(deck.controller);
  action.onWillAppear(key.event);
  deck.controller.setAgentDisplaySettings({ taskSource: "OpenCode", activeQueueEnabled: true });
  await settle();
  assert.equal(keyLabel(key.images.at(-1)), "Finished task");

  await action.onKeyDown(key.event);
  await action.onKeyUp(key.event);

  assert.deepEqual(order, ["foreground", "acknowledge", "publish"]);
  assert.deepEqual(foregrounded, ["foregrounded"]);
  assert.deepEqual(acknowledged, [`opaque-connection:opaque-session:${terminalAt}`]);
  assert.deepEqual(published, ["opaque-connection:opaque-session"]);
  assert.equal(keyLabel(key.images.at(-1)), "black", "the acknowledged result leaves the queue");
});

for (const [persisted, queueExpected] of [
  [{}, false],
  [{ activeQueueEnabled: true }, true],
] as const) {
  test(`controller startup settings load ${queueExpected ? "restore persisted active queue true" : "default active queue off"}`, async (context) => {
    const deck = createDeck();
    deck.codex.localHealth = { state: "ready", changedAt: 1 };
    const [key] = registerAgents(deck.controller, 1);

    await startDeck(context, deck, { settings: persisted });

    assert.equal(keyLabel(key!.images.at(-1)), queueExpected ? "black" : "Not assigned");
  });
}

test("healthy queue gaps render black, unavailable diagnostics remain distinct, and duplicate images are suppressed", async () => {
  const deck = createDeck();
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  deck.controller.setAgentDisplaySettings({ activeQueueEnabled: true });
  await settle();
  const key = fakeKey("empty-agent");

  deck.controller.registerAgent(0, key.action);
  await settle();
  await deck.controller.toggleTargetHost();
  assert.equal(key.images.length, 1);
  assert.match(key.images[0]!, /fill="#000000"/);

  const diagnostics = [
    { state: "degraded", title: /Signals[\s\S]*uncertain/ },
    { state: "offline", title: /Host[\s\S]*offline/ },
    { state: "connecting", title: /Connecting/ },
  ] as const;
  for (const diagnosticCase of diagnostics) {
    deck.codex.localHealth = { state: diagnosticCase.state, reason: "local-bridge-unavailable", changedAt: 1 };
    await deck.controller.toggleTargetHost();
    const diagnostic = key.images.at(-1)!;
    assert.match(diagnostic, diagnosticCase.title);
    assert.match(diagnostic, new RegExp(`data-agent-host-health="${diagnosticCase.state}"`));
    assert.doesNotMatch(diagnostic, /fill="#000000"\/>(?:<\/svg>)?$/);
  }
  assert.equal(key.images.length, 4);
});

test("only working and input Agent keys advance their animation frame between polls", async (context) => {
  const input = createMicroSnapshot();
  input.slots[1]!.status = "awaiting-approval";
  const deck = createDeck();
  deck.codex.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  const keys = registerAgents(deck.controller, 3);
  await startDeck(context, deck, { mockTimers: true });
  const before = keys.map((key) => key.images.length);

  context.mock.timers.tick(200);
  await settle();

  assert.equal(keys[0]!.images.length, before[0]! + 1, "the working key renders its next frame");
  assert.notEqual(keys[0]!.images.at(-1), keys[0]!.images.at(-2));
  assert.equal(keys[1]!.images.length, before[1]! + 1, "the input key renders its next frame");
  assert.equal(keys[2]!.images.length, before[2], "the idle key is not redrawn");
  assert.equal(deck.codex.refreshes, 1, "animation frames do not poll the source");
});

test("an assigned titleless thread renders New chat on a ready host and an unassigned slot renders Not assigned", async (context) => {
  const input = createMicroSnapshot();
  input.slots = [{ id: 0, threadKey: input.slots[0]!.threadKey, title: null, status: "idle", selected: false }];
  const deck = createDeck();
  deck.codex.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  const keys = registerAgents(deck.controller, 2);
  await startDeck(context, deck);

  assert.deepEqual(labels(keys), ["New chat", "Not assigned"]);

  deck.codex.localHealth = { state: "degraded", reason: "local-bridge-unavailable", changedAt: 2 };
  await deck.controller.toggleTargetHost();
  assert.match(keys[0]!.images.at(-1)!, /Signals[\s\S]*uncertain/, "an unready host does not promise a new chat");
});

test("only local codex-not-running blanks the first four Agent keys", async () => {
  const deck = createDeck();
  deck.codex.localHealth = { state: "degraded", reason: "codex-not-running", changedAt: 1 };
  const keys = registerAgents(deck.controller, 5);
  await settle();

  assert.deepEqual(labels(keys).slice(0, 4), BLACK);
  assert.match(keys[4]!.images.at(-1)!, /Signals[\s\S]*uncertain/);

  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  await deck.controller.toggleTargetHost();
  assert.equal(keyLabel(keys[0]!.images.at(-1)), "Not assigned");

  deck.codex.localHealth = { state: "degraded", reason: "local-bridge-unavailable", changedAt: 1 };
  await deck.controller.toggleTargetHost();
  assert.match(keys[0]!.images.at(-1)!, /Signals[\s\S]*uncertain/);
});

for (const disappear of [false, true]) {
  test(`identical Agent instances isolate captured presses${disappear ? " after disappearance" : " across queue churn"}`, async (context) => {
    const original = createMicroSnapshot();
    const replacement = createMicroSnapshot();
    for (const input of [original, replacement]) {
      input.slots.forEach((slot) => {
        slot.status = "idle";
        slot.selected = false;
      });
    }
    original.slots[0]!.status = "working";
    replacement.slots[1]!.status = "working";
    const originalKey = original.slots[0]!.threadKey;
    const replacementKey = replacement.slots[1]!.threadKey;
    const deck = createDeck();
    deck.codex.localSnapshot = { host, snapshot: original, observedAt: 1_000 };
    deck.codex.localHealth = { state: "ready", changedAt: 1 };
    await startDeck(context, deck, { settings: { activeQueueEnabled: true }, mockTimers: true });

    const action = new Agent1(deck.controller);
    const first = fakeKey("deck-one");
    const second = fakeKey("deck-two");
    action.onWillAppear(first.event);
    action.onWillAppear(second.event);
    await action.onKeyDown(first.event);
    if (disappear) action.onWillDisappear(first.event);
    deck.codex.localSnapshot = { host, snapshot: replacement, observedAt: 2_000 };
    await poll(context, deck);
    assert.equal(keyLabel(second.images.at(-1)), "Task 2", "the queue now holds the replacement task");
    await action.onKeyDown(second.event);
    await action.onKeyUp(first.event);
    assert.equal(deck.codex.sends.length, disappear ? 2 : 3, "only the captured instance may release its own task");
    await action.onKeyUp(second.event);
    assert.deepEqual(deck.codex.sends, [
      [0, 1, originalKey],
      [1, 1, replacementKey],
      ...(disappear ? [] : [[0, 0, originalKey]]),
      [1, 0, replacementKey],
    ]);
  });
}

test("startup and legacy host action use the local bridge while preserving old private selection files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-local-startup-"));
  const stateRoot = codexDeckStateRoot(process.platform, root, root);
  try {
    await mkdir(stateRoot, { recursive: true });
    const identity = { ...host, platform: process.platform === "darwin" ? "darwin" : "win32" };
    const privateFiles = {
      "host.json": JSON.stringify(identity),
      "relay-client.json": JSON.stringify({ enabled: true, url: "ws://127.0.0.1:9", token: "test-private-token" }),
      "relay-server.json": JSON.stringify({
        enabled: true,
        listenHost: "127.0.0.1",
        port: 9,
        token: "test-private-token",
      }),
    };
    for (const [name, contents] of Object.entries(privateFiles)) await writeFile(join(stateRoot, name), contents);
    const scriptPath = join(root, "startup.mjs");
    const sourceUrl = (path: string) =>
      JSON.stringify(pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href);
    const sdkUrl = import.meta.resolve("@elgato/streamdeck");
    await writeFile(
      scriptPath,
      `
      import assert from "node:assert/strict";
      import streamDeck from ${JSON.stringify(sdkUrl)};
      import { DeckController } from ${sourceUrl("../src/stream-deck/controller.ts")};
      import { Agent1, HostToggle } from ${sourceUrl("../src/stream-deck/actions.ts")};
      streamDeck.settings.getGlobalSettings = async () => ({ activeQueueEnabled: false });
      const { CodexSource } = await import(${sourceUrl("../src/codex/index.ts")});
      const { OpenCodeSource } = await import(${sourceUrl("../src/opencode/index.ts")});
      const { T3CodeSource } = await import(${sourceUrl("../src/t3code/index.ts")});
      const sends = [];
      const codex = new CodexSource(() => {});
      codex.microBridge.refresh = async () => (${JSON.stringify(snapshot)});
      codex.microBridge.sendAgent = async (...args) => { sends.push(args.slice(0, 3)); };
      const controller = new DeckController({ codex, openCode: new OpenCodeSource(() => {}), t3Code: new T3CodeSource(() => {}) });
      const images = [];
      const event = { action: { id: "legacy-profile-key", isKey: () => true,
        setImage: async image => images.push(decodeURIComponent(image)), setTitle: async () => {},
        showAlert: async () => { throw new Error("legacy local action alerted"); }
      } };
      try {
        await controller.start();
        const legacy = new HostToggle(controller);
        legacy.onWillAppear(event);
        await legacy.onKeyDown(event);
        assert.match(images.at(-1), /${identity.platform === "darwin" ? "MAC" : "WIN"}/);
        assert.match(images.at(-1), /data-host-health="ready"/);
        const agent = new Agent1(controller);
        await agent.onKeyDown(event);
        await agent.onKeyUp(event);
        assert.deepEqual(sends, [[0, 1, ${JSON.stringify(snapshot.slots[0]!.threadKey)}], [0, 0, ${JSON.stringify(snapshot.slots[0]!.threadKey)}]]);
        process.stdout.write("LEGACY_STARTUP_SUCCESS\\n");
      } catch (error) { console.error(error); process.exitCode = 1; } finally { controller.stop(); }
    `,
    );
    for (const selection of ["darwin", "win32", "unknown"]) {
      const target = JSON.stringify({ platform: selection });
      await writeFile(join(stateRoot, "control-target.json"), target);
      const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), scriptPath], {
        cwd: root,
        env: { ...process.env, HOME: root, LOCALAPPDATA: root },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /LEGACY_STARTUP_SUCCESS/);
      assert.equal(await readFile(join(stateRoot, "control-target.json"), "utf8"), target);
      for (const [name, contents] of Object.entries(privateFiles))
        assert.equal(await readFile(join(stateRoot, name), "utf8"), contents);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a delayed OpenCode foreground receipt uses the saved revision and does not publish a rejected acknowledgement", async () => {
  let foregroundReady!: () => void;
  const foreground = new Promise<void>((resolve) => {
    foregroundReady = resolve;
  });
  const deck = createDeck({ foregroundOpenCode: () => foreground });
  deck.controller.setAgentDisplaySettings({ taskSource: "OpenCode" });
  await settle();
  let terminalAt = 100;
  const receipts: unknown[][] = [];
  deck.openCode.openCodeCollector = openCodeCollector({
    tasks: () => [
      {
        source: "opencode",
        connectionId: "connection",
        sessionId: "session",
        label: `Finished ${terminalAt}`,
        status: "complete",
        terminalAt,
      },
    ],
    acknowledgeTask: (...args) => {
      receipts.push(args);
      return false;
    },
    publishTaskViewed: async () => assert.fail("rejected stale revision must not be published"),
  });
  const key = fakeKey("late-key", { onAlert: () => assert.fail("stale revision is a safe no-op") });
  const action = new Agent1(deck.controller);
  action.onWillAppear(key.event);
  deck.controller.setAgentDisplaySettings({ taskSource: "OpenCode", activeQueueEnabled: true });
  await settle();
  assert.equal(keyLabel(key.images.at(-1)), "Finished 100");

  const press = action.onKeyDown(key.event);
  assert.deepEqual(receipts, [], "acknowledgement must wait for foregrounding");
  terminalAt = 200;
  deck.controller.setAgentDisplaySettings({ taskSource: "OpenCode", activeQueueEnabled: false });
  await settle();
  foregroundReady();
  await press;
  await action.onKeyUp(key.event);

  assert.deepEqual(receipts, [["connection", "session", 100]]);
  assert.equal(keyLabel(key.images.at(-1)), "Finished 200", "a newer displayed result remains available");
});

for (const [name, platform, barAge, expected] of [
  ["missing CodexBar snapshot", "darwin", undefined, undefined],
  ["stale CodexBar window", "darwin", CODEX_BAR_FRESH_MS + 1, undefined],
  ["fresh CodexBar window", "darwin", 0, 41],
  ["Windows renderer usage ignoring CodexBar", "win32", 0, 73],
] as const) {
  test(`usage buttons honor ${name}`, {
    skip:
      platform === "darwin" && barAge !== undefined && process.platform !== "darwin"
        ? "CodexBar windows are read only on macOS"
        : false,
  }, async (context) => {
    const deck = createDeck();
    deck.codex.localHost = { ...host, platform };
    deck.codex.localSnapshot = {
      host: deck.codex.localHost,
      snapshot: {
        ...snapshot,
        usage: {
          windows: [
            {
              id: "five-hour",
              kind: "five-hour",
              usedPercent: 73,
              remainingPercent: 27,
              windowDurationMins: 300,
              resetsAt: null,
            },
          ],
          observedAt: Date.now(),
          resetCreditsAvailable: null,
          resetCreditsApplicable: null,
        },
      },
      observedAt: Date.now(),
    };
    deck.codex.localHealth = { state: "ready", changedAt: Date.now() };
    await startDeck(context, deck, { codexBarAge: barAge });
    const key = fakeKey(platform);
    deck.controller.registerUsageLimit(key.action, "five-hour");
    await settle();
    deck.controller.registerUsageOverview(key.action);
    await settle();

    assert.equal(key.images.length, 2);
    for (const image of key.images) {
      if (expected === undefined) assert.doesNotMatch(image, /data-usage-used=/);
      else assert.match(image, new RegExp(`data-usage-used="${expected}"`));
      assert.match(image, /data-theme="dark"/);
    }
  });
}

type BridgeInternals = {
  lastSnapshot?: typeof snapshot;
  refresh: () => Promise<typeof snapshot>;
  dispatch: (type: string, payload: { event: { act: number } }) => Promise<void>;
  ensureThreadActivated: () => Promise<void>;
};

for (const outcome of ["release", "disappear", "error", "activation-error"] as const) {
  test(`delayed native Agent refresh preserves captured phases on ${outcome}`, async (context) => {
    const deck = createDeck();
    // The real bridge owns the refresh/dispatch phases under test; its renderer transport has no public seam.
    const bridge = new CodexMicroRendererBridge(() => {});
    const internals = bridge as unknown as BridgeInternals;
    deck.codex.microBridge = bridge;
    deck.codex.localSnapshot = { host, snapshot, observedAt: 1_000 };
    deck.codex.localHealth = { state: "ready", changedAt: 1 };
    await startDeck(context, deck);
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    internals.lastSnapshot = snapshot;
    internals.refresh = async () => {
      await delayed;
      if (outcome === "error") throw new Error("fixture refresh failed");
      return snapshot;
    };
    const phases: number[] = [];
    internals.dispatch = async (_type, payload) => {
      phases.push(payload.event.act);
    };
    internals.ensureThreadActivated = async () => {
      if (outcome === "activation-error") throw new Error("fixture activation failed");
    };
    const down = deck.controller.sendAgent(0, 1, { id: "slow" });
    const up = deck.controller.sendAgent(0, 0, { id: "slow" });
    await settle();
    assert.deepEqual(phases, []);
    if (outcome === "disappear") deck.controller.unregisterAgent({ id: "slow" });
    finish();
    if (outcome === "error" || outcome === "activation-error") {
      await assert.rejects(down, /fixture (refresh|activation) failed/);
      await up;
    } else await Promise.all([down, up]);
    assert.deepEqual(phases, outcome === "release" || outcome === "activation-error" ? [1, 0] : []);
  });
}

test("reasoning holds isolate button contexts and discard late generations", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const deck = createDeck();
  const calls: string[] = [];
  let resolveOld!: () => void;
  let first = true;
  deck.codex.microBridge.adjustReasoning = async () => {
    calls.push("adjust");
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        resolveOld = resolve;
      });
    }
  };
  const action = new ReasoningUp(deck.controller);
  const event = (id: string) => ({ action: { id, showAlert: async () => assert.fail("unexpected alert") } });
  const old = action.onKeyDown(event("A") as never);
  await action.onKeyDown(event("B") as never);
  assert.equal(calls.length, 2, "another button must act while A is awaiting");
  action.onKeyUp(event("B") as never);
  action.onKeyUp(event("A") as never);
  await action.onKeyDown(event("A") as never);
  resolveOld();
  await old;
  context.mock.timers.tick(499);
  assert.equal(calls.length, 3);
  context.mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 4, "both contexts run and only the current A repeats after 500 ms");
  context.mock.timers.tick(299);
  assert.equal(calls.length, 4);
  context.mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 5, "subsequent repeats wait 300 ms");
  action.onWillDisappear(event("A") as never);
  context.mock.timers.tick(1_000);
  assert.equal(calls.length, 5);
});

test("legacy reset key never spends credits on short, long, or disappearing presses", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const deck = createDeck();
  const usage = { windows: [], observedAt: Date.now(), resetCreditsAvailable: 1, resetCreditsApplicable: 1 };
  deck.codex.localSnapshot = { host, snapshot: { ...snapshot, usage }, observedAt: Date.now() };
  const key = fakeKey("reset-key", { onAlert: () => assert.fail("a reset press must not alert") });
  const action = new RateLimitReset(deck.controller);
  action.onWillAppear(key.event);
  action.onKeyDown?.(key.event);
  context.mock.timers.tick(1_199);
  await action.onKeyUp?.(key.event);
  assert.equal(deck.codex.consumed, 0);
  action.onKeyDown?.(key.event);
  context.mock.timers.tick(1_200);
  action.onWillDisappear(key.event);
  await action.onKeyUp?.(key.event);
  assert.equal(deck.codex.consumed, 0);
  action.onWillAppear(key.event);
  for (const [available, applicable] of [
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    usage.resetCreditsAvailable = available;
    usage.resetCreditsApplicable = applicable;
    action.onKeyDown?.(key.event);
    context.mock.timers.tick(1_200);
    await action.onKeyUp?.(key.event);
  }
  assert.equal(deck.codex.consumed, 0, "presses must never spend reset credits");
  assert.equal(key.alerts(), 0);
});

test("an empty Agent press queued behind a prior pair captures its no-op before settings change", async (context) => {
  const original = createMicroSnapshot();
  original.slots.forEach((slot) => {
    slot.status = "idle";
    slot.selected = false;
  });
  original.slots[0]!.status = "working";
  const idle = structuredClone(original);
  idle.slots[0]!.status = "idle";
  const later = structuredClone(idle);
  later.slots[1]!.status = "working";
  const deck = createDeck();
  deck.codex.localSnapshot = { host, snapshot: original, observedAt: 1_000 };
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  await startDeck(context, deck, { settings: { activeQueueEnabled: true }, mockTimers: true });
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const phases: unknown[][] = [];
  deck.codex.microBridge.sendAgent = async (...args) => {
    if (args[1] === 1) await delayed;
    phases.push(args.slice(0, 3));
  };

  const down = deck.controller.sendAgent(0, 1, { id: "queued" });
  const up = deck.controller.sendAgent(0, 0, { id: "queued" });
  deck.codex.localSnapshot = { host, snapshot: idle, observedAt: 1_500 };
  await poll(context, deck);
  const emptyDown = deck.controller.sendAgent(0, 1, { id: "queued" });
  deck.codex.localSnapshot = { host, snapshot: later, observedAt: 2_000 };
  deck.controller.setAgentDisplaySettings({ activeQueueEnabled: false });
  await settle();
  const emptyUp = deck.controller.sendAgent(0, 0, { id: "queued" });
  finish();
  await Promise.all([down, up, emptyDown, emptyUp]);
  assert.deepEqual(phases, [
    [0, 1, original.slots[0]!.threadKey],
    [0, 0, original.slots[0]!.threadKey],
  ]);
});

test("T3 Agent presses acknowledge the captured result and never send Codex phases", async () => {
  let foregrounds = 0;
  const deck = createDeck({
    foregroundT3Code: async () => {
      foregrounds++;
    },
  });
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  deck.controller.setAgentDisplaySettings({ taskSource: "T3 Code" });
  await settle();
  deck.t3Code.slots = [
    {
      id: 0,
      sourceSlot: 0,
      host,
      threadKey: "thread",
      title: "T3 task",
      status: "unread",
      taskSource: "t3code",
      selected: false,
      activityAt: Date.now(),
      observedAt: Date.now(),
    },
  ];
  deck.t3Code.health = { state: "ready", changedAt: Date.now() };
  deck.codex.microBridge.sendAgent = async () => {
    throw new Error("T3 press reached Codex");
  };
  const key = fakeKey("t3-key");
  deck.controller.registerAgent(0, key.action);
  deck.controller.setAgentDisplaySettings({ taskSource: "T3 Code", activeQueueEnabled: true });
  await settle();
  assert.equal(keyLabel(key.images.at(-1)), "T3 task");
  assert.match(key.images.at(-1)!, /data-agent-host="T3"/);

  await deck.controller.sendAgent(0, 1, { id: "t3-key" });
  await deck.controller.sendAgent(0, 0, { id: "t3-key" });

  assert.equal(foregrounds, 1);
  assert.deepEqual(deck.t3Code.slots, []);
  assert.equal(keyLabel(key.images.at(-1)), "black", "the acknowledged result leaves the queue");
  deck.controller.stop();
});

test("overlapping refresh triggers share one source poll, and an Agent press-down does not refresh", async (context) => {
  const deck = createDeck();
  deck.codex.localSnapshot = { host, snapshot: createMicroSnapshot(), observedAt: Date.now() };
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  await startDeck(context, deck, { mockTimers: true });
  assert.equal(deck.codex.refreshes, 1, "start polls the source once");

  await deck.controller.sendAgent(0, 1, { id: "key" });
  await drain();
  assert.equal(deck.codex.refreshes, 1, "a press-down does not trigger another poll");

  let releasePoll!: () => void;
  deck.codex.refreshGate = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  context.mock.timers.tick(1_200);
  await eventually(() => assert.equal(deck.codex.refreshes, 2));

  await deck.controller.sendAgent(0, 0, { id: "key" });
  await drain();
  assert.equal(deck.codex.refreshes, 2, "the release joins the poll that is still in flight");

  deck.codex.refreshGate = undefined;
  releasePoll();
  await drain();
  assert.equal(deck.codex.refreshes, 2, "settling the shared poll starts no additional poll");

  await poll(context, deck);
  assert.equal(deck.codex.refreshes, 3, "the next scheduled poll runs once the shared one has settled");
});

test("animated Agent frames clear each registration title once", async (context) => {
  const deck = createDeck();
  const input = createMicroSnapshot();
  for (const slot of input.slots) {
    slot.status = "working";
    slot.selected = false;
  }
  deck.codex.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  deck.codex.localHealth = { state: "ready", changedAt: 1 };
  await startDeck(context, deck, { mockTimers: true });
  const keys = registerAgents(deck.controller, 6);
  await drain();
  const initialImages = keys.map((key) => key.images.length);
  for (let frame = 0; frame < 120; frame++) {
    context.mock.timers.tick(200);
    await drain();
  }
  assert.deepEqual(
    keys.map((key) => key.images.length - initialImages[keys.indexOf(key)]!),
    [120, 120, 120, 120, 120, 120],
  );
  assert.deepEqual(
    keys.map((key) => key.titles),
    [[""], [""], [""], [""], [""], [""]],
  );
});

function titleEvents(context: TestContext) {
  const listeners = new Set<(event: TitleParametersDidChangeEvent) => void>();
  context.mock.method(
    streamDeck.actions,
    "onTitleParametersDidChange",
    (listener: (event: TitleParametersDidChangeEvent) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  );
  return {
    size: () => listeners.size,
    dispatch: (key: FakeKey, title: string) => {
      for (const listener of listeners) listener({ action: key.action, payload: { title } } as never);
    },
  };
}

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("concurrent public renders share a title clear and retry a failed clear with unchanged image", async (context) => {
  const events = titleEvents(context);
  const deck = createDeck();
  await startDeck(context, deck, { mockTimers: true });
  const key = fakeKey("shared-title");
  deck.controller.registerAgent(0, key.action);
  await drain();
  const gate = defer();
  context.mock.method(key.action, "setTitle", async (title: string) => {
    key.titles.push(title);
    await gate.promise;
  });
  events.dispatch(key, "External");
  const first = deck.controller.toggleTargetHost();
  const second = deck.controller.toggleTargetHost();
  await drain();
  assert.deepEqual(key.titles, ["", ""]);
  assert.equal(key.images.length, 1);
  gate.resolve();
  await Promise.all([first, second]);

  let failed = false;
  context.mock.method(key.action, "setTitle", async (title: string) => {
    key.titles.push(title);
    if (!failed) {
      failed = true;
      throw new Error("title send failed");
    }
  });
  events.dispatch(key, "External again");
  await assert.rejects(deck.controller.toggleTargetHost(), /title send failed/);
  await deck.controller.toggleTargetHost();
  assert.deepEqual(key.titles, ["", "", "", ""]);
  assert.equal(key.images.length, 1, "retrying the title does not resend a successful image");
});

test("a rejected image retries without repeating a successful title clear", async (context) => {
  const events = titleEvents(context);
  const deck = createDeck();
  await startDeck(context, deck, { mockTimers: true });
  const key = fakeKey("image-retry");
  deck.controller.registerHostToggle(key.action);
  await drain();
  deck.codex.localHealth = { state: "ready", changedAt: 2 };
  let failed = false;
  context.mock.method(key.action, "setImage", async (image: string) => {
    if (!failed) {
      failed = true;
      throw new Error("image send failed");
    }
    key.images.push(decodeURIComponent(image));
  });
  events.dispatch(key, "External");
  await assert.rejects(deck.controller.toggleTargetHost(), /image send failed/);
  await drain();
  await deck.controller.toggleTargetHost();
  assert.deepEqual(key.titles, ["", ""]);
  assert.equal(key.images.length, 2);
});

test("disappearance and same-id registration isolate late title completion for Agent and host keys", async (context) => {
  const events = titleEvents(context);
  const deck = createDeck();
  await startDeck(context, deck, { mockTimers: true });
  for (const kind of ["agent", "host"] as const) {
    const old = fakeKey(kind);
    const oldGate = defer();
    context.mock.method(old.action, "setTitle", async (title: string) => {
      old.titles.push(title);
      await oldGate.promise;
    });
    if (kind === "agent") deck.controller.registerAgent(0, old.action);
    else deck.controller.registerHostToggle(old.action);
    await drain();
    if (kind === "agent") deck.controller.unregisterAgent({ id: kind });
    else deck.controller.unregisterHostToggle({ id: kind });
    const next = fakeKey(kind);
    if (kind === "agent") deck.controller.registerAgent(0, next.action);
    else deck.controller.registerHostToggle(next.action);
    await drain();
    assert.deepEqual(next.titles, [""], "the new context sends its own clear");
    events.dispatch(next, "External after registration");
    oldGate.resolve();
    await drain();
    await deck.controller.toggleTargetHost();
    assert.deepEqual(next.titles, ["", ""], "the old success cannot suppress a new context clear");
    if (kind === "agent") deck.controller.registerAgent(0, next.action);
    else deck.controller.registerHostToggle(next.action);
    await drain();
    assert.deepEqual(next.titles, ["", "", ""], "even the same action object starts a fresh registration");
    if (kind === "agent") deck.controller.unregisterAgent({ id: kind });
    else deck.controller.unregisterHostToggle({ id: kind });
  }
});

test("nonempty title events survive an in-flight clear, ignore empty echoes, and dispose across restart", async (context) => {
  const events = titleEvents(context);
  const deck = createDeck();
  await startDeck(context, deck, { mockTimers: true });
  const key = fakeKey("external-title");
  deck.controller.registerAgent(0, key.action);
  await drain();
  const gate = defer();
  context.mock.method(key.action, "setTitle", async (title: string) => {
    key.titles.push(title);
    events.dispatch(key, "");
    await gate.promise;
  });
  events.dispatch(key, "External");
  const clear = deck.controller.toggleTargetHost();
  events.dispatch(key, "Changed during send");
  gate.resolve();
  await clear;
  await deck.controller.toggleTargetHost();
  await deck.controller.toggleTargetHost();
  assert.deepEqual(key.titles, ["", "", ""]);
  assert.equal(key.images.length, 1);
  assert.equal(events.size(), 1);
  deck.controller.stop();
  assert.equal(events.size(), 0);
  events.dispatch(key, "Stopped");
  await deck.controller.start();
  assert.equal(events.size(), 1);
  assert.deepEqual(key.titles, ["", "", "", ""], "restart establishes a fresh title clear");
  deck.controller.stop();
  assert.equal(events.size(), 0);
});

for (const outcome of ["disappearance", "replacement", "stop"] as const) {
  test(`a delayed fixed-key image cannot restore the title context after ${outcome}`, async (context) => {
    const deck = createDeck();
    await startDeck(context, deck, { mockTimers: true });
    const gate = defer();
    const reachedRead = defer();
    const originalRead = fsPromises.readFile;
    const read = context.mock.method(fsPromises, "readFile", (async (
      ...args: Parameters<typeof fsPromises.readFile>
    ) => {
      if (basename(String(args[0])) !== "delayed-title-keycap.svg") return originalRead(...args);
      reachedRead.resolve();
      await gate.promise;
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#f00"/></svg>';
    }) as typeof fsPromises.readFile);
    syncBuiltinESMExports();
    context.after(() => {
      read.mock.restore();
      syncBuiltinESMExports();
    });
    const old = fakeKey("delayed-fixed-title");
    deck.controller.registerFixedAction(old.action, { kind: "local", keycapId: "delayed-title-keycap" });
    await reachedRead.promise;
    let replacement: FakeKey | undefined;
    if (outcome === "stop") deck.controller.stop();
    else {
      deck.controller.unregisterFixedAction({ id: old.action.id });
      if (outcome === "replacement") {
        replacement = fakeKey(old.action.id);
        deck.controller.registerFixedAction(replacement.action, { kind: "local", keycapId: "delayed-title-keycap" });
      }
    }
    gate.resolve();
    await drain();
    assert.deepEqual(old.titles, [], "a retired action cannot re-create a title clear");
    assert.deepEqual(old.images, [], "a retired action sends no delayed image");
    if (replacement) {
      assert.equal(replacement.images.length, 1);
      assert.deepEqual(replacement.titles, [""]);
    }
    if (outcome === "stop") {
      await deck.controller.start();
      assert.equal(old.images.length, 1, "the current fixed registration still renders after restart");
      assert.deepEqual(old.titles, [""]);
    }
  });
}
