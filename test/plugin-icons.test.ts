import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ensurePluginIcons } from "../scripts/plugin-icons.mjs";

const expected = {
  "plugin-icon.png": "6d2ae235e40a5f8923661f59ecccba320aafe57a652d0ea6ccd9366a3fdf596b",
  "plugin-icon@2x.png": "64b380818556a74cd1e3ae80b052e312f0872db13346fed1a29686520af536fa",
};

async function assertImages(root: string) {
  for (const [name, hash] of Object.entries(expected)) {
    const data = await readFile(resolve(root, "static/imgs", name));
    assert.equal(createHash("sha256").update(data).digest("hex"), hash);
    assert.equal(data.readUInt32BE(16), name.includes("@2x") ? 512 : 256);
    assert.equal(data.readUInt32BE(20), name.includes("@2x") ? 512 : 256);
  }
}

test("standalone generator preserves the original PNG bytes and dimensions", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "plugin-icons-"));
  try {
    await cp(resolve("scripts/generate-plugin-icons.mjs"), resolve(root, "generator.mjs"));
    execFileSync(process.execPath, [resolve(root, "generator.mjs")], { cwd: root });
    await assertImages(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(resolve(tmpdir(), "plugin-icons-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "scripts"));
  await cp(resolve("scripts/generate-plugin-icons.mjs"), resolve(root, "scripts/generate-plugin-icons.mjs"));
  return root;
}

async function ageImages(root: string) {
  for (const name of Object.keys(expected)) {
    await utimes(resolve(root, "static/imgs", name), 1000, 1000);
  }
}

async function assertRewritten(root: string) {
  for (const name of Object.keys(expected)) {
    assert.notEqual((await stat(resolve(root, "static/imgs", name))).mtimeMs, 1_000_000);
  }
}

test("unchanged validated inputs and both outputs avoid rewriting images", async (t) => {
  const root = await fixture(t);
  await ensurePluginIcons(root);
  await assertImages(root);
  await ageImages(root);
  await ensurePluginIcons(root);
  for (const name of Object.keys(expected)) {
    assert.equal((await stat(resolve(root, "static/imgs", name))).mtimeMs, 1_000_000);
  }
});

test("missing, truncated or tampered image restores both outputs", async (t) => {
  const root = await fixture(t);
  await ensurePluginIcons(root);
  for (const name of Object.keys(expected)) {
    for (const damage of ["missing", "truncated", "tampered"]) {
      await ageImages(root);
      const path = resolve(root, "static/imgs", name);
      if (damage === "missing") await rm(path);
      else {
        const bytes = await readFile(path);
        if (damage === "tampered") bytes[bytes.length - 1] = 0;
        await writeFile(path, damage === "truncated" ? bytes.subarray(0, 20) : bytes);
      }
      await ensurePluginIcons(root);
      await assertImages(root);
      await assertRewritten(root);
    }
  }
});

test("missing or damaged marker forces regeneration", async (t) => {
  const root = await fixture(t);
  await ensurePluginIcons(root);
  const marker = resolve(root, "dist/.plugin-icons-cache.json");
  for (const damage of ["missing", "json", "schema", "outputs"]) {
    await ageImages(root);
    if (damage === "missing") await rm(marker);
    else if (damage === "json") await writeFile(marker, "{");
    else {
      const data = JSON.parse(await readFile(marker, "utf8"));
      if (damage === "outputs") data.outputs = {};
      else data.version = 0;
      await writeFile(marker, JSON.stringify(data));
    }
    await ensurePluginIcons(root);
    await assertImages(root);
    await assertRewritten(root);
  }
});

test("edited drawing code executes fresh code in the same helper process", async (t) => {
  const root = await fixture(t);
  await ensurePluginIcons(root);
  const generator = resolve(root, "scripts/generate-plugin-icons.mjs");
  const source = await readFile(generator, "utf8");
  // Change an actual drawing input in the temporary executed module.
  await writeFile(generator, source.replace("let red = 45", "let red = 46"));
  await ensurePluginIcons(root);
  const image = await readFile(resolve(root, "static/imgs/plugin-icon.png"));
  assert.notEqual(createHash("sha256").update(image).digest("hex"), expected["plugin-icon.png"]);
  await writeFile(generator, source);
  await ensurePluginIcons(root);
  await assertImages(root);
});

test("mandatory partial image write failure propagates without a valid marker", async (t) => {
  const root = await fixture(t);
  await ensurePluginIcons(root);
  const image = resolve(root, "static/imgs/plugin-icon@2x.png");
  await rm(image);
  await mkdir(image);
  await assert.rejects(ensurePluginIcons(root), (error: NodeJS.ErrnoException) =>
    ["EISDIR", "EPERM", "EACCES"].includes(error.code ?? ""),
  );
  await assert.rejects(stat(resolve(root, "dist/.plugin-icons-cache.json")), { code: "ENOENT" });
  await rm(image, { recursive: true });
  await ensurePluginIcons(root);
  await assertImages(root);
});

test("an unavailable helper cache does not fail valid mandatory image writes", async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, "dist"), "a file instead of a cache directory");
  await ensurePluginIcons(root);
  await assertImages(root);
  await ageImages(root);
  await ensurePluginIcons(root);
  await assertRewritten(root);
});

test("full build reuses images and copies them after clearing the package root", async (t) => {
  const root = await fixture(t);
  for (const name of ["src", "static", "scripts"]) {
    await cp(resolve(name), resolve(root, name), { recursive: true });
  }
  await cp(resolve("package.json"), resolve(root, "package.json"));
  await symlink(resolve("node_modules"), resolve(root, "node_modules"), "junction");
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root });
  const output = resolve(root, "dist/com.xonika9.codex-deck.sdPlugin");
  await writeFile(resolve(output, "stale.txt"), "stale");
  await ageImages(root);
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root });
  await assert.rejects(stat(resolve(output, "stale.txt")), { code: "ENOENT" });
  for (const [name, hash] of Object.entries(expected)) {
    assert.equal((await stat(resolve(root, "static/imgs", name))).mtimeMs, 1_000_000);
    assert.equal(
      createHash("sha256")
        .update(await readFile(resolve(output, "static/imgs", name)))
        .digest("hex"),
      hash,
    );
  }
  await assert.rejects(stat(resolve(output, ".plugin-icons-cache.json")), { code: "ENOENT" });
  await rm(resolve(root, "dist/.plugin-icons-cache.json"));
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root });
  await assertImages(root);
});

test("a changed Node or zlib environment invalidates the existing marker", async (t) => {
  const root = await fixture(t);
  await cp(resolve("scripts/plugin-icons.mjs"), resolve(root, "scripts/plugin-icons.mjs"));
  await ensurePluginIcons(root);
  for (const key of ["node", "zlib"]) {
    await ageImages(root);
    const program = `Object.defineProperty(process.versions, ${JSON.stringify(key)}, {value: "other-environment"});
      const {ensurePluginIcons} = await import("./scripts/plugin-icons.mjs"); await ensurePluginIcons();`;
    execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: root });
    await assertImages(root);
    await assertRewritten(root);
    await ageImages(root);
    await ensurePluginIcons(root);
    await assertRewritten(root);
  }
});
