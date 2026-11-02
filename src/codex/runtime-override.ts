import { buildMicroSnapshotExpression } from "./bridge.js";
import WebSocket from "ws";

const MICRO_GATE = "3207467860";
const DETECTION_KEY = "codex-micro-has-ever-been-detected";
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function buildRuntimeOverrideExpression(gateName = MICRO_GATE): string {
  if (!/^\d+$/.test(gateName)) throw new Error("The feature gate must contain digits only.");

  return `(async () => {
    const gateName = ${JSON.stringify(gateName)};
    const statsig = globalThis.__STATSIG__;
    if (!statsig) return { ready: false, reason: 'statsig-unavailable' };

    const clients = [...new Set([statsig.firstInstance, ...Object.values(statsig.instances ?? {})].filter(Boolean))];
    if (clients.length === 0) return { ready: false, reason: 'statsig-client-unavailable' };

    for (const client of clients) {
      if (client.overrideAdapter?.__codexDeckGate !== gateName) {
        const original = client.overrideAdapter ?? {};
        client.overrideAdapter = new Proxy(original, {
          get(target, property) {
            if (property === '__codexDeckGate') return gateName;
            if (property === 'getGateOverride') {
              return (gate, user, options) => {
                if (gate?.name === gateName) return { ...gate, value: true };
                const fallback = Reflect.get(target, property, target);
                return typeof fallback === 'function' ? fallback.call(target, gate, user, options) : gate;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
      client._memoCache = {};
    }

    const urls = [
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ];
    const uniqueUrls = [...new Set(urls)].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
    const persistedUrl = uniqueUrls.find((url) => url.includes('/assets/persisted-signal-'));
    let detected = null;
    let detectionMethod = 'native-device-event';
    if (persistedUrl) {
      const persisted = await import(persistedUrl);
      if (typeof persisted.p !== 'function' || typeof persisted.b !== 'function') {
        return { ready: false, reason: 'persisted-signal-api-changed' };
      }
      persisted.b(${JSON.stringify(DETECTION_KEY)}, true);
      detected = Boolean(persisted.p(${JSON.stringify(DETECTION_KEY)}, false));
      detectionMethod = 'persisted-signal';
    }
    for (const client of clients) client.$emt?.({ name: 'values_updated' });

    // Newer Codex builds moved the persisted signal into a shared renderer
    // chunk. Announcing the native device through the already-loaded event bus
    // preserves the same Codex-owned detection path without naming that chunk.
    const likelyModules = uniqueUrls.filter((url) =>
      /(?:vscode-api|codex-micro|app-initial|app-shared|artifact-tab-content)/.test(url)
    ).slice(0, 120);
    let nativeEventBus = false;
    let deviceHandlers = 0;
    let deviceEventDispatched = false;
    const eventDeadline = Date.now() + 5000;
    while (Date.now() < eventDeadline && !deviceEventDispatched) {
      for (const url of likelyModules) {
        try {
          const module = await import(url);
          const bus = Object.values(module).find((candidate) => candidate && typeof candidate === 'object' &&
            (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
          if (!bus) continue;
          nativeEventBus = true;
          deviceHandlers = bus.handlers instanceof Map
            ? (bus.handlers.get('codex-micro-device-state-changed')?.size ?? 0)
            : 1;
          if (deviceHandlers === 0) continue;
          const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
          dispatch.call(bus, ${JSON.stringify({
            type: "codex-micro-device-state-changed",
            state: { status: "connected", error: null, battery: { percentage: 100, isCharging: true } },
          })});
          deviceEventDispatched = true;
          break;
        } catch { /* Ignore unrelated already-loaded renderer chunks. */ }
      }
      if (!deviceEventDispatched) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const enabled = clients.map((client) => Boolean(client.checkGate?.(gateName)));
    return {
      ready: enabled.every(Boolean) && (detected === true || deviceEventDispatched),
      enabled,
      detected,
      detectionMethod,
      nativeEventBus,
      deviceHandlers,
      deviceEventDispatched,
      clients: clients.length
    };
  })()`;
}

export function buildRuntimeVerificationExpression(): string {
  return `(async () => {
    const urls = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
    const likelyModules = urls.filter((url) =>
      /(?:vscode-api|codex-micro|app-initial|app-shared|artifact-tab-content)/.test(url)
    ).slice(0, 120);
    let bus = null;
    for (const url of likelyModules) {
      try {
        const module = await import(url);
        bus = Object.values(module).find((candidate) => candidate && typeof candidate === 'object' &&
          (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function')) ?? null;
        if (bus?.handlers instanceof Map) break;
      } catch { /* Ignore unrelated already-loaded renderer chunks. */ }
    }
    const hidHandlers = bus?.handlers instanceof Map ? (bus.handlers.get('codex-micro-hid-event')?.size ?? 0) : 0;
    const joystickHandlers = bus?.handlers instanceof Map ? (bus.handlers.get('codex-micro-joystick-event')?.size ?? 0) : 0;
    const settingsLink = Boolean(document.querySelector('[href*="/settings/codex-micro"]'));
    const statsig = globalThis.__STATSIG__;
    const clients = [...new Set([statsig?.firstInstance, ...Object.values(statsig?.instances ?? {})].filter(Boolean))];
    const menuEnabled = settingsLink || (clients.length > 0 && clients.every((client) => Boolean(client.checkGate?.(${JSON.stringify(MICRO_GATE)}))));
    return {
      ready: menuEnabled && Boolean(bus) && hidHandlers > 0 && joystickHandlers > 0,
      menuEnabled,
      nativeEventBus: Boolean(bus),
      hidHandlers,
      joystickHandlers,
      modulesInspected: likelyModules.length
    };
  })()`;
}

