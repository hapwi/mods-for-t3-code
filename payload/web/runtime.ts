import type { Json, ModMethod, ModRecord, Permission, UsageSnapshot } from "../../sdk.d.ts";
import { assertPermission, textValue, validateBand, validatePanel, type PanelView } from "./manifest.ts";
import { database } from "./database.ts";
import { routePath } from "./route.ts";

export interface CommandView { id: string; title: string }
export interface RuntimeHooks {
  ready(runtime: ModRuntime): void;
  command(runtime: ModRuntime, command: CommandView): void;
  panel(runtime: ModRuntime, panel: PanelView | null): void;
  notify(runtime: ModRuntime, text: string): void;
  theme(runtime: ModRuntime, colors: unknown): void;
  band(runtime: ModRuntime, parts: ReturnType<typeof validateBand> | null): void;
  usage(): UsageSnapshot | null;
  readDraft(): string;
  insertDraft(runtime: ModRuntime, text: string): Promise<boolean>;
  log(runtime: ModRuntime, text: string): void;
  removed(runtime: ModRuntime): void;
  fault(runtime: ModRuntime, reason: string): void | Promise<void>;
}

const MOD_METHODS = new Set<string>(["events.subscribe", "commands.register", "panels.set", "panels.clear", "notify", "theme.set", "theme.clear", "band.set", "band.clear", "session.usage", "route.get", "draft.read", "draft.insert", "storage.get", "storage.set", "log"]);

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function isModMethod(value: unknown): value is ModMethod {
  return typeof value === "string" && MOD_METHODS.has(value);
}

function jsonValue(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (typeof value === "object") {
    const result: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = jsonValue(item);
    return result;
  }
  throw new Error("Storage values must be JSON.");
}

function eventPermission(name: string): Permission | undefined {
  switch (name) {
    case "app.route": return "app.route";
    case "draft.change": return "draft.read";
    case "session.usage":
    case "turn.complete": return "session.usage";
    default: return undefined;
  }
}

export class ModRuntime {
  readonly record: ModRecord;
  readonly hooks: RuntimeHooks;
  stopped = false;
  private readonly pending = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly subscriptions = new Set<string>();
  private inFlight = 0;
  private callTimes: number[] = [];
  private sequence = 0;
  private lastHeartbeat = Date.now();
  private lastTick = Date.now();
  private readonly frame = document.createElement("iframe");
  private readonly channel = new MessageChannel();
  private readonly port: MessagePort;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private storageQueue: Promise<void> | undefined;

