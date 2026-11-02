import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildModuleDiscoveryExpression } from "../src/codex/module-discovery.js";

function renderer(sources: Record<string, string>, initial = ["app://-/assets/index-abc.js"]) {
  const requested: string[] = [];
  const context = {
    URL,
    AbortSignal,
    Symbol,
    Set,
    document: { baseURI: "app://-/index.html", querySelectorAll: () => initial.map((href) => ({ href })) },
    performance: { getEntriesByType: () => [] },
    fetch: async (url: string) => {
      requested.push(url);
      if (!(url in sources)) throw new Error("Unexpected fetch");
      return { ok: true, text: async () => sources[url] };
    },
  };
  return { requested, run: () => runInNewContext(buildModuleDiscoveryExpression(), context) as Promise<string[]> };
}

test("Micro discovery follows bootstrap dependencies when resource timings omit lazy modules", async () => {
  const fixture = renderer({
    "app://-/assets/index-abc.js": 'import "./app-main-abc.js";',
    "app://-/assets/app-main-abc.js": 'import "./app-runtime-abc.js";',
    "app://-/assets/app-runtime-abc.js": 'import "./app-primary-abc.js";',
    "app://-/assets/app-primary-abc.js": 'const deps=["./codex-micro-slot-signals-abc.js"];',
  });
  const urls = await fixture.run();
  assert.equal(urls.includes("app://-/assets/codex-micro-slot-signals-abc.js"), true);
  assert.equal(fixture.requested.length, 4);
  await fixture.run();
  assert.equal(fixture.requested.length, 4);
});

test("Micro discovery keeps the already-loaded fast path without fetching", async () => {
  const fixture = renderer({}, ["app://-/assets/codex-micro-slot-signals-abc.js"]);
  assert.equal((await fixture.run()).length, 1);
  assert.equal(fixture.requested.length, 0);
});

test("failed discovery is retried and does not follow foreign hosts or unrelated modules", async () => {
  const sources = {
    "app://-/assets/index-abc.js":
      'import "https://foreign.example/assets/app-main-abc.js"; import "./unrelated-abc.js";',
  };
  const fixture = renderer(sources);
  await assert.rejects(fixture.run(), /absent from the renderer dependency graph/);
  sources["app://-/assets/index-abc.js"] = 'import "./codex-micro-slot-signals-abc.js";';
  assert.equal((await fixture.run()).includes("app://-/assets/codex-micro-slot-signals-abc.js"), true);
  assert.equal(fixture.requested.length, 2);
});
