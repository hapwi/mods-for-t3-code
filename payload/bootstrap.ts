import type { ElectronApi, ElectronContents, ElectronSession } from "./electron-types.ts";
import type { FSWatcher } from "node:fs";
// The only code loaded by the patched boot entry. No provider credentials,
// original preload, database, or Electron security setting is changed.
const { app } = require("electron") as ElectronApi;
import fs from "node:fs";
import path from "node:path";

const disabled = /^(1|true|yes)$/i.test(process.env.T3_MODS_DISABLE || "");
const data = (require("./paths.cjs") as {dataRoot: string}).dataRoot;
const inbox = path.join(data, "inbox");
const safeMode = fs.existsSync(path.join(data, "SAFE_MODE"));
const windows = new Set<ElectronContents>();
let renderer: string | undefined;
let watcher: FSWatcher;
const processed = new Map<string, string>();
const sessions = new Set<ElectronSession>();

function allowed(contents: ElectronContents) {
  try { const url = new URL(contents.getURL()); return ["t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app"; }
  catch { return false; }
}

function deliver(contents: ElectronContents, file: string) {
  if (contents.isDestroyed() || !allowed(contents)) return;
  try {
    const filename = path.join(inbox, file);
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return;
    const stamp = `${info.mtimeMs}:${info.size}`;
    const key = `${contents.id}:${file}`;
    if (processed.get(key) === stamp) return;
    const bundle = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (bundle.format !== "t3mod/1") return;
    const code = `Boolean(window.__modsForT3Code) && (window.__modsForT3Code.importCandidate(${JSON.stringify(bundle)}, { inbox: true }), true)`;
    contents.executeJavaScript(code).then((delivered) => { if (delivered) processed.set(key, stamp); }).catch(() => {});
  } catch { /* AI may still be writing the file; the watcher retries on changes */ }
}

function inject(contents: ElectronContents) {
  if (contents.isDestroyed() || !allowed(contents) || disabled) return;
  try {
    renderer ??= fs.readFileSync(path.join(__dirname, "renderer.js"), "utf8");
    const examples = JSON.parse(fs.readFileSync(path.join(__dirname, "examples.json"), "utf8"));
    const options = JSON.stringify({ inbox, safeMode, examples });
    contents.executeJavaScript(`window.__MODS_FOR_T3_OPTIONS__=${options};\n${renderer}`).then(() => {
      for (const file of fs.readdirSync(inbox).filter((name) => /^[a-zA-Z0-9._-]+\.t3mod$/.test(name))) deliver(contents, file);
    }).catch((error) => console.error("[Mods for T3 Code] Host not loaded:", error instanceof Error ? error.message : String(error)));
  } catch (error) { console.error("[Mods for T3 Code]", error instanceof Error ? error.message : String(error)); }
}

if (!disabled) {
  // Append a trusted read-only observer; preserve the app's original preload.
  app.on("web-contents-created", (_, contents) => {
    const session = contents.session;
    if (sessions.has(session)) return;
    sessions.add(session);
    try {
      session.registerPreloadScript({ type: "frame", filePath: path.join(__dirname, "telemetry-preload.cjs"), id: "mods-for-t3-code-context" });
    } catch (error) { console.error("[Mods for T3 Code] Context observer unavailable:", error instanceof Error ? error.message : String(error)); }
  });
  fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  app.on("browser-window-created", (_, window) => {
    const contents = window.webContents;
    windows.add(contents);
    contents.on("did-finish-load", () => inject(contents));
    contents.once("destroyed", () => windows.delete(contents));
  });
  let timer: ReturnType<typeof setTimeout>;
  const changed = new Set<string>();
  watcher = fs.watch(inbox, (_, filename) => {
    const file = String(filename || "");
    if (!/^[a-zA-Z0-9._-]+\.t3mod$/.test(file)) return;
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => { for (const filename of changed) for (const contents of windows) deliver(contents, filename); changed.clear(); }, 500);
  });
  watcher.on("error", (error) => console.error("[Mods for T3 Code] Inbox watcher:", error instanceof Error ? error.message : String(error)));
  app.once("will-quit", () => { clearTimeout(timer); watcher.close(); });
}
