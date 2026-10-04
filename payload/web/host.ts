import type { BandPart, ModBundle, ModRecord } from "../../sdk.d.ts";
import type { ModArtifact, ModArtifactApi, TelemetryApi } from "../telemetry-types.ts";
import { MAX_BUNDLE_BYTES, PERMISSIONS, usageSnapshot, validateBundle } from "./manifest.ts";
import { database } from "./database.ts";
import { updateLegacyWeather } from "./builtin-updates.ts";
import type { PendingRecord, PendingSource } from "./database.ts";
import { ModRuntime } from "./runtime.ts";
import { MODS_ICON, attachSidebarButton, composer, dockAboveComposer, dockContextControl, insertDraft, readDraft, sidebarFooter } from "./adapter.ts";
import { authorPrompt, editPrompt, fixPrompt } from "./author.ts";
import type { EditSource } from "./author.ts";
import { style } from "./style.ts";
import { ThemeHost } from "./themes.ts";
import { routePath } from "./route.ts";
import { ContextUsageView } from "./context-usage.ts";

type MenuEntry = readonly [text: string, action: () => void, className?: string];
type SeenInbox = { [hash: string]: number };
// What the manager shows instead of the tabs: a review of a pending or built-in bundle, or an installed mod's details.
type Review = { bundle: ModBundle; entry?: PendingRecord; detailsOnly?: boolean };
// The Edit form for an installed or built-in mod, and the view Cancel returns to.
type Editing = { id: string; back?: Review };
// A complete bundle from chat that cannot be installed as sent. Kept visible until dismissed or replaced.
type Problem = { hash: string; id?: string; name: string; error: string };
type Flash = { tone: "error" | "info"; text: string };
type StateKey = "active" | "starting" | "stopped" | "off";

export interface ImportSource {
  /** Automatic delivery (inbox folder or a chat reply): deduplicated and never opened without the user. */
  inbox?: boolean;
  from?: PendingSource;
  threadId?: string;
  messageId?: string;
}
export interface MountOptions {
  safeMode?: boolean;
  inbox?: string;
  examples?: readonly ModBundle[];
  sandboxDocument: string;
}
export interface ModsHost {
  open(tab?: string): void;
  importCandidate(value: unknown, source?: ImportSource): Promise<void>;
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
const badge = (text: string, state: string) => node("span", { class: "state", "data-state": state, text });
const meta = (text: string) => node("div", { class: "meta", text });
const MORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
const note = (text: string) => node("div", { class: "row" }, [node("p", { class: "explain", text })]);
const MAX_RENDERED_BLOCKS = 20;
const MAX_PENDING = 20;
const BUNDLE_HINT = '"t3mod/1"';
const SOURCES: readonly PendingSource[] = ["chat", "inbox", "file", "paste"];
const SOURCE_LABEL: { readonly [S in PendingSource]: string } = { chat: "From a chat reply", inbox: "From the mods inbox", file: "From a file", paste: "Pasted" };
// Pages and editors the manager must never read bundles from: its own UI and anything the user is typing.
const NOT_A_REPLY = '#mods-for-t3-code-host, [data-t3mods], [contenteditable="true"], textarea, [data-chat-composer-form]';

function seenMap(value: unknown): SeenInbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const seen: SeenInbox = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "number") seen[key] = item;
  return seen;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
const sameBundle = (left: ModBundle, right: ModBundle) => left.code === right.code && JSON.stringify(left.manifest) === JSON.stringify(right.manifest);
const isSource = (value: unknown): value is PendingSource => SOURCES.some((source) => source === value);

function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return new Date(time).toLocaleDateString();
}

// Name and id of something that looks like a bundle, for messages about bundles that failed validation.
function describeInvalid(value: unknown): { id?: string; name: string } {
  const manifest: unknown = value && typeof value === "object" ? Reflect.get(value, "manifest") : undefined;
  const field = (key: string) => {
    const item: unknown = manifest && typeof manifest === "object" ? Reflect.get(manifest, key) : undefined;
    return typeof item === "string" && item.trim() ? item.trim().slice(0, 100) : undefined;
  };
  const id = field("id");
  return { ...(id ? { id } : {}), name: field("name") ?? id ?? "Mod from chat" };
}

