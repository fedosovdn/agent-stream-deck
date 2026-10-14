<p align="center">
  <img src="docs/assets/codex-deck-hero.jpg" alt="" width="100%">
</p>

<p align="center">
  Language: <strong>English</strong> · <a href="README.ru.md">Русский</a>
</p>

# Agent Deck

[![CI workflow status](https://github.com/xonika9/agent-stream-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/xonika9/agent-stream-deck/actions/workflows/ci.yml)

Agent Deck brings Codex, OpenCode, and T3 Code tasks together on an Elgato Stream Deck. On macOS, six dynamic keys show tasks from one source or all three; Windows retains the local Codex integration. Codex also supports native Micro controls for task selection, actions, navigation, and reasoning effort. OpenCode and T3 Code keys show task status and bring their application to the foreground.

This repository is a fork and continuation of [dazer1234/codex-stream-deck](https://github.com/dazer1234/codex-stream-deck). Current development and releases are maintained by [xonika9](https://github.com/xonika9).

> I share field notes on AI models and developer tools in [Controlled hallucinations](https://t.me/+DOZWlhI4r4EyYjgy), a Russian-language Telegram channel.

> [!IMPORTANT]
> This is an independent community project. It is not made, supported, or endorsed by OpenAI or Elgato. It uses undocumented Codex desktop internals and may need an update after a Codex release.

![Six public agent-tile states in Codex-aligned dark mode](docs/assets/agent-status-preview-dark.svg)

## Choose your setup

The same Stream Deck plugin package works on both platforms. Install only the launcher and configuration needed for your setup.

| Setup | Stream Deck software | Task sources | Guide |
| --- | --- | --- | --- |
| Windows only | Windows | Local Windows Codex | [Windows setup](docs/WINDOWS.md) |
| Mac only | macOS | Local Codex, OpenCode, T3 Code | [macOS setup](docs/MACOS.md) |

Codex runs locally on each platform. macOS also supports local OpenCode and T3 Code tasks, plus remote Linux tasks through saved SSH connections. Separate Codex relay operation has been removed.

## Task sources and controls

Choose the global source in any **Agent** action's Stream Deck property inspector: `Codex`, `OpenCode`, `T3 Code`, or `All`. `All` combines all three; saved `Both` settings resolve to `All`. Selecting OpenCode, T3 Code, or All enables **Active queue** while preserving the saved Codex-only preference.

| Source | Setup | What a task key does |
| --- | --- | --- |
| Codex | Local launcher: [macOS](docs/MACOS.md) or [Windows](docs/WINDOWS.md) | Selects the task through the native Codex integration. |
| OpenCode | macOS Desktop local service or saved SSH connection: [compatibility](docs/OPENCODE_COMPATIBILITY.md) | Brings OpenCode Desktop forward; does not select a specific conversation. |
| T3 Code | Separate read-only connection to the local server or a running remote Linux server over SSH: [setup and compatibility](docs/T3CODE_COMPATIBILITY.md) | Brings T3 Code forward; does not select a specific conversation. |

For OpenCode and T3 Code, fresh completed or failed results leave the queue after five minutes, when the source reports them viewed, or when their key is pressed. A newer result from the same conversation can appear again. T3 acknowledgements remain local to the plugin; OpenCode also attempts to report the result viewed through its supported API.

T3 setup runs from a source checkout with Node.js 24 or newer and `npm ci`. It creates a separate read-only session; follow the [connection guide](docs/T3CODE_COMPATIBILITY.md) for local pairing or `npm run connect:t3:ssh -- <ssh-alias>`. The installed plugin then polls without a checkout process running. Native Micro action, joystick, encoder, reasoning, and new-task controls apply to Codex.

## Requirements

- The desktop application for your selected task source; Codex desktop is required for native Codex controls.
- Elgato Stream Deck 7.1 or newer on the computer connected to the Stream Deck.
- Node.js 24 or newer for the platform launcher.
- Windows 10+ or macOS 13+.
- Historical hardware testing: standard 15-key Stream Deck MK.2. Check each release for separate automated, live-app, and physical-device validation results.

Other Stream Deck models may work, but the included layout and physical-device testing target the normal 5×3 MK.2.

## Quick install

> [!NOTE]
> Download the plugin and launcher archives from the [releases page](https://github.com/xonika9/agent-stream-deck/releases). Contributors can build the source with the commands in [Build and release validation](#build-and-release-validation).

1. Download `com.xonika9.codex-deck.streamDeckPlugin` from the matching xonika9 release and open it on the computer running Stream Deck.
2. Download only the launcher for that computer:
   - Windows: `codex-deck-launcher-windows-vX.Y.Z.zip`
   - macOS: `codex-deck-launcher-macos-vX.Y.Z.zip`
3. Follow [Windows](docs/WINDOWS.md) or [macOS](docs/MACOS.md).
4. Choose the task source in an **Agent** action's Stream Deck property inspector. For native Codex controls, configure agent assignments, actions, joystick, and encoder behavior in **Codex Settings > Codex Micro**.
5. Build the two Stream Deck pages below.

The Agent Deck name is used in this README; released package filenames, plugin/action UUIDs, and local data directories retain their existing Codex Deck identifiers.


> [!WARNING]
> The xonika9 fork uses the new plugin UUID `com.xonika9.codex-deck`. Stream Deck treats it as a different plugin from upstream `com.simeo.codex-deck`: existing actions, per-action settings, and global plugin settings are not migrated automatically. Save or export your profiles, install only one variant at a time, rebuild both pages with the new actions, and then remove the old plugin. Local Agent Deck host, legacy private relay, and icon data remain in the existing platform data directory; the macOS watcher intentionally keeps its established `com.simeo.codex-deck.watcher` service label.

## Features

- Six dynamic agent keys with a global **Codex**, **OpenCode**, **T3 Code**, or **All** task source.
- Optional global **Active queue** for all six Agent actions on one computer; it is off by default.
- Live idle, working, unread completion, approval/input, error, and empty states.
- Codex-aligned light and dark rendering with restrained status animation.
- Native key-down/key-up handling for Micro slots `ACT06` through `ACT12`.
- Native joystick up, right, down, left, and encoder click.
- Dedicated reasoning-effort up/down buttons with press-and-hold repeat.
- Live usage controls: a configurable circular 5-hour/weekly limit key and a two-window overview.
- A read-only reset-credit counter; pressing or holding never consumes credits.
- A local `codex://threads/new` action for a new task.
- Standalone actions for all official single-size keycaps, resolved from the installed Codex build at runtime.
- Optional local loading of official keycap SVGs; those protected files are never included in this repository or its releases.
- Local connection status on the existing host key; pressing it redraws the local status without selecting another computer.

### Active queue

Enable **Active queue** in any Agent action's property inspector to compact relevant tasks into the first Agent keys. The setting applies globally to Agent 1–6 on that computer and defaults to off. It draws from Codex's native pinned and unpinned sidebar catalog: attention and error tasks come first, completion/unread tasks keep their existing FIFO ordering when activity times are available, and working tasks are ordered by the latest user message that started work. Opening or selecting a task, changing its title, background reasoning or tool work, assistant output, renderer activity, and ordinary refreshes do not reorder working keys. A later user message moves a continuously working task forward.

Agent Deck derives that working-order signal only from the type, timestamp, and byte offset of a structural `event_msg` whose `payload.type` is `user_message`; it does not read the message text. If that record is unavailable—for example after a cold start, or outside the bounded 512 KiB session tail—the task receives a stable queue-local fallback instead of a fabricated start time. Known starts sort ahead of unknown starts. The fallback lasts only for the current enabled queue epoch: disabling and re-enabling Active queue or restarting the plugin starts a new epoch, while temporarily disappeared entries are retained for 24 hours. Idle and off tasks are hidden, the remaining positions close up without gaps, and the displayed queue remains capped at six.

If the renderer's full catalog is temporarily unavailable or incompatible, Active queue fails closed to the existing six native Micro slots without taking the normal snapshot offline. A healthy black position is unassigned and does nothing when pressed. Connecting, degraded, and offline diagnostics remain visible.

On a profile with N Agent buttons, place logical **Agent 1** through **Agent N** next to each other in order. Idle chats cannot be opened from those buttons while the queue is enabled. Pinned and unpinned tasks participate in the full native catalog; **custom** deliberately keeps only its six configured candidates, and the queue may still compact the relevant ones. Disable Active queue to restore the exact existing local agent-source layout.

Selecting **OpenCode**, **T3 Code**, or **All** forces Active queue while preserving the saved Codex-only preference. The characterized OpenCode path covers OpenCode Desktop on macOS, historically characterized against `2.0.5` and `2.0.10`: its managed local service and saved non-interactive SSH connections. Later versions remain available when their protected registration, authenticated identity through `/api/info` or legacy `/api/status`, and bounded API response shapes still match; incompatible capabilities fail closed per connection. A bounded, sanitized task title is shown only by the local Stream Deck renderer, with a stable `OpenCode N` alias as its fallback; titles never enter logs. Locations, messages, connection targets, and credentials are neither rendered nor logged. Successful completions and failed tasks remain visible for up to five minutes after their terminal event unless OpenCode reports them viewed or their Stream Deck key is pressed first. Older terminal history is not backfilled. Pressing an OpenCode key also brings OpenCode Desktop forward, removes that exact result locally, and best-effort publishes the same terminal revision through OpenCode's official session-view route; unsupported versions retain the local fallback. A later result from the same chat appears again. WSL and saved HTTP connections are not part of this first integration.

## Recommended 15-key layout

This is the actual polished two-page layout used for the MK.2. It keeps the six live agents on the main page and puts lower-frequency navigation/reasoning controls on page 2.

> This layout is only a recommendation and a practical starting point. Every action, position, page, and profile can be customized freely to match your own workflow; Agent Deck does not require this exact arrangement.

### Page 1 — agents and daily actions

| Agent 1                 | Agent 2           | Agent 3                | Agent 4                 | Agent 5         |
| ----------------------- | ----------------- | ---------------------- | ----------------------- | --------------- |
| Agent 6                 | Action 1 / Fast   | Action 2 / Approve     | Action 3 / Reject       | Action 4 / Fork |
| Action 5 / Push-to-talk | Keycap · Browser¹ | Stream Deck: Next Page | Reasoning Encoder Click | New Task        |

The action names describe the default Codex Micro setup. The keys always follow the live `ACT06`, `ACT07`, `ACT08`, `ACT09`, and `ACT10/11` assignments selected in Codex. ¹If you use `ACT12` / Send more often than Browser, put **Action 6 / Send** in that position instead.

### Page 2 — navigation and reasoning

| Local Codex Connection² | Empty                | Joystick Up / Plan         | Reasoning Down           | Reasoning Up            |
| ------------------------------ | -------------------- | -------------------------- | ------------------------ | ----------------------- |
| Empty                          | Joystick Left / Back | Stream Deck: Previous Page | Joystick Right / Forward | Reasoning Encoder Click |
| Stream Deck: Switch Profile³   | Empty                | Joystick Down / Sidebar    | Empty                    | New Task                |

²The existing host key shows the local Codex connection state. Old profiles keep its UUID; saved remote selection is ignored without modifying old private files. ³Configure Stream Deck's built-in **Switch Profile** action to return to your own standard profile; no user-specific profile ID is distributed.

The page-navigation and profile-switch keys are built-in Stream Deck actions. All other named controls come from Agent Deck. Every official Codex Micro keycap is also exposed as a standalone action, so extra pages can be customized without changing the six synchronized Micro action slots.

### Usage and reset controls

![Usage limit, overview, and reset-credit controls](docs/assets/usage-controls-preview.svg)

Add **Usage Limit** for the existing circular display of consumed quota. Its number and fill show the percentage used. The Stream Deck property inspector can pin the key to **5 hours** or **Weekly**, while **Automatic** prefers 5 hours and falls back to weekly whenever the shorter window is unavailable. **Usage Overview** shows both windows as separate used-percentage bars; a missing window stays visible as unavailable instead of being mistaken for zero capacity. On macOS, quota windows come from a fresh CodexBar widget snapshot and remain available while Codex Desktop is closed. Windows retains its existing Codex Desktop usage source.

**Reset Credits (Read Only)** shows the number of credits Codex currently reports. The legacy action UUID is preserved for existing profiles. Pressing or holding the key does nothing; the plugin cannot consume reset credits. Usage-limit keys also have no press action: choose the displayed window in their settings, or leave Auto to use an available window.

Usage and reset credits come from the local account source. macOS reads quota windows from CodexBar and overlays reset counters from the attached Codex bridge; Windows uses the local renderer query.

## Official keycap SVGs are not included

The public source and release intentionally exclude OpenAI's Codex Micro keycap SVG files. The original agent tiles, status marks, glow system, animations, fallback labels, and plugin artwork are included.

If you have the right to use the files already present in your own Codex installation, copy them outside the repository to:

```text
Windows: %LOCALAPPDATA%\CodexDeck\icons
macOS:   ~/Library/Application Support/CodexDeck/icons
```

Name each copy after its Codex keycap ID, such as `FAST.svg`, `APPR.svg`, `REJ.svg`, `SPLIT.svg`, or `MIC.svg`. Codex can inspect your local installation and copy the exact existing SVG files for you when explicitly instructed not to redraw, download, upload, publish, or commit them. See [Local icon setup](docs/ICON_SETUP.md) for the guarded workflow and complete filename list.

## How it works

The following path describes native Codex controls. OpenCode and T3 Code use separate task collectors; see [Task sources and controls](#task-sources-and-controls).

```text
Stream Deck key
    -> Agent Deck plugin
    -> loopback-only Chrome DevTools connection
    -> Codex renderer host-event bus
    -> native Codex Micro handler
```

The launcher enables a random Chrome DevTools port bound to `127.0.0.1`. The plugin discovers version-hashed renderer modules, reads the native Micro layout/state, and dispatches the same event families used by the Micro integration:

- `codex-micro-device-state-changed`
- `codex-micro-hid-event`
- `codex-micro-joystick-event`

No virtual HID driver is installed and no Codex application file is patched. See [Architecture and security](docs/ARCHITECTURE.md).

## Security and privacy

- The Codex debug endpoint remains loopback-only and must never be exposed or forwarded.
- CDP is privileged: another untrusted process running as the same local user could try to access it.
- Agent Deck has no telemetry, cloud service, or update service.
- For Codex, Agent Deck reads exact local rollout filenames for ownership and a bounded recent tail for structural status tags plus numeric `token_count` fields. It does not parse or relay prompts, responses, project names, or other conversation content.
- OpenCode monitoring is off in the default Codex mode. When selected, the characterized macOS collector reads only user-owned service/SSH registration data and bounded API projections; it never opens OpenCode SQLite, starts WSL, or publishes task content.
- Optional SVGs stay in the user-local icons directory and are never uploaded.
- Private relay tokens, local host state, logs, and personal paths are excluded by the release audit.

Do not use the launcher while running untrusted local software. See [SECURITY.md](SECURITY.md).

## Compatibility

Compatibility is versioned with each release because Agent Deck depends on undocumented Codex desktop internals. Consult the notes and validation evidence on the [releases page](https://github.com/xonika9/agent-stream-deck/releases) for the tested combinations.

OpenCode and T3 Code support is macOS-only and depends on their supported API contracts; see [OpenCode compatibility](docs/OPENCODE_COMPATIBILITY.md) and [T3 setup and compatibility](docs/T3CODE_COMPATIBILITY.md).

The last upstream validation covered the Windows physical-device path and the Windows + Mac relay on a real setup. It also covered the macOS launcher, watcher, native bridge, and plugin package, but not a Stream Deck physically attached to the Mac. Treat those results as historical validation evidence, not as strict minimums, maximums, or a guarantee for later Codex builds.

## Troubleshooting

Start with [Troubleshooting](docs/TROUBLESHOOTING.md). The important rule is: restart only the Stream Deck plugin/app for plugin updates. The macOS watcher never launches a closed Codex app; after a manual app start it permits at most one guarded recovery restart and opens a global cooldown before any later recovery.

## Build and release validation

```shell
npm ci
npm run lint
npm run check:boundaries
npm run check
npm test
npm run validate
npm run pack
npm run audit:release
```

`npm run release:prepare -- --version X.Y.Z` creates a versioned local release-candidate directory with the plugin package, launcher ZIPs, and SHA-256 checksums. On macOS it builds both launcher archives automatically. On another platform, create the macOS ZIP on a Mac with `scripts/package-macos-release.sh` so executable bits survive, then pass it with `--mac-archive /path/to/archive.zip`.

The release plugin's JavaScript is compacted without renaming identifiers; keep the stack frame's column for diagnostics. Release packages keep `bin/plugin.mjs.map` without embedded source text; `npm run build` keeps a full development map. For diagnostics, use the map from the affected package and source files from the exact commit used to build it, obtainable with `git show COMMIT:src/path.ts`. Map a stack frame's line and column (both start at 1) with Node 24:

```sh
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { SourceMap } from 'node:module'; const [map, line, column] = process.argv.slice(1); const entry = new SourceMap(JSON.parse(readFileSync(map, 'utf8'))).findEntry(Number(line) - 1, Number(column) - 1); console.log(entry.originalSource, entry.originalLine + 1, entry.originalColumn + 1);" bin/plugin.mjs.map LINE COLUMN
```

For a four-component Stream Deck hotfix version, set
`CODEX_DECK_RELEASE_VERSION=X.Y.Z.W` while running the macOS packager and pass
`--version X.Y.Z.W` to `npm run release:prepare`. The npm package keeps its
SemVer-compatible prerelease form.

Nothing is published automatically. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

The former phone-native Codex Micro companion was inspired in part
by the public mobile concept shared by [Shikhar (@xikhar)](https://x.com/xikhar).
Codex Deck Mobile was an independent implementation built on this project's own
authenticated bridge, native controls, and visual system; no source code or
artwork from that concept is included.

## License and trademarks

Code and original artwork are licensed under [MIT](LICENSE). OpenAI, Codex, ChatGPT, Elgato, Stream Deck, and their marks/assets belong to their respective owners; third-party and user-supplied assets are not relicensed.
