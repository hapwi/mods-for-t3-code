export const THEME_TOKENS = ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring"] as const;
export type ThemeToken = typeof THEME_TOKENS[number];
type ThemeColors = { [token: string]: string };
const pairs: readonly (readonly [ThemeToken, ThemeToken])[] = [["background", "foreground"], ["card", "card-foreground"], ["popover", "popover-foreground"], ["primary", "primary-foreground"], ["secondary", "secondary-foreground"], ["muted", "muted-foreground"], ["accent", "accent-foreground"], ["sidebar", "sidebar-foreground"], ["sidebar-primary", "sidebar-primary-foreground"], ["sidebar-accent", "sidebar-accent-foreground"]];

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

export class ThemeHost {
  private readonly themes = new Map<string, ThemeColors>();
  private readonly original = new Map<string, { value: string; priority: string; applied: string }>();
  set(id: string, colors: unknown): void { this.themes.delete(id); this.themes.set(id, validateTheme(colors)); this.apply(); }
  clear(id: string): void { this.themes.delete(id); this.apply(); }
  private apply(): void {
    const style = document.documentElement.style;
    for (const [key, saved] of this.original) {
      if (style.getPropertyValue(key) === saved.applied) {
        if (saved.value) style.setProperty(key, saved.value, saved.priority); else style.removeProperty(key);
      }
    }
    this.original.clear();
    const active = [...this.themes.values()].at(-1);
    if (!active) return;
    for (const [token, color] of Object.entries(active)) {
      const key = `--${token}`;
      this.original.set(key, { value: style.getPropertyValue(key), priority: style.getPropertyPriority(key), applied: color });
      style.setProperty(key, color);
    }
  }
}
