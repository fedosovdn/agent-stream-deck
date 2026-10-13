# Architecture and security

## Components

The implementation remains one package. `src/plugin.ts` composes the Codex, OpenCode and
T3 Code sources with the Stream Deck controller. Cross-area imports use the
public `#codex`, `#opencode`, `#t3code`, `#agents`, `#stream-deck`, and `#usage` entries.
`agents` owns pure task types, identity, selection, and queue rules; the task
sources do not import each other. OpenCode separates protected discovery, SSH,
authenticated requests, external session data, and process-local revision state.
Only shared state paths and local host identity remain under `src/runtime`.
The launcher imports the SDK-free Codex entry. Its Windows runtime bundles
internal code while retaining the explicitly allowlisted `ws` dependency.

### Launcher

`Start-CodexDeck.ps1` finds the installed Microsoft Store Codex package. If a healthy debug-enabled Codex process already exists, it reuses its loopback port. Starting an already-running normal session requires an explicit launcher/recovery path; a read-only `-DryRun` never changes it. The launcher chooses an unused loopback port, writes it to `%LOCALAPPDATA%\CodexDeck\codex-micro-bridge.json`, and starts `ChatGPT.exe` with:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=<random-port>
```

The bundled runtime helper connects to that renderer and enables the Micro feature state for the current session. It discovers the versioned `persisted-signal-*` asset dynamically; no asset hash is hardcoded.

The launcher does not edit the Codex installation, Codex LevelDB, task database, rollout files, or logs.

When startup monitoring is installed, a durable copy under `%LOCALAPPDATA%\CodexDeck\launcher` runs `Watch-CodexDeck.ps1` as
a single hidden PowerShell process. It dynamically resolves the newest Codex
Microsoft Store package on every check, so an app update can change the install
path without invalidating the watcher. A named mutex prevents duplicates.

The watcher follows three safety rules:

1. A healthy debug-enabled Codex session is reused and never restarted.
2. A normal session that was already open when monitoring was installed is left untouched until its next normal restart.
3. A later Codex launch, update restart, or crash recovery without the required loopback port receives at most one recovery restart for that process generation.

Stale port metadata is removed automatically. The bounded watcher log lives at
`%LOCALAPPDATA%\CodexDeck\watcher.log`.

On macOS, the launcher discovers the running or installed app by its signed
bundle metadata, reads `CFBundleExecutable`, and launches the app bundle through
LaunchServices with the same loopback-only debugging arguments. The per-user
LaunchAgent watcher stores a main-process generation (PID, start time, and
executable path), reuses healthy bridges, and performs at most one graceful
recovery restart for a later stable unbridged generation. It never launches a
closed Codex app. A generation-independent cooldown prevents a failed recovery
from becoming a PID-to-PID restart loop, even if LaunchServices immediately
creates another process. The generation and recovery policy is persisted
atomically and guarded by a PID-directory lock. LaunchAgent stderr is retained
separately from the bounded watcher log for post-crash diagnosis.

Both platforms persist a stable `hostId`, `hostName`, and platform identifier.
The local queue uses that identity. Old Codex relay settings and private tokens are ignored without rewriting or deleting them.

### Stream Deck plugin

The same plugin runs on Windows and macOS. It discovers the local loopback port from the platform state file or from a running Codex process. It then uses Chrome DevTools Protocol `Runtime.evaluate` calls to:

1. discover the current version-hashed Codex renderer modules;
2. announce a connected Micro device state;
3. read the mandatory native six-slot state, layout, agent source, and lighting preference, then optionally discover the bounded native pinned + unpinned sidebar catalog;
4. dispatch Micro HID and joystick events;
5. emulate native encoder-rotation HID events for reasoning-effort changes;
6. resolve standalone keycap actions from Codex's live Micro keycap registry and current official command runner;
7. read Codex's renderer-owned `rate-limit-status` query and normalize its current 5-hour, weekly, and reset-credit state.

On newer Codex builds, the native Micro pinned atom can retain an older list.
Pinned mode reads the current sidebar rows in display order, including their
live status, and dispatches their exact thread identities rather than relying
on native slot order. The last observed pinned list is retained while rows are
collapsed, with cached selection flags cleared to prevent falsely acknowledging
a completed task after switching chats. A verified empty semantic pin list
clears that cache after the final pin is removed. Older builds fall back to native slots. Other source modes retain
native Micro slots, and full active-catalog discovery still uses the original
native slots before the pinned display override. Active chat detection prefers
the selected sidebar identity and only considers visible composers.
The launcher also discovers the native event bus in `app-shared` chunks.

This integration is adapted from crunchy234's
[`ed6c97e`](https://github.com/crunchy234/codex-stream-deck/commit/ed6c97e4a608d72b5f897f9e5963c27ed363f08a),
while preserving strict host identity matching in this fork.

The bridge does not emulate a USB HID device and installs no driver.

For the characterized macOS OpenCode setup, the plugin starts a separate
collector only when the global Agent source is `OpenCode` or `All`. It discovers
the managed local service from its user-owned loopback registration and saved SSH
connections from `opencode.settings`. SSH uses non-interactive authentication and
a temporary loopback forward. On macOS, a tunnel left by an earlier plugin process killed
before its graceful stop is terminated on the first SSH discovery with a
successful process listing when it was reparented to init, belongs to the
current user, and matches exactly the command line the collector builds for a
currently saved connection. If a CLI-managed remote service has no registration
file, bounded `opencode pair` and authenticated `opencode api` output supply the
same private registration inside the adapter. Compatibility is decided from the
authenticated identity and bounded API shapes rather than an exact version. The adapter publishes only opaque identities,
content-free labels, normalized state, and bounded timestamps. It does not open
OpenCode SQLite, invoke WSL, launch a stopped service, or expose connection and
task content.

### Active queue projection

`Active queue` is a plugin display option shared by all six Agent actions on one
computer. An absent or false setting leaves the current native local agent-source result unchanged. When enabled outside
`custom`, the controller reads the local authoritative native pinned +
unpinned sidebar catalog, resolves trusted conversation mirrors and ownership,
and only then projects at most six display positions. An absent catalog falls
back locally to its six Micro slots; an authoritative empty catalog remains
empty. `custom` keeps its six configured candidates instead of expanding to the
full catalog; the projection may still compact relevant candidates within that set.

The sidebar reader supports both the legacy attention/recency maps and the
split sidebar structure characterized on macOS with Codex `26.930.31730`.
For the split structure it reads full task summaries, including canonical
conversation IDs, runtime status, unread state, titles, and recency. Lightweight
navigation metadata is not a task-state source. Native Micro slots retain status
priority, and a versioned resolver cache prevents an older plugin's discovery
failure from surviving a plugin update. Windows behavior retains
the legacy path; this newer renderer shape has only been checked live on macOS.

The global task-source selector runs before this projection. `Codex` preserves
the saved Active queue preference; `OpenCode`, `T3 Code`, and `All` force the projection
without overwriting that preference. OpenCode candidates use the same
attention/completion/working groups but keep case-sensitive opaque identities
and never receive a context ring. An OpenCode key-down foregrounds OpenCode
Desktop and acknowledges the exact currently displayed terminal revision in the
collector's process-local state; key-up is intentionally a no-op. After local
removal, the collector best-effort publishes the same revision through
OpenCode's authenticated `session.view` route. Unsupported routes and transport
failures leave the local acknowledgement intact. A later terminal timestamp
clears that acknowledgement and becomes visible again. No viewed state or raw
OpenCode connection material is written to a relay. Terminal history older than
five minutes at first observation is treated as the startup baseline and is not
backfilled. Once a newer successful or failed terminal result is admitted, it
remains until source-viewed, locally acknowledged, or five minutes have elapsed
from its normalized terminal event; polling may delay removal by up to one cycle.

The projection drops `idle`, `off`, and unknown states, then compacts candidates
into display positions zero through five. Attention and error states sort first;
completion and unread states use oldest available activity first; working states
use the latest trustworthy user-start event. Session ownership recognizes only a
structural JSONL record with `type === "event_msg"` and
`payload.type === "user_message"`, and reads only its type, timestamp, and byte
offset. The message field is not read. Its timestamp becomes `workStartedAt` and
its byte offset becomes the monotonic `workStartRevision`; background reasoning,
tool and assistant output, title or selection changes, renderer activity, and
snapshot refreshes remain general activity and do not change working rank.

The ownership reader still scans directories and checks file metadata on each
scheduled refresh. It reuses only successful parsed tails whose device, inode,
size, modification time, and metadata-change time remain unchanged, retaining at
most 512 normalized records without file contents. File changes, replacement,
removal, short reads, and errors prevent reuse; completion freshness is evaluated
against the current time even when parsing is reused.

The long-lived controller owns an in-memory queue epoch. A trustworthy start is
ranked once after clock normalization; repeated or lower revisions remain fixed,
while a higher revision from the task's current exact owner moves it to the front
of the working group. A task without a trustworthy start receives a stable
queue-local fallback. First observing an already-working task only seeds that
fallback and never fabricates a start time; a later observed idle/completion to
working transition may raise it within the unknown-start tier. Known starts sort
ahead of unknown starts. Disappeared identities remain for 24 hours, while
disabling and re-enabling Active queue or restarting the process clears the epoch.
Display positions may therefore change only for these defined transitions, but
commands keep the exact host-local thread key, native transport-slot hint, and
owning host. Pinned and unpinned tasks share the full catalog in this view.

A missing projected task renders as a black no-op key while the relevant host is
healthy. Connecting, degraded, and offline states continue through the normal
diagnostic rendering path. Completion freshness remains bounded by the existing
upstream structural-event window and acknowledgement behavior: the projection
adds no task database, durable queue, or restart persistence.

Local snapshot activity, exact task identity, and timestamps live in `src/agents/local-state.ts`, independently of network transport. Only a trusted local rollout owner contributes the atomic `workStartedAt` / `workStartRevision` pair; temporary task aliases do not borrow it. Agent key-down saves the exact assignment or empty position by action context. Queue changes and duplicate instances of the same slot cannot change the corresponding release. Press and release are serialized per action context, so a delayed native refresh cannot send release first; other buttons remain independent. Disappearance cancels that context's pending work. Reasoning holds also keep their own context and generation, retaining the initial 500 ms and subsequent 300 ms repeat intervals.


Usage data remains local and account-scoped. On macOS, quota windows come from the newest valid CodexBar `widget-snapshot.json` Codex entry and expire after five minutes; this path does not start or attach Codex Desktop and does not fall back to renderer quota from another host. Reset-credit counters may still be overlaid from an already-attached local Codex bridge. Windows retains the local renderer-owned usage query. Window identity is derived from duration rather than primary/secondary ordering. A missing 5-hour window is unavailable, and Automatic mode falls back to weekly. Usage controls display and fill the consumed percentage while retaining warning colors derived from remaining capacity. Without a renderer theme, usage controls use the same light fallback as OpenCode Agent keys.

Usage controls are read-only. The legacy reset-credit action UUID remains registered so existing profiles keep their counter, but it has no key handlers or credit-consumption bridge method. Neither a press nor a hold can spend a credit. This supersedes the former 1.2-second hold behavior by explicit maintainer decision.

### Local connection status

The existing `host-toggle` action keeps its UUID for saved profiles. It displays the local platform and connection health; pressing it redraws that status without changing the target. Every Codex command executes through the local native bridge. The watcher has no Codex relay listener or managed relay SSH tunnel. Saved OpenCode SSH connections stay with the OpenCode collector and retain their authenticated loopback path.

An installed watcher is a copied runtime. Reinstall the matching new launcher to replace it; a source build alone does not update or stop the old installed process. Stable host identity, user icons, and legacy private files remain preserved.

### Rendering

Agent keys are original deterministic SVGs generated in memory from task title and state. The status palette is:

| Native state | Display |
|---|---|
| `off` | dark / unassigned |
| `idle` | white |
| `working` | saturated blue animation |
| `unread` | green completion |
| `approval` | orange pause/input |
| `error` | red error |

When Codex exposes token usage for a task, an optional top-right ring shows the
latest context-window percentage. Orange begins at 80% and red at 92%. Select
any Agent key in Stream Deck's property inspector to show or hide this ring
globally for all six agent keys on that computer. The setting is independent on
Windows and macOS and does not stop context metadata from syncing.

The upper-left position is reserved for the task-state mark. If host health is
not ready, the host-health mark replaces it so the two signals do not overlap.

The renderer derives the active Codex appearance from explicit theme tokens when available and falls back to the computed renderer surface luminance. Dark mode uses layered charcoal surfaces rather than pure black, with off-white text and slightly lifted status colors for the Stream Deck display.

Official Codex Micro keycap SVG contents are not part of the source or release. Optional user-local files are loaded from `%LOCALAPPDATA%\CodexDeck\icons` on Windows or `~/Library/Application Support/CodexDeck/icons` on macOS and wrapped in the project's neutral key surface at runtime.

The controller uses non-overlapping self-scheduled refreshes and caches the last
image sent to each action instance. Unchanged keys therefore produce no repeated
USB image writes. Animated frames are limited to working and approval states.

## Trust boundary

CDP provides privileged access to the Codex renderer. Binding to `127.0.0.1` prevents direct access from another machine, but not from another process running as the same local user. Treat the launcher-started session like any other local debugging session:

- do not run untrusted software at the same time;
- do not change the debug address to `0.0.0.0`;
- do not forward the port;
- close Codex when the bridge is no longer needed.

## Data flow

Codex Deck has no Codex relay server, analytics endpoint, or update service. Runtime data stays between Stream Deck, the local plugin, the local Codex renderer, and selected OpenCode services. OpenCode's existing SSH path may reach saved Fedora connections through an authenticated temporary loopback forward. Endpoints, targets, credentials, messages, locations, and permission/form content remain inside that adapter and are not logged or rendered. A bounded, sanitized OpenCode task title flows only into the same-process local Stream Deck renderer. No old relay token or private runtime state belongs in a release.

## Compatibility boundary

This is not a public Codex extension API. Export names, internal commands, or event shapes can change. The code avoids fixed bundle hashes where possible, but semantic changes still require a release update.


The source-separation update preserves the characterized renderer shapes and
native event families above. Automatic fixtures verify press/release ordering,
finite HTTP/WebSocket/CDP budgets, and disposal of unsuccessful connection
attempts, including a peer that never completes a close handshake. They do not
add a newly verified live Codex version or replace application/device acceptance.

Launcher updates validate their complete autonomous runtime before replacing the owned watcher. Startup acknowledgement belongs to the newly launched process; a historical log line is insufficient. Windows recovery reserves a global ten-minute cooldown before attempting a restart and retains it on failure.

T3 Code is an independent macOS source under `src/t3code`, using the local V2
HTTP shell and separately paired read-only sessions. Explicitly configured remote
Linux environments are polled through strict non-interactive SSH; they use their
own loopback shell and retain environment-scoped task identities. The selector offers each source separately
and `All` for all three; legacy `Both` settings resolve to `All`. Its opaque task identities are isolated
from Codex conversation mirrors. See [T3 Code compatibility](T3CODE_COMPATIBILITY.md)
for setup, queue acknowledgement, limits and validation boundaries.
