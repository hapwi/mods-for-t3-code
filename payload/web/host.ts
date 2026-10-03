import type { BandPart, ModBundle, ModRecord } from "../../sdk.d.ts";
import type { TelemetryApi } from "../telemetry-types.ts";
import { MAX_BUNDLE_BYTES, PERMISSIONS, usageSnapshot, validateBundle } from "./manifest.ts";
import { database } from "./database.ts";
import { ModRuntime } from "./runtime.ts";
import { MODS_ICON, attachSidebarButton, composer, dockAboveComposer, insertDraft, readDraft, sidebarFooter } from "./adapter.ts";
import { authorPrompt } from "./author.ts";
import { style } from "./style.ts";
import { ThemeHost } from "./themes.ts";
import { routePath } from "./route.ts";

type ReviewBundle = ModBundle & { inboxHash?: string };
type MenuEntry = readonly [text: string, action: () => void, className?: string];
type SeenInbox = { [hash: string]: number };

export interface MountOptions {
  safeMode?: boolean;
  inbox?: string;
  examples?: readonly ModBundle[];
  sandboxDocument: string;
}
export interface ModsHost {
  open(tab?: string): void;
  importCandidate(value: unknown, source?: { inbox?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}
declare global {
  interface Window {
    __modsForT3Code?: ModsHost;
    __modsForT3Installing?: boolean;
    __MODS_FOR_T3_OPTIONS__?: Partial<MountOptions>;
  }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: { [key: string]: unknown } = {}, children: Node[] = []): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (key === "class") element.className = String(value);
    else if (key === "text") element.textContent = String(value);
    else if (key === "style") element.setAttribute("style", String(value));
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2), value as EventListener);
    else if (key in element) Reflect.set(element, key, value);
    else element.setAttribute(key, String(value));
  }
  if (children.length) element.append(...children);
  return element;
}
const button = (text: string, onclick: () => void, className = "") => node("button", { text, onclick, class: className, type: "button" });
const toggle = (checked: boolean, label: string, disabled = false) => node("input", { type: "checkbox", role: "switch", class: "switch", checked, disabled, "aria-label": label });
function closeButton(onclick: () => void): HTMLButtonElement {
  const control = node("button", { type: "button", class: "ghost icon", onclick }, [node("span", { class: "sr-only", text: "Close" })]);
  control.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>');
  return control;
}
// Settings-style building blocks: an uppercase section label over a bordered card of rows.
const section = (title: string, children: Node[], aside?: Node) => node("section", { class: "section" }, [node("div", { class: "section-head" }, [node("h2", { text: title }), ...(aside ? [aside] : [])]), node("div", { class: "card" }, children)]);
function row(title: string | Node[], description: string, controls: Node[] = [], extra: Node[] = []): HTMLElement {
  const heading = typeof title === "string" ? node("h2", { text: title }) : node("h2", {}, title);
  return node("article", { class: "row" }, [node("div", { class: "row-text" }, [heading, ...(description ? [node("p", { text: description })] : []), ...extra]), node("div", { class: "row-actions" }, controls)]);
}
const MORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
const note = (text: string) => node("div", { class: "row" }, [node("p", { class: "explain", text })]);
const MAX_RENDERED_BLOCKS = 20;

