# T3 Code task source

The macOS Agent selector adds `T3 Code` and `All` (all three sources).
Legacy `Both` settings resolve to `All`; the selector offers only the three
individual sources and `All`. All external sources force Active queue without
changing the saved Codex preference. Windows installation and existing actions
are unchanged; T3 Code collection is currently macOS-only.

## Connect the local server

The setup commands below run from a source checkout of this repository with Node.js
24 or newer and dependencies installed with `npm ci`. They are setup tools; the
installed Stream Deck plugin continues polling without that checkout process running.

Start T3 Code normally. Create a one-time pairing credential with its own CLI,
then pipe the JSON directly into the connector:

```sh
t3 auth pairing create --label CodexDeck --json | npm run connect:t3
```

If `t3` is not installed on PATH, use the CLI bundled with the desktop app.
For the characterized nightly macOS application:

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)' '/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs' auth pairing create --label CodexDeck --json | npm run connect:t3
```

Running this command creates a separate T3 client session. The connector
exchanges the one-time credential for only `orchestration:read`, verifies the
shell endpoint, and stores the bearer token in the current user's
`~/Library/Application Support/CodexDeck/t3code.json` with mode `0600`.
Do not paste credentials into chat or Stream Deck settings. Expired or revoked
sessions require connecting again. The plugin never issues credentials itself.

The adapter reads `~/.t3/userdata/server-runtime.json`, checks that the recorded
process is alive and its origin matches the connection, and sends only loopback
HTTP requests. A changed server port requires connecting again. Custom base
folders remain unsupported. Remote Linux T3 servers can be added over SSH as described below.

## Connect a remote Linux server

With T3 already running remotely and the SSH host saved in your SSH configuration,
run `npm run connect:t3:ssh -- <ssh-alias>`. Python 3 must be available on the remote
host; its existing host key must already be trusted. The connector uses non-interactive
SSH with strict host-key checking, discovers the already-running T3 executable, and
creates a separate `orchestration:read` session through its official pairing CLI.
Both setup commands serialize configuration updates with a user-private lock, so
concurrent connections cannot overwrite each other. If a setup process is forcibly
killed, confirm no setup command is running before removing the private
`t3code-connect.lock` file and retrying. The connector preserves the local connection. Re-running for an already connected alias checks
and reuses that session. To replace a revoked session, remove only its entry from the
private `sshConnections` array and reconnect. Up to eight remote connections are supported.

The plugin polls each saved environment over SSH. Credentials travel through stdin,
never command arguments, desktop credential decryption, or public HTTP. The remote
runtime must remain live and its environment identity must match the saved identity.
No service is started, no tunnel is opened, and no Codex endpoint is forwarded.
The remote server uses its loopback HTTP endpoint internally. Remote identities are
namespaced by environment, so equal thread IDs cannot collide with local tasks.

## Queue behavior

The source uses `GET /api/orchestration/shell` with
`x-t3-orchestration-protocol: 2`. It consumes V2 thread status, pending runtime
requests, proposed plans, background work, run timestamps and `lastVisitedAt`.
It never opens T3's database, decrypts desktop credentials, dispatches commands,
or changes provider/model settings. Shell message previews and private project
metadata are discarded inside the adapter; only bounded sanitized task titles,
opaque IDs, normalized states and timestamps reach the renderer.

Pending input/approval/plans appear orange; preparing/queued/starting/running
work appears blue; fresh completion appears green; failed results appear red.
Archived, deleted, settled, snoozed, idle and interrupted chats are omitted.
Completed/failed results expire five minutes after their terminal timestamp and
are omitted when T3 reports they have already been visited. A press foregrounds
T3 Code and acknowledges only the exact displayed terminal revision locally.
It does not navigate to a specific chat or publish a visited update. A newer
terminal timestamp admits the result again. Key-up sends no Codex command.
T3 keys display `T3` and have no Codex context ring.

Missing credentials, unsupported response shapes, HTTP/SSH failure, excessive
response size or timeouts produce degraded health and clear stale tasks from the
failing connection while retaining successful environments.
Each environment commits its full verified snapshot independently; pending
requests preserve the previous snapshot's observation time. A shared 1200-ms
controller clock triggers the source without waiting for Codex, quota or SDK
work. The source reconciles configuration and starts only idle environment jobs,
with the existing local-plus-eight-SSH capacity. It does not add another clock
or abort a remote request when a local poll starts. Health remains connecting
until required first responses arrive, degrades on a known failure, and becomes
ready when all required environments have responded successfully; ready tasks
are available during the intermediate state.

Changing credentials, environment identity or local runtime generation retires
only the affected job. An invalid private configuration clears all jobs as
before. Exact terminal acknowledgements are checked again at commit, so a
pending response cannot restore an acknowledged revision. These changes are
covered by local fixtures; they do not establish a new live T3/Fedora or physical
device compatibility result.
HTTP requests have a four-second budget and a two-MiB response limit.
SSH polling has a four-second total budget (pairing setup allows ten seconds) and the same two-MiB output limit.
Acknowledgements are process-local and are never distributed or persisted.

## Evidence

The adapter contract was checked against the installed T3 Code Nightly `0.0.46-nightly.20261005.2689` V2
schemas and protocol header on 2026-10-05. The nearby source checkout used an
older orchestration shape and was not used as the final runtime contract.
Automated HTTP fixtures exercise authenticated collection, selection and
revision acknowledgement. Build/package checks do not establish live-app or
physical Stream Deck acceptance. Live acceptance requires creating the separate
connection above and checking running, approval, completion and failure states
in the installed plugin; physical-device testing must be recorded separately.

Live macOS verification on 2026-10-05 confirmed two running local tasks and one
running Fedora task in the same source. This is application validation, not physical
button testing; Windows T3 collection remains unsupported.
