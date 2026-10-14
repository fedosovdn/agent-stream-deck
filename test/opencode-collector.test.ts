import assert from "node:assert/strict";
import nodeTest, { type TestContext } from "node:test";
import { setImmediate as yieldIO } from "node:timers/promises";
import { OpenCodeCollector, type OpenCodeCollectorDependencies, type OpenCodeProcess } from "#opencode";
import { findOrphanedTunnels, sshCommonArgs, sshTunnelArgs, TUNNEL_FORWARD_PLACEHOLDER } from "../src/opencode/ssh.js";

// OpenCode collection is macOS-only (`shouldCollectOpenCode` returns false on Windows), so its tests skip there.
const OPENCODE_PLATFORM_SKIP = process.platform === "win32" ? "OpenCode collection runs only on macOS" : false;

function test(name: string, fn: (context: TestContext) => void | Promise<void>): void {
  void nodeTest(name, { skip: OPENCODE_PLATFORM_SKIP }, fn);
}

const SECRET = "0123456789abcdef0123456789abcdef";
const HOME = "/fixture/home";
const STATE = `${HOME}/.local/state/opencode`;
const SETTINGS = `${HOME}/Library/Application Support/ai.opencode.desktop/opencode.settings`;

type FileEntry = { body: unknown; safe?: boolean };
type CapturedRequest = {
  url: string;
  method: string;
  authorization?: string;
  contentType?: string;
  body?: string;
};
type RouteEntry = Response | ((request: CapturedRequest) => Response | Promise<Response>);

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(value))) },
  });
}

function session(
  id: string,
  updated: number,
  input: {
    parentID?: string;
    outcome?: "succeeded" | "failed" | "interrupted";
    idle?: number;
    viewed?: number;
    title?: string;
  } = {},
) {
  return {
    id,
    parentID: input.parentID,
    title: input.title ?? `PRIVATE TITLE ${id}`,
    location: { directory: `/private/${id}` },
    cost: 999,
    tokens: { input: 123 },
    outcome: input.outcome,
    time: { created: updated - 100, updated, idle: input.idle, viewed: input.viewed },
  };
}

