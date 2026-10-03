"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// payload/bootstrap.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var { app } = require("electron");
var disabled = /^(1|true|yes)$/i.test(process.env.T3_MODS_DISABLE || "");
var data = require("./paths.cjs").dataRoot;
var inbox = import_node_path.default.join(data, "inbox");
var safeMode = import_node_fs.default.existsSync(import_node_path.default.join(data, "SAFE_MODE"));
var windows = /* @__PURE__ */ new Set();
var renderer;
var watcher;
var processed = /* @__PURE__ */ new Map();
var sessions = /* @__PURE__ */ new Set();
function allowed(contents) {
  try {
    const url = new URL(contents.getURL());
    return ["t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app";
  } catch {
    return false;
  }
}
function deliver(contents, file) {
  if (contents.isDestroyed() || !allowed(contents)) return;
  try {
    const filename = import_node_path.default.join(inbox, file);
    const info = import_node_fs.default.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return;
    const stamp = `${info.mtimeMs}:${info.size}`;
    const key = `${contents.id}:${file}`;
    if (processed.get(key) === stamp) return;
    const bundle = JSON.parse(import_node_fs.default.readFileSync(filename, "utf8"));
    if (bundle.format !== "t3mod/1") return;
    const code = `Boolean(window.__modsForT3Code) && (window.__modsForT3Code.importCandidate(${JSON.stringify(bundle)}, { inbox: true }), true)`;
    contents.executeJavaScript(code).then((delivered) => {
      if (delivered) processed.set(key, stamp);
    }).catch(() => {
    });
  } catch {
  }
}
function inject(contents) {
  if (contents.isDestroyed() || !allowed(contents) || disabled) return;
  try {
    renderer ??= import_node_fs.default.readFileSync(import_node_path.default.join(__dirname, "renderer.js"), "utf8");
    const examples = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(__dirname, "examples.json"), "utf8"));
    const options = JSON.stringify({ inbox, safeMode, examples });
    contents.executeJavaScript(`window.__MODS_FOR_T3_OPTIONS__=${options};
${renderer}`).then(() => {
      for (const file of import_node_fs.default.readdirSync(inbox).filter((name) => /^[a-zA-Z0-9._-]+\.t3mod$/.test(name))) deliver(contents, file);
    }).catch((error) => console.error("[Mods for T3 Code] Host not loaded:", error instanceof Error ? error.message : String(error)));
  } catch (error) {
    console.error("[Mods for T3 Code]", error instanceof Error ? error.message : String(error));
  }
}
if (!disabled) {
  app.on("web-contents-created", (_, contents) => {
    const session = contents.session;
    if (sessions.has(session)) return;
    sessions.add(session);
    try {
      session.registerPreloadScript({ type: "frame", filePath: import_node_path.default.join(__dirname, "telemetry-preload.cjs"), id: "mods-for-t3-code-context" });
    } catch (error) {
      console.error("[Mods for T3 Code] Context observer unavailable:", error instanceof Error ? error.message : String(error));
    }
  });
  import_node_fs.default.mkdirSync(inbox, { recursive: true, mode: 448 });
  app.on("browser-window-created", (_, window) => {
    const contents = window.webContents;
    windows.add(contents);
    contents.on("did-finish-load", () => inject(contents));
    contents.once("destroyed", () => windows.delete(contents));
  });
  let timer;
  const changed = /* @__PURE__ */ new Set();
  watcher = import_node_fs.default.watch(inbox, (_, filename) => {
    const file = String(filename || "");
    if (!/^[a-zA-Z0-9._-]+\.t3mod$/.test(file)) return;
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const filename2 of changed) for (const contents of windows) deliver(contents, filename2);
      changed.clear();
    }, 500);
  });
  watcher.on("error", (error) => console.error("[Mods for T3 Code] Inbox watcher:", error instanceof Error ? error.message : String(error)));
  app.once("will-quit", () => {
    clearTimeout(timer);
    watcher.close();
  });
}
