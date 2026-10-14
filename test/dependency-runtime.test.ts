import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexDeckStateRoot } from "../src/runtime/paths.js";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import type { verifyMicroRuntime } from "#codex";
// @ts-expect-error Build options are shared with plain ESM release scripts.
import { buildOptions } from "../scripts/build-options.mjs";
import type { DeckController } from "#stream-deck";
import type { Fast } from "#stream-deck";

let launcherDirectory: string;
let bundledVerifyMicroRuntime: typeof verifyMicroRuntime;
before(async () => {
  launcherDirectory = await mkdtemp(join(tmpdir(), "codex-launcher-bundle-"));
  await cp(fileURLToPath(new URL("../node_modules/ws", import.meta.url)), join(launcherDirectory, "node_modules/ws"), {
    recursive: true,
  });
  const outfile = join(launcherDirectory, "runtime.mjs");
  const result = await build({
    ...buildOptions("windows", true),
    stdin: {
      contents: "export { verifyMicroRuntime } from './src/codex/runtime-override.ts';",
      loader: "ts",
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    },
    outfile,
    metafile: true,
  });
  // Windows distributes ws beside the ESM launcher rather than embedding it.
  assert.ok(
    Object.values(result.metafile!.outputs).some((output) =>
      output.imports.some((dependency) => dependency.path === "ws" && dependency.external),
    ),
  );
  ({ verifyMicroRuntime: bundledVerifyMicroRuntime } = await import(pathToFileURL(outfile).href));
});
after(async () => {
  if (launcherDirectory) await rm(launcherDirectory, { recursive: true, force: true });
});

test("plugin maps preserve fault coordinates without release source text", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-deck-maps-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "fault.ts");
  const contents =
    'export function fail() {\n  const message = "DIAGNOSTIC_FAULT";\n  throw new Error(message);\n}\nfail();\n';
  await writeFile(source, contents);
  for (const [mode, release] of [
    ["development", false],
    ["release", true],
  ] as const) {
    const outfile = join(directory, mode, "plugin.mjs");
    await build({ ...buildOptions("plugin", release), entryPoints: [source], outfile });
    const javascript = await readFile(outfile, "utf8");
    assert.match(javascript, /sourceMappingURL=plugin\.mjs\.map/);
    const payload = JSON.parse(await readFile(`${outfile}.map`, "utf8"));
    for (const path of payload.sources) {
      assert.ok(!isAbsolute(path) && !/^(?:file:|[a-z]:)/i.test(path), "maps must use portable source paths");
    }
    if (release) assert.equal(payload.sourcesContent, undefined);
    else assert.deepEqual(payload.sourcesContent, [contents]);
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      `try { await import(${JSON.stringify(pathToFileURL(outfile).href)}); } catch (error) { process.stdout.write(error.stack); }`,
    ]);
    assert.match(stdout, /Error: DIAGNOSTIC_FAULT/);
    const position = /plugin\.mjs:(\d+):(\d+)/.exec(stdout);
    assert.ok(position, stdout);
    const original = new SourceMap(payload).findEntry(Number(position[1]) - 1, Number(position[2]) - 1);
    assert.ok("originalSource" in original, "the map must resolve the exception frame");
    assert.match(original.originalSource, /fault\.ts$/);
    assert.equal(original.originalLine, 2, "the exception must map to source line 3");
  }
});

test("bundled ESM actions retain SDK decoration and native press/release behavior", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-deck-actions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "actions.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/stream-deck/actions.ts", import.meta.url))],
    outfile,
    ...buildOptions("plugin", true),
  });
  // A bundled SDK instance owns its own cwd-based logger. Keep its rotation
  // separate from SDK instances loaded by other test processes.
  const previousDirectory = process.cwd();
  let actions: { Fast: typeof Fast };
  try {
    process.chdir(directory);
    actions = (await import(pathToFileURL(outfile).href)) as { Fast: typeof Fast };
  } finally {
    process.chdir(previousDirectory);
  }
  const inputs: Array<[string, number]> = [];
  const controller = {
    sendMicroAction: async (slot: string, act: number) => {
      inputs.push([slot, act]);
    },
  } as unknown as DeckController;
  const action = new actions.Fast(controller);
  assert.equal(action.manifestId, "com.xonika9.codex-deck.fast");
  const event = { action: { showAlert: async () => assert.fail("native action unexpectedly failed") } };
  await action.onKeyDown(event as never);
  await action.onKeyUp(event as never);
  assert.deepEqual(inputs, [
    ["ACT06", 1],
    ["ACT06", 0],
  ]);
});

