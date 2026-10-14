import { build } from "esbuild";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildOptions } from "./build-options.mjs";

const output = resolve("release/codex-deck-launcher");
const macOutput = resolve("release/codex-deck-launcher-macos");
await rm(output, { recursive: true, force: true });
await rm(macOutput, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(macOutput, { recursive: true });

await build({
  ...buildOptions("windows", process.argv.includes("--release")),
  entryPoints: [resolve("launcher/runtime-override.ts")],
  outfile: resolve(output, "runtime-override.mjs"),
});

// Copy the runtime package from an explicit allowlist. Cloud-sync conflict
// copies (for example `index 3.js`) must never leak into release archives.
const wsSource = resolve("node_modules/ws");
const wsOutput = resolve(output, "node_modules/ws");
await mkdir(resolve(wsOutput, "lib"), { recursive: true });
for (const filename of ["LICENSE", "package.json", "browser.js", "index.js", "wrapper.mjs"]) {
  await cp(resolve(wsSource, filename), resolve(wsOutput, filename));
}
for (const filename of [
  "buffer-util.js",
  "constants.js",
  "event-target.js",
  "extension.js",
  "limiter.js",
  "permessage-deflate.js",
  "receiver.js",
  "sender.js",
  "stream.js",
  "subprotocol.js",
  "validation.js",
  "websocket.js",
  "websocket-server.js",
]) {
  await cp(resolve(wsSource, "lib", filename), resolve(wsOutput, "lib", filename));
}

for (const filename of ["Start Codex Deck.cmd", "Start-CodexDeck.ps1", "Watch-CodexDeck.ps1", "README.txt"]) {
  await cp(resolve("launcher", filename), resolve(output, filename));
}
await copyPublicDocs(output);

await build({
  ...buildOptions("macos", process.argv.includes("--release")),
  entryPoints: [resolve("launcher/macos/codex-deck-macos.ts")],
  outfile: resolve(macOutput, "codex-deck-macos.mjs"),
});

for (const filename of ["start-codex-deck.sh", "Start Codex Deck.command"]) {
  const destination = resolve(macOutput, filename);
  const contents = await readFile(resolve("launcher", filename), "utf8");
  await writeFile(destination, contents.replace(/\r\n/g, "\n"), { encoding: "utf8", mode: 0o755 });
  await chmod(destination, 0o755);
}
await copyPublicDocs(macOutput);

async function copyPublicDocs(destination) {
  await mkdir(resolve(destination, "docs"), { recursive: true });
  for (const filename of [
    "ARCHITECTURE.md",
    "MACOS.md",
    "WINDOWS.md",
    "TROUBLESHOOTING.md",
    "ICON_SETUP.md",
    "OPENCODE_COMPATIBILITY.md",
  ]) {
    await cp(resolve("docs", filename), resolve(destination, "docs", filename));
  }
  await mkdir(resolve(destination, "docs/assets"), { recursive: true });
  for (const filename of [
    "codex-deck-hero.jpg",
    "agent-status-preview.svg",
    "agent-status-preview-dark.svg",
    "usage-controls-preview.svg",
  ]) {
    await cp(resolve("docs/assets", filename), resolve(destination, "docs/assets", filename));
  }
  for (const filename of ["README.ru.md", "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md"]) {
    await cp(resolve(filename), resolve(destination, filename));
  }
}
