import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { buildActiveCatalogDiscoveryExpression, buildSnapshotPayloadExpression } from "./active-catalog-expression.js";
import { readPinnedSidebarSlots } from "./sidebar.js";
import { codexDeckStateRoot } from "../runtime/paths.js";
import { OFFICIAL_KEYCAP_IDS, type OfficialKeycapId } from "./keycaps.js";
import { CodexSessionOwnershipIndex } from "./session-ownership.js";
import type { MicroActionSlot, MicroDirection, MicroSnapshot, ReasoningAdjustment } from "#agents";

type DebugTarget = {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export function selectCodexMainTarget(targets: DebugTarget[]): DebugTarget | undefined {
  const candidates = targets.filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl && target.url.startsWith("app://"),
  );
  const isIndexDocument = (target: DebugTarget): boolean => {
    try {
      return new URL(target.url).pathname === "/index.html";
    } catch {
      return false;
    }
  };
  const isAuxiliarySurface = (target: DebugTarget): boolean => /avatar-overlay|composition-surface/i.test(target.url);

  return (
    candidates.find((target) => isIndexDocument(target) && !new URL(target.url).search) ??
    candidates.find(isIndexDocument) ??
    candidates.find((target) => !isAuxiliarySurface(target) && !target.url.includes("initialRoute=")) ??
    candidates.find((target) => !isAuxiliarySurface(target))
  );
}

