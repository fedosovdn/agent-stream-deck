import { createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { nodeOpenCodeFileAccess } from "./secure-files.js";
import { AuthenticatedOpenCodeClient } from "./client.js";
import { OpenCodeTaskState } from "./state.js";
import type {
  OpenCodeCollectorDependencies,
  OpenCodeProcess,
  OpenCodeCollectorSnapshot,
  OpenCodeConnectionSnapshot,
  Connection,
  SshServer,
  RawSession,
} from "./contracts.js";
export type {
  OpenCodeTaskStatus,
  OpenCodeTask,
  OpenCodeConnectionHealth,
  OpenCodeConnectionSnapshot,
  OpenCodeCollectorSnapshot,
  OpenCodeProcess,
  OpenCodeCollectorDependencies,
} from "./contracts.js";
import {
  REGISTRATION_LIMIT,
  SETTINGS_LIMIT,
  PROCESS_OUTPUT_LIMIT,
  MAX_CONNECTIONS,
  MAX_SESSIONS,
  MAX_ANCESTOR_DEPTH,
  FETCH_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  SSH_EXECUTABLE,
} from "./limits.js";
import { parseRegistration, parseSshServers, parseRemoteRegistration, loopbackAddress } from "./discovery.js";
import { parseActive, parsePending, parseRootSessions, parseSessionEnvelope } from "./session-data.js";
import {
  REMOTE_DISCOVERY_SCRIPT,
  parseSshTarget,
  sshCommonArgs,
  minimalSshEnvironment,
  readProcessOutput,
  spawnProcess,
  reserveLoopbackPort,
  waitForLoopbackPort,
  terminateProcessGroup,
  sshTunnelArgs,
  reapOrphanedTunnels,
  TUNNEL_FORWARD_PLACEHOLDER,
} from "./ssh.js";
import { mapConcurrent, unavailable } from "./collection-utils.js";

function defaultDependencies(): OpenCodeCollectorDependencies {
  const home = homedir();
  return {
    homeDirectory: home,
    stateDirectory: join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "opencode"),
    settingsPath: join(home, "Library", "Application Support", "ai.opencode.desktop", "opencode.settings"),
    currentUid: typeof process.getuid === "function" ? process.getuid() : undefined,
    now: Date.now,
    setInterval,
    clearInterval,
    files: nodeOpenCodeFileAccess,
    fetch,
    spawn: spawnProcess,
    reserveLoopbackPort,
    waitForLoopbackPort,
    terminateProcessGroup,
    reapOrphanedTunnels,
  };
}

export class OpenCodeCollector {
  private readonly secret: Buffer;
  private readonly deps: OpenCodeCollectorDependencies;
  private readonly state = new OpenCodeTaskState();
  private readonly tunnels = new Map<string, Connection>();
  private readonly connections = new Map<string, Connection>();
  private readonly children = new Set<OpenCodeProcess>();
  private readonly client: AuthenticatedOpenCodeClient;
  private interval?: NodeJS.Timeout;
  private running = false;
  private orphansReaped = false;
  private generation = 0;
  private inFlight?: Promise<OpenCodeCollectorSnapshot>;
  private current: OpenCodeCollectorSnapshot = { version: 1, observedAt: 0, connections: [] };

  constructor(options: { identitySecret: string | Uint8Array; dependencies?: Partial<OpenCodeCollectorDependencies> }) {
    this.secret = Buffer.from(options.identitySecret);
    if (this.secret.byteLength < 32) throw new Error("OpenCode identity secret must contain at least 32 bytes.");
    this.deps = { ...defaultDependencies(), ...options.dependencies };
    this.client = new AuthenticatedOpenCodeClient(this.deps);
  }

  async start(): Promise<OpenCodeCollectorSnapshot> {
    if (this.running) return this.refresh();
    this.running = true;
    this.generation++;
    const snapshot = await this.refresh();
    if (this.running) {
      this.interval = this.deps.setInterval(() => {
        void this.refresh().catch(() => undefined);
      }, POLL_INTERVAL_MS);
    }
    return snapshot;
  }

