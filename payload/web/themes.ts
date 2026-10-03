export const THEME_TOKENS = ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring"] as const;
export type ThemeToken = typeof THEME_TOKENS[number];
type ThemeColors = { [token: string]: string };
type InlineValue = { value: string; priority: string; applied: string };
const pairs: readonly (readonly [ThemeToken, ThemeToken])[] = [["background", "foreground"], ["card", "card-foreground"], ["popover", "popover-foreground"], ["primary", "primary-foreground"], ["secondary", "secondary-foreground"], ["muted", "muted-foreground"], ["accent", "accent-foreground"], ["sidebar", "sidebar-foreground"], ["sidebar-primary", "sidebar-primary-foreground"], ["sidebar-accent", "sidebar-accent-foreground"]];
const SIDEBAR_SELECTOR = "[data-app-sidebar]";

function isThemeToken(value: string): value is ThemeToken {
  return THEME_TOKENS.some((token) => token === value);
}

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (rgb[0] ?? 0) * .2126 + (rgb[1] ?? 0) * .7152 + (rgb[2] ?? 0) * .0722;
}

export function validateTheme(value: unknown): ThemeColors {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected theme color tokens.");
  const theme: ThemeColors = {};
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
    if ((Math.max(a, b) + .05) / (Math.min(a, b) + .05) < 4.5) throw new Error(`The ${background}/${foreground} pair needs readable contrast (4.5:1).`);
  }
  return theme;
}

function restoreInline(style: CSSStyleDeclaration, saved: Map<string, InlineValue>): void {
  for (const [key, prior] of saved) {
    if (style.getPropertyValue(key) !== prior.applied) continue;
    if (prior.value) style.setProperty(key, prior.value, prior.priority);
    else style.removeProperty(key);
  }
}

function applyInline(style: CSSStyleDeclaration, saved: Map<string, InlineValue>, colors: ThemeColors): void {
  saved.clear();
  for (const [token, color] of Object.entries(colors)) {
    const key = `--${token}`;
    saved.set(key, { value: style.getPropertyValue(key), priority: style.getPropertyPriority(key), applied: color });
    style.setProperty(key, color);
  }
}

function themeLayers(active: ThemeColors): { root: ThemeColors; sidebar: ThemeColors } {
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
  const root: ThemeColors = {
    ...active,
    sidebar,
    "sidebar-foreground": sidebarForeground,
    "sidebar-muted-foreground": mutedForeground,
    "sidebar-control-surface": control,
    "sidebar-row-hover": accent, "sidebar-row-active": accent, "sidebar-row-selected": accent,
    "sidebar-stage-fade": sidebar,
    "surface-raised": card,
    "app-chrome-background": active.background,
    "toolbar-background": active.background, "toolbar-foreground": foreground,
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
    "app-theme-terminal-selection-background": accent,
  };
  // [data-app-sidebar] redefines these locally (white/zinc rows, or the selected theme's app-theme vars).
  const sidebarColors: ThemeColors = {
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
    "sidebar-row-hover": accent, "sidebar-row-active": accent, "sidebar-row-selected": accent,
    "sidebar-border": sidebarBorder,
    "sidebar-stage-fade": sidebar,
  };
  return { root, sidebar: sidebarColors };
}

function sidebarNode(node: Node): boolean {
  return node instanceof Element && (node.matches(SIDEBAR_SELECTOR) || node.querySelector(SIDEBAR_SELECTOR) !== null);
}

export class ThemeHost {
  private readonly themes = new Map<string, ThemeColors>();
  private readonly original = new Map<string, InlineValue>();
  private readonly sidebarInline = new Map<HTMLElement, Map<string, InlineValue>>();
  private sidebarObserver: MutationObserver | undefined;
  set(id: string, colors: unknown): void { this.themes.delete(id); this.themes.set(id, validateTheme(colors)); this.apply(); }
  clear(id: string): void { this.themes.delete(id); this.apply(); }
  private apply(): void {
    const style = document.documentElement.style;
    restoreInline(style, this.original);
    const active = [...this.themes.values()].at(-1);
    if (!active) {
      this.original.clear();
      this.paintSidebars(null);
      this.sidebarObserver?.disconnect();
      this.sidebarObserver = undefined;
      return;
    }
    // Keep the selected T3 theme id and appearance class. Override root shadcn
    // tokens, derived chrome/sidebar aliases, and --app-theme-* sources. Inline
    // values already on the page are restored when the last mod clears.
    const layers = themeLayers(active);
    applyInline(style, this.original, layers.root);
    this.paintSidebars(layers.sidebar);
    this.watchSidebars();
  }
  private watchSidebars(): void {
    if (this.sidebarObserver || typeof MutationObserver === "undefined") return;
    this.sidebarObserver = new MutationObserver((records) => {
      const active = [...this.themes.values()].at(-1);
      if (!active || !records.some((record) => [...record.addedNodes].some(sidebarNode))) return;
      this.paintSidebars(themeLayers(active).sidebar);
    });
    this.sidebarObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  private paintSidebars(colors: ThemeColors | null): void {
    const live = new Set<HTMLElement>();
    if (colors) {
      for (const node of document.querySelectorAll<HTMLElement>(SIDEBAR_SELECTOR)) live.add(node);
    }
    for (const [element, saved] of this.sidebarInline) {
      if (live.has(element)) continue;
      restoreInline(element.style, saved);
      this.sidebarInline.delete(element);
    }
    if (!colors) return;
    for (const element of live) {
      const saved = this.sidebarInline.get(element) ?? new Map<string, InlineValue>();
      if (this.sidebarInline.has(element)) restoreInline(element.style, saved);
      this.sidebarInline.set(element, saved);
      applyInline(element.style, saved, colors);
    }
  }
}
