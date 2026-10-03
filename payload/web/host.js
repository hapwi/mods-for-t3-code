import { validateBundle, usageSnapshot, PERMISSIONS, MAX_BUNDLE_BYTES } from "./manifest.js";
import { database } from "./database.js";
import { ModRuntime } from "./runtime.js";
import { MODS_ICON, attachSidebarButton, composer, dockAboveComposer, insertDraft, readDraft, sidebarFooter } from "./adapter.js";
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
const toggle = (checked, label, disabled = false) => node("input", { type: "checkbox", role: "switch", class: "switch", checked, disabled, "aria-label": label });
function closeButton(onclick) {
  const control = node("button", { type: "button", class: "ghost icon", onclick }, [node("span", { class: "sr-only", text: "Close" })]);
  control.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>');
  return control;
}
// Settings-style building blocks: an uppercase section label over a bordered card of rows.
const section = (title, children, aside) => node("section", { class: "section" }, [node("div", { class: "section-head" }, [node("h2", { text: title }), ...(aside ? [aside] : [])]), node("div", { class: "card" }, children)]);
function row(title, description, controls = [], extra = []) {
  const heading = typeof title === "string" ? node("h2", { text: title }) : node("h2", {}, title);
  return node("article", { class: "row" }, [node("div", { class: "row-text" }, [heading, ...(description ? [node("p", { text: description })] : []), ...extra]), node("div", { class: "row-actions" }, controls)]);
}
const MORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
const note = (text) => node("div", { class: "row" }, [node("p", { class: "explain", text })]);

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
  let menu;

  // Compact overflow menu (T3 menu metrics). It lives inside the dialog so a modal
  // dialog doesn't make it inert; fixed positioning escapes the scrolling content.
  function closeMenu(restoreFocus = false) {
    if (!menu) return;
    const { popup, trigger } = menu; menu = undefined;
    popup.remove(); trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && trigger.isConnected) trigger.focus();
  }
  function moreButton(label, items) {
    const trigger = node("button", { type: "button", class: "ghost icon xs", "aria-label": label, title: label, "aria-haspopup": "menu", "aria-expanded": "false" });
    trigger.insertAdjacentHTML("afterbegin", MORE_ICON);
    trigger.onclick = () => { if (menu?.trigger === trigger) closeMenu(); else openMenu(trigger, items); };
    trigger.onkeydown = (event) => { if (event.key === "ArrowDown" && menu?.trigger !== trigger) { event.preventDefault(); openMenu(trigger, items); } };
    return trigger;
  }
  function openMenu(trigger, items) {
    closeMenu();
    const entries = items.map(([text, action, className = ""]) => node("button", { type: "button", role: "menuitem", tabIndex: -1, class: className, text, onclick: () => { closeMenu(true); action(); } }));
    const popup = node("div", { class: "menu", role: "menu", "aria-label": trigger.getAttribute("aria-label") }, entries);
    popup.addEventListener("keydown", (event) => {
      const index = entries.indexOf(shadow.activeElement);
      const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: entries.length - 1 }[event.key];
      if (move !== undefined) { event.preventDefault(); entries[(move + entries.length) % entries.length].focus(); }
      else if (event.key === "Tab") { event.preventDefault(); closeMenu(true); }
    });
    dialog.append(popup);
    const box = trigger.getBoundingClientRect();
    const below = box.bottom + 4 + popup.offsetHeight <= innerHeight - 8;
    popup.style.top = `${below ? box.bottom + 4 : Math.max(8, box.top - 4 - popup.offsetHeight)}px`;
    popup.style.left = `${Math.max(8, Math.min(innerWidth - popup.offsetWidth - 8, box.right - popup.offsetWidth))}px`;
    trigger.setAttribute("aria-expanded", "true"); menu = { popup, trigger }; entries[0]?.focus();
  }
  const onPointerDown = (event) => { if (menu && !event.composedPath().some((target) => target === menu.popup || target === menu.trigger)) closeMenu(); };
  const onViewportChange = () => closeMenu();

  function ask(title, description, action, destructive = false) {
    const result = decisionQueue.then(() => new Promise((resolve) => {
      const prompt = node("dialog", { class: "ask", "aria-label": title }, [node("header", {}, [node("h1", { text: title })]), node("div", { class: "content" }, [node("p", { class: "explain decision-preview", text: description })]), node("div", { class: "footer actions" }, [button("Cancel", () => finish(false)), button(action, () => finish(true), destructive ? "destructive" : "primary")])]);
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
    styleSettingsControl(false);
  }
  function closeManager() { if (inlineContent) leaveInline(); else dialog.close(); }
  function go(key) { tab = key; candidate = undefined; detailsOnly = false; render(); }

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
    tray.replaceChildren(node("header", {}, [node("span", { text: "Mod panels" }), button(trayOpen ? "Collapse" : "Expand", () => { trayOpen = !trayOpen; renderTray(); }, "ghost xs")]));
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
    styleSettingsControl(true);
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
    closeMenu();
    const actions = [button("Import", pickFile, "xs")];
    if (!inlineContent) actions.push(closeButton(closeManager));
    dialog.replaceChildren(node("header", {}, [node("div", {}, [node("h1", { text: "Mods" }), node("p", { text: "Local add-ons for T3 Code. Each mod runs isolated and can be switched off at any time." })]), node("div", { class: "header-actions" }, actions)]));
    if (candidate) { renderReview(); return; }
    dialog.append(node("nav", { class: "tabs", "aria-label": "Mod manager" }, [["installed", "Installed"], ["examples", "Built-in"], ["commands", "Commands"], ["create", "Create"], ["console", "Activity"]].map(([key, text]) => {
      const item = button(text, () => go(key)); item.setAttribute("aria-selected", String(tab === key)); return item;
    })));
    const content = node("div", { class: "content" }); dialog.append(content);
    if (tab === "installed") {
      const list = records.map((record) => {
        const { manifest } = record;
        const enabled = toggle(record.enabled, `Enable ${manifest.name}`, options.safeMode || busy);
        enabled.onchange = () => void run(async () => { stop(manifest.id); record.enabled = enabled.checked; record.quarantined = null; await database.save(record); start(record); broadcast(); });
        const state = paused ? "Paused" : runtimes.has(manifest.id) ? "Active" : "Off";
        const count = manifest.permissions.length;
        return row([document.createTextNode(manifest.name), node("span", { class: "state", "data-state": state.toLowerCase(), text: state })], manifest.description, [
          moreButton(`More actions for ${manifest.name}`, [
            ["Details", () => { candidate = validateBundle(record); detailsOnly = true; render(); }],
            ["Export", () => download(record)],
            ["Remove", () => void run(async () => { if (!await ask(`Remove ${manifest.name}?`, "The mod and its private data will be removed. Export it first if you want a copy.", "Remove mod", true)) return; stop(manifest.id); await database.remove(manifest.id); records = records.filter((item) => item !== record); broadcast(); }), "danger"],
          ]),
          enabled,
        ], [node("div", { class: "meta", text: `${manifest.version} · ${manifest.author} · ${count} permission${count === 1 ? "" : "s"}` }), ...(record.quarantined ? [node("p", { class: "error", text: `Stopped: ${record.quarantined}. Switch it on to retry.` })] : [])]);
      });
      if (!list.length) list.push(row("No mods installed", "Import a .t3mod file, or describe a mod and let your AI build it.", [button("Import", pickFile, "xs"), button("Create", () => go("create"), "xs")]));
      content.append(section("Installed", list, node("span", { class: "meta", text: options.safeMode ? "Safe mode" : `${records.length} installed · ${runtimes.size} active` })));
      const pause = toggle(paused, "Pause all mods", options.safeMode || busy);
      pause.onchange = () => void run(async () => { paused = pause.checked; if (paused) for (const id of [...runtimes.keys()]) stop(id); await database.setSetting("paused", paused); broadcast(); await reload(); });
      const dev = toggle(development, "Development mode");
      dev.onchange = () => void run(async () => { development = dev.checked; await database.setSetting("development", development); });
      content.append(section("General", [
        row("Pause all mods", options.safeMode ? "Safe mode is on, so all mod code is off." : "Stops every mod immediately. Use this if something misbehaves.", [pause]),
        row("Development mode", "Hot reload inbox updates to enabled mods from the same author. New permissions always need review.", [dev]),
      ]));
    } else if (tab === "examples") {
      const list = (options.examples ?? []).map((bundle) => row(bundle.manifest.name, bundle.manifest.description, [button("Review", () => { detailsOnly = false; candidate = validateBundle(bundle); render(); }, "xs")]));
      content.append(section("Built-in", list.length ? list : [note("No built-in mods in this build.")]), node("p", { class: "explain", text: "Included with Mods for T3 Code. A mod starts as soon as you review and install it. Themes use T3’s own color tokens and restore your appearance when turned off." }));
    } else if (tab === "commands") {
      const search = node("input", { type: "search", placeholder: "Find a mod command…", "aria-label": "Find command" });
      const list = node("div"); content.append(search, section("Commands", [list]));
      function show() {
        list.replaceChildren();
        for (const [id, entries] of commands) for (const command of entries.values()) {
          const runtime = runtimes.get(id); if (!runtime || !command.title.toLowerCase().includes(search.value.toLowerCase())) continue;
          list.append(row(command.title, runtime.record.manifest.name, [button("Run", () => { closeManager(); runtime.invoke("command", command.id); }, "xs")]));
        }
        if (!list.childNodes.length) list.append(note(commands.size ? "No matching commands." : "Switch on a mod that registers commands to see them here."));
      }
      search.oninput = show; show();
    } else if (tab === "create") {
      const description = node("textarea", { placeholder: "A focus timer with a start button and a reminder after 25 minutes…", "aria-label": "Describe your mod", maxLength: 5000 });
      const request = () => { if (!description.value.trim()) throw new Error("Describe your mod first."); return authorPrompt(description.value, options.inbox); };
      content.append(section("Create with your AI", [node("div", { class: "body" }, [
        node("label", { text: "What should your mod do?" }), description,
        node("p", { class: "explain", text: "Draft in T3 adds a request with the mod API to your composer; send it with your usual model. Your existing draft is kept. When your AI saves the mod, it appears here for permission review." }),
        node("div", { class: "actions" }, [
          button("Copy request", () => void run(async () => { await navigator.clipboard.writeText(request()); notify("Create a mod", "Request copied. Paste it into a T3 chat."); }), "xs"),
          button("Draft in T3", () => void run(async () => { const text = request(); if (!composer()) throw new Error("Open a T3 thread with a composer, then try again."); closeManager(); insertDraft((readDraft() ? "\n\n" : "") + text); }), "primary xs"),
        ]),
      ])]));
    } else {
      content.append(section("Activity", [node("pre", { class: "log", text: logs.join("\n") || "No mod activity yet." })], button("Clear", () => { logs.length = 0; render(); }, "ghost xs")), node("p", { class: "explain", text: "Recent mod messages and failures in this window." }));
    }
  }
  function renderReview() {
    const { manifest } = candidate;
    const previous = records.find((record) => record.manifest.id === manifest.id);
    const content = node("div", { class: "content" }, [node("div", { class: "review-title" }, [node("h2", { text: detailsOnly ? manifest.name : previous ? `Review update: ${manifest.name}` : `Review ${manifest.name}` }), node("p", { class: "explain", text: manifest.description }), node("div", { class: "meta", text: `${manifest.version} · ${manifest.author}` })])]);
    const permissions = manifest.permissions.map((permission) => node("div", { class: "row permission" }, [node("div", { class: "row-text" }, [node("span", { text: PERMISSIONS[permission] }), node("code", { text: `${permission}${previous && !previous.manifest.permissions.includes(permission) ? " — new permission" : ""}` })])]));
    content.append(section(detailsOnly ? "Permissions" : "This mod asks to", permissions.length ? permissions : [note("No optional permissions.")]));
    const footer = node("div", { class: "footer actions" });
    if (detailsOnly) {
      content.append(node("details", {}, [node("summary", { text: "JavaScript source" }), node("pre", { class: "review-code", text: candidate.code })]));
      footer.append(button("Done", () => { candidate = undefined; detailsOnly = false; render(); }, "xs")); dialog.append(content, footer); return;
    }
    content.append(node("p", { class: "explain", text: "Install code from authors you trust. The mod starts as soon as you install it. Mod code is isolated from T3’s files and credentials, but a mod can consume browser resources and use every permission listed above." }), node("details", {}, [node("summary", { text: "Review JavaScript source" }), node("pre", { class: "review-code", text: candidate.code })]));
    footer.append(button("Cancel", () => void run(async () => { await remember(candidate); candidate = candidates.shift(); }), "xs"), button(previous ? "Update mod" : "Install mod", () => void run(async () => {
      const bundle = candidate; stop(manifest.id);
      // Confirming the review is the consent to run it; pause and safe mode still win in start().
      const record = { ...bundle, enabled: true, quarantined: null }; delete record.inboxHash;
      await database.save(record); await remember(bundle); records = await database.list(); candidate = candidates.shift();
      start(records.find((item) => item.manifest.id === manifest.id) ?? record); broadcast();
      notify(manifest.name, options.safeMode ? "Installed. Mods are off in safe mode." : paused ? "Installed. It will start when you resume mods." : "Installed and switched on.");
    }), "primary xs")); dialog.append(content, footer);
  }
  function onInput(event) {
    if (!event.target?.closest?.('[data-testid="composer-editor"]')) return;
    clearTimeout(draftTimer); draftTimer = setTimeout(() => { for (const runtime of runtimes.values()) runtime.emit("draft.change", readDraft()); }, 150);
  }
  const detachSidebar = attachSidebarButton(() => open());
  let settingsItem;
  // T3's Settings sidebar: the menu that lists its sections, not the thread list.
  function settingsNav() {
    const content = document.querySelector('[data-sidebar="content"]') ?? document.querySelector('[data-slot="sidebar-content"]');
    const menus = content ? [...content.querySelectorAll('[data-sidebar="menu"], [data-slot="sidebar-menu"], ul')] : [];
    return menus.find((menu) => navItems(menu).some((item) => /\b(general|appearance|providers|keybindings)\b/i.test(item.textContent))) ?? null;
  }
  function navItems(menu) { return [...menu.querySelectorAll("button, a")].filter((item) => !item.closest("[data-t3mods]") && item.textContent.trim()); }
  // Borrow an adjacent native item's classes so active/inactive states match T3.
  function styleSettingsControl(active) {
    const control = settingsItem?.querySelector("button");
    if (!control) return;
    const items = settingsItem.parentElement ? navItems(settingsItem.parentElement) : [];
    const isActive = (item) => item.getAttribute("data-active") === "true" || item.getAttribute("aria-current") === "page";
    const reference = (active ? items.find(isActive) : items.find((item) => !isActive(item))) ?? items[0];
    control.className = reference?.className ?? "";
    control.style.cssText = reference ? "" : "display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer";
    for (const name of ["data-slot", "data-sidebar", "data-size"]) { const value = reference?.getAttribute(name); if (value) control.setAttribute(name, value); }
    control.querySelector("svg")?.setAttribute("class", reference?.querySelector("svg")?.getAttribute("class") ?? "");
    control.querySelector("span")?.setAttribute("class", reference?.querySelector("span")?.getAttribute("class") ?? "");
    if (reference?.hasAttribute("data-active")) control.setAttribute("data-active", String(active));
    if (active) control.setAttribute("aria-current", "page"); else control.removeAttribute("aria-current");
  }
  function attachSettings() {
    if (!location.pathname.startsWith("/settings") || settingsItem?.isConnected) return;
    const menu = settingsNav();
    if (!menu) return;
    const nativeItem = navItems(menu)[0]?.closest("li");
    const item = node("li", { "data-t3mods": "settings-section", class: nativeItem?.className ?? "" });
    for (const name of ["data-slot", "data-sidebar"]) { const value = nativeItem?.getAttribute(name); if (value) item.setAttribute(name, value); }
    if (!nativeItem) item.style.cssText = "list-style:none";
    const control = node("button", { type: "button", onclick: openSettings }, [node("span", { text: "Mods" })]);
    control.insertAdjacentHTML("afterbegin", MODS_ICON);
    item.append(control); menu.append(item); settingsItem = item; styleSettingsControl(Boolean(inlineContent));
  }
  function attachPanels() {
    const footer = sidebarFooter();
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
    if (menu) { event.preventDefault(); closeMenu(true); return; }
    if (dialog.open && shadow.querySelectorAll("dialog[open]").length === 1) { event.preventDefault(); if (inlineContent) leaveInline(); else dialog.close(); }
  };
  document.addEventListener("keydown", onKeys, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  shadow.addEventListener("scroll", onViewportChange, true); window.addEventListener("scroll", onViewportChange, true); window.addEventListener("resize", onViewportChange);
  try { channel = new BroadcastChannel("mods-for-t3-code"); channel.onmessage = () => void reload(); } catch { /* some custom protocol versions don't expose BroadcastChannel */ }
  window.__modsForT3Code = { open, importCandidate, async dispose() {
    if (disposed) return; disposed = true;
    for (const id of [...runtimes.keys()]) stop(id);
    leaveInline(); detachSidebar(); observer.disconnect(); panelRoot.remove(); bandDock.dispose(); try { unsubscribeTelemetry?.(); } catch {} settingsItem?.remove(); clearTimeout(draftTimer); channel?.close();
    window.removeEventListener("popstate", onRoute);
    for (const [key, { original, wrapped }] of historyMethods) if (history[key] === wrapped) history[key] = original;
    document.removeEventListener("input", onInput, true); document.removeEventListener("keydown", onKeys, true); document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("scroll", onViewportChange, true); window.removeEventListener("resize", onViewportChange); closeMenu(); root.remove(); delete window.__modsForT3Code;
  } };
  connectTelemetry();
  await reload();
  log("Host", options.safeMode ? "Safe mode enabled" : "Ready");
}
