# OpenCode compatibility

The first OpenCode integration targets the maintainer's characterized setup:

- macOS;
- OpenCode Desktop on macOS: historical characterization against `2.0.5` and `2.0.10`; ordinary local and saved-SSH task/card behavior was confirmed by the maintainer on Desktop `2.0.22` with Fedora service `2.0.21` for release `2.0.0`;
- the managed local `sidecar` service;
- saved SSH connections that authenticate non-interactively through the user's
  existing SSH configuration.

It deliberately does not inspect OpenCode's renderer SQLite database. The local
service comes from its private service registration. Saved SSH connections come
from the user-owned `opencode.settings` file; a CLI-managed remote service may
instead supply bounded pairing and authenticated identity output entirely inside
the SSH adapter. Because OpenCode Desktop currently
writes that file as `0644`, Codex Deck accepts it only when its owner is the
current user and group/other users cannot modify it.

## Out of scope

- WSL connections;
- saved HTTP connections;
- unknown future persistence or API shapes;
- interactive SSH authentication;
- launching a stopped local or remote OpenCode service.

Unsupported connection kinds are ignored. Codex Deck never invokes `wsl.exe`,
never opens `drafts.sqlite`, and never reads OpenCode process memory or Chromium
storage.

## Private-data boundary

Connection targets, service URLs, passwords, locations, messages, permission
resources, form contents, costs, and token counts remain inside the transport
adapter. The queue receives opaque connection and session IDs, stable
content-free `OpenCode N` fallback labels, normalized state, bounded timestamps,
and a bounded, sanitized task title for the same-process local Stream Deck
renderer. The title is never logged, diagnosed, relayed, or packaged.

Compatibility is capability-based rather than pinned to one exact version.
Registration and authenticated service versions and process IDs must match, and
descriptor checks, loopback validation, authentication, response bounds, and
the characterized API shapes must all pass. A future version with matching
capabilities remains available; a mismatched capability fails only that
connection closed.

Authenticated service identity prefers the current `/api/info` route and falls
back to the legacy `/api/status` route only when needed. The selected route is
reused across polls while the local registration is unchanged; a registration
change requires a fresh probe. Each candidate route must independently prove a
`401` or `403` unauthenticated boundary before Codex Deck sends the existing
service credential.

OpenCode `2.0.5` does not consistently publish `time.viewed` for remote roots.
The collector still honors that source field when present. A Stream Deck
key-down immediately acknowledges only the currently displayed completion or
error in memory, then makes a best-effort authenticated
`POST /api/session/{sessionID}/view` with that result's exact `idle` revision.
OpenCode `2.0.10` exposes this route; older or incompatible services may reject
it without restoring the locally acknowledged key or degrading other
connections. The acknowledgement is never sent through a relay and is
invalidated by a later terminal timestamp for the same opaque task identity. A
successful or failed terminal result remains visible until it is viewed,
acknowledged, or reaches five minutes after its normalized terminal event. The
five-second polling cadence schedules the removal; a pending collection or
admission wait can delay it beyond the next tick. Older terminal history present when monitoring starts is
not backfilled. OpenCode
Desktop `2.0.10` still clears its own renderer notification locally when a chat
opens, so opening a chat does not reliably publish `time.viewed` by itself.
When no Codex renderer snapshot is available to supply a theme, OpenCode Agent
and usage keys use the renderer's light fallback rather than changing to dark.


Saved SSH profiles are compared by their normalized target, in addition to their
stable opaque identity. After an authoritative protected settings read, a
changed or removed profile closes only its collector-owned tunnel. An unreadable
settings file does not prove that a profile was removed. An authenticated
PID/version mismatch closes that connection's owned tunnel and requires fresh
discovery on the next poll; other sources remain independent.
On macOS, a tunnel left behind by a plugin process that was killed before its
graceful stop is terminated on the first SSH discovery with a successful process
listing, but only when it was reparented to `launchd`, belongs to the current
user, and carries exactly the command line the collector builds for a saved
connection. The running plugin's tunnels and all other SSH processes are left
alone.

Each admitted environment publishes its completed snapshot without waiting for
the other environments. Initial local discovery does not wait for saved SSH
discovery. The collector retains at most three running collections and two SSH
discoveries: one place conditionally prefers waiting local work, while the
remaining places preserve FIFO progress for remote work. Running remote work
is not cancelled to make room for a later local job. The first 17 admitted
connections prefer sorted local registrations; they may all be local. Saved SSH
settings still allow up to 16 profiles, and failed discovery diagnostics can
appear beyond the admitted slice. Protected registration replacement or removal
invalidates only its own work; late results cannot restore it or an acknowledged
terminal revision. Pending snapshots retain their original observation time.

The independent-cycle update preserves the characterized API contract above.
Its automated fixtures cover tunnel replacement, local acknowledgement before
best-effort publication, new terminal revisions, and cancellation of old demand
generations. No additional live OpenCode or Fedora version is claimed here.
