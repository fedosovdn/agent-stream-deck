import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCodexLaunchSpec,
  buildLaunchAgentPlist,
  buildWatcherLaunchScript,
  parseDebugPort,
} from "../launcher/macos/codex-deck-macos.js";
import { codexDeckStateRoot } from "../src/runtime/paths.js";

test("macOS launcher uses LaunchServices and passes loopback-only CDP arguments", () => {
  const spec = buildCodexLaunchSpec({ appPath: "/Applications/Unexpected Codex Name.app" }, 43123);
  assert.equal(spec.command, "/usr/bin/open");
  assert.deepEqual(spec.args, [
    "-n",
    "-a",
    "/Applications/Unexpected Codex Name.app",
    "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=43123",
  ]);
  assert.doesNotMatch(spec.args.join(" "), /0\.0\.0\.0/);
});

test("macOS launcher validates ports and parses both supported flag forms", () => {
  assert.throws(() => buildCodexLaunchSpec({ appPath: "/Applications/Codex.app" }, 0), /Invalid debugging port/);
  assert.equal(parseDebugPort("Codex --remote-debugging-port=43123"), 43123);
  assert.equal(parseDebugPort("Codex --remote-debugging-port 43124"), 43124);
  assert.equal(parseDebugPort("Codex --remote-debugging-port=70000"), null);
});

test("bridge and user icon state use the native macOS Application Support root", () => {
  assert.equal(codexDeckStateRoot("darwin", "/Users/tester"), "/Users/tester/Library/Application Support/CodexDeck");
  assert.equal(
    codexDeckStateRoot("win32", "C:\\Users\\tester", "C:\\Users\\tester\\AppData\\Local"),
    "C:\\Users\\tester\\AppData\\Local\\CodexDeck",
  );
});

test("LaunchAgent uses a dynamic Node resolver instead of pinning an NVM version", () => {
  const launcher = buildWatcherLaunchScript("/tmp/Codex Deck/runtime.mjs");
  const plist = buildLaunchAgentPlist("/tmp/Codex Deck/watcher-launch.sh");
  assert.match(launcher, /\.nvm\/versions\/node\/\*\/bin\/node/);
  assert.match(launcher, /Contents\/Resources\/cua_node\/bin\/node/);
  assert.match(launcher, /Node\.js 24 or newer/);
  assert.match(plist, /<string>\/bin\/zsh<\/string>/);
  assert.match(plist, /watcher-launch\.sh/);
  assert.match(plist, /watcher\.stderr\.log/);
  assert.doesNotMatch(plist, /\.nvm\/versions\/node\/v\d/);
});

test("manual and double-click launch resolve Node outside an interactive shell", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../launcher/start-codex-deck.sh", import.meta.url), "utf8"),
  );
  assert.match(source, /\.nvm\/versions\/node\/\*\/bin\/node/);
  assert.match(source, /Contents\/Resources\/cua_node\/bin\/node/);
  assert.match(source, /node_major/);
  assert.doesNotMatch(source, /exec \/usr\/bin\/env node/);
});

test("macOS release packaging preserves executable launchers", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../scripts/package-macos-release.sh", import.meta.url), "utf8"),
  );
  assert.match(source, /chmod 755/);
  assert.match(source, /start-codex-deck\.sh/);
  assert.match(source, /Start Codex Deck\.command/);
  assert.match(source, /ditto -c -k/);
});

