export function composer() {
  const editors = [...document.querySelectorAll('[data-testid="composer-editor"][contenteditable="true"]')];
  return editors.find((editor) => editor.getClientRects().length > 0) ?? null;
}

export function readDraft() { return composer()?.innerText ?? ""; }

export function insertDraft(text) {
  const editor = composer();
  if (!editor) throw new Error("Open a T3 thread with a composer, then try again.");
  // Paste through T3's editor event path; never mutate its React state or submit.
  editor.focus();
  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor); range.collapse(false);
  selection.removeAllRanges(); selection.addRange(range);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  editor.dispatchEvent(event);
  if (!event.defaultPrevented) throw new Error("This T3 editor does not support the paste adapter. Copy the text and paste it manually.");
}

// Keeps an owned element directly above T3's composer form, outside its
// contenteditable. React can replace the form at any time; reattach when it does.
export function dockAboveComposer(element) {
  let wanted = false;
  let frame;
  function place() {
    frame = undefined;
    const editor = wanted ? composer() : null;
    const anchor = editor ? editor.closest('[data-chat-composer-form]') ?? editor.closest("form") ?? editor : null;
    if (!anchor?.parentElement) { element.remove(); return; }
    if (element.nextElementSibling !== anchor) anchor.before(element);
  }
  const observer = new MutationObserver(() => { if (wanted && !frame) frame = requestAnimationFrame(place); });
  observer.observe(document.body, { subtree: true, childList: true });
  return {
    show(value) { wanted = value; place(); },
    dispose() { wanted = false; observer.disconnect(); cancelAnimationFrame(frame); element.remove(); },
  };
}

export const MODS_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h4v4a2 2 0 1 0 4 0V3h5v7h-4a2 2 0 1 0 0 4h4v7h-7v-4a2 2 0 1 0-4 0v4H3v-7h4a2 2 0 1 0 0-4H3V3h5Z"/></svg>';
const UTILITY_PAGE = /^\/(settings|usage|pull-requests)(\/|$)/;

export function sidebarFooter() {
  return document.querySelector('[data-sidebar="footer"]') ?? document.querySelector('[data-slot="sidebar-footer"]');
}

// The footer's icon-only utility buttons (Settings, Pull Requests, Usage).
// Their markup varies between T3 builds, so match shape rather than data-slot.
function footerReference(footer) {
  const icons = [...footer.querySelectorAll("button[aria-label]")].filter((item) => !item.closest("[data-t3mods]") && !item.textContent.trim() && item.querySelector("svg"));
  // Prefer sidebar menu buttons; the trailing update pill is also icon-only but styled differently.
  const menuButtons = icons.filter((item) => item.classList.contains("peer/menu-button") || item.getAttribute("data-sidebar") === "menu-button" || item.getAttribute("data-slot") === "sidebar-menu-button");
  return menuButtons.at(-1) ?? icons.at(-1) ?? null;
}

// Tooltip matching T3's small popover tooltip; native ones live in a React portal we can't reuse.
function attachTooltip(target, label) {
  let tip;
  let timer;
  function hide() { clearTimeout(timer); tip?.remove(); tip = undefined; }
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

export function attachSidebarButton(open) {
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
  let reference;
  let frame;
  // Copy presentation only; listeners and React state stay on the native button.
  function mirror(native) {
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
  function place(target) { if (target.nextSibling !== item) target.after(item); }
  function attach() {
    frame = undefined;
    const footer = sidebarFooter();
    const native = footer ? footerReference(footer) : null;
    if (native) {
      mirror(native); if (button.parentElement !== item) item.append(button);
      place(native.closest("li") ?? native); return;
    }
    reference = undefined;
    // Native T3 swaps the utility icons for "Back" on Settings/Usage pages; follow it.
    if (footer && UTILITY_PAGE.test(location.pathname)) { hideTip(); item.remove(); button.remove(); return; }
    item.remove(); button.className = "";
    button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--control-radius,calc(var(--radius,.625rem) - 2px));background:transparent;color:var(--sidebar-muted-foreground,var(--muted-foreground,#a1a1aa));cursor:pointer";
    if (footer) { if (button.parentElement !== footer) footer.append(button); return; }
    button.style.cssText += ";position:fixed;left:12px;bottom:12px;z-index:999;background:var(--background,#0a0a0a);border:1px solid var(--border,#ffffff1a)";
    if (button.parentElement !== document.body) document.body.append(button);
  }
  const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(attach); });
  observer.observe(document.body, { subtree: true, childList: true });
  attach();
  return () => { observer.disconnect(); cancelAnimationFrame(frame); hideTip(); button.remove(); item.remove(); };
}
