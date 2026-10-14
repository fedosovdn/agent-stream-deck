import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createMicroSnapshot, host as macHost } from "./support/micro-snapshot.js";

if (!process.env.DECK_SOURCE_TEST_HOME) {
  test("Codex lifecycle scenarios isolate state before the first source import", async () => {
    const home = await fsPromises.mkdtemp(join(tmpdir(), "deck-source-process-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "--test", "--test-reporter=tap", fileURLToPath(import.meta.url)],
        {
          env: {
            ...process.env,
            NODE_TEST_CONTEXT: undefined,
            HOME: home,
            USERPROFILE: home,
            LOCALAPPDATA: home,
            XDG_STATE_HOME: home,
            CODEX_HOME: join(home, "codex"),
            DECK_SOURCE_TEST_HOME: home,
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /# fail 0/);
      const stateRoot =
        process.platform === "darwin"
          ? join(home, "Library", "Application Support", "CodexDeck")
          : join(home, "CodexDeck");
      const identity = JSON.parse(await fsPromises.readFile(join(stateRoot, "host.json"), "utf8"));
      assert.equal(identity.hostId, "56fd97ad-7073-42cc-85ce-befa17546d7c");
      assert.equal(identity.platform, process.platform);
      assert.deepEqual(
        await fsPromises.readdir(stateRoot),
        ["host.json"],
        "atomic host writes leave only temporary state",
      );
    } finally {
      await fsPromises.rm(home, { recursive: true, force: true });
    }
  });
} else {
  const { CodexMicroRendererBridge, CodexSource } = await import("#codex");
  const host = { ...macHost, platform: process.platform as "darwin" | "win32" };

  function gate<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function drain() {
    for (let turn = 0; turn < 15; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function isolate(context: TestContext) {
    const home = await fsPromises.mkdtemp(join(process.env.DECK_SOURCE_TEST_HOME!, "lifecycle-"));
    const previous = process.env.HOME;
    const previousCodex = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
    context.after(async () => {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      if (previousCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodex;
      await fsPromises.rm(home, { recursive: true, force: true });
    });
    context.after(syncBuiltinESMExports);
  }

  test("Codex source persists a platform correction only in subprocess temporary state", async (context) => {
    const stateRoot =
      process.platform === "darwin"
        ? join(process.env.HOME!, "Library", "Application Support", "CodexDeck")
        : join(process.env.LOCALAPPDATA!, "CodexDeck");
    await fsPromises.mkdir(stateRoot, { recursive: true });
    await fsPromises.writeFile(
      join(stateRoot, "host.json"),
      JSON.stringify({
        ...host,
        platform: process.platform === "darwin" ? "win32" : "darwin",
      }),
    );
    const source = new CodexSource(() => {});
    context.after(() => source.stop());
    await source.start();
    assert.equal(source.localHost?.hostId, "56fd97ad-7073-42cc-85ce-befa17546d7c");
    assert.equal(source.localHost?.platform, process.platform);
    const persisted = JSON.parse(await fsPromises.readFile(join(stateRoot, "host.json"), "utf8"));
    assert.deepEqual(persisted, source.localHost);
  });

  function identities(context: TestContext, readHost: () => Promise<string>) {
    context.mock.method(fsPromises, "readFile", (async (path: unknown) => {
      if (String(path).endsWith("host.json")) return readHost();
      throw Object.assign(new Error("isolated fixture file absent"), { code: "ENOENT" });
    }) as unknown as typeof fsPromises.readFile);
    syncBuiltinESMExports();
  }

  for (const outcome of ["snapshot", "error"] as const) {
    test(`Codex source ignores a late ${outcome} from its stopped generation`, async (context) => {
      await isolate(context);
      identities(context, async () => JSON.stringify(host));
      const source = new CodexSource(() => {});
      context.after(() => source.stop());
      const old = gate<ReturnType<typeof createMicroSnapshot>>();
      context.after(() => old.resolve(createMicroSnapshot()));
      context.mock.method(source.microBridge, "refresh", async () => old.promise);
      await source.start();
      const refreshing = source.refresh();
      source.stop();
      await source.start();
      const current = createMicroSnapshot();
      current.slots[0]!.title = "Current generation";
      context.mock.method(source.microBridge, "refresh", async () => current);
      await source.refresh();
      if (outcome === "snapshot") old.resolve(createMicroSnapshot());
      else {
        // The old public transport response fails after the new owner has committed.
        old.resolve(Promise.reject(new Error("old response")) as never);
      }
      await refreshing;
      assert.equal(source.localSnapshot?.snapshot.slots[0]?.title, "Current generation");
      assert.equal(source.localHealth.state, "ready");
    });
  }

  test("Codex source ignores host identity returned by a retired start", async (context) => {
    await isolate(context);
    const old = gate<string>();
    context.after(() => old.resolve(JSON.stringify(host)));
    let reads = 0;
    const fresh = { ...host, hostId: "11111111-1111-4111-8111-111111111111" };
    identities(context, async () => (++reads === 1 ? old.promise : JSON.stringify(fresh)));
    const source = new CodexSource(() => {});
    context.after(() => source.stop());
    const starting = source.start();
    source.stop();
    await source.start();
    old.resolve(JSON.stringify(host));
    await starting;
    assert.equal(source.localHost?.hostId, "11111111-1111-4111-8111-111111111111");
  });

  test("closed Codex discovery cannot adopt its old socket or disconnect a fresh connection", async (context) => {
    await isolate(context);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const old = gate<void>();
    let lists = 0;
    let connections = 0;
    server.on("connection", (socket) => {
      connections++;
      socket.on("message", (raw) => {
        const { id } = JSON.parse(String(raw)) as { id: number };
        socket.send(JSON.stringify({ id, result: { result: { value: createMicroSnapshot() } } }));
      });
    });
    let currentWork: Promise<unknown> | undefined;
    let firstWork: Promise<unknown> | undefined;
    context.after(async () => {
      old.resolve();
      await Promise.allSettled([firstWork, currentWork]);
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    context.mock.method(fsPromises, "readFile", (async () =>
      JSON.stringify({ port })) as unknown as typeof fsPromises.readFile);
    syncBuiltinESMExports();
    context.mock.method(globalThis, "fetch", async (input: unknown) => {
      if (String(input).endsWith("/json/list")) {
        if (++lists === 1) await old.promise;
        return new Response(
          JSON.stringify([
            { type: "page", url: "app://deck/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}` },
          ]),
        );
      }
      return new Response("{}");
    });
    const bridge = new CodexMicroRendererBridge(() => {});
    context.after(() => bridge.close());
    const first = bridge.refresh().then(
      () => "accepted",
      () => "retired",
    );
    firstWork = first;
    await drain();
    assert.equal(lists, 1, "the first discovery is observably held");
    bridge.close();
    const current = bridge.refresh();
    currentWork = current;
    void current.catch(() => {});
    await drain();
    assert.equal(lists, 2, "restart must not join the retired discovery");
    await current;
    old.resolve();
    assert.equal(await first, "retired");
    await bridge.refresh();
    assert.equal(connections, 1, "late discovery must neither open another socket nor retire the fresh one");

    // Hold actual ownership scanning after a valid CDP answer, then reopen the bridge.
    // The old annotation must not restore cached assignments or disconnect the fresh socket.
    const scanning = gate<void>();
    const releaseScan = gate<void>();
    context.after(() => releaseScan.resolve());
    let scans = 0;
    context.mock.method(fsPromises, "readdir", (async () => {
      if (++scans === 1) {
        scanning.resolve();
        await releaseScan.promise;
      }
      return [];
    }) as typeof fsPromises.readdir);
    syncBuiltinESMExports();
    bridge.close();
    const scanAt = Date.now() + 6_000;
    context.mock.method(Date, "now", () => scanAt);
    const retired = bridge.refresh().then(
      () => "accepted",
      () => "retired",
    );
    await scanning.promise;
    bridge.close();
    await bridge.refresh();
    const before = connections;
    releaseScan.resolve();
    assert.equal(await retired, "retired");
    await bridge.refresh();
    assert.equal(connections, before, "old annotation cannot disconnect the fresh socket");
  });

  test("Codex refresh cannot commit a host identity awaited across restart", async (context) => {
    await isolate(context);
    const old = gate<string>();
    context.after(() => old.resolve(JSON.stringify(host)));
    const reached = gate<void>();
    let reads = 0;
    const fresh = { ...host, hostId: "11111111-1111-4111-8111-111111111111" };
    identities(context, async () => {
      reads++;
      if (reads === 2) {
        reached.resolve();
        return old.promise;
      }
      return JSON.stringify(reads > 2 ? fresh : host);
    });
    const source = new CodexSource(() => {});
    context.after(() => source.stop());
    context.mock.method(source.microBridge, "refresh", async () => createMicroSnapshot());
    await source.start();
    const refreshing = source.refresh();
    await reached.promise;
    source.stop();
    await source.start();
    await source.refresh();
    old.resolve(JSON.stringify(host));
    await refreshing;
    assert.equal(source.localHost?.hostId, "11111111-1111-4111-8111-111111111111");
    assert.equal(source.localSnapshot?.host.hostId, "11111111-1111-4111-8111-111111111111");
    assert.equal(source.localHealth.state, "ready");
  });

  test("Codex bridge preserves exact completion acknowledgement across close and reopen", async (context) => {
    await isolate(context);
    const root = join(process.env.CODEX_HOME!, "sessions");
    await fsPromises.mkdir(root, { recursive: true });
    const thread = "10000000-0000-4000-8000-000000000002";
    const path = join(root, `rollout-now-${thread}.jsonl`);
    const started = Date.now() - 1_000;
    await fsPromises.writeFile(
      path,
      JSON.stringify({
        timestamp: new Date(started).toISOString(),
        type: "event_msg",
        payload: { type: "user_message" },
      }) +
        "\n" +
        JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_complete" } }) +
        "\n",
    );
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    let selected = true;
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const { id } = JSON.parse(String(raw)) as { id: number };
        const value = createMicroSnapshot();
        value.slots[0]!.threadKey = thread;
        value.slots[0]!.selected = selected;
        value.slots[0]!.status = "unread";
        socket.send(JSON.stringify({ id, result: { result: { value } } }));
      });
    });
    const bridge = new CodexMicroRendererBridge(() => {});
    context.after(async () => {
      bridge.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    context.mock.method(fsPromises, "readFile", (async () =>
      JSON.stringify({ port })) as unknown as typeof fsPromises.readFile);
    syncBuiltinESMExports();
    context.mock.method(
      globalThis,
      "fetch",
      async (input: unknown) =>
        new Response(
          String(input).endsWith("/json/list")
            ? JSON.stringify([
                { type: "page", url: "app://deck/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}` },
              ])
            : "{}",
        ),
    );
    const acknowledged = await bridge.refresh();
    assert.equal(acknowledged.hostSessions?.find((item) => item.threadId === thread)?.status, "idle");
    selected = false;
    bridge.close();
    const reopened = await bridge.refresh();
    const retained = reopened.hostSessions?.find((item) => item.threadId === thread);
    assert.equal(retained?.status, "idle", "an acknowledged completion must not reappear on reopen");
    assert.equal(retained?.workStartedAt, started);
    assert.equal(retained?.workStartRevision, 0);
  });

  test("closing a pending Codex WebSocket handshake settles before release and permits a fresh connection", async (context) => {
    await isolate(context);
    const http = createServer();
    const server = new WebSocketServer({ noServer: true });
    const handshake = gate<void>();
    const release = gate<void>();
    const retiredClosed = gate<void>();
    let upgrades = 0;
    let connections = 0;
    const sockets = new Set<Socket>();
    http.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    http.on("upgrade", async (request, socket, head) => {
      if (++upgrades === 1) {
        socket.once("end", () => socket.destroy());
        socket.once("close", () => retiredClosed.resolve());
        handshake.resolve();
        await release.promise;
      }
      if (!socket.destroyed) server.handleUpgrade(request, socket, head, (client) => server.emit("connection", client));
    });
    server.on("connection", (socket) => {
      connections++;
      socket.on("message", (raw) => {
        const { id } = JSON.parse(String(raw)) as { id: number };
        socket.send(JSON.stringify({ id, result: { result: { value: createMicroSnapshot() } } }));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    context.mock.method(fsPromises, "readFile", (async () =>
      JSON.stringify({ port })) as unknown as typeof fsPromises.readFile);
    syncBuiltinESMExports();
    context.mock.method(
      globalThis,
      "fetch",
      async (input: unknown) =>
        new Response(
          String(input).endsWith("/json/list")
            ? JSON.stringify([
                { type: "page", url: "app://deck/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}` },
              ])
            : "{}",
        ),
    );
    const bridge = new CodexMicroRendererBridge(() => {});
    // Freeze timeout delivery at its public boundary while retaining native
    // cancellation handles, including close timers from earlier transports.
    const schedule = globalThis.setTimeout;
    context.mock.method(globalThis, "setTimeout", ((
      callback: (...args: unknown[]) => void,
      _delay?: number,
      ...args: unknown[]
    ) => schedule(callback, 2_147_483_647, ...args).unref()) as typeof setTimeout);
    let retiredSettled = false;
    const retired = bridge.refresh().then(
      () => {
        retiredSettled = true;
        return "accepted";
      },
      () => {
        retiredSettled = true;
        return "retired";
      },
    );
    context.after(async () => {
      release.resolve();
      bridge.close();
      await retired;
      for (const socket of server.clients) socket.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    await handshake.promise;
    // Hold the connection guard's clock: a missing cancellation handler cannot
    // accidentally satisfy prompt retirement by reaching its 3000 ms timeout.
    bridge.close();
    const fresh = await bridge.refresh();
    assert.equal(fresh.slots[0]?.title, "Task 1", "the new generation answers while the old handshake is held");
    assert.equal(
      retiredSettled,
      true,
      "close must settle CONNECTING work before releasing the handshake or its timeout",
    );
    assert.equal(await retired, "retired");
    await retiredClosed.promise;
    assert.equal(connections, 1, "the retired handshake never becomes an accepted WebSocket");
    assert.equal(sockets.size, 1, "only the fresh transport remains connected");
    release.resolve();
    await bridge.refresh();
    assert.equal(connections, 1, "late upgrade release cannot replace the fresh socket");
    const freshClosed = gate<void>();
    [...sockets][0]!.once("close", () => freshClosed.resolve());
    bridge.close();
    await freshClosed.promise;
    assert.equal(sockets.size, 0, "closing the fresh generation releases every server transport");
    assert.equal(server.clients.size, 0);
  });
}