// Fenced blocks in copied reply text, with their info string (t3mod, t3mod-manifest, t3mod-code, json…).
function fences(text: string): { info: string; body: string }[] {
  const blocks: { info: string; body: string }[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/.exec(lines[index] ?? "");
    if (!opening) continue;
    const [, fence = "", info = ""] = opening;
    const start = index + 1;
    for (index = start; index < lines.length && !new RegExp(`^ {0,3}${fence[0] === "~" ? "~" : "`"}{${fence.length},}[ \\t]*$`).test(lines[index] ?? ""); index++);
    blocks.push({ info: info.toLowerCase(), body: lines.slice(start, index).join("\n") });
  }
  return blocks;
}
function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text.trim()) as unknown; } catch (error) { throw new Error(`The ${what} is incomplete or not valid JSON (${messageText(error)}). Copy the whole code block and try again.`); }
}
// Accepts raw bundle JSON, a copied reply with one bundle block, or a reply with
// paired t3mod-manifest and t3mod-code blocks (the code stays raw JavaScript).
function bundleFromText(input: string): unknown {
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
  if (!bundle) throw new Error("No mod found. Paste the whole reply, its t3mod-manifest and t3mod-code blocks, or bundle JSON that starts with {\"format\":\"t3mod/1\".");
  if (bundles.length > 1) throw new Error("This text contains more than one bundle. Paste one at a time.");
  return parseJson(bundle.body, "bundle");
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
  const contextRoot = node("div", { "data-t3mods": "context", style: "display:flex;align-items:center;flex:none" });
  const contextShadow = contextRoot.attachShadow({ mode: "open" });
  contextShadow.append(node("style", { text: style }));
  const contextDock = dockContextControl(contextRoot);
  const contextViews = new Map<string, ContextUsageView>();
  let records: ModRecord[] = [];
  const runtimes = new Map<string, ModRuntime>();
  const readyRuntimes = new WeakSet<ModRuntime>();
  const commands = new Map<string, Map<string, { id: string; title: string }>>();
  const panels = new Map<string, { title: string; body: string; actions: { id: string; label: string }[] }>();
  const bands = new Map<string, BandPart[]>();
  const themes = new ThemeHost();
  const logs: string[] = [];
  const notices: HTMLElement[] = [];
  let paused = Boolean(await database.getSetting("paused"));
  let development = Boolean(await database.getSetting("development"));
  let seenInbox = seenMap(await database.getSetting("seenInbox"));
  let pending: PendingRecord[] = [];
  const problems: Problem[] = [];
  let tab = "installed";
  let review: Review | undefined;
  let editing: Editing | undefined;
  // Requested changes per mod id, kept across re-renders, errors, and closing the manager.
  const editTexts = new Map<string, string>();
  let flash: Flash | undefined;
  let createText = "";
  let importText = "";
  let importError: string | undefined;
  let busy = false;
  let trayOpen = true;
  let lastPath = routePath();
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let channel: BroadcastChannel | undefined;
  let inlineContent: HTMLElement | undefined;
  let inlineDisplay = "";
  let decisionQueue: Promise<unknown> = Promise.resolve();
  let telemetry: TelemetryApi | undefined;
  let unsubscribeTelemetry: (() => void) | undefined;
  let artifacts: ModArtifactApi | undefined;
  let unsubscribeArtifacts: (() => void) | undefined;
  let menu: { popup: HTMLDivElement; trigger: HTMLButtonElement } | undefined;
  let bundleScan: ReturnType<typeof setTimeout> | undefined;
  // Last text read from each rendered block: streaming and same-length corrections are re-read.
  const scannedBlocks = new WeakMap<Element, string>();
  // Raw JavaScript has no end marker, so a rendered pair is read only after its text stops changing.
  const settlingPairs = new WeakMap<Element, { text: string; since: number }>();
  const PAIR_SETTLE_MS = 1500;
  // Deliveries wait for installed mods and pending reviews to load, then run one at a time.
  let loaded: () => void = () => undefined;
  let importQueue: Promise<unknown> = new Promise<void>((resolve) => { loaded = resolve; });

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
  // Remembered hashes are installed or dismissed: the same chat reply never asks again.
  async function remember(hash: string | undefined): Promise<void> {
    if (!hash) return;
    seenInbox[hash] = Date.now();
    seenInbox = Object.fromEntries(Object.entries(seenInbox).sort((left, right) => right[1] - left[1]).slice(0, 200));
    await database.setSetting("seenInbox", seenInbox);
  }
  // Pending reviews survive closing the manager, navigation, reloads, and restarts.
  async function loadPending(): Promise<PendingRecord[]> {
    const stored = await database.getSetting("pending");
    if (!Array.isArray(stored)) return [];
    const result: PendingRecord[] = [];
    for (const item of stored as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const { bundle, hash, source, receivedAt, threadId, messageId } = item as { [key: string]: unknown };
      if (typeof hash !== "string" || !isSource(source)) continue;
      try {
        result.push({ bundle: validateBundle(bundle), hash, source, receivedAt: typeof receivedAt === "number" ? receivedAt : Date.now(), ...(typeof threadId === "string" ? { threadId } : {}), ...(typeof messageId === "string" ? { messageId } : {}) });
      } catch { /* this version can no longer install it; drop it */ }
    }
    return result.slice(-MAX_PENDING);
  }
  async function savePending(): Promise<void> { await database.setSetting("pending", pending); }
  function leaveInline(): void {
    if (!inlineContent) return;
    inlineContent.style.display = inlineDisplay;
    inlineContent = undefined; root.removeAttribute("data-inline");
    dialog.removeAttribute("data-inline"); dialog.close(); document.body.append(root);
    styleSettingsControl(false);
  }
  function closeManager(): void { if (inlineContent) leaveInline(); else dialog.close(); }
  function go(key: string): void { tab = key; review = undefined; editing = undefined; flash = undefined; render(); }
  function showReview(next: Review): void {
    review = next; editing = undefined; flash = undefined;
    render(); if (!dialog.open) dialog.showModal();
  }

  function notify(name: string, text: string, action?: readonly [label: string, run: () => void]): void {
    const notice = node("div", { class: "notice", role: "status" }, [node("strong", { text: name }), node("span", { text })]);
    if (action) notice.append(node("div", { class: "actions" }, [button(action[0], () => { notice.remove(); action[1](); }, "xs")]));
    for (const old of notices.splice(0)) old.remove();
    notices.push(notice); shadow.append(notice);
    setTimeout(() => { notice.remove(); const index = notices.indexOf(notice); if (index >= 0) notices.splice(index, 1); }, action ? 12000 : 6000);
  }
  function log(name: string, text: string): void {
    logs.push(`${new Date().toLocaleTimeString()}  ${name}: ${text}`);
    if (logs.length > 100) logs.shift();
    if (dialog.open && !review && tab === "console") render();
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
  function renderContext(): void {
    const usage = currentUsage();
    for (const view of contextViews.values()) view.update(usage);
    contextDock.show(contextViews.size > 0 && usage !== null);
  }
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
        renderContext();
        for (const runtime of runtimes.values()) runtime.emit(event.name, value);
      });
    } catch { telemetry = undefined; }
  }
  // Complete bundles from native assistant replies, including ones T3 has not rendered.
  // The trusted preload owns the bridge; mod workers never see it.
  function connectArtifacts(): void {
    const api = window.__T3_MODS_ARTIFACTS__;
    if (artifacts || disposed || typeof api?.subscribe !== "function" || typeof api.get !== "function") return;
    artifacts = api;
    try {
      unsubscribeArtifacts = api.subscribe((artifact) => void receiveArtifact(artifact));
      for (const artifact of api.get()) void receiveArtifact(artifact);
    } catch {
      try { unsubscribeArtifacts?.(); } catch { /* bridge already gone */ }
      unsubscribeArtifacts = undefined; artifacts = undefined;
    }
  }
  function receiveArtifact(artifact: ModArtifact): Promise<void> {
    if (!artifact || typeof artifact !== "object" || typeof artifact.threadId !== "string" || typeof artifact.messageId !== "string") return Promise.resolve();
    const source: ImportSource = { inbox: true, from: "chat", threadId: artifact.threadId, messageId: artifact.messageId };
    // A complete reply whose mod could not be assembled or parsed: show why instead of dropping it.
    const { error } = artifact;
    if (typeof error === "string" && error) return enqueue(() => reportProblem(artifact.bundle, new Error(error.slice(0, 1000)), artifact.messageId));
    return importCandidate(artifact.bundle, source);
  }
  function stateOf(record: ModRecord): readonly [label: string, key: StateKey] {
    if (options.safeMode) return ["Safe mode", "off"];
    if (record.quarantined) return ["Stopped", "stopped"];
    if (!record.enabled) return ["Off", "off"];
    if (paused) return ["Paused", "off"];
    const runtime = runtimes.get(record.manifest.id);
    if (runtime && readyRuntimes.has(runtime)) return ["Active", "active"];
    return runtime ? ["Starting", "starting"] : ["Off", "off"];
  }
  const recordFor = (id: string) => records.find((record) => record.manifest.id === id);
  function refresh(): void { if (dialog.open && !review && !editing && !busy && (tab === "installed" || tab === "examples")) render(); renderTray(); }
  function start(record: ModRecord): void {
    if (paused || options.safeMode || !record.enabled || record.quarantined || runtimes.has(record.manifest.id)) return;
    const runtime = new ModRuntime(record, {
      ready: (current) => { readyRuntimes.add(current); log(record.manifest.name, "Loaded"); refresh(); },
      command: (_runtime, command) => {
        const entries = commands.get(record.manifest.id) ?? new Map<string, { id: string; title: string }>();
        if (entries.size >= 20 && !entries.has(command.id)) throw new Error("A mod can register up to 20 commands.");
        entries.set(command.id, command); commands.set(record.manifest.id, entries);
      },
      panel: (_runtime, panel) => { if (panel) panels.set(record.manifest.id, panel); else panels.delete(record.manifest.id); renderTray(); },
      notify: (_runtime, text) => notify(record.manifest.name, text),
      theme: (_runtime, colors) => { if (colors) themes.set(record.manifest.id, colors); else themes.clear(record.manifest.id); },
      band: (_runtime, parts) => { if (parts) bands.set(record.manifest.id, parts); else bands.delete(record.manifest.id); renderBands(); },
      context: (_runtime, enabled) => {
        const id = record.manifest.id;
        if (enabled && !contextViews.has(id)) {
          const view = new ContextUsageView(); contextViews.set(id, view); contextShadow.append(view.root);
        } else if (!enabled) { contextViews.get(id)?.dispose(); contextViews.delete(id); }
        renderContext();
      },
      usage: currentUsage,
      readDraft,
      insertDraft: async (current, text) => {
        if (!await ask(`${record.manifest.name} wants to add to your draft`, `This text will be pasted at the end. Nothing will be sent.\n\n${text}`, "Add to draft") || current.stopped) return false;
        insertDraft(text); return true;
      },
      log: (_runtime, text) => log(record.manifest.name, text),
      removed: (current) => {
        if (runtimes.get(record.manifest.id) !== current) return;
        runtimes.delete(record.manifest.id); commands.delete(record.manifest.id); panels.delete(record.manifest.id); bands.delete(record.manifest.id); themes.clear(record.manifest.id); renderBands(); refresh();
        contextViews.get(record.manifest.id)?.dispose(); contextViews.delete(record.manifest.id); renderContext();
      },
      fault: async (_runtime, reason) => {
        record.enabled = false; record.quarantined = reason;
        await database.save(record); broadcast();
        log(record.manifest.name, reason); notify(record.manifest.name, `Stopped: ${reason}`, ["Open Mods", () => open("installed")]); refresh();
      },
    }, options.sandboxDocument);
    runtimes.set(record.manifest.id, runtime);
  }
  function stop(id: string): void { runtimes.get(id)?.stop(); }
  function broadcast(): void { channel?.postMessage("refresh"); }
  async function reload(): Promise<void> {
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
    if (reviewing && !pending.some((entry) => entry.hash === reviewing.hash)) review = undefined;
    for (const [id, runtime] of runtimes) {
      const record = records.find((item) => item.manifest.id === id);
      if (paused || !record?.enabled || record.quarantined || record.code !== runtime.record.code || JSON.stringify(record.manifest) !== JSON.stringify(runtime.record.manifest)) stop(id);
    }
    for (const record of records) start(record);
    refresh();
  }
  // Without a tab, reopening resumes a pending review or an unfinished edit; reviews are also listed under Waiting for review.
  function open(nextTab?: string): void {
    leaveInline();
    if (nextTab) editing = undefined;
    if (nextTab || !review?.entry) { tab = nextTab ?? "installed"; review = undefined; }
    flash = undefined; render(); if (!dialog.open) dialog.showModal();
  }
  function openSettings(): void {
    const inset = document.querySelector('[data-slot="sidebar-inset"]');
    const content = inset?.firstElementChild?.lastElementChild;
    if (!(content instanceof HTMLElement) || content.tagName === "HEADER" || !content.parentElement) { open(); return; }
    leaveInline(); if (dialog.open) dialog.close();
    inlineContent = content; inlineDisplay = content.style.display; content.style.display = "none";
    root.setAttribute("data-inline", "true"); dialog.setAttribute("data-inline", "true");
    content.parentElement.append(root);
    if (!review?.entry) { tab = "installed"; review = undefined; }
    flash = undefined; render(); dialog.open = true;
    styleSettingsControl(true);
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true; flash = undefined;
    dialog.setAttribute("aria-busy", "true");
    for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button, input, textarea")) control.disabled = true;
    try { await action(); } catch (error) {
      const text = messageText(error); log("Host", text);
      // Show the failure where the user acted; the manager covers page notices.
      if (dialog.open) flash = { tone: "error", text }; else notify("Mods for T3 Code", text);
    } finally { busy = false; dialog.removeAttribute("aria-busy"); render(); }
  }
  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = importQueue.then(() => disposed ? undefined : task());
    importQueue = next.catch(() => undefined); return next;
  }
  // Re-render for new deliveries, but never under someone typing a description or a paste.
  function changed(): void { if (dialog.open && !busy && (!review || review.entry) && !(shadow.activeElement instanceof HTMLTextAreaElement)) render(); }
  // Bundles from chat that parse but cannot install stay visible with the reason and a fix action.
  async function reportProblem(value: unknown, error: unknown, salt = ""): Promise<void> {
    let hash: string;
    try { hash = await digest(`${salt}\n${messageText(error)}\n${JSON.stringify(value) ?? ""}`); } catch { return; }
    if (seenInbox[hash] || problems.some((problem) => problem.hash === hash)) return;
    const { id, name } = describeInvalid(value);
    problems.push({ hash, ...(id ? { id } : {}), name, error: messageText(error) });
    if (problems.length > 10) problems.shift();
    log(name, `Can’t install: ${messageText(error)}`);
    if (dialog.open) changed(); else notify(name, "This mod can’t be installed as sent. Open Mods to see why and ask for a fix.", ["Open Mods", () => open("installed")]);
  }
  // Validates and queues a bundle for review. Explicit imports open the review; deliveries from
  // chat or the inbox are listed under Waiting for review once, without taking over the window.
  async function accept(value: unknown, source: ImportSource): Promise<void> {
    const automatic = Boolean(source.inbox);
    const bundle = validateBundle(value);
    const hash = await digest(JSON.stringify(bundle));
    const { manifest } = bundle;
    const solved = problems.findIndex((problem) => problem.id === manifest.id);
    if (solved >= 0) problems.splice(solved, 1);
    const installed = recordFor(manifest.id);
    if (installed && sameBundle(installed, bundle)) {
      if (pending.some((entry) => entry.hash === hash)) { pending = pending.filter((entry) => entry.hash !== hash); await savePending(); changed(); }
      if (!automatic) { tab = "installed"; review = undefined; flash = { tone: "info", text: `${manifest.name} ${manifest.version} is already installed.` }; render(); if (!dialog.open) dialog.showModal(); }
      return;
    }
    if (automatic && seenInbox[hash]) return;
    const existing = pending.find((entry) => entry.hash === hash);
    if (existing) { if (!automatic) showReview({ bundle: existing.bundle, entry: existing }); return; }
    const superseded = pending.filter((entry) => entry.bundle.manifest.id === manifest.id);
    if (automatic && development && installed?.enabled && installed.manifest.author === manifest.author && manifest.permissions.every((permission) => installed.manifest.permissions.includes(permission))) {
      const record: ModRecord = { ...bundle, enabled: true, quarantined: null };
      await database.save(record); await remember(hash);
      pending = pending.filter((entry) => !superseded.includes(entry)); await savePending();
      if (review?.entry && superseded.includes(review.entry)) review = undefined;
      records = await database.list(); stop(manifest.id); start(recordFor(manifest.id) ?? record); broadcast();
      notify(manifest.name, `Updated to ${manifest.version} and reloaded.`); changed(); return;
    }
    const from = source.from ?? (source.threadId ? "chat" : automatic ? "inbox" : "file");
    const entry: PendingRecord = { bundle, hash, source: from, receivedAt: Date.now(), ...(source.threadId ? { threadId: source.threadId } : {}), ...(source.messageId ? { messageId: source.messageId } : {}) };
    // A newer bundle for the same mod replaces the older one waiting for review.
    pending = [...pending.filter((item) => !superseded.includes(item)), entry].slice(-MAX_PENDING);
    await savePending(); broadcast();
    if (!automatic) { showReview({ bundle, entry }); return; }
    if (review?.entry && superseded.includes(review.entry)) review = { bundle, entry };
    if (dialog.open) changed();
    else notify(manifest.name, installed ? `Update ${manifest.version} is ready to review.` : "Ready to review. Nothing runs until you install it.", ["Review", () => showReview({ bundle, entry })]);
  }
  function importCandidate(value: unknown, source: ImportSource = {}): Promise<void> {
    return enqueue(async () => {
      try { await accept(value, source); } catch (error) {
        if (source.inbox) await reportProblem(value, error, source.messageId);
        else if (dialog.open && !busy) { flash = { tone: "error", text: `Can’t import this mod: ${messageText(error)}` }; render(); }
        else notify("Can’t import mod", messageText(error));
      }
    });
  }
  // Fallback for builds without the native bridge: read finished blocks T3 has rendered.
  // The manager's own source view, the composer, and other editors are never read.
  function scheduleBundleScan(delay = 400): void {
    if (bundleScan !== undefined || disposed) return;
    bundleScan = setTimeout(() => { bundleScan = undefined; void scanRenderedBundles(); }, delay);
  }
  async function scanRenderedBundles(): Promise<void> {
    if (disposed) return;
    const blocks = [...document.querySelectorAll("pre")].filter((block) => !block.closest(NOT_A_REPLY)).slice(-MAX_RENDERED_BLOCKS);
    let manifest: string | undefined;
    for (const block of blocks) {
      if (disposed) return;
      const code = block.querySelector("code") ?? block;
      const text = code.textContent ?? "";
      // Paired blocks: a rendered t3mod-manifest followed by its t3mod-code.
      const kind = /\blanguage-t3mod-(manifest|code)\b/.exec(code.className)?.[1];
      if (kind === "manifest") { manifest = text; continue; }
      const pair = kind === "code" && manifest !== undefined ? manifest : undefined;
      manifest = undefined;
      const seen = pair === undefined ? text : `${pair}\n${text}`;
      if (scannedBlocks.get(block) === seen) continue;
      if (pair !== undefined) {
        const settling = settlingPairs.get(block);
        if (settling?.text !== seen) { settlingPairs.set(block, { text: seen, since: Date.now() }); scheduleBundleScan(PAIR_SETTLE_MS); continue; }
        if (Date.now() - settling.since < PAIR_SETTLE_MS) { scheduleBundleScan(PAIR_SETTLE_MS - (Date.now() - settling.since)); continue; }
      }
      scannedBlocks.set(block, seen);
      let value: unknown;
      if (pair !== undefined) {
        if (!text.trim() || pair.length + text.length > MAX_BUNDLE_BYTES) continue;
        try { value = { format: "t3mod/1", manifest: JSON.parse(pair) as unknown, code: text }; } catch { continue; } // still streaming
      } else {
        const trimmed = text.trim();
        if (trimmed.length > MAX_BUNDLE_BYTES || !trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(BUNDLE_HINT)) continue;
        try { value = JSON.parse(trimmed); } catch { continue; } // still streaming; read again when it changes
      }
      await importCandidate(value, { inbox: true, from: "chat" });
    }
  }
  function pickFile(): void {
    const input = node("input", { type: "file", accept: ".t3mod,application/json" });
    input.onchange = () => void run(async () => {
      const file = input.files?.[0]; if (!file) return;
      importError = undefined;
      try {
        if (file.size > MAX_BUNDLE_BYTES) throw new Error("Mod bundles must be smaller than 1 MB.");
        let value: unknown;
        try { value = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not a valid .t3mod file. Check that it is the complete bundle.`); }
        await accept(value, { from: "file" });
      } catch (error) { importError = `${file.name}: ${messageText(error)}`; review = undefined; tab = "import"; if (!dialog.open) dialog.showModal(); }
    }); input.click();
  }
  function reviewPaste(): void {
    void run(async () => {
      importError = undefined;
      try { await accept(bundleFromText(importText), { from: "paste" }); importText = ""; } catch (error) { importError = messageText(error); }
    });
  }
  function download(record: ModRecord): void {
    const blob = new Blob([JSON.stringify({ format: record.format, manifest: record.manifest, code: record.code }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = node("a", { href: url, download: `${record.manifest.id}.t3mod` });
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function draftInChat(text: string | (() => string), done?: () => void): void {
    void run(async () => {
      const request = typeof text === "string" ? text : text();
      if (!composer()) throw new Error("Open a chat thread first, then try again. The request goes into that thread’s composer.");
      closeManager(); insertDraft((readDraft() ? "\n\n" : "") + request); done?.();
    });
  }
  // Edits start from the installed copy, keeping earlier changes; otherwise from the included built-in.
  function editSource(id: string): EditSource | undefined {
    const installed = recordFor(id);
    const example = (options.examples ?? []).find((item) => item.manifest.id === id);
    if (installed) return { bundle: validateBundle(installed), installed: true, builtIn: Boolean(example) };
    return example ? { bundle: validateBundle(example), installed: false, builtIn: true } : undefined;
  }
  function showEdit(id: string, back?: Review): void {
    editing = { id, ...(back ? { back } : {}) }; review = undefined; flash = undefined;
    render(); if (!dialog.open) dialog.showModal();
  }
  async function install(current: Review): Promise<void> {
    const { bundle, entry } = current;
    const { manifest } = bundle;
    // Confirming the review is the consent to run it; pause and safe mode still win in start().
    const record: ModRecord = { ...bundle, enabled: true, quarantined: null };
    await database.save(record);
    await remember(entry?.hash);
    if (pending.some((item) => item === entry || sameBundle(item.bundle, bundle))) { pending = pending.filter((item) => item !== entry && !sameBundle(item.bundle, bundle)); await savePending(); }
    records = await database.list(); review = undefined; tab = "installed";
    // The previous version keeps running until the new one is saved.
    stop(manifest.id); start(recordFor(manifest.id) ?? record); broadcast();
    notify(manifest.name, options.safeMode ? "Installed. Mods are off in safe mode." : paused ? "Installed. It will start when you resume mods." : "Installed and switched on.");
  }
  async function dismiss(entry: PendingRecord): Promise<void> {
    await remember(entry.hash);
    pending = pending.filter((item) => item.hash !== entry.hash); await savePending();
    if (review?.entry?.hash === entry.hash) review = undefined;
    broadcast();
  }
  async function dismissProblem(problem: Problem): Promise<void> {
    await remember(problem.hash);
    const index = problems.indexOf(problem); if (index >= 0) problems.splice(index, 1);
  }
  function enableToggle(record: ModRecord): HTMLInputElement {
    const { manifest } = record;
    const control = toggle(record.enabled, `Enable ${manifest.name}`, Boolean(options.safeMode) || busy);
    control.onchange = () => void run(async () => { stop(manifest.id); record.enabled = control.checked; record.quarantined = null; await database.save(record); start(record); broadcast(); });
    return control;
  }
  function retry(record: ModRecord): void {
    void run(async () => { stop(record.manifest.id); record.enabled = true; record.quarantined = null; await database.save(record); start(record); broadcast(); });
  }
  function stateBadge(record: ModRecord): HTMLElement { const [label, key] = stateOf(record); return badge(label, key); }
  function installedRow(record: ModRecord): HTMLElement {
    const { manifest } = record;
    const count = manifest.permissions.length;
    const reason = record.quarantined;
    const items: MenuEntry[] = [["Details", () => showReview({ bundle: validateBundle(record), detailsOnly: true })], ["Edit", () => showEdit(manifest.id)]];
    if (reason) items.push(["Ask AI to fix", () => draftInChat(fixPrompt(manifest.name, manifest.id, manifest.version, reason))]);
    items.push(["Export", () => download(record)], ["Remove", () => void run(async () => {
      if (!await ask(`Remove ${manifest.name}?`, "The mod and its private data will be removed. Export it first if you want a copy.", "Remove mod", true)) return;
      stop(manifest.id); await database.remove(manifest.id); records = records.filter((item) => item !== record); broadcast();
    }), "danger"]);
    const controls: Node[] = [...(reason && !options.safeMode ? [button("Retry", () => retry(record), "xs")] : []), moreButton(`More actions for ${manifest.name}`, items), enableToggle(record)];
    const element = row([document.createTextNode(manifest.name), stateBadge(record)], manifest.description, controls, [
      meta(`${manifest.version} · ${manifest.author} · ${count} permission${count === 1 ? "" : "s"}`),
      ...(reason ? [node("p", { class: "error", text: `Stopped: ${reason.replace(/\.?\s*$/, ".")} Retry, or ask your AI for a fix from the menu.` })] : []),
    ]);
    element.dataset.mod = manifest.id; return element;
  }
  function pendingRow(entry: PendingRecord): HTMLElement {
    const { manifest } = entry.bundle;
    const installed = recordFor(manifest.id);
    const element = row([document.createTextNode(manifest.name), badge(installed ? "Update" : "New", "pending")], manifest.description, [
      moreButton(`More actions for ${manifest.name}`, [["Dismiss", () => void run(() => dismiss(entry)), "danger"]]),
      button("Review", () => showReview({ bundle: entry.bundle, entry }), "primary xs"),
    ], [meta(`${installed ? `${installed.manifest.version} → ` : ""}${manifest.version} · ${manifest.author} · ${SOURCE_LABEL[entry.source]} · ${ago(entry.receivedAt)}`)]);
    element.dataset.pending = manifest.id; return element;
  }
  function problemRow(problem: Problem): HTMLElement {
    return row([document.createTextNode(problem.name), badge("Can’t install", "stopped")], "", [
      moreButton(`More actions for ${problem.name}`, [["Dismiss", () => void run(() => dismissProblem(problem)), "danger"]]),
      button("Ask AI to fix", () => draftInChat(fixPrompt(problem.name, problem.id, undefined, problem.error)), "xs"),
    ], [node("p", { class: "error", text: problem.error }), meta("From a chat reply · nothing was installed")]);
  }
  function render(): void {
    closeMenu();
    const actions: Node[] = [button("Import", () => go("import"), "xs")];
    if (!inlineContent) actions.push(closeButton(closeManager));
    dialog.replaceChildren(node("header", {}, [node("div", {}, [node("h1", { text: "Mods" }), node("p", { text: "Local add-ons for T3 Code. Each mod runs isolated and can be switched off at any time." })]), node("div", { class: "header-actions" }, actions)]));
    if (editing) { renderEdit(editing); return; }
    if (review) { renderReview(review); return; }
    const waiting = pending.length + problems.length;
    dialog.append(node("nav", { class: "tabs", "aria-label": "Mod manager" }, [["installed", "Installed"], ["examples", "Built-in"], ["commands", "Commands"], ["create", "Create"], ["console", "Activity"]].map(([key = "", text = ""]) => {
      const item = button(text, () => go(key)); item.setAttribute("aria-selected", String(tab === key));
      if (key === "installed" && waiting) item.append(node("span", { class: "count", text: String(waiting), title: `${waiting} waiting for review` }));
      return item;
    })));
    const content = node("div", { class: "content" }); dialog.append(content);
    if (flash) content.append(node("p", { class: "flash", "data-tone": flash.tone, role: flash.tone === "error" ? "alert" : "status", text: flash.text }));
    if (tab === "installed") {
      if (waiting) content.append(section("Waiting for review", [...pending.map(pendingRow), ...problems.map(problemRow)], meta("Nothing runs until you install it")));
      const list = records.map(installedRow);
      if (!list.length) list.push(row("No mods installed", "Try a built-in mod, import a .t3mod file, or describe one and let your AI build it.", [button("Built-in", () => go("examples"), "xs"), button("Create", () => go("create"), "xs")]));
      const active = records.filter((record) => stateOf(record)[1] === "active").length;
      content.append(section("Installed", list, meta(options.safeMode ? "Safe mode" : `${records.length} installed · ${active} active`)));
      const pause = toggle(paused, "Pause all mods", Boolean(options.safeMode) || busy);
      pause.onchange = () => void run(async () => { paused = pause.checked; if (paused) for (const id of [...runtimes.keys()]) stop(id); await database.setSetting("paused", paused); broadcast(); await reload(); });
      const dev = toggle(development, "Development mode");
      dev.onchange = () => void run(async () => { development = dev.checked; await database.setSetting("development", development); });
      content.append(section("General", [
        row("Pause all mods", options.safeMode ? "Safe mode is on, so all mod code is off." : "Stops every mod immediately. Use this if something misbehaves.", [pause]),
        row("Development mode", "Load updates from chat into an enabled mod right away when the author is the same and no new permissions are needed. New permissions always need review.", [dev]),
      ]));
    } else if (tab === "examples") {
      const list = (options.examples ?? []).map((example) => {
        const bundle = validateBundle(example);
        const { manifest } = bundle;
        const installed = recordFor(manifest.id);
        const more = moreButton(`More actions for ${manifest.name}`, [["Edit", () => showEdit(manifest.id)]]);
        if (!installed) {
          const element = row(manifest.name, manifest.description, [more, button("Review", () => showReview({ bundle }), "xs")], [meta(`${manifest.version} · not installed`)]);
          element.dataset.example = manifest.id; return element;
        }
        const current = sameBundle(installed, bundle);
        const element = row([document.createTextNode(manifest.name), stateBadge(installed)], manifest.description, [
          more,
          ...(current ? [] : [button("Review update", () => showReview({ bundle }), "xs")]),
          ...(installed.quarantined && !options.safeMode ? [button("Retry", () => retry(installed), "xs")] : []),
          enableToggle(installed),
        ], [meta(current ? `${manifest.version} · installed` : `${installed.manifest.version} installed · ${manifest.version} included`)]);
        element.dataset.mod = manifest.id; element.dataset.example = manifest.id; return element;
      });
      content.append(section("Built-in", list.length ? list : [note("No built-in mods in this build.")]), node("p", { class: "explain", text: "Included with Mods for T3 Code. Review one to install it; it starts right away and you can switch it off here or under Installed. Context Usage opens a token inspector; Token Weather shows a compact usage forecast." }));
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
      const description = node("textarea", { placeholder: "A focus timer with a start button and a reminder after 25 minutes…", "aria-label": "Describe your mod", maxLength: 5000, value: createText });
      description.oninput = () => { createText = description.value; };
      const request = () => { if (!createText.trim()) throw new Error("Describe what your mod should do first."); return authorPrompt(createText, options.inbox); };
      const step = (text: string) => node("li", { text });
      if (pending.length) content.append(section("Waiting for review", pending.map(pendingRow)));
      content.append(section("Create with your AI", [node("div", { class: "body" }, [
        node("label", { text: "What should your mod do?" }), description,
        node("ol", { class: "steps" }, [
          step("Draft in T3 adds a request to the open chat’s composer. Send it with the model and account you already use."),
          step("Your AI’s reply returns the mod. It appears here and under Installed, waiting for your review."),
          step("Review its permissions and install. It turns on right away, no restart needed."),
          step("Want changes? Ask in the same chat, then review the update."),
        ]),
        node("div", { class: "actions" }, [
          button("Copy request", () => void run(async () => { await navigator.clipboard.writeText(request()); flash = { tone: "info", text: "Request copied. Paste it into a T3 chat and send it." }; }), "xs"),
          button("Draft in T3", () => draftInChat(request()), "primary xs"),
        ]),
      ])]), node("p", { class: "explain", text: "Reply finished but nothing to review? Copy the whole reply and paste it under Import." }));
    } else if (tab === "import") {
      const text = node("textarea", { class: "code", placeholder: "Paste the AI reply with the mod, or a .t3mod bundle’s JSON…", "aria-label": "Paste a mod bundle", spellcheck: false, value: importText });
      text.oninput = () => { importText = text.value; };
      content.append(section("Import", [
        row("From a file", "A .t3mod file you saved or were given.", [button("Choose file…", pickFile, "xs")]),
        node("div", { class: "body" }, [
          node("label", { text: "Or paste a bundle" }), text,
          ...(importError ? [node("p", { class: "error", role: "alert", text: importError })] : []),
          node("p", { class: "explain", text: "Paste the whole AI reply, its two mod code blocks, or bundle JSON. You review permissions before anything runs." }),
          node("div", { class: "actions" }, [button("Review", reviewPaste, "primary xs")]),
        ]),
      ]));
    } else {
      content.append(section("Activity", [node("pre", { class: "log", text: logs.join("\n") || "No mod activity yet." })], button("Clear", () => { logs.length = 0; render(); }, "ghost xs")), node("p", { class: "explain", text: "Recent mod messages and failures in this window." }));
    }
  }
  function renderReview(current: Review): void {
    const { bundle, entry, detailsOnly = false } = current;
    const { manifest } = bundle;
    const previous = recordFor(manifest.id);
    const updating = Boolean(previous) && !detailsOnly;
    const origin = detailsOnly ? (previous ? stateOf(previous)[0] : "") : entry ? `${SOURCE_LABEL[entry.source]} · ${ago(entry.receivedAt)}` : "Built-in";
    const content = node("div", { class: "content" });
    if (flash) content.append(node("p", { class: "flash", "data-tone": flash.tone, role: flash.tone === "error" ? "alert" : "status", text: flash.text }));
    content.append(node("div", { class: "review-title" }, [
      node("h2", { text: detailsOnly ? manifest.name : updating ? `Review update: ${manifest.name}` : `Review ${manifest.name}` }),
      node("p", { class: "explain", text: manifest.description }),
      meta([updating && previous ? `${previous.manifest.version} → ${manifest.version}` : manifest.version, manifest.author, origin].filter(Boolean).join(" · ")),
    ]));
    const permissions = manifest.permissions.map((permission) => node("div", { class: "row permission" }, [node("div", { class: "row-text" }, [node("span", { text: PERMISSIONS[permission] }), node("code", { text: `${permission}${updating && previous && !previous.manifest.permissions.includes(permission) ? " — new permission" : ""}` })])]));
    content.append(section(detailsOnly ? "Permissions" : "This mod asks to", permissions.length ? permissions : [note("No optional permissions.")]));
    const footer = node("div", { class: "footer actions" });
    if (detailsOnly) {
      content.append(node("details", {}, [node("summary", { text: "JavaScript source" }), node("pre", { class: "review-code", text: bundle.code })]));
      footer.append(button("Edit", () => showEdit(manifest.id, current), "xs"), button("Done", () => { review = undefined; render(); }, "xs")); dialog.append(content, footer); return;
    }
    content.append(node("p", { class: "explain", text: `Install code from authors you trust. ${updating ? "The update replaces the running version as soon as you confirm." : "The mod starts as soon as you install it."} Mod code is isolated from T3’s files and credentials, but a mod can consume browser resources and use every permission listed above.` }), node("details", {}, [node("summary", { text: "Review JavaScript source" }), node("pre", { class: "review-code", text: bundle.code })]));
    const confirm = button(updating ? "Update mod" : "Install mod", () => void run(() => install(current)), "primary xs");
    if (entry) footer.append(button("Dismiss", () => void run(() => dismiss(entry)), "ghost xs start"), button("Not now", () => { review = undefined; tab = "installed"; render(); }, "xs"), confirm);
    else footer.append(...(previous ? [] : [button("Edit", () => showEdit(manifest.id, current), "ghost xs start")]), button("Cancel", () => { review = undefined; render(); }, "xs"), confirm);
    dialog.append(content, footer);
  }
  // Asks the open chat's AI for an edited version. It returns through Waiting for review like any reply.
  function renderEdit(current: Editing): void {
    const { id } = current;
    const source = editSource(id);
    const back = () => { editing = undefined; review = current.back; flash = undefined; render(); };
    const content = node("div", { class: "content" });
    const footer = node("div", { class: "footer actions" });
    if (flash) content.append(node("p", { class: "flash", "data-tone": flash.tone, role: flash.tone === "error" ? "alert" : "status", text: flash.text }));
    if (!source) { content.append(node("p", { class: "explain", text: "This mod is no longer installed." })); footer.append(button("Back", back, "xs")); dialog.append(content, footer); return; }
    const { manifest } = source.bundle;
    const waiting = pending.some((entry) => entry.bundle.manifest.id === id);
    content.append(node("div", { class: "review-title" }, [
      node("h2", { text: `Edit ${manifest.name}` }),
      node("p", { class: "explain", text: manifest.description }),
      meta([manifest.version, manifest.author, source.installed ? "Installed" : "Built-in · not installed"].join(" · ")),
    ]));
    const text = node("textarea", { placeholder: "Also show the context window size, use shorter labels…", "aria-label": `Changes for ${manifest.name}`, maxLength: 5000, value: editTexts.get(id) ?? "" });
    text.oninput = () => { editTexts.set(id, text.value); };
    const request = () => {
      const change = (editTexts.get(id) ?? "").trim();
      if (!change) throw new Error("Describe what should change first.");
      const latest = editSource(id);
      if (!latest) throw new Error(`${manifest.name} is no longer installed.`);
      return editPrompt(change, latest, options.inbox);
    };
    content.append(section("Changes", [node("div", { class: "body" }, [
      node("label", { text: "What should change?" }), text,
      node("p", { class: "explain", text: `Draft in T3 adds a request with ${source.installed ? "your installed copy’s" : "this mod’s"} complete code to the open chat’s composer. Send it with the model and account you already use. The edited mod keeps its id and appears under Waiting for review; ${source.installed ? "the installed version keeps running until you review the update." : "nothing is installed until you review it."}${waiting ? " It replaces the update already waiting for review." : ""}` }),
    ])]));
    footer.append(
      button("Cancel", back, "xs"),
      button("Copy request", () => void run(async () => { await navigator.clipboard.writeText(request()); flash = { tone: "info", text: "Request copied. Paste it into a T3 chat and send it." }; }), "xs"),
      button("Draft in T3", () => draftInChat(request, () => { editTexts.delete(id); editing = undefined; }), "primary xs"),
    );
    dialog.append(content, footer);
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
  // Text changes matter too: replies stream into existing nodes and can be corrected in place.
  // Typing in the composer or the manager's own UI never triggers a scan.
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.type === "childList")) { attachSettings(); attachPanels(); }
    connectArtifacts();
    if (mutations.some((mutation) => { const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement; return Boolean(target && !target.closest(NOT_A_REPLY)); })) scheduleBundleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true }); attachSettings(); attachPanels();
  document.addEventListener("input", onInput, true);
  const onRoute = () => {
    const path = routePath();
    if (lastPath !== path) {
      lastPath = path; leaveInline(); if (settingsItem) { settingsItem.remove(); settingsItem = undefined; } attachSettings();
      connectTelemetry(); connectArtifacts();
      const usage = currentUsage();
      renderContext();
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
    contextDock.dispose();
    leaveInline(); detachSidebar(); observer.disconnect(); clearTimeout(bundleScan); panelRoot.remove(); bandDock.dispose(); try { unsubscribeTelemetry?.(); } catch { /* telemetry can already be gone */ } try { unsubscribeArtifacts?.(); } catch { /* bridge can already be gone */ } for (const notice of notices.splice(0)) notice.remove(); settingsItem?.remove(); clearTimeout(draftTimer); channel?.close();
    window.removeEventListener("popstate", onRoute);
    window.removeEventListener("hashchange", onRoute);
    for (const [key, method] of historyMethods) if (history[key] === method.wrapped) history[key] = method.original;
    document.removeEventListener("input", onInput, true); document.removeEventListener("keydown", onKeys, true); document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("scroll", onViewportChange, true); window.removeEventListener("resize", onViewportChange); closeMenu(); root.remove(); delete window.__modsForT3Code;
  } };
  connectTelemetry();
  try { await reload(); } finally { loaded(); }
  connectArtifacts(); scheduleBundleScan();
  log("Host", options.safeMode ? "Safe mode enabled" : "Ready");
}
