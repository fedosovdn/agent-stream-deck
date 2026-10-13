# Repository instructions

## Setup and validation

- Use `CONTRIBUTING.md` for setup and required validation commands; `package.json` and the lockfile own dependency requirements and resolved versions.
- For code changes, run the complete automated validation prescribed in `CONTRIBUTING.md`.
- Follow `TESTING.md` when writing, changing, or removing tests.
- Never create branches — always commit and work directly on `main`.
- After building release artifacts, run the release audit prescribed in `CONTRIBUTING.md`.
- Report automated, live-app, and physical-device validation separately. Never describe fixture, compile, build, or package validation as physical-device testing.

## Project invariants

- Develop primarily for Mac and preserve standalone Windows installation, startup, and existing actions. Preserve supported task-source scenarios documented in `README.md` and `docs/ARCHITECTURE.md`, including local OpenCode and saved Fedora SSH connections. Fedora is a chat source, not a Stream Deck plugin platform.
- Do not reintroduce the iPhone application, its infrastructure, or the separate multi-host Codex relay without a separate product decision. Preserve and ignore legacy private settings. Removing other supported functions also requires a separate decision.
- Keep the Codex Chrome DevTools endpoint bound to loopback. Do not expose, forward, or rebind it to a network interface; preserve the authenticated, identity-checked OpenCode SSH path documented in `SECURITY.md`.
- Do not add hotkey or task-database fallbacks to the native bridge without a separate design decision.
- Keep usage actions read-only. Preserve the legacy reset-credit action UUID for existing profiles; consuming credits on press or hold requires a separate product decision.
- Do not commit or distribute proprietary OpenAI or Elgato assets, Codex installation files, databases, logs, rollout files, pairing tokens, personal paths, private runtime state, or generated release bundles.
- Update compatibility notes when renderer integration behavior changes.

See `CONTRIBUTING.md` for the pull-request contract and `SECURITY.md` for the complete security boundary.

Use public `#area` entry points between source areas; follow the import direction in `docs/ARCHITECTURE.md`. Native boundary checks require ordinary ESM imports, including `import type`, rather than inline import types or `require`.

Keep task sources independent of one another. Keep the shared queue independent of I/O and the Stream Deck SDK, and keep the launcher independent of that SDK. Follow `docs/ARCHITECTURE.md` for module responsibilities and integration boundaries.

<!-- x9-performance:start -->
## Performance

Performance notes for this repository live in `docs/maintenance/performance/`.

- Before changing code for speed, memory, load, or cost, read `docs/maintenance/performance/README.md` and the recent entries of `docs/maintenance/performance/journal.md`; do not retry an approach the journal records as rejected without new evidence.
- Keep any wait, retry, or limit that the notes or a code comment mark as a guard, unless the condition it protects is handled another way.
- Claim a performance gain only with before-and-after numbers measured as `docs/maintenance/performance/README.md` describes, and record the attempt in the journal, including reverted ones.
<!-- x9-performance:end -->
