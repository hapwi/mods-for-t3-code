import type { ContextBreakdown, UsageSnapshot } from "../../sdk.d.ts";

const CATEGORIES: readonly [keyof ContextBreakdown, string, string][] = [
  ["systemPrompt", "System prompt", "#999999"],
  ["toolDefinitions", "Tool definitions", "#9885ed"],
  ["rules", "Rules", "#399f6b"],
  ["skills", "Skills", "#efb65e"],
  ["mcpTools", "MCP & dynamic tools", "#b28fab"],
  ["summarizedConversation", "Summarized conversation", "#f26483"],
  ["conversation", "Conversation", "#dc8079"],
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

export function formatContextTokens(value: number): string {
  return value < 1000 ? String(value) : value < 1000000
    ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`
    : `${(value / 1000000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

let sequence = 0;

/** All content and measurements are host-owned; workers cannot inject markup or counts. */
export class ContextUsageView {
  readonly root = element("div", "context-widget");
  private readonly trigger = element("button", "context-trigger ghost icon");
  private readonly popup = element("div", "context-popup");
  private readonly content = element("div", "context-content");
  private readonly label = element("span", "context-percent");
  private readonly arc: SVGCircleElement;
  private threadId: string | undefined;

  constructor() {
    this.root.hidden = true;
    this.trigger.type = "button";
    this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.setAttribute("aria-expanded", "false");
    this.popup.id = `t3mods-context-${++sequence}`;
    this.popup.popover = "auto";
    this.popup.role = "dialog";
    this.popup.setAttribute("aria-label", "Context Usage");
    this.trigger.setAttribute("aria-controls", this.popup.id);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    for (const className of ["context-ring-track", "context-ring-fill"]) {
      const circle = document.createElementNS(svg.namespaceURI, "circle") as SVGCircleElement;
      for (const [key, value] of Object.entries({ cx: "12", cy: "12", r: "9.75", fill: "none", "stroke-width": "3", class: className })) circle.setAttribute(key, value);
      svg.append(circle);
    }
    this.arc = svg.lastElementChild as SVGCircleElement;
    this.arc.setAttribute("pathLength", "100");
    this.arc.setAttribute("stroke-dasharray", "100");
    this.trigger.append(svg);
    const close = element("button", "ghost icon xs", "×");
    close.type = "button"; close.setAttribute("aria-label", "Close context usage");
    close.onclick = () => { this.popup.hidePopover(); this.trigger.focus(); };
    this.popup.append(element("header", "context-header"));
    this.popup.firstElementChild!.append(element("h2", "", "Context Usage"), close);
    this.popup.append(this.content);
    this.trigger.onclick = () => {
      if (this.popup.matches(":popover-open")) this.popup.hidePopover();
      else { this.popup.showPopover(); this.position(); close.focus(); }
    };
    this.popup.addEventListener("toggle", () => {
      this.trigger.setAttribute("aria-expanded", String(this.popup.matches(":popover-open")));
    });
    // Prevent composer shortcuts from handling keys intended for the inspector.
    this.popup.addEventListener("keydown", event => event.stopPropagation());
    this.root.append(this.trigger, this.label, this.popup);
    window.addEventListener("resize", this.position);
    window.addEventListener("scroll", this.position, true);
  }

  private readonly position = (): void => {
    if (!this.popup.matches(":popover-open")) return;
    const anchor = this.trigger.getBoundingClientRect();
    const box = this.popup.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.right - box.width, window.innerWidth - box.width - 12));
    const top = Math.max(12, Math.min(anchor.top - box.height - 8, window.innerHeight - box.height - 12));
    this.popup.style.left = `${left}px`; this.popup.style.top = `${top}px`;
  };

  update(snapshot: UsageSnapshot | null): void {
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
    bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
    if (percent !== null) bar.setAttribute("aria-valuenow", String(Math.round(percent)));
    bar.setAttribute("aria-valuetext", accessible);
    const list = element("dl", "context-breakdown");
    let classified = 0;
    const segment = (tokens: number, color: string): void => {
      if (!tokens) return;
      const part = element("span", "context-segment");
      part.style.backgroundColor = color;
      part.style.width = `${tokens / Math.max(maxTokens ?? usedTokens, usedTokens, 1) * 100}%`;
      bar.append(part);
    };
    const row = (name: string, count: number | undefined, color: string): void => {
      const item = element("div", "context-category");
      const title = element("dt", "");
      const swatch = element("span", "context-swatch"); swatch.style.backgroundColor = color;
      title.append(swatch, document.createTextNode(name));
      const total = element("dd", count === undefined ? "context-unavailable" : "", count === undefined ? "Unavailable" : formatContextTokens(count));
      item.append(title, total); list.append(item);
      if (count !== undefined) { classified += count; segment(count, color); }
    };
    for (const [key, name, color] of CATEGORIES) row(name, breakdown?.[key], color);
    const remainder = usedTokens - classified;
    if (remainder > 0 || !breakdown) row("Unclassified context", remainder, "#70869d");
    const note = element("p", "context-note", !breakdown
      ? "T3 reports the total context usage, but does not provide these category counts. Unavailable counts are not zero."
      : "Category counts are reported by T3. Any tokens without a category appear as unclassified context.");
    this.content.replaceChildren(summary, bar, list, note);
    this.position();
  }

  dispose(): void {
    if (this.popup.matches(":popover-open")) this.popup.hidePopover();
    window.removeEventListener("resize", this.position);
    window.removeEventListener("scroll", this.position, true);
    this.root.remove();
  }
}
