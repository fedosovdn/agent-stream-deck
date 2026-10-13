import streamDeck, { type KeyAction } from "@elgato/streamdeck";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexDeckStateRoot } from "../runtime/paths.js";
import { ActiveQueueRankIndex, projectActiveQueue } from "#agents";
import type { CodexSource } from "#codex";
import { readCodexBarUsage } from "#usage";
import type { OfficialKeycapId } from "#codex";
import { LocalActivityIndex } from "#agents";
import {
  renderAgentBlackKey,
  renderAgentKey,
  renderBuiltinKeycap,
  renderFallbackKeycap,
  renderHostTargetKey,
  renderImportedKeycap,
  renderRateLimitResetKey,
  renderUsageLimitKey,
  renderUsageOverviewKey,
  type BuiltinIconName,
} from "./render.js";
import { openCodexThread } from "#codex";
import type { OpenCodeSource } from "#opencode";
import type { T3CodeSource } from "#t3code";
import { visualStatusFromMicro } from "#agents";
import { parseTaskSource, selectTaskCandidates, usesActiveQueue } from "#agents";
import type {
  HostHealth,
  MicroActionSlot,
  MicroDirection,
  MicroSnapshot,
  ReasoningAdjustment,
  RoutedAgentSlot,
  TaskSource,
  UsageLimitMode,
  UsageSnapshot,
  UsageWindowKind,
} from "#agents";
import { selectAccountUsage, selectUsageWindow, usageTheme, type AccountUsageSource } from "#usage";

export type FixedIconSource = { kind: "local"; keycapId: string } | { kind: "builtin"; name: BuiltinIconName };

type FixedIconRegistration = { action: KeyAction<{}>; source: FixedIconSource };
type AgentRegistration = { action: KeyAction<{}>; slot: number };
type MicroActionRegistration = { action: KeyAction<{}>; slot: MicroActionSlot };
type UsageLimitRegistration = { action: KeyAction<{}>; mode: UsageLimitMode };
type ActionIdentity = { id: string };
type TitleClearState = { action: KeyAction<{}>; revision: number; cleared: boolean; pending?: Promise<void> };
type AgentPress = { assignment?: RoutedAgentSlot; down: Promise<void>; abort: AbortController };
type AgentButton = { press?: AgentPress; active: Set<AgentPress>; tail?: Promise<void> };
export type AgentDisplaySettings = {
  showContextRings?: boolean;
  activeQueueEnabled?: boolean;
  taskSource?: TaskSource;
};

type DeckControllerDependencies = { codex: CodexSource; openCode: OpenCodeSource; t3Code: T3CodeSource };

const USER_ICON_ROOT = join(codexDeckStateRoot(), "icons");

export class DeckController {
  private readonly agents = new Map<string, AgentRegistration>();
  private readonly microActions = new Map<string, MicroActionRegistration>();
  private readonly fixedActions = new Map<string, FixedIconRegistration>();
  private readonly keycapImages = new Map<string, Promise<string | null>>();
  private readonly lastImages = new Map<string, string>();
  private readonly titleClears = new Map<string, TitleClearState>();
  private titleListener?: ReturnType<typeof streamDeck.actions.onTitleParametersDidChange>;
  private readonly hostToggleActions = new Map<string, KeyAction<{}>>();
  private readonly usageLimitActions = new Map<string, UsageLimitRegistration>();
  private readonly usageOverviewActions = new Map<string, KeyAction<{}>>();
  private readonly rateLimitResetActions = new Map<string, KeyAction<{}>>();
  private readonly activityIndex = new LocalActivityIndex();
  private readonly activeQueueRankIndex = new ActiveQueueRankIndex();
  private readonly agentButtons = new Map<string, AgentButton>();
  private codexBarUsage?: UsageSnapshot;
  private routedSlots: RoutedAgentSlot[] = [];
  private poll?: NodeJS.Timeout;
  private animation?: NodeJS.Timeout;
  private refreshInFlight?: Promise<void>;
  private stopped = false;
  private animationFrame = 0;
  private lastAssignmentSignature = "";
  private lastStatusSignature = "";
  private lastLayoutSignature = "";
  private lastHostHealthSignature = "";
  private showContextRings = true;
  private activeQueueEnabled = false;
  private taskSource: TaskSource = "Codex";

  constructor(private readonly sources: DeckControllerDependencies) {}