  constructor(record: ModRecord, hooks: RuntimeHooks, sandboxDocument: string) {
    this.record = record;
    this.hooks = hooks;
    this.frame.hidden = true;
    this.frame.title = `${record.manifest.name} isolated runtime`;
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.srcdoc = sandboxDocument;
    this.port = this.channel.port1;
    this.port.onmessage = (event) => { void this.receive(event.data as unknown); };
    this.port.start();
    this.frame.onload = () => this.frame.contentWindow?.postMessage({ type: "t3mods.connect" }, "*", [this.channel.port2]);
    document.body.append(this.frame);
    this.initTimer = setTimeout(() => this.fail("Mod startup took longer than 5 seconds."), 5000);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const hostStalled = now - this.lastTick > 2500;
      this.lastTick = now;
      if (hostStalled) { this.lastHeartbeat = now; return; }
      if (now - this.lastHeartbeat > 5000) this.fail("Mod stopped responding and was quarantined.");
    }, 1000);
  }

  private async receive(message: unknown): Promise<void> {
    if (this.stopped || !isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "connected") {
      this.port.postMessage({ type: "init", code: this.record.code });
    } else if (message.type === "ready") {
      clearTimeout(this.initTimer);
      this.hooks.ready(this);
    } else if (message.type === "heartbeat") {
      this.lastHeartbeat = Date.now();
    } else if (message.type === "fault") {
      this.fail(String(message.error).slice(0, 1000));
    } else if (message.type === "done") {
      if (typeof message.requestId !== "number") return;
      clearTimeout(this.pending.get(message.requestId));
      this.pending.delete(message.requestId);
    } else if (message.type === "call") {
      const now = Date.now();
      this.callTimes = this.callTimes.filter((time) => now - time < 1000);
      this.callTimes.push(now);
      if (this.callTimes.length > 100 || this.inFlight > 20) { this.fail("Mod exceeded its request limit."); return; }
      this.inFlight++;
      const userDecision = message.method === "draft.insert";
      if (userDecision) for (const timer of this.pending.values()) clearTimeout(timer);
      try {
        const args = Array.isArray(message.args) ? message.args.map((item) => item as unknown) : null;
        if (!Number.isSafeInteger(message.id) || !args || JSON.stringify(args).length > 100000) throw new Error("Invalid host request.");
        const value = await this.handle(message.method, args);
        if (!this.stopped) this.port.postMessage({ type: "result", id: message.id, value });
      } catch (error) {
        if (!this.stopped) this.port.postMessage({ type: "result", id: message.id, error: error instanceof Error ? error.message : "Mod request failed." });
      } finally {
        this.inFlight--;
        if (userDecision && !this.stopped) {
          this.lastHeartbeat = Date.now();
          for (const id of this.pending.keys()) this.pending.set(id, setTimeout(() => this.fail("A mod action took longer than 5 seconds."), 5000));
        }
      }
    }
  }

  private async handle(method: unknown, args: unknown[]): Promise<unknown> {
    if (!isModMethod(method)) throw new Error("Unknown mod API method.");
    const manifest = this.record.manifest;
    const require = (permission: Permission) => assertPermission(manifest, permission);
    switch (method) {
      case "events.subscribe": {
        const name = textValue(args[0], 40);
        const permission = eventPermission(name);
        if (!permission) throw new Error("Unsupported event.");
        require(permission);
        this.subscriptions.add(name);
        return;
      }
      case "commands.register": {
        require("ui.commands");
        const command = args[0];
        if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("Expected text of at most 64 characters.");
        this.hooks.command(this, { id: textValue(Reflect.get(command, "id"), 64), title: textValue(Reflect.get(command, "title"), 100) });
        return;
      }
      case "panels.set": require("ui.panels"); this.hooks.panel(this, validatePanel(args[0])); return;
      case "panels.clear": require("ui.panels"); this.hooks.panel(this, null); return;
      case "notify": require("ui.notify"); this.hooks.notify(this, textValue(args[0], 500)); return;
      case "theme.set": require("ui.theme"); this.hooks.theme(this, args[0]); return;
      case "theme.clear": require("ui.theme"); this.hooks.theme(this, null); return;
      case "band.set": require("ui.band"); this.hooks.band(this, validateBand(args[0])); return;
      case "band.clear": require("ui.band"); this.hooks.band(this, null); return;
      case "session.usage": require("session.usage"); return this.hooks.usage();
      case "route.get": require("app.route"); return routePath();
      case "draft.read": require("draft.read"); return this.hooks.readDraft();
      case "draft.insert": require("draft.insert"); return this.hooks.insertDraft(this, textValue(args[0], 30000));
      case "storage.get": {
        require("storage");
        const key = textValue(args[0], 100);
        const value = await database.getData(manifest.id);
        return Object.hasOwn(value, key) ? value[key] : null;
      }
      case "storage.set": {
        require("storage");
        const key = textValue(args[0], 100);
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Reserved storage key.");
        const stored = jsonValue(args[1]);
        // Serialize updates so concurrent SDK writes cannot clobber one another.
        this.storageQueue = (this.storageQueue ?? Promise.resolve()).catch(() => undefined).then(async () => {
          const value = await database.getData(manifest.id);
          const next = { ...value, [key]: stored };
          if (new TextEncoder().encode(JSON.stringify(next)).length > 65536) throw new Error("Mod storage is limited to 64 KB.");
          if (!this.stopped) await database.setData(manifest.id, next);
        });
        return this.storageQueue;
      }
      case "log": this.hooks.log(this, textValue(args[0], 1000)); return;
      default: {
        const unreachable: never = method;
        throw new Error(`Unknown mod API method: ${unreachable}`);
      }
    }
  }

  private dispatch(message: { type: "event"; name: string; value: unknown } | { type: "invoke"; kind: string; id: string }): void {
    if (this.stopped || this.pending.size > 10) return;
    const requestId = ++this.sequence;
    const timer = setTimeout(() => this.fail("A mod action took longer than 5 seconds."), 5000);
    this.pending.set(requestId, timer);
    this.port.postMessage({ ...message, requestId });
  }

  emit(name: string, value: unknown): void {
    if (this.subscriptions.has(name)) this.dispatch({ type: "event", name, value });
  }

  invoke(kind: string, id: string): void { this.dispatch({ type: "invoke", kind, id }); }

  fail(reason: string): void {
    if (this.stopped) return;
    this.stop();
    void this.hooks.fault(this, reason);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.initTimer);
    clearInterval(this.heartbeatTimer);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.port.postMessage({ type: "stop" });
    this.port.close();
    this.frame.remove();
    this.hooks.removed(this);
  }
}
