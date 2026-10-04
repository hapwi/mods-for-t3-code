(() => {
  // payload/web/manifest.ts
  var API_VERSION = 1;
  var MAX_BUNDLE_BYTES = 1024 * 1024;
  var PERMISSIONS = Object.freeze({
    "ui.panels": "Show text panels and buttons in the Mods tray",
    "ui.commands": "Register local commands in the Mods command palette",
    "ui.notify": "Show notifications labeled with the mod name",
    "ui.theme": "Apply a color theme across the T3 interface",
    "ui.band": "Show one line of styled text above the composer",
    "ui.context": "Show a context usage ring and token breakdown above the composer",
    "session.usage": "Read measured context usage for the open thread",
    "app.route": "Read the current app route and follow navigation",
    "draft.read": "Read the current composer draft",
    "draft.insert": "Offer text to paste into the composer, with your confirmation",
    storage: "Store up to 64 KB of private mod data"
  });
  function read(value, key) {
    return Reflect.get(value, key);
  }
  function safeInt(value) {
    return typeof value === "number" && Number.isSafeInteger(value);
  }
  function isPermission(value) {
    return typeof value === "string" && Object.hasOwn(PERMISSIONS, value);
  }
  function validateManifest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A mod needs a manifest object.");
    if (read(value, "apiVersion") !== API_VERSION) throw new Error(`This host supports mod API ${API_VERSION}.`);
    const id = read(value, "id");
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error("Mod ID must be 2\u201364 lowercase letters, digits, or hyphens.");
    const version = read(value, "version");
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Use a SemVer version, for example 1.0.0.");
    const text = {};
    for (const field of ["name", "description", "author"]) {
      const item = read(value, field);
      if (typeof item !== "string" || !item.trim() || item.length > (field === "description" ? 600 : 100)) throw new Error(`Supply a short ${field}.`);
      text[field] = item;
    }
    const permissions = read(value, "permissions");
    if (!Array.isArray(permissions) || !permissions.every(isPermission)) throw new Error("The manifest contains an unsupported permission.");
    if (new Set(permissions).size !== permissions.length) throw new Error("Permissions must be unique.");
    const name = text.name;
    const description = text.description;
    const author = text.author;
    if (name === void 0 || description === void 0 || author === void 0) throw new Error("Supply a short name.");
    return { apiVersion: API_VERSION, id, version, name, description, author, permissions: [...permissions] };
  }
  function validateBundle(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Import a complete .t3mod JSON bundle returned by Create or exported from Mods.");
    const manifest = validateManifest(read(value, "manifest"));
    const code = read(value, "code");
    if (read(value, "format") !== "t3mod/1" || typeof code !== "string" || !code.trim()) throw new Error("This file needs format t3mod/1 and its complete JavaScript code. Ask your AI to return the full bundle, not a CLI plugin or source file.");
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BUNDLE_BYTES) throw new Error("A mod bundle must be smaller than 1 MB.");
    return { format: "t3mod/1", manifest, code };
  }
  function assertPermission(manifest, permission) {
    if (!manifest.permissions.includes(permission)) throw new Error(`Permission not granted: ${permission}`);
  }
  function textValue(value, limit = 4e3) {
    if (typeof value !== "string" || value.length > limit) throw new Error(`Expected text of at most ${limit} characters.`);
    return value;
  }
  function validatePanel(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a panel.");
    const title = textValue(read(value, "title"), 100);
    const bodyField = read(value, "body");
    const body = textValue(bodyField == null ? "" : bodyField, 1e4);
    const rawActions = read(value, "actions") ?? [];
    if (!Array.isArray(rawActions) || rawActions.length > 8) throw new Error("A panel can contain up to 8 actions.");
    const actions = rawActions.map((action) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("Expected text of at most 64 characters.");
      return { id: textValue(read(action, "id"), 64), label: textValue(read(action, "label"), 80) };
    });
    return { title, body, actions };
  }
  var BAND_TONES = ["default", "muted", "yellow", "cyan", "blue", "magenta", "red"];
  function isBandTone(value) {
    return typeof value === "string" && BAND_TONES.some((tone) => tone === value);
  }
  function validateBand(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("A band needs 1\u201316 text parts.");
    let total = 0;
    const parts = value.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("Each band part needs text.");
      const text = textValue(read(part, "text"), 160);
      if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) throw new Error("Band text must be a single line without control characters.");
      const tone = read(part, "tone") ?? "default";
      if (!isBandTone(tone)) throw new Error(`Use a band tone: ${BAND_TONES.join(", ")}.`);
      total += text.length;
      return { text, tone };
    });
    if (total > 300) throw new Error("A band can show up to 300 characters.");
    return parts;
  }
  function usageSnapshot(value) {
    if (!value || typeof value !== "object") return null;
    const id = (item) => typeof item === "string" && item.length > 0 && item.length <= 300 ? item : null;
    const threadId = id(read(value, "threadId"));
    const usedTokens = read(value, "usedTokens");
    if (!threadId || !safeInt(usedTokens) || usedTokens < 0) return null;
    const turnId = id(read(value, "turnId"));
    const maxTokens = read(value, "maxTokens");
    const measuredAt = read(value, "measuredAt");
    const breakdown = contextBreakdown(read(value, "breakdown"), usedTokens);
    return {
      threadId,
      turnId,
      usedTokens,
      maxTokens: safeInt(maxTokens) && maxTokens > 0 ? maxTokens : null,
      measuredAt: typeof measuredAt === "number" && Number.isFinite(measuredAt) ? measuredAt : Date.now(),
      complete: read(value, "complete") === true && turnId !== null,
      ...breakdown ? { breakdown } : {}
    };
  }
  function contextBreakdown(value, usedTokens) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
    const result = {};
    let total = 0;
    for (const key of ["systemPrompt", "toolDefinitions", "rules", "skills", "mcpTools", "summarizedConversation", "conversation"]) {
      const count = read(value, key);
      if (count === void 0) continue;
      if (!safeInt(count) || count < 0) return void 0;
      result[key] = count;
      total += count;
    }
    return Object.keys(result).length && total <= usedTokens ? result : void 0;
  }

  // payload/web/database.ts
  var DB_NAME = "mods-for-t3-code-v1";
  var opening;
  function open() {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("mods", { keyPath: "manifest.id" });
        request.result.createObjectStore("data");
        request.result.createObjectStore("settings");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = void 0;
        reject(request.error ?? new Error("Could not open mod storage."));
      };
    });
    return opening;
  }
  async function operation(store, mode, callback) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      let result;
      const request = callback(transaction.objectStore(store));
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Mod storage failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Mod storage transaction cancelled."));
    });
  }
  function jsonObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  }
  var database = {
    async list() {
      const records = await operation("mods", "readonly", (store) => store.getAll());
      return Array.isArray(records) ? records : [];
    },
    save(record) {
      return operation("mods", "readwrite", (store) => store.put(record)).then(() => void 0);
    },
    async remove(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["mods", "data"], "readwrite");
        transaction.objectStore("mods").delete(id);
        transaction.objectStore("data").delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Mod storage failed."));
      });
    },
    async getData(id) {
      return jsonObject(await operation("data", "readonly", (store) => store.get(id)));
    },
    setData(id, value) {
      return operation("data", "readwrite", (store) => store.put(value, id)).then(() => void 0);
    },
    getSetting(key) {
      return operation("settings", "readonly", (store) => store.get(key));
    },
    setSetting(key, value) {
      return operation("settings", "readwrite", (store) => store.put(value, key)).then(() => void 0);
    }
  };

  // payload/web/builtin-updates.ts
  var LEGACY_WEATHER = /* @__PURE__ */ new Set([
    "ee89f18bd37f8cce096e42ebbb608a29389fa3f85ef973e133d300da697a89e8",
    "6adf3981c6104b2319bbdf564b87e32ed42770cc821c07e38588f239210f023a"
  ]);
  async function updateLegacyWeather(record, examples) {
    if (record.manifest.id !== "token-weather") return record;
    const current = examples.find((bundle) => bundle.manifest.id === "token-weather");
    if (!current || current.code === record.code) return record;
    const { manifest: m } = record;
    const serialized = JSON.stringify({
      format: record.format,
      manifest: { apiVersion: m.apiVersion, id: m.id, version: m.version, name: m.name, description: m.description, author: m.author, permissions: [...m.permissions].sort() },
      code: record.code
    });
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    const fingerprint = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!LEGACY_WEATHER.has(fingerprint)) return record;
    const replacement = validateBundle(current);
    if (replacement.manifest.author !== m.author || replacement.manifest.permissions.some((permission) => !m.permissions.includes(permission))) return record;
    return { ...record, ...replacement };
  }

  // payload/web/route.ts
  function routePath(value = location) {
    const path = value.hash?.startsWith("#/") ? value.hash.slice(1) : value.pathname;
    return path.split(/[?#]/, 1)[0] || "/";
  }

  // payload/web/runtime.ts
  var MOD_METHODS = /* @__PURE__ */ new Set(["events.subscribe", "commands.register", "panels.set", "panels.clear", "notify", "theme.set", "theme.clear", "band.set", "band.clear", "context.show", "context.clear", "session.usage", "route.get", "draft.read", "draft.insert", "storage.get", "storage.set", "log"]);
  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }
  function isModMethod(value) {
    return typeof value === "string" && MOD_METHODS.has(value);
  }
  function jsonValue(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map((item) => jsonValue(item));
    if (typeof value === "object") {
      const result = {};
      for (const [key, item] of Object.entries(value)) if (item !== void 0) result[key] = jsonValue(item);
      return result;
    }
    throw new Error("Storage values must be JSON.");
  }
  function eventPermission(name) {
    switch (name) {
      case "app.route":
        return "app.route";
      case "draft.change":
        return "draft.read";
      case "session.usage":
      case "turn.complete":
        return "session.usage";
      default:
        return void 0;
    }
  }
  var ModRuntime = class {
    record;
    hooks;
    stopped = false;
    pending = /* @__PURE__ */ new Map();
    subscriptions = /* @__PURE__ */ new Set();
    inFlight = 0;
    callTimes = [];
    sequence = 0;
    lastHeartbeat = Date.now();
    lastTick = Date.now();
    frame = document.createElement("iframe");
    channel = new MessageChannel();
    port;
    initTimer;
    heartbeatTimer;
    storageQueue;
    constructor(record, hooks, sandboxDocument) {
      this.record = record;
      this.hooks = hooks;
      this.frame.hidden = true;
      this.frame.title = `${record.manifest.name} isolated runtime`;
      this.frame.setAttribute("sandbox", "allow-scripts");
      this.frame.srcdoc = sandboxDocument;
      this.port = this.channel.port1;
      this.port.onmessage = (event) => {
        void this.receive(event.data);
      };
      this.port.start();
      this.frame.onload = () => this.frame.contentWindow?.postMessage({ type: "t3mods.connect" }, "*", [this.channel.port2]);
      document.body.append(this.frame);
      this.initTimer = setTimeout(() => this.fail("Mod startup took longer than 5 seconds."), 5e3);
      this.heartbeatTimer = setInterval(() => {
        const now = Date.now();
        const hostStalled = now - this.lastTick > 2500;
        this.lastTick = now;
        if (hostStalled) {
          this.lastHeartbeat = now;
          return;
        }
        if (now - this.lastHeartbeat > 5e3) this.fail("Mod stopped responding and was quarantined.");
      }, 1e3);
    }
    async receive(message) {
      if (this.stopped || !isRecord(message) || typeof message.type !== "string") return;
      if (message.type === "connected") {
        this.port.postMessage({ type: "init", code: this.record.code });
      } else if (message.type === "ready") {
        clearTimeout(this.initTimer);
        this.hooks.ready(this);
      } else if (message.type === "heartbeat") {
        this.lastHeartbeat = Date.now();
      } else if (message.type === "fault") {
        this.fail(String(message.error).slice(0, 1e3));
      } else if (message.type === "done") {
        if (typeof message.requestId !== "number") return;
        clearTimeout(this.pending.get(message.requestId));
        this.pending.delete(message.requestId);
      } else if (message.type === "call") {
        const now = Date.now();
        this.callTimes = this.callTimes.filter((time) => now - time < 1e3);
        this.callTimes.push(now);
        if (this.callTimes.length > 100 || this.inFlight > 20) {
          this.fail("Mod exceeded its request limit.");
          return;
        }
        this.inFlight++;
        const userDecision = message.method === "draft.insert";
        if (userDecision) for (const timer of this.pending.values()) clearTimeout(timer);
        try {
          const args = Array.isArray(message.args) ? message.args.map((item) => item) : null;
          if (!Number.isSafeInteger(message.id) || !args || JSON.stringify(args).length > 1e5) throw new Error("Invalid host request.");
          const value = await this.handle(message.method, args);
          if (!this.stopped) this.port.postMessage({ type: "result", id: message.id, value });
        } catch (error) {
          if (!this.stopped) this.port.postMessage({ type: "result", id: message.id, error: error instanceof Error ? error.message : "Mod request failed." });
        } finally {
          this.inFlight--;
          if (userDecision && !this.stopped) {
            this.lastHeartbeat = Date.now();
            for (const id of this.pending.keys()) this.pending.set(id, setTimeout(() => this.fail("A mod action took longer than 5 seconds."), 5e3));
          }
        }
      }
    }
    async handle(method, args) {
      if (!isModMethod(method)) throw new Error("Unknown mod API method.");
      const manifest = this.record.manifest;
      const require2 = (permission) => assertPermission(manifest, permission);
      switch (method) {
        case "events.subscribe": {
          const name = textValue(args[0], 40);
          const permission = eventPermission(name);
          if (!permission) throw new Error("Unsupported event.");
          require2(permission);
          this.subscriptions.add(name);
          return;
        }
        case "commands.register": {
          require2("ui.commands");
          const command = args[0];
          if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("Expected text of at most 64 characters.");
          this.hooks.command(this, { id: textValue(Reflect.get(command, "id"), 64), title: textValue(Reflect.get(command, "title"), 100) });
          return;
        }
        case "panels.set":
          require2("ui.panels");
          this.hooks.panel(this, validatePanel(args[0]));
          return;
        case "panels.clear":
          require2("ui.panels");
          this.hooks.panel(this, null);
          return;
        case "notify":
          require2("ui.notify");
          this.hooks.notify(this, textValue(args[0], 500));
          return;
        case "theme.set":
          require2("ui.theme");
          this.hooks.theme(this, args[0]);
          return;
        case "theme.clear":
          require2("ui.theme");
          this.hooks.theme(this, null);
          return;
        case "band.set":
          require2("ui.band");
          this.hooks.band(this, validateBand(args[0]));
          return;
        case "band.clear":
          require2("ui.band");
          this.hooks.band(this, null);
          return;
        case "context.show":
          require2("ui.context");
          require2("session.usage");
          this.hooks.context(this, true);
          return;
        case "context.clear":
          require2("ui.context");
          this.hooks.context(this, false);
          return;
        case "session.usage":
          require2("session.usage");
          return this.hooks.usage();
        case "route.get":
          require2("app.route");
          return routePath();
        case "draft.read":
          require2("draft.read");
          return this.hooks.readDraft();
        case "draft.insert":
          require2("draft.insert");
          return this.hooks.insertDraft(this, textValue(args[0], 3e4));
        case "storage.get": {
          require2("storage");
          const key = textValue(args[0], 100);
          const value = await database.getData(manifest.id);
          return Object.hasOwn(value, key) ? value[key] : null;
        }
        case "storage.set": {
          require2("storage");
          const key = textValue(args[0], 100);
          if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Reserved storage key.");
          const stored = jsonValue(args[1]);
          this.storageQueue = (this.storageQueue ?? Promise.resolve()).catch(() => void 0).then(async () => {
            const value = await database.getData(manifest.id);
            const next = { ...value, [key]: stored };
            if (new TextEncoder().encode(JSON.stringify(next)).length > 65536) throw new Error("Mod storage is limited to 64 KB.");
            if (!this.stopped) await database.setData(manifest.id, next);
          });
          return this.storageQueue;
        }
        case "log":
          this.hooks.log(this, textValue(args[0], 1e3));
          return;
        default: {
          const unreachable = method;
          throw new Error(`Unknown mod API method: ${unreachable}`);
        }
      }
    }
    dispatch(message) {
      if (this.stopped || this.pending.size > 10) return;
      const requestId = ++this.sequence;
      const timer = setTimeout(() => this.fail("A mod action took longer than 5 seconds."), 5e3);
      this.pending.set(requestId, timer);
      this.port.postMessage({ ...message, requestId });
    }
    emit(name, value) {
      if (this.subscriptions.has(name)) this.dispatch({ type: "event", name, value });
    }
    invoke(kind, id) {
      this.dispatch({ type: "invoke", kind, id });
    }
    fail(reason) {
      if (this.stopped) return;
      this.stop();
      void this.hooks.fault(this, reason);
    }
    stop() {
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
  };

  // payload/web/adapter.ts
  function composer() {
    const editors = [...document.querySelectorAll('[data-testid="composer-editor"][contenteditable="true"]')];
    return editors.find((editor) => editor.getClientRects().length > 0) ?? null;
  }
  function readDraft() {
    return composer()?.innerText ?? "";
  }
  function insertDraft(text) {
    const editor = composer();
    if (!editor) throw new Error("Open a T3 thread with a composer, then try again.");
    editor.focus();
    const selection = getSelection();
    if (!selection) throw new Error("Open a T3 thread with a composer, then try again.");
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
    editor.dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error("This T3 editor does not support the paste adapter. Copy the text and paste it manually.");
  }
  var FLOATING = { position: "absolute", left: "0", width: "auto", maxWidth: "none", margin: "0", zIndex: "30", pointerEvents: "none" };
  function dockContextControl(element2, fallback) {
    let wanted = false;
    let meter = null;
    let original;
    let frame;
    const initialStyle = element2.style.cssText;
    function restore() {
      if (meter && original) {
        if (original.value) meter.style.setProperty("display", original.value, original.priority);
        else meter.style.removeProperty("display");
      }
      meter = null;
      original = void 0;
    }
    function place() {
      frame = void 0;
      if (!wanted) {
        restore();
        fallback(false);
        element2.remove();
        return;
      }
      const editor = composer();
      const form = editor?.closest("[data-chat-composer-form]") ?? editor?.closest("form");
      const next = form?.querySelector('button[aria-label^="Context window " i]') ?? null;
      if (next !== meter) {
        restore();
        meter = next;
        if (meter) original = { value: meter.style.getPropertyValue("display"), priority: meter.style.getPropertyPriority("display") };
      }
      if (meter?.parentElement) {
        fallback(false);
        element2.style.cssText = initialStyle;
        if (element2.nextSibling !== meter) meter.before(element2);
        meter.style.setProperty("display", "none", "important");
      } else fallback(true);
    }
    function schedule() {
      if (wanted && frame === void 0) frame = requestAnimationFrame(place);
    }
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return {
      show(value) {
        wanted = value;
        place();
      },
      dispose() {
        wanted = false;
        observer.disconnect();
        if (frame !== void 0) cancelAnimationFrame(frame);
        restore();
        fallback(false);
        element2.remove();
      }
    };
  }
  function dockAboveComposer(element2) {
    let wanted = false;
    let frame;
    let observed = [];
    const inFlow = element2.style.cssText;
    const resizeObserver = new ResizeObserver(() => schedule());
    function schedule() {
      if (wanted && frame === void 0) frame = requestAnimationFrame(place);
    }
    function watch(...targets) {
      const next = targets.filter((target) => Boolean(target));
      if (next.length === observed.length && next.every((target, index) => target === observed[index])) return;
      resizeObserver.disconnect();
      observed = next;
      for (const target of next) resizeObserver.observe(target);
    }
    function float(main, dock) {
      const box = main.getBoundingClientRect();
      const parts = dock?.getClientRects().length ? [...dock.children].map((child) => child.getBoundingClientRect()).filter((rect) => rect.width && rect.height) : [];
      let lift = 0;
      let reserve = 0;
      if (parts.some((rect) => rect.width > box.width / 2 || rect.left < box.left + box.width / 2)) lift = Math.max(0, box.top - Math.min(...parts.map((rect) => rect.top)));
      else if (parts.length) reserve = Math.max(0, box.right - Math.min(...parts.map((rect) => rect.left)) + 8);
      Object.assign(element2.style, FLOATING, { right: `${reserve}px`, bottom: `calc(100% + ${lift}px)` });
    }
    function place() {
      frame = void 0;
      const editor = wanted ? composer() : null;
      if (!editor) {
        watch();
        element2.remove();
        return;
      }
      const main = editor.closest("[data-chat-composer-main-surface]");
      const form = editor.closest("[data-chat-composer-form]") ?? editor.closest("form");
      if (main?.parentElement) {
        if (element2.nextElementSibling !== main) main.before(element2);
        const dock = form ? [...form.children].find((child) => child instanceof HTMLElement && child.matches('[data-slot="composer-banner-attachment"]')) ?? null : null;
        watch(main, dock);
        float(main, dock);
        return;
      }
      watch();
      element2.style.cssText = inFlow;
      const anchor = form ?? editor;
      if (!anchor.parentElement) {
        element2.remove();
        return;
      }
      if (element2.nextElementSibling !== anchor) anchor.before(element2);
    }
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true });
    return {
      show(value) {
        wanted = value;
        place();
      },
      dispose() {
        wanted = false;
        observer.disconnect();
        resizeObserver.disconnect();
        if (frame !== void 0) cancelAnimationFrame(frame);
        element2.remove();
      }
    };
  }
  var MODS_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h4v4a2 2 0 1 0 4 0V3h5v7h-4a2 2 0 1 0 0 4h4v7h-7v-4a2 2 0 1 0-4 0v4H3v-7h4a2 2 0 1 0 0-4H3V3h5Z"/></svg>';
  var UTILITY_PAGE = /^\/(settings|usage|pull-requests)(\/|$)/;
  function sidebarFooter() {
    return document.querySelector('[data-sidebar="footer"]') ?? document.querySelector('[data-slot="sidebar-footer"]');
  }
  function footerReference(footer) {
    const icons = [...footer.querySelectorAll("button[aria-label]")].filter((item) => item instanceof HTMLButtonElement && !item.closest("[data-t3mods]") && !item.textContent?.trim() && Boolean(item.querySelector("svg")));
    const menuButtons = icons.filter((item) => item.classList.contains("peer/menu-button") || item.getAttribute("data-sidebar") === "menu-button" || item.getAttribute("data-slot") === "sidebar-menu-button");
    return menuButtons.at(-1) ?? icons.at(-1) ?? null;
  }
  function attachTooltip(target, label) {
    let tip;
    let timer;
    function hide() {
      clearTimeout(timer);
      tip?.remove();
      tip = void 0;
    }
    function show() {
      if (tip || !target.isConnected) return;
      tip = document.createElement("div");
      tip.dataset.t3mods = "tooltip";
      tip.setAttribute("role", "tooltip");
      tip.textContent = label;
      tip.style.cssText = "position:fixed;z-index:2147483000;pointer-events:none;padding:4px 8px;border:1px solid var(--border,#ffffff1a);border-radius:calc(var(--radius,.625rem) - 2px);background:var(--popover,#1c1c1f);color:var(--popover-foreground,var(--foreground,#f5f5f5));font:12px/16px var(--font-sans,system-ui,sans-serif);white-space:nowrap;box-shadow:0 4px 12px #0000000d";
      document.body.append(tip);
      const box = target.getBoundingClientRect();
      const left = Math.max(4, Math.min(innerWidth - tip.offsetWidth - 4, box.left + box.width / 2 - tip.offsetWidth / 2));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(4, box.top - tip.offsetHeight - 6)}px`;
    }
    const delayed = () => {
      clearTimeout(timer);
      timer = setTimeout(show, 400);
    };
    target.addEventListener("pointerenter", delayed);
    target.addEventListener("pointerleave", hide);
    target.addEventListener("focus", () => {
      if (target.matches(":focus-visible")) show();
    });
    target.addEventListener("blur", hide);
    target.addEventListener("click", hide);
    return hide;
  }
  function attachSidebarButton(open2) {
    const label = "Mods";
    const button2 = document.createElement("button");
    button2.type = "button";
    button2.dataset.t3mods = "sidebar-button";
    button2.setAttribute("aria-label", label);
    button2.innerHTML = MODS_ICON;
    button2.onclick = open2;
    const hideTip = attachTooltip(button2, label);
    const item = document.createElement("li");
    item.dataset.t3mods = "sidebar-item";
    let reference;
    let frame;
    function mirror(native) {
      if (reference === native) return;
      reference = native;
      button2.className = native.className;
      for (const { name } of [...button2.attributes]) if (name.startsWith("data-") && name !== "data-t3mods") button2.removeAttribute(name);
      for (const { name, value } of native.attributes) if (/^data-(slot|sidebar|size|variant)$/.test(name)) button2.setAttribute(name, value);
      button2.style.cssText = "";
      const nativeItem = native.closest("li");
      item.className = nativeItem?.className ?? "";
      item.style.cssText = nativeItem ? "" : "list-style:none;display:flex;flex-shrink:0";
    }
    function place(target) {
      if (target.nextSibling !== item) target.after(item);
    }
    function attach() {
      frame = void 0;
      const footer = sidebarFooter();
      const native = footer ? footerReference(footer) : null;
      if (native) {
        mirror(native);
        if (button2.parentElement !== item) item.append(button2);
        place(native.closest("li") ?? native);
        return;
      }
      reference = void 0;
      if (footer && UTILITY_PAGE.test(routePath())) {
        hideTip();
        item.remove();
        button2.remove();
        return;
      }
      item.remove();
      button2.className = "";
      button2.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--control-radius,calc(var(--radius,.625rem) - 2px));background:transparent;color:var(--sidebar-muted-foreground,var(--muted-foreground,#a1a1aa));cursor:pointer";
      if (footer) {
        if (button2.parentElement !== footer) footer.append(button2);
        return;
      }
      button2.style.cssText += ";position:fixed;left:12px;bottom:12px;z-index:999;background:var(--background,#0a0a0a);border:1px solid var(--border,#ffffff1a)";
      if (button2.parentElement !== document.body) document.body.append(button2);
    }
    const observer = new MutationObserver(() => {
      if (frame === void 0) frame = requestAnimationFrame(attach);
    });
    observer.observe(document.body, { subtree: true, childList: true });
    attach();
    return () => {
      observer.disconnect();
      if (frame !== void 0) cancelAnimationFrame(frame);
      hideTip();
      button2.remove();
      item.remove();
    };
  }

  // payload/web/author.ts
  function authorPrompt(description, inbox) {
    return `Create a mod for Mods for T3 Code (API version 1).

What I want: ${description}

Use my existing T3 provider session. Do not change T3 itself. Nothing runs until I review the mod in the Mods manager and choose Install.

${contract(inbox, "After the two blocks, tell me in plain words what the mod does and which permissions to review.")}`;
  }
  function quote(info, text) {
    const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)));
    return `${fence}${info}
${text}
${fence}`;
  }
  function editPrompt(change, source, inbox) {
    const { bundle: { manifest, code }, installed, builtIn } = source;
    const [major = 0, minor = 0] = /^(\d+)\.(\d+)\.\d+/.exec(manifest.version)?.slice(1).map(Number) ?? [];
    const origin = installed ? builtIn ? "This is my installed copy of a built-in mod, including any changes made to it since. Edit this code, not the original built-in sample." : "This is the version I have installed." : "This is a built-in mod included with Mods for T3 Code. It is not installed yet; send an edited variant I can install instead of the original.";
    return `Edit a mod for Mods for T3 Code (API version 1).

Mod: "${manifest.name}" (id ${manifest.id}, version ${manifest.version}, author ${manifest.author}). ${origin}

What I want changed: ${change}

Start from the complete current manifest and code below. Keep the id "${manifest.id}" and the author "${manifest.author}" exactly, and give it a higher SemVer version than ${manifest.version}, for example ${major}.${minor + 1}.0. Keep every existing feature and behavior I did not ask to change, and keep the name and description unless the change calls for new ones. Add a permission only when the change needs it. Send the complete updated mod, not a diff or only the changed parts.

Current manifest:
${quote("json", JSON.stringify(manifest, null, 2))}

Current code:
${quote("javascript", code)}

Use my existing T3 provider session. Do not change T3 itself. Nothing changes until I review the edited mod in the Mods manager and choose ${installed ? "Update mod; until then the installed version keeps running" : "Install mod"}.

${contract(inbox, "After the two blocks, tell me in plain words what you changed and any new permissions to review.")}`;
  }
  function contract(inbox, closing) {
    const destination = inbox || "the current workspace";
    return `How to hand the mod back:
Your finished reply must contain exactly two fenced code blocks, in this order, with nothing else inside them:

\`\`\`t3mod-manifest
{"apiVersion":1,"id":"lowercase-mod-id","version":"1.0.0","name":"Readable name","description":"What it does","author":"AI assisted","permissions":[]}
\`\`\`

\`\`\`t3mod-code
globalThis.T3Mod = {
  async activate(api) {
    // implementation
  },
};
\`\`\`

- t3mod-manifest holds only the manifest as raw JSON.
- t3mod-code holds the complete raw JavaScript, not a JSON string, so do not escape quotes or newlines. Never put a line of three backticks inside it.
- Use these exact tags. Do not tag the blocks json, js, or markdown, and do not split the code across blocks. Manifest and code together must stay under 1 MB.
- T3 reads both blocks from your finished reply and lists the mod in the Mods manager under Waiting for review, even when you run on another computer. If something does not validate, the manager shows me the reason. A mod I already installed or dismissed does not ask again.
- Optional: if ${destination} is a folder on this computer that you can write to, also save the complete bundle there as <id>.t3mod, a JSON file of the form {"format":"t3mod/1","manifest":{\u2026},"code":"\u2026"} with the same manifest and code. Skip this when you cannot write there; the two blocks are what count.
- When I ask for changes later, send both blocks again with the same id and a higher version. The update replaces the older one waiting for review, and installing it replaces the running version.

T3 integration and design contract:
This is a mod inside the existing T3 Code Electron app, written for the Mods for T3 Code API below. It is not a Claude Code plugin or Claude Code mod: T3 runs Claude through the Agent SDK, which does not render Claude Code mod UI inside T3. Do not use the plugin-authoring skill, plugin.json, hooks.json, register.js, register(), on(), ui.render, $.ui, tool.call or tool.check hooks, or any other Claude Code mods API, and do not write files under ~/.claude. T3 already owns the sidebar, Settings, thread list, conversation, composer, provider picker, and attachment drawer. Use the supported host surfaces below; do not rebuild T3, inject an overlay, invent DOM selectors, or assume a Claude Code terminal plugin API. Mods are workers, so document/window/React and T3's internal stores are unavailable. The host places and styles your output to match the current T3 theme.
For a compact live indicator above the prompt use ui.band, with short plain text and semantic tones. Do not add a title panel or a second composer for a one-line indicator. For interactive actions use ui.panels or ui.commands. For themes use paired ui.theme tokens, including sidebar tokens when needed, instead of CSS or hardcoded layout. Keep labels concise, avoid decorative headings and redundant controls, and let the host choose fonts, spacing, borders, and light/dark colors.
Install starts the mod immediately after permission review. It must work without restarting T3, update while the app stays open, and clean up its own timers when disabled. Treat navigation as a change of thread: do not display a previous thread's measurements on the next thread. Cache history by threadId, deduplicate completed turns by turnId, and preserve it with storage only if requested.
Context measurements come from T3's actual provider-turn reports and cached thread projections. They are context-window usage, not subscription limits, cumulative billing totals, or a text-length estimate. A provider may return no measurement yet (for example in a blank conversation); prefer hiding a live context band with api.band.clear() until a measurement exists, rather than showing a placeholder. maxTokens may be unknown; show that with a short muted note. Omit a turn delta until two completed turns have been measured instead of showing an unknown placeholder; never guess a 200k window, percentage, turn delta, or chart sample. Do not infer a token count from the model's name. Subscribe to both session.usage and turn.complete, and read api.session.usage() on activation. A completed turn may receive a corrected measurement later. Live indicators should render real data as soon as it arrives.

Mod code:
The t3mod-code block is complete JavaScript, runs in an isolated browser worker, and must set globalThis.T3Mod.activate. No imports, DOM, Node, filesystem, network, credentials, tool approval, or model calls are available. A mod cannot intercept, block, rewrite, or approve tool calls, prompts, permission requests, or model requests, and it cannot replace T3's own interface; only the surfaces listed below exist. Declare only the permissions you need:
- ui.panels: api.panels.set({title,body,actions:[{id,label}]}), api.panels.clear(), api.panels.action(id, async () => {}). One text panel per mod.
- ui.commands: await api.commands.register({id,title}, async () => {}). Commands run locally when I click them.
- ui.notify: await api.notify("message").
- ui.theme: await api.theme.set({background:"#17212f",foreground:"#edf2f8",...}); api.theme.clear(). Supported tokens: background/foreground, card/card-foreground, popover/popover-foreground, primary/primary-foreground, secondary/secondary-foreground, muted/muted-foreground, accent/accent-foreground, sidebar/sidebar-foreground, sidebar-primary/sidebar-primary-foreground, sidebar-accent/sidebar-accent-foreground, border,input,ring,sidebar-border,sidebar-ring. Always provide both tokens in a pair, including background and foreground. Only #RRGGBB colors; text pairs need 4.5:1 contrast. No arbitrary CSS. Turning the mod off restores the normal theme.
- ui.band: await api.band.set([{text:"\u2600 Clear",tone:"yellow"},{text:"  20%"}]); api.band.clear(). One line of plain text above the composer, 1\u201316 parts, up to 160 characters each and 300 in total. Tones: default, muted, yellow, cyan, blue, magenta, red. No HTML, markdown, or newlines.
- ui.context + session.usage: await api.context.show(); api.context.clear(). Shows a host-rendered usage ring in the native composer meter slot (or above the composer on older builds). Clicking opens the measured context breakdown. Updates automatically; absent category counts are labeled unavailable. No access to conversation text.
- session.usage: await api.session.usage() returns {threadId,turnId,usedTokens,maxTokens,measuredAt,complete} for the open thread, or null. api.on("session.usage", snapshot => {}) fires on new measurements and on navigation (snapshot may be null). api.on("turn.complete", snapshot => {}) fires when a turn completes and can repeat for the same turnId with a later measurement, so replace rather than append. maxTokens can be null: show that the window is unknown and never assume a size. These are measurements only; no prompt or response text.
- app.route: await api.route.get(); api.on("app.route", path => {}).
- draft.read: await api.draft.read(); api.on("draft.change", text => {}). Drafts may contain sensitive text.
- draft.insert: await api.draft.insert("text"). This ALWAYS asks for my confirmation, pastes at the end, and never sends a prompt.
- storage: await api.storage.get("key"); await api.storage.set("key", JSONValue). 64 KB per mod.
- api.log("message") is always available.
activate may return a cleanup function. All actions should finish within 5 seconds. Timers are fine. Long loops cause quarantine. Never request permissions outside this list.

Before you answer, check the JavaScript syntax and that the manifest is valid JSON, without executing host API calls outside T3. Walk through activation, missing data, unknown window size, navigation, repeated completion events, disable, and re-enable. Do not claim a live T3 check you did not perform. ${closing}`;
  }
  function fixPrompt(name, id, version, problem) {
    const target = id ? `"${name}" (id ${id}${version ? `, version ${version}` : ""})` : `"${name}"`;
    return `The Mods for T3 Code mod ${target} needs a fix: ${problem}

Fix the cause and send the complete corrected mod again as two fenced code blocks: one tagged t3mod-manifest with only the manifest JSON (the same id${id ? "" : " as before"} and a higher version), and one tagged t3mod-code with the complete raw JavaScript, not a JSON string. Keep to the Mods for T3 Code API and permission list from the original request; do not use Claude Code plugin APIs. Check the JavaScript syntax and that the manifest is valid JSON before you answer, then tell me what you changed.`;
  }

  // payload/web/style.ts
  var style = `
:host{--mf-fg:var(--foreground,#f5f5f5);--mf-muted:var(--muted-foreground,#a1a1aa);--mf-border:var(--border,#ffffff14);--mf-input:var(--input,var(--mf-border));--mf-bg:var(--background,#0a0a0a);--mf-card:var(--card,var(--mf-bg));--mf-popover:var(--popover,var(--mf-bg));--mf-accent:var(--accent,color-mix(in srgb,var(--mf-fg) 6%,transparent));--mf-primary:var(--primary,#3b82f6);--mf-primary-fg:var(--primary-foreground,#fff);--mf-ring:var(--ring,var(--mf-muted));--mf-danger:var(--destructive,#ef4444);--mf-radius:var(--radius,.625rem);--mf-control-radius:var(--control-radius,calc(var(--mf-radius) - 2px));font:13px/1.5 var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif);color:var(--mf-fg);color-scheme:inherit;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}h1,h2,h3,p{margin:0}button,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid color-mix(in srgb,var(--mf-ring) 60%,transparent);outline-offset:1px}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 9px;border:1px solid var(--mf-input);border-radius:var(--mf-control-radius);background:color-mix(in srgb,var(--mf-input) 32%,transparent);font-size:13px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s,color .15s,border-color .15s}
button:hover{background:color-mix(in srgb,var(--mf-accent) 60%,transparent)}button:disabled{opacity:.64;cursor:default;pointer-events:none}
button.primary{background:var(--mf-primary);border-color:var(--mf-primary);color:var(--mf-primary-fg)}button.primary:hover{background:color-mix(in srgb,var(--mf-primary) 90%,transparent)}
button.ghost,button.danger{background:transparent;border-color:transparent;color:var(--mf-muted)}button.ghost:hover,button.danger:hover{background:var(--mf-accent);color:var(--mf-fg)}button.danger:hover{color:var(--mf-danger)}
button.destructive{background:var(--mf-danger);border-color:var(--mf-danger);color:#fff}
button.xs{height:24px;padding:0 7px;font-size:12px;gap:4px}button.icon{width:28px;padding:0}button.icon.xs{width:24px}button svg{width:16px;height:16px;flex:none}
input.switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:32px;height:20px;margin:0;padding:0;border:1px solid color-mix(in srgb,var(--mf-fg) 14%,transparent);border-radius:999px;background:color-mix(in srgb,var(--mf-fg) 20%,transparent);cursor:pointer;transition:background-color .2s,border-color .2s}
input.switch::after{content:"";position:absolute;top:1px;left:1px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0003;transition:transform .2s}
input.switch:checked{background:var(--mf-primary);border-color:var(--mf-primary)}input.switch:checked::after{transform:translateX(12px)}input.switch:disabled{opacity:.64;cursor:default}
input[type=search],input[type=text],textarea{display:block;width:100%;min-height:32px;padding:5px 10px;border:1px solid var(--mf-input);border-radius:var(--mf-control-radius);background:color-mix(in srgb,var(--mf-input) 32%,transparent);font-size:13px;outline:none}
input[type=search]:focus-visible,textarea:focus-visible{border-color:var(--mf-ring);outline:2px solid color-mix(in srgb,var(--mf-ring) 24%,transparent);outline-offset:0}
textarea{min-height:96px;max-height:240px;resize:vertical;line-height:1.5}::placeholder{color:color-mix(in srgb,var(--mf-muted) 72%,transparent)}
dialog{padding:0;margin:auto;border:1px solid var(--mf-border);border-radius:calc(var(--mf-radius) + 6px);background:var(--mf-popover);color:inherit;box-shadow:0 16px 48px #0000002e;width:min(640px,calc(100vw - 32px));height:min(600px,calc(100vh - 64px));overflow:hidden}
dialog[open]{display:flex;flex-direction:column}dialog::backdrop{background:#00000052}
dialog.ask{width:min(420px,calc(100vw - 32px));height:auto;max-height:calc(100vh - 64px)}dialog.ask .content{padding-top:4px}dialog.ask .explain{max-height:40vh;overflow:auto}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 20px 12px;flex:none}header h1{font-size:15px;font-weight:600;line-height:20px;letter-spacing:-.01em}header p{margin-top:2px;font-size:12px;color:var(--mf-muted)}.header-actions{display:flex;align-items:center;gap:4px;margin:-2px -6px 0 0}
.tabs{display:flex;align-items:center;gap:2px;flex:none;margin:0 20px 4px;padding:2px;width:max-content;max-width:calc(100% - 40px);overflow-x:auto;border-radius:calc(var(--mf-control-radius) + 2px);background:color-mix(in srgb,var(--mf-fg) 5%,transparent)}
.tabs button{height:24px;padding:0 10px;border:0;background:transparent;color:var(--mf-muted);font-size:12px}.tabs button:hover{color:var(--mf-fg);background:transparent}.tabs button[aria-selected=true]{background:color-mix(in srgb,var(--mf-fg) 10%,transparent);color:var(--mf-fg)}
.content{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px 20px 20px;display:flex;flex-direction:column;gap:20px;scrollbar-gutter:stable}
.section{display:flex;flex-direction:column;gap:8px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:20px;padding:0 4px}
.section-head h2{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:color-mix(in srgb,var(--mf-fg) 50%,transparent)}.section-head h2::before{content:"";width:12px;height:1px;background:var(--mf-border)}
.card{border:1px solid var(--mf-border);border-radius:calc(var(--mf-radius) + 6px);background:var(--mf-card)}.card>.body{padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;border-top:1px solid var(--mf-border)}.row:first-child{border-top:0}
.row-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.row h2{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;letter-spacing:-.01em;line-height:20px}.row p{font-size:12px;line-height:1.5;color:color-mix(in srgb,var(--mf-muted) 85%,transparent)}
.row-actions{display:flex;align-items:center;gap:4px;flex:none}.row-actions input.switch{margin-left:8px}
.meta{font-size:11px;color:var(--mf-muted);font-variant-numeric:tabular-nums}.state{font-size:11px;font-weight:500;line-height:16px;padding:0 6px;border-radius:999px;color:var(--mf-muted);background:color-mix(in srgb,var(--mf-fg) 7%,transparent)}.state[data-state=active]{color:var(--mf-fg)}
.state[data-state=active]::before,.state[data-state=starting]::before{content:"";display:inline-block;width:6px;height:6px;margin-right:4px;border-radius:50%;vertical-align:1px;background:var(--success,var(--color-emerald-500,#10b981))}.state[data-state=starting]::before{background:var(--mf-muted);animation:mf-pulse 1.2s ease-in-out infinite}
.state[data-state=stopped]{color:var(--mf-danger);background:color-mix(in srgb,var(--mf-danger) 12%,transparent)}.state[data-state=pending]{color:var(--mf-primary);background:color-mix(in srgb,var(--mf-primary) 14%,transparent)}
@keyframes mf-pulse{50%{opacity:.35}}@media(prefers-reduced-motion:reduce){.state[data-state=starting]::before{animation:none}}
.tabs .count{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--mf-primary);color:var(--mf-primary-fg);font-size:10px;font-weight:600;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}
.flash{padding:8px 12px;border:1px solid var(--mf-border);border-radius:var(--mf-control-radius);font-size:12px;line-height:1.5;color:var(--mf-muted);white-space:pre-wrap;overflow-wrap:anywhere}.flash[data-tone=error]{color:var(--mf-danger);border-color:color-mix(in srgb,var(--mf-danger) 35%,transparent);background:color-mix(in srgb,var(--mf-danger) 7%,transparent)}
.steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:1.5;color:var(--mf-muted)}
textarea.code{min-height:120px;font:11px/1.6 var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);white-space:pre;overflow-wrap:normal}
.card>.row+.body{border-top:1px solid var(--mf-border)}.actions .start{margin-right:auto}.notice .actions{justify-content:flex-start;margin-top:6px}
.explain{font-size:12px;line-height:1.5;color:var(--mf-muted)}.content>.explain{padding:0 4px}.permission span{font-size:13px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.error{font-size:12px;color:var(--mf-danger);white-space:pre-wrap}label{font-size:12px;font-weight:500}
.permission code,.review code{font:11px/1.4 var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--mf-muted)}
.review-title{display:flex;flex-direction:column;gap:2px}.review-title h2{font-size:15px;font-weight:600;line-height:20px}
details{font-size:12px}summary{cursor:pointer;color:var(--mf-muted);padding:2px 4px}summary:hover{color:var(--mf-fg)}
.review-code,.log{margin:8px 0 0;padding:10px 12px;max-height:220px;overflow:auto;border:1px solid var(--mf-border);border-radius:var(--mf-control-radius);background:color-mix(in srgb,var(--mf-fg) 3%,transparent);font:11px/1.6 var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);white-space:pre-wrap;overflow-wrap:anywhere}
.card>.log{margin:0;border:0;border-radius:inherit;max-height:none;min-height:120px;background:transparent}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}.footer{flex:none;padding:12px 20px;border-top:1px solid var(--mf-border);background:color-mix(in srgb,var(--mf-fg) 2%,transparent)}
.menu{position:fixed;z-index:10;min-width:140px;padding:4px;display:flex;flex-direction:column;border:1px solid var(--mf-border);border-radius:var(--mf-radius);background:var(--mf-popover);box-shadow:0 8px 24px #00000029}
.menu button{justify-content:flex-start;height:28px;padding:0 8px;border:0;border-radius:calc(var(--mf-radius) - 4px);background:transparent;color:var(--mf-fg);font-weight:400;outline:none}.menu button:hover,.menu button:focus-visible{background:var(--mf-accent)}.menu button.danger{color:var(--mf-danger)}
.decision-preview{white-space:pre-wrap;overflow-wrap:anywhere}
:host([data-inline]){display:flex;flex-direction:column;flex:1;min-height:0}
dialog[data-inline]{position:static;flex:1;min-height:0;width:100%;height:auto;max-width:none;max-height:none;margin:0;border:0;border-radius:0;box-shadow:none;background:transparent}
dialog[data-inline]>header,dialog[data-inline]>.content,dialog[data-inline]>.footer{padding-inline:max(24px,calc((100% - 48rem) / 2))}dialog[data-inline]>.tabs{margin-inline:max(24px,calc((100% - 48rem) / 2))}dialog[data-inline]>header{padding-top:24px}dialog[data-inline]>.content{padding-bottom:32px}dialog[data-inline]>.footer{background:transparent}
.notice{position:fixed;right:16px;bottom:16px;z-index:1000;width:min(340px,calc(100vw - 32px));display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--mf-border);border-radius:var(--mf-radius);background:var(--mf-popover);box-shadow:0 8px 24px #00000024;font-size:13px}.notice strong{font-size:12px;font-weight:600}.notice span{color:var(--mf-muted);font-size:12px}
.panel-tray{position:fixed;right:16px;bottom:16px;z-index:999;width:300px;max-height:60vh;overflow:auto;border:1px solid var(--mf-border);border-radius:var(--mf-radius);background:var(--mf-popover);box-shadow:0 8px 24px #00000024}
.panel-tray header{align-items:center;padding:6px 6px 6px 10px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:color-mix(in srgb,var(--mf-fg) 50%,transparent)}
.panel{padding:10px;border-top:1px solid var(--mf-border)}.panel h2{font-size:13px;font-weight:600;margin:1px 0 4px}.panel p{font-size:12px;line-height:1.5;color:var(--mf-muted);white-space:pre-wrap}.panel .actions{justify-content:flex-start;flex-wrap:wrap;gap:4px;margin-top:8px}
.panel-tray[data-docked]{position:relative;inset:auto;width:100%;max-height:30vh;box-shadow:none;z-index:auto;margin-bottom:8px;background:var(--mf-card)}
@media(max-width:600px){header{padding:16px 16px 10px}.tabs{margin-inline:16px;max-width:calc(100% - 32px)}.content{padding:12px 16px 16px}.row{flex-direction:column;align-items:stretch;gap:8px}.row-actions{justify-content:flex-start;flex-wrap:wrap}.panel-tray{width:280px}}
.band-stack{width:fit-content;max-width:100%;padding:2px 16px 6px;border-top-right-radius:var(--mf-control-radius);background:var(--mf-bg);font-size:12px;line-height:16px;color:var(--mf-muted)}.band{white-space:pre;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}.band [data-tone=muted]{color:var(--mf-muted)}.band [data-tone=yellow]{color:var(--color-yellow-500,#d4a72c)}.band [data-tone=cyan]{color:var(--color-cyan-500,#22a8bd)}.band [data-tone=blue]{color:var(--info,var(--color-blue-500,#3b82f6))}.band [data-tone=magenta]{color:var(--color-fuchsia-500,#c85bd8)}.band [data-tone=red]{color:var(--destructive,#e5534b)}
.context-widget{display:flex;align-items:center;gap:3px;pointer-events:auto}.context-widget[hidden]{display:none}.context-trigger{width:auto;min-width:28px;height:28px;padding:4px;gap:3px}.context-trigger svg{width:20px;height:20px;transform:rotate(-90deg)}.context-ring-track{stroke:color-mix(in srgb,var(--mf-muted) 24%,transparent)}.context-ring-fill{stroke:color-mix(in srgb,var(--mf-muted) 72%,transparent);stroke-linecap:round;transition:stroke-dashoffset .5s ease-out,stroke .5s ease-out}.context-widget[data-level=high] .context-ring-fill{stroke:var(--color-error,var(--mf-danger))}.context-widget[data-unknown=true] .context-ring-track{stroke-dasharray:3 3}.context-percent:empty{display:none}.context-percent{font-size:11px;color:var(--mf-muted);font-variant-numeric:tabular-nums}
.context-popup{position:fixed;inset:auto;margin:0;width:min(430px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:0;border:1px solid var(--mf-border);border-radius:calc(var(--mf-radius) + 4px);background:var(--mf-popover);color:var(--mf-fg);box-shadow:0 8px 24px #00000029;pointer-events:auto;white-space:normal}.context-header{padding:12px 16px 4px;align-items:center;gap:12px}.context-header h2{font-size:13px;font-weight:500;color:var(--mf-muted)}.context-content{padding:8px 16px 16px;display:flex;flex-direction:column;gap:12px}.context-summary{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--mf-muted);font-variant-numeric:tabular-nums}.context-bar{display:flex;gap:1px;height:6px;flex:none;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--mf-muted) 24%,transparent)}.context-segment{height:100%;flex-shrink:1;border-radius:2px}.context-breakdown{display:flex;flex-direction:column;gap:10px;margin:2px 0 0;font-size:12px}.context-category{display:flex;align-items:center;justify-content:space-between;gap:16px}.context-category dt{display:flex;align-items:center;gap:8px;min-width:0}.context-category dd{margin:0;color:var(--mf-muted);font-variant-numeric:tabular-nums;flex:none}.context-category .context-unavailable{font-size:11px;color:color-mix(in srgb,var(--mf-muted) 75%,transparent)}.context-swatch{width:10px;height:10px;flex:none;border-radius:2px}.context-note{font-size:11px;line-height:1.5;color:var(--mf-muted)}@media(prefers-reduced-motion:reduce){.context-ring-fill{transition:none}}
`;

  // payload/web/themes.ts
  var THEME_TOKENS = ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring"];
  var pairs = [["background", "foreground"], ["card", "card-foreground"], ["popover", "popover-foreground"], ["primary", "primary-foreground"], ["secondary", "secondary-foreground"], ["muted", "muted-foreground"], ["accent", "accent-foreground"], ["sidebar", "sidebar-foreground"], ["sidebar-primary", "sidebar-primary-foreground"], ["sidebar-accent", "sidebar-accent-foreground"]];
  var SIDEBAR_SELECTOR = "[data-app-sidebar]";
  function isThemeToken(value) {
    return THEME_TOKENS.some((token) => token === value);
  }
  function luminance(hex) {
    const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
  }
  function validateTheme(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected theme color tokens.");
    const theme = {};
    for (const [token, color] of Object.entries(value)) {
      if (!isThemeToken(token) || typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Use a supported color token and an opaque #RRGGBB color: ${token}`);
      theme[token] = color;
    }
    if (!theme.background || !theme.foreground) throw new Error("A theme must provide background and foreground.");
    for (const [background, foreground] of pairs) {
      const back = theme[background];
      const fore = theme[foreground];
      if (!back && !fore) continue;
      if (!back || !fore) throw new Error(`Provide ${background} and ${foreground} together.`);
      const a = luminance(back);
      const b = luminance(fore);
      if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 4.5) throw new Error(`The ${background}/${foreground} pair needs readable contrast (4.5:1).`);
    }
    return theme;
  }
  function restoreInline(style2, saved) {
    for (const [key, prior] of saved) {
      if (style2.getPropertyValue(key) !== prior.applied) continue;
      if (prior.value) style2.setProperty(key, prior.value, prior.priority);
      else style2.removeProperty(key);
    }
  }
  function applyInline(style2, saved, colors) {
    saved.clear();
    for (const [token, color] of Object.entries(colors)) {
      const key = `--${token}`;
      saved.set(key, { value: style2.getPropertyValue(key), priority: style2.getPropertyPriority(key), applied: color });
      style2.setProperty(key, color);
    }
  }
  function themeLayers(active) {
    const sidebar = active.sidebar ?? active.background;
    const foreground = active.foreground;
    const accent = active["sidebar-accent"] ?? active.accent ?? sidebar;
    const accentForeground = active["sidebar-accent-foreground"] ?? active["accent-foreground"] ?? foreground;
    const mutedForeground = active["muted-foreground"] ?? foreground;
    const card = active.card ?? active.background;
    const cardForeground = active["card-foreground"] ?? foreground;
    const popover = active.popover ?? active.background;
    const popoverForeground = active["popover-foreground"] ?? foreground;
    const border = active.border ?? active.background;
    const primary = active.primary ?? accent;
    const primaryForeground = active["primary-foreground"] ?? foreground;
    const sidebarForeground = active["sidebar-foreground"] ?? foreground;
    const control = active.muted ?? sidebar;
    const sidebarBorder = active["sidebar-border"] ?? border;
    const root = {
      ...active,
      sidebar,
      "sidebar-foreground": sidebarForeground,
      "sidebar-muted-foreground": mutedForeground,
      "sidebar-control-surface": control,
      "sidebar-row-hover": accent,
      "sidebar-row-active": accent,
      "sidebar-row-selected": accent,
      "sidebar-stage-fade": sidebar,
      "surface-raised": card,
      "app-chrome-background": active.background,
      "toolbar-background": active.background,
      "toolbar-foreground": foreground,
      "toolbar-border": border,
      "toolbar-control": popover,
      "toolbar-control-foreground": popoverForeground,
      "toolbar-control-hover": active.accent ?? active.background,
      // Selected themes (html[data-theme-id]) read these sources for canvas, chrome, text, and sidebar rows.
      "app-theme-canvas": active.background,
      "app-theme-chrome": active.background,
      "app-theme-text": foreground,
      "app-theme-toolbar": active.background,
      "app-theme-toolbar-foreground": foreground,
      "app-theme-toolbar-border": border,
      "app-theme-toolbar-control": popover,
      "app-theme-toolbar-control-foreground": popoverForeground,
      "app-theme-toolbar-control-hover": active.accent ?? active.background,
      "app-theme-surface": card,
      "app-theme-surface-raised": card,
      "app-theme-surface-overlay": active.popover ?? card,
      "app-theme-muted": active.muted ?? active.background,
      "app-theme-muted-foreground": mutedForeground,
      "app-theme-placeholder": mutedForeground,
      "app-theme-secondary-label": mutedForeground,
      "app-theme-icon-muted": mutedForeground,
      "app-theme-border": border,
      "app-theme-input": active.input ?? border,
      "app-theme-focus": active.ring ?? primary,
      "app-theme-accent": primary,
      "app-theme-accent-foreground": primaryForeground,
      "app-theme-accent-surface": accent,
      "app-theme-accent-surface-foreground": accentForeground,
      "app-theme-secondary": active.secondary ?? active.muted ?? active.background,
      "app-theme-secondary-foreground": active["secondary-foreground"] ?? foreground,
      "app-theme-sidebar": sidebar,
      "app-theme-sidebar-foreground": sidebarForeground,
      "app-theme-sidebar-muted-foreground": mutedForeground,
      "app-theme-sidebar-control-surface": control,
      "app-theme-sidebar-row-hover": accent,
      "app-theme-sidebar-row-active": accent,
      "app-theme-sidebar-row-selected": accent,
      "app-theme-sidebar-border": sidebarBorder,
      "app-theme-message-surface": card,
      "app-theme-message-foreground": cardForeground,
      "app-theme-message-action": primary,
      "app-theme-message-action-foreground": primaryForeground,
      "app-theme-message-action-hover": active.accent ?? primary,
      "app-theme-code-background": card,
      "app-theme-code-foreground": cardForeground,
      "app-theme-terminal-background": card,
      "app-theme-terminal-foreground": cardForeground,
      "app-theme-terminal-cursor": foreground,
      "app-theme-terminal-selection-background": accent
    };
    const sidebarColors = {
      background: sidebar,
      foreground: sidebarForeground,
      card,
      "card-foreground": cardForeground,
      accent,
      "accent-foreground": accentForeground,
      muted: control,
      "muted-foreground": mutedForeground,
      border: sidebarBorder,
      input: active.input ?? border,
      sidebar,
      "sidebar-foreground": sidebarForeground,
      "sidebar-muted-foreground": mutedForeground,
      "sidebar-control-surface": control,
      "sidebar-row-hover": accent,
      "sidebar-row-active": accent,
      "sidebar-row-selected": accent,
      "sidebar-border": sidebarBorder,
      "sidebar-stage-fade": sidebar
    };
    return { root, sidebar: sidebarColors };
  }
  function sidebarNode(node2) {
    return node2 instanceof Element && (node2.matches(SIDEBAR_SELECTOR) || node2.querySelector(SIDEBAR_SELECTOR) !== null);
  }
  var ThemeHost = class {
    themes = /* @__PURE__ */ new Map();
    original = /* @__PURE__ */ new Map();
    sidebarInline = /* @__PURE__ */ new Map();
    sidebarObserver;
    set(id, colors) {
      this.themes.delete(id);
      this.themes.set(id, validateTheme(colors));
      this.apply();
    }
    clear(id) {
      this.themes.delete(id);
      this.apply();
    }
    apply() {
      const style2 = document.documentElement.style;
      restoreInline(style2, this.original);
      const active = [...this.themes.values()].at(-1);
      if (!active) {
        this.original.clear();
        this.paintSidebars(null);
        this.sidebarObserver?.disconnect();
        this.sidebarObserver = void 0;
        return;
      }
      const layers = themeLayers(active);
      applyInline(style2, this.original, layers.root);
      this.paintSidebars(layers.sidebar);
      this.watchSidebars();
    }
    watchSidebars() {
      if (this.sidebarObserver || typeof MutationObserver === "undefined") return;
      this.sidebarObserver = new MutationObserver((records) => {
        const active = [...this.themes.values()].at(-1);
        if (!active || !records.some((record) => [...record.addedNodes].some(sidebarNode))) return;
        this.paintSidebars(themeLayers(active).sidebar);
      });
      this.sidebarObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    paintSidebars(colors) {
      const live = /* @__PURE__ */ new Set();
      if (colors) {
        for (const node2 of document.querySelectorAll(SIDEBAR_SELECTOR)) live.add(node2);
      }
      for (const [element2, saved] of this.sidebarInline) {
        if (live.has(element2)) continue;
        restoreInline(element2.style, saved);
        this.sidebarInline.delete(element2);
      }
      if (!colors) return;
      for (const element2 of live) {
        const saved = this.sidebarInline.get(element2) ?? /* @__PURE__ */ new Map();
        if (this.sidebarInline.has(element2)) restoreInline(element2.style, saved);
        this.sidebarInline.set(element2, saved);
        applyInline(element2.style, saved, colors);
      }
    }
  };

  // payload/web/context-usage.ts
  var CATEGORIES = [
    ["systemPrompt", "System prompt", "#999999"],
    ["toolDefinitions", "Tool definitions", "#9885ed"],
    ["rules", "Rules", "#399f6b"],
    ["skills", "Skills", "#efb65e"],
    ["mcpTools", "MCP & dynamic tools", "#b28fab"],
    ["summarizedConversation", "Summarized conversation", "#f26483"],
    ["conversation", "Conversation", "#dc8079"]
  ];
  function element(tag, className, text) {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== void 0) result.textContent = text;
    return result;
  }
  function formatContextTokens(value) {
    return value < 1e3 ? String(value) : value < 1e6 ? `${(value / 1e3).toFixed(1).replace(/\.0$/, "")}K` : `${(value / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  var sequence = 0;
  var ContextUsageView = class {
    root = element("div", "context-widget");
    trigger = element("button", "context-trigger ghost");
    popup = element("div", "context-popup");
    content = element("div", "context-content");
    label = element("span", "context-percent");
    arc;
    threadId;
    constructor() {
      this.root.hidden = true;
      this.trigger.type = "button";
      this.trigger.setAttribute("aria-haspopup", "dialog");
      this.trigger.setAttribute("aria-expanded", "false");
      this.popup.id = `t3mods-context-${++sequence}`;
      this.popup.popover = "auto";
      this.popup.role = "dialog";
      this.popup.setAttribute("data-chat-composer-floating-layer", "true");
      this.popup.setAttribute("aria-label", "Context Usage");
      this.trigger.setAttribute("aria-controls", this.popup.id);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      for (const className of ["context-ring-track", "context-ring-fill"]) {
        const circle = document.createElementNS(svg.namespaceURI, "circle");
        for (const [key, value] of Object.entries({ cx: "12", cy: "12", r: "9.75", fill: "none", "stroke-width": "3", class: className })) circle.setAttribute(key, value);
        svg.append(circle);
      }
      this.arc = svg.lastElementChild;
      this.arc.setAttribute("pathLength", "100");
      this.arc.setAttribute("stroke-dasharray", "100");
      this.trigger.append(svg, this.label);
      const close = element("button", "ghost icon xs", "\xD7");
      close.type = "button";
      close.setAttribute("aria-label", "Close context usage");
      close.onclick = () => {
        this.popup.hidePopover();
        this.trigger.focus();
      };
      this.popup.append(element("header", "context-header"));
      this.popup.firstElementChild.append(element("h2", "", "Context Usage"), close);
      this.popup.append(this.content);
      this.trigger.onclick = () => {
        if (this.popup.matches(":popover-open")) this.popup.hidePopover();
        else {
          this.popup.showPopover();
          this.position();
          close.focus();
        }
      };
      this.popup.addEventListener("toggle", () => {
        this.trigger.setAttribute("aria-expanded", String(this.popup.matches(":popover-open")));
      });
      this.popup.addEventListener("keydown", (event) => event.stopPropagation());
      this.root.append(this.trigger, this.popup);
      window.addEventListener("resize", this.position);
      window.addEventListener("scroll", this.position, true);
    }
    position = () => {
      if (!this.popup.matches(":popover-open")) return;
      const anchor = this.trigger.getBoundingClientRect();
      const box = this.popup.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.right - box.width, window.innerWidth - box.width - 12));
      const top = Math.max(12, Math.min(anchor.top - box.height - 8, window.innerHeight - box.height - 12));
      this.popup.style.left = `${left}px`;
      this.popup.style.top = `${top}px`;
    };
    update(snapshot) {
      if (this.threadId !== snapshot?.threadId || !snapshot) {
        if (this.popup.matches(":popover-open")) this.popup.hidePopover();
      }
      this.threadId = snapshot?.threadId;
      this.root.hidden = !snapshot;
      if (!snapshot) return;
      const { usedTokens, maxTokens, breakdown } = snapshot;
      const percent = maxTokens ? Math.min(100, usedTokens / maxTokens * 100) : null;
      const percentText = percent === null ? "Window unknown" : `${Math.round(percent)}%`;
      this.label.textContent = percent === null ? "" : percentText;
      const accessible = percent === null ? `Context usage: ${formatContextTokens(usedTokens)} tokens, window size unavailable` : `Context window ${percentText} used`;
      this.trigger.title = `${accessible}. Click for breakdown.`;
      this.trigger.setAttribute("aria-label", `${accessible}. Show context usage`);
      this.root.dataset.level = percent !== null && percent > 90 ? "high" : "normal";
      this.root.dataset.unknown = String(percent === null);
      this.arc.setAttribute("stroke-dashoffset", String(100 - (percent ?? 0)));
      const summary = element("div", "context-summary");
      summary.append(element("span", "", percent === null ? "Window size unavailable" : `${percentText} Full`), element("span", "", `${formatContextTokens(usedTokens)}${maxTokens ? ` / ${formatContextTokens(maxTokens)}` : ""} Tokens`));
      const bar = element("div", "context-bar");
      bar.role = "progressbar";
      bar.setAttribute("aria-label", "Context window usage");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      if (percent !== null) bar.setAttribute("aria-valuenow", String(Math.round(percent)));
      bar.setAttribute("aria-valuetext", accessible);
      const list = element("dl", "context-breakdown");
      let classified = 0;
      const segment = (tokens, color) => {
        if (!tokens) return;
        const part = element("span", "context-segment");
        part.style.backgroundColor = color;
        part.style.width = `${tokens / Math.max(maxTokens ?? usedTokens, usedTokens, 1) * 100}%`;
        bar.append(part);
      };
      const row2 = (name, count, color) => {
        const item = element("div", "context-category");
        const title = element("dt", "");
        const swatch = element("span", "context-swatch");
        swatch.style.backgroundColor = color;
        title.append(swatch, document.createTextNode(name));
        const total = element("dd", count === void 0 ? "context-unavailable" : "", count === void 0 ? "Unavailable" : formatContextTokens(count));
        item.append(title, total);
        list.append(item);
        if (count !== void 0) {
          classified += count;
          segment(count, color);
        }
      };
      for (const [key, name, color] of CATEGORIES) row2(name, breakdown?.[key], color);
      const remainder = usedTokens - classified;
      if (remainder > 0 || !breakdown) row2("Unclassified context", remainder, "#70869d");
      const note2 = element("p", "context-note", !breakdown ? "T3 reports the total context usage, but does not provide these category counts. Unavailable counts are not zero." : "Category counts are reported by T3. Any tokens without a category appear as unclassified context.");
      this.content.replaceChildren(summary, bar, list, note2);
      this.position();
    }
    dispose() {
      if (this.popup.matches(":popover-open")) this.popup.hidePopover();
      window.removeEventListener("resize", this.position);
      window.removeEventListener("scroll", this.position, true);
      this.root.remove();
    }
  };

  // payload/web/host.ts
  function node(tag, attributes = {}, children = []) {
    const element2 = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value == null) continue;
      if (key === "class") element2.className = String(value);
      else if (key === "text") element2.textContent = String(value);
      else if (key === "style") element2.setAttribute("style", String(value));
      else if (key.startsWith("on") && typeof value === "function") element2.addEventListener(key.slice(2), value);
      else if (key in element2) Reflect.set(element2, key, value);
      else element2.setAttribute(key, String(value));
    }
    if (children.length) element2.append(...children);
    return element2;
  }
  var button = (text, onclick, className = "") => node("button", { text, onclick, class: className, type: "button" });
  var toggle = (checked, label, disabled = false) => node("input", { type: "checkbox", role: "switch", class: "switch", checked, disabled, "aria-label": label });
  function closeButton(onclick) {
    const control = node("button", { type: "button", class: "ghost icon", onclick }, [node("span", { class: "sr-only", text: "Close" })]);
    control.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>');
    return control;
  }
  var section = (title, children, aside) => node("section", { class: "section" }, [node("div", { class: "section-head" }, [node("h2", { text: title }), ...aside ? [aside] : []]), node("div", { class: "card" }, children)]);
  function row(title, description, controls = [], extra = []) {
    const heading = typeof title === "string" ? node("h2", { text: title }) : node("h2", {}, title);
    return node("article", { class: "row" }, [node("div", { class: "row-text" }, [heading, ...description ? [node("p", { text: description })] : [], ...extra]), node("div", { class: "row-actions" }, controls)]);
  }
  var badge = (text, state) => node("span", { class: "state", "data-state": state, text });
  var meta = (text) => node("div", { class: "meta", text });
  var MORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  var note = (text) => node("div", { class: "row" }, [node("p", { class: "explain", text })]);
  var MAX_RENDERED_BLOCKS = 20;
  var MAX_PENDING = 20;
  var BUNDLE_HINT = '"t3mod/1"';
  var SOURCES = ["chat", "inbox", "file", "paste"];
  var SOURCE_LABEL = { chat: "From a chat reply", inbox: "From the mods inbox", file: "From a file", paste: "Pasted" };
  var NOT_A_REPLY = '#mods-for-t3-code-host, [data-t3mods], [contenteditable="true"], textarea, [data-chat-composer-form]';
  function seenMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const seen = {};
    for (const [key, item] of Object.entries(value)) if (typeof item === "number") seen[key] = item;
    return seen;
  }
  function messageText(error) {
    return error instanceof Error ? error.message : "Something went wrong.";
  }
  async function digest(text) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  var sameBundle = (left, right) => left.code === right.code && JSON.stringify(left.manifest) === JSON.stringify(right.manifest);
  var isSource = (value) => SOURCES.some((source) => source === value);
  function ago(time) {
    const minutes = Math.round((Date.now() - time) / 6e4);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
    return new Date(time).toLocaleDateString();
  }
  function describeInvalid(value) {
    const manifest = value && typeof value === "object" ? Reflect.get(value, "manifest") : void 0;
    const field = (key) => {
      const item = manifest && typeof manifest === "object" ? Reflect.get(manifest, key) : void 0;
      return typeof item === "string" && item.trim() ? item.trim().slice(0, 100) : void 0;
    };
    const id = field("id");
    return { ...id ? { id } : {}, name: field("name") ?? id ?? "Mod from chat" };
  }
  function fences(text) {
    const blocks = [];
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const opening2 = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/.exec(lines[index] ?? "");
      if (!opening2) continue;
      const [, fence = "", info = ""] = opening2;
      const start = index + 1;
      for (index = start; index < lines.length && !new RegExp(`^ {0,3}${fence[0] === "~" ? "~" : "`"}{${fence.length},}[ \\t]*$`).test(lines[index] ?? ""); index++) ;
      blocks.push({ info: info.toLowerCase(), body: lines.slice(start, index).join("\n") });
    }
    return blocks;
  }
  function parseJson(text, what) {
    try {
      return JSON.parse(text.trim());
    } catch (error) {
      throw new Error(`The ${what} is incomplete or not valid JSON (${messageText(error)}). Copy the whole code block and try again.`);
    }
  }
  function bundleFromText(input) {
    const text = input.replace(/\r\n?/g, "\n").trim();
    if (!text) throw new Error("Paste a mod bundle first.");
    if (new TextEncoder().encode(text).length > MAX_BUNDLE_BYTES * 2) throw new Error("A mod bundle must be smaller than 1 MB.");
    if (text.startsWith("{")) return parseJson(text, "bundle");
    const blocks = fences(text);
    const manifests = blocks.filter((block) => block.info === "t3mod-manifest");
    const codes = blocks.filter((block) => block.info === "t3mod-code");
    if (manifests.length || codes.length) {
      const [manifest] = manifests;
      const [code] = codes;
      if (!manifest || !code) throw new Error(`Found a t3mod-${manifest ? "manifest" : "code"} block but no matching t3mod-${manifest ? "code" : "manifest"} block. Copy the whole reply, or both blocks.`);
      if (manifests.length > 1 || codes.length > 1) throw new Error("This text contains more than one mod. Paste one at a time.");
      return { format: "t3mod/1", manifest: parseJson(manifest.body, "manifest"), code: code.body };
    }
    const bundles = blocks.filter((block) => block.body.includes(BUNDLE_HINT));
    const [bundle] = bundles;
    if (!bundle) throw new Error('No mod found. Paste the whole reply, its t3mod-manifest and t3mod-code blocks, or bundle JSON that starts with {"format":"t3mod/1".');
    if (bundles.length > 1) throw new Error("This text contains more than one bundle. Paste one at a time.");
    return parseJson(bundle.body, "bundle");
  }
  async function mount(options) {
    if (window.__modsForT3Code) return;
    const root = node("div", { id: "mods-for-t3-code-host" });
    const shadow = root.attachShadow({ mode: "open" });
    shadow.append(node("style", { text: style }));
    document.body.append(root);
    const dialog = node("dialog", { "aria-label": "Mods for T3 Code" });
    const tray = node("aside", { class: "panel-tray", hidden: true, "aria-label": "Mod panels" });
    shadow.append(dialog, tray);
    const panelRoot = node("div", { "data-t3mods": "panels" });
    const panelShadow = panelRoot.attachShadow({ mode: "open" });
    panelShadow.append(node("style", { text: style }));
    const composerRoot = node("div", { "data-t3mods": "composer", "data-chat-composer-collapsed-controls": "true", style: "display:flex;align-items:center;width:100%;max-width:var(--chat-content-max-width,none);margin-inline:auto" });
    const bandRoot = node("div", { "data-t3mods": "bands", style: "display:none;flex:1;min-width:0" });
    const bandShadow = bandRoot.attachShadow({ mode: "open" });
    const bandStack = node("div", { class: "band-stack" });
    bandShadow.append(node("style", { text: style }), bandStack);
    composerRoot.append(bandRoot);
    const bandDock = dockAboveComposer(composerRoot);
    let bandsVisible = false;
    let contextAboveComposer = false;
    const contextRoot = node("div", { "data-t3mods": "context", "data-composer-context-control": "true", "data-chat-composer-floating-layer": "true", style: "display:flex;align-items:center;flex:none" });
    const contextShadow = contextRoot.attachShadow({ mode: "open" });
    contextShadow.append(node("style", { text: style }));
    const contextDock = dockContextControl(contextRoot, (visible) => {
      contextAboveComposer = visible;
      if (visible) {
        contextRoot.style.paddingLeft = "16px";
        contextRoot.style.background = "var(--background,#0a0a0a)";
        if (contextRoot.parentElement !== composerRoot) composerRoot.insertBefore(contextRoot, bandRoot);
      } else if (contextRoot.parentElement === composerRoot) contextRoot.remove();
      bandDock.show(bandsVisible || contextAboveComposer);
    });
    const contextViews = /* @__PURE__ */ new Map();
    let records = [];
    const runtimes = /* @__PURE__ */ new Map();
    const readyRuntimes = /* @__PURE__ */ new WeakSet();
    const commands = /* @__PURE__ */ new Map();
    const panels = /* @__PURE__ */ new Map();
    const bands = /* @__PURE__ */ new Map();
    const themes = new ThemeHost();
    const logs = [];
    const notices = [];
    let paused = Boolean(await database.getSetting("paused"));
    let development = Boolean(await database.getSetting("development"));
    let seenInbox = seenMap(await database.getSetting("seenInbox"));
    let pending = [];
    const problems = [];
    let tab = "installed";
    let review;
    let editing;
    const editTexts = /* @__PURE__ */ new Map();
    let flash;
    let createText = "";
    let importText = "";
    let importError;
    let busy = false;
    let trayOpen = true;
    let lastPath = routePath();
    let draftTimer;
    let disposed = false;
    let channel;
    let inlineContent;
    let inlineDisplay = "";
    let decisionQueue = Promise.resolve();
    let telemetry;
    let unsubscribeTelemetry;
    let artifacts;
    let unsubscribeArtifacts;
    let menu;
    let bundleScan;
    const scannedBlocks = /* @__PURE__ */ new WeakMap();
    const settlingPairs = /* @__PURE__ */ new WeakMap();
    const PAIR_SETTLE_MS = 1500;
    let loaded = () => void 0;
    let importQueue = new Promise((resolve) => {
      loaded = resolve;
    });
    function closeMenu(restoreFocus = false) {
      if (!menu) return;
      const { popup, trigger } = menu;
      menu = void 0;
      popup.remove();
      trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && trigger.isConnected) trigger.focus();
    }
    function moreButton(label, items) {
      const trigger = node("button", { type: "button", class: "ghost icon xs", "aria-label": label, title: label, "aria-haspopup": "menu", "aria-expanded": "false" });
      trigger.insertAdjacentHTML("afterbegin", MORE_ICON);
      trigger.onclick = () => {
        if (menu?.trigger === trigger) closeMenu();
        else openMenu(trigger, items);
      };
      trigger.onkeydown = (event) => {
        if (event.key === "ArrowDown" && menu?.trigger !== trigger) {
          event.preventDefault();
          openMenu(trigger, items);
        }
      };
      return trigger;
    }
    function openMenu(trigger, items) {
      closeMenu();
      const entries = items.map(([text, action, className = ""]) => node("button", { type: "button", role: "menuitem", tabIndex: -1, class: className, text, onclick: () => {
        closeMenu(true);
        action();
      } }));
      const popup = node("div", { class: "menu", role: "menu", "aria-label": trigger.getAttribute("aria-label") ?? "Menu" }, entries);
      popup.addEventListener("keydown", (event) => {
        const active = shadow.activeElement;
        const index = active instanceof HTMLButtonElement ? entries.indexOf(active) : -1;
        const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: entries.length - 1 };
        const move = moves[event.key];
        if (move !== void 0) {
          event.preventDefault();
          entries[(move + entries.length) % entries.length]?.focus();
        } else if (event.key === "Tab") {
          event.preventDefault();
          closeMenu(true);
        }
      });
      dialog.append(popup);
      const box = trigger.getBoundingClientRect();
      const below = box.bottom + 4 + popup.offsetHeight <= innerHeight - 8;
      popup.style.top = `${below ? box.bottom + 4 : Math.max(8, box.top - 4 - popup.offsetHeight)}px`;
      popup.style.left = `${Math.max(8, Math.min(innerWidth - popup.offsetWidth - 8, box.right - popup.offsetWidth))}px`;
      trigger.setAttribute("aria-expanded", "true");
      menu = { popup, trigger };
      entries[0]?.focus();
    }
    const onPointerDown = (event) => {
      const current = menu;
      if (!current) return;
      const path = event.composedPath();
      if (!path.includes(current.popup) && !path.includes(current.trigger)) closeMenu();
    };
    const onViewportChange = () => closeMenu();
    function ask(title, description, action, destructive = false) {
      const result = decisionQueue.then(() => new Promise((resolve) => {
        const prompt = node("dialog", { class: "ask", "aria-label": title }, [node("header", {}, [node("h1", { text: title })]), node("div", { class: "content" }, [node("p", { class: "explain decision-preview", text: description })]), node("div", { class: "footer actions" }, [button("Cancel", () => finish(false)), button(action, () => finish(true), destructive ? "destructive" : "primary")])]);
        function finish(value) {
          prompt.close();
          prompt.remove();
          resolve(value);
        }
        prompt.addEventListener("cancel", (event) => {
          event.preventDefault();
          finish(false);
        });
        shadow.append(prompt);
        prompt.showModal();
      }));
      decisionQueue = result.catch(() => false);
      return result;
    }
    async function remember(hash) {
      if (!hash) return;
      seenInbox[hash] = Date.now();
      seenInbox = Object.fromEntries(Object.entries(seenInbox).sort((left, right) => right[1] - left[1]).slice(0, 200));
      await database.setSetting("seenInbox", seenInbox);
    }
    async function loadPending() {
      const stored = await database.getSetting("pending");
      if (!Array.isArray(stored)) return [];
      const result = [];
      for (const item of stored) {
        if (!item || typeof item !== "object") continue;
        const { bundle, hash, source, receivedAt, threadId, messageId } = item;
        if (typeof hash !== "string" || !isSource(source)) continue;
        try {
          result.push({ bundle: validateBundle(bundle), hash, source, receivedAt: typeof receivedAt === "number" ? receivedAt : Date.now(), ...typeof threadId === "string" ? { threadId } : {}, ...typeof messageId === "string" ? { messageId } : {} });
        } catch {
        }
      }
      return result.slice(-MAX_PENDING);
    }
    async function savePending() {
      await database.setSetting("pending", pending);
    }
    function leaveInline() {
      if (!inlineContent) return;
      inlineContent.style.display = inlineDisplay;
      inlineContent = void 0;
      root.removeAttribute("data-inline");
      dialog.removeAttribute("data-inline");
      dialog.close();
      document.body.append(root);
      styleSettingsControl(false);
    }
    function closeManager() {
      if (inlineContent) leaveInline();
      else dialog.close();
    }
    function go(key) {
      tab = key;
      review = void 0;
      editing = void 0;
      flash = void 0;
      render();
    }
    function showReview(next) {
      review = next;
      editing = void 0;
      flash = void 0;
      render();
      if (!dialog.open) dialog.showModal();
    }
    function notify(name, text, action) {
      const notice = node("div", { class: "notice", role: "status" }, [node("strong", { text: name }), node("span", { text })]);
      if (action) notice.append(node("div", { class: "actions" }, [button(action[0], () => {
        notice.remove();
        action[1]();
      }, "xs")]));
      for (const old of notices.splice(0)) old.remove();
      notices.push(notice);
      shadow.append(notice);
      setTimeout(() => {
        notice.remove();
        const index = notices.indexOf(notice);
        if (index >= 0) notices.splice(index, 1);
      }, action ? 12e3 : 6e3);
    }
    function log(name, text) {
      logs.push(`${(/* @__PURE__ */ new Date()).toLocaleTimeString()}  ${name}: ${text}`);
      if (logs.length > 100) logs.shift();
      if (dialog.open && !review && tab === "console") render();
    }
    function renderTray() {
      tray.hidden = panels.size === 0;
      tray.replaceChildren(node("header", {}, [node("span", { text: "Mod panels" }), button(trayOpen ? "Collapse" : "Expand", () => {
        trayOpen = !trayOpen;
        renderTray();
      }, "ghost xs")]));
      if (!trayOpen) return;
      for (const [id, panel] of panels) {
        const runtime = runtimes.get(id);
        if (!runtime) continue;
        tray.append(node("section", { class: "panel" }, [node("div", { class: "meta", text: runtime.record.manifest.name }), node("h2", { text: panel.title }), node("p", { text: panel.body }), node("div", { class: "actions" }, panel.actions.map((action) => button(action.label, () => runtime.invoke("action", action.id), "xs")))]));
      }
    }
    function renderBands() {
      const rows = [];
      for (const [id, parts] of bands) {
        const runtime = runtimes.get(id);
        if (!runtime || rows.length >= 4) continue;
        const name = runtime.record.manifest.name;
        rows.push(node("div", { class: "band", title: name, "aria-label": `${name}: ${parts.map((part) => part.text).join("")}`, "data-mod": id }, parts.map((part) => node("span", { "data-tone": part.tone ?? "default", text: part.text }))));
      }
      bandStack.replaceChildren(...rows);
      bandsVisible = rows.length > 0;
      bandRoot.style.display = bandsVisible ? "block" : "none";
      bandDock.show(bandsVisible || contextAboveComposer);
    }
    function renderContext() {
      const usage = currentUsage();
      for (const view of contextViews.values()) view.update(usage);
      contextDock.show(contextViews.size > 0 && usage !== null);
    }
    function currentUsage() {
      try {
        return usageSnapshot(telemetry?.get(routePath()));
      } catch {
        return null;
      }
    }
    function connectTelemetry() {
      const api = window.__T3_MODS_TELEMETRY__;
      if (telemetry || disposed || typeof api?.subscribe !== "function") return;
      telemetry = api;
      try {
        unsubscribeTelemetry = telemetry.subscribe((event) => {
          if (event.name !== "session.usage" && event.name !== "turn.complete") return;
          const value = usageSnapshot(event.value);
          if (!value || currentUsage()?.threadId !== value.threadId) return;
          renderContext();
          for (const runtime of runtimes.values()) runtime.emit(event.name, value);
        });
      } catch {
        telemetry = void 0;
      }
    }
    function connectArtifacts() {
      const api = window.__T3_MODS_ARTIFACTS__;
      if (artifacts || disposed || typeof api?.subscribe !== "function" || typeof api.get !== "function") return;
      artifacts = api;
      try {
        unsubscribeArtifacts = api.subscribe((artifact) => void receiveArtifact(artifact));
        for (const artifact of api.get()) void receiveArtifact(artifact);
      } catch {
        try {
          unsubscribeArtifacts?.();
        } catch {
        }
        unsubscribeArtifacts = void 0;
        artifacts = void 0;
      }
    }
    function receiveArtifact(artifact) {
      if (!artifact || typeof artifact !== "object" || typeof artifact.threadId !== "string" || typeof artifact.messageId !== "string") return Promise.resolve();
      const source = { inbox: true, from: "chat", threadId: artifact.threadId, messageId: artifact.messageId };
      const { error } = artifact;
      if (typeof error === "string" && error) return enqueue(() => reportProblem(artifact.bundle, new Error(error.slice(0, 1e3)), artifact.messageId));
      return importCandidate(artifact.bundle, source);
    }
    function stateOf(record) {
      if (options.safeMode) return ["Safe mode", "off"];
      if (record.quarantined) return ["Stopped", "stopped"];
      if (!record.enabled) return ["Off", "off"];
      if (paused) return ["Paused", "off"];
      const runtime = runtimes.get(record.manifest.id);
      if (runtime && readyRuntimes.has(runtime)) return ["Active", "active"];
      return runtime ? ["Starting", "starting"] : ["Off", "off"];
    }
    const recordFor = (id) => records.find((record) => record.manifest.id === id);
    function refresh() {
      if (dialog.open && !review && !editing && !busy && (tab === "installed" || tab === "examples")) render();
      renderTray();
    }
    function start(record) {
      if (paused || options.safeMode || !record.enabled || record.quarantined || runtimes.has(record.manifest.id)) return;
      const runtime = new ModRuntime(record, {
        ready: (current) => {
          readyRuntimes.add(current);
          log(record.manifest.name, "Loaded");
          refresh();
        },
        command: (_runtime, command) => {
          const entries = commands.get(record.manifest.id) ?? /* @__PURE__ */ new Map();
          if (entries.size >= 20 && !entries.has(command.id)) throw new Error("A mod can register up to 20 commands.");
          entries.set(command.id, command);
          commands.set(record.manifest.id, entries);
        },
        panel: (_runtime, panel) => {
          if (panel) panels.set(record.manifest.id, panel);
          else panels.delete(record.manifest.id);
          renderTray();
        },
        notify: (_runtime, text) => notify(record.manifest.name, text),
        theme: (_runtime, colors) => {
          if (colors) themes.set(record.manifest.id, colors);
          else themes.clear(record.manifest.id);
        },
        band: (_runtime, parts) => {
          if (parts) bands.set(record.manifest.id, parts);
          else bands.delete(record.manifest.id);
          renderBands();
        },
        context: (_runtime, enabled) => {
          const id = record.manifest.id;
          if (enabled && !contextViews.has(id)) {
            const view = new ContextUsageView();
            contextViews.set(id, view);
            contextShadow.append(view.root);
          } else if (!enabled) {
            contextViews.get(id)?.dispose();
            contextViews.delete(id);
          }
          renderContext();
        },
        usage: currentUsage,
        readDraft,
        insertDraft: async (current, text) => {
          if (!await ask(`${record.manifest.name} wants to add to your draft`, `This text will be pasted at the end. Nothing will be sent.

${text}`, "Add to draft") || current.stopped) return false;
          insertDraft(text);
          return true;
        },
        log: (_runtime, text) => log(record.manifest.name, text),
        removed: (current) => {
          if (runtimes.get(record.manifest.id) !== current) return;
          runtimes.delete(record.manifest.id);
          commands.delete(record.manifest.id);
          panels.delete(record.manifest.id);
          bands.delete(record.manifest.id);
          themes.clear(record.manifest.id);
          renderBands();
          refresh();
          contextViews.get(record.manifest.id)?.dispose();
          contextViews.delete(record.manifest.id);
          renderContext();
        },
        fault: async (_runtime, reason) => {
          record.enabled = false;
          record.quarantined = reason;
          await database.save(record);
          broadcast();
          log(record.manifest.name, reason);
          notify(record.manifest.name, `Stopped: ${reason}`, ["Open Mods", () => open2("installed")]);
          refresh();
        }
      }, options.sandboxDocument);
      runtimes.set(record.manifest.id, runtime);
    }
    function stop(id) {
      runtimes.get(id)?.stop();
    }
    function broadcast() {
      channel?.postMessage("refresh");
    }
    async function reload() {
      records = await database.list();
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const updated = await updateLegacyWeather(record, options.examples ?? []);
        if (updated === record) continue;
        await database.save(updated);
        records[index] = updated;
        log(updated.manifest.name, "Updated the built-in to hide empty-context and first-turn placeholders.");
      }
      paused = Boolean(await database.getSetting("paused"));
      pending = await loadPending();
      const reviewing = review?.entry;
      if (reviewing && !pending.some((entry) => entry.hash === reviewing.hash)) review = void 0;
      for (const [id, runtime] of runtimes) {
        const record = records.find((item) => item.manifest.id === id);
        if (paused || !record?.enabled || record.quarantined || record.code !== runtime.record.code || JSON.stringify(record.manifest) !== JSON.stringify(runtime.record.manifest)) stop(id);
      }
      for (const record of records) start(record);
      refresh();
    }
    function open2(nextTab) {
      leaveInline();
      if (nextTab) editing = void 0;
      if (nextTab || !review?.entry) {
        tab = nextTab ?? "installed";
        review = void 0;
      }
      flash = void 0;
      render();
      if (!dialog.open) dialog.showModal();
    }
    function openSettings() {
      const inset = document.querySelector('[data-slot="sidebar-inset"]');
      const content = inset?.firstElementChild?.lastElementChild;
      if (!(content instanceof HTMLElement) || content.tagName === "HEADER" || !content.parentElement) {
        open2();
        return;
      }
      leaveInline();
      if (dialog.open) dialog.close();
      inlineContent = content;
      inlineDisplay = content.style.display;
      content.style.display = "none";
      root.setAttribute("data-inline", "true");
      dialog.setAttribute("data-inline", "true");
      content.parentElement.append(root);
      if (!review?.entry) {
        tab = "installed";
        review = void 0;
      }
      flash = void 0;
      render();
      dialog.open = true;
      styleSettingsControl(true);
    }
    async function run(action) {
      if (busy) return;
      busy = true;
      flash = void 0;
      dialog.setAttribute("aria-busy", "true");
      for (const control of dialog.querySelectorAll("button, input, textarea")) control.disabled = true;
      try {
        await action();
      } catch (error) {
        const text = messageText(error);
        log("Host", text);
        if (dialog.open) flash = { tone: "error", text };
        else notify("Mods for T3 Code", text);
      } finally {
        busy = false;
        dialog.removeAttribute("aria-busy");
        render();
      }
    }
    function enqueue(task) {
      const next = importQueue.then(() => disposed ? void 0 : task());
      importQueue = next.catch(() => void 0);
      return next;
    }
    function changed() {
      if (dialog.open && !busy && (!review || review.entry) && !(shadow.activeElement instanceof HTMLTextAreaElement)) render();
    }
    async function reportProblem(value, error, salt = "") {
      let hash;
      try {
        hash = await digest(`${salt}
${messageText(error)}
${JSON.stringify(value) ?? ""}`);
      } catch {
        return;
      }
      if (seenInbox[hash] || problems.some((problem) => problem.hash === hash)) return;
      const { id, name } = describeInvalid(value);
      problems.push({ hash, ...id ? { id } : {}, name, error: messageText(error) });
      if (problems.length > 10) problems.shift();
      log(name, `Can\u2019t install: ${messageText(error)}`);
      if (dialog.open) changed();
      else notify(name, "This mod can\u2019t be installed as sent. Open Mods to see why and ask for a fix.", ["Open Mods", () => open2("installed")]);
    }
    async function accept(value, source) {
      const automatic = Boolean(source.inbox);
      const bundle = validateBundle(value);
      const hash = await digest(JSON.stringify(bundle));
      const { manifest } = bundle;
      const solved = problems.findIndex((problem) => problem.id === manifest.id);
      if (solved >= 0) problems.splice(solved, 1);
      const installed = recordFor(manifest.id);
      if (installed && sameBundle(installed, bundle)) {
        if (pending.some((entry2) => entry2.hash === hash)) {
          pending = pending.filter((entry2) => entry2.hash !== hash);
          await savePending();
          changed();
        }
        if (!automatic) {
          tab = "installed";
          review = void 0;
          flash = { tone: "info", text: `${manifest.name} ${manifest.version} is already installed.` };
          render();
          if (!dialog.open) dialog.showModal();
        }
        return;
      }
      if (automatic && seenInbox[hash]) return;
      const existing = pending.find((entry2) => entry2.hash === hash);
      if (existing) {
        if (!automatic) showReview({ bundle: existing.bundle, entry: existing });
        return;
      }
      const superseded = pending.filter((entry2) => entry2.bundle.manifest.id === manifest.id);
      if (automatic && development && installed?.enabled && installed.manifest.author === manifest.author && manifest.permissions.every((permission) => installed.manifest.permissions.includes(permission))) {
        const record = { ...bundle, enabled: true, quarantined: null };
        await database.save(record);
        await remember(hash);
        pending = pending.filter((entry2) => !superseded.includes(entry2));
        await savePending();
        if (review?.entry && superseded.includes(review.entry)) review = void 0;
        records = await database.list();
        stop(manifest.id);
        start(recordFor(manifest.id) ?? record);
        broadcast();
        notify(manifest.name, `Updated to ${manifest.version} and reloaded.`);
        changed();
        return;
      }
      const from = source.from ?? (source.threadId ? "chat" : automatic ? "inbox" : "file");
      const entry = { bundle, hash, source: from, receivedAt: Date.now(), ...source.threadId ? { threadId: source.threadId } : {}, ...source.messageId ? { messageId: source.messageId } : {} };
      pending = [...pending.filter((item) => !superseded.includes(item)), entry].slice(-MAX_PENDING);
      await savePending();
      broadcast();
      if (!automatic) {
        showReview({ bundle, entry });
        return;
      }
      if (review?.entry && superseded.includes(review.entry)) review = { bundle, entry };
      if (dialog.open) changed();
      else notify(manifest.name, installed ? `Update ${manifest.version} is ready to review.` : "Ready to review. Nothing runs until you install it.", ["Review", () => showReview({ bundle, entry })]);
    }
    function importCandidate(value, source = {}) {
      return enqueue(async () => {
        try {
          await accept(value, source);
        } catch (error) {
          if (source.inbox) await reportProblem(value, error, source.messageId);
          else if (dialog.open && !busy) {
            flash = { tone: "error", text: `Can\u2019t import this mod: ${messageText(error)}` };
            render();
          } else notify("Can\u2019t import mod", messageText(error));
        }
      });
    }
    function scheduleBundleScan(delay = 400) {
      if (bundleScan !== void 0 || disposed) return;
      bundleScan = setTimeout(() => {
        bundleScan = void 0;
        void scanRenderedBundles();
      }, delay);
    }
    async function scanRenderedBundles() {
      if (disposed) return;
      const blocks = [...document.querySelectorAll("pre")].filter((block) => !block.closest(NOT_A_REPLY)).slice(-MAX_RENDERED_BLOCKS);
      let manifest;
      for (const block of blocks) {
        if (disposed) return;
        const code = block.querySelector("code") ?? block;
        const text = code.textContent ?? "";
        const kind = /\blanguage-t3mod-(manifest|code)\b/.exec(code.className)?.[1];
        if (kind === "manifest") {
          manifest = text;
          continue;
        }
        const pair = kind === "code" && manifest !== void 0 ? manifest : void 0;
        manifest = void 0;
        const seen = pair === void 0 ? text : `${pair}
${text}`;
        if (scannedBlocks.get(block) === seen) continue;
        if (pair !== void 0) {
          const settling = settlingPairs.get(block);
          if (settling?.text !== seen) {
            settlingPairs.set(block, { text: seen, since: Date.now() });
            scheduleBundleScan(PAIR_SETTLE_MS);
            continue;
          }
          if (Date.now() - settling.since < PAIR_SETTLE_MS) {
            scheduleBundleScan(PAIR_SETTLE_MS - (Date.now() - settling.since));
            continue;
          }
        }
        scannedBlocks.set(block, seen);
        let value;
        if (pair !== void 0) {
          if (!text.trim() || pair.length + text.length > MAX_BUNDLE_BYTES) continue;
          try {
            value = { format: "t3mod/1", manifest: JSON.parse(pair), code: text };
          } catch {
            continue;
          }
        } else {
          const trimmed = text.trim();
          if (trimmed.length > MAX_BUNDLE_BYTES || !trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(BUNDLE_HINT)) continue;
          try {
            value = JSON.parse(trimmed);
          } catch {
            continue;
          }
        }
        await importCandidate(value, { inbox: true, from: "chat" });
      }
    }
    function pickFile() {
      const input = node("input", { type: "file", accept: ".t3mod,application/json" });
      input.onchange = () => void run(async () => {
        const file = input.files?.[0];
        if (!file) return;
        importError = void 0;
        try {
          if (file.size > MAX_BUNDLE_BYTES) throw new Error("Mod bundles must be smaller than 1 MB.");
          let value;
          try {
            value = JSON.parse(await file.text());
          } catch {
            throw new Error(`${file.name} is not a valid .t3mod file. Check that it is the complete bundle.`);
          }
          await accept(value, { from: "file" });
        } catch (error) {
          importError = `${file.name}: ${messageText(error)}`;
          review = void 0;
          tab = "import";
          if (!dialog.open) dialog.showModal();
        }
      });
      input.click();
    }
    function reviewPaste() {
      void run(async () => {
        importError = void 0;
        try {
          await accept(bundleFromText(importText), { from: "paste" });
          importText = "";
        } catch (error) {
          importError = messageText(error);
        }
      });
    }
    function download(record) {
      const blob = new Blob([JSON.stringify({ format: record.format, manifest: record.manifest, code: record.code }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = node("a", { href: url, download: `${record.manifest.id}.t3mod` });
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
    }
    function draftInChat(text, done) {
      void run(async () => {
        const request = typeof text === "string" ? text : text();
        if (!composer()) throw new Error("Open a chat thread first, then try again. The request goes into that thread\u2019s composer.");
        closeManager();
        insertDraft((readDraft() ? "\n\n" : "") + request);
        done?.();
      });
    }
    function editSource(id) {
      const installed = recordFor(id);
      const example = (options.examples ?? []).find((item) => item.manifest.id === id);
      if (installed) return { bundle: validateBundle(installed), installed: true, builtIn: Boolean(example) };
      return example ? { bundle: validateBundle(example), installed: false, builtIn: true } : void 0;
    }
    function showEdit(id, back) {
      editing = { id, ...back ? { back } : {} };
      review = void 0;
      flash = void 0;
      render();
      if (!dialog.open) dialog.showModal();
    }
    async function install(current) {
      const { bundle, entry } = current;
      const { manifest } = bundle;
      const record = { ...bundle, enabled: true, quarantined: null };
      await database.save(record);
      await remember(entry?.hash);
      if (pending.some((item) => item === entry || sameBundle(item.bundle, bundle))) {
        pending = pending.filter((item) => item !== entry && !sameBundle(item.bundle, bundle));
        await savePending();
      }
      records = await database.list();
      review = void 0;
      tab = "installed";
      stop(manifest.id);
      start(recordFor(manifest.id) ?? record);
      broadcast();
      notify(manifest.name, options.safeMode ? "Installed. Mods are off in safe mode." : paused ? "Installed. It will start when you resume mods." : "Installed and switched on.");
    }
    async function dismiss(entry) {
      await remember(entry.hash);
      pending = pending.filter((item) => item.hash !== entry.hash);
      await savePending();
      if (review?.entry?.hash === entry.hash) review = void 0;
      broadcast();
    }
    async function dismissProblem(problem) {
      await remember(problem.hash);
      const index = problems.indexOf(problem);
      if (index >= 0) problems.splice(index, 1);
    }
    function enableToggle(record) {
      const { manifest } = record;
      const control = toggle(record.enabled, `Enable ${manifest.name}`, Boolean(options.safeMode) || busy);
      control.onchange = () => void run(async () => {
        stop(manifest.id);
        record.enabled = control.checked;
        record.quarantined = null;
        await database.save(record);
        start(record);
        broadcast();
      });
      return control;
    }
    function retry(record) {
      void run(async () => {
        stop(record.manifest.id);
        record.enabled = true;
        record.quarantined = null;
        await database.save(record);
        start(record);
        broadcast();
      });
    }
    function stateBadge(record) {
      const [label, key] = stateOf(record);
      return badge(label, key);
    }
    function installedRow(record) {
      const { manifest } = record;
      const count = manifest.permissions.length;
      const reason = record.quarantined;
      const items = [["Details", () => showReview({ bundle: validateBundle(record), detailsOnly: true })], ["Edit", () => showEdit(manifest.id)]];
      if (reason) items.push(["Ask AI to fix", () => draftInChat(fixPrompt(manifest.name, manifest.id, manifest.version, reason))]);
      items.push(["Export", () => download(record)], ["Remove", () => void run(async () => {
        if (!await ask(`Remove ${manifest.name}?`, "The mod and its private data will be removed. Export it first if you want a copy.", "Remove mod", true)) return;
        stop(manifest.id);
        await database.remove(manifest.id);
        records = records.filter((item) => item !== record);
        broadcast();
      }), "danger"]);
      const controls = [...reason && !options.safeMode ? [button("Retry", () => retry(record), "xs")] : [], moreButton(`More actions for ${manifest.name}`, items), enableToggle(record)];
      const element2 = row([document.createTextNode(manifest.name), stateBadge(record)], manifest.description, controls, [
        meta(`${manifest.version} \xB7 ${manifest.author} \xB7 ${count} permission${count === 1 ? "" : "s"}`),
        ...reason ? [node("p", { class: "error", text: `Stopped: ${reason.replace(/\.?\s*$/, ".")} Retry, or ask your AI for a fix from the menu.` })] : []
      ]);
      element2.dataset.mod = manifest.id;
      return element2;
    }
    function pendingRow(entry) {
      const { manifest } = entry.bundle;
      const installed = recordFor(manifest.id);
      const element2 = row([document.createTextNode(manifest.name), badge(installed ? "Update" : "New", "pending")], manifest.description, [
        moreButton(`More actions for ${manifest.name}`, [["Dismiss", () => void run(() => dismiss(entry)), "danger"]]),
        button("Review", () => showReview({ bundle: entry.bundle, entry }), "primary xs")
      ], [meta(`${installed ? `${installed.manifest.version} \u2192 ` : ""}${manifest.version} \xB7 ${manifest.author} \xB7 ${SOURCE_LABEL[entry.source]} \xB7 ${ago(entry.receivedAt)}`)]);
      element2.dataset.pending = manifest.id;
      return element2;
    }
    function problemRow(problem) {
      return row([document.createTextNode(problem.name), badge("Can\u2019t install", "stopped")], "", [
        moreButton(`More actions for ${problem.name}`, [["Dismiss", () => void run(() => dismissProblem(problem)), "danger"]]),
        button("Ask AI to fix", () => draftInChat(fixPrompt(problem.name, problem.id, void 0, problem.error)), "xs")
      ], [node("p", { class: "error", text: problem.error }), meta("From a chat reply \xB7 nothing was installed")]);
    }
    function render() {
      closeMenu();
      const actions = [button("Import", () => go("import"), "xs")];
      if (!inlineContent) actions.push(closeButton(closeManager));
      dialog.replaceChildren(node("header", {}, [node("div", {}, [node("h1", { text: "Mods" }), node("p", { text: "Local add-ons for T3 Code. Each mod runs isolated and can be switched off at any time." })]), node("div", { class: "header-actions" }, actions)]));
      if (editing) {
        renderEdit(editing);
        return;
      }
      if (review) {
        renderReview(review);
        return;
      }
      const waiting = pending.length + problems.length;
      dialog.append(node("nav", { class: "tabs", "aria-label": "Mod manager" }, [["installed", "Installed"], ["examples", "Built-in"], ["commands", "Commands"], ["create", "Create"], ["console", "Activity"]].map(([key = "", text = ""]) => {
        const item = button(text, () => go(key));
        item.setAttribute("aria-selected", String(tab === key));
        if (key === "installed" && waiting) item.append(node("span", { class: "count", text: String(waiting), title: `${waiting} waiting for review` }));
        return item;
      })));
      const content = node("div", { class: "content" });
      dialog.append(content);
      if (flash) content.append(node("p", { class: "flash", "data-tone": flash.tone, role: flash.tone === "error" ? "alert" : "status", text: flash.text }));
      if (tab === "installed") {
        if (waiting) content.append(section("Waiting for review", [...pending.map(pendingRow), ...problems.map(problemRow)], meta("Nothing runs until you install it")));
        const list = records.map(installedRow);
        if (!list.length) list.push(row("No mods installed", "Try a built-in mod, import a .t3mod file, or describe one and let your AI build it.", [button("Built-in", () => go("examples"), "xs"), button("Create", () => go("create"), "xs")]));
        const active = records.filter((record) => stateOf(record)[1] === "active").length;
        content.append(section("Installed", list, meta(options.safeMode ? "Safe mode" : `${records.length} installed \xB7 ${active} active`)));
        const pause = toggle(paused, "Pause all mods", Boolean(options.safeMode) || busy);
        pause.onchange = () => void run(async () => {
          paused = pause.checked;
          if (paused) for (const id of [...runtimes.keys()]) stop(id);
          await database.setSetting("paused", paused);
          broadcast();
          await reload();
        });
        const dev = toggle(development, "Development mode");
        dev.onchange = () => void run(async () => {
          development = dev.checked;
          await database.setSetting("development", development);
        });
        content.append(section("General", [
          row("Pause all mods", options.safeMode ? "Safe mode is on, so all mod code is off." : "Stops every mod immediately. Use this if something misbehaves.", [pause]),
          row("Development mode", "Load updates from chat into an enabled mod right away when the author is the same and no new permissions are needed. New permissions always need review.", [dev])
        ]));
      } else if (tab === "examples") {
        const list = (options.examples ?? []).map((example) => {
          const bundle = validateBundle(example);
          const { manifest } = bundle;
          const installed = recordFor(manifest.id);
          const more = moreButton(`More actions for ${manifest.name}`, [["Edit", () => showEdit(manifest.id)]]);
          if (!installed) {
            const element3 = row(manifest.name, manifest.description, [more, button("Review", () => showReview({ bundle }), "xs")], [meta(`${manifest.version} \xB7 not installed`)]);
            element3.dataset.example = manifest.id;
            return element3;
          }
          const current = sameBundle(installed, bundle);
          const element2 = row([document.createTextNode(manifest.name), stateBadge(installed)], manifest.description, [
            more,
            ...current ? [] : [button("Review update", () => showReview({ bundle }), "xs")],
            ...installed.quarantined && !options.safeMode ? [button("Retry", () => retry(installed), "xs")] : [],
            enableToggle(installed)
          ], [meta(current ? `${manifest.version} \xB7 installed` : `${installed.manifest.version} installed \xB7 ${manifest.version} included`)]);
          element2.dataset.mod = manifest.id;
          element2.dataset.example = manifest.id;
          return element2;
        });
        content.append(section("Built-in", list.length ? list : [note("No built-in mods in this build.")]), node("p", { class: "explain", text: "Included with Mods for T3 Code. Review one to install it; it starts right away and you can switch it off here or under Installed. Context Usage opens a token inspector; Token Weather shows a compact usage forecast." }));
      } else if (tab === "commands") {
        let show2 = function() {
          list.replaceChildren();
          for (const [id, entries] of commands) for (const command of entries.values()) {
            const runtime = runtimes.get(id);
            if (!runtime || !command.title.toLowerCase().includes(search.value.toLowerCase())) continue;
            list.append(row(command.title, runtime.record.manifest.name, [button("Run", () => {
              closeManager();
              runtime.invoke("command", command.id);
            }, "xs")]));
          }
          if (!list.childNodes.length) list.append(note(commands.size ? "No matching commands." : "Switch on a mod that registers commands to see them here."));
        };
        var show = show2;
        const search = node("input", { type: "search", placeholder: "Find a mod command\u2026", "aria-label": "Find command" });
        const list = node("div");
        content.append(search, section("Commands", [list]));
        search.oninput = show2;
        show2();
      } else if (tab === "create") {
        const description = node("textarea", { placeholder: "A focus timer with a start button and a reminder after 25 minutes\u2026", "aria-label": "Describe your mod", maxLength: 5e3, value: createText });
        description.oninput = () => {
          createText = description.value;
        };
        const request = () => {
          if (!createText.trim()) throw new Error("Describe what your mod should do first.");
          return authorPrompt(createText, options.inbox);
        };
        const step = (text) => node("li", { text });
        if (pending.length) content.append(section("Waiting for review", pending.map(pendingRow)));
        content.append(section("Create with your AI", [node("div", { class: "body" }, [
          node("label", { text: "What should your mod do?" }),
          description,
          node("ol", { class: "steps" }, [
            step("Draft in T3 adds a request to the open chat\u2019s composer. Send it with the model and account you already use."),
            step("Your AI\u2019s reply returns the mod. It appears here and under Installed, waiting for your review."),
            step("Review its permissions and install. It turns on right away, no restart needed."),
            step("Want changes? Ask in the same chat, then review the update.")
          ]),
          node("div", { class: "actions" }, [
            button("Copy request", () => void run(async () => {
              await navigator.clipboard.writeText(request());
              flash = { tone: "info", text: "Request copied. Paste it into a T3 chat and send it." };
            }), "xs"),
            button("Draft in T3", () => draftInChat(request()), "primary xs")
          ])
        ])]), node("p", { class: "explain", text: "Reply finished but nothing to review? Copy the whole reply and paste it under Import." }));
      } else if (tab === "import") {
        const text = node("textarea", { class: "code", placeholder: "Paste the AI reply with the mod, or a .t3mod bundle\u2019s JSON\u2026", "aria-label": "Paste a mod bundle", spellcheck: false, value: importText });
        text.oninput = () => {
          importText = text.value;
        };
        content.append(section("Import", [
          row("From a file", "A .t3mod file you saved or were given.", [button("Choose file\u2026", pickFile, "xs")]),
          node("div", { class: "body" }, [
            node("label", { text: "Or paste a bundle" }),
            text,
            ...importError ? [node("p", { class: "error", role: "alert", text: importError })] : [],
            node("p", { class: "explain", text: "Paste the whole AI reply, its two mod code blocks, or bundle JSON. You review permissions before anything runs." }),
            node("div", { class: "actions" }, [button("Review", reviewPaste, "primary xs")])
          ])
        ]));
      } else {
        content.append(section("Activity", [node("pre", { class: "log", text: logs.join("\n") || "No mod activity yet." })], button("Clear", () => {
          logs.length = 0;
          render();
        }, "ghost xs")), node("p", { class: "explain", text: "Recent mod messages and failures in this window." }));
      }
    }
    function renderReview(current) {
      const { bundle, entry, detailsOnly = false } = current;
      const { manifest } = bundle;
      const previous = recordFor(manifest.id);
      const updating = Boolean(previous) && !detailsOnly;
      const origin = detailsOnly ? previous ? stateOf(previous)[0] : "" : entry ? `${SOURCE_LABEL[entry.source]} \xB7 ${ago(entry.receivedAt)}` : "Built-in";
      const content = node("div", { class: "content" });
      if (flash) content.append(node("p", { class: "flash", "data-tone": flash.tone, role: flash.tone === "error" ? "alert" : "status", text: flash.text }));
      content.append(node("div", { class: "review-title" }, [
        node("h2", { text: detailsOnly ? manifest.name : updating ? `Review update: ${manifest.name}` : `Review ${manifest.name}` }),
        node("p", { class: "explain", text: manifest.description }),
        meta([updating && previous ? `${previous.manifest.version} \u2192 ${manifest.version}` : manifest.version, manifest.author, origin].filter(Boolean).join(" \xB7 "))
      ]));
      const permissions = manifest.permissions.map((permission) => node("div", { class: "row permission" }, [node("div", { class: "row-text" }, [node("span", { text: PERMISSIONS[permission] }), node("code", { text: `${permission}${updating && previous && !previous.manifest.permissions.includes(permission) ? " \u2014 new permission" : ""}` })])]));
      content.append(section(detailsOnly ? "Permissions" : "This mod asks to", permissions.length ? permissions : [note("No optional permissions.")]));
      const footer = node("div", { class: "footer actions" });
      if (detailsOnly) {
        content.append(node("details", {}, [node("summary", { text: "JavaScript source" }), node("pre", { class: "review-code", text: bundle.code })]));
        footer.append(button("Edit", () => showEdit(manifest.id, current), "xs"), button("Done", () => {
          review = void 0;
          render();
        }, "xs"));
        dialog.append(content, footer);
        return;
      }
      content.append(node("p", { class: "explain", text: `Install code from authors you trust. ${updating ? "The update replaces the running version as soon as you confirm." : "The mod starts as soon as you install it."} Mod code is isolated from T3\u2019s files and credentials, but a mod can consume browser resources and use every permission listed above.` }), node("details", {}, [node("summary", { text: "Review JavaScript source" }), node("pre", { class: "review-code", text: bundle.code })]));
      const confirm = button(updating ? "Update mod" : "Install mod", () => void run(() => install(current)), "primary xs");
      if (entry) footer.append(button("Dismiss", () => void run(() => dismiss(entry)), "ghost xs start"), button("Not now", () => {
        review = void 0;
        tab = "installed";
        render();
      }, "xs"), confirm);
      else footer.append(...previous ? [] : [button("Edit", () => showEdit(manifest.id, current), "ghost xs start")], button("Cancel", () => {
        review = void 0;
        render();
      }, "xs"), confirm);
      dialog.append(content, footer);
    }
    function renderEdit(current) {
      const { id } = current;
      const source = editSource(id);
      const back = () => {
        editing = void 0;
        review = current.back;
        flash = void 0;
        render();
      };
      const content = node("div", { class: "content" });
      const footer = node("div", { class: "footer actions" });
      if (flash) content.append(node("p", { class: "flash", "data-tone": flash.tone, role: flash.tone === "error" ? "alert" : "status", text: flash.text }));
      if (!source) {
        content.append(node("p", { class: "explain", text: "This mod is no longer installed." }));
        footer.append(button("Back", back, "xs"));
        dialog.append(content, footer);
        return;
      }
      const { manifest } = source.bundle;
      const waiting = pending.some((entry) => entry.bundle.manifest.id === id);
      content.append(node("div", { class: "review-title" }, [
        node("h2", { text: `Edit ${manifest.name}` }),
        node("p", { class: "explain", text: manifest.description }),
        meta([manifest.version, manifest.author, source.installed ? "Installed" : "Built-in \xB7 not installed"].join(" \xB7 "))
      ]));
      const text = node("textarea", { placeholder: "Also show the context window size, use shorter labels\u2026", "aria-label": `Changes for ${manifest.name}`, maxLength: 5e3, value: editTexts.get(id) ?? "" });
      text.oninput = () => {
        editTexts.set(id, text.value);
      };
      const request = () => {
        const change = (editTexts.get(id) ?? "").trim();
        if (!change) throw new Error("Describe what should change first.");
        const latest = editSource(id);
        if (!latest) throw new Error(`${manifest.name} is no longer installed.`);
        return editPrompt(change, latest, options.inbox);
      };
      content.append(section("Changes", [node("div", { class: "body" }, [
        node("label", { text: "What should change?" }),
        text,
        node("p", { class: "explain", text: `Draft in T3 adds a request with ${source.installed ? "your installed copy\u2019s" : "this mod\u2019s"} complete code to the open chat\u2019s composer. Send it with the model and account you already use. The edited mod keeps its id and appears under Waiting for review; ${source.installed ? "the installed version keeps running until you review the update." : "nothing is installed until you review it."}${waiting ? " It replaces the update already waiting for review." : ""}` })
      ])]));
      footer.append(
        button("Cancel", back, "xs"),
        button("Copy request", () => void run(async () => {
          await navigator.clipboard.writeText(request());
          flash = { tone: "info", text: "Request copied. Paste it into a T3 chat and send it." };
        }), "xs"),
        button("Draft in T3", () => draftInChat(request, () => {
          editTexts.delete(id);
          editing = void 0;
        }), "primary xs")
      );
      dialog.append(content, footer);
    }
    function onInput(event) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('[data-testid="composer-editor"]')) return;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        for (const runtime of runtimes.values()) runtime.emit("draft.change", readDraft());
      }, 150);
    }
    const detachSidebar = attachSidebarButton(() => open2());
    let settingsItem;
    function settingsNav() {
      const content = document.querySelector('[data-sidebar="content"]') ?? document.querySelector('[data-slot="sidebar-content"]');
      const menus = content ? [...content.querySelectorAll('[data-sidebar="menu"], [data-slot="sidebar-menu"], ul')] : [];
      return menus.find((item) => navItems(item).some((entry) => /\b(general|appearance|providers|keybindings)\b/i.test(entry.textContent ?? ""))) ?? null;
    }
    function navItems(menuRoot) {
      return [...menuRoot.querySelectorAll("button, a")].filter((item) => !item.closest("[data-t3mods]") && Boolean(item.textContent?.trim()));
    }
    function styleSettingsControl(active) {
      const control = settingsItem?.querySelector("button");
      if (!(control instanceof HTMLButtonElement)) return;
      const items = settingsItem?.parentElement ? navItems(settingsItem.parentElement) : [];
      const isActive = (item) => item.getAttribute("data-active") === "true" || item.getAttribute("aria-current") === "page";
      const reference = (active ? items.find(isActive) : items.find((item) => !isActive(item))) ?? items[0];
      control.className = reference?.className ?? "";
      control.style.cssText = reference ? "" : "display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer";
      for (const name of ["data-slot", "data-sidebar", "data-size"]) {
        const value = reference?.getAttribute(name);
        if (value) control.setAttribute(name, value);
      }
      control.querySelector("svg")?.setAttribute("class", reference?.querySelector("svg")?.getAttribute("class") ?? "");
      control.querySelector("span")?.setAttribute("class", reference?.querySelector("span")?.getAttribute("class") ?? "");
      if (reference?.hasAttribute("data-active")) control.setAttribute("data-active", String(active));
      if (active) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
    }
    function attachSettings() {
      if (!routePath().startsWith("/settings") || settingsItem?.isConnected) return;
      const menuRoot = settingsNav();
      if (!menuRoot) return;
      const nativeItem = navItems(menuRoot)[0]?.closest("li");
      const item = node("li", { "data-t3mods": "settings-section", class: nativeItem?.className ?? "" });
      for (const name of ["data-slot", "data-sidebar"]) {
        const value = nativeItem?.getAttribute(name);
        if (value) item.setAttribute(name, value);
      }
      if (!nativeItem) item.style.cssText = "list-style:none";
      const control = node("button", { type: "button", onclick: openSettings }, [node("span", { text: "Mods" })]);
      control.insertAdjacentHTML("afterbegin", MODS_ICON);
      item.append(control);
      menuRoot.append(item);
      settingsItem = item;
      styleSettingsControl(Boolean(inlineContent));
    }
    function attachPanels() {
      const footer = sidebarFooter();
      if (!footer) return;
      if (panelRoot.parentElement !== footer) footer.prepend(panelRoot);
      if (tray.parentNode !== panelShadow) {
        tray.setAttribute("data-docked", "true");
        panelShadow.append(tray);
      }
    }
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === "childList")) {
        attachSettings();
        attachPanels();
      }
      connectArtifacts();
      if (mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return Boolean(target && !target.closest(NOT_A_REPLY));
      })) scheduleBundleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    attachSettings();
    attachPanels();
    document.addEventListener("input", onInput, true);
    const onRoute = () => {
      const path = routePath();
      if (lastPath !== path) {
        lastPath = path;
        leaveInline();
        if (settingsItem) {
          settingsItem.remove();
          settingsItem = void 0;
        }
        attachSettings();
        connectTelemetry();
        connectArtifacts();
        const usage = currentUsage();
        renderContext();
        for (const runtime of runtimes.values()) {
          runtime.emit("app.route", lastPath);
          runtime.emit("session.usage", usage);
        }
      }
    };
    const historyMethods = /* @__PURE__ */ new Map();
    for (const key of ["pushState", "replaceState"]) {
      const original = history[key];
      const wrapped = function(...args) {
        Reflect.apply(original, this, args);
        queueMicrotask(onRoute);
      };
      historyMethods.set(key, { original, wrapped });
      history[key] = wrapped;
    }
    window.addEventListener("popstate", onRoute);
    window.addEventListener("hashchange", onRoute);
    const onKeys = (event) => {
      if (event.key !== "Escape" || !shadow.querySelector("dialog[open]")) return;
      event.stopPropagation();
      if (menu) {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (dialog.open && shadow.querySelectorAll("dialog[open]").length === 1) {
        event.preventDefault();
        if (inlineContent) leaveInline();
        else dialog.close();
      }
    };
    document.addEventListener("keydown", onKeys, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    shadow.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    try {
      channel = new BroadcastChannel("mods-for-t3-code");
      channel.onmessage = () => void reload();
    } catch {
    }
    window.__modsForT3Code = { open: open2, importCandidate, async dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...runtimes.keys()]) stop(id);
      contextDock.dispose();
      leaveInline();
      detachSidebar();
      observer.disconnect();
      clearTimeout(bundleScan);
      panelRoot.remove();
      bandDock.dispose();
      try {
        unsubscribeTelemetry?.();
      } catch {
      }
      try {
        unsubscribeArtifacts?.();
      } catch {
      }
      for (const notice of notices.splice(0)) notice.remove();
      settingsItem?.remove();
      clearTimeout(draftTimer);
      channel?.close();
      window.removeEventListener("popstate", onRoute);
      window.removeEventListener("hashchange", onRoute);
      for (const [key, method] of historyMethods) if (history[key] === method.wrapped) history[key] = method.original;
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keydown", onKeys, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      closeMenu();
      root.remove();
      delete window.__modsForT3Code;
    } };
    connectTelemetry();
    try {
      await reload();
    } finally {
      loaded();
    }
    connectArtifacts();
    scheduleBundleScan();
    log("Host", options.safeMode ? "Safe mode enabled" : "Ready");
  }

  // renderer-entry.js
  if (!window.__modsForT3Installing && !window.__modsForT3Code) {
    window.__modsForT3Installing = true;
    mount({ examples: [{ "format": "t3mod/1", "manifest": { "apiVersion": 1, "id": "context-usage", "version": "1.0.0", "name": "Context Usage", "description": "A live context usage ring. Click to see measured tokens, window capacity, and category counts when T3 supplies them.", "author": "Mods for T3 Code", "permissions": ["ui.context", "session.usage"] }, "code": '"use strict";\nvar T3Mod = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n\n  // examples/context-usage/mod.ts\n  var mod_exports = {};\n  __export(mod_exports, {\n    activate: () => activate\n  });\n  async function activate(api) {\n    await api.context.show();\n  }\n  return __toCommonJS(mod_exports);\n})();\n\nglobalThis.T3Mod = T3Mod;\n' }, { "format": "t3mod/1", "manifest": { "apiVersion": 1, "id": "token-weather", "version": "1.0.0", "name": "Token weather", "description": "A one-line forecast above the composer: measured context use for the open thread and the last turn\u2019s change.", "author": "Mods for T3 Code", "permissions": ["ui.band", "session.usage", "storage"] }, "code": '"use strict";\nvar T3Mod = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n\n  // examples/token-weather/mod.ts\n  var mod_exports = {};\n  __export(mod_exports, {\n    activate: () => activate,\n    formatTokens: () => formatTokens,\n    line: () => line,\n    weather: () => weather\n  });\n  var WEATHER = [\n    { below: 25, icon: "\\u2600", label: "Clear", tone: "yellow" },\n    { below: 50, icon: "\\u2601", label: "Cloudy", tone: "cyan" },\n    { below: 75, icon: "\\u2602", label: "Showers", tone: "blue" },\n    { below: 90, icon: "\\u2607", label: "Storm", tone: "magenta" },\n    { below: Infinity, icon: "\\u21AF", label: "Compact soon", tone: "red" }\n  ];\n  var MAX_TURNS = 12;\n  var MAX_THREADS = 40;\n  function formatTokens(value) {\n    if (value < 1e3) return String(value);\n    if (value < 999950) return `${(value / 1e3).toFixed(1).replace(/\\.0$/, "")}k`;\n    return `${(value / 1e6).toFixed(2).replace(/\\.?0+$/, "")}M`;\n  }\n  function weather(percent) {\n    const forecast = WEATHER.find((item) => percent < item.below);\n    if (forecast) return forecast;\n    const fallback = WEATHER[WEATHER.length - 1];\n    if (!fallback) throw new Error("Weather scale is empty.");\n    return fallback;\n  }\n  function turnKey(turnId) {\n    let hash = 2166136261;\n    for (let index = 0; index < turnId.length; index++) hash = Math.imul(hash ^ turnId.charCodeAt(index), 16777619);\n    return (hash >>> 0).toString(36);\n  }\n  function line(snapshot, turns) {\n    if (!snapshot) return [];\n    const parts = [];\n    if (snapshot.maxTokens) {\n      const percent = Math.floor(snapshot.usedTokens / snapshot.maxTokens * 100);\n      const forecast = weather(percent);\n      parts.push({ text: `${forecast.icon} ${forecast.label}`, tone: forecast.tone }, { text: `  ${percent}%` }, { text: `  ${formatTokens(snapshot.usedTokens)} / ${formatTokens(snapshot.maxTokens)}`, tone: "muted" });\n    } else {\n      parts.push({ text: "\\u25CC Window unknown", tone: "muted" }, { text: `  ${formatTokens(snapshot.usedTokens)} used \\xB7 window size unavailable`, tone: "muted" });\n    }\n    if (turns.length > 1) {\n      const latest = turns.at(-1);\n      const prior = turns.at(-2);\n      if (latest !== void 0 && prior !== void 0) {\n        const delta = latest - prior;\n        parts.push(delta >= 0 ? { text: `  \\u25B2 +${formatTokens(delta)} last turn` } : { text: `  \\u25BC \\u2212${formatTokens(-delta)} last turn`, tone: "cyan" });\n      }\n    }\n    return parts;\n  }\n  function isRecord(value) {\n    return typeof value === "object" && value !== null && !Array.isArray(value);\n  }\n  function readTurn(value) {\n    if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "number") return null;\n    if (!Number.isSafeInteger(value[1]) || value[1] < 0) return null;\n    return [value[0], value[1]];\n  }\n  function historyPayload(threads) {\n    const encoded = [];\n    for (const [threadId, turns] of threads) encoded.push([threadId, turns.map((turn) => [turn[0], turn[1]])]);\n    return { version: 1, threads: encoded };\n  }\n  async function activate(api) {\n    const threads = /* @__PURE__ */ new Map();\n    const saved = await api.storage.get("history");\n    if (isRecord(saved) && saved.version === 1 && Array.isArray(saved.threads)) {\n      for (const item of saved.threads.slice(-MAX_THREADS)) {\n        if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;\n        const turns = [];\n        for (const turn of item[1]) {\n          const stored = readTurn(turn);\n          if (stored) turns.push(stored);\n        }\n        threads.set(item[0], turns.slice(-MAX_TURNS));\n      }\n    }\n    let current = await api.session.usage();\n    let shown = "";\n    function record(snapshot) {\n      if (!snapshot?.complete || !snapshot.turnId) return;\n      const turns = threads.get(snapshot.threadId) ?? [];\n      const key = turnKey(snapshot.turnId);\n      const existing = turns.find((turn) => turn[0] === key);\n      if (existing) {\n        if (existing[1] === snapshot.usedTokens) return;\n        existing[1] = snapshot.usedTokens;\n      } else turns.push([key, snapshot.usedTokens]);\n      threads.delete(snapshot.threadId);\n      threads.set(snapshot.threadId, turns.slice(-MAX_TURNS));\n      while (threads.size > MAX_THREADS) {\n        const oldest = threads.keys().next().value;\n        if (oldest === void 0) break;\n        threads.delete(oldest);\n      }\n      void api.storage.set("history", historyPayload(threads));\n    }\n    async function draw() {\n      const parts = line(current, current ? (threads.get(current.threadId) ?? []).map((turn) => turn[1]) : []);\n      const text = JSON.stringify(parts);\n      if (text === shown) return;\n      shown = text;\n      if (parts.length) await api.band.set(parts);\n      else await api.band.clear();\n    }\n    async function update(snapshot) {\n      current = snapshot;\n      record(snapshot);\n      await draw();\n    }\n    api.on("session.usage", update);\n    api.on("turn.complete", (snapshot) => update(snapshot));\n    record(current);\n    await draw();\n  }\n  return __toCommonJS(mod_exports);\n})();\n\nglobalThis.T3Mod = T3Mod;\n' }], ...window.__MODS_FOR_T3_OPTIONS__, sandboxDocument: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><title>Isolated mod runtime</title></head><body><script>"use strict";
(() => {
  // payload/public/sandbox.ts
  (() => {
    let initialized = false;
    window.addEventListener("message", (event) => {
      if (initialized || event.source !== parent || event.data?.type !== "t3mods.connect" || !event.ports[0]) return;
      initialized = true;
      const port = event.ports[0];
      let worker;
      let blobUrl;
      port.onmessage = ({ data }) => {
        if (data.type === "init") {
          const source = workerBootstrap.toString();
          blobUrl = URL.createObjectURL(new Blob([\`"use strict";
\${data.code}
;(\${source})(globalThis.T3Mod);\`], { type: "text/javascript" }));
          worker = new Worker(blobUrl);
          worker.onmessage = ({ data: message }) => port.postMessage(message);
          worker.onerror = (error) => port.postMessage({ type: "fault", error: error.message || "Mod worker failed." });
          worker.postMessage(data);
        } else if (data.type === "stop") {
          worker?.terminate();
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          port.close();
        } else worker?.postMessage(data);
      };
      port.start();
      port.postMessage({ type: "connected" });
    });
    function workerBootstrap(mod) {
      const scope = globalThis;
      let sequence = 0;
      const pending = /* @__PURE__ */ new Map();
      const events = /* @__PURE__ */ new Map();
      const commands = /* @__PURE__ */ new Map();
      const actions = /* @__PURE__ */ new Map();
      let cleanup;
      function call(method, args) {
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = method === "draft.insert" ? null : setTimeout(() => {
            pending.delete(id);
            reject(new Error("Host request timed out."));
          }, 1e4);
          pending.set(id, { resolve: (value) => resolve(value), reject, timer });
          scope.postMessage({ type: "call", id, method, args });
        });
      }
      const api = Object.freeze({
        on(event, callback) {
          if (typeof callback !== "function") throw new Error("An event needs a callback.");
          const callbacks = events.get(event) ?? /* @__PURE__ */ new Set();
          callbacks.add(callback);
          events.set(event, callbacks);
          call("events.subscribe", [event]).catch((error) => scope.postMessage({ type: "fault", error: error instanceof Error ? error.message : String(error) }));
          return () => {
            callbacks.delete(callback);
          };
        },
        commands: Object.freeze({
          async register(command, callback) {
            commands.set(command.id, callback);
            await call("commands.register", [command]);
          }
        }),
        panels: Object.freeze({
          set: (panel) => call("panels.set", [panel]),
          clear: () => call("panels.clear", []),
          action(id, callback) {
            actions.set(id, callback);
          }
        }),
        notify: (message) => call("notify", [message]),
        theme: Object.freeze({ set: (colors) => call("theme.set", [colors]), clear: () => call("theme.clear", []) }),
        band: Object.freeze({ set: (parts) => call("band.set", [parts]), clear: () => call("band.clear", []) }),
        context: Object.freeze({ show: () => call("context.show", []), clear: () => call("context.clear", []) }),
        session: Object.freeze({ usage: () => call("session.usage", []) }),
        route: Object.freeze({ get: () => call("route.get", []) }),
        draft: Object.freeze({ read: () => call("draft.read", []), insert: (text) => call("draft.insert", [text]) }),
        storage: Object.freeze({ get: (key) => call("storage.get", [key]), set: (key, value) => call("storage.set", [key, value]) }),
        log: (message) => call("log", [String(message)])
      });
      const heartbeat = setInterval(() => scope.postMessage({ type: "heartbeat" }), 1e3);
      scope.onmessage = async ({ data }) => {
        if (data.type === "result") {
          const waiter = pending.get(data.id);
          if (!waiter) return;
          pending.delete(data.id);
          if (waiter.timer !== null) clearTimeout(waiter.timer);
          if (data.error) waiter.reject(new Error(data.error));
          else waiter.resolve(data.value);
          return;
        }
        try {
          if (data.type === "init") {
            if (typeof mod?.activate !== "function") throw new Error("Export an activate(api) function.");
            cleanup = await mod.activate(api);
            scope.postMessage({ type: "ready" });
          } else if (data.type === "event") {
            for (const callback of events.get(data.name) ?? []) await callback(data.value);
          } else if (data.type === "invoke") {
            const callback = (data.kind === "command" ? commands : actions).get(data.id);
            if (typeof callback !== "function") throw new Error("Unknown mod action.");
            await callback();
          } else if (data.type === "dispose") {
            clearInterval(heartbeat);
            if (typeof cleanup === "function") await cleanup();
          }
          if ("requestId" in data && data.requestId) scope.postMessage({ type: "done", requestId: data.requestId });
        } catch (error) {
          scope.postMessage({ type: "fault", error: error instanceof Error ? error.message : String(error) });
        }
      };
    }
  })();
})();
<\/script></body></html>` }).catch((error) => console.error("[Mods for T3 Code]", error)).finally(() => {
      delete window.__modsForT3Installing;
    });
  }
})();
