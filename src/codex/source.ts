import type { CodexHost, HostHealth, HostSnapshot } from "#agents";
import { getOrCreateHostIdentity } from "../runtime/host-identity.js";
import { CodexMicroRendererBridge, localBridgeFailureReason } from "./bridge.js";

export class CodexSource {
  readonly microBridge: CodexMicroRendererBridge;
  localHost?: CodexHost;
  localSnapshot?: HostSnapshot;
  localHealth: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private lastError = "";
  private generation = 0;
  private stopped = false;

  constructor(
    log: (message: string) => void,
    private readonly warn: (message: string) => void = log,
  ) {
    this.microBridge = new CodexMicroRendererBridge(log);
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.microBridge.close();
    this.stopped = false;
    const host = await getOrCreateHostIdentity();
    if (!this.stopped && generation === this.generation) this.localHost = host;
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    const generation = this.generation;
    try {
      const snapshot = await this.microBridge.refresh();
      if (this.stopped || generation !== this.generation) return;
      const host = await getOrCreateHostIdentity();
      if (this.stopped || generation !== this.generation) return;
      this.localHost = host;
      this.localSnapshot = { host, snapshot, observedAt: Date.now() };
      this.localHealth = { state: "ready", changedAt: Date.now() };
      this.lastError = "";
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.localHealth = { state: "degraded", reason: localBridgeFailureReason(error), changedAt: Date.now() };
      const message = String(error);
      if (message !== this.lastError) {
        this.lastError = message;
        this.warn(`Codex Micro bridge unavailable: ${message}`);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.microBridge.close();
  }
}
