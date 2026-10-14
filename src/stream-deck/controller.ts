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
type DisplayState = { action: KeyAction<{}>; generation: number; revision: number; cleared: boolean; image?: string };
type AgentPress = { assignment?: RoutedAgentSlot; down: Promise<void>; abort: AbortController };
type AgentButton = { press?: AgentPress; active: Set<AgentPress>; tail?: Promise<void> };
type DisplayPass = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
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
  private readonly displayStates = new Map<string, DisplayState>();
  private displayGeneration = 0;
  private desiredDisplayRevision = 0;
  private attemptedDisplayRevision = 0;
  private displayNeedsAll = false;
  private displayInFlight?: Promise<void>;
  private nextDisplayPass?: DisplayPass;
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
  private quotaInFlight?: Promise<void>;
  private sourceUnsubscribes: (() => void)[] = [];
  private projectionQueued = false;
  private codexStarted = false;
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
    const generation = ++this.displayGeneration;
    if (this.poll) clearTimeout(this.poll);
    if (this.animation) clearTimeout(this.animation);
    this.refreshInFlight = undefined;
    this.quotaInFlight = undefined;
    this.codexStarted = false;
    this.displayStates.clear();
    this.stopped = false;
    for (const unsubscribe of this.sourceUnsubscribes) unsubscribe();
    this.sourceUnsubscribes = [this.openCode, this.t3Code].map((source) =>
      source.subscribe(() => {
        if (this.isCurrentGeneration(generation)) this.requestProjection();
      }),
    );
    this.titleListener?.dispose();
    this.titleListener = streamDeck.actions.onTitleParametersDidChange((event) => {
      if (!event.payload.title) return;
      const state = this.displayStates.get(event.action.id);
      if (state?.action === event.action) {
        state.revision++;
        state.cleared = false;
        this.requestRender();
      }
    });
    await this.loadAgentDisplaySettings(generation);
    if (!this.isCurrentGeneration(generation)) return;
    void this.syncTaskSourceDemand().catch((error) =>
      streamDeck.logger.error(`Source preparation failed: ${String(error)}`),
    );
    this.refreshOwners();
    this.scheduleRefresh(generation);
    this.scheduleAnimation(generation);
    await this.codex.start();
    if (!this.isCurrentGeneration(generation)) return;
    this.codexStarted = true;
    void this.syncTaskSourceDemand().catch((error) =>
      streamDeck.logger.error(`Source preparation failed: ${String(error)}`),
    );
    void this.refresh();
    void this.refreshDisplay().catch((error) => streamDeck.logger.error(`Display projection failed: ${String(error)}`));
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.stopped && generation === this.displayGeneration;
  }

  private async loadAgentDisplaySettings(generation: number): Promise<void> {
    try {
      const settings = await streamDeck.settings.getGlobalSettings<AgentDisplaySettings>();
      if (!this.isCurrentGeneration(generation)) return;
      this.showContextRings = settings.showContextRings !== false;
      this.activeQueueEnabled = settings.activeQueueEnabled === true;
      this.taskSource = parseTaskSource(settings.taskSource);
    } catch (error) {
      if (this.isCurrentGeneration(generation))
        streamDeck.logger.warn(`Agent display settings were unavailable; using defaults: ${String(error)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.displayGeneration++;
    this.titleListener?.dispose();
    this.titleListener = undefined;
    this.displayStates.clear();
    for (const unsubscribe of this.sourceUnsubscribes) unsubscribe();
    this.sourceUnsubscribes = [];
    this.codexStarted = false;
    this.refreshInFlight = undefined;
    this.quotaInFlight = undefined;
    if (this.poll) clearInterval(this.poll);
    if (this.animation) clearInterval(this.animation);
    for (const button of this.agentButtons.values()) for (const press of button.active) press.abort.abort();
    this.agentButtons.clear();
    this.codex.stop();
    this.openCode.stop();
    this.t3Code.stop();
  }

  registerAgent(slot: number, action: KeyAction<{}>): void {
    this.resetDisplayState(action);
    this.agents.set(action.id, { action, slot });
    this.requestRender();
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
        void this.syncTaskSourceDemand().catch(() => streamDeck.logger.error("Agent display settings refresh failed."));
        void this.t3Code.refresh().catch(() => streamDeck.logger.error("T3 refresh failed."));
      }
      void this.refreshDisplay().catch(() => streamDeck.logger.error("Agent display settings refresh failed."));
    } else {
      this.requestRender();
    }
  }

  registerMicroAction(slot: MicroActionSlot, action: KeyAction<{}>): void {
    this.resetDisplayState(action);
    this.microActions.set(action.id, { action, slot });
    this.requestRender();
  }

  unregisterMicroAction(action: ActionIdentity): void {
    this.unregister(action, this.microActions);
  }

  registerFixedAction(action: KeyAction<{}>, source: FixedIconSource): void {
    this.resetDisplayState(action);
    this.fixedActions.set(action.id, { action, source });
    this.requestRender();
  }

  unregisterFixedAction(action: ActionIdentity): void {
    this.unregister(action, this.fixedActions);
  }

  registerHostToggle(action: KeyAction<{}>): void {
    this.resetDisplayState(action);
    this.hostToggleActions.set(action.id, action);
    this.requestRender();
  }

  unregisterHostToggle(action: ActionIdentity): void {
    this.unregister(action, this.hostToggleActions);
  }

  registerUsageLimit(action: KeyAction<{}>, mode: UsageLimitMode): void {
    this.resetDisplayState(action);
    const registration = { action, mode };
    this.usageLimitActions.set(action.id, registration);
    this.renderUsageAction("Usage limit", action);
  }

  updateUsageLimitMode(action: KeyAction<{}>, mode: UsageLimitMode): void {
    if (this.usageLimitActions.get(action.id)?.action !== action) this.resetDisplayState(action);
    const registration = { action, mode };
    this.usageLimitActions.set(action.id, registration);
    this.renderUsageAction("Usage limit", action);
  }

  unregisterUsageLimit(action: ActionIdentity): void {
    this.unregister(action, this.usageLimitActions);
  }

  registerUsageOverview(action: KeyAction<{}>): void {
    this.resetDisplayState(action);
    this.usageOverviewActions.set(action.id, action);
    this.renderUsageAction("Usage overview", action);
  }

  unregisterUsageOverview(action: ActionIdentity): void {
    this.unregister(action, this.usageOverviewActions);
  }

  registerRateLimitReset(action: KeyAction<{}>): void {
    this.resetDisplayState(action);
    this.rateLimitResetActions.set(action.id, action);
    this.renderUsageAction("Rate-limit reset", action);
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

  private refresh(): Promise<void> {
    if (this.stopped || !this.codexStarted) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const generation = this.displayGeneration;
    const pending = this.codex
      .refresh()
      .then(() => {
        if (this.isCurrentGeneration(generation)) this.requestProjection();
      })
      .catch((error) => {
        if (this.isCurrentGeneration(generation)) streamDeck.logger.error(`Codex refresh failed: ${String(error)}`);
      });
    this.refreshInFlight = pending;
    void pending.finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    });
    return pending;
  }

  private refreshOwners(): void {
    if (this.stopped) return;
    void this.refresh();
    void this.t3Code.refresh().catch((error) => streamDeck.logger.error(`T3 refresh failed: ${String(error)}`));
    if (process.platform !== "darwin" || this.quotaInFlight) return;
    const generation = this.displayGeneration;
    const pending = readCodexBarUsage()
      .then((usage) => {
        if (!this.isCurrentGeneration(generation)) return;
        this.codexBarUsage = usage;
        this.requestProjection();
      })
      .catch((error) => {
        if (this.isCurrentGeneration(generation)) streamDeck.logger.error(`Quota refresh failed: ${String(error)}`);
      });
    this.quotaInFlight = pending;
    void pending.finally(() => {
      if (this.quotaInFlight === pending) this.quotaInFlight = undefined;
    });
  }

  private requestProjection(): void {
    if (this.stopped || this.projectionQueued) return;
    this.projectionQueued = true;
    setImmediate(() => {
      this.projectionQueued = false;
      if (!this.stopped)
        void this.refreshDisplay().catch((error) =>
          streamDeck.logger.error(`Display projection failed: ${String(error)}`),
        );
    });
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

  private requestRender(): void {
    void this.renderAll().catch((error) => streamDeck.logger.error(`Display render failed: ${String(error)}`));
  }

  private renderAll(animatedOnly = false): Promise<void> {
    this.desiredDisplayRevision++;
    if (!animatedOnly) this.displayNeedsAll = true;
    // Input waits for the pass containing its revision, never for an endless animation drain.
    if (!this.nextDisplayPass) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      this.nextDisplayPass = { promise, resolve, reject };
    }
    const requested = this.nextDisplayPass.promise;
    if (this.displayInFlight) return requested;
    const pending = Promise.resolve().then(async () => {
      while (!this.stopped && this.attemptedDisplayRevision !== this.desiredDisplayRevision) {
        const pass = this.nextDisplayPass;
        this.nextDisplayPass = undefined;
        this.attemptedDisplayRevision = this.desiredDisplayRevision;
        const animatedOnly = !this.displayNeedsAll;
        this.displayNeedsAll = false;
        try {
          await this.renderOnce(animatedOnly);
          pass?.resolve();
        } catch (error) {
          pass?.reject(error);
        }
      }
      this.nextDisplayPass?.resolve();
      this.nextDisplayPass = undefined;
    });
    this.displayInFlight = pending;
    void pending
      .finally(() => {
        if (this.displayInFlight !== pending) return;
        this.displayInFlight = undefined;
        if (!this.stopped && this.attemptedDisplayRevision !== this.desiredDisplayRevision) this.requestRender();
      })
      .catch(() => undefined);
    return requested;
  }

  private async renderOnce(animatedOnly: boolean): Promise<void> {
    const generation = this.displayGeneration;
    const registeredRender = (action: KeyAction<{}>, draw: () => Promise<void>) => {
      const state = this.displayState(action);
      return async () => {
        if (state && this.isCurrentDisplay(state)) await draw();
      };
    };
    const agents = [...this.agents.values()].filter(({ slot }) => !animatedOnly || this.isAnimatedAgent(slot));
    const renders = agents.map((registration) =>
      registeredRender(registration.action, () => this.renderAgent(registration)),
    );
    if (!animatedOnly)
      renders.push(
        ...[...this.microActions.values()].map((registration) =>
          registeredRender(registration.action, () => this.renderMicroAction(registration)),
        ),
        ...[...this.fixedActions.values()].map((registration) =>
          registeredRender(registration.action, () => this.renderFixedAction(registration)),
        ),
        ...[...this.hostToggleActions.values()].map((action) =>
          registeredRender(action, () => this.renderHostToggle(action)),
        ),
        ...[...this.usageLimitActions.values()].map((registration) =>
          registeredRender(registration.action, () => this.renderUsageLimit(registration)),
        ),
        ...[...this.usageOverviewActions.values()].map((action) =>
          registeredRender(action, () => this.renderUsageOverview(action)),
        ),
        ...[...this.rateLimitResetActions.values()].map((action) =>
          registeredRender(action, () => this.renderRateLimitReset(action)),
        ),
      );
    let failure: unknown;
    for (const render of renders) {
      if (this.stopped || generation !== this.displayGeneration) return;
      try {
        await render();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
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

  private isAnimatedAgent(slot: number): boolean {
    const agent = this.routedSlots[slot];
    if (!agent) return false;
    const status = visualStatusFromMicro(agent.status);
    return status === "thinking" || status === "input";
  }

  private async renderAnimatedAgents(): Promise<void> {
    if ([...this.agents.values()].some(({ slot }) => this.isAnimatedAgent(slot))) await this.renderAll(true);
  }

  private async renderMicroAction({ action, slot }: MicroActionRegistration): Promise<void> {
    const state = this.displayState(action);
    const snapshot = this.targetSnapshot();
    const keycapId = snapshot?.layout.slots[slot]?.keycapId;
    if (!keycapId) return;
    const image = await this.keycapImage(keycapId, snapshot?.theme ?? "dark");
    if (image) await this.setImage(action, image, state);
  }

  private async renderFixedAction(registration: FixedIconRegistration): Promise<void> {
    const state = this.displayState(registration.action);
    const theme = this.targetSnapshot()?.theme ?? "dark";
    const image =
      registration.source.kind === "builtin"
        ? renderBuiltinKeycap(registration.source.name, theme)
        : await this.keycapImage(registration.source.keycapId, theme);
    if (image) await this.setImage(registration.action, image, state);
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

  private displayState(action: KeyAction<{}>): DisplayState | undefined {
    if (this.stopped) return undefined;
    let state = this.displayStates.get(action.id);
    if (!state) {
      const registeredAction =
        this.agents.get(action.id)?.action ??
        this.microActions.get(action.id)?.action ??
        this.fixedActions.get(action.id)?.action ??
        this.hostToggleActions.get(action.id) ??
        this.usageLimitActions.get(action.id)?.action ??
        this.usageOverviewActions.get(action.id) ??
        this.rateLimitResetActions.get(action.id);
      if (registeredAction !== action) return undefined;
      state = { action, generation: this.displayGeneration, revision: 0, cleared: false };
      this.displayStates.set(action.id, state);
    }
    return state.action === action ? state : undefined;
  }

  private isCurrentDisplay(state: DisplayState): boolean {
    return (
      !this.stopped && state.generation === this.displayGeneration && this.displayStates.get(state.action.id) === state
    );
  }

  private async setImage(action: KeyAction<{}>, image: string, state = this.displayState(action)): Promise<void> {
    if (!state || !this.isCurrentDisplay(state)) return;
    if (!state.cleared) {
      const revision = state.revision;
      await action.setTitle("");
      if (!this.isCurrentDisplay(state)) return;
      if (state.revision === revision) state.cleared = true;
    }
    if (!this.isCurrentDisplay(state) || state.image === image) return;
    await action.setImage(image);
    if (this.isCurrentDisplay(state)) state.image = image;
  }

  private resetDisplayState(action: KeyAction<{}>): void {
    this.displayStates.set(action.id, { action, generation: this.displayGeneration, revision: 0, cleared: false });
  }

  private effectiveActiveQueueEnabled(): boolean {
    return usesActiveQueue(this.taskSource, this.activeQueueEnabled);
  }

  private renderUsageAction(label: string, action: KeyAction<{}>): void {
    void this.renderAll()
      .then(() => streamDeck.logger.info(`${label} action rendered (${action.id}).`))
      .catch((error) => streamDeck.logger.error(`${label} action render failed (${action.id}): ${String(error)}`));
  }

  private unregister<T>(action: ActionIdentity, registrations: Map<string, T>): void {
    registrations.delete(action.id);
    this.displayStates.delete(action.id);
  }

  private scheduleRefresh(generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.poll = setTimeout(() => {
      if (!this.isCurrentGeneration(generation)) return;
      this.refreshOwners();
      this.scheduleRefresh(generation);
    }, 1_200);
  }

  private scheduleAnimation(generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.animation = setTimeout(() => {
      if (!this.isCurrentGeneration(generation)) return;
      this.animationFrame = (this.animationFrame + 1) % 12;
      void this.renderAnimatedAgents().catch((error) =>
        streamDeck.logger.error(`Animation render failed: ${String(error)}`),
      );
      this.scheduleAnimation(generation);
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
