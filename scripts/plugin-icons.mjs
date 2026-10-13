import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const filenames = ["plugin-icon.png", "plugin-icon@2x.png"];
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export async function ensurePluginIcons(root = process.cwd()) {
  // The drawing module currently has only Node builtin imports and no assets.
  const sourcePath = resolve(root, "scripts/generate-plugin-icons.mjs");
  const source = readFileSync(sourcePath);
  const fingerprint = sha256(
    Buffer.concat([source, Buffer.from(`${process.versions.node}\0${process.versions.zlib}`)]),
  );
  // Outside the package root and watch roots; reconstructed whenever absent.
  const markerPath = resolve(root, "dist/.plugin-icons-cache.json");
  const outputHashes = () => filenames.map((name) => sha256(readFileSync(resolve(root, "static/imgs", name))));
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      marker.version === 1 &&
      marker.fingerprint === fingerprint &&
      Array.isArray(marker.outputs) &&
      marker.outputs.length === filenames.length
    ) {
      const hashes = outputHashes();
      if (hashes.every((hash, index) => marker.outputs?.[index] === hash)) return;
    }
  } catch {
    // Missing, damaged or inaccessible helper data is a cache miss.
  }
  try {
    rmSync(markerPath, { force: true });
  } catch {
    // Mandatory image writes still run when the helper cache is unavailable.
  }
  // A content-specific URL avoids executing an older cached module after edits.
  const generatorUrl = pathToFileURL(sourcePath);
  generatorUrl.searchParams.set("source", sha256(source));
  const { generatePluginIcons } = await import(generatorUrl.href);
  generatePluginIcons(root);
  // Never stamp images if the source changed while it was being loaded/run.
  if (!readFileSync(sourcePath).equals(source)) return;
  const outputs = outputHashes();
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ version: 1, fingerprint, outputs }));
  } catch {
    // This optimization must not fail an otherwise valid image generation.
  }
}