  refresh(): Promise<OpenCodeCollectorSnapshot> {
    if (!this.running) return Promise.reject(new Error("OpenCode collector is not started."));
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.inFlight = this.collect(generation).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  snapshot(): OpenCodeCollectorSnapshot {
    return this.current;
  }

  acknowledgeTask(connectionId: string, sessionId: string, terminalAt: number): boolean {
    const acknowledged = this.state.acknowledgeTask(this.current, connectionId, sessionId, terminalAt);
    if (!acknowledged) return false;
    this.current = acknowledged;
    return true;
  }

  async publishTaskViewed(connectionId: string, sessionId: string): Promise<boolean> {
    const binding = this.state.acknowledgedRevision(connectionId, sessionId);
    const connection = this.connections.get(connectionId);
    if (!binding?.acknowledged || binding.idleAt === undefined || !connection) return false;
    try {
      const authorization = `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}`;
      const response = await this.client.fetchResponse(
        connection.endpoint,
        `/api/session/${encodeURIComponent(sessionId)}/view`,
        authorization,
        16 * 1024,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idle: binding.idleAt }),
        },
      );
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && this.tunnels.size === 0) return;
    this.running = false;
    this.generation++;
    if (this.interval) this.deps.clearInterval(this.interval);
    this.interval = undefined;
    this.client.stop();
    this.tunnels.clear();
    this.connections.clear();
    await this.terminateChildren();
    await this.inFlight?.catch(() => undefined);
    await this.terminateChildren();
  }

  private async collect(generation: number): Promise<OpenCodeCollectorSnapshot> {
    const now = this.deps.now();
    const local = await this.discoverLocal();
    const ssh = await this.discoverSsh();
    const discovered = [...local, ...ssh.connections].slice(0, MAX_CONNECTIONS);
    const results = await mapConcurrent(discovered, 3, async (connection) => {
      try {
        return await this.collectConnection(connection, now);
      } catch {
        if (connection.tunnel) {
          this.tunnels.delete(connection.connectionId);
          await this.terminateChild(connection.tunnel);
        }
        return unavailable(connection.connectionId, now);
      }
    });
    if (!this.running || generation !== this.generation) return this.current;
    this.connections.clear();
    for (const [index, connection] of discovered.entries()) {
      const health = results[index]?.health;
      if (health === "ready" || health === "capacity-exceeded") {
        this.connections.set(connection.connectionId, connection);
      }
    }
    results.push(...ssh.failures.map((connectionId) => unavailable(connectionId, now)));
    const deduplicated = [...new Map(results.map((result) => [result.connectionId, result])).values()].sort(
      (left, right) => left.connectionId.localeCompare(right.connectionId),
    );
    this.state.label(deduplicated, now);
    this.current = { version: 1, observedAt: now, connections: deduplicated };
    return this.current;
  }

  private async discoverLocal(): Promise<Connection[]> {
    const names = (await this.deps.files.list(this.deps.stateDirectory))
      .filter((name) => /^service(?:[._-][A-Za-z0-9_-]{1,64})?\.json$/u.test(name))
      .sort()
      .slice(0, MAX_CONNECTIONS);
    const connections: Connection[] = [];
    for (const name of names) {
      try {
        const bytes = await this.deps.files.readSecure(
          join(this.deps.stateDirectory, name),
          REGISTRATION_LIMIT,
          this.deps.currentUid,
        );
        const registration = parseRegistration(bytes);
        if (!registration) continue;
        const connectionId = this.opaqueId(`local\0${registration.id ?? name}`);
        const existing = this.connections.get(connectionId);
        if (
          existing &&
          !existing.tunnel &&
          existing.endpoint === registration.url &&
          existing.password === registration.password &&
          existing.version === registration.version &&
          existing.pid === registration.pid
        ) {
          connections.push(existing);
          continue;
        }
        connections.push({
          connectionId,
          endpoint: registration.url,
          password: registration.password,
          version: registration.version,
          pid: registration.pid,
        });
      } catch {
        // Unsafe and unreadable registrations are absent by design.
      }
    }
    return [...new Map(connections.map((connection) => [connection.connectionId, connection])).values()];
  }

  private async discoverSsh(): Promise<{ connections: Connection[]; failures: string[] }> {
    let servers: SshServer[];
    try {
      const bytes = await this.deps.files.readSecure(
        this.deps.settingsPath,
        SETTINGS_LIMIT,
        this.deps.currentUid,
        "owner-write",
      );
      servers = parseSshServers(bytes);
    } catch {
      return { connections: [], failures: [] };
    }
    if (!this.orphansReaped) {
      const templates = this.tunnelTemplates(servers);
      if (templates.length > 0) {
        try {
          await this.deps.reapOrphanedTunnels(templates);
          this.orphansReaped = true;
        } catch {
          // Retried on the next discovery.
        }
      }
    }
    const targets = new Map(
      servers.map((server) => {
        const id = this.opaqueId(`ssh\0${server.id}`);
        try {
          return [id, JSON.stringify(parseSshTarget(server.target))] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    for (const [id, connection] of this.tunnels) {
      if (targets.get(id) === connection.sshTarget) continue;
      this.tunnels.delete(id);
      if (connection.tunnel) await this.terminateChild(connection.tunnel);
    }
    const results = await mapConcurrent(servers, 2, async (server) => {
      const connectionId = this.opaqueId(`ssh\0${server.id}`);
      const existing = this.tunnels.get(connectionId);
      if (existing) return { connection: existing };
      try {
        const connection = await this.openSsh(server, connectionId);
        if (!this.running) {
          if (connection.tunnel) await this.terminateChild(connection.tunnel);
          return { failure: connectionId };
        }
        connection.sshTarget = targets.get(connectionId) ?? undefined;
        this.tunnels.set(connectionId, connection);
        return { connection };
      } catch {
        return { failure: connectionId };
      }
    });
    return {
      connections: results.flatMap((result) => (result.connection ? [result.connection] : [])),
      failures: results.flatMap((result) => (result.failure ? [result.failure] : [])),
    };
  }

  private async openSsh(server: SshServer, connectionId: string): Promise<Connection> {
    const target = parseSshTarget(server.target);
    const common = sshCommonArgs(target.args);
    const discovery = await this.deps.spawn(SSH_EXECUTABLE, [...common, target.host, "sh -l -s"], {
      env: minimalSshEnvironment(this.deps.homeDirectory),
      detached: true,
    });
    this.children.add(discovery);
    discovery.write(REMOTE_DISCOVERY_SCRIPT);
    discovery.end();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("ssh-timeout")), FETCH_TIMEOUT_MS);
    });
    let output: string;
    let code: number | null;
    try {
      [output, , code] = await Promise.race([
        Promise.all([
          readProcessOutput(discovery.stdout, PROCESS_OUTPUT_LIMIT),
          readProcessOutput(discovery.stderr, 16 * 1024),
          discovery.exited,
        ]),
        timeout,
      ]);
    } catch (error) {
      await this.deps.terminateProcessGroup(discovery);
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.children.delete(discovery);
    }
    if (code !== 0) throw new Error("ssh-discovery");
    const registration = parseRemoteRegistration(output);
    if (!registration) throw new Error("ssh-registration");
    const remote = loopbackAddress(registration.url, true);
    const localPort = await this.deps.reserveLoopbackPort();
    const forward = `127.0.0.1:${localPort}:${remote.host}:${remote.port}`;
    const tunnel = await this.deps.spawn(SSH_EXECUTABLE, sshTunnelArgs(common, forward, target.host), {
      env: minimalSshEnvironment(this.deps.homeDirectory),
      detached: true,
    });
    this.children.add(tunnel);
    try {
      if (!(await this.deps.waitForLoopbackPort(localPort, FETCH_TIMEOUT_MS))) throw new Error("ssh-forward");
      const endpoint = `http://127.0.0.1:${localPort}`;
      const connection: Connection = {
        connectionId,
        endpoint,
        password: registration.password,
        version: registration.version,
        pid: registration.pid,
        tunnel,
      };
      if (!(await this.client.verifyIdentity(connection))) throw new Error("ssh-identity");
      return connection;
    } catch (error) {
      await this.terminateChild(tunnel);
      throw error;
    }
  }

  private async collectConnection(connection: Connection, now: number): Promise<OpenCodeConnectionSnapshot> {
    if (!(await this.client.verifyIdentity(connection))) {
      if (connection.tunnel) {
        this.tunnels.delete(connection.connectionId);
        await this.terminateChild(connection.tunnel);
      }
      return { ...unavailable(connection.connectionId, now), health: "incompatible" };
    }
    const [activeRaw, permissionRaw, formRaw, rootsRaw] = await Promise.all([
      this.client.fetchJson(connection, "/api/session/active"),
      this.client.fetchJson(connection, "/api/permission/request"),
      this.client.fetchJson(connection, "/api/form"),
      this.client.fetchJson(connection, "/api/session?parentID=null&order=desc&limit=100"),
    ]);
    const activeIds = parseActive(activeRaw);
    const attentionIds = [...parsePending(permissionRaw), ...parsePending(formRaw)];
    const rootPage = parseRootSessions(rootsRaw);
    const roots = rootPage.sessions;
    const sessions = new Map(roots.map((session) => [session.id, session]));
    let complete = rootPage.complete;
    const requested = [...new Set([...activeIds, ...attentionIds])];
    const lineages = new Map<string, RawSession[]>();
    // Scoped to this connection and cycle: identity checks and later refreshes still read fresh data.
    const sessionRequests = new Map<string, Promise<RawSession>>();
    await mapConcurrent(requested, 4, async (id) => {
      const lineage: RawSession[] = [];
      let currentId: string | undefined = id;
      const seen = new Set<string>();
      for (let depth = 0; currentId && depth < MAX_ANCESTOR_DEPTH; depth++) {
        if (seen.has(currentId)) throw new Error("session-cycle");
        seen.add(currentId);
        let current = sessions.get(currentId);
        if (!current) {
          if (sessions.size >= MAX_SESSIONS) {
            complete = false;
            break;
          }
          let request = sessionRequests.get(currentId);
          if (!request) {
            request = this.client
              .fetchJson(connection, `/api/session/${encodeURIComponent(currentId)}`)
              .then(parseSessionEnvelope);
            sessionRequests.set(currentId, request);
          }
          current = await request;
          if (sessions.size >= MAX_SESSIONS) {
            complete = false;
            break;
          }
          sessions.set(current.id, current);
        }
        lineage.push(current);
        currentId = current.parentID;
        if (depth === MAX_ANCESTOR_DEPTH - 1 && currentId) complete = false;
      }
      lineages.set(id, lineage);
    });
    const attentionRoots = new Set<string>();
    for (const id of attentionIds) {
      const lineage = lineages.get(id);
      const root = lineage?.[lineage.length - 1];
      if (root?.parentID !== undefined) continue;
      if (root) attentionRoots.add(root.id);
    }
    const activeRoots = new Set<string>();
    for (const id of activeIds) {
      const session = sessions.get(id);
      if (session && session.parentID === undefined) activeRoots.add(id);
    }
    const rootSessions = [...sessions.values()].filter((session) => session.parentID === undefined);
    return this.state.project(connection.connectionId, rootSessions, attentionRoots, activeRoots, now, complete);
  }

  // Command lines a tunnel for each saved target would have; an earlier plugin process killed without
  // stop() leaves such tunnels reparented to init.
  private tunnelTemplates(servers: SshServer[]): string[] {
    return servers.flatMap((server) => {
      try {
        const target = parseSshTarget(server.target);
        const args = sshTunnelArgs(sshCommonArgs(target.args), TUNNEL_FORWARD_PLACEHOLDER, target.host);
        return [[SSH_EXECUTABLE, ...args].join(" ")];
      } catch {
        return [];
      }
    });
  }

  private opaqueId(value: string): string {
    return `oc_${createHmac("sha256", this.secret).update(value).digest("base64url")}`;
  }

  private async terminateChild(child: OpenCodeProcess): Promise<void> {
    if (!this.children.delete(child)) return;
    await this.deps.terminateProcessGroup(child);
  }

  private async terminateChildren(): Promise<void> {
    const children = [...this.children];
    this.children.clear();
    await Promise.allSettled(children.map((child) => this.deps.terminateProcessGroup(child)));
  }
}