function fixture(input: {
  files?: Record<string, FileEntry>;
  routes?: Record<string, RouteEntry>;
  now?: number | (() => number);
  processes?: OpenCodeProcess[];
  waitForTunnel?: boolean;
}) {
  const files = input.files ?? {};
  const requests: CapturedRequest[] = [];
  const processes = [...(input.processes ?? [])];
  const terminated: number[] = [];
  const intervals: number[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; detached: boolean }> = [];
  const reaped: string[][] = [];
  const dependencies: OpenCodeCollectorDependencies = {
    homeDirectory: HOME,
    stateDirectory: STATE,
    settingsPath: SETTINGS,
    currentUid: 501,
    now: () => (typeof input.now === "function" ? input.now() : (input.now ?? 1_000_000)),
    setInterval: (_callback, milliseconds) => {
      intervals.push(milliseconds);
      return {} as NodeJS.Timeout;
    },
    clearInterval: () => undefined,
    files: {
      async list(path) {
        if (path !== STATE) return [];
        return Object.keys(files)
          .filter((file) => file.startsWith(`${STATE}/`))
          .map((file) => file.slice(STATE.length + 1));
      },
      async readSecure(path) {
        const entry = files[path];
        if (!entry) throw new Error("missing");
        if (entry.safe === false) throw new Error("unsafe");
        return Buffer.from(JSON.stringify(entry.body));
      },
    },
    async fetch(url, init) {
      const headers = new Headers(init?.headers);
      const request = {
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization") ?? undefined,
        contentType: headers.get("content-type") ?? undefined,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      requests.push(request);
      const parsed = new URL(url);
      const route =
        input.routes?.[`${parsed.host}${parsed.pathname}${parsed.search}`] ??
        input.routes?.[parsed.pathname + parsed.search] ??
        input.routes?.[parsed.pathname];
      if (!route) throw new Error("unavailable");
      return typeof route === "function" ? route(request) : route.clone();
    },
    async spawn(command, args, options) {
      spawnCalls.push({ command, args: [...args], env: { ...options.env }, detached: options.detached });
      const process = processes.shift();
      if (!process) throw new Error("unexpected spawn");
      return process;
    },
    async reserveLoopbackPort() {
      return 43123;
    },
    async waitForLoopbackPort() {
      return input.waitForTunnel !== false;
    },
    async terminateProcessGroup(process) {
      terminated.push(process.pid);
      process.kill("SIGTERM");
    },
    async reapOrphanedTunnels(templates) {
      reaped.push([...templates]);
    },
  };
  return { dependencies, requests, terminated, spawnCalls, intervals, reaped };
}

function localRegistration(extra: Record<string, unknown> = {}) {
  return {
    id: "managed",
    url: "http://127.0.0.1:4096",
    password: "fixture-password",
    version: "2.0.5",
    pid: 42,
    ...extra,
  };
}

function basicRoutes(now = 1_000_000): Record<string, RouteEntry> {
  return {
    "/api/info": ({ authorization }: { authorization?: string }) =>
      authorization ? response({ version: "2.0.5", pid: 42 }) : response({}, 401),
    "/api/session/active": response({ data: {} }),
    "/api/permission/request": response({ data: [] }),
    "/api/form": response({ data: [] }),
    "/api/session?parentID=null&order=desc&limit=100": response({
      data: [session("ses_idle", now - 100)],
      cursor: {},
    }),
  };
}

// start now establishes readiness; explicit refresh is the complete-snapshot boundary for these existing assertions.
async function startAndRefresh(collector: OpenCodeCollector) {
  await collector.start();
  return collector.refresh();
}

test("shares pending ancestor reads only within one connection refresh and retries changed or failed data", async () => {
  const now = 1_000_000;
  let title = "First root";
  let fail = false;
  const children = ["ses_child1", "ses_child2", "ses_child3", "ses_child4"];
  const routes = basicRoutes(now);
  routes["/api/permission/request"] = response({ data: children.map((sessionID) => ({ sessionID })) });
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({ data: [], cursor: {} });
  for (const id of children)
    routes[`/api/session/${id}`] = response({ data: session(id, now, { parentID: "ses_parent" }) });
  routes["/api/session/ses_parent"] = async () => {
    // Let every ready child reach its parent while that response is still pending.
    await yieldIO();
    return fail ? response({}, 500) : response({ data: session("ses_parent", now, { parentID: "ses_root" }) });
  };
  routes["/api/session/ses_root"] = async () => {
    await yieldIO();
    return response({ data: session("ses_root", now, { title }) });
  };
  const setup = fixture({
    now,
    files: {
      [`${STATE}/service.one.json`]: { body: localRegistration({ id: "one" }) },
      [`${STATE}/service.two.json`]: { body: localRegistration({ id: "two", url: "http://127.0.0.1:4097" }) },
    },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  const parentReads = () =>
    setup.requests.filter((request) => new URL(request.url).pathname === "/api/session/ses_parent");
  try {
    const first = await startAndRefresh(collector);
    assert.deepEqual(
      first.connections.map((connection) => [connection.health, connection.tasks[0]?.displayTitle]),
      [
        ["ready", "First root"],
        ["ready", "First root"],
      ],
    );
    assert.deepEqual(
      parentReads()
        .map((request) => new URL(request.url).port)
        .sort(),
      ["4096", "4097"],
    );
    assert.equal(
      setup.requests.filter((request) => new URL(request.url).pathname === "/api/session/ses_root").length,
      2,
    );
    title = "Changed root";
    const changed = await collector.refresh();
    assert.deepEqual(
      changed.connections.map((connection) => connection.tasks[0]?.displayTitle),
      ["Changed root", "Changed root"],
    );
    assert.equal(parentReads().length, 4);
    fail = true;
    const failed = await collector.refresh();
    assert.deepEqual(
      failed.connections.map((connection) => [connection.health, connection.tasks]),
      [
        ["unavailable", []],
        ["unavailable", []],
      ],
    );
    fail = false;
    const recovered = await collector.refresh();
    assert.deepEqual(
      recovered.connections.map((connection) => connection.health),
      ["ready", "ready"],
    );
    assert.equal(parentReads().length, 8);
  } finally {
    await collector.stop();
  }
});

test("shared ancestor reads retain cycle, depth and session capacity guards", async () => {
  for (const kind of ["cycle", "depth", "capacity"] as const) {
    const routes = basicRoutes();
    const children = Array.from({ length: kind === "capacity" ? 200 : 4 }, (_, index) => `ses_child${index}`);
    routes["/api/permission/request"] = response({ data: children.map((sessionID) => ({ sessionID })) });
    routes["/api/session?parentID=null&order=desc&limit=100"] = response({
      data: kind === "capacity" ? Array.from({ length: 100 }, (_, index) => session(`ses_root${index}`, 999_900)) : [],
      cursor: {},
    });
    for (const id of children)
      routes[`/api/session/${id}`] = response({
        data: session(id, 999_900, { parentID: kind === "capacity" ? "ses_root0" : "ses_parent0" }),
      });
    for (let index = 0; index < 16; index++) {
      const id = `ses_parent${index}`;
      routes[`/api/session/${id}`] = async () => {
        await yieldIO();
        return response({ data: session(id, 999_900, { parentID: kind === "cycle" ? id : `ses_parent${index + 1}` }) });
      };
    }
    const setup = fixture({ files: { [`${STATE}/service.json`]: { body: localRegistration() } }, routes });
    const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
    try {
      const snapshot = await startAndRefresh(collector);
      assert.equal(snapshot.connections[0]!.health, kind === "cycle" ? "unavailable" : "capacity-exceeded", kind);
      assert.equal(snapshot.connections[0]!.complete, false, kind);
      assert.deepEqual(
        snapshot.connections[0]!.tasks.map((task) => task.sessionId),
        kind === "capacity" ? ["ses_root0"] : [],
        kind,
      );
      assert.equal(
        setup.requests.some((request) => new URL(request.url).pathname === "/api/session/ses_parent15"),
        false,
        "the 16-level budget includes the child",
      );
      const childReads = setup.requests.filter((request) =>
        new URL(request.url).pathname.startsWith("/api/session/ses_child"),
      );
      assert.ok(
        childReads.length <= 103,
        "100 roots leave room for 100 children, with at most three already pending reads",
      );
    } finally {
      await collector.stop();
    }
  }
});

test("discovers a descriptor-approved local registration without publishing its endpoint or password", async () => {
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: basicRoutes(),
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.equal(snapshot.connections.length, 1);
  assert.equal(snapshot.connections[0]!.health, "ready");
  assert.deepEqual(snapshot.connections[0]!.tasks, []);
  assert.match(snapshot.connections[0]!.connectionId, /^oc_[A-Za-z0-9_-]+$/u);
  assert.equal(JSON.stringify(snapshot).includes("4096"), false);
  assert.equal(JSON.stringify(snapshot).includes("fixture-password"), false);
  assert.ok(
    setup.requests.every(
      (request) => request.authorization == null || !request.authorization.includes("fixture-password"),
    ),
  );
  assert.deepEqual(setup.intervals, [5_000]);
});

test("prefers api info and reuses its authenticated identity route across polls", async () => {
  const routes = basicRoutes();
  routes["/api/status"] = ({ authorization }) => (authorization ? response({}, 404) : response({}, 401));
  routes["/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.5", pid: 42, urls: [], paths: {} }) : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.refresh();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "ready");
  const statusRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/status");
  const infoRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/info");
  assert.equal(statusRequests.length, 0);
  assert.deepEqual(
    infoRequests.map((request) => request.authorization === undefined),
    [true, false, false],
  );
});

test("falls back to legacy api status and reuses it across polls", async () => {
  const routes = basicRoutes();
  routes["/api/info"] = response({}, 404);
  routes["/api/status"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.5", pid: 42 }) : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.refresh();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "ready");
  const infoRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/info");
  const statusRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/status");
  assert.equal(infoRequests.length, 1);
  assert.deepEqual(
    statusRequests.map((request) => request.authorization === undefined),
    [true, false, false],
  );
});

test("reprobes the authentication boundary when a local registration changes", async () => {
  const registration = localRegistration();
  let identityPid = registration.pid;
  const routes = basicRoutes();
  routes["/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.5", pid: identityPid }) : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: registration } },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  await startAndRefresh(collector);
  registration.pid = 43;
  identityPid = 43;
  await collector.refresh();
  await collector.stop();

  const infoRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/info");
  assert.deepEqual(
    infoRequests.map((request) => request.authorization === undefined),
    [true, false, true, false],
  );
});

test("rejects unsafe, non-loopback, broad, and incompatible registrations before fetch", async () => {
  const files: Record<string, FileEntry> = {
    [`${STATE}/service.json`]: { body: localRegistration(), safe: false },
    [`${STATE}/service-bad-url.json`]: { body: localRegistration({ id: "bad-url", url: "http://example.com:4096" }) },
    [`${STATE}/service-bad-version.json`]: { body: localRegistration({ id: "bad-version", version: "" }) },
    [`${STATE}/service-bad-pid.json`]: { body: localRegistration({ id: "bad-pid", pid: 0 }) },
  };
  const setup = fixture({ files, routes: basicRoutes() });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.deepEqual(snapshot.connections, []);
  assert.equal(setup.requests.length, 0);
});

test("accepts a future service version when the authenticated API capabilities still match", async () => {
  const routes = basicRoutes();
  routes["/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.6", pid: 42 }) : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration({ version: "2.0.6" }) } },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "ready");
});

test("rejects a stale registration when the authenticated service identity does not match", async () => {
  const routes = basicRoutes();
  routes["/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.7", pid: 42 }) : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration({ version: "2.0.6" }) } },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "incompatible");
});

test("does not send a local service credential before the authentication boundary is proven", async () => {
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: { "/api/info": response({ version: "2.0.5", pid: 42 }) },
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "incompatible");
  assert.deepEqual(
    setup.requests.map((request) => request.authorization),
    [undefined],
  );
});

