import type { Stats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostSessionPresence, MicroSnapshot } from "#agents";

const SESSION_FILENAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const THREAD_KEY = /(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COMPLETION_FRESHNESS_MS = 5 * 60_000;
const WORK_START_RETENTION_MS = 24 * 60 * 60_000;
const MAX_RETAINED_WORK_STARTS = 512;
const MAX_CACHED_SESSION_STATUSES = 512;

type SessionStatus = Pick<
  HostSessionPresence,
  "status" | "completionRevision" | "contextUsedPercent" | "workStartedAt" | "workStartRevision"
> & { activityAt?: number };
type CachedSessionStatus = { signature: string; status: SessionStatus };

type WorkStartPair = { workStartedAt: number; workStartRevision: number };
type WorkStartRecord = WorkStartPair & { lastSeenAt: number };

export class CodexSessionOwnershipIndex {
  private sessionIds = new Set<string>();
  private recentSessions: HostSessionPresence[] = [];
  private trackedSessionPresence = new Map<string, HostSessionPresence>();
  private acknowledgedCompletions = new Map<string, number>();
  private contextParsedSessions = new Set<string>();
  private attemptedContextSessions = new Set<string>();
  private retainedWorkStarts = new Map<string, WorkStartRecord>();
  private parsedSessionStatuses = new Map<string, CachedSessionStatus>();
  private refreshedAt = 0;
  private refreshInFlight?: Promise<void>;

  constructor(
    private readonly roots = defaultSessionRoots(),
    private readonly refreshIntervalMs = 5_000,
  ) {}

  /** Retire in-flight work while retaining this process's committed observations. */
  fork(): CodexSessionOwnershipIndex {
    const next = new CodexSessionOwnershipIndex([...this.roots], this.refreshIntervalMs);
    next.sessionIds = new Set(this.sessionIds);
    next.recentSessions = this.recentSessions.map((session) => ({ ...session }));
    next.trackedSessionPresence = new Map(
      [...this.trackedSessionPresence].map(([id, session]) => [id, { ...session }]),
    );
    next.acknowledgedCompletions = new Map(this.acknowledgedCompletions);
    next.contextParsedSessions = new Set(this.contextParsedSessions);
    next.attemptedContextSessions = new Set(this.attemptedContextSessions);
    next.retainedWorkStarts = new Map([...this.retainedWorkStarts].map(([id, record]) => [id, { ...record }]));
    next.parsedSessionStatuses = new Map(
      [...this.parsedSessionStatuses].map(([path, entry]) => [path, { ...entry, status: { ...entry.status } }]),
    );
    next.refreshedAt = this.refreshedAt;
    return next;
  }

  async annotate(snapshot: MicroSnapshot, now = Date.now()): Promise<MicroSnapshot> {
    const trackedSessions = new Set(
      snapshot.slots
        .map((slot) => sessionIdFromThreadKey(slot.threadKey))
        .filter((sessionId): sessionId is string => sessionId != null),
    );
    const activeSessionId = sessionIdFromThreadKey(snapshot.activeThreadKey ?? null);
    if (activeSessionId) trackedSessions.add(activeSessionId);
    for (const candidate of snapshot.activeCatalog?.candidates ?? []) {
      if (candidate.conversationId && candidate.status !== "idle" && candidate.status !== "off") {
        trackedSessions.add(candidate.conversationId.toLowerCase());
      }
    }
    await this.refreshIfNeeded(now, trackedSessions);
    const selectedSessions = new Set(
      snapshot.slots
        .filter((slot) => slot.selected)
        .map((slot) => sessionIdFromThreadKey(slot.threadKey))
        .filter((sessionId): sessionId is string => sessionId != null),
    );
    if (activeSessionId) selectedSessions.add(activeSessionId);
    for (const candidate of snapshot.activeCatalog?.candidates ?? []) {
      if (candidate.selected && candidate.conversationId) selectedSessions.add(candidate.conversationId.toLowerCase());
    }
    for (const session of this.trackedSessionPresence.values()) {
      if (
        session.status === "complete" &&
        session.completionRevision != null &&
        selectedSessions.has(session.threadId)
      ) {
        this.acknowledgedCompletions.set(session.threadId, session.completionRevision);
      }
    }
    const allVisibleSessions = new Map(
      [...this.trackedSessionPresence.values()].map((session) => [session.threadId, this.visibleSession(session, now)]),
    );
    const publicVisibleSessions = this.recentSessions.map(
      (session) => allVisibleSessions.get(session.threadId) ?? this.visibleSession(session, now),
    );
    return {
      ...snapshot,
      hostSessions: publicVisibleSessions,
      activeCatalog: snapshot.activeCatalog && {
        ...snapshot.activeCatalog,
        candidates: snapshot.activeCatalog.candidates.map((candidate) => {
          const sessionId = candidate.conversationId?.toLowerCase();
          const session = sessionId ? allVisibleSessions.get(sessionId) : undefined;
          const ownedByHost = sessionId != null && this.sessionIds.has(sessionId);
          return { ...candidate, ...ownedSessionFields(candidate.status, session, ownedByHost) };
        }),
      },
      slots: snapshot.slots.map((slot) => {
        const sessionId = sessionIdFromThreadKey(slot.threadKey);
        const session = sessionId ? allVisibleSessions.get(sessionId) : undefined;
        const ownedByHost = sessionId != null && this.sessionIds.has(sessionId);
        return { ...slot, ...ownedSessionFields(slot.status, session, ownedByHost) };
      }),
    };
  }

  /** null explicitly forbids deriving an identity from a temporary catalog key. */
  markOpened(threadKey: string, trustedConversationId?: string | null): void {
    if (trustedConversationId === null) return;
    const normalizedTrusted = trustedConversationId?.toLowerCase();
    const sessionId =
      normalizedTrusted && sessionIdFromThreadKey(normalizedTrusted) === normalizedTrusted
        ? normalizedTrusted
        : trustedConversationId === undefined
          ? sessionIdFromThreadKey(threadKey)
          : null;
    if (!sessionId) return;
    const session = this.trackedSessionPresence.get(sessionId);
    if (session?.status === "complete" && session.completionRevision != null) {
      this.acknowledgedCompletions.set(sessionId, session.completionRevision);
    }
  }

  private async refreshIfNeeded(now: number, trackedSessions: Set<string>): Promise<void> {
    const plannedRefresh = now - this.refreshedAt >= this.refreshIntervalMs;
    const needsContext = [...trackedSessions].some(
      (sessionId) => !this.contextParsedSessions.has(sessionId) && !this.attemptedContextSessions.has(sessionId),
    );
    if (!plannedRefresh && !needsContext) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refresh(now, trackedSessions);
    this.refreshInFlight = pending;
    try {
      await pending;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    }
  }

  private async refresh(now: number, trackedSessions: Set<string>): Promise<void> {
    const next = new Set<string>();
    const sessionFiles: Array<{ threadId: string; path: string }> = [];
    const files: Array<{ threadId: string; path: string; activityAt: number; signature: string }> = [];
    for (const root of this.roots) {
      try {
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const sessionId = sessionIdFromRolloutFilename(entry.name);
          if (!sessionId) continue;
          next.add(sessionId);
          const parentPath =
            (entry as typeof entry & { parentPath?: string; path?: string }).parentPath ??
            (entry as typeof entry & { path?: string }).path;
          if (!parentPath) continue;
          sessionFiles.push({ threadId: sessionId, path: join(parentPath, entry.name) });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
    }
    for (let index = 0; index < sessionFiles.length; index += 32) {
      const batch = sessionFiles.slice(index, index + 32);
      const resolved = await Promise.all(
        batch.map(async ({ threadId, path }) => {
          try {
            const info = await stat(path);
            return { threadId, path, activityAt: info.mtimeMs, signature: sessionFileSignature(info) };
          } catch {
            return null;
          }
        }),
      );
      files.push(...resolved.filter((value): value is NonNullable<typeof value> => value != null));
    }
    const uniqueRecent = new Map<string, (typeof files)[number]>();
    for (const file of files.sort((left, right) => right.activityAt - left.activityAt)) {
      if (!uniqueRecent.has(file.threadId)) uniqueRecent.set(file.threadId, file);
    }
    const uniqueFiles = [...uniqueRecent.values()];
    const recent = uniqueFiles.slice(0, 128);
    const recentIds = new Set(recent.map((file) => file.threadId));
    const trackedExtra = uniqueFiles.filter(
      (file) => trackedSessions.has(file.threadId) && !recentIds.has(file.threadId),
    );
    const filesToRead = [...recent, ...trackedExtra];
    const contextParsed = new Set<string>();
    const nextParsedStatuses = new Map<string, CachedSessionStatus>();
    const retainedWorkStarts = new Map(this.retainedWorkStarts);
    const presence = await Promise.all(
      filesToRead.map(async ({ threadId, path, activityAt: fileActivityAt, signature }) => {
        const shouldRead = now - fileActivityAt <= 15 * 60_000 || trackedSessions.has(threadId);
        let recentStatus: SessionStatus = { status: "idle" };
        if (shouldRead) {
          const cached = this.parsedSessionStatuses.get(path);
          const parsed = cached?.signature === signature ? cached : await readRecentSessionStatus(path);
          if (parsed) {
            recentStatus = parsed.status;
            // Cache only a complete successful read of the file observed by
            // this scan. Replacement, truncation and writes invalidate it.
            if (parsed.signature === signature && nextParsedStatuses.size < MAX_CACHED_SESSION_STATUSES) {
              nextParsedStatuses.set(path, parsed);
            }
          }
        }
        if (shouldRead) contextParsed.add(threadId);
        const { activityAt, ...status } = recentStatus;
        const observedWorkStart = workStartFields(recentStatus);
        const prior = retainedWorkStarts.get(threadId);
        if (observedWorkStart && (prior == null || observedWorkStart.workStartRevision >= prior.workStartRevision)) {
          retainedWorkStarts.set(threadId, { ...observedWorkStart, lastSeenAt: now });
        }
        const retained = retainedWorkStarts.get(threadId);
        const workStart =
          retained && now - retained.lastSeenAt <= WORK_START_RETENTION_MS ? workStartFields(retained) : null;
        return { threadId, activityAt: activityAt ?? fileActivityAt, ...status, ...(workStart ?? {}) };
      }),
    );
    this.sessionIds = next;
    this.retainedWorkStarts = retainedWorkStarts;
    this.trackedSessionPresence = new Map(presence.map((session) => [session.threadId, session]));
    this.parsedSessionStatuses = nextParsedStatuses;
    this.recentSessions = recent.map((file) => this.trackedSessionPresence.get(file.threadId)!);
    this.contextParsedSessions = contextParsed;
    this.attemptedContextSessions = new Set(trackedSessions);
    const currentIds = new Set(this.trackedSessionPresence.keys());
    for (const threadId of this.acknowledgedCompletions.keys()) {
      if (!currentIds.has(threadId)) this.acknowledgedCompletions.delete(threadId);
    }
    for (const [threadId, retained] of this.retainedWorkStarts) {
      if (now - retained.lastSeenAt > WORK_START_RETENTION_MS) this.retainedWorkStarts.delete(threadId);
    }
    if (this.retainedWorkStarts.size > MAX_RETAINED_WORK_STARTS) {
      const oldest = [...this.retainedWorkStarts.entries()]
        .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
        .slice(0, this.retainedWorkStarts.size - MAX_RETAINED_WORK_STARTS);
      for (const [threadId] of oldest) this.retainedWorkStarts.delete(threadId);
    }
    this.refreshedAt = now;
  }

  private visibleSession(session: HostSessionPresence, now: number): HostSessionPresence {
    const completionIsAcknowledged =
      session.status === "complete" &&
      session.completionRevision != null &&
      this.acknowledgedCompletions.get(session.threadId) === session.completionRevision;
    const completionIsStale = session.status === "complete" && now - session.activityAt > COMPLETION_FRESHNESS_MS;
    return {
      ...session,
      status: completionIsAcknowledged || completionIsStale ? "idle" : session.status,
    };
  }
}

export function sessionIdFromRolloutFilename(filename: string): string | null {
  return filename.match(SESSION_FILENAME)?.[1]?.toLowerCase() ?? null;
}

export function sessionIdFromThreadKey(threadKey: string | null): string | null {
  return threadKey?.match(THREAD_KEY)?.[1]?.toLowerCase() ?? null;
}

function defaultSessionRoots(): string[] {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
}

function sessionFileSignature(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function readRecentSessionStatus(path: string): Promise<CachedSessionStatus | null> {
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      const length = Math.min(info.size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length));
      const tail = buffer.toString("utf8");
      const baseOffset = info.size - length;
      let lifecycle: "idle" | "working" | "complete" | undefined;
      let completionRevision: number | undefined;
      let activityAt: number | undefined;
      let workStartedAt: number | undefined;
      let workStartRevision: number | undefined;
      let lineStart = baseOffset === 0 ? 0 : buffer.indexOf(0x0a) + 1;
      while (lineStart < buffer.length) {
        const newline = buffer.indexOf(0x0a, lineStart);
        const lineEnd = newline < 0 ? buffer.length : newline;
        try {
          const event = JSON.parse(buffer.subarray(lineStart, lineEnd).toString("utf8")) as {
            type?: string;
            timestamp?: string;
            payload?: { type?: string; role?: string };
          };
          const eventType = event.type === "event_msg" ? event.payload?.type : undefined;
          const responseType = event.type === "response_item" ? event.payload?.type : undefined;
          const eventTime = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
          if (eventType === "user_message" && Number.isFinite(eventTime) && eventTime > 0) {
            workStartedAt = eventTime;
            workStartRevision = baseOffset + lineStart;
          }
          if (eventType === "task_started" || eventType === "agent_reasoning" || eventType === "function_call") {
            lifecycle = "working";
            if (Number.isFinite(eventTime)) activityAt = eventTime;
          } else if (eventType === "task_complete") {
            lifecycle = "complete";
            completionRevision = baseOffset + lineStart;
            if (Number.isFinite(eventTime)) activityAt = eventTime;
          } else if (eventType === "turn_aborted") {
            lifecycle = "idle";
          } else if (
            ["reasoning", "custom_tool_call", "custom_tool_call_output"].includes(responseType ?? "") ||
            (responseType === "message" && event.payload?.role === "assistant")
          ) {
            // Current Codex builds record active reasoning and tool work as
            // response_item entries. Long-lived threads can push the original
            // task_started record beyond this bounded tail read.
            lifecycle = "working";
            if (Number.isFinite(eventTime)) activityAt = eventTime;
          }
        } catch {
          /* Ignore a truncated first or last JSONL record. */
        }
        if (newline < 0) break;
        lineStart = newline + 1;
      }
      const contextUsedPercent = readContextUsedPercent(tail);
      const workStart = workStartedAt != null && workStartRevision != null ? { workStartedAt, workStartRevision } : {};
      // A short read can race a truncation. Preserve the current result but
      // force another read next time rather than retaining the partial tail.
      const signature = bytesRead === length ? sessionFileSignature(info) : "";
      if (lifecycle === "working")
        return {
          signature,
          status: {
            status: "working",
            ...(activityAt != null ? { activityAt } : {}),
            ...(contextUsedPercent != null ? { contextUsedPercent } : {}),
            ...workStart,
          },
        };
      if (lifecycle === "complete" && completionRevision != null)
        return {
          signature,
          status: {
            status: "complete",
            completionRevision,
            ...(activityAt != null ? { activityAt } : {}),
            ...(contextUsedPercent != null ? { contextUsedPercent } : {}),
            ...workStart,
          },
        };
      return {
        signature,
        status: { status: "idle", ...(contextUsedPercent != null ? { contextUsedPercent } : {}), ...workStart },
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function workStartFields(
  value:
    | {
        workStartedAt?: number;
        workStartRevision?: number;
      }
    | undefined,
): WorkStartPair | null {
  return value?.workStartedAt != null && value.workStartRevision != null
    ? { workStartedAt: value.workStartedAt, workStartRevision: value.workStartRevision }
    : null;
}

function ownedSessionFields(
  status: string,
  session: HostSessionPresence | undefined,
  ownedByHost: boolean,
): {
  ownedByHost: boolean;
  status: string;
  workStartedAt?: number;
  workStartRevision?: number;
  contextUsedPercent?: number;
} {
  return {
    ownedByHost,
    status: ownedByHost && session ? reconcileOwnedStatus(status, session.status) : status,
    workStartedAt: undefined,
    workStartRevision: undefined,
    ...(session?.contextUsedPercent != null ? { contextUsedPercent: session.contextUsedPercent } : {}),
    ...(workStartFields(session) ?? {}),
  };
}

function reconcileOwnedStatus(nativeStatus: string, sessionStatus: HostSessionPresence["status"]): string {
  if (["approval", "awaiting-approval", "awaiting-response", "error"].includes(nativeStatus)) return nativeStatus;
  if (sessionStatus === "working") return "working";
  if (sessionStatus === "complete")
    return ["unread", "complete", "completed", "done"].includes(nativeStatus) ? nativeStatus : "complete";
  return "idle";
}

function readContextUsedPercent(tail: string): number | null {
  let offset = tail.lastIndexOf('"type":"token_count"');
  while (offset >= 0) {
    const start = tail.lastIndexOf("\n", offset) + 1;
    const nextLine = tail.indexOf("\n", offset);
    const end = nextLine < 0 ? tail.length : nextLine;
    try {
      const event = JSON.parse(tail.slice(start, end)) as {
        type?: string;
        payload?: {
          type?: string;
          info?: { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown };
        };
      };
      const total = event.payload?.info?.last_token_usage?.total_tokens;
      const window = event.payload?.info?.model_context_window;
      if (
        event.type === "event_msg" &&
        event.payload?.type === "token_count" &&
        typeof total === "number" &&
        Number.isFinite(total) &&
        total >= 0 &&
        typeof window === "number" &&
        Number.isFinite(window) &&
        window > 0
      ) {
        return Math.max(0, Math.min(100, Math.round((total / window) * 100)));
      }
    } catch {
      /* Ignore a truncated first or last JSONL record. */
    }
    offset = tail.lastIndexOf('"type":"token_count"', start - 1);
  }
  return null;
}
