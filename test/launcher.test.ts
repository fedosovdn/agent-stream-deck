import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRuntimeOverrideExpression, buildRuntimeVerificationExpression, selectRuntimeTarget } from "#codex";

const execFileAsync = promisify(execFile);

test("launcher rejects an unsafe feature-gate expression", () => {
  assert.throws(() => buildRuntimeOverrideExpression("1);alert(1)//"), /digits only/);
});

test("runtime override targets the main renderer instead of macOS avatar surfaces", () => {
  const target = selectRuntimeTarget([
    { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://route" },
    {
      type: "page",
      url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge",
      webSocketDebuggerUrl: "ws://mascot",
    },
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://main" },
  ]);

  assert.equal(target?.webSocketDebuggerUrl, "ws://main");
});

// Recovery decisions themselves are exercised by the Windows PowerShell self-test below.
test("Windows startup shortcut, watcher, and Codex package keep their cross-script contracts", async () => {
  const [watcher, launcher] = await Promise.all([
    readFile(new URL("../launcher/Watch-CodexDeck.ps1", import.meta.url), "utf8"),
    readFile(new URL("../launcher/Start-CodexDeck.ps1", import.meta.url), "utf8"),
  ]);
  // Older installed watchers hold the same mutex, so a renamed mutex would run duplicate watchers.
  assert.match(watcher, /Local\\CodexDeckBridgeWatcher/);
  assert.match(watcher, /Get-AppxPackage -Name 'OpenAI\.Codex'/);
  assert.match(watcher, /\[switch\]\$RecoverExistingSession/);
  assert.match(launcher, /-File `"\$watcherPath`" -RecoverExistingSession/);
  assert.match(launcher, /LocalAppData.*CodexDeck.*launcher/is);
  // The self-test covers the recovery decision, not the loop: only that guarded branch may restart Codex.
  assert.equal(watcher.match(/Invoke-CodexDeckLauncher -ForceRestart/g)?.length, 1);
  assert.match(
    watcher,
    /-and \$mayRecover\) \{\s*\$nextRecoveryAt = \[DateTimeOffset\]::UtcNow\.AddMinutes\(10\)[\s\S]{0,300}Invoke-CodexDeckLauncher -ForceRestart/,
    "the recovery restart is guarded and starts the global cooldown",
  );
});

test("launcher build ships an explicit ws allowlist and LF macOS start scripts", async () => {
  const build = await readFile(new URL("../scripts/build-launcher.mjs", import.meta.url), "utf8");
  assert.match(build, /"Start-CodexDeck\.ps1", "Watch-CodexDeck\.ps1"/);
  assert.match(build, /"package\.json", "browser\.js", "index\.js", "wrapper\.mjs"/);
  assert.doesNotMatch(build, /cp\(resolve\("node_modules\/ws"\).*recursive: true/s);
  assert.match(build, /replace\(\/\\r\\n\/g, "\\n"\)/);
});

test("both launcher packages resolve the README cover links to the public JPEG", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-launcher-docs-"));
  try {
    for (const name of ["docs", "launcher", "README.md", "README.ru.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md"]) {
      await cp(new URL(`../${name}`, import.meta.url), join(root, name), { recursive: true });
    }
    await mkdir(join(root, "node_modules"));
    await cp(new URL("../node_modules/ws", import.meta.url), join(root, "node_modules/ws"), { recursive: true });
    // Public docs packaging is the boundary here; unrelated runtime bundles use empty entries.
    await writeFile(join(root, "launcher/runtime-override.ts"), "export {};\n");
    await writeFile(join(root, "launcher/macos/codex-deck-macos.ts"), "export {};\n");
    await execFileAsync(process.execPath, [fileURLToPath(new URL("../scripts/build-launcher.mjs", import.meta.url))], {
      cwd: root,
    });

    for (const name of ["codex-deck-launcher", "codex-deck-launcher-macos"]) {
      const output = join(root, "release", name);
      for (const guide of ["README.md", "README.ru.md"]) {
        assert.match(await readFile(join(output, guide), "utf8"), /src="docs\/assets\/codex-deck-hero\.jpg"/);
      }
      assert.deepEqual(
        await readFile(join(output, "docs/assets/codex-deck-hero.jpg")),
        await readFile(new URL("../docs/assets/codex-deck-hero.jpg", import.meta.url)),
      );
      await assert.rejects(access(join(output, "docs/assets/codex-deck-hero.png")), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watcher recovery decision self-test passes in PowerShell", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows PowerShell watcher self-test runs on Windows");
    return;
  }

  const watcherPath = fileURLToPath(new URL("../launcher/Watch-CodexDeck.ps1", import.meta.url));
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    watcherPath,
    "-SelfTest",
  ]);
  assert.match(stdout, /self-test passed \(8 cases\)/i);
});

const MICRO_HANDLERS = ["codex-micro-device-state-changed", "codex-micro-hid-event", "codex-micro-joystick-event"];

/** A renderer with one Statsig client whose gates read through the installed override adapter, as Statsig does. */
function runtimeRenderer(options: {
  resources: string[];
  modules: Record<string, Record<string, unknown>>;
  settingsLink?: boolean;
}) {
  const emitted: unknown[] = [];
  const client = {
    overrideAdapter: undefined as { getGateOverride?: (gate: object) => { value?: boolean } } | undefined,
    _memoCache: { stale: true } as Record<string, unknown>,
    checkGate(name: string): boolean {
      const gate = { name, value: false };
      return Boolean((client.overrideAdapter?.getGateOverride?.(gate) ?? gate).value);
    },
    $emt: (event: unknown) => emitted.push(event),
  };
  let now = 0;
  const context = {
    Map,
    Set,
    Proxy,
    Reflect,
    Date: { now: () => (now += 1_000) },
    setTimeout: (callback: () => void) => callback(),
    __STATSIG__: { firstInstance: client },
    document: {
      querySelectorAll: () => [],
      querySelector: () => (options.settingsLink ? {} : null),
    },
    performance: { getEntriesByType: () => options.resources.map((name) => ({ name })) },
    loadModule: async (url: string) => {
      const module = options.modules[url];
      if (!module) throw new Error(`unexpected import ${url}`);
      return module;
    },
  };
  const run = async (expression: string) =>
    JSON.parse(JSON.stringify(await runInNewContext(expression.replaceAll("import(", "loadModule("), context)));
  return {
    client,
    emitted,
    activate: () => run(buildRuntimeOverrideExpression()),
    verify: () => run(buildRuntimeVerificationExpression()),
  };
}

function nativeBus(handlers: string[], events: unknown[] = []) {
  return {
    handlers: new Map(handlers.map((name) => [name, new Set([() => {}])])),
    dispatchHostMessage: (message: unknown) => events.push(message),
  };
}

test("launcher enables only the Micro gate and records detection through any persisted-signal build", async () => {
  const signals = new Map<string, unknown>();
  const persistedUrl = "app://-/assets/persisted-signal-Zq81_x.js";
  const renderer = runtimeRenderer({
    resources: [persistedUrl],
    modules: {
      [persistedUrl]: {
        p: (key: string, fallback: unknown) => (signals.has(key) ? signals.get(key) : fallback),
        b: (key: string, value: unknown) => signals.set(key, value),
      },
    },
  });

  const result = await renderer.activate();
  assert.equal(result.ready, true);
  assert.equal(result.detectionMethod, "persisted-signal");
  assert.equal(signals.get("codex-micro-has-ever-been-detected"), true);
  assert.equal(renderer.client.checkGate("3207467860"), true);
  assert.equal(renderer.client.checkGate("1234"), false, "other gates keep their real value");
  assert.deepEqual(Object.keys(renderer.client._memoCache), [], "cached gate results are cleared");
  assert.deepEqual(JSON.parse(JSON.stringify(renderer.emitted)), [{ name: "values_updated" }]);
});

test("launcher reports a changed persisted-signal API instead of guessing", async () => {
  const persistedUrl = "app://-/assets/persisted-signal-changed.js";
  const renderer = runtimeRenderer({ resources: [persistedUrl], modules: { [persistedUrl]: { p: () => true } } });
  assert.deepEqual(await renderer.activate(), { ready: false, reason: "persisted-signal-api-changed" });
});

test("launcher activates and verifies a native event bus exposed only by app-shared", async () => {
  const events: unknown[] = [];
  const renderer = runtimeRenderer({
    resources: ["app://-/assets/app-shared-fixture.js"],
    modules: { "app://-/assets/app-shared-fixture.js": { bus: nativeBus(MICRO_HANDLERS, events) } },
  });
  const activate = await renderer.activate();
  assert.equal(activate.ready, true);
  assert.equal(activate.detectionMethod, "native-device-event");
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    {
      type: "codex-micro-device-state-changed",
      state: { status: "connected", error: null, battery: { percentage: 100, isCharging: true } },
    },
  ]);
  const verify = await renderer.verify();
  assert.equal(verify.ready, true);
  assert.equal(verify.menuEnabled, true, "the activated gate enables the Micro menu");
});