test("macOS discovery reuses only stable metadata while checking fresh candidates and executables", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-discovery-")));
  try {
    const runtime = join(root, "runtime.mjs");
    await build({
      stdin: {
        contents: "export { discoverCodexInstallation } from './launcher/macos/codex-deck-macos.ts';",
        loader: "ts",
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      },
      outfile: runtime,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    const scenario = join(root, "scenario.mjs");
    await writeFile(
      scenario,
      `
      import assert from "node:assert/strict";
      import cp from "node:child_process";
      import fs from "node:fs";
      import fsp from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      const root = ${JSON.stringify(root)};
      let candidates = [], running = [], nextRunning, generation = 0, plutil = 0, fail = false, race;
      const originalReaddir = fsp.readdir;
      fsp.readdir = (path, ...args) => {
        if (path === "/Applications" || path === join(root, "Applications")) return Promise.resolve([]);
        throw new Error("Unexpected directory read");
      };
      cp.spawnSync = (command, args) => {
        if (command === "/bin/ps") {
          const stdout = running.map((path, index) => (index + 100 + generation) + " 1 Tue Oct 13 10:00:00 2026 " + join(path, "Contents/MacOS/Codex")).join("\\n");
          if (nextRunning) { running = nextRunning; nextRunning = undefined; }
          return { status: 0, stdout, stderr: "" };
        }
        if (command === "/usr/bin/mdfind") return { status: 0, stdout: candidates.join("\\n"), stderr: "" };
        if (command === "/usr/bin/plutil") {
          plutil++;
          if (fail) { fail = false; return { status: 1, stdout: "", stderr: "temporary failure" }; }
          const value = JSON.parse(fs.readFileSync(args[5], "utf8"))[args[1]];
          if (race && args[1] === "CFBundleExecutable") { const change = race; race = undefined; change(); }
          return { status: 0, stdout: value, stderr: "" };
        }
        throw new Error("Unexpected external command");
      };
      cp.spawn = () => { throw new Error("Unexpected child process"); };
      globalThis.fetch = () => { throw new Error("Unexpected network"); };
      syncBuiltinESMExports();
      const { discoverCodexInstallation: discover } = await import(${JSON.stringify(runtime)});
      const metadata = (version = "1.0", id = "com.openai.codex") => ({ CFBundleIdentifier: id, CFBundleExecutable: "Codex", CFBundleShortVersionString: version, CFBundleVersion: "100" });
      const info = path => join(path, "Contents/Info.plist");
      const executable = path => join(path, "Contents/MacOS/Codex");
      const make = (name, version, id) => {
        const path = join(root, name + ".app");
        fs.mkdirSync(join(path, "Contents/MacOS"), { recursive: true });
        fs.writeFileSync(info(path), JSON.stringify(metadata(version, id)));
        fs.writeFileSync(executable(path), "fixture executable");
        return path;
      };
      const first = make("Unusual installation name", "1.0"), foreign = make("Other app", "9.0", "org.example.other");
      candidates = [foreign, first];
      assert.equal((await discover()).appPath, first);
      assert.equal(plutil, 5);
      assert.equal((await discover()).appPath, first);
      assert.equal(plutil, 5, "unchanged candidates must not rerun plutil");
      const exposed = await discover();
      exposed.bundleId = "org.example.modified";
      exposed.version = "99.0";
      assert.equal((await discover()).bundleId, "com.openai.codex", "returned fields must not corrupt metadata reuse");
      assert.equal((await discover()).version, "1.0");

      // An atomic replacement preserves length and timestamps but changes the file identity.
      const old = fs.statSync(info(first));
      fs.writeFileSync(info(first) + ".new", JSON.stringify(metadata("2.0")));
      fs.utimesSync(info(first) + ".new", old.atime, old.mtime);
      fs.renameSync(info(first) + ".new", info(first));
      assert.equal((await discover()).version, "2.0");
      fs.writeFileSync(info(first), JSON.stringify(metadata("2.0", "org.other.appid")));
      await assert.rejects(discover(), /No installed Codex app/);
      fs.writeFileSync(info(first), JSON.stringify(metadata("3.0")));
      assert.equal((await discover()).version, "3.0");

      fs.unlinkSync(executable(first));
      await assert.rejects(discover(), /No installed Codex app/);
      fs.mkdirSync(executable(first));
      await assert.rejects(discover(), /No installed Codex app/);
      fs.rmdirSync(executable(first));
      fs.writeFileSync(executable(first), "restored executable");
      assert.equal((await discover()).appPath, first);

      fs.writeFileSync(info(first), JSON.stringify(metadata("4.0")));
      fail = true;
      await assert.rejects(discover(), /No installed Codex app/);
      assert.equal((await discover()).version, "4.0", "temporary metadata failure must recover");
      fs.writeFileSync(info(first), JSON.stringify(metadata("5.0")));
      race = () => fs.writeFileSync(info(first), JSON.stringify(metadata("5.0", "org.other.appid")));
      await assert.rejects(discover(), /No installed Codex app/, "mixed plist fields must not be trusted");
      await assert.rejects(discover(), /No installed Codex app/);
      fs.writeFileSync(info(first), JSON.stringify(metadata("6.0")));
      assert.equal((await discover()).version, "6.0");
      const fixedTime = new Date("2026-01-01T00:00:00Z");
      fs.utimesSync(info(first), fixedTime, fixedTime);
      await discover();
      const beforeInPlace = fs.statSync(info(first));
      fs.writeFileSync(info(first), JSON.stringify(metadata("6.1")));
      fs.utimesSync(info(first), fixedTime, fixedTime);
      const afterInPlace = fs.statSync(info(first));
      assert.equal(afterInPlace.ino, beforeInPlace.ino);
      assert.equal(afterInPlace.size, beforeInPlace.size);
      assert.equal(afterInPlace.mtimeMs, beforeInPlace.mtimeMs);
      assert.equal((await discover()).version, "6.1", "ctime invalidates equal-sized in-place replacement with restored mtime");

      const second = make("New Codex", "7.0");
      candidates.push(second);
      assert.equal((await discover()).appPath, second);
      running = [first];
      assert.equal((await discover()).appPath, first);
      generation++;
      assert.equal((await discover()).appPath, first, "changed running PID is sampled anew");
      nextRunning = [second];
      assert.equal((await discover()).appPath, second, "second fresh process sample owns running priority");
      running = [];
      process.env.CODEX_DECK_APP_PATH = first;
      assert.equal((await discover()).appPath, second, "explicit path preserves version selection priority");
      candidates = [];
      assert.equal((await discover()).appPath, first, "explicit unusual app path remains discoverable");
      delete process.env.CODEX_DECK_APP_PATH;

      // Disappeared candidates must not retain cached metadata even if the file is unchanged.
      candidates = [second];
      await discover();
      candidates = [first];
      const beforeReappearance = plutil;
      await discover();
      assert.equal(plutil - beforeReappearance, 4);
      fs.renameSync(first, first + ".away");
      await assert.rejects(discover(), /No installed Codex app/);
      fs.renameSync(first + ".away", first);
      const beforeRestoredDirectory = plutil;
      await discover();
      assert.equal(plutil - beforeRestoredDirectory, 4, "missing app directories must evict cached metadata");
      candidates = [first, ...Array.from({ length: 140 }, (_, index) => make("Foreign " + index, "1.0", "org.example.other"))];
      await discover();
      const beforeOverflow = plutil;
      assert.equal((await discover()).appPath, first);
      assert.ok(plutil > beforeOverflow, "metadata retention must remain bounded");
      fsp.readdir = originalReaddir;
      console.log("discovery fixture passed");
    `,
    );
    const result = spawnSync(process.execPath, [scenario], {
      env: { ...process.env, HOME: root, CODEX_DECK_APP_PATH: "" },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /discovery fixture passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS watcher update fails before stopping on preflight failure and reports partial bootstrap failure", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-watcher-install-")));
  try {
    // The installed launch script only searches fixed Node locations; give the fixture HOME one so the
    // test does not depend on Homebrew or a Codex app providing Node 24 on this machine.
    const fixtureNode = join(root, ".nvm/versions/node/v24.0.0/bin");
    await mkdir(fixtureNode, { recursive: true });
    await symlink(process.execPath, join(fixtureNode, "node"));
    const fixtureRuntime = join(root, "runtime.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../launcher/macos/codex-deck-macos.ts", import.meta.url))],
      outfile: fixtureRuntime,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    const mockPath = join(root, "mock.mjs");
    const callsPath = join(root, "calls.json");
    await writeFile(
      mockPath,
      `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      let watcher;
      process.on("beforeExit", () => {
        if (!watcher) return;
        const child = watcher;
        watcher = undefined;
        child.once("exit", () => writeFileSync(${JSON.stringify(join(root, "watcher-exited"))}, "exited"));
        child.ref();
        child.kill();
      });
      const original = childProcess.spawnSync;
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = (...args) => {
        if (process.env.CHILD_WATCHER === "true") throw new Error("Fixture blocked external process launch");
        return originalSpawn(...args);
      };
      const calls = [];
      childProcess.spawnSync = (command, args, options) => {
        if (process.env.CHILD_WATCHER === "true") {
          if (command === "/bin/ps") return { status: 0, stdout: "", stderr: "" };
          // Block discovery, app launch/quit, and every external child command.
          return { status: 1, stdout: "", stderr: "Fixture blocked external command" };
        }
        if (command === "/bin/launchctl") {
          calls.push(args);
          writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
          if (process.env.INSTALL_SCENARIO === "live") {
            if (args[0] === "bootstrap") watcher = childProcess.spawn("/bin/zsh", [join(process.env.HOME, "Library/Application Support/CodexDeck/watcher-launch.sh")], { env: { ...process.env, CHILD_WATCHER: "true", NODE_OPTIONS: "--import=" + JSON.stringify(${JSON.stringify(mockPath)}) }, stdio: "ignore" });
            watcher?.unref();
            return { status: 0, stdout: args[0] === "print" ? "state = running; pid = " + watcher.pid : "", stderr: "" };
          }
          if (process.env.INSTALL_SCENARIO === "no-ready") return { status: 0, stdout: args[0] === "print" ? "state = running; pid = 777" : "", stderr: "" };
          if (process.env.INSTALL_SCENARIO === "busy") return { status: args[0] === "print" ? 0 : 1, stdout: "state = running", stderr: "fixture busy service" };
          return { status: args[0] === "bootout" ? 0 : 1, stdout: "", stderr: "fixture launchctl failure" };
        }
        if (command === "/bin/zsh" && process.env.PREFLIGHT_FAIL === "true") {
          return { status: 1, stdout: "", stderr: "fixture runtime preflight failure" };
        }
        return original(command, args, options);
      };
      syncBuiltinESMExports();
    `,
    );
    for (const scenario of ["preflight", "bootstrap", "busy", "no-ready", "live"]) {
      const preflightFails = scenario === "preflight";
      await writeFile(callsPath, "[]");
      const result = spawnSync(process.execPath, ["--import", mockPath, fixtureRuntime, "install"], {
        env: { ...process.env, HOME: root, PREFLIGHT_FAIL: String(preflightFails), INSTALL_SCENARIO: scenario },
        encoding: "utf8",
        timeout: 35_000,
      });
      assert.equal(result.status, scenario === "live" ? 0 : 1, result.stderr);
      const calls = JSON.parse(await readFile(callsPath, "utf8")) as string[][];
      if (preflightFails) {
        assert.match(result.stderr, /fixture runtime preflight failure/);
        assert.deepEqual(calls, [], "preflight failure must not stop the existing service");
      } else if (scenario === "busy") {
        assert.match(result.stderr, /runtime was left unchanged/);
        assert.deepEqual(
          calls.map((args) => args[0]),
          ["bootout", "print"],
        );
      } else if (scenario === "no-ready") {
        assert.match(result.stderr, /did not acquire its lock and confirm startup/);
        assert.doesNotMatch(result.stdout, /installed and watcher running/);
        assert.ok(calls.some((args) => args[0] === "bootstrap"));
        assert.ok(calls.some((args) => args[0] === "print"));
      } else if (scenario === "live") {
        assert.match(result.stdout, /installed and watcher running/);
        assert.ok(calls.some((args) => args[0] === "print"));
        assert.equal(await readFile(join(root, "watcher-exited"), "utf8"), "exited");
        await assert.rejects(readFile(join(root, "Library/Application Support/CodexDeck/watcher.lock/pid")));
      } else {
        assert.match(result.stderr, /partially failed after stopping the old service/);
        assert.deepEqual(
          calls.map((args) => args[0]),
          ["bootout", "bootstrap"],
        );
        assert.match(calls[0]![1]!, /com\.simeo\.codex-deck\.watcher$/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("double-click launcher handles success, decline and accepted restart in actual zsh", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-command-"));
  try {
    const command = join(root, "Start Codex Deck.command");
    await writeFile(command, await readFile(new URL("../launcher/Start Codex Deck.command", import.meta.url)));
    const stub = join(root, "start-codex-deck.sh");
    await writeFile(
      stub,
      '#!/bin/zsh\n[[ "$2" == "--restart" ]] && { print restarted; exit 0; }\nexit $FIXTURE_STATUS\n',
    );
    await chmod(stub, 0o755);
    for (const scenario of [
      { status: "0", input: "", restarted: false },
      { status: "2", input: "no\n", restarted: false },
      { status: "2", input: "yes\n", restarted: true },
    ]) {
      const result = spawnSync("/bin/zsh", [command], {
        env: { ...process.env, FIXTURE_STATUS: scenario.status },
        input: scenario.input,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes("restarted"), scenario.restarted);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