function seenMap(value: unknown): SeenInbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const seen: SeenInbox = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "number") seen[key] = item;
  return seen;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function digestBundle(bundle: ModBundle): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(bundle)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mount(options: MountOptions): Promise<void> {
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
  let records: ModRecord[] = [];
  const runtimes = new Map<string, ModRuntime>();
  const commands = new Map<string, Map<string, { id: string; title: string }>>();
  const panels = new Map<string, { title: string; body: string; actions: { id: string; label: string }[] }>();
  const bands = new Map<string, BandPart[]>();
  const themes = new ThemeHost();
  const logs: string[] = [];
  const notices: HTMLElement[] = [];
  let paused = Boolean(await database.getSetting("paused"));
  let development = Boolean(await database.getSetting("development"));
  let seenInbox = seenMap(await database.getSetting("seenInbox"));
  let tab = "installed";
  let candidate: ReviewBundle | undefined;
  const candidates: ReviewBundle[] = [];
  let busy = false;
  let trayOpen = true;
  let lastPath = routePath();
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let channel: BroadcastChannel | undefined;
  let detailsOnly = false;
  let inlineContent: HTMLElement | undefined;
  let inlineDisplay = "";
  let decisionQueue: Promise<unknown> = Promise.resolve();
  let telemetry: TelemetryApi | undefined;
  let unsubscribeTelemetry: (() => void) | undefined;
  let menu: { popup: HTMLDivElement; trigger: HTMLButtonElement } | undefined;
  let bundleScan: ReturnType<typeof setTimeout> | undefined;
  const scannedBlocks = new WeakMap<HTMLElement, number>();

  // Compact overflow menu (T3 menu metrics). It lives inside the dialog so a modal
  // dialog doesn't make it inert; fixed positioning escapes the scrolling content.
  function closeMenu(restoreFocus = false): void {
    if (!menu) return;
    const { popup, trigger } = menu; menu = undefined;
    popup.remove(); trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && trigger.isConnected) trigger.focus();
  }
  function moreButton(label: string, items: readonly MenuEntry[]): HTMLButtonElement {
    const trigger = node("button", { type: "button", class: "ghost icon xs", "aria-label": label, title: label, "aria-haspopup": "menu", "aria-expanded": "false" });
    trigger.insertAdjacentHTML("afterbegin", MORE_ICON);
    trigger.onclick = () => { if (menu?.trigger === trigger) closeMenu(); else openMenu(trigger, items); };
    trigger.onkeydown = (event) => { if (event.key === "ArrowDown" && menu?.trigger !== trigger) { event.preventDefault(); openMenu(trigger, items); } };
    return trigger;
  }
  function openMenu(trigger: HTMLButtonElement, items: readonly MenuEntry[]): void {
    closeMenu();
    const entries = items.map(([text, action, className = ""]) => node("button", { type: "button", role: "menuitem", tabIndex: -1, class: className, text, onclick: () => { closeMenu(true); action(); } }));
    const popup = node("div", { class: "menu", role: "menu", "aria-label": trigger.getAttribute("aria-label") ?? "Menu" }, entries);
    popup.addEventListener("keydown", (event) => {
      const active = shadow.activeElement;
      const index = active instanceof HTMLButtonElement ? entries.indexOf(active) : -1;
      const moves: { [key: string]: number } = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: entries.length - 1 };
      const move = moves[event.key];
      if (move !== undefined) { event.preventDefault(); entries[(move + entries.length) % entries.length]?.focus(); }
      else if (event.key === "Tab") { event.preventDefault(); closeMenu(true); }
    });
    dialog.append(popup);
    const box = trigger.getBoundingClientRect();
    const below = box.bottom + 4 + popup.offsetHeight <= innerHeight - 8;
    popup.style.top = `${below ? box.bottom + 4 : Math.max(8, box.top - 4 - popup.offsetHeight)}px`;
    popup.style.left = `${Math.max(8, Math.min(innerWidth - popup.offsetWidth - 8, box.right - popup.offsetWidth))}px`;
    trigger.setAttribute("aria-expanded", "true"); menu = { popup, trigger }; entries[0]?.focus();
  }
  const onPointerDown = (event: Event) => {
    const current = menu;
    if (!current) return;
    const path = event.composedPath();
    if (!path.includes(current.popup) && !path.includes(current.trigger)) closeMenu();
  };
  const onViewportChange = () => closeMenu();

  function ask(title: string, description: string, action: string, destructive = false): Promise<boolean> {
    const result = decisionQueue.then(() => new Promise<boolean>((resolve) => {
      const prompt = node("dialog", { class: "ask", "aria-label": title }, [node("header", {}, [node("h1", { text: title })]), node("div", { class: "content" }, [node("p", { class: "explain decision-preview", text: description })]), node("div", { class: "footer actions" }, [button("Cancel", () => finish(false)), button(action, () => finish(true), destructive ? "destructive" : "primary")])]);
      function finish(value: boolean): void { prompt.close(); prompt.remove(); resolve(value); }
      prompt.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
      shadow.append(prompt); prompt.showModal();
    }));
    decisionQueue = result.catch(() => false); return result;
  }
  async function remember(bundle: ReviewBundle | undefined): Promise<void> {
    if (!bundle?.inboxHash) return;
    seenInbox[bundle.inboxHash] = Date.now();
    seenInbox = Object.fromEntries(Object.entries(seenInbox).sort((left, right) => right[1] - left[1]).slice(0, 200));
    await database.setSetting("seenInbox", seenInbox);
  }
  function leaveInline(): void {
    if (!inlineContent) return;
    inlineContent.style.display = inlineDisplay;
    inlineContent = undefined; root.removeAttribute("data-inline");
    dialog.removeAttribute("data-inline"); dialog.close(); document.body.append(root);
    styleSettingsControl(false);
  }
  function closeManager(): void { if (inlineContent) leaveInline(); else dialog.close(); }
  function go(key: string): void { tab = key; candidate = undefined; detailsOnly = false; render(); }

  function notify(name: string, text: string): void {
    const notice = node("div", { class: "notice", role: "status" }, [node("strong", { text: name }), node("span", { text })]);
    for (const old of notices.splice(0)) old.remove();
    notices.push(notice); shadow.append(notice);
    setTimeout(() => { notice.remove(); const index = notices.indexOf(notice); if (index >= 0) notices.splice(index, 1); }, 6000);
  }
  function log(name: string, text: string): void {
    logs.push(`${new Date().toLocaleTimeString()}  ${name}: ${text}`);
    if (logs.length > 100) logs.shift();
    if (dialog.open && tab === "console") render();
  }
  function renderTray(): void {
    tray.hidden = panels.size === 0;
    tray.replaceChildren(node("header", {}, [node("span", { text: "Mod panels" }), button(trayOpen ? "Collapse" : "Expand", () => { trayOpen = !trayOpen; renderTray(); }, "ghost xs")]));
    if (!trayOpen) return;
    for (const [id, panel] of panels) {
      const runtime = runtimes.get(id);
      if (!runtime) continue;
      tray.append(node("section", { class: "panel" }, [node("div", { class: "meta", text: runtime.record.manifest.name }), node("h2", { text: panel.title }), node("p", { text: panel.body }), node("div", { class: "actions" }, panel.actions.map((action) => button(action.label, () => runtime.invoke("action", action.id), "xs")))]));
    }
  }
  function renderBands(): void {
    const rows: HTMLElement[] = [];
    for (const [id, parts] of bands) {
      const runtime = runtimes.get(id);
      if (!runtime || rows.length >= 4) continue;
      const name = runtime.record.manifest.name;
      rows.push(node("div", { class: "band", title: name, "aria-label": `${name}: ${parts.map((part) => part.text).join("")}`, "data-mod": id }, parts.map((part) => node("span", { "data-tone": part.tone ?? "default", text: part.text }))));
    }
    bandStack.replaceChildren(...rows); bandDock.show(rows.length > 0);
  }
  // Measurements come only from the trusted preload and only for the open thread.
  function currentUsage() {
    try { return usageSnapshot(telemetry?.get(routePath())); } catch { return null; }
  }
  function connectTelemetry(): void {
    const api = window.__T3_MODS_TELEMETRY__;
    if (telemetry || disposed || typeof api?.subscribe !== "function") return;
    telemetry = api;
    try {
      unsubscribeTelemetry = telemetry.subscribe((event) => {
        if (event.name !== "session.usage" && event.name !== "turn.complete") return;
        const value = usageSnapshot(event.value);
        if (!value || currentUsage()?.threadId !== value.threadId) return;
        for (const runtime of runtimes.values()) runtime.emit(event.name, value);
      });
    } catch { telemetry = undefined; }
  }
  function refresh(): void { if (dialog.open && !candidate && !busy && tab === "installed") render(); renderTray(); }
  function start(record: ModRecord): void {
    if (paused || options.safeMode || !record.enabled || record.quarantined || runtimes.has(record.manifest.id)) return;
    const runtime = new ModRuntime(record, {
      ready: () => { log(record.manifest.name, "Loaded"); refresh(); },
      command: (_runtime, command) => {
        const entries = commands.get(record.manifest.id) ?? new Map<string, { id: string; title: string }>();
        if (entries.size >= 20 && !entries.has(command.id)) throw new Error("A mod can register up to 20 commands.");
        entries.set(command.id, command); commands.set(record.manifest.id, entries);
      },
      panel: (_runtime, panel) => { if (panel) panels.set(record.manifest.id, panel); else panels.delete(record.manifest.id); renderTray(); },
      notify: (_runtime, text) => notify(record.manifest.name, text),
      theme: (_runtime, colors) => { if (colors) themes.set(record.manifest.id, colors); else themes.clear(record.manifest.id); },
      band: (_runtime, parts) => { if (parts) bands.set(record.manifest.id, parts); else bands.delete(record.manifest.id); renderBands(); },
      usage: currentUsage,
      readDraft,
      insertDraft: async (current, text) => {
        if (!await ask(`${record.manifest.name} wants to add to your draft`, `This text will be pasted at the end. Nothing will be sent.\n\n${text}`, "Add to draft") || current.stopped) return false;
        insertDraft(text); return true;
      },
      log: (_runtime, text) => log(record.manifest.name, text),
      removed: () => { runtimes.delete(record.manifest.id); commands.delete(record.manifest.id); panels.delete(record.manifest.id); bands.delete(record.manifest.id); themes.clear(record.manifest.id); renderBands(); refresh(); },
      fault: async (_runtime, reason) => {
        record.enabled = false; record.quarantined = reason;
        await database.save(record); broadcast();
        log(record.manifest.name, reason); notify(record.manifest.name, reason); refresh();
      },
    }, options.sandboxDocument);
    runtimes.set(record.manifest.id, runtime);
  }
  function stop(id: string): void { runtimes.get(id)?.stop(); }
  function broadcast(): void { channel?.postMessage("refresh"); }
  async function reload(): Promise<void> {
    records = await database.list();
    paused = Boolean(await database.getSetting("paused"));
    for (const [id, runtime] of runtimes) {
      const record = records.find((item) => item.manifest.id === id);
      if (paused || !record?.enabled || record.quarantined || record.code !== runtime.record.code || JSON.stringify(record.manifest) !== JSON.stringify(runtime.record.manifest)) stop(id);
    }
    for (const record of records) start(record);
    refresh();
  }
  function open(nextTab = "installed"): void { leaveInline(); tab = nextTab; candidate = undefined; detailsOnly = false; render(); if (!dialog.open) dialog.showModal(); }
  function openSettings(): void {
    const inset = document.querySelector('[data-slot="sidebar-inset"]');
    const content = inset?.firstElementChild?.lastElementChild;
    if (!(content instanceof HTMLElement) || content.tagName === "HEADER" || !content.parentElement) { open(); return; }
    leaveInline(); if (dialog.open) dialog.close();
    inlineContent = content; inlineDisplay = content.style.display; content.style.display = "none";
    root.setAttribute("data-inline", "true"); dialog.setAttribute("data-inline", "true");
    content.parentElement.append(root); tab = "installed"; candidate = undefined; detailsOnly = false; render(); dialog.open = true;
    styleSettingsControl(true);
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    dialog.setAttribute("aria-busy", "true");
    for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) control.disabled = true;
    try { await action(); } catch (error) { const text = messageText(error); notify("Mods for T3 Code", text); log("Host", text); }
    finally { busy = false; dialog.removeAttribute("aria-busy"); render(); }
  }
  async function importCandidate(value: unknown, source: { inbox?: boolean } = {}): Promise<void> {
    try {
      const bundle: ReviewBundle = validateBundle(value);
      const installed = records.find((record) => record.manifest.id === bundle.manifest.id);
      if (installed && installed.code === bundle.code && JSON.stringify(installed.manifest) === JSON.stringify(bundle.manifest)) return;
      if (source.inbox) {
        bundle.inboxHash = await digestBundle(bundle);
        if (seenInbox[bundle.inboxHash] || candidate?.inboxHash === bundle.inboxHash || candidates.some((item) => item.inboxHash === bundle.inboxHash)) return;
        if (development && installed?.enabled && installed.manifest.author === bundle.manifest.author && bundle.manifest.permissions.every((permission) => installed.manifest.permissions.includes(permission))) {
          stop(installed.manifest.id);
          const record: ModRecord = { ...bundle, enabled: true, quarantined: null }; delete record.inboxHash;
          await database.save(record); await remember(bundle); records = await database.list(); start(record); broadcast();
          notify(record.manifest.name, "Development update loaded live."); return;
        }
      }
      const sameBundle = (item: ModBundle) => item.manifest.id === bundle.manifest.id && item.code === bundle.code;
      if (candidate) {
        if (sameBundle(candidate) || candidates.some(sameBundle)) return;
        if (candidates.length < 20) candidates.push(bundle);
        notify("Mod inbox", `${bundle.manifest.name} is waiting for review.`); return;
      }
      leaveInline(); detailsOnly = false; candidate = bundle; tab = "installed"; render();
      if (!dialog.open) dialog.showModal();
    } catch (error) { notify("Cannot import mod", messageText(error)); }
  }
  // A remote provider cannot write this computer's inbox. Read a finished t3mod
  // JSON block from the native thread only; the manager's own source stays in shadow DOM.
  function scheduleBundleScan(): void {
    if (bundleScan !== undefined || disposed) return;
    bundleScan = setTimeout(() => { bundleScan = undefined; void scanRenderedBundles(); }, 400);
  }
  async function scanRenderedBundles(): Promise<void> {
    if (disposed) return;
    const blocks = [...document.querySelectorAll("pre code")].filter((block): block is HTMLElement => block instanceof HTMLElement && !block.closest("#mods-for-t3-code-host")).slice(-MAX_RENDERED_BLOCKS);
    for (const block of blocks) {
      if (disposed) return;
      const text = block.textContent ?? "";
      if (scannedBlocks.get(block) === text.length) continue;
      const trimmed = text.trim();
      let bundle: ModBundle | undefined;
      if (text.length <= MAX_BUNDLE_BYTES && trimmed.startsWith("{") && trimmed.includes('"t3mod/1"')) {
        try { bundle = validateBundle(JSON.parse(trimmed) as unknown); } catch { bundle = undefined; }
      }
      scannedBlocks.set(block, text.length);
      if (bundle) await importCandidate(bundle, { inbox: true });
    }
  }
  function pickFile(): void {
    const input = node("input", { type: "file", accept: ".t3mod,application/json" });
    input.onchange = () => void run(async () => {
      const file = input.files?.[0]; if (!file) return;
      if (file.size > MAX_BUNDLE_BYTES) throw new Error("Mod bundles must be smaller than 1 MB.");
      await importCandidate(JSON.parse(await file.text()) as unknown);
    }); input.click();
  }
  function download(record: ModRecord): void {
    const blob = new Blob([JSON.stringify({ format: record.format, manifest: record.manifest, code: record.code }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = node("a", { href: url, download: `${record.manifest.id}.t3mod` });
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function render(): void {
    closeMenu();
    const actions: Node[] = [button("Import", pickFile, "xs")];
    if (!inlineContent) actions.push(closeButton(closeManager));
    dialog.replaceChildren(node("header", {}, [node("div", {}, [node("h1", { text: "Mods" }), node("p", { text: "Local add-ons for T3 Code. Each mod runs isolated and can be switched off at any time." })]), node("div", { class: "header-actions" }, actions)]));
    if (candidate) { renderReview(); return; }
    dialog.append(node("nav", { class: "tabs", "aria-label": "Mod manager" }, [["installed", "Installed"], ["examples", "Built-in"], ["commands", "Commands"], ["create", "Create"], ["console", "Activity"]].map(([key, text]) => {
      const item = button(text ?? "", () => go(key ?? "")); item.setAttribute("aria-selected", String(tab === key)); return item;
    })));
    const content = node("div", { class: "content" }); dialog.append(content);
    if (tab === "installed") {
      const list = records.map((record) => {
        const { manifest } = record;
        const enabled = toggle(record.enabled, `Enable ${manifest.name}`, Boolean(options.safeMode) || busy);
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
      const pause = toggle(paused, "Pause all mods", Boolean(options.safeMode) || busy);
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
      function show(): void {
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
        node("p", { class: "explain", text: "Draft in T3 adds a request with the mod API to your composer; send it with your usual model. Your existing draft is kept. The reply must include the mod JSON in one t3mod block so it can be reviewed here even when the model is not running on this computer." }),
        node("div", { class: "actions" }, [
          button("Copy request", () => void run(async () => { await navigator.clipboard.writeText(request()); notify("Create a mod", "Request copied. Paste it into a T3 chat."); }), "xs"),
          button("Draft in T3", () => void run(async () => { const text = request(); if (!composer()) throw new Error("Open a T3 thread with a composer, then try again."); closeManager(); insertDraft((readDraft() ? "\n\n" : "") + text); }), "primary xs"),
        ]),
      ])]));
    } else {
      content.append(section("Activity", [node("pre", { class: "log", text: logs.join("\n") || "No mod activity yet." })], button("Clear", () => { logs.length = 0; render(); }, "ghost xs")), node("p", { class: "explain", text: "Recent mod messages and failures in this window." }));
    }
  }
  function renderReview(): void {
    const reviewing = candidate;
    if (!reviewing) return;
    const { manifest } = reviewing;
    const previous = records.find((record) => record.manifest.id === manifest.id);
    const content = node("div", { class: "content" }, [node("div", { class: "review-title" }, [node("h2", { text: detailsOnly ? manifest.name : previous ? `Review update: ${manifest.name}` : `Review ${manifest.name}` }), node("p", { class: "explain", text: manifest.description }), node("div", { class: "meta", text: `${manifest.version} · ${manifest.author}` })])]);
    const permissions = manifest.permissions.map((permission) => node("div", { class: "row permission" }, [node("div", { class: "row-text" }, [node("span", { text: PERMISSIONS[permission] }), node("code", { text: `${permission}${previous && !previous.manifest.permissions.includes(permission) ? " — new permission" : ""}` })])]));
    content.append(section(detailsOnly ? "Permissions" : "This mod asks to", permissions.length ? permissions : [note("No optional permissions.")]));
    const footer = node("div", { class: "footer actions" });
    if (detailsOnly) {
      content.append(node("details", {}, [node("summary", { text: "JavaScript source" }), node("pre", { class: "review-code", text: reviewing.code })]));
      footer.append(button("Done", () => { candidate = undefined; detailsOnly = false; render(); }, "xs")); dialog.append(content, footer); return;
    }
    content.append(node("p", { class: "explain", text: "Install code from authors you trust. The mod starts as soon as you install it. Mod code is isolated from T3’s files and credentials, but a mod can consume browser resources and use every permission listed above." }), node("details", {}, [node("summary", { text: "Review JavaScript source" }), node("pre", { class: "review-code", text: reviewing.code })]));
    footer.append(button("Cancel", () => void run(async () => { await remember(candidate); candidate = candidates.shift(); }), "xs"), button(previous ? "Update mod" : "Install mod", () => void run(async () => {
      const bundle = candidate; if (!bundle) return; stop(manifest.id);
      // Confirming the review is the consent to run it; pause and safe mode still win in start().
      const record: ModRecord = { ...bundle, enabled: true, quarantined: null }; delete record.inboxHash;
      await database.save(record); await remember(bundle); records = await database.list(); candidate = candidates.shift();
      start(records.find((item) => item.manifest.id === manifest.id) ?? record); broadcast();
      notify(manifest.name, options.safeMode ? "Installed. Mods are off in safe mode." : paused ? "Installed. It will start when you resume mods." : "Installed and switched on.");
    }), "primary xs")); dialog.append(content, footer);
  }
  function onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-testid="composer-editor"]')) return;
    clearTimeout(draftTimer); draftTimer = setTimeout(() => { for (const runtime of runtimes.values()) runtime.emit("draft.change", readDraft()); }, 150);
  }
  const detachSidebar = attachSidebarButton(() => open());
  let settingsItem: HTMLLIElement | undefined;
  // T3's Settings sidebar: the menu that lists its sections, not the thread list.
  function settingsNav(): HTMLElement | null {
    const content = document.querySelector('[data-sidebar="content"]') ?? document.querySelector('[data-slot="sidebar-content"]');
    const menus = content ? [...content.querySelectorAll<HTMLElement>('[data-sidebar="menu"], [data-slot="sidebar-menu"], ul')] : [];
    return menus.find((item) => navItems(item).some((entry) => /\b(general|appearance|providers|keybindings)\b/i.test(entry.textContent ?? ""))) ?? null;
  }
  function navItems(menuRoot: ParentNode): HTMLElement[] { return [...menuRoot.querySelectorAll<HTMLElement>("button, a")].filter((item) => !item.closest("[data-t3mods]") && Boolean(item.textContent?.trim())); }
  // Borrow an adjacent native item's classes so active/inactive states match T3.
  function styleSettingsControl(active: boolean): void {
    const control = settingsItem?.querySelector("button");
    if (!(control instanceof HTMLButtonElement)) return;
    const items = settingsItem?.parentElement ? navItems(settingsItem.parentElement) : [];
    const isActive = (item: Element) => item.getAttribute("data-active") === "true" || item.getAttribute("aria-current") === "page";
    const reference = (active ? items.find(isActive) : items.find((item) => !isActive(item))) ?? items[0];
    control.className = reference?.className ?? "";
    control.style.cssText = reference ? "" : "display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer";
    for (const name of ["data-slot", "data-sidebar", "data-size"]) { const value = reference?.getAttribute(name); if (value) control.setAttribute(name, value); }
    control.querySelector("svg")?.setAttribute("class", reference?.querySelector("svg")?.getAttribute("class") ?? "");
    control.querySelector("span")?.setAttribute("class", reference?.querySelector("span")?.getAttribute("class") ?? "");
    if (reference?.hasAttribute("data-active")) control.setAttribute("data-active", String(active));
    if (active) control.setAttribute("aria-current", "page"); else control.removeAttribute("aria-current");
  }
  function attachSettings(): void {
    if (!routePath().startsWith("/settings") || settingsItem?.isConnected) return;
    const menuRoot = settingsNav();
    if (!menuRoot) return;
    const nativeItem = navItems(menuRoot)[0]?.closest("li");
    const item = node("li", { "data-t3mods": "settings-section", class: nativeItem?.className ?? "" });
    for (const name of ["data-slot", "data-sidebar"]) { const value = nativeItem?.getAttribute(name); if (value) item.setAttribute(name, value); }
    if (!nativeItem) item.style.cssText = "list-style:none";
    const control = node("button", { type: "button", onclick: openSettings }, [node("span", { text: "Mods" })]);
    control.insertAdjacentHTML("afterbegin", MODS_ICON);
    item.append(control); menuRoot.append(item); settingsItem = item; styleSettingsControl(Boolean(inlineContent));
  }
  function attachPanels(): void {
    const footer = sidebarFooter();
    if (!footer) return;
    if (panelRoot.parentElement !== footer) footer.prepend(panelRoot);
    if (tray.parentNode !== panelShadow) { tray.setAttribute("data-docked", "true"); panelShadow.append(tray); }
  }
  const observer = new MutationObserver(() => { attachSettings(); attachPanels(); scheduleBundleScan(); });
  observer.observe(document.body, { childList: true, subtree: true }); attachSettings(); attachPanels(); scheduleBundleScan();
  document.addEventListener("input", onInput, true);
  const onRoute = () => {
    const path = routePath();
    if (lastPath !== path) {
      lastPath = path; leaveInline(); if (settingsItem) { settingsItem.remove(); settingsItem = undefined; } attachSettings();
      connectTelemetry();
      const usage = currentUsage();
      for (const runtime of runtimes.values()) { runtime.emit("app.route", lastPath); runtime.emit("session.usage", usage); }
    }
  };
  const historyMethods = new Map<"pushState" | "replaceState", { original: History["pushState"]; wrapped: History["pushState"] }>();
  for (const key of ["pushState", "replaceState"] as const) {
    const original = history[key];
    const wrapped: History["pushState"] = function (this: History, ...args) { Reflect.apply(original, this, args); queueMicrotask(onRoute); };
    historyMethods.set(key, { original, wrapped }); history[key] = wrapped;
  }
  window.addEventListener("popstate", onRoute);
  window.addEventListener("hashchange", onRoute);
  const onKeys = (event: KeyboardEvent) => {
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
    leaveInline(); detachSidebar(); observer.disconnect(); clearTimeout(bundleScan); panelRoot.remove(); bandDock.dispose(); try { unsubscribeTelemetry?.(); } catch { /* telemetry can already be gone */ } settingsItem?.remove(); clearTimeout(draftTimer); channel?.close();
    window.removeEventListener("popstate", onRoute);
    window.removeEventListener("hashchange", onRoute);
    for (const [key, method] of historyMethods) if (history[key] === method.wrapped) history[key] = method.original;
    document.removeEventListener("input", onInput, true); document.removeEventListener("keydown", onKeys, true); document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("scroll", onViewportChange, true); window.removeEventListener("resize", onViewportChange); closeMenu(); root.remove(); delete window.__modsForT3Code;
  } };
  connectTelemetry();
  await reload();
  log("Host", options.safeMode ? "Safe mode enabled" : "Ready");
}
