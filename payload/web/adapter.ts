import { routePath } from "./route.ts";

export function composer(): HTMLElement | null {
  const editors = [...document.querySelectorAll<HTMLElement>('[data-testid="composer-editor"][contenteditable="true"]')];
  return editors.find((editor) => editor.getClientRects().length > 0) ?? null;
}

export function readDraft(): string { return composer()?.innerText ?? ""; }

export function insertDraft(text: string): void {
  const editor = composer();
  if (!editor) throw new Error("Open a T3 thread with a composer, then try again.");
  // Paste through T3's editor event path; never mutate its React state or submit.
  editor.focus();
  const selection = getSelection();
  if (!selection) throw new Error("Open a T3 thread with a composer, then try again.");
  const range = document.createRange();
  range.selectNodeContents(editor); range.collapse(false);
  selection.removeAllRanges(); selection.addRange(range);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  editor.dispatchEvent(event);
  if (!event.defaultPrevented) throw new Error("This T3 editor does not support the paste adapter. Copy the text and paste it manually.");
}

// Keeps an owned one-line element just above T3's composer, outside its
// contenteditable. Upstream T3 renders <form data-chat-composer-form> as
// [banner dock (attached banners, Stash tab), div.relative > main surface].
// The band floats absolutely over the dock's empty left area, so it adds no
// layout space and isn't affected by parent gaps; when the dock shows a
// full-width banner it lifts above it. Its opaque strip (style.ts) reaches down
// to the surface, so conversation scrolling behind the footer never shows
// through. Builds without the main-surface marker fall back to an in-flow line
// before the form. React can replace any of these nodes; reattach when it does.
const FLOATING = { position: "absolute", left: "0", width: "auto", maxWidth: "none", margin: "0", zIndex: "30", pointerEvents: "none" };
/** Replace the native meter's footprint, preserving its inline display for restoration. */
export function dockContextControl(element: HTMLElement): { show(value: boolean): void; dispose(): void } {
  const fallback = dockAboveComposer(element);
  let wanted = false;
  let meter: HTMLButtonElement | null = null;
  let original: { value: string; priority: string } | undefined;
  let frame: number | undefined;
  const initialStyle = element.style.cssText;
  let inNativeSlot = false;
  function restore(): void {
    if (meter && original) {
      if (original.value) meter.style.setProperty("display", original.value, original.priority);
      else meter.style.removeProperty("display");
    }
    meter = null; original = undefined;
  }
  function place(): void {
    frame = undefined;
    if (!wanted) { restore(); inNativeSlot = false; fallback.show(false); return; }
    const editor = composer();
    const form = editor?.closest("[data-chat-composer-form]") ?? editor?.closest("form");
    // ContextWindowMeter's accessible label is more stable than generated CSS classes.
    const next = form?.querySelector<HTMLButtonElement>('button[aria-label^="Context window " i]') ?? null;
    if (next !== meter) {
      restore(); meter = next;
      if (meter) original = { value: meter.style.getPropertyValue("display"), priority: meter.style.getPropertyPriority("display") };
    }
    if (meter?.parentElement) {
      if (!inNativeSlot) { fallback.show(false); element.style.cssText = initialStyle; inNativeSlot = true; }
      if (element.nextSibling !== meter) meter.before(element);
      meter.style.setProperty("display", "none", "important");
    } else { inNativeSlot = false; fallback.show(true); }
  }
  function schedule(): void { if (frame === undefined) frame = requestAnimationFrame(place); }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    show(value) { wanted = value; place(); },
    dispose() { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); restore(); fallback.dispose(); },
  };
}

