# Changelog

Versions through `0.7.0.2` below are the historical upstream releases by Dazer. Starting with `1.0.0`, releases belong to the xonika9 fork and use its own plugin identity.

## 2.2.0 - 2026-10-14

### Highlights

- Ready local OpenCode and T3 Code tasks now appear and continue updating while another connected environment is slow. Discovery, collection and publication are independent, with bounded concurrency and a reserved next opportunity for waiting local OpenCode work.
- Codex, usage and T3 work no longer block one another's polling. Image delivery is serialized per key and coalesces pending updates, preserving the latest picture and the task captured when a press begins.

### Fixes and performance

- Reuse successfully parsed unchanged Codex session tails, index completion activity once per queue projection, share common OpenCode parent requests within a collection cycle, and avoid repeatedly clearing already-empty key titles.
- Reuse verified macOS installation metadata and generated plugin icons. File replacement, truncation, failed reads and changed build inputs invalidate the relevant caches.
- Concurrent first OpenCode starts share protected credential preparation. Retired source generations and late native-bridge responses cannot overwrite current tasks or confirmations; an index fork copies only committed observations.
- A failed or removed environment drops its stale cards without hiding successful environments. Exact completion confirmations preserve newer results, and key replacement cannot redirect an in-progress press/release pair.

### Build and compatibility

- Distributable plugins use syntax/whitespace compression and source maps without embedded source text; development builds keep full source maps. Debugging a release requires its map and the matching repository revision.
- Launcher archives include the existing author-provided JPEG referenced by both installation guides, reducing archive size. macOS and Windows launcher code remains uncompressed.
- Existing action UUIDs, profiles, read-only usage actions and standalone Windows installation remain supported. T3 collection remains macOS-only; saved Fedora SSH connections remain task sources. Authentication, loopback binding, freshness rules and protective timeouts are preserved.

### Validation

- Local automated macOS validation passed with Node 24.16.0: clean dependency install, lint, import boundaries, types, 297 successful tests with two existing Windows-only skips, plugin validation, packaging, both archive integrity checks, checksums and release artifact auditing.
- Five alternating synthetic comparisons confirmed local task publication during held remote work. A separate saturated-catalog run covered about 92000 synthetic tasks for ten minutes after warmup without retained-memory growth; measurement limitations and failed attempts remain recorded in the performance reports.
- Live macOS validation confirmed refreshing cards and quota in Stream Deck 7.6.0. The maintainer confirmed matching physical-device images and a single read-only quota press without an error indicator on production code `1b2da42`, before the release-only version bump. The final versioned package was not separately tested on hardware. Native Windows application and device validation were not run.

## 2.1.1 - 2026-10-08

### Fixes

- OpenCode SSH tunnels no longer accumulate on the Mac when Stream Deck kills the plugin without a graceful stop. On its first SSH discovery with a successful process listing, the macOS collector terminates only tunnels that were reparented to `launchd`, belong to the current user, and carry exactly the command line it builds for a saved connection with a loopback forward. Tunnels of the running plugin and any other SSH processes are left alone.

### Maintenance

- CI now runs on this repository for every push and pull request on macOS 15 and Windows 2025, with checkout and setup-node pinned to commit SHAs. The Windows job runs the PowerShell watcher and updater tests that local macOS runs skip.
- Tests exercise behavior instead of source text: controller tests use the public API, renderer and launcher expressions execute in `node:vm`, and the property inspector script runs against a fake DOM. Platform-only tests skip with a stated reason; `TESTING.md` records the testing rules.
- Release checksums and the post-checksum audit moved into `scripts/finalize-release.mjs`; the produced `SHA256SUMS.txt` format is unchanged.

### Validation

- Automated macOS validation passed: clean dependency install, lint, import boundaries, type checking, tests (229 passed, two existing platform skips), plugin validation, packaging, archive integrity, checksums, and release artifact audit. GitHub CI passed the same checks on macOS 15 and Windows 2025.
- Live macOS check: an orphaned tunnel with the plugin's exact command line was terminated after a plugin restart, and the new tunnel answered the OpenCode authentication boundary. User-reported: Agent keys, the OpenCode SSH source, and tunnel cleanup after a forced plugin kill work on a physical Stream Deck. Native Windows application and device validation were not run.