type DebugTarget = { type?: string; url?: string; webSocketDebuggerUrl?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

function remaining(deadline: number): number {
  const budget = deadline - Date.now();
  if (budget <= 0) throw new Error("Timed out waiting for the Codex runtime.");
  return budget;
}

export function selectRuntimeTarget(targets: DebugTarget[]): DebugTarget | undefined {
  const pages = targets.filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl && target.url?.startsWith("app://"),
  );
  const isIndexDocument = (target: DebugTarget): boolean => {
    try {
      return new URL(target.url!).pathname === "/index.html";
    } catch {
      return false;
    }
  };
  const isAuxiliarySurface = (target: DebugTarget): boolean =>
    /avatar-overlay|composition-surface/i.test(target.url ?? "");

  return (
    pages.find((target) => isIndexDocument(target) && !new URL(target.url!).search) ??
    pages.find(isIndexDocument) ??
    pages.find((target) => !isAuxiliarySurface(target) && !target.url?.includes("initialRoute=")) ??
    pages.find((target) => !isAuxiliarySurface(target))
  );
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    url: string,
    private readonly deadline: number,
  ) {
    this.socket = new WebSocket(url, { handshakeTimeout: remaining(deadline) });
    this.socket.on("message", (raw) => this.handle(String(raw)));
    this.socket.on("close", () => this.failPending(new Error("Codex runtime connection closed.")));
    this.socket.on("error", (error) => this.failPending(error));
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeListener("open", opened);
        this.socket.removeListener("error", failed);
        this.socket.removeListener("close", closed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () => failed(new Error("Codex runtime connection closed."));
      const timer = setTimeout(
        () => failed(new Error("Timed out connecting to the Codex runtime.")),
        remaining(this.deadline),
      );
      this.socket.once("open", opened);
      this.socket.once("error", failed);
      this.socket.once("close", closed);
    });
  }

  evaluate(expression: string): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Codex runtime is disconnected."));
    const budget = remaining(this.deadline);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out waiting for the Codex runtime response."));
      }, budget);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        },
      );
    });
  }

  close(): void {
    this.failPending(new Error("Codex runtime client closed."));
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handle(raw: string): void {
    let message: {
      id?: number;
      error?: { message?: string };
      result?: {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "CDP request failed."));
      return;
    }
    if (message.result?.exceptionDetails) {
      pending.reject(
        new Error(
          message.result.exceptionDetails.exception?.description ??
            message.result.exceptionDetails.text ??
            "Codex runtime evaluation failed.",
        ),
      );
      return;
    }
    pending.resolve(message.result?.result?.value);
  }
}

async function findTarget(port: number, deadline: number): Promise<DebugTarget> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(remaining(deadline)),
      });
      if (response.ok) {
        const targets = (await response.json()) as DebugTarget[];
        const target = selectRuntimeTarget(targets);
        if (target) return target;
      }
    } catch {
      /* Codex is still starting. */
    }
    if (Date.now() < deadline) await delay(Math.min(250, remaining(deadline)));
  }
  throw new Error("Timed out waiting for the Codex renderer.");
}

export async function applyRuntimeOverride(port: number, timeout = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeout;
  const target = await findTarget(port, deadline);
  const client = new CdpClient(target.webSocketDebuggerUrl!, deadline);
  try {
    await client.connect();
    let result: unknown;
    while (Date.now() < deadline) {
      result = await client.evaluate(buildRuntimeOverrideExpression());
      if ((result as { ready?: boolean } | null)?.ready) {
        const snapshot = (await client.evaluate(buildMicroSnapshotExpression())) as { slots?: unknown[] };
        if (!Array.isArray(snapshot?.slots) || snapshot.slots.length !== 6)
          throw new Error("Codex Micro slot verification failed.");
        return { ...(result as object), slotsReady: true, slotCount: snapshot.slots.length };
      }
      await delay(Math.min(100, remaining(deadline)));
    }
    throw new Error(`Timed out enabling the Codex Micro runtime: ${JSON.stringify(result)}`);
  } finally {
    client.close();
  }
}

export async function verifyMicroRuntime(port: number, timeout = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeout;
  const target = await findTarget(port, deadline);
  const client = new CdpClient(target.webSocketDebuggerUrl!, deadline);
  try {
    await client.connect();
    let result: unknown;
    while (Date.now() < deadline) {
      result = await client.evaluate(buildRuntimeVerificationExpression());
      if ((result as { ready?: boolean } | null)?.ready) return result;
      if (Date.now() < deadline) await delay(Math.min(250, remaining(deadline)));
    }
    throw new Error(`Timed out verifying the Codex Micro runtime: ${JSON.stringify(result)}`);
  } finally {
    client.close();
  }
}
