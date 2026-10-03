export async function activate(api) {
  await api.theme.set({
    background: "#17212f", foreground: "#edf2f8", card: "#1d2939", "card-foreground": "#edf2f8",
    popover: "#253348", "popover-foreground": "#edf2f8", primary: "#8db9ef", "primary-foreground": "#152033",
    secondary: "#263750", "secondary-foreground": "#edf2f8", muted: "#243247", "muted-foreground": "#b8c5d8",
    accent: "#304562", "accent-foreground": "#edf2f8", border: "#3e526d", input: "#435872", ring: "#8db9ef",
    sidebar: "#131d2b", "sidebar-foreground": "#edf2f8", "sidebar-accent": "#304562", "sidebar-accent-foreground": "#edf2f8",
    "sidebar-border": "#3e526d", "sidebar-ring": "#8db9ef"
  });
}