  private get codex(): CodexSource {
    return this.sources.codex;
  }
  private get openCode(): OpenCodeSource {
    return this.sources.openCode;
  }

  private get t3Code(): T3CodeSource {
    return this.sources.t3Code;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.titleListener?.dispose();
    this.titleListener = streamDeck.actions.onTitleParametersDidChange((event) => {
      if (!event.payload.title) return;
      const state = this.titleClears.get(event.action.id);
      if (state) {
        state.revision++;
        state.cleared = false;
      }
    });
    await this.loadAgentDisplaySettings();
    await this.codex.start();
    await this.syncTaskSourceDemand();
    await this.refresh();
    this.scheduleRefresh();
    this.scheduleAnimation();
  }

  private async loadAgentDisplaySettings(): Promise<void> {
    try {
      const settings = await streamDeck.settings.getGlobalSettings<AgentDisplaySettings>();
      this.showContextRings = settings.showContextRings !== false;
      this.activeQueueEnabled = settings.activeQueueEnabled === true;
      this.taskSource = parseTaskSource(settings.taskSource);
    } catch (error) {
      streamDeck.logger.warn(`Agent display settings were unavailable; using defaults: ${String(error)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.titleListener?.dispose();
    this.titleListener = undefined;
    this.titleClears.clear();
    if (this.poll) clearInterval(this.poll);
    if (this.animation) clearInterval(this.animation);
    for (const button of this.agentButtons.values()) for (const press of button.active) press.abort.abort();
    this.agentButtons.clear();
    this.codex.stop();
    this.openCode.stop();
    this.t3Code.stop();
  }

  registerAgent(slot: number, action: KeyAction<{}>): void {
    this.resetTitleClear(action);
    this.agents.set(action.id, { action, slot });
    void this.renderAgent({ action, slot });
  }

  unregisterAgent(action: ActionIdentity): void {
    const button = this.agentButtons.get(action.id);
    if (button) for (const press of button.active) press.abort.abort();
    this.agentButtons.delete(action.id);
    this.unregister(action, this.agents);
  }

  setAgentDisplaySettings(settings: AgentDisplaySettings): void {
    const showContextRings = settings.showContextRings !== false;
    const activeQueueEnabled = settings.activeQueueEnabled === true;
    const taskSource = parseTaskSource(settings.taskSource);
    const contextRingsChanged = this.showContextRings !== showContextRings;
    const activeQueueChanged = this.activeQueueEnabled !== activeQueueEnabled;
    const taskSourceChanged = this.taskSource !== taskSource;
    if (!contextRingsChanged && !activeQueueChanged && !taskSourceChanged) return;
    this.showContextRings = showContextRings;
    this.activeQueueEnabled = activeQueueEnabled;
    this.taskSource = taskSource;
    if (activeQueueChanged || taskSourceChanged) {
      this.activeQueueRankIndex.clear();
      if (taskSourceChanged) {
        const synchronize = this.syncTaskSourceDemand();
        void this.refreshDisplay().catch(() => streamDeck.logger.error("Agent display settings refresh failed."));
        void synchronize
          .then(() => this.t3Code.refresh())
          .then(() => this.refreshDisplay())
          .catch(() => streamDeck.logger.error("Agent display settings refresh failed."));
      } else {
        void this.refreshDisplay().catch(() => streamDeck.logger.error("Agent display settings refresh failed."));
      }
    } else {
      void Promise.all([...this.agents.values()].map((registration) => this.renderAgent(registration)));
    }
  }

  registerMicroAction(slot: MicroActionSlot, action: KeyAction<{}>): void {
    this.resetTitleClear(action);
    this.microActions.set(action.id, { action, slot });
    void this.renderMicroAction({ action, slot });
  }

  unregisterMicroAction(action: ActionIdentity): void {
    this.unregister(action, this.microActions);
  }

  registerFixedAction(action: KeyAction<{}>, source: FixedIconSource): void {
    this.resetTitleClear(action);
    this.fixedActions.set(action.id, { action, source });
    void this.renderFixedAction({ action, source });
  }

  unregisterFixedAction(action: ActionIdentity): void {
    this.unregister(action, this.fixedActions);
  }

  registerHostToggle(action: KeyAction<{}>): void {
    this.resetTitleClear(action);
    this.hostToggleActions.set(action.id, action);
    void this.renderHostToggle(action);
  }

  unregisterHostToggle(action: ActionIdentity): void {
    this.unregister(action, this.hostToggleActions);
  }

  registerUsageLimit(action: KeyAction<{}>, mode: UsageLimitMode): void {
    this.resetTitleClear(action);
    const registration = { action, mode };
    this.usageLimitActions.set(action.id, registration);
    this.renderUsageAction("Usage limit", action, () => this.renderUsageLimit(registration));
  }

  updateUsageLimitMode(action: KeyAction<{}>, mode: UsageLimitMode): void {
    if (this.usageLimitActions.get(action.id)?.action !== action) this.resetTitleClear(action);
    const registration = { action, mode };
    this.usageLimitActions.set(action.id, registration);
    this.renderUsageAction("Usage limit", action, () => this.renderUsageLimit(registration));
  }

  unregisterUsageLimit(action: ActionIdentity): void {
    this.unregister(action, this.usageLimitActions);
  }

  registerUsageOverview(action: KeyAction<{}>): void {
    this.resetTitleClear(action);
    this.usageOverviewActions.set(action.id, action);
    this.renderUsageAction("Usage overview", action, () => this.renderUsageOverview(action));
  }

  unregisterUsageOverview(action: ActionIdentity): void {
    this.unregister(action, this.usageOverviewActions);
  }

  registerRateLimitReset(action: KeyAction<{}>): void {
    this.resetTitleClear(action);
    this.rateLimitResetActions.set(action.id, action);
    this.renderUsageAction("Rate-limit reset", action, () => this.renderRateLimitReset(action));
  }

  unregisterRateLimitReset(action: ActionIdentity): void {
    this.unregister(action, this.rateLimitResetActions);
  }

  async toggleTargetHost(): Promise<void> {
    await this.renderAll();
  }

  sendAgent(slot: number, act: 0 | 1, action: ActionIdentity): Promise<void> {
    if (act === 0) {
      const button = this.agentButtons.get(action.id);
      const press = button?.press;
      if (!button || !press) return Promise.resolve();
      button.press = undefined;
      return this.enqueueAgent(action.id, button, async () => {
        try {
          try {
            await press.down;
          } catch {
            /* The native owner may already have delivered the press. */
          }
          if (
            press.abort.signal.aborted ||
            !press.assignment ||
            (press.assignment.taskSource && press.assignment.taskSource !== "codex")
          )
            return;
          await this.codex.microBridge.sendAgent(
            press.assignment.sourceSlot,
            0,
            press.assignment.threadKey!,
            press.abort.signal,
          );
          void this.refresh();
        } finally {
          button.active.delete(press);
        }
      });
    }
    const button = this.agentButtons.get(action.id) ?? { active: new Set<AgentPress>() };
    this.agentButtons.set(action.id, button);
    const assignment = this.routedSlots[slot];
    const emptyAllowed = this.effectiveActiveQueueEnabled();
    const abort = new AbortController();
    const down = this.enqueueAgent(action.id, button, async () => {
      if (abort.signal.aborted) return;
      if (!assignment) {
        if (emptyAllowed) return;
        throw new Error(`No Codex task is assigned to global agent slot ${slot + 1}.`);
      }
      if (assignment.taskSource === "t3code") {
        if (await this.t3Code.open(assignment, abort.signal)) await this.refreshDisplay();
        return;
      }
      if (assignment.taskSource === "opencode") {
        if (await this.openCode.open(assignment, abort.signal)) await this.refreshDisplay();
        return;
      }
      if (!assignment.threadKey) throw new Error("The selected Codex task has no stable thread identity.");
      await this.codex.microBridge.sendAgent(assignment.sourceSlot, 1, assignment.threadKey, abort.signal);
    });
    const press = { assignment, down, abort };
    button.press = press;
    button.active.add(press);
    return down;
  }

  private enqueueAgent(id: string, button: AgentButton, operation: () => Promise<void>): Promise<void> {
    const previous = button.tail;
    const pending = previous ? previous.catch(() => undefined).then(operation) : operation();
    button.tail = pending;
    void pending
      .finally(() => {
        if (button.tail !== pending) return;
        button.tail = undefined;
        if (button.active.size === 0 && this.agentButtons.get(id) === button) this.agentButtons.delete(id);
      })
      .catch(() => undefined);
    return pending;
  }

  async sendMicroAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
    await this.codex.microBridge.sendAction(slot, act);
  }

  async sendJoystick(direction: MicroDirection, distance: 0 | 1): Promise<void> {
    await this.codex.microBridge.sendJoystick(direction, distance);
  }

  async sendEncoder(act: 0 | 1): Promise<void> {
    await this.codex.microBridge.sendEncoder(act);
  }

  async adjustReasoning(direction: ReasoningAdjustment): Promise<void> {
    await this.codex.microBridge.adjustReasoning(direction);
  }

  async runKeycap(keycapId: OfficialKeycapId): Promise<void> {
    await this.codex.microBridge.runKeycap(keycapId);
  }

  async createTask(): Promise<void> {
    await openCodexThread("new");
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refreshOnce();
    this.refreshInFlight = pending;
    try {
      await pending;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    }
  }

  private async refreshOnce(): Promise<void> {
    if (process.platform === "darwin") this.codexBarUsage = await readCodexBarUsage();
    await Promise.all([this.codex.refresh(), this.t3Code.refresh()]);
    await this.refreshDisplay();
  }

  private syncTaskSourceDemand(): Promise<void> {
    this.t3Code.syncDemand(this.taskSource, this.codex.localHost, this.stopped);
    return this.openCode.syncDemand(this.taskSource, this.codex.localHost, this.stopped);
  }

  private async refreshDisplay(): Promise<void> {
    this.openCode.refreshOpenCodeSnapshot();
    const inputs = this.codex.localSnapshot ? [this.codex.localSnapshot] : [];
    const healthSignature = `${this.codex.localHealth.state}:${this.codex.localHealth.reason ?? ""}`;
    if (healthSignature !== this.lastHostHealthSignature) {
      this.lastHostHealthSignature = healthSignature;
      streamDeck.logger.info(`Local Codex health: ${healthSignature}`);
    }
    const now = Date.now();
    const activeQueueEnabled = this.effectiveActiveQueueEnabled();
    const queueInputs = activeQueueEnabled && this.codex.localHealth.reason === "codex-not-running" ? [] : inputs;
    const codexSlots = activeQueueEnabled
      ? this.activityIndex.mergeActiveCatalog(queueInputs[0], now)
      : this.activityIndex.merge(this.codex.localSnapshot, now);
    const merged = selectTaskCandidates(this.taskSource, codexSlots, this.openCode.openCodeSlots, this.t3Code.slots);
    this.routedSlots = activeQueueEnabled
      ? projectActiveQueue(merged, queueInputs, this.activeQueueRankIndex, now)
      : merged;

    const assignments = this.routedSlots
      .map((slot) => `${slot.id}=${slot.taskSource ?? "codex"}:${slot.host.platform}`)
      .join(" ");
    if (assignments !== this.lastAssignmentSignature) {
      this.lastAssignmentSignature = assignments;
      streamDeck.logger.info(`Agent slots: ${assignments || "empty"}`);
    }

    const statuses = this.routedSlots
      .map((slot) => `${slot.taskSource ?? "codex"}:${slot.host.hostId}:${slot.status}:${slot.selected}`)
      .join(",");
    if (statuses !== this.lastStatusSignature) {
      this.lastStatusSignature = statuses;
      streamDeck.logger.info(
        `Agent states: ${this.routedSlots.map((slot) => `${slot.id + 1}=${slot.status}`).join(" ") || "empty"}`,
      );
    }

    const target = this.targetSnapshot();
    const layout = JSON.stringify({ theme: target?.theme, slots: target?.layout.slots });
    if (layout !== this.lastLayoutSignature) {
      this.lastLayoutSignature = layout;
      this.keycapImages.clear();
      if (target)
        streamDeck.logger.info(`Codex Micro layout synchronized (${target.agentSource}, ${target.theme} theme).`);
    }
    await this.renderAll();
  }

  private async renderAll(): Promise<void> {
    await Promise.all([
      ...[...this.agents.values()].map((registration) => this.renderAgent(registration)),
      ...[...this.microActions.values()].map((registration) => this.renderMicroAction(registration)),
      ...[...this.fixedActions.values()].map((registration) => this.renderFixedAction(registration)),
      ...[...this.hostToggleActions.values()].map((action) => this.renderHostToggle(action)),
      ...[...this.usageLimitActions.values()].map((registration) => this.renderUsageLimit(registration)),
      ...[...this.usageOverviewActions.values()].map((action) => this.renderUsageOverview(action)),
      ...[...this.rateLimitResetActions.values()].map((action) => this.renderRateLimitReset(action)),
    ]);
  }

  private async renderAgent({ action, slot }: AgentRegistration): Promise<void> {
    const agent = this.routedSlots[slot];
    const health = this.agentHealth(agent);
    const codexStopped = slot < 4 && health.state === "degraded" && health.reason === "codex-not-running";
    const healthyQueueGap = this.effectiveActiveQueueEnabled() && !agent && health.state === "ready";
    if (codexStopped || healthyQueueGap) {
      await this.setImage(action, renderAgentBlackKey());
      return;
    }
    const unavailableTitle =
      health.state === "degraded"
        ? "Signals uncertain"
        : health.state === "offline"
          ? "Host offline"
          : health.state === "connecting"
            ? "Connecting"
            : "Not assigned";
    const title = agent?.title ?? (agent?.threadKey && health.state === "ready" ? "New chat" : unavailableTitle);
    const status = agent ? visualStatusFromMicro(agent.status) : "empty";
    const theme = this.targetSnapshot()?.theme ?? this.codex.localSnapshot?.snapshot.theme ?? "light";
    const hostBadge = agent?.taskSource === "t3code" ? "T3" : agent?.taskSource === "opencode" ? "O" : undefined;
    await this.setImage(
      action,
      renderAgentKey(
        slot,
        title,
        status,
        agent?.selected ?? false,
        this.animationFrame,
        theme,
        hostBadge,
        health.state,
        agent?.contextUsedPercent,
        this.showContextRings && (!agent?.taskSource || agent.taskSource === "codex"),
      ),
    );
  }

  private async renderAnimatedAgents(): Promise<void> {
    const registrations = [...this.agents.values()].filter(({ slot }) => {
      const agent = this.routedSlots[slot];
      if (!agent) return false;
      const status = visualStatusFromMicro(agent.status);
      return status === "thinking" || status === "input";
    });
    await Promise.all(
      registrations.map((registration) =>
        this.renderAgent(registration).catch((error) =>
          streamDeck.logger.error(`Agent animation ${registration.slot + 1} failed: ${String(error)}`),
        ),
      ),
    );
  }

  private async renderMicroAction({ action, slot }: MicroActionRegistration): Promise<void> {
    const snapshot = this.targetSnapshot();
    const keycapId = snapshot?.layout.slots[slot]?.keycapId;
    if (!keycapId) return;
    const image = await this.keycapImage(keycapId, snapshot?.theme ?? "dark");
    if (image) await this.setImage(action, image);
  }

  private async renderFixedAction(registration: FixedIconRegistration): Promise<void> {
    const theme = this.targetSnapshot()?.theme ?? "dark";
    const image =
      registration.source.kind === "builtin"
        ? renderBuiltinKeycap(registration.source.name, theme)
        : await this.keycapImage(registration.source.keycapId, theme);
    if (image) await this.setImage(registration.action, image);
  }

  private async renderHostToggle(action: KeyAction<{}>): Promise<void> {
    const label = (this.codex.localHost?.platform ?? process.platform) === "darwin" ? "MAC" : "WIN";
    const theme = this.targetSnapshot()?.theme ?? "dark";
    await this.setImage(action, renderHostTargetKey(label, this.targetHealth().state, theme));
  }

  private async renderUsageLimit({ action, mode }: UsageLimitRegistration): Promise<void> {
    const source = this.accountUsageSource();
    const usage = source.usage;
    const window = selectUsageWindow(usage, mode);
    const requestedKind: UsageWindowKind = mode === "auto" ? (window?.kind ?? "other") : mode;
    await this.setImage(action, renderUsageLimitKey(window, requestedKind, usageTheme(source), source.health.state));
  }

  private async renderUsageOverview(action: KeyAction<{}>): Promise<void> {
    const source = this.accountUsageSource();
    const usage = source.usage;
    await this.setImage(action, renderUsageOverviewKey(usage?.windows ?? [], usageTheme(source), source.health.state));
  }

  private async renderRateLimitReset(action: KeyAction<{}>): Promise<void> {
    const source = this.accountUsageSource();
    const usage = source.usage;
    await this.setImage(
      action,
      renderRateLimitResetKey(usage?.resetCreditsAvailable ?? null, usageTheme(source), source.health.state),
    );
  }

  private targetHealth(): HostHealth {
    return this.codex.localHealth;
  }

  private agentHealth(agent: RoutedAgentSlot | undefined): HostHealth {
    if (!agent) return this.selectedTaskHealth();
    if (agent.taskSource === "t3code") return this.t3Code.health;
    if (agent.taskSource === "opencode") return this.openCode.openCodeHealth;
    return this.codex.localHealth;
  }

  private selectedTaskHealth(): HostHealth {
    if (this.taskSource === "OpenCode") return this.openCode.openCodeHealth;
    if (this.taskSource === "Codex") return this.targetHealth();
    if (this.taskSource === "T3 Code") return this.t3Code.health;
    const health = [this.targetHealth(), this.openCode.openCodeHealth, this.t3Code.health];
    return (
      health.find((item) => item.state === "ready") ?? health.find((item) => item.state === "degraded") ?? health[0]!
    );
  }

  private targetSnapshot(): MicroSnapshot | undefined {
    return this.codex.localSnapshot?.snapshot;
  }

  private accountUsageSource(): AccountUsageSource {
    return selectAccountUsage(
      this.codex.localHost,
      this.codex.localSnapshot,
      this.codex.localHealth,
      this.codexBarUsage,
    );
  }

  private async setImage(action: KeyAction<{}>, image: string): Promise<void> {
    if (this.stopped) return;
    let state = this.titleClears.get(action.id);
    if (!state) {
      const registeredAction =
        this.agents.get(action.id)?.action ??
        this.microActions.get(action.id)?.action ??
        this.fixedActions.get(action.id)?.action ??
        this.hostToggleActions.get(action.id) ??
        this.usageLimitActions.get(action.id)?.action ??
        this.usageOverviewActions.get(action.id) ??
        this.rateLimitResetActions.get(action.id);
      if (registeredAction !== action) return;
      state = { action, revision: 0, cleared: false };
      this.titleClears.set(action.id, state);
    }
    if (state.action !== action) return;
    if (this.lastImages.get(action.id) === image && state.cleared) return;
    const updateImage =
      this.lastImages.get(action.id) === image
        ? Promise.resolve()
        : action.setImage(image).then(() => {
            if (this.titleClears.get(action.id) === state) this.lastImages.set(action.id, image);
          });
    await Promise.all([updateImage, this.clearTitle(state)]);
  }

  private resetTitleClear(action: KeyAction<{}>): void {
    this.titleClears.set(action.id, { action, revision: 0, cleared: false });
  }

  private clearTitle(state: TitleClearState): Promise<void> {
    if (state.cleared) return Promise.resolve();
    if (state.pending) return state.pending;
    const revision = state.revision;
    state.pending = state.action.setTitle("").then(
      () => {
        if (state.revision === revision) state.cleared = true;
        state.pending = undefined;
      },
      (error) => {
        state.pending = undefined;
        throw error;
      },
    );
    return state.pending;
  }

  private effectiveActiveQueueEnabled(): boolean {
    return usesActiveQueue(this.taskSource, this.activeQueueEnabled);
  }

  private renderUsageAction(label: string, action: KeyAction<{}>, render: () => Promise<void>): void {
    void render()
      .then(() => streamDeck.logger.info(`${label} action rendered (${action.id}).`))
      .catch((error) => streamDeck.logger.error(`${label} action render failed (${action.id}): ${String(error)}`));
  }

  private unregister<T>(action: ActionIdentity, registrations: Map<string, T>): void {
    registrations.delete(action.id);
    this.lastImages.delete(action.id);
    this.titleClears.delete(action.id);
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    this.poll = setTimeout(async () => {
      try {
        await this.refresh();
      } finally {
        this.scheduleRefresh();
      }
    }, 1_200);
  }

  private scheduleAnimation(): void {
    if (this.stopped) return;
    this.animation = setTimeout(async () => {
      this.animationFrame = (this.animationFrame + 1) % 12;
      try {
        await this.renderAnimatedAgents();
      } finally {
        this.scheduleAnimation();
      }
    }, 200);
  }

  private keycapImage(keycapId: string, theme: "light" | "dark"): Promise<string | null> {
    const cacheKey = `${theme}:${keycapId}`;
    let pending = this.keycapImages.get(cacheKey);
    if (pending) return pending;
    pending = readFile(join(USER_ICON_ROOT, `${keycapId}.svg`), "utf8")
      .then((svg) => renderImportedKeycap(svg, theme))
      .catch(() => renderFallbackKeycap(keycapId, theme));
    this.keycapImages.set(cacheKey, pending);
    return pending;
  }
}