test("ESM launcher verifies the runtime over loopback HTTP and WebSocket CDP", async (context) => {
  let port = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/json/list");
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify([
        { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/main` },
      ]),
    );
  });
  const sockets = new WebSocketServer({ server });
  context.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  const receipt = { ready: true, nativeEventBus: true, hidHandlers: 1, joystickHandlers: 1 };
  let evaluations = 0;
  let closed: Promise<unknown> | undefined;
  sockets.on("connection", (socket, request) => {
    assert.equal(request.url, "/devtools/page/main");
    closed = once(socket, "close");
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params: { expression: string; awaitPromise: boolean; returnByValue: boolean };
      };
      assert.equal(message.method, "Runtime.evaluate");
      assert.equal(message.params.awaitPromise, true);
      assert.equal(message.params.returnByValue, true);
      assert.ok(message.params.expression.length > 0);
      evaluations += 1;
      // Notifications and unrelated responses must not complete the pending request.
      socket.send(JSON.stringify({ method: "Runtime.consoleAPICalled", params: {} }));
      socket.send(JSON.stringify({ id: message.id + 100, result: { result: { value: { ready: false } } } }));
      socket.send(JSON.stringify({ id: message.id, result: { result: { value: receipt } } }));
    });
  });
  assert.deepEqual(await bundledVerifyMicroRuntime(port, 2_000), receipt);
  assert.equal(evaluations, 1);
  assert.ok(closed);
  await closed;
});

for (const failure of ["http", "handshake", "pending", "close"] as const) {
  test(`launcher bounds ${failure} failure and can reconnect`, async (context) => {
    let port = 0;
    let broken = true;
    const server = createServer((_request, response) => {
      if (broken && failure === "http") return;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify([
          { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/main` },
        ]),
      );
    });
    const peers = new Set<import("node:stream").Duplex>();
    server.on("connection", (socket) => {
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if (broken && failure === "handshake") return;
      sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
    });
    sockets.on("connection", (socket) =>
      socket.on("message", (raw) => {
        if (broken) {
          if (failure === "close") socket.close();
          return;
        }
        const { id } = JSON.parse(String(raw));
        socket.send(JSON.stringify({ id, result: { result: { value: { ready: true } } } }));
      }),
    );
    context.after(async () => {
      for (const socket of sockets.clients) socket.terminate();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as import("node:net").AddressInfo).port;
    let guard: NodeJS.Timeout | undefined;
    try {
      await assert.rejects(
        Promise.race([
          bundledVerifyMicroRuntime(port, 120),
          new Promise((_, reject) => {
            guard = setTimeout(() => reject(new Error("TEST_GUARD_EXPIRED")), 500);
          }),
        ]),
        (error) => error instanceof Error && !error.message.includes("TEST_GUARD_EXPIRED"),
      );
    } finally {
      clearTimeout(guard);
    }
    broken = false;
    assert.deepEqual(await bundledVerifyMicroRuntime(port, 1_000), { ready: true });
  });
}

test("native bridge releases an unowned handshake attempt before retry", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-handshake-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let port = 0;
  let upgrades = 0;
  let closures = 0;
  const peers = new Set<import("node:stream").Duplex>();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      request.url === "/json/version"
        ? "{}"
        : JSON.stringify([
            { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/main` },
          ]),
    );
  });
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.resume();
    socket.once("end", () => socket.end());
    peers.add(socket);
    socket.once("close", () => {
      closures++;
      peers.delete(socket);
    });
    if (upgrades === 3) socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
  });
  context.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as import("node:net").AddressInfo).port;
  const stateRoot = codexDeckStateRoot(process.platform, directory, directory);
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "codex-micro-bridge.json"), JSON.stringify({ port }));
  const script = join(directory, "handshake.mjs");
  await writeFile(
    script,
    `
    import assert from "node:assert/strict";
    import { CodexMicroRendererBridge } from ${JSON.stringify(new URL("../src/codex/index.ts", import.meta.url).href)};
    const bridge = new CodexMicroRendererBridge(() => {});
    try {
      await assert.rejects(bridge.refresh(), /Zeitüberschreitung/);
      bridge.close();
      await assert.rejects(bridge.refresh(), /Zeitüberschreitung/);
      await assert.rejects(bridge.refresh(), /Unexpected server response/);
      process.stdout.write("NATIVE_HANDSHAKE_SUCCESS\\n");
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally { bridge.close(); }
  `,
  );
  const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), script], {
    cwd: directory,
    env: { ...process.env, HOME: directory, LOCALAPPDATA: directory },
    timeout: 8_000,
  });
  assert.match(result.stdout, /NATIVE_HANDSHAKE_SUCCESS/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(upgrades, 3);
  assert.equal(closures, 3, "timeout and error attempts must close at their owner boundary");
});

test("launcher relinquishes its process handle after a deadline with a peer that ignores close", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cdp-close-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let port = 0;
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify([
        { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/main` },
      ]),
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) =>
    socket.once("message", () => {
      (socket as unknown as { _socket: import("node:net").Socket })._socket.pause();
    }),
  );
  context.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as import("node:net").AddressInfo).port;
  const script = join(directory, "close.mjs");
  await writeFile(
    script,
    `
    import assert from "node:assert/strict";
    import { verifyMicroRuntime } from ${JSON.stringify(pathToFileURL(join(launcherDirectory, "runtime.mjs")).href)};
    await assert.rejects(verifyMicroRuntime(${port}, 120), /Timed out/);
    process.stdout.write("CDP_DEADLINE_RELEASED\\n");
  `,
  );
  const result = await promisify(execFile)(process.execPath, [script], {
    cwd: directory,
    timeout: 2_000,
  });
  assert.match(result.stdout, /CDP_DEADLINE_RELEASED/);
});
