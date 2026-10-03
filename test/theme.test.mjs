import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as esbuild from "esbuild";
import { validateTheme } from "../payload/web/themes.ts";

const midnight = {
  background: "#17212f", foreground: "#edf2f8", card: "#1d2939", "card-foreground": "#edf2f8",
  popover: "#253348", "popover-foreground": "#edf2f8", primary: "#8db9ef", "primary-foreground": "#152033",
  secondary: "#263750", "secondary-foreground": "#edf2f8", muted: "#243247", "muted-foreground": "#b8c5d8",
  accent: "#304562", "accent-foreground": "#edf2f8", border: "#3e526d", input: "#435872", ring: "#8db9ef",
  sidebar: "#131d2b", "sidebar-foreground": "#edf2f8", "sidebar-accent": "#304562", "sidebar-accent-foreground": "#edf2f8",
  "sidebar-border": "#3e526d", "sidebar-ring": "#8db9ef",
};
const later = { ...midnight, background: "#101820", sidebar: "#0b1219", "sidebar-accent": "#3d5678", "sidebar-accent-foreground": "#edf2f8" };

// Declarations copied from T3 0.0.46 nightly 2632 and 2638 client CSS. Both builds share them.
const nativeCss = `
:root{--color-white:#fff;--color-zinc-25:oklch(99.2% 0 0);--color-zinc-50:oklch(98.5% 0 none);--color-zinc-100:oklch(96.7% .001 286.375);--color-zinc-200:oklch(92% .004 286.32);--color-zinc-300:oklch(87.1% .006 286.286);--color-zinc-500:oklch(55.2% .016 285.938);--color-zinc-800:oklch(27.4% .006 286.033);--color-zinc-900:oklch(21% .006 285.885);--sidebar-row-active:var(--color-white);--sidebar-row-selected:var(--color-white)}
[data-app-sidebar]{--background:var(--color-zinc-25);--foreground:var(--color-zinc-800);--card:var(--color-white);--card-foreground:var(--color-zinc-800);--accent:var(--color-zinc-100);--accent-foreground:var(--color-zinc-900);--muted:var(--color-zinc-50);--muted-foreground:var(--color-zinc-500);--border:var(--color-zinc-200);--input:var(--color-zinc-300);--sidebar:var(--color-zinc-50);--sidebar-foreground:var(--color-zinc-800);--sidebar-muted-foreground:var(--color-zinc-500);--sidebar-control-surface:var(--color-zinc-100);--sidebar-row-hover:var(--color-zinc-25);--sidebar-row-active:var(--color-white);--sidebar-row-selected:var(--color-white);--sidebar-border:var(--color-zinc-200);--sidebar-stage-fade:var(--sidebar)}
[data-app-sidebar]:is(.dark,.dark *){--background:#000;--foreground:#f1f3f7;--card:#000;--card-foreground:var(--foreground);--accent:#191a1d;--accent-foreground:#f7f9ff;--muted:#0a0a0a;--muted-foreground:#a3a3a3;--border:#ffffff14;--input:#ffffff2e;--sidebar:var(--card);--sidebar-foreground:var(--foreground);--sidebar-muted-foreground:var(--muted-foreground);--sidebar-control-surface:var(--muted);--sidebar-row-hover:var(--contrast-foreground)}
@supports (color:color-mix(in lab, red, red)){[data-app-sidebar]:is(.dark,.dark *){--sidebar-row-hover:color-mix(in srgb, var(--contrast-foreground) 8%, transparent)}}
[data-app-sidebar]:is(.dark,.dark *){--sidebar-row-active:var(--contrast-foreground)}
@supports (color:color-mix(in lab, red, red)){[data-app-sidebar]:is(.dark,.dark *){--sidebar-row-active:color-mix(in srgb, var(--contrast-foreground) 11%, transparent)}}
[data-app-sidebar]:is(.dark,.dark *){--sidebar-row-selected:var(--contrast-foreground)}
@supports (color:color-mix(in lab, red, red)){[data-app-sidebar]:is(.dark,.dark *){--sidebar-row-selected:color-mix(in srgb, var(--contrast-foreground) 7%, transparent)}}
html[data-theme-id]:not([data-theme-id=""]){--background:var(--app-theme-canvas);--app-chrome-background:var(--app-theme-chrome);--toolbar-background:var(--app-theme-toolbar);--toolbar-foreground:var(--app-theme-toolbar-foreground);--toolbar-border:var(--app-theme-toolbar-border);--toolbar-control:var(--app-theme-toolbar-control);--toolbar-control-foreground:var(--app-theme-toolbar-control-foreground);--toolbar-control-hover:var(--app-theme-toolbar-control-hover);--surface-raised:var(--app-theme-surface-raised);--foreground:var(--app-theme-text);--card:var(--app-theme-surface);--card-foreground:var(--app-theme-text);--popover:var(--app-theme-surface-overlay);--popover-foreground:var(--app-theme-text);--primary:var(--app-theme-message-action);--primary-foreground:var(--app-theme-message-action-foreground);--secondary:var(--app-theme-secondary);--secondary-foreground:var(--app-theme-secondary-foreground);--muted:var(--app-theme-muted);--muted-foreground:var(--app-theme-muted-foreground);--placeholder:var(--app-theme-placeholder);--secondary-label:var(--app-theme-secondary-label);--icon-muted:var(--app-theme-icon-muted);--accent:var(--app-theme-accent-surface);--accent-foreground:var(--app-theme-accent-surface-foreground);--message-surface:var(--app-theme-message-surface);--message-foreground:var(--app-theme-message-foreground);--message-action:var(--app-theme-message-action);--message-action-foreground:var(--app-theme-message-action-foreground);--message-action-hover:var(--app-theme-message-action-hover);--error:var(--app-theme-error);--error-foreground:var(--app-theme-error-foreground);--tool-error-icon:var(--error-foreground);--error-surface:var(--app-theme-error-surface);--destructive:var(--error);--destructive-foreground:var(--error-foreground);--warning:var(--app-theme-warning);--warning-foreground:var(--app-theme-warning-foreground);--warning-surface:var(--app-theme-warning-surface);--update:var(--app-theme-update);--update-foreground:var(--app-theme-update-foreground);--update-surface:var(--app-theme-update-surface);--border:var(--app-theme-border);--input:var(--app-theme-input);--ring:var(--app-theme-focus);--sidebar:var(--app-theme-sidebar);--sidebar-foreground:var(--app-theme-sidebar-foreground);--sidebar-muted-foreground:var(--app-theme-sidebar-muted-foreground);--sidebar-control-surface:var(--app-theme-sidebar-control-surface);--sidebar-row-hover:var(--app-theme-sidebar-row-hover);--sidebar-row-active:var(--app-theme-sidebar-row-active);--sidebar-row-selected:var(--app-theme-sidebar-row-selected);--sidebar-border:var(--app-theme-sidebar-border);--sidebar-stage-fade:var(--app-theme-sidebar);--code-background:var(--app-theme-code-background);--code-foreground:var(--app-theme-code-foreground);--terminal-background:var(--app-theme-terminal-background);--terminal-foreground:var(--app-theme-terminal-foreground);--terminal-cursor:var(--app-theme-terminal-cursor);--terminal-selection-background:var(--app-theme-terminal-selection-background)}
html[data-theme-id] [data-app-sidebar]{--background:var(--app-theme-canvas);--foreground:var(--app-theme-text);--card:var(--app-theme-surface);--card-foreground:var(--app-theme-text);--accent:var(--app-theme-accent-surface);--accent-foreground:var(--app-theme-accent-surface-foreground);--muted:var(--app-theme-muted);--muted-foreground:var(--app-theme-muted-foreground);--border:var(--app-theme-border);--input:var(--app-theme-input);--sidebar:var(--app-theme-sidebar);--sidebar-foreground:var(--app-theme-sidebar-foreground);--sidebar-muted-foreground:var(--app-theme-sidebar-muted-foreground);--sidebar-control-surface:var(--app-theme-sidebar-control-surface);--sidebar-row-hover:var(--app-theme-sidebar-row-hover);--sidebar-row-active:var(--app-theme-sidebar-row-active);--sidebar-row-selected:var(--app-theme-sidebar-row-selected);--sidebar-border:var(--app-theme-sidebar-border);--sidebar-stage-fade:var(--app-theme-sidebar);border-color:var(--contrast-sidebar-foreground)}
`;

