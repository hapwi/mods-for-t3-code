import type { ModApi } from "../../sdk.d.ts";

export async function activate(api: ModApi): Promise<void> {
  await api.theme.set({
    background: "#f5f6f8", foreground: "#253044", card: "#ffffff", "card-foreground": "#253044",
    popover: "#ffffff", "popover-foreground": "#253044", primary: "#284f88", "primary-foreground": "#ffffff",
    secondary: "#e7ecf3", "secondary-foreground": "#253044", muted: "#edf0f4", "muted-foreground": "#536176",
    accent: "#dce5f2", "accent-foreground": "#253044", border: "#c8d2df", input: "#becbdb", ring: "#284f88",
    sidebar: "#e7ecf3", "sidebar-foreground": "#253044", "sidebar-accent": "#dce5f2", "sidebar-accent-foreground": "#253044",
    "sidebar-border": "#c8d2df", "sidebar-ring": "#284f88"
  });
}