## 2.1.0 - 2026-10-05

### Highlights

- Added macOS T3 Code tasks to the Stream Deck queue, including the local app and explicitly connected remote Linux environments over authenticated SSH.
- Simplified the source selector to Codex, OpenCode, T3 Code, and All. Saved Both settings resolve to All; existing action UUIDs and profiles are preserved.
- Added separate read-only T3 pairing sessions, protected credential storage, environment-scoped identities, and independent failure handling. A failed T3 connection drops its stale cards while successful connections remain visible.
- Serialized connection setup so concurrent commands preserve each other's configuration. Renewing the local connection preserves remote connections.

### Compatibility and behavior

- T3 collection is macOS-only. Windows installation and existing actions remain supported; remote Linux hosts supply tasks rather than running the Stream Deck plugin.
- T3 button presses bring T3 Code to the foreground without selecting a specific conversation. Fresh completed/failed results leave the queue when their button is pressed, the result is reported viewed, or five minutes pass; a newer result can return.
- T3 setup requires a separate read-only connection; SSH setup requires a trusted saved host, Python 3, and an already-running remote T3 server. No desktop credential decryption, service startup, relay, or Codex endpoint forwarding is added. See [T3 setup and compatibility](https://github.com/xonika9/agent-stream-deck/blob/v2.1.0/docs/T3CODE_COMPATIBILITY.md).
- The Both selector option is removed. Its stored value is accepted as All, which includes T3 tasks when connected.

### Validation

- Automated macOS validation passed: clean dependency install, lint, import boundaries, type checking, tests (212 passed, two existing platform skips), plugin validation, packaging, archive integrity, checksums, and release artifact audit.
- Live macOS application validation confirmed local and Fedora T3 tasks together, including the previously missing W34 card. T3 button presses on physical Stream Deck hardware and native Windows application/device validation were not run for this release.
- T3 integration was characterized against Nightly 0.0.46-nightly.20261005.2689. Automated SSH cancellation, timeout, oversized-response and cross-environment collision scenarios remain unverified; successful SSH collection was checked live.

## 2.0.0 - 2026-10-05

### Highlights

- Added the macOS Codex, OpenCode, and Both task-source modes, including local OpenCode and authenticated saved Fedora SSH connections. Viewed OpenCode results leave the queue, and new work in the same chat returns.
- Restored current Codex sidebar and full task-catalog integration, omitted stale stopped local tasks, and stabilized task ownership, queue order, and captured press/release behavior.
- Kept all 53 action UUIDs and existing xonika9 profile assignments. The former host selector now reports the local Codex connection; old private relay settings are preserved and ignored.
- Split maintained code into Codex, OpenCode, agent queue, Stream Deck, and usage areas with checked public imports. Updated dependencies, expanded type checking, and added formatting and boundary checks to macOS/Windows CI.
- Made desktop watcher updates preflight their bundles and confirm the new process, lock, and fresh startup receipt. Preserved loopback-only Codex access and identity-checked OpenCode SSH.

### Breaking changes

- Removed the iPhone application, pairing, widgets, mobile infrastructure, and separate multi-host Codex relay. Fedora remains an OpenCode chat source, not a Stream Deck plugin platform.
- Removed paid reset-credit consumption. The legacy reset action remains a read-only counter; pressing or holding it never spends a credit.
- Requires Stream Deck 7.1 or newer and Node.js 24 or newer for development and launchers; the plugin now uses Stream Deck SDK 3.

### Validation and compatibility

- Local macOS clean install, lint, import boundaries, type checking, tests (207 passed, two Windows-only skips), plugin validation, packaging, and artifact auditing passed.
- Live macOS validation used Codex 26.930.31730, Stream Deck 7.6.0, and OpenCode Desktop 2.0.22 with Fedora OpenCode 2.0.21. The maintainer confirmed ordinary physical Stream Deck MK.2 presses for Codex and both OpenCode sources.
- Native Windows application/device validation and rare physical hold/queue-change cases are explicitly deferred. A separate real SSH collector probe verified disconnect/recovery; installed-plugin retention of active local cards during that outage was not observed. CI results are reported separately from live/device acceptance.
- Codex/OpenCode renderer and service integrations still depend on undocumented interfaces. See the compatibility guide and maintenance report for evidence and limitations.

## 1.0.1 - 2026-08-22

- Fixed handling of `turn_aborted` so stopped Codex tasks no longer remain in the Active queue as working.
- Stabilized working-task order around the latest structural user work start instead of incidental selection, title, activity, or snapshot changes.
- Added a stable fallback for tasks without a trusted start event and retained their queue rank across brief disappearance for up to 24 hours.
- Carried optional work-start metadata through relay protocol v1 while preserving compatibility with mixed plugin and launcher versions.
- Updated multi-host compatibility notes, troubleshooting guidance, and queue-order diagnostics.

## 1.0.0 - 2026-08-11

First stable xonika9 release.

### Highlights

- Added an opt-in Active queue that discovers the complete native pinned and unpinned Codex task catalog, ranks attention, completed, and working tasks, omits idle history, keeps up to six useful tasks on agent keys, and renders unused keys black.
- Preserved exact task identity and the captured host across press/release so tasks outside Codex Micro's native six slots can still be opened without a release jumping to a replacement relay host.
- Hardened optional Windows/macOS relay ownership, socket replacement, stale-message rejection, catalog validation, and UTF-8 payload limits so failures degrade to the native six-slot snapshot instead of leaking or misrouting state.
- Updated renderer discovery for current Codex desktop internals, including full-catalog status mapping, temporary-thread identity, title rendering, active-thread detection, and native microphone dispatch.
- Improved Stream Deck title fitting and multiline readability, usage preview assets, local development watching, and release artifact auditing.
- Kept independent Windows-only, macOS-only, and optional authenticated multi-host operation; Chrome DevTools remains loopback-only.

### Install / update

- Release artifacts now include the xonika9 Stream Deck plugin plus separate Windows and macOS launcher archives with SHA-256 checksums.
- Release preparation is cross-platform through `npm run release:prepare`; the macOS launcher archive is still built on macOS to preserve executable modes.

### Compatibility

- Codex integration still depends on undocumented desktop renderer internals. Use the release notes and troubleshooting guide when a later Codex build changes those signals.

### Breaking changes

- The plugin UUID and action UUIDs moved from the upstream `com.simeo.codex-deck` namespace to `com.xonika9.codex-deck`. Stream Deck treats this as a separate plugin, so existing upstream profile assignments are not migrated automatically.

## 0.7.0.2 - 2026-07-22

- Normalize remote snapshot timestamps to local receipt time so ordinary Mac/Windows clock differences cannot hide working, selected, approval, or usage state.
- Reset a stale opposite-platform control target when the plugin starts without a configured second host, while preserving intentional remote targeting during temporary relay outages.
- Keep unique last-known tasks visible when one iPhone node is offline, clearly mark them offline in the app and widgets, and prevent offline agent keys from dispatching commands.
- Prefer the live connection when duplicate iPhone profiles authenticate as the same computer, including command delivery and displayed connection health.
- Added regression coverage for Mac-only, Windows-only, mixed online/offline, duplicate-profile, and cross-host clock-skew behavior.

## 0.7.0.1 - 2026-07-22

- Fixed one cross-host Codex task appearing twice when a new Windows or Mac thread transitioned from its temporary renderer ID to its stable rollout ID.
- Remember resolved temporary thread aliases across later task selections and relay reconnects so mirrored tasks remain de-duplicated.
- Preserve the available title and context usage from either host when the rollout owner temporarily publishes incomplete renderer metadata.
- Reserve `Not assigned` for genuinely empty agent slots; assigned titleless threads now use `New chat` while their native title is pending.
- Keep a neutral context ring visible until a new thread publishes its first token-count event.
- Added bidirectional Windows-to-Mac and Mac-to-Windows regression coverage for task identity, title fallback, selection changes, and reconnects.

## 0.7.0 - 2026-07-21

- Added a source-distributed native SwiftUI iPhone companion that merges authenticated Mac and Windows snapshots while leaving the Stream Deck plugin independent.
- Added pinned-TLS Nearby Wi-Fi pairing and private Tailscale HTTPS profiles without exposing Chrome DevTools or accepting wildcard/public relay listeners.
- Added native task details, command receipts, Attention Center, optional notifications, one-task Live Activity follow mode, five WidgetKit experiences, and app-local key layouts.
- Added circular 5-hour/weekly usage, a two-window overview, optional context rings, and a centered reset-credit action with a deliberate 1.2-second hold.
- Added portable local iOS signing configuration; personal team, bundle, App Group, relay tokens, and official OpenAI keycap artwork remain outside public artifacts.
- Fixed empty iPhone agent keys drawing two misaligned plus symbols.
- Fixed the iPhone dashboard in landscape with a bounded two-column layout instead of stretching the square Micro device across the full screen width.
- Fixed completed, selected, and mirrored tasks retaining stale working/unread colors across Mac and Windows while preserving fresh approval and active-work signals.
- Fixed long-running iPhone relays retaining stale Codex version metadata after an app update; host identity remains stable and no Codex restart is required.
- Updated renderer discovery and active-task detection for Codex macOS `26.715.70719` and Windows `26.715.8383.0` without hardcoding renderer hashes.
- Added physical-iPhone Swift tests, macOS launcher/watcher self-tests, release privacy audits, and expanded relay, renderer, usage, and project regression coverage.
- Added beginner installation, same-Wi-Fi verification, and release documentation plus explicit inspiration credit for the mobile companion concept.

## 0.6.3 - 2026-07-19

- Fix completed tasks remaining stuck in the green finished state after they are opened.
- Track each structural `task_complete` revision instead of comparing rollout modification times, so harmless file touches cannot resurrect an acknowledged completion.
- Detect the task currently open in each Codex renderer even when it is outside that host's six native Micro slots.
- Propagate the content-free active-task and completion-revision signals through the authenticated multi-host relay, allowing a mirrored task opened on either computer to clear correctly.
- Preserve the visible completion transition for a task that was already open while it ran; only a later activation or Stream Deck press acknowledges it.
- Prevent delayed completion metadata from overriding a newer native working/thinking state.

## 0.6.2 - 2026-07-19

- Added explicit per-host `READY`, `DEGRADED`, `CONNECT`, and `OFFLINE` state to the Windows/Mac target key.
- Native-signal failures now emit a typed relay health event instead of leaving an authenticated connection looking healthy.
- Detect stale remote snapshots from local receipt time, independent of clock differences between hosts.
- Preserve last-known task placement during host failures while marking every affected agent tile orange for uncertain native signals or red for an offline relay; commands still fail safely instead of falling through to another host.
- Restored relay smoke-test compatibility after health-only updates were separated from snapshot delivery.
- Route reasoning up/down through Codex's native encoder-rotation HID events, matching the current Micro implementation after a Codex desktop update removed the old command-runner asset.
- Resolve standalone keycap commands from the currently loaded official Micro bridge while retaining compatibility with older Codex builds.

## 0.6.1 - 2026-07-18

- Fixed a macOS restart loop after an unexpected shutdown when an authenticated Windows relay requested a snapshot before the Codex Micro signals were ready.
- The macOS watcher no longer launches Codex while the app is closed, waits for an unbridged process to stabilize, and uses a generation-independent recovery cooldown to prevent PID-to-PID restart loops.
- Added safe relay error handling, rate-limited offline diagnostics, and a dedicated macOS watcher stderr log.
- Fixed macOS Codex updates exposing avatar-overlay renderer targets before the real main window, which could stop relay snapshots and leave an agent key stuck in `working`.
- Fixed remote agent commands for nested `local:client-new-thread:` task identities being rejected by the relay validator.
- Read the live agent-source setting directly from Codex instead of falling back to Recently updated after app updates.
- Added mode-aware combined agent slots for pinned, recent, priority, and individual Codex Micro assignments while preserving native single-host behavior.
- Interleaved pinned Windows and Mac tasks fairly, de-duplicated mirrored task identities, and routed each key to its real owner.
- Defined individual-assignment conflicts: the Stream Deck computer wins a doubly assigned slot, while the other host fills empty slots; duplicate tasks appear only once.
- Normalized additional native `thinking`, `complete`, `completed`, and `done` status names for stable animations and colors.
- Added diagnostics when the two Codex apps use different agent-source modes.
- Fixed explicit release-audit paths and added regression coverage for private runtime-state rejection.
- Kept CDP evaluation promises alive in the renderer to prevent intermittent `Promise was collected` failures on remote agent presses.
- Added a content-free local session-presence catalog so cloud/SSH mirrors are attributed to the computer that owns the rollout even when Codex omits that task from the owner's six native Micro slots.
- Keeps freshly completed owner sessions visible at unread/error priority instead of dropping them behind idle tasks.
- Bounds and validates relay presence catalogs and clears a derived completion state after that task is opened from the deck.

## 0.6.0 - 2026-07-18

- Added the local macOS Codex Micro launcher and persistent LaunchAgent watcher.
- Added an opt-in authenticated SSH/Tailscale relay for mixed Windows/macOS agent slots and native command routing.
- Added a Windows/Mac target action while keeping agent keys bound to each task's originating host.
- Added host badges and stable `(hostId, threadKey)` routing for the six global agent keys.
- Replaced the one-shot Windows-login launcher with a persistent, single-instance bridge watcher.
- Automatically recovers the bridge after Codex updates, crashes, and normal restarts.
- Detects rapid Codex restarts by main-process generation even when no stopped interval is observed.
- Avoids touching a normal Codex session that was already open when the watcher is first installed.
- Removes stale bridge-port files and records bounded diagnostics in `%LOCALAPPDATA%\CodexDeck\watcher.log`.
- Added independent Windows-only and macOS-only operation from the same Stream Deck plugin package.
- Added host-generic task ownership and global recent-activity ordering for mixed Mac/Windows agent keys.
- Restricted relay listeners and clients to loopback or explicit Tailscale addresses and added hidden token entry on Windows.
- Installed the Windows watcher into a durable per-user location instead of depending on the extracted ZIP folder.
- Added separated release archives, checksums, and an automated audit for private state, personal setup markers, and protected keycap SVGs.

## 0.5.0 - 2026-07-17

- The launcher reuses a healthy existing loopback debug session instead of restarting Codex on every run.
- Added `-ForceRestart` for an explicit clean restart path.
- The source launcher can use the built release helper during local development.
- Added standalone native actions for every official single-size Codex Micro keycap; the microphone remains a true press/release action.
- Added live keycap-registry resolution so command mappings follow the installed Codex build instead of being duplicated in the plugin.
- Added readable themed fallbacks when a user-local SVG is unavailable.
- Prevented overlapping bridge polls, redundant Stream Deck image writes, and idle selected-agent animation traffic.
- Multiple copies of the same action now render correctly across pages and profiles.
- Added compatibility with the Codex `26.715.2305.0` renderer event bus and settings exports.
- Kept approval requests and user questions orange for the current `awaiting-approval` and `awaiting-response` Micro states.

## 0.4.1 - 2026-07-17

Initial public release.

- Native six-slot Codex Micro agent synchronization.
- Animated status tiles for idle, working, unread, approval, error, and empty states.
- Native Micro action, joystick, and encoder event dispatch.
- Direct reasoning-effort increase/decrease actions.
- Loopback-only Codex launcher with runtime module discovery.
- Optional local keycap SVG loading; third-party SVG contents are not distributed.
- Removed development database/log fallbacks and legacy hotkey behavior from the public runtime.