test("projects only sanitized roots with attention precedence and mixed active and terminal states", async () => {
  const now = 2_000_000;
  const roots = [
    session("ses_attention", now - 1_000),
    session("ses_working", now - 2_000),
    session("ses_complete", now - 3_000, { outcome: "succeeded", idle: now - 3_000 }),
    session("ses_error", now - 4_000, { outcome: "failed", idle: now - 4_000 }),
    session("ses_idle", now - 5_000),
    session("ses_interrupted", now - 6_000, { outcome: "interrupted", idle: now - 6_000 }),
  ];
  const child = session("ses_child", now - 500, { parentID: "ses_attention" });
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: {
      "/api/info": ({ authorization }) => (authorization ? response({ version: "2.0.5", pid: 42 }) : response({}, 401)),
      "/api/session/active": response({
        data: { ses_working: { type: "running" }, ses_attention: { type: "running" } },
      }),
      "/api/permission/request": response({
        data: [{ id: "per_private", sessionID: "ses_child", resources: ["SECRET_RESOURCE"] }],
      }),
      "/api/form": response({
        data: [{ id: "frm_private", sessionID: "ses_attention", title: "SECRET_FORM", fields: [] }],
      }),
      "/api/session?parentID=null&order=desc&limit=100": response({ data: roots, cursor: {} }),
      "/api/session/ses_child": response({ data: child }),
    },
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();
  const tasks = snapshot.connections[0]!.tasks;

  assert.deepEqual(
    tasks.map((task) => [task.sessionId, task.status]),
    [
      ["ses_attention", "attention"],
      ["ses_error", "error"],
      ["ses_complete", "complete"],
      ["ses_working", "working"],
    ],
  );
  assert.deepEqual(
    tasks.find((task) => task.sessionId === "ses_working"),
    {
      source: "opencode",
      connectionId: tasks[0]!.connectionId,
      sessionId: "ses_working",
      label: "OpenCode 4",
      displayTitle: "PRIVATE TITLE ses_working",
      status: "working",
      workStartedAt: now - 2_100,
      workStartRevision: 0,
    },
  );
  assert.deepEqual(
    tasks.map((task) => task.displayTitle),
    [
      "PRIVATE TITLE ses_attention",
      "PRIVATE TITLE ses_error",
      "PRIVATE TITLE ses_complete",
      "PRIVATE TITLE ses_working",
    ],
  );
  assert.deepEqual(
    tasks.map((task) => task.label),
    ["OpenCode 1", "OpenCode 2", "OpenCode 3", "OpenCode 4"],
  );
  const serialized = JSON.stringify(snapshot);
  for (const privateValue of ["/private/", "SECRET_RESOURCE", "SECRET_FORM", "cost", "tokens", "location"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test("bounds and sanitizes titles before local rendering", async () => {
  const routes = basicRoutes();
  routes["/api/session/active"] = response({ data: { ses_title: { type: "running" } } });
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_title", 999_000, { title: `  Visible\u0000 chat\n${"界".repeat(200)}  ` })],
    cursor: {},
  });
  const setup = fixture({ files: { [`${STATE}/service.json`]: { body: localRegistration() } }, routes });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();
  const title = snapshot.connections[0]!.tasks[0]!.displayTitle;

  assert.ok(title?.startsWith("Visible chat "));
  assert.ok(Buffer.byteLength(title ?? "", "utf8") <= 256);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject or strip untrusted control characters deliberately.
  assert.doesNotMatch(title ?? "", /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
});

test("expires successful and failed terminal outcomes five minutes after their event", async () => {
  let now = 3_000_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [
      session("ses_complete", now - 299_999, { outcome: "succeeded", idle: now - 299_999 }),
      session("ses_error", now - 299_999, { outcome: "failed", idle: now - 299_999 }),
      session("ses_old", now - 300_000, { outcome: "failed", idle: now - 300_000 }),
      session("ses_viewed", now - 1_000, { outcome: "failed", idle: now - 1_000, viewed: now - 500 }),
    ],
    cursor: {},
  });
  const setup = fixture({
    now: () => now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await startAndRefresh(collector);
  now += 1;
  const later = await collector.refresh();
  await collector.stop();

  assert.deepEqual(
    first.connections[0]!.tasks.map((task) => task.sessionId),
    ["ses_error", "ses_complete"],
  );
  assert.deepEqual(later.connections[0]!.tasks, []);
});

test("acknowledges only the current terminal result and shows a later completion again", async () => {
  const now = 3_000_000;
  let idle = now - 1_000;
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: {
      ...basicRoutes(now),
      "/api/session?parentID=null&order=desc&limit=100": () =>
        response({
          data: [session("ses_ack", idle, { outcome: "succeeded", idle })],
          cursor: {},
        }),
    },
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await startAndRefresh(collector);
  const task = first.connections[0]!.tasks[0]!;
  assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
  assert.deepEqual(collector.snapshot().connections[0]!.tasks, []);

  const sameResult = await collector.refresh();
  assert.deepEqual(sameResult.connections[0]!.tasks, []);

  idle += 500;
  const nextResult = await collector.refresh();
  await collector.stop();

  assert.deepEqual(
    nextResult.connections[0]!.tasks.map((candidate) => candidate.sessionId),
    ["ses_ack"],
  );
});

test("publishes the acknowledged terminal revision through the official session view route", async () => {
  const now = 3_000_000;
  const idle = now - 1_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_ack", idle, { outcome: "succeeded", idle })],
    cursor: {},
  });
  routes["/api/session/ses_ack/view"] = (request) => {
    assert.equal(request.method, "POST");
    assert.notEqual(request.authorization, undefined);
    assert.equal(request.contentType, "application/json");
    assert.deepEqual(JSON.parse(request.body ?? "null"), { idle });
    return new Response(null, { status: 204 });
  };
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration({ version: "2.0.10" }) } },
    routes: {
      ...routes,
      "/api/info": ({ authorization }) =>
        authorization ? response({ version: "2.0.10", pid: 42 }) : response({}, 401),
    },
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await startAndRefresh(collector);
  const task = first.connections[0]!.tasks[0]!;
  assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
  assert.equal(await collector.publishTaskViewed(task.connectionId, task.sessionId), true);
  await collector.stop();

  assert.equal(setup.requests.filter((request) => new URL(request.url).pathname.endsWith("/view")).length, 1);
  assert.deepEqual(collector.snapshot().connections[0]!.tasks, []);
});

test("keeps the local acknowledgement when the session view route is unavailable", async () => {
  const now = 3_000_000;
  const idle = now - 1_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_legacy", idle, { outcome: "failed", idle })],
    cursor: {},
  });
  routes["/api/session/ses_legacy/view"] = response({}, 404);
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await startAndRefresh(collector);
  const task = first.connections[0]!.tasks[0]!;
  assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
  assert.equal(await collector.publishTaskViewed(task.connectionId, task.sessionId), false);
  await collector.stop();

  assert.deepEqual(collector.snapshot().connections[0]!.tasks, []);
});

test("does not publish a synthetic view revision when OpenCode omits the idle timestamp", async () => {
  const now = 3_000_000;
  const updated = now - 1_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_no_idle", updated, { outcome: "succeeded" })],
    cursor: {},
  });
  routes["/api/session/ses_no_idle/view"] = new Response(null, { status: 204 });
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration({ version: "2.0.10" }) } },
    routes: {
      ...routes,
      "/api/info": ({ authorization }) =>
        authorization ? response({ version: "2.0.10", pid: 42 }) : response({}, 401),
    },
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await startAndRefresh(collector);
  const task = first.connections[0]!.tasks[0]!;
  assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
  assert.equal(await collector.publishTaskViewed(task.connectionId, task.sessionId), false);
  await collector.stop();

  assert.equal(
    setup.requests.some((request) => new URL(request.url).pathname.endsWith("/view")),
    false,
  );
});