type CdpResponse = {
  id?: number;
  result?: {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
};

export type AgentDispatchPlan =
  | { kind: "native"; slot: number; threadKey: string }
  | { kind: "direct"; slot: number; threadKey: string };

const THREAD_ID_SUFFIX = /(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const BARE_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compare renderer IDs without changing the task key sent to Codex. */
export function canonicalThreadId(threadKey: string): string {
  return threadKey.match(THREAD_ID_SUFFIX)?.[1]?.toLowerCase() ?? threadKey;
}

/** Bare renderer IDs may match one prefixed host ID; two different host prefixes never do. */
export function threadKeysEquivalent(left: string, right: string): boolean {
  if (left.toLowerCase() === right.toLowerCase()) return true;
  return (
    canonicalThreadId(left) === canonicalThreadId(right) && (BARE_THREAD_ID.test(left) || BARE_THREAD_ID.test(right))
  );
}

/** Prefer an exact host identity and use a canonical fallback only when it is unambiguous. */
export function selectSidebarThreadId(threadKey: string, sidebarThreadIds: readonly string[]): string | undefined {
  const exact = sidebarThreadIds.find((candidate) => candidate.toLowerCase() === threadKey.toLowerCase());
  if (exact) return exact;
  const matches = [...new Set(sidebarThreadIds)].filter((candidate) => threadKeysEquivalent(threadKey, candidate));
  return matches.length === 1 ? matches[0] : undefined;
}

export function nativeActionKey(slot: MicroActionSlot): string {
  return slot === "ACT10_ACT11" ? "ACT10" : slot;
}

export function resolveAgentDispatch(
  snapshot: MicroSnapshot,
  requestedSlot: number,
  expectedThreadKey?: string,
): AgentDispatchPlan {
  const requested = snapshot.slots.find((item) => item.id === requestedSlot);
  const threadKey = expectedThreadKey ?? requested?.threadKey ?? null;
  if (!threadKey) throw new Error("The selected Codex task has no stable thread identity.");
  const current = snapshot.slots.find((item) => item.threadKey === threadKey);
  return current && snapshot.agentSource !== "pinned"
    ? { kind: "native", slot: current.id, threadKey }
    : { kind: "direct", slot: requestedSlot, threadKey };
}

const execFileAsync = promisify(execFile);
const PORT_FILE = join(codexDeckStateRoot(), "codex-micro-bridge.json");
const WATCHER_STATE_FILE = join(codexDeckStateRoot(), "watcher-state.json");
const DEVICE_STATE = {
  type: "codex-micro-device-state-changed",
  state: { status: "connected", error: null, battery: { percentage: 100, isCharging: true } },
};

const REASONING_ENCODER_KEYS: Record<ReasoningAdjustment, "ENC_CW" | "ENC_CC"> = {
  decrease: "ENC_CW",
  increase: "ENC_CC",
};

const SNAPSHOT_EXPRESSION = `(async () => {
  const urls = [...new Set([
    ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
    ...performance.getEntriesByType('resource').map((entry) => entry.name)
  ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
  const slotSignalsUrl = urls.find((url) => url.includes('/assets/codex-micro-slot-signals-'));
  if (!slotSignalsUrl) throw new Error('Codex Micro slot signals are not loaded.');

  const namespaces = [];
  for (const url of urls) {
    try { namespaces.push(await import(url)); } catch {}
  }
  const exportedValues = namespaces.flatMap((namespace) => Object.values(namespace));
  const definitions = exportedValues.find((candidate) =>
    candidate && typeof candidate === 'object' &&
    candidate.layout?.key === 'codex-micro-layout' &&
    candidate.agentSource?.key === 'codex-micro-agent-source'
  );
  if (!definitions) throw new Error('Codex Micro settings definitions were not found.');

  const bus = exportedValues.find((candidate) => candidate && typeof candidate === 'object' && candidate.handlers instanceof Map && (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
  if (!bus) throw new Error('Codex VS Code event bus was not found.');
  const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
  if ((bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0) {
    dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
  }
  const root = document.getElementById('root');
  const reactKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactContainer$'));
  if (!root || !reactKey) throw new Error('Codex React root was not found.');

  const slotSignals = await import(slotSignalsUrl);
  const resolvers = Object.values(slotSignals).filter((candidate) =>
    candidate && typeof candidate === 'object' &&
    typeof candidate.resolve === 'function' &&
    typeof candidate.createSubscriberAtom === 'function'
  );
  if (resolvers.length === 0) throw new Error('Codex Micro slot resolver was not found.');

  let queue = [root[reactKey]];
  const seen = new Set();
  const queryClients = new Set();
  let found = null;
  while (queue.length && seen.size < 30000 && !found) {
    const fiber = queue.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const maps = [];
    const contextValues = [fiber.memoizedProps?.value];
    let dependency = fiber.dependencies?.firstContext;
    while (dependency) {
      contextValues.push(dependency.memoizedValue);
      dependency = dependency.next;
    }
    for (const value of contextValues) {
      if (value instanceof Map) maps.push(value);
      if (value && typeof value.getQueryCache === 'function' && typeof value.getQueryData === 'function') queryClients.add(value);
    }
    for (const chain of maps) {
      for (const node of chain.values()) {
        if (!node?.store || typeof node.store.get !== 'function') continue;
        for (const resolver of resolvers) {
          try {
            const atom = resolver.resolve(node, chain);
            const slots = node.store.get(atom);
            if (Array.isArray(slots) && slots.length === 6 && slots.every((slot, index) => slot?.id === index)) {
              found = { chain, node, slots };
              break;
            }
          } catch {}
        }
        if (found) break;
      }
      if (found) break;
    }
    queue.push(fiber.child, fiber.sibling);
  }
  if (!found) throw new Error('Codex Micro slot store was not found.');

  let layout = definitions.layout.default;
  let agentSource = definitions.agentSource.default;
  let lightingAutoOff = definitions.lightingAutoOff?.default ?? '3-minutes';

  let settingsResolved = false;
  const directSettingReader = exportedValues.find((candidate) => {
    if (typeof candidate !== 'function' || candidate.length !== 1) return false;
    const source = Function.prototype.toString.call(candidate);
    return source.includes('get-setting') && source.includes('.default');
  });
  if (directSettingReader) {
    try {
      const candidateLayout = await directSettingReader(definitions.layout);
      const candidateAgentSource = await directSettingReader(definitions.agentSource);
      const candidateLightingAutoOff = definitions.lightingAutoOff
        ? await directSettingReader(definitions.lightingAutoOff)
        : lightingAutoOff;
      if (
        candidateLayout?.version === 1 &&
        typeof candidateLayout.slots === 'object' &&
        ['pinned', 'recent', 'priority', 'custom'].includes(candidateAgentSource)
      ) {
        layout = candidateLayout;
        agentSource = candidateAgentSource;
        if (typeof candidateLightingAutoOff === 'string') lightingAutoOff = candidateLightingAutoOff;
        settingsResolved = true;
      }
    } catch {}
  }

  if (!settingsResolved) {
    const settingReaders = exportedValues.filter((candidate) => {
      if (typeof candidate !== 'function' || candidate.length !== 2) return false;
      const source = Function.prototype.toString.call(candidate);
      return source.includes('.key') && source.includes('.default');
    });
    const getStoreValue = found.node.store.get.bind(found.node.store);
    for (const readSetting of settingReaders) {
      try {
        const candidateLayout = await readSetting(getStoreValue, definitions.layout);
        const candidateAgentSource = await readSetting(getStoreValue, definitions.agentSource);
        const candidateLightingAutoOff = definitions.lightingAutoOff
          ? await readSetting(getStoreValue, definitions.lightingAutoOff)
          : lightingAutoOff;
        if (candidateLayout?.version !== 1 || typeof candidateLayout.slots !== 'object') continue;
        if (!['pinned', 'recent', 'priority', 'custom'].includes(candidateAgentSource)) continue;
        layout = candidateLayout;
        agentSource = candidateAgentSource;
        if (typeof candidateLightingAutoOff === 'string') lightingAutoOff = candidateLightingAutoOff;
        break;
      } catch {}
    }
  }
  const toEpoch = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 100000000000 ? value * 1000 : value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  let slots = found.slots.map((slot) => ({
    ...slot,
    activityAt: toEpoch(slot.activityAt) ?? toEpoch(slot.updatedAt) ?? toEpoch(slot.lastActivityAt) ??
      toEpoch(slot.thread?.updatedAt) ?? toEpoch(slot.task?.updatedAt)
  }));

${buildActiveCatalogDiscoveryExpression()}

  const pinnedCacheKey = Symbol.for('codex-deck-live-pinned-slots');
  const sidebarSlots = agentSource === 'pinned'
    ? (${readPinnedSidebarSlots.toString()})(document, slots, pinnedSidebarThreadKeys)
    : undefined;
  if (sidebarSlots) globalThis[pinnedCacheKey] = sidebarSlots;
  if (agentSource === 'pinned') {
    // Cached selection is not proof that a completion was viewed. Ownership
    // separately receives the current activeThreadKey from live DOM state.
    slots = sidebarSlots ?? globalThis[pinnedCacheKey]?.map((slot) => ({ ...slot, selected: false })) ?? slots;
  }

  let usage;
  for (const client of queryClients) {
    try {
      const query = client.getQueryCache().getAll().find((candidate) =>
        JSON.stringify(candidate.queryKey) === '["rate-limit-status"]'
      );
      const refreshKey = Symbol.for('codex-deck-rate-limit-refresh-at');
      const now = Date.now();
      const dataUpdatedAt = Number(query?.state?.dataUpdatedAt) || 0;
      const lastRefreshAttempt = Number(globalThis[refreshKey]) || 0;
      if (query && typeof query.fetch === 'function' && now - dataUpdatedAt >= 15000 && now - lastRefreshAttempt >= 15000) {
        globalThis[refreshKey] = now;
        // Rate-limit refresh is network-backed and must never hold agent status,
        // selection, or lighting behind its response. A later snapshot reads
        // the refreshed query cache once this best-effort request completes.
        try { Promise.resolve(query.fetch()).catch(() => {}); } catch {}
      }
      const data = query?.state?.data;
      const rateLimit = data?.rate_limit;
      if (!rateLimit || typeof rateLimit !== 'object') continue;
      const normalizeWindow = (window, role) => {
        if (!window || typeof window !== 'object') return null;
        const used = Number(window.used_percent);
        if (!Number.isFinite(used)) return null;
        const seconds = Number(window.limit_window_seconds);
        const minutes = Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null;
        const kind = minutes != null && Math.abs(minutes - 300) <= 1 ? 'five-hour'
          : minutes != null && Math.abs(minutes - 10080) <= 1 ? 'weekly'
            : 'other';
        const usedPercent = Math.min(100, Math.max(0, used));
        return {
          id: kind === 'other' ? role + '-' + String(minutes ?? 'unknown') : kind,
          kind,
          usedPercent,
          remainingPercent: 100 - usedPercent,
          windowDurationMins: minutes,
          resetsAt: toEpoch(window.reset_at) ?? null
        };
      };
      const windows = [
        normalizeWindow(rateLimit.primary_window, 'primary'),
        normalizeWindow(rateLimit.secondary_window, 'secondary')
      ].filter(Boolean);
      const available = Number(data.rate_limit_reset_credits?.available_count);
      const applicable = Number(data.rate_limit_reset_credits?.applicable_available_count);
      usage = {
        windows,
        observedAt: Number.isFinite(query.state?.dataUpdatedAt) && query.state.dataUpdatedAt > 0
          ? query.state.dataUpdatedAt
          : Date.now(),
        resetCreditsAvailable: Number.isFinite(available) ? Math.max(0, Math.floor(available)) : null,
        resetCreditsApplicable: Number.isFinite(applicable) ? Math.max(0, Math.floor(applicable)) : null
      };
      break;
    } catch {}
  }

  const html = document.documentElement;
  const body = document.body;
  const themeWords = [
    html.dataset.theme,
    html.dataset.colorScheme,
    html.className,
    body?.dataset?.theme,
    body?.className,
    getComputedStyle(html).colorScheme
  ].filter(Boolean).join(' ').toLowerCase();
  const explicitDark = /(^|[\\s_-])dark($|[\\s_-])/.test(themeWords);
  const explicitLight = /(^|[\\s_-])light($|[\\s_-])/.test(themeWords);
  const backgrounds = [body, document.getElementById('root'), html]
    .filter(Boolean)
    .map((element) => getComputedStyle(element).backgroundColor)
    .map((value) => value.match(/rgba?\\(([^)]+)\\)/)?.[1]?.split(',').map(Number))
    .filter((channels) => channels?.length >= 3 && (channels.length < 4 || channels[3] > 0));
  const background = backgrounds[0];
  const luminance = background
    ? (0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2]) / 255
    : null;
  const theme = explicitDark || (!explicitLight && (luminance != null ? luminance < 0.42 : matchMedia('(prefers-color-scheme: dark)').matches))
    ? 'dark'
    : 'light';
  const activeThreadElement = document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')
    ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]');
  const activeThreadKey = activeThreadElement?.getAttribute('data-app-action-sidebar-thread-id')
    ?? [...document.querySelectorAll('[data-above-composer-conversation-id]')]
      .find((element) => element.getClientRects().length > 0)
      ?.getAttribute('data-above-composer-conversation-id')
    ?? undefined;
  const activeThreadTitle = activeThreadElement
    ? (activeThreadElement.getAttribute('aria-label') ?? activeThreadElement.textContent ?? '').trim().slice(0, 240) || undefined
    : undefined;

  return ${buildSnapshotPayloadExpression(`{
    slots, activeThreadKey, activeThreadTitle, layout, agentSource, lightingAutoOff, theme,
    ...(usage ? { usage } : {})
  }`)};
})()`;

export function buildEnsureThreadActivatedExpression(threadKey: string): string {
  return `(async () => {
      const threadKey = ${JSON.stringify(threadKey)};
      const threadIdSuffix = /(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
      const bareThreadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const canonicalThreadId = (value) => value?.match(threadIdSuffix)?.[1]?.toLowerCase() ?? value;
      const matchesThreadKeys = (left, right) => {
        if (!left || !right) return false;
        if (left.toLowerCase() === right.toLowerCase()) return true;
        return canonicalThreadId(left) === canonicalThreadId(right) &&
          (bareThreadId.test(left) || bareThreadId.test(right));
      };
      const activeSidebarThreadKey = () => document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')
          ?.getAttribute('data-app-action-sidebar-thread-id')
        ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')
          ?.getAttribute('data-app-action-sidebar-thread-id')
        ?? null;
      const activeComposerThreadKey = () => [...document.querySelectorAll('[data-above-composer-conversation-id]')]
        .find((element) => element.getClientRects().length > 0)
        ?.getAttribute('data-above-composer-conversation-id')
        ?? null;
      const sidebarThreadKeys = () => [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .map((element) => element.getAttribute('data-app-action-sidebar-thread-id'))
        .filter(Boolean);
      const selectSidebarThreadKey = (candidate, sidebarCandidates = sidebarThreadKeys()) => {
        const exact = sidebarCandidates.find((sidebarCandidate) => sidebarCandidate.toLowerCase() === candidate.toLowerCase());
        if (exact) return exact;
        const equivalent = [...new Set(sidebarCandidates)].filter((sidebarCandidate) => matchesThreadKeys(sidebarCandidate, candidate));
        return equivalent.length === 1 ? equivalent[0] : null;
      };
      const isActiveThread = () => {
        const sidebarCandidates = sidebarThreadKeys();
        const selectedThreadKey = selectSidebarThreadKey(threadKey, sidebarCandidates);
        const sidebarThreadKey = activeSidebarThreadKey();
        if (sidebarThreadKey) {
          return sidebarThreadKey.toLowerCase() === selectedThreadKey?.toLowerCase();
        }
        const composerThreadKey = activeComposerThreadKey();
        if (!composerThreadKey) return false;
        if (sidebarCandidates.length === 0) {
          return composerThreadKey.toLowerCase() === threadKey.toLowerCase();
        }
        const selectedComposerThreadKey = selectSidebarThreadKey(composerThreadKey, sidebarCandidates);
        return selectedThreadKey != null &&
          selectedThreadKey.toLowerCase() === selectedComposerThreadKey?.toLowerCase();
      };
      const waitForActive = async (duration) => {
        const deadline = Date.now() + duration;
        while (Date.now() < deadline) {
          if (isActiveThread()) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return isActiveThread();
      };
      if (await waitForActive(250)) return 'active';
      const items = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')];
      const selectedThreadKey = selectSidebarThreadKey(threadKey);
      const item = selectedThreadKey
        ? items.find((element) => element.getAttribute('data-app-action-sidebar-thread-id') === selectedThreadKey)
        : null;
      if (!item) return 'missing';
      const selector = 'button, a, [role="button"], [role="link"]';
      const clickable = item.matches(selector) ? item : item.querySelector(selector) ?? item.closest(selector) ?? item;
      if (typeof clickable.click === 'function') clickable.click();
      else clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return await waitForActive(1500) ? 'opened' : 'failed';
    })()`;
}

export class CodexMicroRendererBridge {
  private socket?: WebSocket;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: CdpResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private connecting?: Promise<void>;
  private connectionAbort?: AbortController;
  private generation = 0;
  private lastSnapshot?: MicroSnapshot;
  private readonly agentPresses = new WeakMap<AbortSignal, AgentDispatchPlan>();
  private sessionOwnership = new CodexSessionOwnershipIndex();
  private readonly evaluationNamespace = randomUUID();

  constructor(private readonly log: (message: string) => void) {}

  async refresh(): Promise<MicroSnapshot> {
    const generation = this.generation;
    try {
      await this.ensureConnected();
      this.checkGeneration(generation);
      const nativeSnapshot = await this.evaluate<MicroSnapshot>(SNAPSHOT_EXPRESSION);
      this.checkGeneration(generation);
      const snapshot = await this.sessionOwnership.annotate(nativeSnapshot);
      this.checkGeneration(generation);
      this.lastSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      if (generation === this.generation) this.disconnect();
      throw error;
    }
  }

  async sendAgent(slot: number, act: 0 | 1, expectedThreadKey?: string, signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    if (!Number.isInteger(slot) || slot < 0 || slot > 5) throw new Error(`Ungültiger Micro-Agent-Slot: ${slot}`);
    if (act === 0 && signal) {
      const pressed = this.agentPresses.get(signal);
      this.agentPresses.delete(signal);
      if (pressed?.kind !== "native" || signal.aborted) return;
      await this.dispatch(
        "codex-micro-hid-event",
        {
          event: { key: `AG0${pressed.slot}`, act: 0, slot: pressed.slot, threadKey: pressed.threadKey },
        },
        "codex-micro-hid-event",
      );
      return;
    }
    const snapshot = act === 1 ? await this.refresh() : (this.lastSnapshot ?? (await this.refresh()));
    this.checkGeneration(generation);
    if (signal?.aborted) return;
    const plan = resolveAgentDispatch(snapshot, slot, expectedThreadKey);
    if (plan.kind === "native") {
      if (plan.slot !== slot) {
        this.log(`Agent slot ${slot + 1} changed before dispatch; using current native slot ${plan.slot + 1}.`);
      }
      await this.dispatch(
        "codex-micro-hid-event",
        {
          event: { key: `AG0${plan.slot}`, act, slot: plan.slot, threadKey: plan.threadKey },
        },
        "codex-micro-hid-event",
      );
      this.checkGeneration(generation);
      if (act === 0) return;
      if (signal) this.agentPresses.set(signal, plan);
    } else {
      if (act === 0) return;
      this.log(`Selecting Codex task ${plan.threadKey} by its exact native thread identity.`);
      await this.dispatch(
        "codex-micro-hid-event",
        {
          event: { key: `AG0${plan.slot}`, act: 1, slot: plan.slot, threadKey: plan.threadKey },
        },
        "codex-micro-hid-event",
      );
      this.checkGeneration(generation);
      const conversationId = snapshot.activeCatalog?.candidates.find(
        (candidate) => candidate.threadKey === plan.threadKey,
      )?.conversationId;
      this.sessionOwnership.markOpened(plan.threadKey, conversationId ?? null);
      return;
    }
    await this.ensureThreadActivated(plan.threadKey);
    this.checkGeneration(generation);
    const conversationId = snapshot.activeCatalog?.candidates.find(
      (candidate) => candidate.threadKey === plan.threadKey,
    )?.conversationId;
    this.sessionOwnership.markOpened(plan.threadKey, conversationId);
  }

  private async ensureThreadActivated(threadKey: string): Promise<void> {
    const result = await this.evaluate<"active" | "opened" | "missing" | "failed">(
      buildEnsureThreadActivatedExpression(threadKey),
    );
    if (result === "active" || result === "opened") return;
    if (result === "missing") {
      throw new Error(
        "The exact Codex task is not present in this host's loaded sidebar. Open or pin it once in Codex, then retry.",
      );
    }
    throw new Error("Codex received the task selection but did not activate the requested thread.");
  }

  async sendAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
    const key = nativeActionKey(slot);
    await this.dispatch(
      "codex-micro-hid-event",
      { event: { key, act, slot: null, threadKey: null } },
      "codex-micro-hid-event",
    );
  }

  async sendJoystick(direction: MicroDirection, distance: 0 | 1): Promise<void> {
    const angle: Record<MicroDirection, number> = { up: 0.75, right: 0, down: 0.25, left: 0.5 };
    await this.dispatch(
      "codex-micro-joystick-event",
      { event: { angle: angle[direction], distance } },
      "codex-micro-joystick-event",
    );
  }

  async sendEncoder(act: 0 | 1): Promise<void> {
    await this.dispatch(
      "codex-micro-hid-event",
      { event: { key: "ENC", act, slot: null, threadKey: null } },
      "codex-micro-hid-event",
    );
  }

  async adjustReasoning(direction: ReasoningAdjustment): Promise<void> {
    await this.dispatch(
      "codex-micro-hid-event",
      {
        event: { key: REASONING_ENCODER_KEYS[direction], act: 2, slot: null, threadKey: null },
      },
      "codex-micro-hid-event",
    );
  }

  async runKeycap(keycapId: OfficialKeycapId): Promise<void> {
    const generation = this.generation;
    if (!OFFICIAL_KEYCAP_IDS.includes(keycapId)) throw new Error(`Unknown Codex Micro keycap: ${keycapId}`);
    if (keycapId === "MIC") {
      await this.sendAction("ACT10_ACT11", 1);
      this.checkGeneration(generation);
      await this.sendAction("ACT10_ACT11", 0);
      return;
    }
    await this.ensureConnected();
    this.checkGeneration(generation);
    const expression = `(async () => {
      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])];
      const moduleUrl = (prefix) => urls.find((value) => value.includes('/assets/' + prefix));
      const layoutUrl = moduleUrl('codex-micro-layout-');
      const commandsUrl = moduleUrl('run-command-');
      const bridgeUrl = moduleUrl('codex-micro-bridge-');
      const vscodeUrl = moduleUrl('vscode-api-');
      if (!layoutUrl) throw new Error('Codex Micro keycap registry is unavailable.');
      const layout = await import(layoutUrl);
      const keycapGetter = Object.values(layout).find((candidate) => {
        if (typeof candidate !== 'function') return false;
        try { return candidate('FAST')?.id === 'FAST'; } catch { return false; }
      });
      if (typeof keycapGetter !== 'function') throw new Error('Codex Micro keycap registry changed.');
      const keycap = keycapGetter(${JSON.stringify(keycapId)});
      const action = keycap?.action;
      if (!action) throw new Error('The selected Codex Micro keycap has no action.');

      if (action.type === 'command') {
        let commandRunner = null;
        if (commandsUrl) {
          const commands = await import(commandsUrl);
          if (typeof commands.i === 'function') commandRunner = commands.i;
        }
        if (!commandRunner && bridgeUrl) {
          const bridgeSource = await (await fetch(bridgeUrl)).text();
          const runnerMatch = bridgeSource.match(/([A-Za-z_$][\\w$]*)\\(\\s*[A-Za-z_$][\\w$]*\\??\\.command\\s*,["'\\x60]codex_micro_hid["'\\x60]\\)/);
          const runnerLocal = runnerMatch?.[1];
          const importPattern = /import\\s*\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']/g;
          let importMatch;
          while (runnerLocal && (importMatch = importPattern.exec(bridgeSource))) {
            for (const specifier of importMatch[1].split(',')) {
              const parts = specifier.trim().split(/\\s+as\\s+/);
              const exportName = parts[0];
              const localName = parts[1] ?? parts[0];
              if (localName !== runnerLocal) continue;
              const namespace = await import(new URL(importMatch[2], bridgeUrl).href);
              if (typeof namespace[exportName] === 'function') commandRunner = namespace[exportName];
              break;
            }
            if (commandRunner) break;
          }
        }
        if (typeof commandRunner !== 'function') throw new Error('Codex command runner is unavailable.');
        const handled = commandRunner(action.command, 'codex_micro_hid');
        if (!handled) throw new Error('This Codex command is not active in the current view.');
        return true;
      }

      if (!vscodeUrl) throw new Error('Codex VS Code event module is unavailable for this keycap.');
      const vscode = await import(vscodeUrl);
      const bus = [vscode.g, vscode.m, ...Object.values(vscode)].find((candidate) => candidate && typeof candidate === 'object' && (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
      if (!bus) throw new Error('Codex VS Code event bus was not found.');
      if (action.type === 'external-url' && typeof bus.dispatchMessage === 'function') {
        bus.dispatchMessage('open-in-browser', { url: action.url, source: 'manual', initiator: 'open_in_browser_bridge' });
        return true;
      }
      if (action.type === 'composer-text' && typeof bus.dispatchHostMessage === 'function') {
        bus.dispatchHostMessage({ type: 'codex-micro-insert-composer-text', text: action.text });
        return true;
      }
      throw new Error('This Codex Micro keycap action is not supported as a standalone key.');
    })()`;
    try {
      await this.evaluate(expression);
      this.checkGeneration(generation);
    } catch (error) {
      if (generation === this.generation) this.disconnect();
      throw error;
    }
  }

  close(): void {
    this.generation++;
    this.connectionAbort?.abort();
    this.connectionAbort = undefined;
    this.connecting = undefined;
    this.lastSnapshot = undefined;
    this.sessionOwnership = this.sessionOwnership.fork();
    this.disconnect();
  }

  private checkGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("Codex bridge generation was retired.");
  }

  private async dispatch(type: string, payload: object, requiredHandler: string): Promise<void> {
    const generation = this.generation;
    await this.ensureConnected();
    this.checkGeneration(generation);
    const message = { type, ...payload };
    const expression = `(async () => {
      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
      let bus = null;
      for (const url of urls) {
        try {
          const namespace = await import(url);
          bus = Object.values(namespace).find((candidate) => candidate && typeof candidate === 'object' && candidate.handlers instanceof Map && (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
          if (bus) break;
        } catch {}
      }
      if (!bus) throw new Error('Codex VS Code event bus was not found.');
      const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
      if ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0) {
        dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
      }
      const deadline = Date.now() + 1200;
      while ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0) throw new Error('Codex Micro input handler is not active.');
      dispatch.call(bus, ${JSON.stringify(message)});
      return true;
    })()`;
    try {
      await this.evaluate(expression);
      this.checkGeneration(generation);
    } catch (error) {
      if (generation === this.generation) this.disconnect();
      throw error;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    const abort = new AbortController();
    const pending = this.connect(this.generation, abort.signal);
    this.connectionAbort = abort;
    this.connecting = pending;
    try {
      await pending;
    } finally {
      if (this.connecting === pending) this.connecting = undefined;
      if (this.connectionAbort === abort) this.connectionAbort = undefined;
    }
  }

  private async connect(generation: number, signal: AbortSignal): Promise<void> {
    const port = await discoverDebugPort(signal);
    this.checkGeneration(generation);
    const targets = await fetchJson<DebugTarget[]>(`http://127.0.0.1:${port}/json/list`, signal);
    this.checkGeneration(generation);
    const target = selectCodexMainTarget(targets);
    if (!target?.webSocketDebuggerUrl) throw new Error("Kein Codex-Hauptfenster mit Debug-Brücke gefunden.");

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("open", opened);
        socket.removeListener("error", failed);
        socket.removeListener("close", closed);
        signal.removeEventListener("abort", aborted);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        // ws emits an error when terminating a CONNECTING handshake.
        socket.once("error", () => undefined);
        socket.terminate();
        reject(error);
      };
      const closed = () => failed(new Error("Codex closed the bridge during connection."));
      const aborted = () => failed(new Error("Codex bridge generation was retired."));
      const timer = setTimeout(() => failed(new Error("Zeitüberschreitung beim Verbinden mit Codex.")), 3000);
      socket.once("open", opened);
      socket.once("error", failed);
      socket.once("close", closed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
    if (generation !== this.generation) {
      socket.terminate();
      this.checkGeneration(generation);
    }
    socket.on("message", (raw) => this.handleMessage(String(raw)));
    socket.on("close", () => this.disconnect(socket));
    socket.on("error", () => this.disconnect(socket));
    this.socket = socket;
    this.log(`Native Codex-Micro-Brücke verbunden (Port ${port}, ${target.url}).`);
  }

  private evaluate<T = unknown>(expression: string): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Codex-Micro-Brücke ist nicht verbunden."));
    const id = ++this.nextId;
    // CDP may garbage-collect an awaited Runtime.evaluate promise while a
    // renderer handler or dynamic import is still pending. Keep the exact
    // promise reachable from the renderer until after our own timeout.
    const retainedExpression = retainEvaluationPromise(expression, `${this.evaluationNamespace}-${id}`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex-Runtime-Antwort hat zu lange gedauert."));
      }, 5000);
      this.pending.set(id, {
        timer,
        reject,
        resolve: (message) => {
          if (message.error) return reject(new Error(message.error.message ?? "Unbekannter CDP-Fehler."));
          const result = message.result;
          if (result?.exceptionDetails)
            return reject(
              new Error(
                result.exceptionDetails.exception?.description ??
                  result.exceptionDetails.text ??
                  "Codex-Auswertung fehlgeschlagen.",
              ),
            );
          resolve(result?.result?.value as T);
        },
      });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression: retainedExpression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  }

  private handleMessage(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private disconnect(expected?: WebSocket): void {
    if (expected && this.socket !== expected) return;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Codex-Micro-Brücke wurde getrennt."));
    }
    this.pending.clear();
  }
}

