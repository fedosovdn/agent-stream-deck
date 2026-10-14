import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexHost, HostHealth, RoutedAgentSlot, TaskSource } from "#agents";
import { codexDeckStateRoot } from "../runtime/paths.js";

import { t3SshRequest, validateSshConnection } from "./ssh.js";

const TERMINAL_WINDOW_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
type Options = { configPath?: string; runtimePath?: string; foreground?: () => Promise<void> };
type LocalRuntime = { origin: string; token: string; pid: number };
type Environment = {
  namespace: string;
  identity: string;
  read: (request: AbortController) => Promise<RecordValue>;
  slots: RoutedAgentSlot[];
  state: "connecting" | "ready" | "degraded";
  request?: AbortController;
  pending?: Promise<void>;
};

export class T3CodeSource {
  slots: RoutedAgentSlot[] = [];
  health: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private host?: CodexHost;
  private demanded = false;
  private generation = 0;
  private preparation?: Promise<void>;
  private configurationFailed = false;
  private readonly environments = new Map<string, Environment>();
  private readonly listeners = new Set<() => void>();
  private readonly acknowledged = new Map<string, number>();
  private readonly configPath: string;
  private readonly runtimePath: string;
  private readonly foreground: () => Promise<void>;

  constructor(
    private readonly log: (message: string) => void,
    options: Options = {},
  ) {
    this.configPath = options.configPath ?? join(codexDeckStateRoot("darwin"), "t3code.json");
    this.runtimePath = options.runtimePath ?? join(homedir(), ".t3", "userdata", "server-runtime.json");
    this.foreground = options.foreground ?? foregroundT3Code;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  syncDemand(source: TaskSource, host: CodexHost | undefined, stopped: boolean): void {
    const demanded = !stopped && host?.platform === "darwin" && (source === "T3 Code" || source === "All");
    const hostChanged = this.host?.hostId !== host?.hostId;
    this.host = host;
    if (demanded === this.demanded && !hostChanged) return;
    this.demanded = demanded;
    this.generation++;
    this.resetEnvironments();
    this.preparation = undefined;
    this.configurationFailed = false;
    this.publish();
    if (demanded) void this.refresh();
  }

  stop(): void {
    this.demanded = false;
    this.generation++;
    this.resetEnvironments();
    this.preparation = undefined;
    this.configurationFailed = false;
    this.acknowledged.clear();
    this.publish();
  }

  // The caller supplies its existing cadence; each environment owns its pending work and commit.
  refresh(): Promise<void> {
    if (!this.demanded || !this.host) return Promise.resolve();
    if (this.preparation) return this.preparation;
    const generation = this.generation;
    const preparation = this.prepare(generation).finally(() => {
      if (this.preparation === preparation) this.preparation = undefined;
    });
    this.preparation = preparation;
    return preparation;
  }

  private async prepare(generation: number): Promise<void> {
    try {
      const config = await readPrivateConfig(this.configPath);
      if (generation !== this.generation || !this.demanded) return;
      const desired = new Map<string, { identity: string; read: Environment["read"] }>();
      try {
        const runtime = await this.localRuntime(config);
        desired.set("", {
          identity: JSON.stringify([runtime.origin, runtime.token, runtime.pid]),
          read: async (request) => this.localShell(runtime, request),
        });
      } catch {
        desired.set("", {
          identity: "unavailable",
          read: async () => {
            throw new Error("Local runtime unavailable");
          },
        });
      }
      if (generation !== this.generation || !this.demanded) return;
      let configurationFailed = false;
      if (config.sshConnections !== undefined) {
        if (!Array.isArray(config.sshConnections) || config.sshConnections.length > 8) configurationFailed = true;
        else
          for (const value of config.sshConnections) {
            try {
              const connection = validateSshConnection(value);
              const namespace = `ssh:${connection.environmentId}:`;
              if (desired.has(namespace)) throw new Error("Duplicate T3 environment");
              desired.set(namespace, {
                identity: JSON.stringify([connection.host, connection.environmentId, connection.token]),
                read: async (request) => object(await t3SshRequest(connection.host, connection, request.signal)),
              });
            } catch {
              configurationFailed = true;
            }
          }
      }
      let changed = this.configurationFailed !== configurationFailed;
      this.configurationFailed = configurationFailed;
      for (const [namespace, environment] of this.environments) {
        if (desired.get(namespace)?.identity === environment.identity) continue;
        environment.request?.abort();
        this.environments.delete(namespace);
        changed = true;
      }
      for (const [namespace, candidate] of desired) {
        if (this.environments.has(namespace)) continue;
        this.environments.set(namespace, { namespace, ...candidate, slots: [], state: "connecting" });
        changed = true;
      }
      if (changed) this.publish();
      for (const environment of this.environments.values()) this.collect(environment, generation);
    } catch {
      if (generation !== this.generation || !this.demanded) return;
      const wasDegraded = this.health.state === "degraded";
      this.resetEnvironments();
      this.configurationFailed = true;
      this.publish();
      if (!wasDegraded) this.log("T3 Code task source unavailable; check the local connection.");
    }
  }

  private collect(environment: Environment, generation: number): void {
    if (environment.pending) return;
    const request = new AbortController();
    environment.request = request;
    const current = () =>
      generation === this.generation &&
      this.demanded &&
      this.environments.get(environment.namespace) === environment &&
      !request.signal.aborted;
    const pending = (async () => {
      try {
        const shell = await environment.read(request);
        if (
          !Number.isSafeInteger(shell.schemaVersion) ||
          !Array.isArray(shell.threads) ||
          shell.threads.length > 10_000
        )
          throw new Error("Unsupported shell");
        const observedAt = Date.now();
        const candidate = shell.threads.flatMap((value, index) => {
          const slot = this.taskSlot(object(value), index, observedAt, environment.namespace);
          return slot ? [slot] : [];
        });
        if (!current()) return;
        // Recheck the exact acknowledgement at commit, including the environment namespace.
        environment.slots = candidate.filter(
          (slot) =>
            (slot.status !== "unread" && slot.status !== "error") ||
            this.acknowledged.get(slot.threadKey!) !== slot.activityAt,
        );
        environment.state = "ready";
        this.publish();
      } catch {
        if (!current()) return;
        environment.slots = [];
        environment.state = "degraded";
        this.publish();
      }
    })().finally(() => {
      if (environment.pending === pending) {
        environment.pending = undefined;
        environment.request = undefined;
      }
    });
    environment.pending = pending;
  }

  private resetEnvironments(): void {
    for (const environment of this.environments.values()) environment.request?.abort();
    this.environments.clear();
  }

  private publish(): void {
    this.slots = [...this.environments.values()].flatMap((environment) => environment.slots);
    const present = new Set(this.slots.map((slot) => slot.threadKey));
    const now = Date.now();
    for (const [id, at] of this.acknowledged)
      if (!present.has(id) && now - at > TERMINAL_WINDOW_MS) this.acknowledged.delete(id);
    const environments = [...this.environments.values()];
    const state =
      this.configurationFailed || environments.some((environment) => environment.state === "degraded")
        ? "degraded"
        : !environments.length || environments.some((environment) => environment.state === "connecting")
          ? "connecting"
          : "ready";
    if (this.health.state !== state) {
      this.health =
        state === "ready"
          ? { state, changedAt: now }
          : {
              state,
              reason: state === "connecting" ? "awaiting-snapshot" : "native-signals-unavailable",
              changedAt: now,
            };
    }
    for (const listener of this.listeners) listener();
  }

  private async localRuntime(config: RecordValue): Promise<LocalRuntime> {
    const origin = loopbackOrigin(config.origin);
    const token = config.token;
    if (typeof token !== "string" || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/u.test(token))
      throw new Error("Invalid token");
    const runtime = object(JSON.parse(await readFile(this.runtimePath, "utf8")));
    if (
      runtime.version !== 1 ||
      runtime.origin !== origin ||
      !Number.isSafeInteger(runtime.pid) ||
      Number(runtime.pid) <= 0
    )
      throw new Error("Invalid runtime");
    process.kill(Number(runtime.pid), 0);
    return { origin, token, pid: Number(runtime.pid) };
  }

  private async localShell(runtime: LocalRuntime, request: AbortController): Promise<RecordValue> {
    const { origin, token } = runtime;
    const response = await fetch(`${origin}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(4_000)]),
    });
    if (!response.ok || !response.body) throw new Error("Shell unavailable");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error("Shell too large");
      }
      chunks.push(chunk);
    }
    const shell = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return shell;
  }

  async open(assignment: RoutedAgentSlot, signal: AbortSignal): Promise<boolean> {
    if (!this.demanded || signal.aborted) return false;
    const generation = this.generation;
    await this.foreground();
    if (signal.aborted || generation !== this.generation || !this.demanded) return false;
    const current = this.slots.find((slot) => slot.threadKey === assignment.threadKey);
    if (!current || current.activityAt !== assignment.activityAt || current.status !== assignment.status) return false;
    if ((current.status === "unread" || current.status === "error") && current.activityAt !== undefined) {
      this.acknowledged.set(current.threadKey!, current.activityAt);
      for (const environment of this.environments.values())
        environment.slots = environment.slots.filter((slot) => slot !== current);
      this.publish();
    }
    return true;
  }

  private taskSlot(thread: RecordValue, index: number, now: number, namespace = ""): RoutedAgentSlot | null {
    if (
      typeof thread.id !== "string" ||
      !thread.id ||
      thread.id.length > 512 ||
      typeof thread.title !== "string" ||
      typeof thread.status !== "string"
    )
      throw new Error("Unsupported thread");
    if (
      thread.deletedAt ||
      thread.archivedAt ||
      thread.settledAt ||
      thread.settledOverride === "settled" ||
      (timestamp(thread.snoozedUntil) ?? 0) > now
    )
      return null;
    const workStartedAt =
      timestamp(thread.activityRunStartedAt) ??
      timestamp(thread.latestUserAuthoredMessageAt) ??
      timestamp(thread.latestRunRequestedAt);
    const terminalAt = timestamp(thread.latestRunCompletedAt);
    let status: string;
    if (thread.pendingRuntimeRequest || thread.hasActionableProposedPlan) status = "approval";
    else if (
      ["preparing", "queued", "starting", "running", "waiting"].includes(
        String(thread.activityRunStatus ?? thread.status),
      ) ||
      (Array.isArray(thread.pendingBackgroundTasks) && thread.pendingBackgroundTasks.length > 0)
    )
      status = "working";
    else if (thread.status === "completed" || thread.status === "failed") {
      if (
        terminalAt === undefined ||
        now - terminalAt > TERMINAL_WINDOW_MS ||
        terminalAt > now + 60_000 ||
        this.acknowledged.get(namespace + thread.id) === terminalAt ||
        (timestamp(thread.lastVisitedAt) ?? 0) >= terminalAt
      )
        return null;
      status = thread.status === "failed" ? "error" : "unread";
    } else return null;
    return {
      id: index,
      sourceSlot: index,
      catalogIndex: index,
      taskSource: "t3code",
      host: this.host!,
      threadKey: namespace + thread.id,
      conversationId: namespace + thread.id,
      title:
        thread.title
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 160) || "T3 Code task",
      status,
      selected: false,
      activityAt: terminalAt ?? workStartedAt,
      observedAt: now,
      workStartedAt,
      workStartRevision: workStartedAt,
    };
  }
}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
  return value as RecordValue;
}
function timestamp(value: unknown): number | undefined {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isSafeInteger(at) && at > 0 ? at : undefined;
}
function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid origin");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.origin !== value)
    throw new Error("Only loopback origins are supported");
  return url.origin;
}
async function readPrivateConfig(path: string): Promise<RecordValue> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Unprotected configuration");
    return object(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
}
async function foregroundT3Code(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/open", ["-b", "com.t3tools.t3code"], { timeout: 5_000 }, (error) =>
      error ? reject(new Error("T3 Code activation failed")) : resolve(),
    );
  });
}