test("does not acknowledge a newer terminal revision through a stale displayed assignment", async () => {
  const now = 3_000_000;
  let idle = now - 1_000;
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: {
      ...basicRoutes(now),
      "/api/session?parentID=null&order=desc&limit=100": () =>
        response({
          data: [session("ses_race", idle, { outcome: "succeeded", idle })],
          cursor: {},
        }),
    },
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await startAndRefresh(collector);
  const displayed = first.connections[0]!.tasks[0]!;
  idle += 500;
  const refreshed = await collector.refresh();
  const current = refreshed.connections[0]!.tasks[0]!;

  assert.notEqual(displayed.terminalAt, current.terminalAt);
  assert.equal(collector.acknowledgeTask(displayed.connectionId, displayed.sessionId, displayed.terminalAt!), false);
  assert.deepEqual(
    collector.snapshot().connections[0]!.tasks.map((task) => task.terminalAt),
    [current.terminalAt],
  );
  await collector.stop();
});

test("keeps a healthy connection visible when another connection fails", async () => {
  const files = {
    [`${STATE}/service-a.json`]: { body: localRegistration({ id: "a", url: "http://127.0.0.1:4101", pid: 101 }) },
    [`${STATE}/service-b.json`]: { body: localRegistration({ id: "b", url: "http://127.0.0.1:4102", pid: 102 }) },
  };
  const ok = basicRoutes();
  ok["/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.5", pid: 101 }) : response({}, 401);
  ok["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_ok", 999_000, { outcome: "succeeded", idle: 999_000 })],
    cursor: {},
  });
  const routes = Object.fromEntries(Object.entries(ok).map(([path, value]) => [`127.0.0.1:4101${path}`, value]));
  const setup = fixture({ files, routes });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.equal(snapshot.connections.length, 2);
  assert.equal(snapshot.connections.filter((connection) => connection.health === "ready").length, 1);
  assert.equal(snapshot.connections.filter((connection) => connection.health === "unavailable").length, 1);
  assert.deepEqual(
    snapshot.connections.flatMap((connection) => connection.tasks).map((task) => task.sessionId),
    ["ses_ok"],
  );
});

test("marks a bounded root page incomplete when OpenCode reports more history", async () => {
  const routes = basicRoutes();
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_page", 999_000, { outcome: "succeeded", idle: 999_000 })],
    cursor: { next: "opaque-page" },
  });
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes,
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.equal(snapshot.connections[0]!.complete, false);
  assert.equal(snapshot.connections[0]!.health, "capacity-exceeded");
  assert.deepEqual(
    snapshot.connections[0]!.tasks.map((task) => task.sessionId),
    ["ses_page"],
  );
});

test("keeps a content-free task alias stable across a missed refresh", async () => {
  let visible = true;
  const now = 1_000_000;
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: {
      ...basicRoutes(now),
      "/api/session?parentID=null&order=desc&limit=100": () =>
        response({
          data: visible ? [session("ses_alias", now - 1_000, { outcome: "succeeded", idle: now - 1_000 })] : [],
          cursor: {},
        }),
    },
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await startAndRefresh(collector);
  visible = false;
  await collector.refresh();
  visible = true;
  const restored = await collector.refresh();
  await collector.stop();

  assert.equal(restored.connections[0]!.tasks[0]!.label, first.connections[0]!.tasks[0]!.label);
});