export class CodexNotRunningError extends Error {
  constructor() {
    super("Codex is not running.");
    this.name = "CodexNotRunningError";
  }
}

export function localBridgeFailureReason(error: unknown): "codex-not-running" | "local-bridge-unavailable" {
  return error instanceof CodexNotRunningError ? "codex-not-running" : "local-bridge-unavailable";
}

export function macCodexExecutablePathFromWatcherState(state: string): string | null | undefined {
  try {
    const lastGeneration = (JSON.parse(state) as { lastGeneration?: unknown }).lastGeneration;
    if (lastGeneration === null) return null;
    if (typeof lastGeneration !== "string") return undefined;
    const pathOffset = lastGeneration.lastIndexOf(":/");
    const executablePath = pathOffset === -1 ? "" : lastGeneration.slice(pathOffset + 1);
    return executablePath.startsWith("/") ? executablePath : undefined;
  } catch {
    return undefined;
  }
}

export function hasMacCodexExecutable(commands: Iterable<string>, executablePath: string): boolean {
  for (const line of commands) {
    const command = line.trimStart();
    const exactExecutable =
      command.startsWith(executablePath) &&
      (command.length === executablePath.length || /\s/.test(command[executablePath.length] ?? ""));
    if (exactExecutable) return true;
  }
  return false;
}

