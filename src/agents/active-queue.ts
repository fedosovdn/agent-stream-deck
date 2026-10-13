import { threadIdentity, validTimestamp, type HostSnapshot } from "./local-state.js";
import type { RoutedAgentSlot } from "./types.js";

type QueueCandidate = {
  slot: RoutedAgentSlot;
  group: QueueGroup;
  activityAt: number | null;
  identity: string;
  rank?: WorkingRank;
};

type WorkingRank = {
  trustedRank?: number;
  trustedStartedAt?: number;
  inferredRank?: number;
  firstSeenOrdinal: number;
};

type RankRecord = WorkingRank & {
  disappearedAt?: number;
  previousState: QueueState;
  trustedOwner?: string;
  trustedRevision?: number;
};

type QueueGroup = "attention" | "completion" | "working";
type QueueState = "idle" | "other" | QueueGroup;

const ATTENTION_STATUSES = new Set(["attention", "approval", "awaiting-approval", "awaiting-response", "error"]);
const COMPLETION_STATUSES = new Set(["unread", "complete", "completed", "done"]);
const WORKING_STATUSES = new Set(["working", "thinking"]);
const GROUP_ORDER: Record<QueueGroup, number> = { attention: 0, completion: 1, working: 2 };
const RANK_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Queue-local, process-memory ranks for one enabled Active queue epoch. */
export class ActiveQueueRankIndex {
  private readonly records = new Map<string, RankRecord>();
  private nextFirstSeenOrdinal = 0;
  private nextTrustedFront = -1;
  private nextInferredRank = 1;
  private observed = false;
  private newestTrustedStartedAt: number | undefined;

  clear(): void {
    this.records.clear();
    this.nextFirstSeenOrdinal = 0;
    this.nextTrustedFront = -1;
    this.nextInferredRank = 1;
    this.observed = false;
    this.newestTrustedStartedAt = undefined;
  }

  observe(slots: readonly RoutedAgentSlot[], now = Date.now()): void {
    const present = new Set(slots.flatMap((slot) => (slot.threadKey ? [queueIdentity(slot)] : [])));
    this.prune(now, present);
    const trustedEvents: Array<{
      identity: string;
      slot: RoutedAgentSlot;
      startedAt: number;
      revision: number;
      firstKnown: boolean;
    }> = [];

    for (const slot of slots) {
      if (!slot.threadKey) continue;
      const identity = queueIdentity(slot);
      const state = queueState(slot.status);
      let record = this.records.get(identity);
      const trusted = trustedStart(slot);
      if (!record) {
        record = {
          firstSeenOrdinal: this.nextFirstSeenOrdinal++,
          previousState: state,
        };
        this.records.set(identity, record);
        if (trusted) trustedEvents.push({ identity, slot, ...trusted, firstKnown: true });
        continue;
      }

      if (trusted) {
        if (record.trustedOwner == null) {
          trustedEvents.push({ identity, slot, ...trusted, firstKnown: true });
        } else if (record.trustedOwner !== slot.host.hostId) {
          // Ownership handoff is a baseline, not a new work event.
          record.trustedOwner = slot.host.hostId;
          record.trustedRevision = trusted.revision;
        } else if (record.trustedRevision == null || trusted.revision > record.trustedRevision) {
          trustedEvents.push({ identity, slot, ...trusted, firstKnown: false });
        }
      }

      if (
        state === "working" &&
        record.trustedRank == null &&
        (record.previousState === "idle" || record.previousState === "completion")
      ) {
        record.inferredRank = this.nextInferredRank++;
      }
      record.previousState = state;
    }

    const priorTrustedMaximum = this.newestTrustedStartedAt;
    const frontEvents: typeof trustedEvents = [];
    for (const item of trustedEvents) {
      const record = this.records.get(item.identity)!;
      if (item.firstKnown && record.trustedRank != null) continue;

      // The epoch seed keeps timestamp order at rank zero. Later first-known starts
      // advance only when they are newer than every trusted event already observed.
      if (
        !this.observed ||
        (item.firstKnown && (priorTrustedMaximum == null || item.startedAt > priorTrustedMaximum))
      ) {
        if (!this.observed) record.trustedRank = 0;
        else frontEvents.push(item);
      } else if (!item.firstKnown) {
        frontEvents.push(item);
      } else {
        record.trustedRank = 0;
      }

      record.trustedStartedAt = item.startedAt;
      record.trustedOwner = item.slot.host.hostId;
      record.trustedRevision = item.revision;
      if (this.newestTrustedStartedAt == null || item.startedAt > this.newestTrustedStartedAt) {
        this.newestTrustedStartedAt = item.startedAt;
      }
    }

    // Assign oldest first so the decreasing ranks put the newest event first.
    // Reverse identity ties make the final ascending identity order stable.
    frontEvents.sort((left, right) => left.startedAt - right.startedAt || compareText(right.identity, left.identity));
    for (const item of frontEvents) {
      this.records.get(item.identity)!.trustedRank = this.nextTrustedFront--;
    }
    this.observed = true;
  }

