(() => {
  // payload/web/manifest.js
  var API_VERSION = 1;
  var MAX_BUNDLE_BYTES = 1024 * 1024;
  var PERMISSIONS = Object.freeze({
    "ui.panels": "Show text panels and buttons in the Mods tray",
    "ui.commands": "Register local commands in the Mods command palette",
    "ui.notify": "Show notifications labeled with the mod name",
    "ui.theme": "Apply a color theme across the T3 interface",
    "ui.band": "Show one line of styled text above the composer",
    "session.usage": "Read measured context usage for the open thread",
    "app.route": "Read the current app route and follow navigation",
    "draft.read": "Read the current composer draft",
    "draft.insert": "Offer text to paste into the composer, with your confirmation",
    storage: "Store up to 64 KB of private mod data"
  });
  function validateManifest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A mod needs a manifest object.");
    if (value.apiVersion !== API_VERSION) throw new Error(`This host supports mod API ${API_VERSION}.`);
    if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(value.id)) throw new Error("Mod ID must be 2\u201364 lowercase letters, digits, or hyphens.");
    if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)) throw new Error("Use a SemVer version, for example 1.0.0.");
    for (const field of ["name", "description", "author"]) {
      if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > (field === "description" ? 600 : 100)) throw new Error(`Supply a short ${field}.`);
    }
    if (!Array.isArray(value.permissions) || value.permissions.some((p) => !Object.hasOwn(PERMISSIONS, p))) throw new Error("The manifest contains an unsupported permission.");
    if (new Set(value.permissions).size !== value.permissions.length) throw new Error("Permissions must be unique.");
    return { apiVersion: API_VERSION, id: value.id, version: value.version, name: value.name, description: value.description, author: value.author, permissions: [...value.permissions] };
  }
  function validateBundle(value) {
    const manifest = validateManifest(value?.manifest);
    if (value.format !== "t3mod/1" || typeof value.code !== "string" || !value.code.trim()) throw new Error("Choose a .t3mod bundle made with the pack command.");
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BUNDLE_BYTES) throw new Error("A mod bundle must be smaller than 1 MB.");
    return { format: "t3mod/1", manifest, code: value.code };
  }
  function assertPermission(manifest, permission) {
    if (!manifest.permissions.includes(permission)) throw new Error(`Permission not granted: ${permission}`);
  }
  function textValue(value, limit = 4e3) {
    if (typeof value !== "string" || value.length > limit) throw new Error(`Expected text of at most ${limit} characters.`);
    return value;
  }
  function validatePanel(value) {
    if (!value || typeof value !== "object") throw new Error("Expected a panel.");
    const title = textValue(value.title, 100);
    const body = textValue(value.body ?? "", 1e4);
    if (!Array.isArray(value.actions ?? []) || (value.actions ?? []).length > 8) throw new Error("A panel can contain up to 8 actions.");
    const actions = (value.actions ?? []).map((action) => ({ id: textValue(action.id, 64), label: textValue(action.label, 80) }));
    return { title, body, actions };
  }
  var BAND_TONES = Object.freeze(["default", "muted", "yellow", "cyan", "blue", "magenta", "red"]);
  function validateBand(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("A band needs 1\u201316 text parts.");
    let total = 0;
    const parts = value.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("Each band part needs text.");
      const text = textValue(part.text, 160);
      if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) throw new Error("Band text must be a single line without control characters.");
      const tone = part.tone ?? "default";
      if (!BAND_TONES.includes(tone)) throw new Error(`Use a band tone: ${BAND_TONES.join(", ")}.`);
      total += text.length;
      return { text, tone };
    });
    if (total > 300) throw new Error("A band can show up to 300 characters.");
    return parts;
  }
  function usageSnapshot(value) {
    if (!value || typeof value !== "object") return null;
    const id = (item) => typeof item === "string" && item.length > 0 && item.length <= 300 ? item : null;
    const threadId = id(value.threadId);
    if (!threadId || !Number.isSafeInteger(value.usedTokens) || value.usedTokens < 0) return null;
    const turnId = id(value.turnId);
    return {
      threadId,
      turnId,
      usedTokens: value.usedTokens,
      maxTokens: Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0 ? value.maxTokens : null,
      measuredAt: Number.isFinite(value.measuredAt) ? value.measuredAt : Date.now(),
      complete: value.complete === true && turnId !== null
    };
  }

  // payload/web/database.js
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
        reject(request.error);
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
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Mod storage transaction cancelled."));
    });
  }
  var database = {
    list: () => operation("mods", "readonly", (store) => store.getAll()),
    save: (record) => operation("mods", "readwrite", (store) => store.put(record)),
    async remove(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["mods", "data"], "readwrite");
        transaction.objectStore("mods").delete(id);
        transaction.objectStore("data").delete(id);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    },
    getData: (id) => operation("data", "readonly", (store) => store.get(id)).then((value) => value ?? {}),
    setData: (id, value) => operation("data", "readwrite", (store) => store.put(value, id)),
    getSetting: (key) => operation("settings", "readonly", (store) => store.get(key)),
    setSetting: (key, value) => operation("settings", "readwrite", (store) => store.put(value, key))
  };

  // payload/web/runtime.js
  var ModRuntime = class {
    constructor(record, hooks, sandboxDocument) {
      this.record = record;
      this.hooks = hooks;
      this.stopped = false;
      this.pending = /* @__PURE__ */ new Map();
      this.subscriptions = /* @__PURE__ */ new Set();
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
      if (this.stopped || !message || typeof message !== "object") return;
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
          if (!Number.isSafeInteger(message.id) || !Array.isArray(message.args) || JSON.stringify(message.args).length > 1e5) throw new Error("Invalid host request.");
          const value = await this.handle(message.method, message.args);
          if (!this.stopped) this.port.postMessage({ type: "result", id: message.id, value });
        } catch (error) {
          if (!this.stopped) this.port.postMessage({ type: "result", id: message.id, error: error.message });
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
      const manifest = this.record.manifest;
      const require2 = (permission) => assertPermission(manifest, permission);
      switch (method) {
        case "events.subscribe": {
          const name = textValue(args[0], 40);
          const events = { "app.route": "app.route", "draft.change": "draft.read", "session.usage": "session.usage", "turn.complete": "session.usage" };
          if (!Object.hasOwn(events, name)) throw new Error("Unsupported event.");
          require2(events[name]);
          this.subscriptions.add(name);
          return;
        }
        case "commands.register":
          require2("ui.commands");
          this.hooks.command(this, { id: textValue(args[0]?.id, 64), title: textValue(args[0]?.title, 100) });
          return;
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
        case "session.usage":
          require2("session.usage");
          return this.hooks.usage();
        case "route.get":
          require2("app.route");
          return location.pathname;
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
          this.storageQueue = (this.storageQueue ?? Promise.resolve()).catch(() => {
          }).then(async () => {
            const value = await database.getData(manifest.id);
            const next = { ...value, [key]: args[1] };
            if (new TextEncoder().encode(JSON.stringify(next)).length > 65536) throw new Error("Mod storage is limited to 64 KB.");
            if (!this.stopped) await database.setData(manifest.id, next);
          });
          return this.storageQueue;
        }
        case "log":
          this.hooks.log(this, textValue(args[0], 1e3));
          return;
        default:
          throw new Error("Unknown mod API method.");
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
      this.hooks.fault(this, reason);
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

  // payload/web/adapter.js
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
  function dockAboveComposer(element) {
    let wanted = false;
    let frame;
    function place() {
      frame = void 0;
      const editor = wanted ? composer() : null;
      const anchor = editor ? editor.closest("[data-chat-composer-form]") ?? editor.closest("form") ?? editor : null;
      if (!anchor?.parentElement) {
        element.remove();
        return;
      }
      if (element.nextElementSibling !== anchor) anchor.before(element);
    }
    const observer = new MutationObserver(() => {
      if (wanted && !frame) frame = requestAnimationFrame(place);
    });
    observer.observe(document.body, { subtree: true, childList: true });
    return {
      show(value) {
        wanted = value;
        place();
      },
      dispose() {
        wanted = false;
        observer.disconnect();
        cancelAnimationFrame(frame);
        element.remove();
      }
    };
  }
  function attachSidebarButton(open2) {
    let button2;
    let frame;
    function attach() {
      frame = void 0;
      const footer = document.querySelector('[data-sidebar="footer"]') ?? document.querySelector('[data-slot="sidebar-footer"]');
      if (button2?.isConnected && (button2.dataset.fallback !== "true" || !footer)) return;
      if (button2?.isConnected && footer) button2.remove();
      button2 = document.createElement("button");
      button2.type = "button";
      button2.dataset.t3mods = "sidebar-button";
      button2.title = "Mods for T3 Code";
      const native = footer?.querySelector('[data-slot="sidebar-menu-button"]');
      button2.className = native?.className ?? "";
      button2.setAttribute("data-slot", "sidebar-menu-button");
      button2.setAttribute("aria-label", "Mods for T3 Code");
      button2.style.cssText = native ? "" : "display:flex;align-items:center;gap:8px;background:transparent;border:0;color:inherit;cursor:pointer;padding:8px;border-radius:6px;font:inherit;font-size:12px;min-height:32px";
      button2.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3h4v4a2 2 0 1 0 4 0V3h5v7h-4a2 2 0 1 0 0 4h4v7h-7v-4a2 2 0 1 0-4 0v4H3v-7h4a2 2 0 1 0 0-4H3V3h5Z"/></svg><span>Mods</span>';
      button2.onclick = open2;
      if (!footer) {
        button2.dataset.fallback = "true";
        button2.style.cssText += ";position:fixed;bottom:12px;left:12px;background:var(--background,#202027);z-index:999;border:1px solid var(--border,#444)";
        document.body.append(button2);
        return;
      }
      const menu = footer.querySelector('[data-sidebar="menu"]') ?? footer.querySelector('[data-slot="sidebar-menu"]');
      if (menu) {
        const item = document.createElement("li");
        item.setAttribute("data-slot", "sidebar-menu-item");
        item.style.cssText = "list-style:none;display:flex;align-items:center";
        item.append(button2);
        menu.append(item);
      } else footer.append(button2);
    }
    const observer = new MutationObserver(() => {
      if ((!button2?.isConnected || button2.dataset.fallback === "true") && !frame) frame = requestAnimationFrame(attach);
    });
    observer.observe(document.body, { subtree: true, childList: true });
    attach();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      const parent = button2?.parentElement;
      button2?.remove();
      if (parent?.tagName === "LI") parent.remove();
    };
  }

  // payload/web/author.js
  function authorPrompt(description, inbox) {
    return `Create a mod for Mods for T3 Code (API version 1).

What I want: ${description}

Use my existing T3 provider session. Produce a self-contained .t3mod JSON file.
Save it to ${inbox || "the current workspace"}/<id>.t3mod. Do not change T3 itself.
The host watches its inbox and will ask me to review the mod before it runs.

Bundle format:
{"format":"t3mod/1","manifest":{"apiVersion":1,"id":"lowercase-mod-id","version":"1.0.0","name":"Readable name","description":"What it does","author":"AI assisted","permissions":[]},"code":"globalThis.T3Mod = { async activate(api) { /* implementation */ } };"}

The code string is complete JavaScript, runs in an isolated browser worker, and must set globalThis.T3Mod.activate. No imports, DOM, Node, filesystem, network, credentials, tool approval, or model calls are available. Declare only the permissions you need:
- ui.panels: api.panels.set({title,body,actions:[{id,label}]}), api.panels.clear(), api.panels.action(id, async () => {}). One text panel per mod.
- ui.commands: await api.commands.register({id,title}, async () => {}). Commands run locally when I click them.
- ui.notify: await api.notify("message").
- ui.theme: await api.theme.set({background:"#17212f",foreground:"#edf2f8",...}); api.theme.clear(). Supported tokens: background/foreground, card/card-foreground, popover/popover-foreground, primary/primary-foreground, secondary/secondary-foreground, muted/muted-foreground, accent/accent-foreground, sidebar/sidebar-foreground, sidebar-primary/sidebar-primary-foreground, sidebar-accent/sidebar-accent-foreground, border,input,ring,sidebar-border,sidebar-ring. Always provide both tokens in a pair, including background and foreground. Only #RRGGBB colors; text pairs need 4.5:1 contrast. No arbitrary CSS. Turning the mod off restores the normal theme.
- ui.band: await api.band.set([{text:"\u2600 Clear",tone:"yellow"},{text:"  20%"}]); api.band.clear(). One line of plain text above the composer, 1\u201316 parts, up to 160 characters each and 300 in total. Tones: default, muted, yellow, cyan, blue, magenta, red. No HTML, markdown, or newlines.
- session.usage: await api.session.usage() returns {threadId,turnId,usedTokens,maxTokens,measuredAt,complete} for the open thread, or null. api.on("session.usage", snapshot => {}) fires on new measurements and on navigation (snapshot may be null). api.on("turn.complete", snapshot => {}) fires when a turn completes and can repeat for the same turnId with a later measurement, so replace rather than append. maxTokens can be null: show that the window is unknown and never assume a size. These are measurements only; no prompt or response text.
- app.route: await api.route.get(); api.on("app.route", path => {}).
- draft.read: await api.draft.read(); api.on("draft.change", text => {}). Drafts may contain sensitive text.
- draft.insert: await api.draft.insert("text"). This ALWAYS asks for my confirmation, pastes at the end, and never sends a prompt.
- storage: await api.storage.get("key"); await api.storage.set("key", JSONValue). 64 KB per mod.
- api.log("message") is always available.
activate may return a cleanup function. All actions should finish within 5 seconds. Timers are fine. Long loops cause quarantine. Never request permissions outside this list.

Write valid JSON with properly escaped code. Do not use markdown inside the file. After writing it, tell me what it does and which permissions to review. If saving to the inbox is unavailable, save in the workspace and tell me to use Import mod in the Mods manager.`;
  }

  // payload/web/style.js
  var style = `
:host{font-family:var(--font-sans,inherit);font-size:14px;color:var(--foreground,#e9e9ee);color-scheme:inherit;--mf-bg:var(--background,#202027);--mf-muted:var(--muted-foreground,#aaaab5);--mf-border:var(--border,#3a3a46);--mf-accent:var(--primary,#6574cd)}
*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--mf-accent);outline-offset:3px}
button{background:transparent;color:inherit;border:1px solid var(--mf-border);border-radius:6px;padding:7px 11px}button:hover{background:color-mix(in srgb,var(--mf-accent) 12%,transparent)}button.primary{background:var(--mf-accent);color:var(--primary-foreground,#fff);border-color:var(--mf-accent);font-weight:600}button.danger{color:var(--destructive,#cc5151)}button.link{border:0;padding:4px;color:var(--mf-muted)}
dialog{width:min(780px,calc(100vw - 40px));max-height:calc(100vh - 60px);margin:auto;padding:0;border:1px solid var(--mf-border);border-radius:calc(var(--radius,.625rem) + 2px);background:var(--mf-bg);color:inherit;box-shadow:0 20px 70px #0006}dialog::backdrop{background:#0008}
header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 26px;border-bottom:1px solid var(--mf-border)}header h1{font-size:19px;letter-spacing:-.4px;margin:0}header p{color:var(--mf-muted);font-size:12px;margin:5px 0 0}.header-actions{display:flex;gap:8px}.tabs{display:flex;gap:6px;padding:14px 26px 0}.tabs button{border:0;color:var(--mf-muted);padding:8px 12px}.tabs button[aria-selected=true]{background:color-mix(in srgb,var(--mf-accent) 16%,transparent);color:inherit}
.content{padding:22px 26px;min-height:270px;max-height:65vh;overflow:auto}.toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:22px}.toolbar p{margin:0;color:var(--mf-muted);font-size:12px}.row{display:flex;gap:18px;justify-content:space-between;padding:18px 0;border-top:1px solid var(--mf-border)}.row:first-child{border-top:0}.row h2{font-size:15px;margin:0 0 7px}.row p{font-size:13px;color:var(--mf-muted);line-height:1.5;max-width:440px;margin:0 0 7px}.meta{font-size:11px;color:var(--mf-muted)}.row-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.state{font-size:11px;border-radius:4px;padding:3px 6px;color:var(--mf-muted);background:#8881}.error{color:var(--destructive,#cc5151);font-size:12px;white-space:pre-wrap}.empty{padding:26px 0;max-width:470px}.empty h2{font-size:24px;letter-spacing:-.6px;margin:0 0 12px}.empty p,.explain{line-height:1.6;color:var(--mf-muted);font-size:13px}.empty .actions{display:flex;gap:10px;margin-top:22px}
.switch{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mf-muted)}input[type=checkbox]{accent-color:var(--mf-accent);width:16px;height:16px}textarea,input[type=text],input[type=search]{width:100%;background:transparent;color:inherit;border:1px solid var(--mf-border);border-radius:6px;padding:10px;margin:8px 0 14px}textarea{min-height:120px;resize:vertical}label{font-size:13px}.permission{padding:9px 0;border-top:1px solid var(--mf-border);font-size:13px}.permission code{font-size:11px;color:var(--mf-muted)}.review-code{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:190px;overflow:auto;border:1px solid var(--mf-border);padding:12px}.actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:20px}.log{font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.panel-tray{position:fixed;right:18px;bottom:18px;width:310px;max-height:60vh;overflow:auto;background:var(--mf-bg);border:1px solid var(--mf-border);border-radius:9px;box-shadow:0 8px 32px #0004;z-index:999}.panel-tray header{padding:10px 14px;font-size:12px}.panel{padding:14px;border-top:1px solid var(--mf-border)}.panel h2{font-size:14px;margin:0 0 8px}.panel p{white-space:pre-wrap;font-size:13px;line-height:1.5;color:var(--mf-muted);margin:0}.panel .actions{justify-content:flex-start;flex-wrap:wrap;margin-top:10px}.notice{position:fixed;right:20px;top:20px;background:var(--mf-bg);border:1px solid var(--mf-border);border-radius:7px;padding:14px;width:min(350px,90vw);z-index:1000;font-size:13px;box-shadow:0 8px 30px #0004}.notice strong{display:block;margin-bottom:5px;font-size:12px;color:var(--mf-muted)}.fallback{position:fixed;left:12px;bottom:12px;background:var(--mf-bg);z-index:999}.badge{color:var(--mf-accent)}
dialog[data-inline]{position:relative;inset:auto;width:100%;max-height:none;border:0;box-shadow:none;margin:0;border-radius:0;background:transparent}dialog[data-inline] .content{max-height:none}.decision-preview{white-space:pre-wrap;overflow-wrap:anywhere}.panel-tray[data-docked]{position:relative;inset:auto;width:100%;max-height:30vh;box-shadow:none;z-index:auto;margin-bottom:8px}@media(max-width:600px){header{padding:18px}.header-actions{gap:4px}.header-actions button{font-size:12px;padding:6px}.content{padding:18px}.tabs{padding-left:12px}.row{flex-direction:column;gap:10px}.row-actions{justify-content:flex-start}.panel-tray{width:280px}.toolbar{flex-wrap:wrap}.toolbar p{width:100%}}
.band-stack{width:calc(100% - 2 * var(--chat-composer-drawer-inset,1.375rem));margin:0 auto -1rem;padding:5px 14px calc(1rem + 5px);border:1px solid var(--chat-composer-attached-outline,var(--mf-border));border-bottom:0;border-radius:1rem 1rem 0 0;background:var(--chat-composer-attached-surface,var(--card,var(--mf-bg)));font-size:12px;line-height:1.6}.band{white-space:pre;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}.band [data-tone=muted]{color:var(--mf-muted)}.band [data-tone=yellow]{color:var(--color-yellow-500,#d4a72c)}.band [data-tone=cyan]{color:var(--color-cyan-500,#22a8bd)}.band [data-tone=blue]{color:var(--info,var(--color-blue-500,#3b82f6))}.band [data-tone=magenta]{color:var(--color-fuchsia-500,#c85bd8)}.band [data-tone=red]{color:var(--destructive,#e5534b)}
`;

  // payload/web/themes.js
  var THEME_TOKENS = ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring"];
  var pairs = [["background", "foreground"], ["card", "card-foreground"], ["popover", "popover-foreground"], ["primary", "primary-foreground"], ["secondary", "secondary-foreground"], ["muted", "muted-foreground"], ["accent", "accent-foreground"], ["sidebar", "sidebar-foreground"], ["sidebar-primary", "sidebar-primary-foreground"], ["sidebar-accent", "sidebar-accent-foreground"]];
  function luminance(hex) {
    const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }
  function validateTheme(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected theme color tokens.");
    const theme = {};
    for (const [token, color] of Object.entries(value)) {
      if (!THEME_TOKENS.includes(token) || typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Use a supported color token and an opaque #RRGGBB color: ${token}`);
      theme[token] = color;
    }
    if (!theme.background || !theme.foreground) throw new Error("A theme must provide background and foreground.");
    for (const [background, foreground] of pairs) {
      if (!theme[background] && !theme[foreground]) continue;
      if (!theme[background] || !theme[foreground]) throw new Error(`Provide ${background} and ${foreground} together.`);
      const a = luminance(theme[background]);
      const b = luminance(theme[foreground]);
      if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 4.5) throw new Error(`The ${background}/${foreground} pair needs readable contrast (4.5:1).`);
    }
    return theme;
  }
  var ThemeHost = class {
    constructor() {
      this.themes = /* @__PURE__ */ new Map();
      this.original = /* @__PURE__ */ new Map();
    }
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
      for (const [key, saved] of this.original) {
        if (style2.getPropertyValue(key) === saved.applied) {
          if (saved.value) style2.setProperty(key, saved.value, saved.priority);
          else style2.removeProperty(key);
        }
      }
      this.original.clear();
      const active = [...this.themes.values()].at(-1);
      if (!active) return;
      for (const [token, color] of Object.entries(active)) {
        const key = `--${token}`;
        this.original.set(key, { value: style2.getPropertyValue(key), priority: style2.getPropertyPriority(key), applied: color });
        style2.setProperty(key, color);
      }
    }
  };

  // payload/web/host.js
  function node(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "class") element.className = value;
      else if (key === "text") element.textContent = value;
      else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
      else if (key in element) element[key] = value;
      else element.setAttribute(key, value);
    }
    element.append(...children);
    return element;
  }
  var button = (text, onclick, className = "") => node("button", { text, onclick, class: className, type: "button" });
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
    const bandRoot = node("div", { "data-t3mods": "bands", style: "display:block;width:100%;max-width:var(--chat-content-max-width,none);margin-inline:auto" });
    const bandShadow = bandRoot.attachShadow({ mode: "open" });
    const bandStack = node("div", { class: "band-stack" });
    bandShadow.append(node("style", { text: style }), bandStack);
    const bandDock = dockAboveComposer(bandRoot);
    let records = [];
    const runtimes = /* @__PURE__ */ new Map();
    const commands = /* @__PURE__ */ new Map();
    const panels = /* @__PURE__ */ new Map();
    const bands = /* @__PURE__ */ new Map();
    const themes = new ThemeHost();
    const logs = [];
    const notices = [];
    let paused = Boolean(await database.getSetting("paused"));
    let development = Boolean(await database.getSetting("development"));
    let seenInbox = await database.getSetting("seenInbox") ?? {};
    let tab = "installed";
    let candidate;
    const candidates = [];
    let busy = false;
    let trayOpen = true;
    let lastPath = location.pathname;
    let draftTimer;
    let disposed = false;
    let channel;
    let detailsOnly = false;
    let inlineContent;
    let inlineDisplay;
    let decisionQueue = Promise.resolve();
    let telemetry;
    let unsubscribeTelemetry;
    function ask(title, description, action, destructive = false) {
      const result = decisionQueue.then(() => new Promise((resolve) => {
        const prompt = node("dialog", { "aria-label": title }, [node("header", {}, [node("h1", { text: title })]), node("div", { class: "content" }, [node("p", { class: "explain decision-preview", text: description }), node("div", { class: "actions" }, [button("Cancel", () => finish(false)), button(action, () => finish(true), destructive ? "danger" : "primary")])])]);
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
    async function remember(bundle) {
      if (!bundle?.inboxHash) return;
      seenInbox[bundle.inboxHash] = Date.now();
      seenInbox = Object.fromEntries(Object.entries(seenInbox).sort((a, b) => b[1] - a[1]).slice(0, 200));
      await database.setSetting("seenInbox", seenInbox);
    }
    function leaveInline() {
      if (!inlineContent) return;
      inlineContent.style.display = inlineDisplay;
      inlineContent = void 0;
      root.removeAttribute("data-inline");
      dialog.removeAttribute("data-inline");
      dialog.close();
      document.body.append(root);
      settingsItem?.querySelector("button")?.removeAttribute("aria-current");
      settingsItem?.querySelector("button")?.removeAttribute("data-active");
    }
    function notify(name, text) {
      const notice = node("div", { class: "notice", role: "status" }, [node("strong", { text: name }), node("span", { text })]);
      for (const old of notices.splice(0)) old.remove();
      notices.push(notice);
      shadow.append(notice);
      setTimeout(() => {
        notice.remove();
        const index = notices.indexOf(notice);
        if (index >= 0) notices.splice(index, 1);
      }, 6e3);
    }
    function log(name, text) {
      logs.push(`${(/* @__PURE__ */ new Date()).toLocaleTimeString()}  ${name}: ${text}`);
      if (logs.length > 100) logs.shift();
      if (dialog.open && tab === "console") render();
    }
    function renderTray() {
      tray.hidden = panels.size === 0;
      tray.replaceChildren(node("header", {}, [node("span", { text: "Mod panels" }), button(trayOpen ? "Collapse" : "Expand", () => {
        trayOpen = !trayOpen;
        renderTray();
      }, "link")]));
      if (!trayOpen) return;
      for (const [id, panel] of panels) {
        const runtime = runtimes.get(id);
        if (!runtime) continue;
        tray.append(node("section", { class: "panel" }, [node("div", { class: "meta", text: runtime.record.manifest.name }), node("h2", { text: panel.title }), node("p", { text: panel.body }), node("div", { class: "actions" }, panel.actions.map((action) => button(action.label, () => runtime.invoke("action", action.id))))]));
      }
    }
    function renderBands() {
      const rows = [];
      for (const [id, parts] of bands) {
        const runtime = runtimes.get(id);
        if (!runtime || rows.length >= 4) continue;
        const name = runtime.record.manifest.name;
        rows.push(node("div", { class: "band", title: name, "aria-label": `${name}: ${parts.map((part) => part.text).join("")}`, "data-mod": id }, parts.map((part) => node("span", { "data-tone": part.tone, text: part.text }))));
      }
      bandStack.replaceChildren(...rows);
      bandDock.show(rows.length > 0);
    }
    function currentUsage() {
      try {
        return usageSnapshot(telemetry?.get(location.pathname));
      } catch {
        return null;
      }
    }
    function connectTelemetry() {
      if (telemetry || disposed || typeof window.__T3_MODS_TELEMETRY__?.subscribe !== "function") return;
      telemetry = window.__T3_MODS_TELEMETRY__;
      try {
        unsubscribeTelemetry = telemetry.subscribe((event) => {
          if (event?.name !== "session.usage" && event?.name !== "turn.complete") return;
          const value = usageSnapshot(event.value);
          if (!value || currentUsage()?.threadId !== value.threadId) return;
          for (const runtime of runtimes.values()) runtime.emit(event.name, value);
        });
      } catch {
        telemetry = void 0;
      }
    }
    function refresh() {
      if (dialog.open && !candidate && !busy && tab === "installed") render();
      renderTray();
    }
    function start(record) {
      if (paused || options.safeMode || !record.enabled || record.quarantined || runtimes.has(record.manifest.id)) return;
      const runtime = new ModRuntime(record, {
        ready: () => {
          log(record.manifest.name, "Loaded");
          refresh();
        },
        command: (_, command) => {
          const entries = commands.get(record.manifest.id) ?? /* @__PURE__ */ new Map();
          if (entries.size >= 20 && !entries.has(command.id)) throw new Error("A mod can register up to 20 commands.");
          entries.set(command.id, command);
          commands.set(record.manifest.id, entries);
        },
        panel: (_, panel) => {
          if (panel) panels.set(record.manifest.id, panel);
          else panels.delete(record.manifest.id);
          renderTray();
        },
        notify: (_, text) => notify(record.manifest.name, text),
        theme: (_, colors) => {
          if (colors) themes.set(record.manifest.id, colors);
          else themes.clear(record.manifest.id);
        },
        band: (_, parts) => {
          if (parts) bands.set(record.manifest.id, parts);
          else bands.delete(record.manifest.id);
          renderBands();
        },
        usage: currentUsage,
        readDraft,
        insertDraft: async (runtime2, text) => {
          if (!await ask(`${record.manifest.name} wants to add to your draft`, `This text will be pasted at the end. Nothing will be sent.

${text}`, "Add to draft") || runtime2.stopped) return false;
          insertDraft(text);
          return true;
        },
        log: (_, text) => log(record.manifest.name, text),
        removed: () => {
          runtimes.delete(record.manifest.id);
          commands.delete(record.manifest.id);
          panels.delete(record.manifest.id);
          bands.delete(record.manifest.id);
          themes.clear(record.manifest.id);
          renderBands();
          refresh();
        },
        fault: async (_, reason) => {
          record.enabled = false;
          record.quarantined = reason;
          await database.save(record);
          broadcast();
          log(record.manifest.name, reason);
          notify(record.manifest.name, reason);
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
      paused = Boolean(await database.getSetting("paused"));
      for (const [id, runtime] of runtimes) {
        const record = records.find((item) => item.manifest.id === id);
        if (paused || !record?.enabled || record.quarantined || record.code !== runtime.record.code || JSON.stringify(record.manifest) !== JSON.stringify(runtime.record.manifest)) stop(id);
      }
      for (const record of records) start(record);
      refresh();
    }
    function open2(nextTab = "installed") {
      leaveInline();
      tab = nextTab;
      candidate = void 0;
      detailsOnly = false;
      render();
      if (!dialog.open) dialog.showModal();
    }
    function openSettings() {
      const inset = document.querySelector('[data-slot="sidebar-inset"]');
      const content = inset?.firstElementChild?.lastElementChild;
      if (!content || content.tagName === "HEADER") {
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
      tab = "installed";
      candidate = void 0;
      detailsOnly = false;
      render();
      dialog.open = true;
      settingsItem?.querySelector("button")?.setAttribute("aria-current", "page");
      settingsItem?.querySelector("button")?.setAttribute("data-active", "true");
    }
    async function run(action) {
      if (busy) return;
      busy = true;
      dialog.setAttribute("aria-busy", "true");
      for (const control of dialog.querySelectorAll("button, input")) control.disabled = true;
      try {
        await action();
      } catch (error) {
        notify("Mods for T3 Code", error.message);
        log("Host", error.message);
      } finally {
        busy = false;
        dialog.removeAttribute("aria-busy");
        render();
      }
    }
    async function importCandidate(value, source = {}) {
      try {
        const bundle = validateBundle(value);
        const installed = records.find((record) => record.manifest.id === bundle.manifest.id);
        if (installed && installed.code === bundle.code && JSON.stringify(installed.manifest) === JSON.stringify(bundle.manifest)) return;
        if (source.inbox) {
          const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(bundle)));
          bundle.inboxHash = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
          if (seenInbox[bundle.inboxHash]) return;
          if (development && installed?.enabled && installed.manifest.author === bundle.manifest.author && bundle.manifest.permissions.every((permission) => installed.manifest.permissions.includes(permission))) {
            stop(installed.manifest.id);
            const record = { ...bundle, enabled: true, quarantined: null };
            delete record.inboxHash;
            await database.save(record);
            await remember(bundle);
            records = await database.list();
            start(record);
            broadcast();
            notify(record.manifest.name, "Development update loaded live.");
            return;
          }
        }
        if (candidate) {
          if (candidates.length < 20 && !candidates.some((item) => item.manifest.id === bundle.manifest.id && item.code === bundle.code)) candidates.push(bundle);
          notify("Mod inbox", `${bundle.manifest.name} is waiting for review.`);
          return;
        }
        leaveInline();
        detailsOnly = false;
        candidate = bundle;
        tab = "installed";
        render();
        if (!dialog.open) dialog.showModal();
      } catch (error) {
        notify("Cannot import mod", error.message);
      }
    }
    function pickFile() {
      const input = node("input", { type: "file", accept: ".t3mod,application/json" });
      input.onchange = () => void run(async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > MAX_BUNDLE_BYTES) throw new Error("Mod bundles must be smaller than 1 MB.");
        await importCandidate(JSON.parse(await file.text()));
      });
      input.click();
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
    function render() {
      dialog.replaceChildren(node("header", {}, [node("div", {}, [node("h1", { text: inlineContent ? "Mods" : "Mods for T3 Code" }), node("p", { text: "Your app, with a few personal touches." })]), node("div", { class: "header-actions" }, [button("Import mod", pickFile), button("Create a mod", () => {
        tab = "create";
        candidate = void 0;
        render();
      }, "primary"), button("Close", () => {
        if (inlineContent) leaveInline();
        else dialog.close();
      }, "link")])]));
      if (candidate) {
        renderReview();
        return;
      }
      dialog.append(node("nav", { class: "tabs", "aria-label": "Mod manager" }, [["installed", "Installed"], ["examples", "Built-in"], ["commands", "Commands"], ["create", "Create"], ["console", "Activity"]].map(([key, text]) => {
        const item = button(text, () => {
          tab = key;
          render();
        });
        item.setAttribute("aria-selected", String(tab === key));
        return item;
      })));
      const content = node("div", { class: "content" });
      dialog.append(content);
      if (tab === "installed") {
        const pause = node("input", { type: "checkbox", checked: paused, disabled: options.safeMode || busy });
        pause.onchange = () => void run(async () => {
          paused = pause.checked;
          if (paused) for (const id of [...runtimes.keys()]) stop(id);
          await database.setSetting("paused", paused);
          broadcast();
          await reload();
        });
        content.append(node("div", { class: "toolbar" }, [node("p", { text: options.safeMode ? "Safe mode: all mod code is off." : `${records.length} installed \xB7 ${runtimes.size} active` }), node("label", { class: "switch" }, [pause, document.createTextNode("Pause all mods")])]));
        const dev = node("input", { type: "checkbox", checked: development, "aria-label": "Development mode" });
        dev.onchange = () => void run(async () => {
          development = dev.checked;
          await database.setSetting("development", development);
        });
        content.append(node("label", { class: "switch" }, [dev, document.createTextNode("Development mode: hot reload enabled inbox mods with existing permissions")]), node("p", { class: "explain", text: "New permissions always need review. Pause all mods is the immediate recovery switch." }));
        if (!records.length) content.append(node("div", { class: "empty" }, [node("h2", { text: "Make T3 feel like yours." }), node("p", { text: "Add a focus timer, save your favorite prompts, or ask your AI to build something new. Mods can be installed and switched off while T3 stays open." }), node("div", { class: "actions" }, [button("Import a .t3mod file", pickFile), button("Create with my AI", () => open2("create"), "primary")])]));
        for (const record of records) {
          const { manifest } = record;
          const toggle = node("input", { type: "checkbox", checked: record.enabled, disabled: options.safeMode || busy, "aria-label": `Enable ${manifest.name}` });
          toggle.onchange = () => void run(async () => {
            stop(manifest.id);
            record.enabled = toggle.checked;
            record.quarantined = null;
            await database.save(record);
            start(record);
            broadcast();
          });
          content.append(node("article", { class: "row" }, [node("div", {}, [node("h2", { text: manifest.name }), node("p", { text: manifest.description }), node("div", { class: "meta", text: `${manifest.version} \xB7 ${manifest.author} \xB7 ${manifest.permissions.length} permissions` }), ...record.quarantined ? [node("p", { class: "error", text: `Stopped: ${record.quarantined}. Enable to retry.` })] : []]), node("div", { class: "row-actions" }, [node("span", { class: "state", text: paused ? "Paused" : runtimes.has(manifest.id) ? "Active" : "Off" }), toggle, button("Details", () => {
            candidate = validateBundle(record);
            detailsOnly = true;
            render();
          }), button("Export", () => download(record)), button("Remove", () => void run(async () => {
            if (!await ask(`Remove ${manifest.name}?`, "The mod and its private data will be removed. Export it first if you want a copy.", "Remove mod", true)) return;
            stop(manifest.id);
            await database.remove(manifest.id);
            records = records.filter((item) => item !== record);
            broadcast();
          }), "danger")])]));
        }
      } else if (tab === "examples") {
        content.append(node("p", { class: "explain", text: "Included with the app patch. Review and install a mod, then switch it on. Themes change T3\u2019s own color tokens and restore your appearance when disabled." }));
        for (const bundle of options.examples ?? []) content.append(node("article", { class: "row" }, [node("div", {}, [node("h2", { text: bundle.manifest.name }), node("p", { text: bundle.manifest.description })]), button("Review mod", () => {
          detailsOnly = false;
          candidate = validateBundle(bundle);
          render();
        })]));
      } else if (tab === "commands") {
        let show = function() {
          list.replaceChildren();
          for (const [id, entries] of commands) for (const command of entries.values()) {
            const runtime = runtimes.get(id);
            if (!runtime || !command.title.toLowerCase().includes(search.value.toLowerCase())) continue;
            list.append(node("div", { class: "row" }, [node("div", {}, [node("h2", { text: command.title }), node("span", { class: "meta", text: runtime.record.manifest.name })]), button("Run", () => {
              dialog.close();
              runtime.invoke("command", command.id);
            })]));
          }
          if (!list.childNodes.length) list.append(node("p", { class: "explain", text: "Enable a mod that registers commands to see them here." }));
        };
        const search = node("input", { type: "search", placeholder: "Find a local mod command\u2026", "aria-label": "Find command" });
        const list = node("div");
        content.append(search, list);
        search.oninput = show;
        show();
      } else if (tab === "create") {
        const description = node("textarea", { placeholder: "A focus timer with a start button and a reminder after 25 minutes\u2026", "aria-label": "Describe your mod", maxLength: 5e3 });
        content.append(node("h2", { text: "Build a mod with your AI" }), node("p", { class: "explain", text: "Describe what you want. We\u2019ll put a request with the mod API in your T3 composer. Choose your usual model and send it using the account you already have." }), node("label", { text: "What should your mod do?" }), description, node("p", { class: "explain", text: "When your AI saves the file, review its permissions here before enabling it. Open a chat thread first. Your existing draft will be kept." }), node("div", { class: "actions" }, [button("Copy request", () => void run(async () => {
          if (!description.value.trim()) throw new Error("Describe your mod first.");
          await navigator.clipboard.writeText(authorPrompt(description.value, options.inbox));
          notify("Create a mod", "Request copied. Paste it into your T3 chat.");
        })), button("Draft in T3", () => void run(async () => {
          if (!description.value.trim()) throw new Error("Describe your mod first.");
          const text = authorPrompt(description.value, options.inbox);
          dialog.close();
          insertDraft((readDraft() ? "\n\n" : "") + text);
        }), "primary")]));
      } else {
        content.append(node("p", { class: "explain", text: "Recent mod messages and failures. This log stays in this window." }), button("Clear activity", () => {
          logs.length = 0;
          render();
        }), node("pre", { class: "log", text: logs.join("\n") || "No mod activity yet." }));
      }
    }
    function renderReview() {
      const { manifest } = candidate;
      const previous = records.find((record) => record.manifest.id === manifest.id);
      const content = node("div", { class: "content" }, [node("h2", { text: detailsOnly ? manifest.name : previous ? `Review update: ${manifest.name}` : `Review ${manifest.name}` }), node("p", { class: "explain", text: manifest.description }), node("div", { class: "meta", text: `${manifest.version} \xB7 ${manifest.author}` }), node("p", { class: "explain", text: "This mod asks to:" })]);
      for (const permission of manifest.permissions) content.append(node("div", { class: "permission" }, [node("div", { text: PERMISSIONS[permission] }), node("code", { text: `${permission}${previous && !previous.manifest.permissions.includes(permission) ? " \u2014 new permission" : ""}` })]));
      if (!manifest.permissions.length) content.append(node("p", { class: "explain", text: "No optional permissions." }));
      if (detailsOnly) {
        content.append(node("details", {}, [node("summary", { text: "JavaScript source" }), node("pre", { class: "review-code", text: candidate.code })]), button("Close details", () => {
          candidate = void 0;
          detailsOnly = false;
          render();
        }));
        dialog.append(content);
        return;
      }
      content.append(node("p", { class: "explain", text: "Install code from authors you trust. Mod code is isolated from T3\u2019s files and credentials, but a mod can consume browser resources and use every permission listed above." }), node("details", {}, [node("summary", { text: "Review JavaScript source" }), node("pre", { class: "review-code", text: candidate.code })]), node("div", { class: "actions" }, [button("Cancel", () => void run(async () => {
        await remember(candidate);
        candidate = candidates.shift();
      })), button(previous ? "Update mod" : "Install mod", () => void run(async () => {
        const bundle = candidate;
        stop(manifest.id);
        const record = { ...bundle, enabled: false, quarantined: null };
        delete record.inboxHash;
        await database.save(record);
        await remember(bundle);
        records = await database.list();
        candidate = candidates.shift();
        broadcast();
        notify(manifest.name, "Installed. Switch it on when you\u2019re ready.");
      }), "primary")]));
      dialog.append(content);
    }
    function onInput(event) {
      if (!event.target?.closest?.('[data-testid="composer-editor"]')) return;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        for (const runtime of runtimes.values()) runtime.emit("draft.change", readDraft());
      }, 150);
    }
    const detachSidebar = attachSidebarButton(() => open2());
    let settingsItem;
    function attachSettings() {
      if (!location.pathname.startsWith("/settings") || settingsItem?.isConnected) return;
      const sidebar = document.querySelector('[data-sidebar="content"] [data-sidebar="menu"]');
      if (!sidebar) return;
      const item = node("li", { "data-t3mods": "settings-section", "data-slot": "sidebar-menu-item", style: "list-style:none" });
      const control = button("Mods", openSettings);
      const sibling = sidebar.querySelector('[data-slot="sidebar-menu-button"]');
      control.className = sibling?.className ?? "";
      control.setAttribute("data-slot", "sidebar-menu-button");
      control.style.cssText = sibling ? "" : "width:100%;text-align:left;padding:8px 10px;background:none;border:0;color:inherit;font:inherit;font-size:13px;cursor:pointer;border-radius:6px";
      control.setAttribute("aria-label", "Mods settings");
      item.append(control);
      sidebar.append(item);
      settingsItem = item;
    }
    function attachPanels() {
      const footer = document.querySelector('[data-sidebar="footer"]') ?? document.querySelector('[data-slot="sidebar-footer"]');
      if (!footer) return;
      if (panelRoot.parentElement !== footer) footer.prepend(panelRoot);
      if (tray.parentNode !== panelShadow) {
        tray.setAttribute("data-docked", "true");
        panelShadow.append(tray);
      }
    }
    const observer = new MutationObserver(() => {
      attachSettings();
      attachPanels();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    attachSettings();
    attachPanels();
    document.addEventListener("input", onInput, true);
    const onRoute = () => {
      if (lastPath !== location.pathname) {
        lastPath = location.pathname;
        leaveInline();
        if (settingsItem) {
          settingsItem.remove();
          settingsItem = void 0;
        }
        attachSettings();
        connectTelemetry();
        const usage = currentUsage();
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
        const result = Reflect.apply(original, this, args);
        queueMicrotask(onRoute);
        return result;
      };
      historyMethods.set(key, { original, wrapped });
      history[key] = wrapped;
    }
    window.addEventListener("popstate", onRoute);
    const onKeys = (event) => {
      if (event.key !== "Escape" || !shadow.querySelector("dialog[open]")) return;
      event.stopPropagation();
      if (dialog.open && shadow.querySelectorAll("dialog[open]").length === 1) {
        event.preventDefault();
        if (inlineContent) leaveInline();
        else dialog.close();
      }
    };
    document.addEventListener("keydown", onKeys, true);
    try {
      channel = new BroadcastChannel("mods-for-t3-code");
      channel.onmessage = () => void reload();
    } catch {
    }
    window.__modsForT3Code = { open: open2, importCandidate, async dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...runtimes.keys()]) stop(id);
      leaveInline();
      detachSidebar();
      observer.disconnect();
      panelRoot.remove();
      bandDock.dispose();
      try {
        unsubscribeTelemetry?.();
      } catch {
      }
      settingsItem?.remove();
      clearTimeout(draftTimer);
      channel?.close();
      window.removeEventListener("popstate", onRoute);
      for (const [key, { original, wrapped }] of historyMethods) if (history[key] === wrapped) history[key] = original;
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keydown", onKeys, true);
      root.remove();
      delete window.__modsForT3Code;
    } };
    connectTelemetry();
    await reload();
    log("Host", options.safeMode ? "Safe mode enabled" : "Ready");
  }

  // renderer-entry.js
  if (!window.__modsForT3Installing && !window.__modsForT3Code) {
    window.__modsForT3Installing = true;
    mount({ examples: [{ "format": "t3mod/1", "manifest": { "apiVersion": 1, "id": "focus-timer", "version": "1.0.0", "name": "Focus timer", "description": "A small timer in the Mods tray. Start a 25 minute session and get a reminder when it ends.", "author": "Mods for T3 Code", "permissions": ["ui.panels", "ui.commands", "ui.notify"] }, "code": 'var T3Mod = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n\n  // examples/focus-timer/mod.js\n  var mod_exports = {};\n  __export(mod_exports, {\n    activate: () => activate\n  });\n  async function activate(api) {\n    let remaining = 25 * 60;\n    let running = false;\n    async function draw() {\n      const minutes = Math.floor(remaining / 60);\n      const seconds = String(remaining % 60).padStart(2, "0");\n      await api.panels.set({ title: `${minutes}:${seconds}`, body: running ? "One task at a time. Your focus session is running." : "Ready for a little focused work?", actions: [{ id: "toggle", label: running ? "Pause" : "Start" }, { id: "reset", label: "Reset" }] });\n    }\n    api.panels.action("toggle", async () => {\n      running = !running;\n      await draw();\n    });\n    api.panels.action("reset", async () => {\n      remaining = 25 * 60;\n      running = false;\n      await draw();\n    });\n    await api.commands.register({ id: "start", title: "Start a 25 minute focus session" }, async () => {\n      remaining = 25 * 60;\n      running = true;\n      await draw();\n    });\n    const interval = setInterval(async () => {\n      if (!running) return;\n      remaining--;\n      if (remaining <= 0) {\n        running = false;\n        await api.notify("Focus session finished. Take a short break.");\n      }\n      await draw();\n    }, 1e3);\n    await draw();\n    return () => clearInterval(interval);\n  }\n  return __toCommonJS(mod_exports);\n})();\n\nglobalThis.T3Mod = T3Mod;\n' }, { "format": "t3mod/1", "manifest": { "apiVersion": 1, "id": "prompt-kit", "version": "1.0.0", "name": "Prompt kit", "description": "Local commands that offer useful review and debugging prompts for your current T3 draft. Every insertion asks first.", "author": "Mods for T3 Code", "permissions": ["ui.commands", "draft.insert"] }, "code": 'var T3Mod = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n\n  // examples/prompt-kit/mod.js\n  var mod_exports = {};\n  __export(mod_exports, {\n    activate: () => activate\n  });\n  async function activate(api) {\n    await api.commands.register({ id: "review", title: "Draft a focused code review" }, () => api.draft.insert("Review the changes in this thread. Focus on correctness and the behavior requested. Explain any concrete issues and the smallest fix."));\n    await api.commands.register({ id: "debug", title: "Draft a debugging request" }, () => api.draft.insert("Investigate this failure. Find the smallest reproducible cause, explain it, and make a focused fix. Run only the checks needed to confirm the fix."));\n  }\n  return __toCommonJS(mod_exports);\n})();\n\nglobalThis.T3Mod = T3Mod;\n' }, { "format": "t3mod/1", "manifest": { "apiVersion": 1, "id": "token-weather", "version": "1.0.0", "name": "Token weather", "description": "A one-line forecast above the composer: measured context use for the open thread, a sparkline of recent completed turns, and the last turn\u2019s change.", "author": "Mods for T3 Code", "permissions": ["ui.band", "session.usage", "storage"] }, "code": 'var T3Mod = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n\n  // examples/token-weather/mod.js\n  var mod_exports = {};\n  __export(mod_exports, {\n    activate: () => activate,\n    formatTokens: () => formatTokens,\n    line: () => line,\n    weather: () => weather\n  });\n  var WEATHER = [\n    { below: 25, icon: "\\u2600", label: "Clear", tone: "yellow" },\n    { below: 50, icon: "\\u2601", label: "Cloudy", tone: "cyan" },\n    { below: 75, icon: "\\u2602", label: "Showers", tone: "blue" },\n    { below: 90, icon: "\\u2607", label: "Storm", tone: "magenta" },\n    { below: Infinity, icon: "\\u21AF", label: "Compact soon", tone: "red" }\n  ];\n  var BARS = "\\u2581\\u2582\\u2583\\u2584\\u2585\\u2586\\u2587\\u2588";\n  var MAX_TURNS = 12;\n  var MAX_THREADS = 40;\n  function formatTokens(value) {\n    if (value < 1e3) return String(value);\n    if (value < 999950) return `${(value / 1e3).toFixed(1).replace(/\\.0$/, "")}k`;\n    return `${(value / 1e6).toFixed(2).replace(/\\.?0+$/, "")}M`;\n  }\n  function weather(percent) {\n    return WEATHER.find((item) => percent < item.below);\n  }\n  function turnKey(turnId) {\n    let hash = 2166136261;\n    for (let index = 0; index < turnId.length; index++) hash = Math.imul(hash ^ turnId.charCodeAt(index), 16777619);\n    return (hash >>> 0).toString(36);\n  }\n  function line(snapshot, turns) {\n    if (!snapshot) return [{ text: "\\u25CC Context usage unavailable for this view", tone: "muted" }];\n    const parts = [];\n    let tone = "muted";\n    if (snapshot.maxTokens) {\n      const percent = Math.floor(snapshot.usedTokens / snapshot.maxTokens * 100);\n      const forecast = weather(percent);\n      tone = forecast.tone;\n      parts.push({ text: `${forecast.icon} ${forecast.label}`, tone }, { text: `  ${percent}%` }, { text: `  ${formatTokens(snapshot.usedTokens)} / ${formatTokens(snapshot.maxTokens)}`, tone: "muted" });\n    } else {\n      parts.push({ text: "\\u25CC Window unknown", tone: "muted" }, { text: `  ${formatTokens(snapshot.usedTokens)} used \\xB7 window size unavailable`, tone: "muted" });\n    }\n    if (turns.length) {\n      const scale = snapshot.maxTokens ?? Math.max(...turns, 1);\n      parts.push({ text: `  ${turns.map((used) => BARS[Math.min(7, Math.round(used / scale * 7))]).join("")}`, tone });\n    }\n    if (turns.length === 1) parts.push({ text: "  \\u0394 unknown (first turn)", tone: "muted" });\n    else if (turns.length > 1) {\n      const delta = turns.at(-1) - turns.at(-2);\n      parts.push(delta >= 0 ? { text: `  \\u25B2 +${formatTokens(delta)} last turn` } : { text: `  \\u25BC \\u2212${formatTokens(-delta)} last turn`, tone: "cyan" });\n    }\n    return parts;\n  }\n  async function activate(api) {\n    const threads = /* @__PURE__ */ new Map();\n    const saved = await api.storage.get("history");\n    if (saved?.version === 1 && Array.isArray(saved.threads)) {\n      for (const item of saved.threads.slice(-MAX_THREADS)) {\n        if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;\n        const turns = item[1].filter((turn) => Array.isArray(turn) && typeof turn[0] === "string" && Number.isSafeInteger(turn[1]) && turn[1] >= 0).slice(-MAX_TURNS);\n        threads.set(item[0], turns);\n      }\n    }\n    let current = await api.session.usage();\n    let shown = "";\n    function record(snapshot) {\n      if (!snapshot?.complete || !snapshot.turnId) return;\n      const turns = threads.get(snapshot.threadId) ?? [];\n      const key = turnKey(snapshot.turnId);\n      const existing = turns.find((turn) => turn[0] === key);\n      if (existing) {\n        if (existing[1] === snapshot.usedTokens) return;\n        existing[1] = snapshot.usedTokens;\n      } else turns.push([key, snapshot.usedTokens]);\n      threads.delete(snapshot.threadId);\n      threads.set(snapshot.threadId, turns.slice(-MAX_TURNS));\n      while (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value);\n      void api.storage.set("history", { version: 1, threads: [...threads] });\n    }\n    async function draw() {\n      const parts = line(current, current ? (threads.get(current.threadId) ?? []).map((turn) => turn[1]) : []);\n      const text = JSON.stringify(parts);\n      if (text === shown) return;\n      shown = text;\n      await api.band.set(parts);\n    }\n    async function update(snapshot) {\n      current = snapshot;\n      record(snapshot);\n      await draw();\n    }\n    api.on("session.usage", update);\n    api.on("turn.complete", update);\n    record(current);\n    await draw();\n  }\n  return __toCommonJS(mod_exports);\n})();\n\nglobalThis.T3Mod = T3Mod;\n' }, { "format": "t3mod/1", "manifest": { "apiVersion": 1, "id": "midnight-theme", "version": "1.0.0", "name": "Midnight blue", "description": "A calm dark palette using T3\u2019s native theme tokens. Turning it off restores your normal appearance.", "author": "Mods for T3 Code", "permissions": ["ui.theme"] }, "code": 'var T3Mod = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n\n  // examples/midnight-theme/mod.js\n  var mod_exports = {};\n  __export(mod_exports, {\n    activate: () => activate\n  });\n  async function activate(api) {\n    await api.theme.set({\n      background: "#17212f",\n      foreground: "#edf2f8",\n      card: "#1d2939",\n      "card-foreground": "#edf2f8",\n      popover: "#253348",\n      "popover-foreground": "#edf2f8",\n      primary: "#8db9ef",\n      "primary-foreground": "#152033",\n      secondary: "#263750",\n      "secondary-foreground": "#edf2f8",\n      muted: "#243247",\n      "muted-foreground": "#b8c5d8",\n      accent: "#304562",\n      "accent-foreground": "#edf2f8",\n      border: "#3e526d",\n      input: "#435872",\n      ring: "#8db9ef",\n      sidebar: "#131d2b",\n      "sidebar-foreground": "#edf2f8",\n      "sidebar-accent": "#304562",\n      "sidebar-accent-foreground": "#edf2f8",\n      "sidebar-border": "#3e526d",\n      "sidebar-ring": "#8db9ef"\n    });\n  }\n  return __toCommonJS(mod_exports);\n})();\n\nglobalThis.T3Mod = T3Mod;\n' }, { "format": "t3mod/1", "manifest": { "apiVersion": 1, "id": "paper-theme", "version": "1.0.0", "name": "Quiet paper", "description": "A soft light palette with blue controls. Uses T3\u2019s own tokens and restores the original theme when disabled.", "author": "Mods for T3 Code", "permissions": ["ui.theme"] }, "code": 'var T3Mod = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n\n  // examples/paper-theme/mod.js\n  var mod_exports = {};\n  __export(mod_exports, {\n    activate: () => activate\n  });\n  async function activate(api) {\n    await api.theme.set({\n      background: "#f5f6f8",\n      foreground: "#253044",\n      card: "#ffffff",\n      "card-foreground": "#253044",\n      popover: "#ffffff",\n      "popover-foreground": "#253044",\n      primary: "#284f88",\n      "primary-foreground": "#ffffff",\n      secondary: "#e7ecf3",\n      "secondary-foreground": "#253044",\n      muted: "#edf0f4",\n      "muted-foreground": "#536176",\n      accent: "#dce5f2",\n      "accent-foreground": "#253044",\n      border: "#c8d2df",\n      input: "#becbdb",\n      ring: "#284f88",\n      sidebar: "#e7ecf3",\n      "sidebar-foreground": "#253044",\n      "sidebar-accent": "#dce5f2",\n      "sidebar-accent-foreground": "#253044",\n      "sidebar-border": "#c8d2df",\n      "sidebar-ring": "#284f88"\n    });\n  }\n  return __toCommonJS(mod_exports);\n})();\n\nglobalThis.T3Mod = T3Mod;\n' }], ...window.__MODS_FOR_T3_OPTIONS__, sandboxDocument: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><title>Isolated mod runtime</title></head><body><script>// This trusted bootstrap lives in an opaque-origin iframe. Mod code only runs
// in its dedicated worker; the host can kill that worker even if it loops.
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
        blobUrl = URL.createObjectURL(new Blob([\`"use strict";\\n\${data.code}\\n;(\${source})(globalThis.T3Mod);\`], { type: "text/javascript" }));
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
    let sequence = 0;
    const pending = new Map();
    const events = new Map();
    const commands = new Map();
    const actions = new Map();
    let cleanup;
    function call(method, args) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = method === "draft.insert" ? null : setTimeout(() => { pending.delete(id); reject(new Error("Host request timed out.")); }, 10000);
        pending.set(id, { resolve, reject, timer });
        postMessage({ type: "call", id, method, args });
      });
    }
    const api = Object.freeze({
      on(event, callback) {
        if (typeof callback !== "function") throw new Error("An event needs a callback.");
        const callbacks = events.get(event) ?? new Set();
        callbacks.add(callback); events.set(event, callbacks);
        call("events.subscribe", [event]).catch((error) => postMessage({ type: "fault", error: error.message }));
        return () => callbacks.delete(callback);
      },
      commands: Object.freeze({
        async register(command, callback) {
          commands.set(command.id, callback);
          await call("commands.register", [command]);
        },
      }),
      panels: Object.freeze({
        set: (panel) => call("panels.set", [panel]),
        clear: () => call("panels.clear", []),
        action(id, callback) { actions.set(id, callback); },
      }),
      notify: (message) => call("notify", [message]),
      theme: Object.freeze({ set: (colors) => call("theme.set", [colors]), clear: () => call("theme.clear", []) }),
      band: Object.freeze({ set: (parts) => call("band.set", [parts]), clear: () => call("band.clear", []) }),
      session: Object.freeze({ usage: () => call("session.usage", []) }),
      route: Object.freeze({ get: () => call("route.get", []) }),
      draft: Object.freeze({ read: () => call("draft.read", []), insert: (text) => call("draft.insert", [text]) }),
      storage: Object.freeze({ get: (key) => call("storage.get", [key]), set: (key, value) => call("storage.set", [key, value]) }),
      log: (message) => call("log", [String(message)]),
    });
    const heartbeat = setInterval(() => postMessage({ type: "heartbeat" }), 1000);
    self.onmessage = async ({ data }) => {
      if (data.type === "result") {
        const waiter = pending.get(data.id);
        if (!waiter) return;
        pending.delete(data.id); clearTimeout(waiter.timer);
        if (data.error) waiter.reject(new Error(data.error)); else waiter.resolve(data.value);
        return;
      }
      try {
        if (data.type === "init") {
          if (typeof mod?.activate !== "function") throw new Error("Export an activate(api) function.");
          cleanup = await mod.activate(api);
          postMessage({ type: "ready" });
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
        if (data.requestId) postMessage({ type: "done", requestId: data.requestId });
      } catch (error) {
        postMessage({ type: "fault", error: error instanceof Error ? error.message : String(error) });
      }
    };
  }
})();
<\/script></body></html>` }).catch((error) => console.error("[Mods for T3 Code]", error)).finally(() => {
      delete window.__modsForT3Installing;
    });
  }
})();