test("discovers a CLI-managed SSH service through bounded pair output", async () => {
  const remoteUrl = "http://127.0.0.1:4096";
  const remotePassword = "private-pair-password";
  let discoveryInput = "";
  const discovery: OpenCodeProcess = {
    pid: 7101,
    stdout: [
      `OPENCODE_SERVICE_STATUS=${remoteUrl}`,
      "OPENCODE_PAIR_BEGIN",
      `\u001b[36m  Password  ${remotePassword}\u001b[0m`,
      "OPENCODE_PAIR_END",
      "OPENCODE_PAIR_STATUS_BEGIN",
      JSON.stringify({ version: "2.0.6", pid: 88 }),
      "OPENCODE_PAIR_STATUS_END",
      "",
    ].join("\n"),
    stderr: "",
    exited: Promise.resolve(0),
    write(data) {
      discoveryInput += String(data);
    },
    end() {},
    kill() {},
  };
  const tunnel: OpenCodeProcess = {
    pid: 7102,
    stdout: "",
    stderr: "",
    exited: new Promise(() => undefined),
    write() {},
    end() {},
    kill() {},
  };
  const routes = basicRoutes();
  routes["/api/status"] = ({ authorization }) => (authorization ? response({}, 404) : response({}, 401));
  routes["/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.6", pid: 88 }) : response({}, 401);
  const setup = fixture({
    files: { [SETTINGS]: { body: { "ssh.servers": [{ id: "fedora", target: "test-host", name: "Fedora" }] } } },
    routes,
    processes: [discovery, tunnel],
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "ready");
  assert.equal(JSON.stringify(snapshot).includes(remotePassword), false);
  assert.equal(JSON.stringify(setup.spawnCalls).includes(remotePassword), false);
  assert.match(discoveryInput, /"\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}"/u);
  assert.doesNotMatch(discoveryInput, /\\\$\{/u);
  assert.match(discoveryInput, /\/api\/info/u);
});

test("stop tears down every SSH process group", async () => {
  let tunnelKilled = false;
  const discovery: OpenCodeProcess = {
    pid: 7001,
    stdout: `OPENCODE_SERVICE_STATUS=http://0.0.0.0:4096\nOPENCODE_REGISTRATION_BEGIN\n${JSON.stringify(localRegistration({ url: "http://0.0.0.0:4096", pid: 77 }))}\nOPENCODE_REGISTRATION_END\n`,
    stderr: "",
    exited: Promise.resolve(0),
    write() {},
    end() {},
    kill() {},
  };
  const tunnel: OpenCodeProcess = {
    pid: 7002,
    stdout: "",
    stderr: "",
    exited: new Promise(() => undefined),
    write() {},
    end() {},
    kill() {
      tunnelKilled = true;
    },
  };
  const settings = { "ssh.servers": [{ id: "desktop-id", target: "test-host", name: "Private name" }] };
  const routes = basicRoutes();
  const setup = fixture({
    files: { [SETTINGS]: { body: settings } },
    routes: {
      ...routes,
      "/api/info": ({ authorization }) => (authorization ? response({ version: "2.0.5", pid: 77 }) : response({}, 401)),
    },
    processes: [discovery, tunnel],
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await startAndRefresh(collector);
  await collector.stop();

  assert.equal(tunnelKilled, true);
  assert.deepEqual(setup.terminated, [7002]);
  assert.equal(setup.spawnCalls.length, 2);
  assert.deepEqual(
    setup.spawnCalls.map((call) => call.command),
    ["/usr/bin/ssh", "/usr/bin/ssh"],
  );
  assert.ok(setup.spawnCalls[0]!.args.includes("BatchMode=yes"));
  assert.ok(setup.spawnCalls[1]!.args.includes("ExitOnForwardFailure=yes"));
  assert.equal(setup.spawnCalls[1]!.args.includes("ClearAllForwardings=yes"), false);
  assert.ok(setup.spawnCalls[1]!.args.some((argument) => argument.startsWith("127.0.0.1:43123:")));
  assert.equal(JSON.stringify(setup.spawnCalls).includes("fixture-password"), false);
  assert.equal(
    Object.keys(setup.spawnCalls[0]!.env).some((key) => /password|token|secret/iu.test(key)),
    false,
  );
  assert.equal(JSON.stringify(snapshot).includes("test-host"), false);
  assert.equal(JSON.stringify(snapshot).includes("Private name"), false);
});

function sshProcesses(discoveryPid: number, tunnelPid: number, servicePid = 77): OpenCodeProcess[] {
  return [
    {
      pid: discoveryPid,
      stdout: `OPENCODE_SERVICE_STATUS=http://0.0.0.0:4096\nOPENCODE_REGISTRATION_BEGIN\n${JSON.stringify(localRegistration({ url: "http://0.0.0.0:4096", pid: servicePid }))}\nOPENCODE_REGISTRATION_END\n`,
      stderr: "",
      exited: Promise.resolve(0),
      write() {},
      end() {},
      kill() {},
    },
    { pid: tunnelPid, stdout: "", stderr: "", exited: new Promise(() => undefined), write() {}, end() {}, kill() {} },
  ];
}

test("SSH identity replacement evicts its tunnel and rediscovers without interrupting the local source", async () => {
  let pid = 77;
  const routes = basicRoutes();
  routes["127.0.0.1:43123/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.5", pid }) : response({}, 401);
  const setup = fixture({
    files: {
      [SETTINGS]: { body: { "ssh.servers": [{ id: "saved", target: "fixture-host", name: "Fixture" }] } },
      [`${STATE}/service.json`]: { body: localRegistration() },
    },
    routes,
    processes: [...sshProcesses(8001, 8002), ...sshProcesses(8003, 8004, 78)],
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    assert.ok((await startAndRefresh(collector)).connections.every((item) => item.health === "ready"));
    pid = 78;
    const incompatible = await collector.refresh();
    assert.deepEqual(incompatible.connections.map((item) => item.health).sort(), ["incompatible", "ready"]);
    assert.deepEqual(setup.terminated, [8002]);
    const recovered = await collector.refresh();
    assert.ok(recovered.connections.every((item) => item.health === "ready"));
    assert.equal(setup.spawnCalls.length, 4);
  } finally {
    await collector.stop();
  }
});

test("authoritative SSH settings replace changed targets and remove only their own tunnels", async () => {
  const files: Record<string, FileEntry> = {
    [SETTINGS]: {
      body: {
        "ssh.servers": [
          { id: "saved", target: "fixture-one", name: "Fixture" },
          { id: "retained", target: "fixture-retained", name: "Retained" },
        ],
      },
    },
  };
  const routes = basicRoutes();
  routes["/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.5", pid: 77 }) : response({}, 401);
  const setup = fixture({
    files,
    routes,
    processes: [
      sshProcesses(8101, 8102)[0]!,
      sshProcesses(8111, 8112)[0]!,
      sshProcesses(8101, 8102)[1]!,
      sshProcesses(8111, 8112)[1]!,
      ...sshProcesses(8103, 8104),
    ],
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    await startAndRefresh(collector);
    files[SETTINGS]!.safe = false;
    await collector.refresh();
    assert.deepEqual(setup.terminated, [], "unreadable settings cannot prove removal");
    files[SETTINGS] = {
      body: {
        "ssh.servers": [
          { id: "saved", target: "fixture-two", name: "Fixture" },
          { id: "retained", target: "fixture-retained", name: "Retained" },
        ],
      },
    };
    await collector.refresh();
    assert.deepEqual(setup.terminated, [8102]);
    assert.ok(setup.spawnCalls[4]!.args.includes("fixture-two"));
    files[SETTINGS] = { body: { "ssh.servers": [{ id: "retained", target: "fixture-retained", name: "Retained" }] } };
    const retained = await collector.refresh();
    assert.equal(retained.connections.length, 1);
    assert.equal(retained.connections[0]!.health, "ready");
    assert.equal(setup.spawnCalls.length, 6);
    assert.deepEqual(setup.terminated, [8102, 8104]);
  } finally {
    await collector.stop();
  }
});

test("stop discards a late authenticated snapshot and clears the readiness polling interval", async () => {
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const routes = basicRoutes();
  routes["/api/session/active"] = async () => {
    arrived();
    await delayed;
    return response({ data: { ses_late: { type: "running" } } });
  };
  routes["/api/session/ses_late"] = response({ data: session("ses_late", 999_900) });
  const setup = fixture({ files: { [`${STATE}/service.json`]: { body: localRegistration() } }, routes });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  const started = collector.start();
  await arrival;
  const stopped = collector.stop();
  finish();
  await Promise.all([started, stopped]);
  assert.deepEqual(collector.snapshot(), { version: 1, observedAt: 0, connections: [] });
  assert.deepEqual(setup.intervals, [5_000]);
});

test("reaps orphaned tunnels once, using the exact command line the collector spawns", async () => {
  const settings = { "ssh.servers": [{ id: "desktop-id", target: "test-host", name: "Private name" }] };
  const routes = basicRoutes();
  const setup = fixture({
    files: { [SETTINGS]: { body: settings } },
    routes: {
      ...routes,
      "/api/info": ({ authorization }) => (authorization ? response({ version: "2.0.5", pid: 77 }) : response({}, 401)),
    },
    processes: sshProcesses(7101, 7102),
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  await startAndRefresh(collector);
  await collector.refresh();
  await collector.stop();

  assert.equal(setup.reaped.length, 1);
  assert.equal(setup.reaped[0]!.length, 1);
  const tunnelCall = setup.spawnCalls[1]!;
  const forward = tunnelCall.args.find((argument) => argument.startsWith("127.0.0.1:43123:"))!;
  assert.equal(
    setup.reaped[0]![0]!.replace(TUNNEL_FORWARD_PLACEHOLDER, forward),
    [tunnelCall.command, ...tunnelCall.args].join(" "),
  );
});

test("orphan detection accepts only reparented loopback tunnels of the current user", () => {
  const template = ["/usr/bin/ssh", ...sshTunnelArgs(sshCommonArgs([]), TUNNEL_FORWARD_PLACEHOLDER, "x9-fedora")].join(
    " ",
  );
  const command = (forward: string, host = "x9-fedora") =>
    ["/usr/bin/ssh", ...sshTunnelArgs(sshCommonArgs([]), forward, host)].join(" ");
  const ps = [
    `  101     1   501 ${command("127.0.0.1:50281:127.0.0.1:4096")}`,
    `  102     1   501 ${command("127.0.0.1:50282:[::1]:4096")}`,
    `  103  2821   501 ${command("127.0.0.1:50283:127.0.0.1:4096")}`,
    `  104     1   502 ${command("127.0.0.1:50284:127.0.0.1:4096")}`,
    `  105     1   501 ${command("127.0.0.1:50285:10.0.0.5:4096")}`,
    `  106     1   501 ${command("127.0.0.1:50286:127.0.0.1:4096", "other-host")}`,
    "  107     1   501 /usr/bin/ssh -L 127.0.0.1:50287:127.0.0.1:4096 -N x9-fedora",
    `  108     1   501 ${command("0.0.0.0:50288:127.0.0.1:4096")}`,
    "garbage line",
  ].join("\n");

  assert.deepEqual(findOrphanedTunnels(ps, [template], 501), [101, 102]);
  assert.deepEqual(findOrphanedTunnels(ps, [], 501), []);
});

test("orphan detection matches user arguments with spaces and non-ASCII text, never control characters", () => {
  const userArgs = ["-o", "ProxyCommand=ssh -W %h:%p jump", "-i", "/Users/тест/key file"];
  const build = (forward: string, args: string[]) =>
    ["/usr/bin/ssh", ...sshTunnelArgs(sshCommonArgs(args), forward, "x9-fedora")].join(" ");
  const tabbed = ["-i", "/Users/me/key\tfile"];
  const ps = [
    `  201     1   501 ${build("127.0.0.1:50301:127.0.0.1:4096", userArgs)}`,
    `  202     1   501 ${build("127.0.0.1:50302:127.0.0.1:4096", [])}`,
    `  203     1   501 ${build("127.0.0.1:50303:127.0.0.1:4096", tabbed)}`,
  ].join("\n");

  assert.deepEqual(findOrphanedTunnels(ps, [build(TUNNEL_FORWARD_PLACEHOLDER, userArgs)], 501), [201]);
  assert.deepEqual(findOrphanedTunnels(ps, [build(TUNNEL_FORWARD_PLACEHOLDER, tabbed)], 501), []);
});

test("orphan reaping is retried after a failed process listing and skipped without saved targets", async () => {
  const settings = { "ssh.servers": [{ id: "desktop-id", target: "test-host", name: "Private name" }] };
  const routes = basicRoutes();
  const setup = fixture({
    files: { [SETTINGS]: { body: settings } },
    routes: {
      ...routes,
      "/api/info": ({ authorization }) => (authorization ? response({ version: "2.0.5", pid: 77 }) : response({}, 401)),
    },
    processes: sshProcesses(7201, 7202),
  });
  let calls = 0;
  setup.dependencies.reapOrphanedTunnels = async () => {
    calls++;
    if (calls === 1) throw new Error("ps-timeout");
  };
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  await startAndRefresh(collector);
  await collector.refresh();
  await collector.refresh();
  await collector.stop();
  assert.equal(calls, 2);

  const empty = fixture({ files: { [SETTINGS]: { body: { "ssh.servers": [] } } }, routes: basicRoutes() });
  const idle = new OpenCodeCollector({ identitySecret: SECRET, dependencies: empty.dependencies });
  await startAndRefresh(idle);
  await idle.stop();
  assert.deepEqual(empty.reaped, []);
});

test("publishes three local cycles while SSH discovery remains held", async () => {
  let release!: () => void;
  const held = new Promise<number>((resolve) => {
    release = () => resolve(0);
  });
  let spawned!: () => void;
  const arrival = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  const processes = sshProcesses(9001, 9002);
  processes[0]!.exited = held;
  const routes = basicRoutes();
  let title = "Local 1";
  routes["/api/session/active"] = response({ data: { ses_local: { type: "running" } } });
  routes["/api/session?parentID=null&order=desc&limit=100"] = () =>
    response({ data: [session("ses_local", 999_900, { title })], cursor: {} });
  routes["127.0.0.1:43123/api/info"] = ({ authorization }) =>
    authorization ? response({ version: "2.0.5", pid: 77 }) : response({}, 401);
  const setup = fixture({
    files: {
      [`${STATE}/service.json`]: { body: localRegistration() },
      [SETTINGS]: { body: { "ssh.servers": [{ id: "saved", target: "fixture-host", name: "Fixture" }] } },
    },
    routes,
    processes,
  });
  const spawn = setup.dependencies.spawn;
  setup.dependencies.spawn = async (...args) => {
    const child = await spawn(...args);
    spawned();
    return child;
  };
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  const started = collector.start();
  try {
    await arrival;
    await yieldIO();
    assert.equal(collector.snapshot().connections.flatMap((item) => item.tasks)[0]?.displayTitle, "Local 1");
    for (const next of ["Local 2", "Local 3"]) {
      title = next;
      void collector.refresh();
      await yieldIO();
      assert.equal(
        collector
          .snapshot()
          .connections.flatMap((item) => item.tasks)
          .find((task) => task.sessionId === "ses_local")?.displayTitle,
        next,
      );
    }
  } finally {
    release();
    await started;
    await collector.stop();
  }
});

test("own polling publishes local changes through three bounded remote stages", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  const discovery = gate();
  const identity = gate();
  const collection = gate();
  const processes = sshProcesses(9101, 9102);
  processes[0]!.exited = discovery.promise.then(() => 0);
  let title = "Cycle 1";
  let now = 1_000_000;
  const stages: string[] = [];
  const routes = basicRoutes();
  routes["/api/session/active"] = response({ data: { ses_local: { type: "running" } } });
  routes["/api/session?parentID=null&order=desc&limit=100"] = () =>
    response({ data: [session("ses_local", 999_900, { title })], cursor: {} });
  routes["127.0.0.1:43123/api/info"] = async ({ authorization }) => {
    if (!authorization) return response({}, 401);
    stages.push("identity");
    await identity.promise;
    return response({ version: "2.0.5", pid: 77 });
  };
  routes["127.0.0.1:43123/api/session/active"] = async () => {
    stages.push("collection");
    await collection.promise;
    return response({ data: {} });
  };
  const setup = fixture({
    now: () => now,
    routes,
    processes,
    files: {
      [`${STATE}/service.json`]: { body: localRegistration() },
      [SETTINGS]: { body: { "ssh.servers": [{ id: "saved", target: "fixture-host", name: "Fixture" }] } },
    },
  });
  setup.dependencies.setInterval = setInterval;
  setup.dependencies.clearInterval = clearInterval;
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  const published: string[] = [];
  const unsubscribe = collector.subscribe(() => {
    const task = collector
      .snapshot()
      .connections.flatMap((item) => item.tasks)
      .find((task) => task.sessionId === "ses_local");
    if (task?.displayTitle) published.push(task.displayTitle);
  });
  try {
    assert.deepEqual(await collector.start(), { version: 1, observedAt: 0, connections: [] });
    await yieldIO();
    assert.equal(published.at(-1), "Cycle 1");
    now += 4_500;
    context.mock.timers.tick(4_500);
    discovery.release();
    await yieldIO();
    assert.deepEqual(stages, ["identity"]);
    title = "Cycle 2";
    now += 500;
    context.mock.timers.tick(500);
    await yieldIO();
    assert.equal(published.at(-1), "Cycle 2");
    now += 4_000;
    context.mock.timers.tick(4_000);
    identity.release();
    await yieldIO();
    assert.deepEqual(stages, ["identity", "identity", "collection"]);
    title = "Cycle 3";
    now += 1_000;
    context.mock.timers.tick(1_000);
    await yieldIO();
    assert.equal(published.at(-1), "Cycle 3");
    now += 3_500;
    context.mock.timers.tick(3_500);
    collection.release();
    await yieldIO();
    assert.ok(collector.snapshot().connections.every((item) => item.health === "ready"));
  } finally {
    discovery.release();
    identity.release();
    collection.release();
    unsubscribe();
    await collector.stop();
  }
});

test("acknowledgement made during a collection remains authoritative at commit", async () => {
  const routes = basicRoutes();
  let revision = 999_900;
  let release!: () => void;
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delay = false;
  routes["/api/session?parentID=null&order=desc&limit=100"] = async () => {
    const result = response({
      data: [session("ses_ack", revision, { outcome: "succeeded", idle: revision })],
      cursor: {},
    });
    if (delay) {
      arrived();
      await held;
    }
    return result;
  };
  const setup = fixture({ routes, files: { [`${STATE}/service.json`]: { body: localRegistration() } } });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    const first = await startAndRefresh(collector);
    const task = first.connections[0]!.tasks[0]!;
    delay = true;
    const pending = collector.refresh();
    await arrival;
    assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
    release();
    assert.deepEqual((await pending).connections[0]!.tasks, []);
    revision = 999_950;
    delay = false;
    assert.equal((await collector.refresh()).connections[0]!.tasks[0]?.terminalAt, 999_950);
  } finally {
    release();
    await collector.stop();
  }
});

test("replacement registration commits before the old request returns and rejects that old result", async () => {
  const routes = basicRoutes();
  let release!: () => void;
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const files = { [`${STATE}/service.json`]: { body: localRegistration() } };
  routes["127.0.0.1:4096/api/session/active"] = async () => {
    arrived();
    await held;
    return response({ data: { ses_old: { type: "running" } } });
  };
  routes["/api/session/active"] = response({ data: { ses_new: { type: "running" } } });
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_new", 999_900), session("ses_old", 999_900)],
    cursor: {},
  });
  const setup = fixture({ routes, files });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    await collector.start();
    await arrival;
    files[`${STATE}/service.json`]!.body = localRegistration({ url: "http://127.0.0.1:4097", password: "replacement" });
    const replaced = await collector.refresh();
    assert.deepEqual(
      replaced.connections[0]!.tasks.map((task) => task.sessionId),
      ["ses_new"],
    );
    release();
    await yieldIO();
    assert.deepEqual(
      collector.snapshot().connections[0]!.tasks.map((task) => task.sessionId),
      ["ses_new"],
    );
  } finally {
    release();
    await collector.stop();
  }
});

