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

export function attachSidebarButton(open) {
  let button;
  let frame;
  function attach() {
    frame = undefined;
    const footer = document.querySelector('[data-sidebar="footer"]') ?? document.querySelector('[data-slot="sidebar-footer"]');
    if (button?.isConnected && (button.dataset.fallback !== "true" || !footer)) return;
    if (button?.isConnected && footer) button.remove();
    button = document.createElement("button");
    button.type = "button";
    button.dataset.t3mods = "sidebar-button";
    button.title = "Mods for T3 Code";
    const native = footer?.querySelector('[data-slot="sidebar-menu-button"]');
    button.className = native?.className ?? "";
    button.setAttribute("data-slot", "sidebar-menu-button");
    button.setAttribute("aria-label", "Mods for T3 Code");
    button.style.cssText = native ? "" : "display:flex;align-items:center;gap:8px;background:transparent;border:0;color:inherit;cursor:pointer;padding:8px;border-radius:6px;font:inherit;font-size:12px;min-height:32px";
    button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3h4v4a2 2 0 1 0 4 0V3h5v7h-4a2 2 0 1 0 0 4h4v7h-7v-4a2 2 0 1 0-4 0v4H3v-7h4a2 2 0 1 0 0-4H3V3h5Z"/></svg><span>Mods</span>';
    button.onclick = open;
    if (!footer) {
      button.dataset.fallback = "true";
      button.style.cssText += ";position:fixed;bottom:12px;left:12px;background:var(--background,#202027);z-index:999;border:1px solid var(--border,#444)";
      document.body.append(button); return;
    }
    const menu = footer.querySelector('[data-sidebar="menu"]') ?? footer.querySelector('[data-slot="sidebar-menu"]');
    if (menu) {
      const item = document.createElement("li");
      item.setAttribute("data-slot", "sidebar-menu-item");
      item.style.cssText = "list-style:none;display:flex;align-items:center";
      item.append(button); menu.append(item);
    } else footer.append(button);
  }
  const observer = new MutationObserver(() => { if ((!button?.isConnected || button.dataset.fallback === "true") && !frame) frame = requestAnimationFrame(attach); });
  observer.observe(document.body, { subtree: true, childList: true });
  attach();
  return () => { observer.disconnect(); cancelAnimationFrame(frame); const parent = button?.parentElement; button?.remove(); if (parent?.tagName === "LI") parent.remove(); };
}