test("launcher verification requires both native input handlers and an enabled Micro menu", async () => {
  const url = "app://-/assets/app-shared-fixture.js";
  const missingJoystick = runtimeRenderer({
    resources: [url],
    modules: { [url]: { bus: nativeBus(MICRO_HANDLERS.slice(0, 2)) } },
    settingsLink: true,
  });
  assert.equal((await missingJoystick.verify()).ready, false);

  const gateOff = runtimeRenderer({ resources: [url], modules: { [url]: { bus: nativeBus(MICRO_HANDLERS) } } });
  assert.deepEqual(
    { ready: (await gateOff.verify()).ready, menuEnabled: (await gateOff.verify()).menuEnabled },
    { ready: false, menuEnabled: false },
  );

  const settingsLinkOnly = runtimeRenderer({
    resources: [url],
    modules: { [url]: { bus: nativeBus(MICRO_HANDLERS) } },
    settingsLink: true,
  });
  assert.equal((await settingsLinkOnly.verify()).ready, true, "a visible Micro settings link counts as enabled");
});

test("Windows updater preserves unproven SSH and cleans only retired same-root bundle files", (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows PowerShell updater fixture requires Windows");
    return;
  }
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./windows-update-fixture.ps1", import.meta.url)),
      "-Repository",
      fileURLToPath(new URL("../", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture passed/);
});