function remoteFixture(files: Record<string, FileEntry>, routes: Record<string, RouteEntry>) {
  const setup = fixture({ files, routes });
  let port = 4_400;
  let pid = 10_000;
  setup.dependencies.reserveLoopbackPort = async () => port++;
  setup.dependencies.spawn = async (_command, args) => {
    const processes = sshProcesses(pid++, pid++);
    if (args.includes("unreachable") && !args.includes("-N")) processes[0]!.exited = Promise.resolve(1);
    return processes[args.includes("-N") ? 1 : 0]!;
  };
  routes["/api/info"] = ({ authorization, url }) =>
    authorization
      ? response({ version: "2.0.5", pid: Number(new URL(url).port) >= 4_400 ? 77 : 42 })
      : response({}, 401);
  return setup;
}

test("admits seventeen sorted locals and retains SSH diagnostics beyond the connection slice", async () => {
  const files: Record<string, FileEntry> = {};
  for (let index = 0; index < 18; index++) {
    files[`${STATE}/service.${String(index).padStart(2, "0")}.json`] = {
      body: localRegistration({ id: `local-${index}`, url: `http://127.0.0.1:${4_096 + index}` }),
    };
  }
  files[SETTINGS] = {
    body: {
      "ssh.servers": [
        { id: "saved", target: "fixture-host", name: "Fixture" },
        { id: "failed", target: "unreachable", name: "Unavailable" },
      ],
    },
  };
  const routes = basicRoutes();
  const setup = remoteFixture(files, routes);
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    const snapshot = await startAndRefresh(collector);
    assert.equal(snapshot.connections.filter((item) => item.health === "ready").length, 17);
    assert.equal(snapshot.connections.filter((item) => item.health === "unavailable").length, 1);
    assert.equal(snapshot.connections.length, 18);
    assert.deepEqual(
      setup.requests
        .filter((request) => new URL(request.url).pathname === "/api/session/active")
        .map((request) => Number(new URL(request.url).port))
        .sort((a, b) => a - b),
      [4096, 4097, 4098, 4099, 4100, 4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108, 4109, 4110, 4111, 4112],
    );
  } finally {
    await collector.stop();
  }
});