export function dockAboveComposer(element: HTMLElement): { show(value: boolean): void; dispose(): void } {
  let wanted = false;
  let frame: number | undefined;
  let observed: Element[] = [];
  const inFlow = element.style.cssText;
  const resizeObserver = new ResizeObserver(() => schedule());
  function schedule(): void { if (wanted && frame === undefined) frame = requestAnimationFrame(place); }
  function watch(...targets: Array<Element | null | undefined>): void {
    const next = targets.filter((target): target is Element => Boolean(target));
    if (next.length === observed.length && next.every((target, index) => target === observed[index])) return;
    resizeObserver.disconnect(); observed = next;
    for (const target of next) resizeObserver.observe(target);
  }
  function float(main: HTMLElement, dock: Element | null): void {
    const box = main.getBoundingClientRect();
    const parts = dock?.getClientRects().length ? [...dock.children].map((child) => child.getBoundingClientRect()).filter((rect) => rect.width && rect.height) : [];
    let lift = 0;
    let reserve = 0;
    // A wide banner or anything on the left would sit under the band: go above the dock.
    if (parts.some((rect) => rect.width > box.width / 2 || rect.left < box.left + box.width / 2)) lift = Math.max(0, box.top - Math.min(...parts.map((rect) => rect.top)));
    else if (parts.length) reserve = Math.max(0, box.right - Math.min(...parts.map((rect) => rect.left)) + 8);
    Object.assign(element.style, FLOATING, { right: `${reserve}px`, bottom: `calc(100% + ${lift}px)` });
  }
  function place(): void {
    frame = undefined;
    const editor = wanted ? composer() : null;
    if (!editor) { watch(); element.remove(); return; }
    const main = editor.closest<HTMLElement>("[data-chat-composer-main-surface]");
    const form = editor.closest<HTMLElement>("[data-chat-composer-form]") ?? editor.closest<HTMLElement>("form");
    if (main?.parentElement) {
      if (element.nextElementSibling !== main) main.before(element);
      const dock = form ? [...form.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.matches('[data-slot="composer-banner-attachment"]')) ?? null : null;
      watch(main, dock); float(main, dock); return;
    }
    watch();
    element.style.cssText = inFlow;
    const anchor = form ?? editor;
    if (!anchor.parentElement) { element.remove(); return; }
    if (element.nextElementSibling !== anchor) anchor.before(element);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true });
  return {
    show(value: boolean) { wanted = value; place(); },
    dispose() { wanted = false; observer.disconnect(); resizeObserver.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); element.remove(); },
  };
}

export const MODS_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h4v4a2 2 0 1 0 4 0V3h5v7h-4a2 2 0 1 0 0 4h4v7h-7v-4a2 2 0 1 0-4 0v4H3v-7h4a2 2 0 1 0 0-4H3V3h5Z"/></svg>';
const UTILITY_PAGE = /^\/(settings|usage|pull-requests)(\/|$)/;

export function sidebarFooter(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-sidebar="footer"]') ?? document.querySelector<HTMLElement>('[data-slot="sidebar-footer"]');
}

// The footer's icon-only utility buttons (Settings, Pull Requests, Usage).
// Their markup varies between T3 builds, so match shape rather than data-slot.
function footerReference(footer: ParentNode): HTMLButtonElement | null {
  const icons = [...footer.querySelectorAll("button[aria-label]")].filter((item): item is HTMLButtonElement => item instanceof HTMLButtonElement && !item.closest("[data-t3mods]") && !item.textContent?.trim() && Boolean(item.querySelector("svg")));
  // Prefer sidebar menu buttons; the trailing update pill is also icon-only but styled differently.
  const menuButtons = icons.filter((item) => item.classList.contains("peer/menu-button") || item.getAttribute("data-sidebar") === "menu-button" || item.getAttribute("data-slot") === "sidebar-menu-button");
  return menuButtons.at(-1) ?? icons.at(-1) ?? null;
}