test("theme tokens stay on the supported paired palette", () => {
  assert.equal(validateTheme(midnight).background, "#17212f");
  assert.throws(() => validateTheme({ ...midnight, "app-theme-canvas": "#17212f" }), /supported color token/);
});

test("root, derived, sidebar, and app-theme aliases follow native T3 rules and restore inline values", async () => {
  const built = await esbuild.build({
    entryPoints: [new URL("../payload/web/themes.ts", import.meta.url).pathname],
    bundle: true,
    format: "iife",
    globalName: "T3Themes",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  const script = built.outputFiles[0].text;
  const dir = mkdtempSync(join(tmpdir(), "t3-theme-page-"));
  const htmlPath = join(dir, "theme.html");
  writeFileSync(htmlPath, `<!doctype html>
<html class="dark" data-theme-id="grove">
<head><style>${nativeCss}</style></head>
<body>
<div id="early" data-app-sidebar></div>
<div id="preset" data-app-sidebar style="--sidebar-row-active: #abcabc !important"></div>
<script>${script}</script>
<pre id="out"></pre>
<script>
const html = document.documentElement;
html.style.setProperty("--app-theme-canvas", "#fcfcfc");
html.style.setProperty("--app-theme-chrome", "#fcfcfc");
html.style.setProperty("--app-theme-text", "#27272a");
html.style.setProperty("--app-theme-sidebar", "#fafafa");
html.style.setProperty("--app-theme-sidebar-row-active", "#ffffff");
html.style.setProperty("--app-theme-sidebar-row-selected", "#ffffff");
html.style.setProperty("--app-theme-error", "#fb2c36");
html.style.setProperty("--background", "#eeeeee");
const host = new T3Themes.ThemeHost();
const first = ${JSON.stringify(midnight)};
const second = ${JSON.stringify(later)};
host.set("first", first);
const late = document.createElement("div");
late.id = "late";
late.setAttribute("data-app-sidebar", "");
document.body.append(late);
queueMicrotask(() => {
const early = document.getElementById("early");
const preset = document.getElementById("preset");
function resolved(value) {
  const raw = value.trim();
  if (!raw) return "";
  const probe = document.body.appendChild(document.createElement("span"));
  probe.style.color = raw;
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
function read(element) {
  const style = getComputedStyle(element);
  const names = ["--background", "--foreground", "--sidebar", "--sidebar-row-active", "--sidebar-row-selected", "--card"];
  return Object.fromEntries(names.map((name) => [name, resolved(style.getPropertyValue(name))]));
}
function inline(name) {
  return html.style.getPropertyValue(name);
}
function snap(label) {
  return {
    label,
    themeId: html.dataset.themeId ?? "",
    className: html.className,
    width: html.style.width,
    inline: {
      canvas: inline("--app-theme-canvas"),
      chrome: inline("--app-theme-chrome"),
      text: inline("--app-theme-text"),
      error: inline("--app-theme-error"),
      background: inline("--background"),
      row: inline("--sidebar-row-active"),
      toolbar: inline("--toolbar-background"),
      appChrome: inline("--app-chrome-background"),
      surface: inline("--app-theme-surface-raised"),
      sidebarRow: inline("--app-theme-sidebar-row-active"),
      sidebarWidth: inline("--sidebar-width"),
    },
    early: read(early),
    late: read(late),
    presetRow: preset.style.getPropertyValue("--sidebar-row-active"),
    presetPriority: preset.style.getPropertyPriority("--sidebar-row-active"),
  };
}
const snaps = [];
try {
  snaps.push(snap("first"));
  host.set("second", second);
  snaps.push(snap("second"));
  host.clear("second");
  snaps.push(snap("back"));
  host.clear("first");
  snaps.push(snap("cleared"));
  delete html.dataset.themeId;
  host.set("first", first);
  snaps.push(snap("plain-dark"));
  host.clear("first");
  snaps.push(snap("plain-dark-off"));
  html.className = "";
  host.set("first", first);
  snaps.push(snap("plain-light"));
  host.clear("first");
  snaps.push(snap("plain-light-off"));
  document.getElementById("out").textContent = JSON.stringify({ ok: true, snaps });
} catch (error) {
  document.getElementById("out").textContent = JSON.stringify({ ok: false, error: String(error && error.stack || error), snaps });
}
});
</script>
</body>
</html>`);
  try {
    const report = await dumpThemeReport(htmlPath);
    assert.equal(report.ok, true, report.error);
    const byLabel = Object.fromEntries(report.snaps.map((snap) => [snap.label, snap]));
    const row = "rgb(48, 69, 98)";
    const laterRow = "rgb(61, 86, 120)";
    const sidebar = "rgb(19, 29, 43)";
    const laterSidebar = "rgb(11, 18, 25)";
    const text = "rgb(237, 242, 248)";
    const white = "rgb(255, 255, 255)";
    const first = byLabel.first;
    assert.equal(first.themeId, "grove");
    assert.equal(first.className, "dark");
    assert.equal(first.width, "");
    assert.equal(first.inline.sidebarWidth, "");
    assert.equal(first.inline.canvas, "#17212f");
    assert.equal(first.inline.chrome, "#17212f");
    assert.equal(first.inline.text, "#edf2f8");
    assert.equal(first.inline.error, "#fb2c36");
    assert.equal(first.inline.background, "#17212f");
    assert.equal(first.inline.row, "#304562");
    assert.equal(first.inline.toolbar, "#17212f");
    assert.equal(first.inline.appChrome, "#17212f");
    assert.equal(first.inline.surface, "#1d2939");
    assert.equal(first.inline.sidebarRow, "#304562");
    assert.equal(first.early["--background"], sidebar);
    assert.equal(first.early["--foreground"], text);
    assert.equal(first.early["--sidebar"], sidebar);
    assert.equal(first.early["--sidebar-row-active"], row);
    assert.equal(first.early["--sidebar-row-selected"], row);
    assert.equal(first.late["--sidebar-row-active"], row);
    assert.equal(first.late["--background"], sidebar);
    assert.equal(first.presetRow.trim().toLowerCase(), "#304562");
    assert.equal(first.presetPriority, "");
    const second = byLabel.second;
    assert.equal(second.inline.background, "#101820");
    assert.equal(second.inline.canvas, "#101820");
    assert.equal(second.early["--background"], laterSidebar);
    assert.equal(second.early["--sidebar-row-active"], laterRow);
    assert.equal(second.late["--sidebar-row-active"], laterRow);
    assert.equal(second.themeId, "grove");
    const back = byLabel.back;
    assert.equal(back.inline.canvas, "#17212f");
    assert.equal(back.early["--sidebar-row-active"], row);
    assert.equal(back.early["--background"], sidebar);
    const cleared = byLabel.cleared;
    assert.equal(cleared.themeId, "grove");
    assert.equal(cleared.className, "dark");
    assert.equal(cleared.inline.canvas, "#fcfcfc");
    assert.equal(cleared.inline.chrome, "#fcfcfc");
    assert.equal(cleared.inline.text, "#27272a");
    assert.equal(cleared.inline.error, "#fb2c36");
    assert.equal(cleared.inline.background, "#eeeeee");
    assert.equal(cleared.inline.row, "");
    assert.equal(cleared.inline.toolbar, "");
    assert.equal(cleared.inline.appChrome, "");
    assert.equal(cleared.inline.sidebarRow, "#ffffff");
    assert.equal(cleared.presetRow.trim(), "#abcabc");
    assert.equal(cleared.presetPriority, "important");
    assert.equal(cleared.early["--sidebar-row-active"], white);
    assert.notEqual(cleared.early["--background"], sidebar);
    const plainDark = byLabel["plain-dark"];
    assert.equal(plainDark.themeId, "");
    assert.equal(plainDark.className, "dark");
    assert.equal(plainDark.early["--sidebar-row-active"], row);
    assert.equal(plainDark.early["--background"], sidebar);
    assert.equal(plainDark.early["--foreground"], text);
    const plainDarkOff = byLabel["plain-dark-off"];
    assert.equal(plainDarkOff.className, "dark");
    assert.equal(plainDarkOff.themeId, "");
    assert.notEqual(plainDarkOff.early["--sidebar-row-active"], row);
    assert.equal(plainDarkOff.early["--background"], "rgb(0, 0, 0)");
    assert.equal(plainDarkOff.presetRow.trim(), "#abcabc");
    assert.equal(plainDarkOff.presetPriority, "important");
    const plainLight = byLabel["plain-light"];
    assert.equal(plainLight.className, "");
    assert.equal(plainLight.early["--sidebar-row-active"], row);
    assert.equal(plainLight.early["--background"], sidebar);
    assert.notEqual(plainLight.early["--sidebar-row-active"], white);
    const plainLightOff = byLabel["plain-light-off"];
    assert.equal(plainLightOff.className, "");
    assert.equal(plainLightOff.early["--sidebar-row-active"], white);
    assert.equal(plainLightOff.inline.background, "#eeeeee");
    assert.equal(plainLightOff.inline.canvas, "#fcfcfc");
    assert.equal(plainLightOff.inline.error, "#fb2c36");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dumpThemeReport(htmlPath) {
  const profile = mkdtempSync(join(tmpdir(), "t3-theme-chrome-"));
  return new Promise((resolve, reject) => {
    const child = spawn("chromium", [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--allow-file-access-from-files",
      `--user-data-dir=${profile}`,
      "--virtual-time-budget=8000",
      "--dump-dom",
      htmlPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(profile, { recursive: true, force: true });
      const match = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
      if (!match) {
        reject(new Error(`chromium ${code} did not render the theme probe\\n${stderr.slice(0, 800)}\\n${stdout.slice(0, 800)}`));
        return;
      }
      resolve(JSON.parse(match[1]));
    });
  });
}