  rank(slot: RoutedAgentSlot): WorkingRank | undefined {
    return slot.threadKey ? this.records.get(queueIdentity(slot)) : undefined;
  }

  private prune(now: number, present: ReadonlySet<string>): void {
    for (const [identity, record] of this.records) {
      if (present.has(identity)) {
        if (record.disappearedAt != null && now - record.disappearedAt >= RANK_RETENTION_MS) {
          this.records.delete(identity);
        } else {
          record.disappearedAt = undefined;
        }
      } else if (record.disappearedAt == null) {
        record.disappearedAt = now;
      } else if (now - record.disappearedAt >= RANK_RETENTION_MS) {
        this.records.delete(identity);
      }
    }
  }
}

/**
 * Filters and ranks slots after host routing has resolved ownership and mirrors.
 * The returned ids are display positions; host/sourceSlot/threadKey still identify
 * the routed command target.
 */
export function projectActiveQueue(
  routedSlots: readonly RoutedAgentSlot[],
  inputs: readonly HostSnapshot[],
  rankIndex = new ActiveQueueRankIndex(),
  now = Date.now(),
): RoutedAgentSlot[] {
  // Observe the full routed catalog before filtering and the six-item projection.
  rankIndex.observe(routedSlots, now);
  const sessionsByHost = new Map(inputs.map((input) => [input.host.hostId, input.snapshot.hostSessions ?? []]));
  let sessionActivityByHost: Map<string, Map<string, number>> | undefined;

  return routedSlots
    .flatMap((slot): QueueCandidate[] => {
      if (!slot.threadKey) return [];
      const group = queueGroup(slot.status);
      if (group == null) return [];
      const identity = threadIdentity(slot.threadKey);
      let sessionActivity: number | null = null;
      if (group === "completion" && (!slot.taskSource || slot.taskSource === "codex")) {
        sessionActivityByHost ??= new Map();
        let activities = sessionActivityByHost.get(slot.host.hostId);
        if (!activities) {
          activities = indexSessionActivity(sessionsByHost.get(slot.host.hostId));
          sessionActivityByHost.set(slot.host.hostId, activities);
        }
        sessionActivity = activities.get(identity) ?? null;
      }
      return [
        {
          slot,
          group,
          activityAt: sessionActivity ?? validTimestamp(slot.activityAt),
          identity,
          rank: group === "working" ? rankIndex.rank(slot) : undefined,
        },
      ];
    })
    .sort(compareCandidates)
    .slice(0, 6)
    .map(({ slot }, id) => ({
      ...slot,
      id,
      sourceSlot: slot.catalogIndex != null && slot.nativeSlot == null ? id : slot.sourceSlot,
    }));
}