test("three borrowed remote slots yield one local reserve while the other slots retain FIFO", async () => {
  const files: Record<string, FileEntry> = {
    [SETTINGS]: {
      body: {
        "ssh.servers": [0, 1, 2, 3].map((index) => ({
          id: `remote-${index}`,
          target: `fixture-${index}`,
          name: "Fixture",
        })),
      },
    },
  };
  const routes = basicRoutes();
  const events: number[] = [];
  const releases = new Map<number, () => void>();
  let active = 0;
  let maximum = 0;
  let free = false;
  routes["/api/session/active"] = async ({ url }) => {
    const port = Number(new URL(url).port);
    events.push(port);
    active++;
    maximum = Math.max(maximum, active);
    if (!free)
      await new Promise<void>((resolve) => {
        releases.set(port, resolve);
      });
    active--;
    return response({ data: {} });
  };
  const setup = remoteFixture(files, routes);
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  const release = async (port: number) => {
    releases.get(port)!();
    releases.delete(port);
    await yieldIO();
  };
  try {
    await collector.start();
    await yieldIO();
    assert.deepEqual(events, [4400, 4401, 4402], "all three slots are available to remote work without local demand");
    for (let index = 0; index < 13; index++)
      files[`${STATE}/service.${index}.json`] = {
        body: localRegistration({ id: `local-${index}`, url: `http://127.0.0.1:${4096 + index}` }),
      };
    const pending = collector.refresh();
    void collector.refresh();
    void collector.refresh();
    await yieldIO();
    assert.deepEqual(events, [4400, 4401, 4402], "local demand does not preempt the three running remote collections");
    await release(4400);
    assert.equal(events[3], 4096, "the first free slot supplies the conditional local reserve");
    await release(4401);
    assert.equal(events[4], 4403, "the second free slot takes the remote work already waiting in FIFO");
    await release(4096);
    assert.equal(events[5], 4097, "multiple local waiters progress through the single reserve");
    assert.equal(maximum, 3);
    assert.equal(setup.terminated.length, 0, "admission never kills borrowed remote work");
    free = true;
    for (const finish of releases.values()) finish();
    releases.clear();
    await pending;
    assert.equal(collector.snapshot().connections.length, 17);
    assert.equal(new Set(events).size, 17);
    assert.equal(events.length, 17, "repeated pending refreshes do not accumulate duplicate collection work");
    assert.equal(maximum, 3);
  } finally {
    free = true;
    for (const finish of releases.values()) finish();
    await collector.stop();
  }
});

