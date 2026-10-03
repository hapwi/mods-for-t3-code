import { validateBundle, usageSnapshot, PERMISSIONS, MAX_BUNDLE_BYTES } from "./manifest.js";
import { database } from "./database.js";
import { ModRuntime } from "./runtime.js";
import { attachSidebarButton, dockAboveComposer, insertDraft, readDraft } from "./adapter.js";
import { authorPrompt } from "./author.js";
import { style } from "./style.js";
import { ThemeHost } from "./themes.js";

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  }
  element.append(...children); return element;
}
const button = (text, onclick, className = "") => node("button", { text, onclick, class: className, type: "button" });

export async function mount(options) {
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
  const runtimes = new Map();
  const commands = new Map();
  const panels = new Map();
  const bands = new Map();
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
      function finish(value) { prompt.close(); prompt.remove(); resolve(value); }
      prompt.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
      shadow.append(prompt); prompt.showModal();
    }));
    decisionQueue = result.catch(() => false); return result;
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
    inlineContent = undefined; root.removeAttribute("data-inline");
    dialog.removeAttribute("data-inline"); dialog.close(); document.body.append(root);
    settingsItem?.querySelector("button")?.removeAttribute("aria-current");
    settingsItem?.querySelector("button")?.removeAttribute("data-active");
  }

  function notify(name, text) {
    const notice = node("div", { class: "notice", role: "status" }, [node("strong", { text: name }), node("span", { text })]);
    for (const old of notices.splice(0)) old.remove();
    notices.push(notice); shadow.append(notice);
    setTimeout(() => { notice.remove(); const index = notices.indexOf(notice); if (index >= 0) notices.splice(index, 1); }, 6000);
  }
  function log(name, text) {
    logs.push(`${new Date().toLocaleTimeString()}  ${name}: ${text}`);
    if (logs.length > 100) logs.shift();
    if (dialog.open && tab === "console") render();
  }
  function renderTray() {
    tray.hidden = panels.size === 0;
    tray.replaceChildren(node("header", {}, [node("span", { text: "Mod panels" }), button(trayOpen ? "Collapse" : "Expand", () => { trayOpen = !trayOpen; renderTray(); }, "link")]));
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
    bandStack.replaceChildren(...rows); bandDock.show(rows.length > 0);
  }
  // Measurements come only from the trusted preload and only for the open thread.
  function currentUsage() {
    try { return usageSnapshot(telemetry?.get(location.pathname)); } catch { return null; }
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
    } catch { telemetry = undefined; }
  }
  function refresh() { if (dialog.open && !candidate && !busy && tab === "installed") render(); renderTray(); }
  function start(record) {
    if (paused || options.safeMode || !record.enabled || record.quarantined || runtimes.has(record.manifest.id)) return;
    const runtime = new ModRuntime(record, {
      ready: () => { log(record.manifest.name, "Loaded"); refresh(); },
      command: (_, command) => {
        const entries = commands.get(record.manifest.id) ?? new Map();
        if (entries.size >= 20 && !entries.has(command.id)) throw new Error("A mod can register up to 20 commands.");
        entries.set(command.id, command); commands.set(record.manifest.id, entries);
      },
      panel: (_, panel) => { if (panel) panels.set(record.manifest.id, panel); else panels.delete(record.manifest.id); renderTray(); },
      notify: (_, text) => notify(record.manifest.name, text),
      theme: (_, colors) => { if (colors) themes.set(record.manifest.id, colors); else themes.clear(record.manifest.id); },
      band: (_, parts) => { if (parts) bands.set(record.manifest.id, parts); else bands.delete(record.manifest.id); renderBands(); },
      usage: currentUsage,
      readDraft,
      insertDraft: async (runtime, text) => {
        if (!await ask(`${record.manifest.name} wants to add to your draft`, `This text will be pasted at the end. Nothing will be sent.\n\n${text}`, "Add to draft") || runtime.stopped) return false;
        insertDraft(text); return true;
      },
      log: (_, text) => log(record.manifest.name, text),
      removed: () => { runtimes.delete(record.manifest.id); commands.delete(record.manifest.id); panels.delete(record.manifest.id); bands.delete(record.manifest.id); themes.clear(record.manifest.id); renderBands(); refresh(); },
      fault: async (_, reason) => {
        record.enabled = false; record.quarantined = reason;
        await database.save(record); broadcast();
        log(record.manifest.name, reason); notify(record.manifest.name, reason); refresh();
      },
    }, options.sandboxDocument);
    runtimes.set(record.manifest.id, runtime);
  }
  function stop(id) { runtimes.get(id)?.stop(); }
  function broadcast() { channel?.postMessage("refresh"); }
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
  function open(nextTab = "installed") { leaveInline(); tab = nextTab; candidate = undefined; detailsOnly = false; render(); if (!dialog.open) dialog.showModal(); }
  function openSettings() {
    const inset = document.querySelector('[data-slot="sidebar-inset"]');
    const content = inset?.firstElementChild?.lastElementChild;
    if (!content || content.tagName === "HEADER") { open(); return; }
    leaveInline(); if (dialog.open) dialog.close();
    inlineContent = content; inlineDisplay = content.style.display; content.style.display = "none";
    root.setAttribute("data-inline", "true"); dialog.setAttribute("data-inline", "true");
    content.parentElement.append(root); tab = "installed"; candidate = undefined; detailsOnly = false; render(); dialog.open = true;
    settingsItem?.querySelector("button")?.setAttribute("aria-current", "page");
    settingsItem?.querySelector("button")?.setAttribute("data-active", "true");
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    dialog.setAttribute("aria-busy", "true");
    for (const control of dialog.querySelectorAll("button, input")) control.disabled = true;
    try { await action(); } catch (error) { notify("Mods for T3 Code", error.message); log("Host", error.message); }
    finally { busy = false; dialog.removeAttribute("aria-busy"); render(); }
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
          const record = { ...bundle, enabled: true, quarantined: null }; delete record.inboxHash;
          await database.save(record); await remember(bundle); records = await database.list(); start(record); broadcast();
          notify(record.manifest.name, "Development update loaded live."); return;
        }
      }
      if (candidate) {
        if (candidates.length < 20 && !candidates.some((item) => item.manifest.id === bundle.manifest.id && item.code === bundle.code)) candidates.push(bundle);
        notify("Mod inbox", `${bundle.manifest.name} is waiting for review.`); return;
      }
      leaveInline(); detailsOnly = false; candidate = bundle; tab = "installed"; render();
      if (!dialog.open) dialog.showModal();
    } catch (error) { notify("Cannot import mod", error.message); }
  }
  function pickFile() {
    const input = node("input", { type: "file", accept: ".t3mod,application/json" });
    input.onchange = () => void run(async () => {
      const file = input.files?.[0]; if (!file) return;
      if (file.size > MAX_BUNDLE_BYTES) throw new Error("Mod bundles must be smaller than 1 MB.");
      await importCandidate(JSON.parse(await file.text()));
    }); input.click();
  }
  function download(record) {
    const blob = new Blob([JSON.stringify({ format: record.format, manifest: record.manifest, code: record.code }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = node("a", { href: url, download: `${record.manifest.id}.t3mod` });
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function render() {
    dialog.replaceChildren(node("header", {}, [node("div", {}, [node("h1", { text: inlineContent ? "Mods" : "Mods for T3 Code" }), node("p", { text: "Your app, with a few personal touches." })]), node("div", { class: "header-actions" }, [button("Import mod", pickFile), button("Create a mod", () => { tab = "create"; candidate = undefined; render(); }, "primary"), button("Close", () => { if (inlineContent) leaveInline(); else dialog.close(); }, "link")])]));
    if (candidate) { renderReview(); return; }
    dialog.append(node("nav", { class: "tabs", "aria-label": "Mod manager" }, [["installed", "Installed"], ["examples", "Built-in"], ["commands", "Commands"], ["create", "Create"], ["console", "Activity"]].map(([key, text]) => {
      const item = button(text, () => { tab = key; render(); }); item.setAttribute("aria-selected", String(tab === key)); return item;
    })));
    const content = node("div", { class: "content" }); dialog.append(content);
    if (tab === "installed") {
      const pause = node("input", { type: "checkbox", checked: paused, disabled: options.safeMode || busy });
      pause.onchange = () => void run(async () => { paused = pause.checked; if (paused) for (const id of [...runtimes.keys()]) stop(id); await database.setSetting("paused", paused); broadcast(); await reload(); });
      content.append(node("div", { class: "toolbar" }, [node("p", { text: options.safeMode ? "Safe mode: all mod code is off." : `${records.length} installed · ${runtimes.size} active` }), node("label", { class: "switch" }, [pause, document.createTextNode("Pause all mods")])]));
      const dev = node("input", { type: "checkbox", checked: development, "aria-label": "Development mode" });
      dev.onchange = () => void run(async () => { development = dev.checked; await database.setSetting("development", development); });
      content.append(node("label", { class: "switch" }, [dev, document.createTextNode("Development mode: hot reload enabled inbox mods with existing permissions")]), node("p", { class: "explain", text: "New permissions always need review. Pause all mods is the immediate recovery switch." }));
      if (!records.length) content.append(node("div", { class: "empty" }, [node("h2", { text: "Make T3 feel like yours." }), node("p", { text: "Add a focus timer, save your favorite prompts, or ask your AI to build something new. Mods can be installed and switched off while T3 stays open." }), node("div", { class: "actions" }, [button("Import a .t3mod file", pickFile), button("Create with my AI", () => open("create"), "primary")])]));
      for (const record of records) {
        const { manifest } = record;
        const toggle = node("input", { type: "checkbox", checked: record.enabled, disabled: options.safeMode || busy, "aria-label": `Enable ${manifest.name}` });
        toggle.onchange = () => void run(async () => { stop(manifest.id); record.enabled = toggle.checked; record.quarantined = null; await database.save(record); start(record); broadcast(); });
        content.append(node("article", { class: "row" }, [node("div", {}, [node("h2", { text: manifest.name }), node("p", { text: manifest.description }), node("div", { class: "meta", text: `${manifest.version} · ${manifest.author} · ${manifest.permissions.length} permissions` }), ...(record.quarantined ? [node("p", { class: "error", text: `Stopped: ${record.quarantined}. Enable to retry.` })] : [])]), node("div", { class: "row-actions" }, [node("span", { class: "state", text: paused ? "Paused" : runtimes.has(manifest.id) ? "Active" : "Off" }), toggle, button("Details", () => { candidate = validateBundle(record); detailsOnly = true; render(); }), button("Export", () => download(record)), button("Remove", () => void run(async () => { if (!await ask(`Remove ${manifest.name}?`, "The mod and its private data will be removed. Export it first if you want a copy.", "Remove mod", true)) return; stop(manifest.id); await database.remove(manifest.id); records = records.filter((item) => item !== record); broadcast(); }), "danger")])]));
      }
    } else if (tab === "examples") {
      content.append(node("p", { class: "explain", text: "Included with the app patch. Review and install a mod, then switch it on. Themes change T3’s own color tokens and restore your appearance when disabled." }));
      for (const bundle of options.examples ?? []) content.append(node("article", { class: "row" }, [node("div", {}, [node("h2", { text: bundle.manifest.name }), node("p", { text: bundle.manifest.description })]), button("Review mod", () => { detailsOnly = false; candidate = validateBundle(bundle); render(); })]));
    } else if (tab === "commands") {
      const search = node("input", { type: "search", placeholder: "Find a local mod command…", "aria-label": "Find command" });
      const list = node("div"); content.append(search, list);
      function show() {
        list.replaceChildren();
        for (const [id, entries] of commands) for (const command of entries.values()) {
          const runtime = runtimes.get(id); if (!runtime || !command.title.toLowerCase().includes(search.value.toLowerCase())) continue;
          list.append(node("div", { class: "row" }, [node("div", {}, [node("h2", { text: command.title }), node("span", { class: "meta", text: runtime.record.manifest.name })]), button("Run", () => { dialog.close(); runtime.invoke("command", command.id); })]));
        }
        if (!list.childNodes.length) list.append(node("p", { class: "explain", text: "Enable a mod that registers commands to see them here." }));
      }
      search.oninput = show; show();
    } else if (tab === "create") {
      const description = node("textarea", { placeholder: "A focus timer with a start button and a reminder after 25 minutes…", "aria-label": "Describe your mod", maxLength: 5000 });
      content.append(node("h2", { text: "Build a mod with your AI" }), node("p", { class: "explain", text: "Describe what you want. We’ll put a request with the mod API in your T3 composer. Choose your usual model and send it using the account you already have." }), node("label", { text: "What should your mod do?" }), description, node("p", { class: "explain", text: "When your AI saves the file, review its permissions here before enabling it. Open a chat thread first. Your existing draft will be kept." }), node("div", { class: "actions" }, [button("Copy request", () => void run(async () => { if (!description.value.trim()) throw new Error("Describe your mod first."); await navigator.clipboard.writeText(authorPrompt(description.value, options.inbox)); notify("Create a mod", "Request copied. Paste it into your T3 chat."); })), button("Draft in T3", () => void run(async () => { if (!description.value.trim()) throw new Error("Describe your mod first."); const text = authorPrompt(description.value, options.inbox); dialog.close(); insertDraft((readDraft() ? "\n\n" : "") + text); }), "primary")]));
    } else {
      content.append(node("p", { class: "explain", text: "Recent mod messages and failures. This log stays in this window." }), button("Clear activity", () => { logs.length = 0; render(); }), node("pre", { class: "log", text: logs.join("\n") || "No mod activity yet." }));
    }
  }
  function renderReview() {
    const { manifest } = candidate;
    const previous = records.find((record) => record.manifest.id === manifest.id);
    const content = node("div", { class: "content" }, [node("h2", { text: detailsOnly ? manifest.name : previous ? `Review update: ${manifest.name}` : `Review ${manifest.name}` }), node("p", { class: "explain", text: manifest.description }), node("div", { class: "meta", text: `${manifest.version} · ${manifest.author}` }), node("p", { class: "explain", text: "This mod asks to:" })]);
    for (const permission of manifest.permissions) content.append(node("div", { class: "permission" }, [node("div", { text: PERMISSIONS[permission] }), node("code", { text: `${permission}${previous && !previous.manifest.permissions.includes(permission) ? " — new permission" : ""}` })]));
    if (!manifest.permissions.length) content.append(node("p", { class: "explain", text: "No optional permissions." }));
    if (detailsOnly) {
      content.append(node("details", {}, [node("summary", { text: "JavaScript source" }), node("pre", { class: "review-code", text: candidate.code })]), button("Close details", () => { candidate = undefined; detailsOnly = false; render(); })); dialog.append(content); return;
    }
    content.append(node("p", { class: "explain", text: "Install code from authors you trust. Mod code is isolated from T3’s files and credentials, but a mod can consume browser resources and use every permission listed above." }), node("details", {}, [node("summary", { text: "Review JavaScript source" }), node("pre", { class: "review-code", text: candidate.code })]), node("div", { class: "actions" }, [button("Cancel", () => void run(async () => { await remember(candidate); candidate = candidates.shift(); })), button(previous ? "Update mod" : "Install mod", () => void run(async () => {
      const bundle = candidate; stop(manifest.id);
      const record = { ...bundle, enabled: false, quarantined: null }; delete record.inboxHash;
      await database.save(record); await remember(bundle); records = await database.list(); candidate = candidates.shift(); broadcast();
      notify(manifest.name, "Installed. Switch it on when you’re ready.");
    }), "primary")])); dialog.append(content);
  }
  function onInput(event) {
    if (!event.target?.closest?.('[data-testid="composer-editor"]')) return;
    clearTimeout(draftTimer); draftTimer = setTimeout(() => { for (const runtime of runtimes.values()) runtime.emit("draft.change", readDraft()); }, 150);
  }
  const detachSidebar = attachSidebarButton(() => open());
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
    control.setAttribute("aria-label", "Mods settings"); item.append(control); sidebar.append(item); settingsItem = item;
  }
  function attachPanels() {
    const footer = document.querySelector('[data-sidebar="footer"]') ?? document.querySelector('[data-slot="sidebar-footer"]');
    if (!footer) return;
    if (panelRoot.parentElement !== footer) footer.prepend(panelRoot);
    if (tray.parentNode !== panelShadow) { tray.setAttribute("data-docked", "true"); panelShadow.append(tray); }
  }
  const observer = new MutationObserver(() => { attachSettings(); attachPanels(); });
  observer.observe(document.body, { childList: true, subtree: true }); attachSettings(); attachPanels();
  document.addEventListener("input", onInput, true);
  const onRoute = () => {
    if (lastPath !== location.pathname) {
      lastPath = location.pathname; leaveInline(); if (settingsItem) { settingsItem.remove(); settingsItem = undefined; } attachSettings();
      connectTelemetry();
      const usage = currentUsage();
      for (const runtime of runtimes.values()) { runtime.emit("app.route", lastPath); runtime.emit("session.usage", usage); }
    }
  };
  const historyMethods = new Map();
  for (const key of ["pushState", "replaceState"]) {
    const original = history[key];
    const wrapped = function(...args) { const result = Reflect.apply(original, this, args); queueMicrotask(onRoute); return result; };
    historyMethods.set(key, { original, wrapped }); history[key] = wrapped;
  }
  window.addEventListener("popstate", onRoute);
  const onKeys = (event) => {
    if (event.key !== "Escape" || !shadow.querySelector("dialog[open]")) return;
    event.stopPropagation();
    if (dialog.open && shadow.querySelectorAll("dialog[open]").length === 1) { event.preventDefault(); if (inlineContent) leaveInline(); else dialog.close(); }
  };
  document.addEventListener("keydown", onKeys, true);
  try { channel = new BroadcastChannel("mods-for-t3-code"); channel.onmessage = () => void reload(); } catch { /* some custom protocol versions don't expose BroadcastChannel */ }
  window.__modsForT3Code = { open, importCandidate, async dispose() {
    if (disposed) return; disposed = true;
    for (const id of [...runtimes.keys()]) stop(id);
    leaveInline(); detachSidebar(); observer.disconnect(); panelRoot.remove(); bandDock.dispose(); try { unsubscribeTelemetry?.(); } catch {} settingsItem?.remove(); clearTimeout(draftTimer); channel?.close();
    window.removeEventListener("popstate", onRoute);
    for (const [key, { original, wrapped }] of historyMethods) if (history[key] === wrapped) history[key] = original;
    document.removeEventListener("input", onInput, true); document.removeEventListener("keydown", onKeys, true); root.remove(); delete window.__modsForT3Code;
  } };
  connectTelemetry();
  await reload();
  log("Host", options.safeMode ? "Safe mode enabled" : "Ready");
}
