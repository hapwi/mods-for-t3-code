import { assertPermission, textValue, validateBand, validatePanel } from "./manifest.js";
import { database } from "./database.js";

export class ModRuntime {
  constructor(record, hooks, sandboxDocument) {
    this.record = record;
    this.hooks = hooks;
    this.stopped = false;
    this.pending = new Map();
    this.subscriptions = new Set();
    this.inFlight = 0;
    this.callTimes = [];
    this.sequence = 0;
    this.lastHeartbeat = Date.now();
    this.lastTick = Date.now();
    this.frame = document.createElement("iframe");
    this.frame.hidden = true;
    this.frame.title = `${record.manifest.name} isolated runtime`;
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.srcdoc = sandboxDocument;
    this.channel = new MessageChannel();
    this.port = this.channel.port1;
    this.port.onmessage = ({ data }) => void this.receive(data);
    this.port.start();
    this.frame.onload = () => this.frame.contentWindow.postMessage({ type: "t3mods.connect" }, "*", [this.channel.port2]);
    document.body.append(this.frame);
    this.initTimer = setTimeout(() => this.fail("Mod startup took longer than 5 seconds."), 5000);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now(); const hostStalled = now - this.lastTick > 2500; this.lastTick = now;
      if (hostStalled) { this.lastHeartbeat = now; return; }
      if (now - this.lastHeartbeat > 5000) this.fail("Mod stopped responding and was quarantined.");
    }, 1000);
  }

  async receive(message) {
    if (this.stopped || !message || typeof message !== "object") return;
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
        if (!Number.isSafeInteger(message.id) || !Array.isArray(message.args) || JSON.stringify(message.args).length > 100000) throw new Error("Invalid host request.");
        const value = await this.handle(message.method, message.args);
        if (!this.stopped) this.port.postMessage({ type: "result", id: message.id, value });
      } catch (error) {
        if (!this.stopped) this.port.postMessage({ type: "result", id: message.id, error: error.message });
      } finally {
        this.inFlight--;
        if (userDecision && !this.stopped) {
          this.lastHeartbeat = Date.now();
          for (const id of this.pending.keys()) this.pending.set(id, setTimeout(() => this.fail("A mod action took longer than 5 seconds."), 5000));
        }
      }
    }
  }

  async handle(method, args) {
    const manifest = this.record.manifest;
    const require = (permission) => assertPermission(manifest, permission);
    switch (method) {
      case "events.subscribe": {
        const name = textValue(args[0], 40);
        const events = { "app.route": "app.route", "draft.change": "draft.read", "session.usage": "session.usage", "turn.complete": "session.usage" };
        if (!Object.hasOwn(events, name)) throw new Error("Unsupported event.");
        require(events[name]); this.subscriptions.add(name); return;
      }
      case "commands.register":
        require("ui.commands");
        this.hooks.command(this, { id: textValue(args[0]?.id, 64), title: textValue(args[0]?.title, 100) }); return;
      case "panels.set": require("ui.panels"); this.hooks.panel(this, validatePanel(args[0])); return;
      case "panels.clear": require("ui.panels"); this.hooks.panel(this, null); return;
      case "notify": require("ui.notify"); this.hooks.notify(this, textValue(args[0], 500)); return;
      case "theme.set": require("ui.theme"); this.hooks.theme(this, args[0]); return;
      case "theme.clear": require("ui.theme"); this.hooks.theme(this, null); return;
      case "band.set": require("ui.band"); this.hooks.band(this, validateBand(args[0])); return;
      case "band.clear": require("ui.band"); this.hooks.band(this, null); return;
      case "session.usage": require("session.usage"); return this.hooks.usage();
      case "route.get": require("app.route"); return location.pathname;
      case "draft.read": require("draft.read"); return this.hooks.readDraft();
      case "draft.insert": require("draft.insert"); return this.hooks.insertDraft(this, textValue(args[0], 30000));
      case "storage.get": {
        require("storage"); const key = textValue(args[0], 100);
        const value = await database.getData(manifest.id);
        return Object.hasOwn(value, key) ? value[key] : null;
      }
      case "storage.set": {
        require("storage"); const key = textValue(args[0], 100);
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Reserved storage key.");
        // Serialize updates so concurrent SDK writes cannot clobber one another.
        this.storageQueue = (this.storageQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
          const value = await database.getData(manifest.id);
          const next = { ...value, [key]: args[1] };
          if (new TextEncoder().encode(JSON.stringify(next)).length > 65536) throw new Error("Mod storage is limited to 64 KB.");
          if (!this.stopped) await database.setData(manifest.id, next);
        });
        return this.storageQueue;
      }
      case "log": this.hooks.log(this, textValue(args[0], 1000)); return;
      default: throw new Error("Unknown mod API method.");
    }
  }

  dispatch(message) {
    if (this.stopped || this.pending.size > 10) return;
    const requestId = ++this.sequence;
    const timer = setTimeout(() => this.fail("A mod action took longer than 5 seconds."), 5000);
    this.pending.set(requestId, timer);
    this.port.postMessage({ ...message, requestId });
  }

  emit(name, value) {
    if (this.subscriptions.has(name)) this.dispatch({ type: "event", name, value });
  }

  invoke(kind, id) { this.dispatch({ type: "invoke", kind, id }); }

  fail(reason) {
    if (this.stopped) return;
    this.stop();
    this.hooks.fault(this, reason);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.initTimer); clearInterval(this.heartbeatTimer);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.port.postMessage({ type: "stop" });
    this.port.close(); this.frame.remove();
    this.hooks.removed(this);
  }
}