// Tooltip matching T3's small popover tooltip; native ones live in a React portal we can't reuse.
function attachTooltip(target: HTMLElement, label: string): () => void {
  let tip: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function hide(): void { clearTimeout(timer); tip?.remove(); tip = undefined; }
  function show(): void {
    if (tip || !target.isConnected) return;
    tip = document.createElement("div");
    tip.dataset.t3mods = "tooltip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = label;
    tip.style.cssText = "position:fixed;z-index:2147483000;pointer-events:none;padding:4px 8px;border:1px solid var(--border,#ffffff1a);border-radius:calc(var(--radius,.625rem) - 2px);background:var(--popover,#1c1c1f);color:var(--popover-foreground,var(--foreground,#f5f5f5));font:12px/16px var(--font-sans,system-ui,sans-serif);white-space:nowrap;box-shadow:0 4px 12px #0000000d";
    document.body.append(tip);
    const box = target.getBoundingClientRect();
    const left = Math.max(4, Math.min(innerWidth - tip.offsetWidth - 4, box.left + box.width / 2 - tip.offsetWidth / 2));
    tip.style.left = `${left}px`; tip.style.top = `${Math.max(4, box.top - tip.offsetHeight - 6)}px`;
  }
  const delayed = () => { clearTimeout(timer); timer = setTimeout(show, 400); };
  target.addEventListener("pointerenter", delayed);
  target.addEventListener("pointerleave", hide);
  target.addEventListener("focus", () => { if (target.matches(":focus-visible")) show(); });
  target.addEventListener("blur", hide);
  target.addEventListener("click", hide);
  return hide;
}

export function attachSidebarButton(open: () => void): () => void {
  const label = "Mods";
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.t3mods = "sidebar-button";
  button.setAttribute("aria-label", label);
  button.innerHTML = MODS_ICON;
  button.onclick = open;
  const hideTip = attachTooltip(button, label);
  const item = document.createElement("li");
  item.dataset.t3mods = "sidebar-item";
  let reference: HTMLElement | undefined;
  let frame: number | undefined;
  // Copy presentation only; listeners and React state stay on the native button.
  function mirror(native: HTMLElement): void {
    if (reference === native) return;
    reference = native;
    button.className = native.className;
    for (const { name } of [...button.attributes]) if (name.startsWith("data-") && name !== "data-t3mods") button.removeAttribute(name);
    for (const { name, value } of native.attributes) if (/^data-(slot|sidebar|size|variant)$/.test(name)) button.setAttribute(name, value);
    button.style.cssText = "";
    const nativeItem = native.closest("li");
    item.className = nativeItem?.className ?? "";
    item.style.cssText = nativeItem ? "" : "list-style:none;display:flex;flex-shrink:0";
  }
  function place(target: Element): void { if (target.nextSibling !== item) target.after(item); }
  function attach(): void {
    frame = undefined;
    const footer = sidebarFooter();
    const native = footer ? footerReference(footer) : null;
    if (native) {
      mirror(native); if (button.parentElement !== item) item.append(button);
      place(native.closest("li") ?? native); return;
    }
    reference = undefined;
    // Native T3 swaps the utility icons for "Back" on Settings/Usage pages; follow it.
    if (footer && UTILITY_PAGE.test(routePath())) { hideTip(); item.remove(); button.remove(); return; }
    item.remove(); button.className = "";
    button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--control-radius,calc(var(--radius,.625rem) - 2px));background:transparent;color:var(--sidebar-muted-foreground,var(--muted-foreground,#a1a1aa));cursor:pointer";
    if (footer) { if (button.parentElement !== footer) footer.append(button); return; }
    button.style.cssText += ";position:fixed;left:12px;bottom:12px;z-index:999;background:var(--background,#0a0a0a);border:1px solid var(--border,#ffffff1a)";
    if (button.parentElement !== document.body) document.body.append(button);
  }
  const observer = new MutationObserver(() => { if (frame === undefined) frame = requestAnimationFrame(attach); });
  observer.observe(document.body, { subtree: true, childList: true });
  attach();
  return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); hideTip(); button.remove(); item.remove(); };
}
