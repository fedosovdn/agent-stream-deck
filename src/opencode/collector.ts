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

type Environment = {
  connectionId: string;
  generation: number;
  local: boolean;
  connection?: Connection;
  server?: SshServer;
  target?: string;
  client: AuthenticatedOpenCodeClient;
  pending?: Promise<void>;
};
type Work = {
  environment: Environment;
  run(): Promise<void>;
  finish(): void;
};
type ConnectionCandidate = {
  rootSessions: RawSession[];
  attentionRoots: Set<string>;
  activeRoots: Set<string>;
  complete: boolean;
};

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
  private readonly local = new Map<string, Environment>();
  private readonly remote = new Map<string, Environment>();
  private readonly snapshots = new Map<string, OpenCodeConnectionSnapshot>();
  private readonly children = new Map<OpenCodeProcess, Environment>();
  private readonly terminating = new Map<Promise<void>, number>();
  private readonly listeners = new Set<() => void>();
  private readonly client: AuthenticatedOpenCodeClient;
  private readonly collectionQueue: Work[] = [];
  private readonly discoveryQueue: Work[] = [];
  private collections = 0;
  private discoveries = 0;
  private localReserve = false;
  private interval?: NodeJS.Timeout;
  private running = false;
  private orphansReaped = false;
  private generation = 0;
  private localDiscovery?: Promise<Environment[]>;
  private sshDiscovery?: Promise<Environment[]>;
  private current: OpenCodeCollectorSnapshot = { version: 1, observedAt: 0, connections: [] };

  constructor(options: { identitySecret: string | Uint8Array; dependencies?: Partial<OpenCodeCollectorDependencies> }) {
    this.secret = Buffer.from(options.identitySecret);
    if (this.secret.byteLength < 32) throw new Error("OpenCode identity secret must contain at least 32 bytes.");
    this.deps = { ...defaultDependencies(), ...options.dependencies };
    this.client = new AuthenticatedOpenCodeClient(this.deps);
  }

  async start(): Promise<OpenCodeCollectorSnapshot> {
    if (!this.running) {
      this.running = true;
      this.generation++;
      this.current = { version: 1, observedAt: 0, connections: [] };
      // One cadence, independent work: neither a slow discovery nor a slow collection owns this timer.
      this.interval = this.deps.setInterval(() => {
        void this.poll().catch(() => undefined);
      }, POLL_INTERVAL_MS);
      void this.poll().catch(() => undefined);
    }
    return this.current;
  }

  async refresh(): Promise<OpenCodeCollectorSnapshot> {
    if (!this.running) throw new Error("OpenCode collector is not started.");
    await Promise.all(await this.poll());
    return this.current;
  }

  private async poll(): Promise<Promise<void>[]> {
    const generation = this.generation;
    const schedule = async (discovery: Promise<Environment[]>) => {
      const environments = await discovery;
      if (!this.running || generation !== this.generation) return [];
      return environments.map((environment) => this.schedule(environment));
    };
    const work = await Promise.all([schedule(this.reconcileLocal()), schedule(this.reconcileSsh())]);
    if (
      this.running &&
      generation === this.generation &&
      this.local.size === 0 &&
      this.remote.size === 0 &&
      this.current.observedAt === 0
    ) {
      this.publish(this.deps.now());
    }
    return work.flat();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): OpenCodeCollectorSnapshot {
    return this.current;
  }

  acknowledgeTask(connectionId: string, sessionId: string, terminalAt: number): boolean {
    const acknowledged = this.state.acknowledgeTask(this.current, connectionId, sessionId, terminalAt);
    if (!acknowledged) return false;
    this.current = acknowledged;
    for (const snapshot of acknowledged.connections) this.snapshots.set(snapshot.connectionId, snapshot);
    this.notify();
    return true;
  }

  async publishTaskViewed(connectionId: string, sessionId: string): Promise<boolean> {
    const binding = this.state.acknowledgedRevision(connectionId, sessionId);
    const connection = (this.local.get(connectionId) ?? this.remote.get(connectionId))?.connection;
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
    if (!this.running) return;
    const generation = this.generation;
    this.running = false;
    this.generation++;
    if (this.interval) this.deps.clearInterval(this.interval);
    this.interval = undefined;
    const environments = [...this.local.values(), ...this.remote.values()];
    const pending = environments.flatMap((environment) => (environment.pending ? [environment.pending] : []));
    const discoveries = [this.localDiscovery, this.sshDiscovery];
    this.localDiscovery = undefined;
    this.sshDiscovery = undefined;
    this.local.clear();
    this.remote.clear();
    this.client.stop();
    for (const environment of environments) this.retire(environment);
    this.snapshots.clear();
    await this.terminateChildren(generation);
    await Promise.allSettled([...pending, ...discoveries]);
    await this.terminateChildren(generation);
  }

  private active(environment: Environment): boolean {
    return (
      this.running &&
      environment.generation === this.generation &&
      (environment.local ? this.local : this.remote).get(environment.connectionId) === environment
    );
  }

  private admitted(): Environment[] {
    return [...this.local.values(), ...[...this.remote.values()].filter((environment) => environment.connection)].slice(
      0,
      MAX_CONNECTIONS,
    );
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private publish(now: number): void {
    const admitted = new Set(this.admitted().map((environment) => environment.connectionId));
    const connections = [...this.snapshots.values()]
      .filter(
        (snapshot) =>
          admitted.has(snapshot.connectionId) ||
          (!this.remote.get(snapshot.connectionId)?.connection && this.remote.has(snapshot.connectionId)),
      )
      .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
    this.current = { version: 1, observedAt: now, connections };
    this.notify();
  }

  private prunePublished(): void {
    const allowed = new Set(this.admitted().map((environment) => environment.connectionId));
    for (const environment of this.remote.values()) if (!environment.connection) allowed.add(environment.connectionId);
    if (
      this.current.connections.some(
        (connection) => !allowed.has(connection.connectionId) || !this.snapshots.has(connection.connectionId),
      )
    ) {
      this.publish(this.deps.now());
    }
  }

  private retire(environment: Environment): void {
    environment.client.stop();
    for (const queue of [this.collectionQueue, this.discoveryQueue]) {
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index]!.environment !== environment) continue;
        queue.splice(index, 1)[0]!.finish();
      }
    }
    for (const [child, owner] of this.children)
      if (owner === environment) void this.terminateChild(child).catch(() => undefined);
    this.snapshots.delete(environment.connectionId);
  }

  private reconcileLocal(): Promise<Environment[]> {
    if (this.localDiscovery) return this.localDiscovery;
    const generation = this.generation;
    const discovery = this.discoverLocal()
      .then((connections) => {
        if (!this.running || generation !== this.generation) return [];
        const next = new Map<string, Environment>();
        for (const connection of connections) {
          const existing = this.local.get(connection.connectionId);
          if (existing?.connection === connection) next.set(connection.connectionId, existing);
          else {
            if (existing) this.retire(existing);
            next.set(connection.connectionId, {
              connectionId: connection.connectionId,
              generation,
              local: true,
              connection,
              client: new AuthenticatedOpenCodeClient(this.deps),
            });
          }
        }
        for (const environment of this.local.values())
          if (!next.has(environment.connectionId)) this.retire(environment);
        this.local.clear();
        for (const [id, environment] of next) this.local.set(id, environment);
        this.prunePublished();
        return [...next.values()];
      })
      .finally(() => {
        if (this.localDiscovery === discovery) this.localDiscovery = undefined;
      });
    this.localDiscovery = discovery;
    return discovery;
  }

  private reconcileSsh(): Promise<Environment[]> {
    if (this.sshDiscovery) return this.sshDiscovery;
    const generation = this.generation;
    const discovery = (async () => {
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
        // A failed read is not authority to remove a saved environment or its tunnel.
        return generation === this.generation ? [...this.remote.values()] : [];
      }
      if (!this.running || generation !== this.generation) return [];
      const next = new Map<string, Environment>();
      for (const server of servers) {
        const connectionId = this.opaqueId(`ssh\0${server.id}`);
        let target: string;
        try {
          target = JSON.stringify(parseSshTarget(server.target));
        } catch {
          target = server.target;
        }
        const existing = this.remote.get(connectionId);
        if (existing?.target === target) next.set(connectionId, existing);
        else {
          if (existing) this.retire(existing);
          next.set(connectionId, {
            connectionId,
            generation,
            local: false,
            server,
            target,
            client: new AuthenticatedOpenCodeClient(this.deps),
          });
        }
      }
      for (const environment of this.remote.values()) if (!next.has(environment.connectionId)) this.retire(environment);
      this.remote.clear();
      for (const [id, environment] of next) this.remote.set(id, environment);
      this.prunePublished();
      if (!this.orphansReaped) {
        const templates = this.tunnelTemplates(servers);
        if (templates.length > 0) {
          try {
            await this.deps.reapOrphanedTunnels(templates);
            if (this.running && generation === this.generation) this.orphansReaped = true;
          } catch {
            /* Retried on the next discovery. */
          }
        }
      }
      return this.running && generation === this.generation ? [...next.values()] : [];
    })().finally(() => {
      if (this.sshDiscovery === discovery) this.sshDiscovery = undefined;
    });
    this.sshDiscovery = discovery;
    return discovery;
  }

  private enqueue(environment: Environment, discovery: boolean, run: () => Promise<void>): Promise<void> {
    return new Promise((finish) => {
      (discovery ? this.discoveryQueue : this.collectionQueue).push({ environment, run, finish });
      this.drain();
    });
  }

  private drain(): void {
    while (this.discoveries < 2 && this.discoveryQueue.length > 0) {
      const work = this.discoveryQueue.shift()!;
      if (!this.active(work.environment)) {
        work.finish();
        continue;
      }
      this.discoveries++;
      void work
        .run()
        .catch(() => undefined)
        .finally(() => {
          this.discoveries--;
          work.finish();
          this.drain();
        });
    }
    while (this.collections < 3 && this.collectionQueue.length > 0) {
      const localIndex = this.localReserve ? -1 : this.collectionQueue.findIndex((work) => work.environment.local);
      const reserved = localIndex >= 0;
      const work = this.collectionQueue.splice(reserved ? localIndex : 0, 1)[0]!;
      if (!this.active(work.environment) || !this.admitted().includes(work.environment)) {
        work.finish();
        continue;
      }
      this.collections++;
      if (reserved) this.localReserve = true;
      void work
        .run()
        .catch(() => undefined)
        .finally(() => {
          this.collections--;
          if (reserved) this.localReserve = false;
          work.finish();
          this.drain();
        });
    }
  }

  private schedule(environment: Environment): Promise<void> {
    if (!this.active(environment)) return Promise.resolve();
    if (environment.pending) return environment.pending;
    const pending = (async () => {
      if (!environment.connection && environment.server) {
        await this.enqueue(environment, true, async () => {
          try {
            const connection = await this.openSsh(environment.server!, environment.connectionId, environment);
            if (!this.active(environment)) {
              if (connection.tunnel) await this.terminateChild(connection.tunnel);
              return;
            }
            environment.connection = connection;
          } catch {
            if (!this.active(environment)) return;
            this.snapshots.set(environment.connectionId, unavailable(environment.connectionId, this.deps.now()));
            this.publish(this.deps.now());
          }
        });
      }
      const connection = environment.connection;
      if (!connection || !this.active(environment) || !this.admitted().includes(environment)) return;
      await this.enqueue(environment, false, async () => {
        let candidate: ConnectionCandidate | undefined;
        let health: "unavailable" | "incompatible" = "unavailable";
        try {
          candidate = await this.collectConnection(connection, environment.client);
          if (!candidate) health = "incompatible";
        } catch {
          /* A failed connection contributes only its unavailable snapshot. */
        }
        if (
          !this.active(environment) ||
          environment.connection !== connection ||
          !this.admitted().includes(environment)
        )
          return;
        const now = this.deps.now();
        // Project only at synchronous commit: acknowledgements made while I/O was pending remain authoritative.
        const snapshot = candidate
          ? this.state.project(
              environment.connectionId,
              candidate.rootSessions,
              candidate.attentionRoots,
              candidate.activeRoots,
              now,
              candidate.complete,
            )
          : { ...unavailable(environment.connectionId, now), health };
        this.state.label([snapshot], now);
        this.snapshots.set(environment.connectionId, snapshot);
        if (!candidate && connection.tunnel) {
          environment.connection = undefined;
          this.publish(now);
          await this.terminateChild(connection.tunnel);
        } else this.publish(now);
      });
    })().finally(() => {
      if (environment.pending === pending) environment.pending = undefined;
    });
    environment.pending = pending;
    return pending;
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
        const existing = this.local.get(connectionId)?.connection;
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

  private async openSsh(server: SshServer, connectionId: string, environment: Environment): Promise<Connection> {
    const target = parseSshTarget(server.target);
    const common = sshCommonArgs(target.args);
    const discovery = await this.deps.spawn(SSH_EXECUTABLE, [...common, target.host, "sh -l -s"], {
      env: minimalSshEnvironment(this.deps.homeDirectory),
      detached: true,
    });
    this.children.set(discovery, environment);
    if (!this.active(environment)) {
      await this.terminateChild(discovery);
      throw new Error("stopped");
    }
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
      await this.terminateChild(discovery);
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.children.delete(discovery);
    }
    if (code !== 0) throw new Error("ssh-discovery");
    if (!this.active(environment)) throw new Error("stopped");
    const registration = parseRemoteRegistration(output);
    if (!registration) throw new Error("ssh-registration");
    const remote = loopbackAddress(registration.url, true);
    const localPort = await this.deps.reserveLoopbackPort();
    const forward = `127.0.0.1:${localPort}:${remote.host}:${remote.port}`;
    const tunnel = await this.deps.spawn(SSH_EXECUTABLE, sshTunnelArgs(common, forward, target.host), {
      env: minimalSshEnvironment(this.deps.homeDirectory),
      detached: true,
    });
    this.children.set(tunnel, environment);
    if (!this.active(environment)) {
      await this.terminateChild(tunnel);
      throw new Error("stopped");
    }
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
      if (!(await environment.client.verifyIdentity(connection))) throw new Error("ssh-identity");
      return connection;
    } catch (error) {
      await this.terminateChild(tunnel);
      throw error;
    }
  }

  private async collectConnection(
    connection: Connection,
    client: AuthenticatedOpenCodeClient,
  ): Promise<ConnectionCandidate | undefined> {
    if (!(await client.verifyIdentity(connection))) return;
    const [activeRaw, permissionRaw, formRaw, rootsRaw] = await Promise.all([
      client.fetchJson(connection, "/api/session/active"),
      client.fetchJson(connection, "/api/permission/request"),
      client.fetchJson(connection, "/api/form"),
      client.fetchJson(connection, "/api/session?parentID=null&order=desc&limit=100"),
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
            request = client
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
    return { rootSessions, attentionRoots, activeRoots, complete };
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
    const owner = this.children.get(child);
    if (!owner) return;
    this.children.delete(child);
    const terminated = this.deps.terminateProcessGroup(child);
    this.terminating.set(terminated, owner.generation);
    try {
      await terminated;
    } finally {
      this.terminating.delete(terminated);
    }
  }

  private async terminateChildren(generation: number): Promise<void> {
    const children = [...this.children.entries()]
      .filter(([, owner]) => owner.generation === generation)
      .map(([child]) => child);
    const started = children.map((child) => this.terminateChild(child));
    const pending = [...this.terminating.entries()]
      .filter(([, owner]) => owner === generation)
      .map(([promise]) => promise);
    await Promise.allSettled([...started, ...pending]);
  }
}