function queueGroup(status: string): QueueGroup | null {
  if (ATTENTION_STATUSES.has(status)) return "attention";
  if (COMPLETION_STATUSES.has(status)) return "completion";
  if (WORKING_STATUSES.has(status)) return "working";
  return null;
}

function queueState(status: string): QueueState {
  if (status === "idle") return "idle";
  return queueGroup(status) ?? "other";
}

function compareCandidates(left: QueueCandidate, right: QueueCandidate): number {
  if (left.group !== right.group) return GROUP_ORDER[left.group] - GROUP_ORDER[right.group];
  if (left.group === "working") return compareWorking(left, right);
  if (left.activityAt == null || right.activityAt == null) {
    if (left.activityAt != null) return -1;
    if (right.activityAt != null) return 1;
  } else if (left.activityAt !== right.activityAt) {
    return left.activityAt - right.activityAt;
  }
  return compareLegacyTies(left, right);
}

function compareWorking(left: QueueCandidate, right: QueueCandidate): number {
  const leftTrusted = left.rank?.trustedRank;
  const rightTrusted = right.rank?.trustedRank;
  if (leftTrusted != null || rightTrusted != null) {
    if (leftTrusted == null) return 1;
    if (rightTrusted == null) return -1;
    if (leftTrusted !== rightTrusted) return leftTrusted - rightTrusted;
    const trustedStart = (right.rank?.trustedStartedAt ?? 0) - (left.rank?.trustedStartedAt ?? 0);
    if (trustedStart) return trustedStart;
  } else {
    const leftInferred = left.rank?.inferredRank;
    const rightInferred = right.rank?.inferredRank;
    if (leftInferred != null || rightInferred != null) {
      if (leftInferred == null) return 1;
      if (rightInferred == null) return -1;
      if (leftInferred !== rightInferred) return rightInferred - leftInferred;
    }
    const firstSeen = (left.rank?.firstSeenOrdinal ?? 0) - (right.rank?.firstSeenOrdinal ?? 0);
    if (firstSeen) return firstSeen;
  }
  return (
    compareText(queueIdentity(left.slot), queueIdentity(right.slot)) ||
    compareText(left.slot.host.hostId, right.slot.host.hostId)
  );
}

function compareLegacyTies(left: QueueCandidate, right: QueueCandidate): number {
  return (
    (left.slot.catalogIndex ?? left.slot.sourceSlot) - (right.slot.catalogIndex ?? right.slot.sourceSlot) ||
    left.slot.sourceSlot - right.slot.sourceSlot ||
    compareText(left.identity, right.identity) ||
    compareText(left.slot.host.hostId, right.slot.host.hostId)
  );
}

function queueIdentity(slot: RoutedAgentSlot): string {
  if (slot.taskSource && slot.taskSource !== "codex")
    return `${slot.taskSource}:${slot.host.hostId}:${slot.threadKey ?? ""}`;
  return slot.conversationId
    ? `trusted:${slot.conversationId.toLowerCase()}`
    : `host:${slot.host.hostId}:exact:${slot.threadKey!.toLowerCase()}`;
}

function trustedStart(slot: RoutedAgentSlot): { startedAt: number; revision: number } | null {
  const startedAt = validTimestamp(slot.workStartedAt);
  const revision = slot.workStartRevision;
  return slot.conversationId && startedAt != null && Number.isSafeInteger(revision) && revision! >= 0
    ? { startedAt, revision: revision! }
    : null;
}

function indexSessionActivity(
  sessions: readonly { threadId: string; activityAt: number }[] | undefined,
): Map<string, number> {
  const activities = new Map<string, number>();
  for (const session of sessions ?? []) {
    const activityAt = validTimestamp(session.activityAt);
    if (activityAt == null) continue;
    const identity = threadIdentity(session.threadId);
    const newest = activities.get(identity);
    if (newest == null || activityAt > newest) activities.set(identity, activityAt);
  }
  return activities;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
