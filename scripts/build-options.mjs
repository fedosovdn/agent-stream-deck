/** Shared by the distributable builders and their executable contract tests. */
export function buildOptions(target, release = false) {
  return {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    minify: false,
    ...(release && target === "plugin" ? { minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false } : {}),
    ...(target === "plugin" ? { sourcemap: true, sourcesContent: !release } : {}),
    ...(target === "windows"
      ? { external: ["ws"] }
      : {
          banner: {
            js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
          },
        }),
  };
}