test("late SSH children and the old stop cannot affect a restarted generation", async () => {
  const routes = basicRoutes();
  const files: Record<string, FileEntry> = {
    [`${STATE}/service.json`]: { body: localRegistration() },
    [SETTINGS]: {
      body: {
        "ssh.servers": [0, 1].map((index) => ({ id: `saved-${index}`, target: `old-${index}`, name: "Fixture" })),
      },
    },
  };
  const setup = remoteFixture(files, routes);
  const spawn = setup.dependencies.spawn;
  const late: Array<{ release(): void; child: OpenCodeProcess }> = [];
  setup.dependencies.spawn = async (...args) => {
    const child = await spawn(...args);
    if (args[1].some((argument) => /^old-/u.test(argument))) {
      await new Promise<void>((resolve) => {
        late.push({ release: resolve, child });
      });
    }
    return child;
  };
  const timers = new Set<NodeJS.Timeout>();
  setup.dependencies.setInterval = () => {
    const timer = {} as NodeJS.Timeout;
    timers.add(timer);
    return timer;
  };
  setup.dependencies.clearInterval = (timer) => {
    timers.delete(timer);
  };
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    await collector.start();
    await yieldIO();
    assert.equal(late.length, 2, "the global SSH discovery limit is two");
    const stopped = collector.stop();
    files[SETTINGS] = { body: { "ssh.servers": [{ id: "saved-0", target: "new-target", name: "Fixture" }] } };
    await collector.start();
    const current = collector.refresh();
    await yieldIO();
    assert.equal(late.length, 2, "old executing discoveries retain their capacity until they finish");
    assert.equal(
      collector.snapshot().connections[0]?.health,
      "ready",
      "local collection progresses in the new generation",
    );
    for (const item of late) item.release();
    await Promise.all([stopped, current]);
    assert.equal(timers.size, 1, "the old stop does not clear the new generation's timer");
    assert.ok(
      late.every((item) => setup.terminated.includes(item.child.pid)),
      "late old children are reaped",
    );
    assert.equal(collector.snapshot().connections.length, 2);
    assert.ok(collector.snapshot().connections.every((item) => item.health === "ready"));
  } finally {
    for (const item of late) item.release();
    await collector.stop();
    assert.equal(timers.size, 0);
  }
});

test("sixteen local waiters share one reserve and cannot requeue ahead of a waiting remote", async () => {
  const files: Record<string, FileEntry> = {
    [SETTINGS]: { body: { "ssh.servers": [{ id: "saved", target: "fixture-host", name: "Fixture" }] } },
  };
  for (let index = 0; index < 16; index++)
    files[`${STATE}/service.${String(index).padStart(2, "0")}.json`] = {
      body: localRegistration({ id: `local-${index}`, url: `http://127.0.0.1:${4096 + index}` }),
    };
  const routes = basicRoutes();
  const events: number[] = [];
  const releases = new Map<number, () => void>();
  let free = false;
  routes["/api/session/active"] = async ({ url }) => {
    const port = Number(new URL(url).port);
    events.push(port);
    if (!free)
      await new Promise<void>((resolve) => {
        releases.set(port, resolve);
      });
    return response({ data: {} });
  };
  const setup = remoteFixture(files, routes);
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    await collector.start();
    await yieldIO();
    assert.deepEqual(events, [4096, 4097, 4098]);
    releases.get(4097)!();
    releases.delete(4097);
    await yieldIO();
    assert.equal(events.at(-1), 4099);
    // The completed local joins behind the remote, while its neighbours still wait.
    const requeued = collector.refresh();
    await yieldIO();
    for (let index = 3; index < 16; index++) {
      const port = 4096 + index;
      releases.get(port)!();
      releases.delete(port);
      await yieldIO();
    }
    assert.equal(events.at(-1), 4400, "FIFO reaches the remote before the completed local re-enters");
    assert.equal(events.filter((port) => port === 4097).length, 1);
    free = true;
    for (const finish of releases.values()) finish();
    releases.clear();
    await requeued;
    assert.equal(events.filter((port) => port === 4097).length, 2);
    assert.equal(collector.snapshot().connections.length, 17);
  } finally {
    free = true;
    for (const finish of releases.values()) finish();
    await collector.stop();
  }
});

test("a pending environment retains its timestamp and a successful empty result clears only itself", async () => {
  const routes = basicRoutes();
  routes["/api/session/active"] = response({ data: { ses_work: { type: "running" } } });
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_work", 999_900)],
    cursor: {},
  });
  let now = 1_000_000;
  const setup = fixture({
    now: () => now,
    routes,
    files: {
      [`${STATE}/service.one.json`]: { body: localRegistration({ id: "one" }) },
      [`${STATE}/service.two.json`]: { body: localRegistration({ id: "two", url: "http://127.0.0.1:4097" }) },
    },
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await startAndRefresh(collector);
    const previous = collector.snapshot().connections;
    const updates: Array<[number, number[]]> = [];
    const unsubscribe = collector.subscribe(() => {
      const snapshot = collector.snapshot();
      updates.push([
        snapshot.connections.flatMap((item) => item.tasks).length,
        snapshot.connections.map((item) => item.observedAt).sort(),
      ]);
    });
    routes["127.0.0.1:4097/api/session/active"] = async () => {
      await held;
      return response({ data: {} });
    };
    routes["127.0.0.1:4097/api/session?parentID=null&order=desc&limit=100"] = response({ data: [], cursor: {} });
    now = 1_005_000;
    const pending = collector.refresh();
    await yieldIO();
    assert.equal(collector.snapshot().connections.flatMap((item) => item.tasks).length, 2);
    assert.deepEqual(
      collector
        .snapshot()
        .connections.map((item) => item.observedAt)
        .sort(),
      [1_000_000, 1_005_000],
    );
    assert.ok(
      previous.every((item) => item.observedAt === 1_000_000),
      "previous whole snapshots remain immutable",
    );
    release();
    const finished = await pending;
    assert.equal(finished.connections.flatMap((item) => item.tasks).length, 1);
    assert.ok(finished.connections.every((item) => item.health === "ready"));
    assert.deepEqual(updates, [
      [2, [1_000_000, 1_005_000]],
      [1, [1_005_000, 1_005_000]],
    ]);
    unsubscribe();
    await collector.refresh();
    assert.equal(updates.length, 2, "unsubscribe stops further committed-snapshot notifications");
  } finally {
    release();
    await collector.stop();
  }
});

test("stop waits for owned tunnel termination after child registry cleanup", async () => {
  const routes = basicRoutes();
  const setup = remoteFixture(
    { [SETTINGS]: { body: { "ssh.servers": [{ id: "saved", target: "fixture-host", name: "Fixture" }] } } },
    routes,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let terminating!: () => void;
  const arrival = new Promise<void>((resolve) => {
    terminating = resolve;
  });
  setup.dependencies.terminateProcessGroup = async () => {
    terminating();
    await held;
  };
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    await startAndRefresh(collector);
    let stopped = false;
    const pending = collector.stop().then(() => {
      stopped = true;
    });
    await arrival;
    await yieldIO();
    assert.equal(
      stopped,
      false,
      "stop owns the in-progress teardown even after the child is detached from its registry",
    );
    release();
    await pending;
    assert.equal(stopped, true);
  } finally {
    release();
    await collector.stop();
  }
});