export function retainEvaluationPromise(expression: string, id: string | number): string {
  const key = `codex-deck-${id}`;
  return `(() => {
    const store = globalThis.__codexDeckPendingEvaluations ??= new Map();
    const pending = Promise.resolve((${expression}));
    store.set(${JSON.stringify(key)}, pending);
    setTimeout(() => store.delete(${JSON.stringify(key)}), 10000);
    return pending;
  })()`;
}

async function discoverDebugPort(signal: AbortSignal): Promise<number> {
  if (process.platform === "darwin") {
    const fromFile = await readPortFile();
    if (fromFile && (await isDebugPort(fromFile, signal))) return fromFile;
    signal.throwIfAborted();
    const executablePath = await readMacCodexExecutablePath();
    signal.throwIfAborted();
    if (executablePath === null) throw new CodexNotRunningError();
    if (executablePath === undefined) throw new Error("Codex launcher state is unavailable.");
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="], { timeout: 4000, signal });
    const commands = stdout.split("\n");
    for (const line of commands) {
      if (!hasMacCodexExecutable([line], executablePath) || !line.includes("--remote-debugging-address=127.0.0.1"))
        continue;
      const port = Number.parseInt(line.match(/--remote-debugging-port(?:=|\s+)(\d+)/)?.[1] ?? "", 10);
      if (Number.isInteger(port) && (await isDebugPort(port, signal))) return port;
    }
    throw new Error("Codex wurde nicht über den macOS-Micro-Aktivierungsstarter geöffnet.");
  }
  const fromFile = await readPortFile();
  if (fromFile && (await isDebugPort(fromFile, signal))) return fromFile;
  signal.throwIfAborted();
  if (process.platform !== "win32")
    throw new Error("Die native Codex-Micro-Brücke wird auf dieser Plattform nicht unterstützt.");

  const command =
    "$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch '--type=' }); if ($processes.Count -eq 0) { '__CODEX_DECK_NOT_RUNNING__' } else { $processes | Where-Object { $_.CommandLine -match '--remote-debugging-port=(\\d+)' } | ForEach-Object { if ($_.CommandLine -match '--remote-debugging-port=(\\d+)') { $Matches[1] } } | Select-Object -Unique }";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    timeout: 4000,
    signal,
  });
  const values = stdout.split(/\s+/);
  if (values.includes("__CODEX_DECK_NOT_RUNNING__")) throw new CodexNotRunningError();
  for (const value of values) {
    const port = Number.parseInt(value, 10);
    if (Number.isInteger(port) && (await isDebugPort(port, signal))) return port;
  }
  throw new Error("Codex wurde nicht über den Micro-Aktivierungsstarter geöffnet.");
}

async function readPortFile(): Promise<number | null> {
  try {
    const data = JSON.parse(await readFile(PORT_FILE, "utf8")) as { port?: unknown };
    const port = Number(data.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

async function readMacCodexExecutablePath(): Promise<string | null | undefined> {
  try {
    return macCodexExecutablePathFromWatcherState(await readFile(WATCHER_STATE_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

async function isDebugPort(port: number, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(750)]),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
  if (!response.ok) throw new Error(`Codex-Debug-Endpunkt antwortete mit ${response.status}.`);
  return (await response.json()) as T;
}
