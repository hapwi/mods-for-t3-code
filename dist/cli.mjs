#!/usr/bin/env node

// bin/cli.ts
import { readFile as readFile7, writeFile as writeFile7, mkdir as mkdir6, readdir as readdir5, rm as rm6 } from "node:fs/promises";
import path8 from "node:path";
import { platform as platform7 } from "node:os";

// payload/web/manifest.ts
var API_VERSION = 1;
var MAX_BUNDLE_BYTES = 1024 * 1024;
var PERMISSIONS = Object.freeze({
  "ui.panels": "Show text panels and buttons in the Mods tray",
  "ui.commands": "Register local commands in the Mods command palette",
  "ui.notify": "Show notifications labeled with the mod name",
  "ui.theme": "Apply a color theme across the T3 interface",
  "ui.band": "Show one line of styled text above the composer",
  "ui.context": "Show a context usage ring and token breakdown above the composer",
  "session.usage": "Read measured context usage for the open thread",
  "app.route": "Read the current app route and follow navigation",
  "draft.read": "Read the current composer draft",
  "draft.insert": "Offer text to paste into the composer, with your confirmation",
  storage: "Store up to 64 KB of private mod data"
});
function read(value, key) {
  return Reflect.get(value, key);
}
function isPermission(value) {
  return typeof value === "string" && Object.hasOwn(PERMISSIONS, value);
}
function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A mod needs a manifest object.");
  if (read(value, "apiVersion") !== API_VERSION) throw new Error(`This host supports mod API ${API_VERSION}.`);
  const id = read(value, "id");
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error("Mod ID must be 2\u201364 lowercase letters, digits, or hyphens.");
  const version = read(value, "version");
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Use a SemVer version, for example 1.0.0.");
  const text = {};
  for (const field of ["name", "description", "author"]) {
    const item = read(value, field);
    if (typeof item !== "string" || !item.trim() || item.length > (field === "description" ? 600 : 100)) throw new Error(`Supply a short ${field}.`);
    text[field] = item;
  }
  const permissions = read(value, "permissions");
  if (!Array.isArray(permissions) || !permissions.every(isPermission)) throw new Error("The manifest contains an unsupported permission.");
  if (new Set(permissions).size !== permissions.length) throw new Error("Permissions must be unique.");
  const name = text.name;
  const description = text.description;
  const author = text.author;
  if (name === void 0 || description === void 0 || author === void 0) throw new Error("Supply a short name.");
  return { apiVersion: API_VERSION, id, version, name, description, author, permissions: [...permissions] };
}
function validateBundle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Import a complete .t3mod JSON bundle returned by Create or exported from Mods.");
  const manifest = validateManifest(read(value, "manifest"));
  const code = read(value, "code");
  if (read(value, "format") !== "t3mod/1" || typeof code !== "string" || !code.trim()) throw new Error("This file needs format t3mod/1 and its complete JavaScript code. Ask your AI to return the full bundle, not a CLI plugin or source file.");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BUNDLE_BYTES) throw new Error("A mod bundle must be smaller than 1 MB.");
  return { format: "t3mod/1", manifest, code };
}

// src/failure.ts
function failureText(error) {
  return `${error.message}`;
}

// src/install.ts
import { access, copyFile, mkdir, readFile, writeFile, rename, rm, mkdtemp, readdir, realpath } from "node:fs/promises";
import { constants, createReadStream as createReadStream2 } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// src/archive.ts
import { open, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
async function archiveHeader(filename) {
  const file = await open(filename, "r");
  try {
    const prefix = Buffer.alloc(16);
    if ((await file.read(prefix, 0, 16, 0)).bytesRead !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error("Not an Electron ASAR archive.");
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024 || jsonSize > headerSize - 8) throw new Error("Invalid ASAR header size.");
    const json = Buffer.alloc(jsonSize);
    if ((await file.read(json, 0, jsonSize, 16)).bytesRead !== jsonSize) throw new Error("Truncated ASAR header.");
    const header = JSON.parse(json.toString());
    if (!header.files || typeof header.files !== "object") throw new Error("Invalid ASAR directory.");
    return { header, headerString: json.toString(), dataStart: 8 + headerSize };
  } finally {
    await file.close();
  }
}
function entry(header, name) {
  const segments = name.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || [".", ".."].includes(segment))) throw new Error("Invalid archive path.");
  let value = header;
  for (const segment of segments) value = value?.files?.[segment];
  if (!value || value.link || value.unpacked || !Number.isSafeInteger(value.size) || !/^\d+$/.test(String(value.offset))) throw new Error(`Unsupported ASAR entry: ${name}`);
  return value;
}
async function readEntry(filename, name, limit = 1024 * 1024) {
  const { header, dataStart } = await archiveHeader(filename);
  const value = entry(header, name);
  if (value.size > limit) throw new Error(`ASAR entry too large: ${name}`);
  const file = await open(filename, "r");
  try {
    const content = Buffer.alloc(value.size);
    const offset = Number(value.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || (await file.read(content, 0, value.size, dataStart + offset)).bytesRead !== value.size) throw new Error("Invalid ASAR entry offset.");
    return content;
  } finally {
    await file.close();
  }
}
function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = Math.ceil((4 + json.length) / 4) * 4;
  const buffer = Buffer.alloc(12 + payloadSize);
  buffer.writeUInt32LE(4, 0);
  buffer.writeUInt32LE(4 + payloadSize, 4);
  buffer.writeUInt32LE(payloadSize, 8);
  buffer.writeUInt32LE(json.length, 12);
  json.copy(buffer, 16);
  return buffer;
}
async function replaceEntry(source, destination, name, content) {
  const { header, dataStart } = await archiveHeader(source);
  const value = entry(header, name);
  const payloadSize = (await stat(source)).size - dataStart;
  value.offset = String(payloadSize);
  value.size = content.length;
  const blockSize = value.integrity?.blockSize ?? 4 * 1024 * 1024;
  const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
  const blocks = [];
  for (let offset = 0; offset < content.length; offset += blockSize) blocks.push(hash(content.subarray(offset, offset + blockSize)));
  value.integrity = { algorithm: "SHA256", hash: hash(content), blockSize, blocks };
  const file = await open(destination, "wx", (await stat(source)).mode);
  try {
    await file.writeFile(encodeHeader(header));
  } finally {
    await file.close();
  }
  await pipeline(createReadStream(source, { start: dataStart }), createWriteStream(destination, { flags: "a" }));
  const append = await open(destination, "a");
  try {
    await append.writeFile(content);
    await append.sync();
  } finally {
    await append.close();
  }
}
async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

// src/paths.ts
import os from "node:os";
import path from "node:path";
var dataRoot = path.resolve(process.env.MODS_FOR_T3_DATA || (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Mods for T3 Code") : process.platform === "win32" ? path.join(process.env.APPDATA || os.homedir(), "Mods for T3 Code") : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "mods-for-t3-code")));
var paths = { dataRoot };
var paths_default = paths;

// src/install.ts
var packageRoot = path2.dirname(path2.dirname(fileURLToPath(import.meta.url)));
var dataRoot2 = paths_default.dataRoot;
var marker = "/* mods-for-t3-code:v1 */";
var appImageCopyName = /^app(?:-[a-f0-9]{16})?$/;
function ownedInstallCopy(candidate, root, pattern) {
  if (!candidate || typeof candidate !== "string") return null;
  const resolved = path2.resolve(candidate);
  if (path2.dirname(resolved) !== path2.resolve(root) || !pattern.test(path2.basename(resolved))) return null;
  return resolved;
}
async function removeStaleOwnedCopy(candidate, { root, retain = [], pattern }) {
  const resolved = ownedInstallCopy(candidate, root, pattern);
  if (!resolved || retain.some((item) => item && path2.resolve(item) === resolved)) return false;
  let location = resolved;
  let rootLocation = path2.resolve(root);
  try {
    location = await realpath(resolved);
    rootLocation = await realpath(root);
  } catch {
    return false;
  }
  if (location !== rootLocation && !location.startsWith(`${rootLocation}${path2.sep}`)) return false;
  await rm(resolved, { recursive: true, force: true });
  return true;
}
async function inspectArchive(archive) {
  try {
    const pkg = JSON.parse((await readEntry(archive, "package.json")).toString());
    const identity = `${pkg.name || ""} ${pkg.productName || ""}`;
    if (!/t3[ -]?(?:code|desktop)|@t3tools\/desktop/i.test(identity)) return null;
    const main = pkg.main;
    if (typeof main !== "string" || !main || /(^|[/\\])\.\.([/\\]|$)/.test(main)) return null;
    const source = (await readEntry(archive, main, 12 * 1024 * 1024)).toString();
    return { main, version: pkg.version || "unknown", markerFree: !source.includes(marker) };
  } catch {
    return null;
  }
}
async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}
function command(binary, args2, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args2, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path2.basename(binary)} failed (${signal || code}).`)));
  });
}
async function installRuntime() {
  const target = path2.join(dataRoot2, "runtime");
  await mkdir(target, { recursive: true, mode: 448 });
  for (const file of ["bootstrap.cjs", "telemetry-preload.cjs", "renderer.js", "paths.cjs", "examples.json"]) {
    const source = path2.join(packageRoot, "dist", file);
    if (!await exists(source)) throw new Error("Runtime bundle missing. Run npm run build in a development checkout.");
    const temporary = path2.join(target, `${file}.tmp-${process.pid}`);
    if (file === "paths.cjs") await writeFile(temporary, `exports.dataRoot = ${JSON.stringify(dataRoot2)};
`, { mode: 384 });
    else await copyFile(source, temporary);
    await rename(temporary, path2.join(target, file));
  }
  await mkdir(path2.join(dataRoot2, "inbox"), { recursive: true, mode: 448 });
  return target;
}
async function patchArchive(filename, { checkOnly = false, managedCopy = false } = {}) {
  const archive = path2.resolve(filename);
  if (!managedCopy && archive.includes(`${path2.sep}Contents${path2.sep}Resources${path2.sep}`)) throw new Error("Use --mac-app so the installed macOS bundle is backed up and correctly signed.");
  const stateFile = `${archive}.mods-for-t3-code.json`;
  const backup = `${archive}.mods-for-t3-code.bak`;
  let adoptUpstream = false;
  if (await exists(stateFile)) {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (await sha256(archive) === state.patchedHash) {
      if (checkOnly) return { ...state, archive, alreadyPatched: true };
      await installRuntime();
      return { ...state, archive, alreadyPatched: true };
    }
    const upstream = await inspectArchive(archive);
    if (!upstream?.markerFree) throw new Error("T3 changed since this patch. Restore/reinstall the official app, then patch the new version. Your backup has been kept.");
    if (checkOnly) return { archive, main: upstream.main, appVersion: upstream.version, backup };
    adoptUpstream = true;
  }
  const pkg = JSON.parse((await readEntry(archive, "package.json")).toString());
  const identity = `${pkg.name || ""} ${pkg.productName || ""}`;
  if (!/t3[ -]?(?:code|desktop)|@t3tools\/desktop/i.test(identity)) throw new Error(`This is not a recognized T3 Code archive (${identity.trim()}).`);
  const main = pkg.main;
  if (typeof main !== "string" || !main || /(^|[/\\])\.\.([/\\]|$)/.test(main)) throw new Error("T3 has an unsupported main entry.");
  const original = (await readEntry(archive, main, 12 * 1024 * 1024)).toString();
  if (original.includes(marker)) throw new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
  const result = { archive, main, appVersion: pkg.version || "unknown", backup };
  if (checkOnly) return result;
  await access(archive, constants.W_OK);
  const lock = `${stateFile}.lock`;
  await mkdir(lock).catch(() => {
    throw new Error("Another patch operation is active. If it crashed, remove the .lock directory beside the archive.");
  });
  const temp = `${archive}.mods-tmp-${process.pid}`;
  let swapped = false;
  let backupCreated = false;
  try {
    if (adoptUpstream) {
      await rm(backup, { force: true });
      await rm(stateFile, { force: true });
    }
    if (await exists(backup)) throw new Error(`Backup already exists: ${backup}. It will not be overwritten.`);
    const runtime = await installRuntime();
    const bootstrap = path2.join(runtime, "bootstrap.cjs");
    const requireCode = `try { if (!process.env.T3_MODS_DISABLE) require(${JSON.stringify(bootstrap)}); } catch (error) { console.error('[Mods for T3 Code]', error.message); }`;
    const prefix = pkg.type === "module" && !main.endsWith(".cjs") || main.endsWith(".mjs") ? `${marker}
import { createRequire as __modsForT3CreateRequire } from 'node:module';
try { if (!process.env.T3_MODS_DISABLE) __modsForT3CreateRequire(import.meta.url)(${JSON.stringify(bootstrap)}); } catch (error) { console.error('[Mods for T3 Code]', error.message); }
` : `${marker}
${requireCode}
`;
    const content = Buffer.from(original.startsWith("#!") ? original.replace(/^(#![^\n]*\n)/, `$1${prefix}`) : prefix + original);
    const originalHash = await sha256(archive);
    await copyFile(archive, backup, constants.COPYFILE_EXCL);
    backupCreated = true;
    await replaceEntry(archive, temp, main, content);
    if (!(await readEntry(temp, main, 13 * 1024 * 1024)).equals(content)) throw new Error("Archive patch verification failed.");
    const state = { ...result, originalHash, patchedHash: await sha256(temp), installedAt: (/* @__PURE__ */ new Date()).toISOString() };
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2), { flag: "wx", mode: 384 });
    await rename(temp, archive);
    swapped = true;
    await rename(`${stateFile}.tmp`, stateFile);
    return state;
  } catch (error) {
    if (swapped) await copyFile(backup, archive);
    if (backupCreated && !swapped) await rm(backup, { force: true });
    throw error;
  } finally {
    await rm(temp, { force: true });
    await rm(`${stateFile}.tmp`, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
async function restoreArchive(filename) {
  const archive = path2.resolve(filename);
  const stateFile = `${archive}.mods-for-t3-code.json`;
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const backup = `${archive}.mods-for-t3-code.bak`;
  if (await sha256(archive) !== state.patchedHash) {
    const upstream = await inspectArchive(archive);
    if (!upstream?.markerFree) throw new Error("The app changed after patching. Restore would overwrite an update, so it has been refused.");
    await rm(backup, { force: true });
    await rm(stateFile, { force: true });
    return archive;
  }
  if (await sha256(backup) !== state.originalHash) throw new Error("The backup checksum no longer matches. Restore refused.");
  const temp = `${archive}.restore-${process.pid}`;
  await copyFile(backup, temp);
  await rename(temp, archive);
  await rm(stateFile);
  await rm(backup);
  return archive;
}
async function findAsar(directory, depth = 0) {
  if (depth > 4) return null;
  const direct = path2.join(directory, "resources", "app.asar");
  if (await exists(direct)) return direct;
  for (const entry2 of await readdir(directory, { withFileTypes: true })) {
    if (!entry2.isDirectory()) continue;
    const found = await findAsar(path2.join(directory, entry2.name), depth + 1);
    if (found) return found;
  }
  return null;
}
async function installAppImage(filename) {
  if (platform() !== "linux") throw new Error("AppImage installation requires Linux.");
  const image = path2.resolve(filename);
  const file = await readPrefix(image);
  if (file.toString("hex", 0, 4) !== "7f454c46" || !["414901", "414902"].includes(file.toString("hex", 8, 11))) throw new Error("Choose the actual AppImage binary, not a shell launcher. If yours is a shim, use the .AppImage.real file.");
  await mkdir(dataRoot2, { recursive: true, mode: 448 });
  const imageHash = await sha256(image);
  const metadataFile = path2.join(dataRoot2, "appimage.json");
  let previous;
  if (await exists(metadataFile)) {
    previous = JSON.parse(await readFile(metadataFile, "utf8"));
    if (previous.imageHash === imageHash && await exists(previous.archive)) {
      await patchArchive(previous.archive);
      return previous;
    }
  }
  const staging = await mkdtemp(path2.join(dataRoot2, ".extract-"));
  const destination = path2.join(dataRoot2, `app-${imageHash.slice(0, 16)}`);
  try {
    await command(image, ["--appimage-extract"], { cwd: staging, stdio: "ignore" });
    const extracted = path2.join(staging, "squashfs-root");
    const archive = await findAsar(extracted);
    if (!archive || !await exists(path2.join(extracted, "AppRun"))) throw new Error("This AppImage does not contain the supported T3 Electron layout.");
    await patchArchive(archive, { checkOnly: true });
    if (await exists(destination)) throw new Error(`App copy already exists at ${destination}; it has not been overwritten.`);
    await rename(extracted, destination);
    const installedArchive = path2.join(destination, path2.relative(extracted, archive));
    try {
      const patch = await patchArchive(installedArchive);
      const previousApp = previous?.launcher ? path2.dirname(previous.launcher) : null;
      const metadata = { image, imageHash, archive: installedArchive, launcher: path2.join(destination, "AppRun"), appVersion: patch.appVersion, previousApp };
      await writeFile(`${metadataFile}.tmp`, JSON.stringify(metadata, null, 2), { mode: 384 });
      await rename(`${metadataFile}.tmp`, metadataFile);
      try {
        await removeStaleOwnedCopy(previous?.previousApp, { root: dataRoot2, retain: [destination, previousApp], pattern: appImageCopyName });
      } catch (error) {
        console.warn(`Older AppImage copy was left in place: ${failureText(error)}`);
      }
      return metadata;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
async function readPrefix(filename) {
  const chunks = [];
  for await (const chunk of createReadStream2(filename, { start: 0, end: 15 })) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function detectInstallation() {
  const root = homedir();
  const candidates = platform() === "linux" ? [
    path2.join(root, "Applications", "T3-Code.AppImage.real"),
    path2.join(root, "Applications", "T3-Code.AppImage"),
    "/opt/T3 Code/resources/app.asar",
    "/opt/t3-code/resources/app.asar",
    "/opt/t3code/resources/app.asar"
  ] : platform() === "win32" ? [path2.join(process.env.LOCALAPPDATA || root, "Programs", "T3 Code", "resources", "app.asar")] : [];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("T3 was not found automatically. Pass --appimage /path/to/T3-Code.AppImage or --asar /path/to/resources/app.asar; use --mac-app or --windows-dir for native installations.");
}
async function launchApp(args2 = []) {
  let metadata = JSON.parse(await readFile(path2.join(dataRoot2, "appimage.json"), "utf8"));
  try {
    if (await sha256(metadata.image) !== metadata.imageHash) {
      console.log("T3 was updated. Preparing the mod host for the new version\u2026");
      metadata = await installAppImage(metadata.image);
    }
    await patchArchive(metadata.archive, { checkOnly: true });
  } catch (error) {
    console.warn(`Mods could not be loaded: ${failureText(error)}
Opening the updated, original T3 app instead. Your mods are kept.`);
    await command(metadata.image, args2);
    return;
  }
  await command(metadata.launcher, args2, { env: { ...process.env, APPDIR: path2.dirname(metadata.launcher), APPIMAGE: metadata.image } });
}
async function uninstallAppImage() {
  const filename = path2.join(dataRoot2, "appimage.json");
  const metadata = JSON.parse(await readFile(filename, "utf8"));
  const copy = path2.dirname(metadata.launcher);
  if (path2.dirname(copy) !== dataRoot2 || !/^app(?:-[a-f0-9]{16})?$/.test(path2.basename(copy))) throw new Error("Invalid installation record.");
  await rm(copy, { recursive: true });
  if (metadata.previousApp && path2.dirname(metadata.previousApp) === dataRoot2 && /^app(?:-[a-f0-9]{16})?$/.test(path2.basename(metadata.previousApp))) await rm(metadata.previousApp, { recursive: true, force: true });
  await rm(filename);
}

// src/platform.ts
import { cp, mkdir as mkdir3, readFile as readFile4, writeFile as writeFile4, rename as rename3, rm as rm3, readdir as readdir3 } from "node:fs/promises";
import { createHash as createHash3 } from "node:crypto";
import { platform as platform4, homedir as homedir2 } from "node:os";
import path5 from "node:path";

// src/mac-install.ts
import { lstat, mkdir as mkdir2, open as open3, readdir as readdir2, readFile as readFile2, realpath as realpath2, rename as rename2, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import { createHash as createHash2, randomBytes } from "node:crypto";
import { platform as platform3 } from "node:os";
import path4 from "node:path";

// src/mac-session.ts
import { open as open2 } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform as platform2 } from "node:os";
import path3 from "node:path";
var execute = promisify(execFile);
var pause = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});
function appPids(processList, appPath) {
  const prefix = `${path3.resolve(appPath)}/Contents/MacOS/`;
  return processList.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match?.[2]?.startsWith(prefix) && !match[2].slice(prefix.length).includes("/") ? [Number(match[1])] : [];
  });
}
function createProgress(output = process.stderr) {
  const animated = Boolean(output.isTTY) && process.env.TERM !== "dumb";
  const frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
  let timer;
  let label;
  let index = 0;
  const clear = () => {
    clearInterval(timer);
    timer = void 0;
    if (animated && label) output.write("\r\x1B[2K");
  };
  return {
    stage(message) {
      if (message === label) return;
      if (label) {
        clear();
        output.write(`  \u2713 ${label}
`);
      }
      label = message;
      if (!animated) {
        output.write(`  \u2192 ${message}
`);
        return;
      }
      const draw = () => {
        output.write(`\r\x1B[2K  ${frames[index % frames.length] ?? "\u280B"} ${label}`);
        index += 1;
      };
      draw();
      timer = setInterval(draw, 90);
      timer.unref();
    },
    finish(success = true) {
      clear();
      if (label && animated) output.write(`  ${success ? "\u2713" : "\xD7"} ${label}
`);
      label = void 0;
    }
  };
}
async function confirmInTerminal(message) {
  let terminal;
  try {
    terminal = await open2("/dev/tty", "r+");
  } catch {
    throw new Error("T3 is open. Close it and rerun the installer in a terminal; no app files have been changed.");
  }
  try {
    await terminal.write(message);
    const byte = Buffer.alloc(1);
    let answer = "";
    while (answer.length < 128) {
      const { bytesRead } = await terminal.read(byte, 0, 1, null);
      if (!bytesRead || byte[0] === 10 || byte[0] === 13) break;
      answer += byte.toString();
    }
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    await terminal.close();
  }
}
async function withMacAppClosed(appPath, work, options = {}) {
  if ((options.hostPlatform ?? platform2()) !== "darwin") throw new Error("macOS installation must run on macOS.");
  const run = options.run ?? execute;
  const confirm = options.confirm ?? confirmInTerminal;
  const sleep = options.sleep ?? pause;
  const progress = options.progress ?? createProgress();
  const running = async () => appPids((await run("/bin/ps", ["-axo", "pid=,comm="])).stdout, appPath).length > 0;
  const wasOpen = await running();
  let closed = false;
  let successful = false;
  if (wasOpen) {
    const name = path3.basename(appPath, ".app");
    if (!await confirm(`
${name} is open. Close it and install Mods? [y/N] `)) throw new Error("Installation cancelled. T3 and your app files were left unchanged.");
    progress.stage("Closing T3 normally");
    const quoted = appPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    try {
      await run("/usr/bin/osascript", ["-e", `tell application "${quoted}" to quit`]);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (!await running()) {
          closed = true;
          break;
        }
        await sleep(250);
      }
      if (!closed) throw new Error("T3 is still open. Finish any save or confirmation dialog, close T3, then rerun the installer.");
    } catch (error) {
      progress.finish(false);
      throw error;
    }
  }
  try {
    progress.stage("Checking the installed T3 app");
    const result = await work((message) => progress.stage(message));
    successful = true;
    progress.finish();
    return result;
  } finally {
    if (!successful) progress.finish(false);
    if (closed) {
      try {
        await run("/usr/bin/open", [appPath]);
        process.stderr.write("\nReopened your existing T3 app.\n");
      } catch (error) {
        process.stderr.write(`
Reopen T3 using its normal icon: ${failureText(error)}
`);
      }
    }
  }
}

// src/mac-install.ts
var marker2 = "/* mods-for-t3-code:v1 */";
var execute2 = promisify2(execFile2);
var recordPath = path4.join(dataRoot2, "mac-install.json");
var backupsRoot = path4.join(dataRoot2, "backups");
var backupPattern = /^mac-[a-f0-9]{16}\.app$/;
var managedCopyPattern = /^managed-darwin-[a-f0-9]{16}\.app$/;
var machoMagics = /* @__PURE__ */ new Set([4277009102, 4277009103, 3405691582, 3472551422, 3489328638, 3199925962]);
var requiredEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation"
];
var updaterStatus = { updaterEnabled: true, nativeUpdaterVerified: false };
var restrictedExact = /* @__PURE__ */ new Set([
  "com.apple.application-identifier",
  "keychain-access-groups",
  "com.apple.security.application-groups",
  "beta-reports-active",
  "aps-environment"
]);
function isRestrictedEntitlement(key) {
  return restrictedExact.has(key) || key.startsWith("com.apple.developer.") || key.startsWith("com.apple.private.");
}
function readContainer(xml, index, tag) {
  const openEnd = xml.indexOf(">", index);
  if (openEnd < 0) throw new Error("Invalid entitlements plist.");
  if (xml[openEnd - 1] === "/") return { raw: xml.slice(index, openEnd + 1), next: openEnd + 1 };
  let depth = 1;
  let cursor = openEnd + 1;
  while (depth > 0) {
    const nextOpen = xml.indexOf(`<${tag}`, cursor);
    const nextClose = xml.indexOf(`</${tag}>`, cursor);
    if (nextClose < 0) throw new Error("Invalid entitlements plist.");
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      const nestedEnd = xml.indexOf(">", nextOpen);
      if (nestedEnd < 0) throw new Error("Invalid entitlements plist.");
      cursor = nestedEnd + 1;
    } else {
      depth -= 1;
      cursor = nextClose + `</${tag}>`.length;
    }
  }
  return { raw: xml.slice(index, cursor), next: cursor };
}
function readValue(xml, index) {
  let cursor = index;
  while (xml[cursor] && /\s/.test(xml[cursor])) cursor += 1;
  const self = xml.slice(cursor).match(/^<(true|false)\s*\/>/);
  if (self) return { raw: self[0], next: cursor + self[0].length };
  const empty = xml.slice(cursor).match(/^<(dict|array)\s*\/>/);
  if (empty) return { raw: empty[0], next: cursor + empty[0].length };
  const leaf = xml.slice(cursor).match(/^<(string|integer|real|date|data)(\s[^>]*)?>([\s\S]*?)<\/\1>/);
  if (leaf) return { raw: leaf[0], next: cursor + leaf[0].length };
  if (xml.startsWith("<array", cursor) || xml.startsWith("<dict", cursor)) {
    return readContainer(xml, cursor, xml.startsWith("<array", cursor) ? "array" : "dict");
  }
  throw new Error("Invalid entitlements plist.");
}
function entitlementKeys(xml) {
  return topPairs(xml).map(([key]) => key);
}
function topPairs(xml) {
  const start = xml.indexOf("<dict>");
  if (start < 0) throw new Error("Entitlements plist has no dictionary.");
  const container = readContainer(xml, start, "dict");
  const inner = container.raw.slice("<dict>".length, -"</dict>".length);
  const pairs = [];
  let cursor = 0;
  while (cursor < inner.length) {
    while (inner[cursor] && /\s/.test(inner[cursor])) cursor += 1;
    if (cursor >= inner.length) break;
    const key = inner.slice(cursor).match(/^<key>([^<]*)<\/key>/);
    if (!key) throw new Error("Invalid entitlements plist.");
    const keyName = key[1] ?? "";
    if (!/^[A-Za-z0-9.-]+$/.test(keyName)) throw new Error(`Unsupported entitlement key: ${key[1]}`);
    cursor += key[0].length;
    const value = readValue(inner, cursor);
    pairs.push([keyName, value.raw.trim()]);
    cursor = value.next;
  }
  return pairs;
}
function sanitizeEntitlements(xml) {
  const source = typeof xml === "string" && xml.includes("<dict>") ? xml : `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
`;
  const kept = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [key, raw] of topPairs(source)) {
    if (isRestrictedEntitlement(key)) continue;
    kept.push([key, raw]);
    seen.add(key);
  }
  for (const key of requiredEntitlements) {
    if (!seen.has(key)) kept.push([key, "<true/>"]);
  }
  const body = kept.map(([key, raw]) => `	<key>${key}</key>
	${raw}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}
function adHocSignArguments(target, entitlementsFile) {
  return ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlementsFile, target];
}
function parseSignatureDetails(text) {
  const cdhash = text.match(/^CDHash=([0-9a-fA-F\s]+)$/m)?.[1]?.replace(/\s+/g, "").toLowerCase() ?? null;
  const adhoc = /Signature=adhoc/i.test(text) || /flags=[^\n]*\badhoc\b/i.test(text);
  const authority = [...text.matchAll(/^Authority=(.*)$/gm)].map((match) => match[1].trim()).filter(Boolean);
  return { cdhash, adhoc, authority, label: adhoc ? "adhoc" : authority[0] || (cdhash ? "signed" : "unknown") };
}
function macOpenArguments(installedApp, args2 = []) {
  return args2.length ? [installedApp, "--args", ...args2] : [installedApp];
}
function relocatedSidecarState(state, archive) {
  const target = path4.resolve(archive);
  return { ...state, archive: target, backup: `${target}.mods-for-t3-code.bak` };
}
function macInstallPlan({ hasRecord, sameApp, liveHash, recordedPatchedHash, sidecarPatchedHash, recognized, markerFree }) {
  if (sameApp && recordedPatchedHash && liveHash === recordedPatchedHash) return "current";
  if (sidecarPatchedHash && liveHash === sidecarPatchedHash) return "record-missing";
  if (!recognized || !markerFree) return "refuse";
  if (hasRecord && sameApp) return "adopt";
  if (hasRecord && !sameApp) return "other-app";
  return "fresh";
}
function macRestorePlan({ liveHash, recordedPatchedHash, backupHash, recordedOriginalHash, recognized, markerFree }) {
  if (liveHash === recordedPatchedHash && backupHash === recordedOriginalHash) return "restore";
  if (liveHash !== recordedPatchedHash && recognized && markerFree) return "keep-update";
  return "refuse";
}
function macNativeUpdatePreparationPlan(input) {
  const plan = macRestorePlan(input);
  if (plan !== "restore") return plan;
  if (input.backupAdhoc || !input.vendorCdHash || !input.backupCdHash || input.backupCdHash !== input.vendorCdHash) return "refuse";
  return "restore";
}
function resolveMacInstallTarget(requested, legacy, root = dataRoot2) {
  const resolved = path4.resolve(requested);
  if (!legacy?.original) return resolved;
  const base = path4.basename(resolved);
  if (path4.dirname(resolved) === path4.resolve(root) && managedCopyPattern.test(base)) return path4.resolve(legacy.original);
  return resolved;
}
function assertMac(options = {}) {
  if ((options.hostPlatform ?? platform3()) !== "darwin") throw new Error("macOS installation must run on macOS.");
}
function isInside(child, parent) {
  const resolved = path4.resolve(child);
  const root = path4.resolve(parent);
  return resolved === root || resolved.startsWith(`${root}${path4.sep}`);
}
function backupPath(originalHash) {
  return path4.join(backupsRoot, `mac-${originalHash.slice(0, 16)}.app`);
}
function ownedBackupOrNull(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const resolved = path4.resolve(candidate);
  if (path4.dirname(resolved) !== path4.resolve(backupsRoot) || !backupPattern.test(path4.basename(resolved))) return null;
  return resolved;
}
function sidecarPaths(archive) {
  const target = path4.resolve(archive);
  return { archive: target, backup: `${target}.mods-for-t3-code.bak`, stateFile: `${target}.mods-for-t3-code.json` };
}
function commandFailure(error) {
  const message = failureText(error);
  if (typeof error !== "object" || error === null) return { message, stdout: "", stderr: "" };
  const failed = error;
  return { message, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? "") };
}
async function defaultRunner(binary, args2) {
  try {
    const { stdout, stderr } = await execute2(binary, args2, { maxBuffer: 32 * 1024 * 1024 });
    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  } catch (error) {
    const failed = commandFailure(error);
    const detail = (failed.stderr || failed.stdout).trim();
    const wrapped = new Error(detail ? `${path4.basename(binary)} failed: ${detail}` : failed.message);
    wrapped.stdout = failed.stdout;
    wrapped.stderr = failed.stderr;
    throw wrapped;
  }
}
function runnerFor(options) {
  return options.runner ?? defaultRunner;
}
async function defaultSpawn(binary, args2, spawnOptions = {}) {
  await command(binary, args2, spawnOptions);
}
function withUpdater(record) {
  return { ...record, ...updaterStatus, nativeUpdaterVerified: false, updaterEnabled: true };
}
function assertRecord(record) {
  if (!record || record.kind !== "darwin" || record.patchedInPlace !== true) throw new Error("Invalid macOS installation record.");
  const installedApp = path4.resolve(record.installedApp || record.original || "");
  const archive = path4.resolve(record.archive || "");
  const executable = path4.resolve(record.executable || "");
  const bundleBackup = path4.resolve(record.bundleBackup || "");
  if (!installedApp.endsWith(".app")) throw new Error("Invalid macOS installation record.");
  if (archive !== path4.join(installedApp, "Contents", "Resources", "app.asar")) throw new Error("Invalid macOS installation record.");
  if (path4.dirname(executable) !== path4.join(installedApp, "Contents", "MacOS")) throw new Error("Invalid macOS installation record.");
  if (record.original && path4.resolve(record.original) !== installedApp) throw new Error("Invalid macOS installation record.");
  if (!ownedBackupOrNull(bundleBackup)) throw new Error("Invalid macOS installation record.");
  if (!/^[a-f0-9]{64}$/.test(record.originalHash || "") || !/^[a-f0-9]{64}$/.test(record.patchedHash || "")) throw new Error("Invalid macOS installation record.");
  if (record.signature !== "adhoc") throw new Error("Invalid macOS installation record.");
  return withUpdater({
    ...record,
    kind: "darwin",
    installedApp,
    original: installedApp,
    archive,
    executable,
    bundleBackup,
    previousBackup: ownedBackupOrNull(record.previousBackup),
    patchedInPlace: true,
    signature: "adhoc"
  });
}
async function readRecord() {
  if (!await exists(recordPath)) return null;
  try {
    return assertRecord(JSON.parse(await readFile2(recordPath, "utf8")));
  } catch (error) {
    if (failureText(error) === "Invalid macOS installation record.") throw error;
    throw new Error("macOS installation record is unreadable.");
  }
}
async function writeRecord(record) {
  const temporary = `${recordPath}.${process.pid}.tmp`;
  await mkdir2(dataRoot2, { recursive: true, mode: 448 });
  await writeFile2(temporary, JSON.stringify(withUpdater(record), null, 2), { mode: 384 });
  try {
    await rename2(temporary, recordPath);
  } catch (error) {
    await rm2(temporary, { force: true });
    throw error;
  }
  return assertRecord(record);
}
async function withLock(work) {
  await mkdir2(dataRoot2, { recursive: true, mode: 448 });
  const lock = path4.join(dataRoot2, "mac-install.lock");
  await mkdir2(lock).catch(() => {
    throw new Error("Another macOS patch operation is active. If it crashed, remove the mac-install.lock directory in the mods data folder.");
  });
  try {
    return await work();
  } finally {
    await rm2(lock, { recursive: true, force: true });
  }
}
async function isMachO(file) {
  const handle = await open3(file, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead < 4) return false;
    return machoMagics.has(header.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}
async function inspectArchive2(archive) {
  try {
    const pkg = JSON.parse((await readEntry(archive, "package.json")).toString());
    const identity = `${pkg.name || ""} ${pkg.productName || ""}`;
    if (!/t3[ -]?(?:code|desktop)|@t3tools\/desktop/i.test(identity)) return { recognized: false, markerFree: false };
    const main = pkg.main;
    if (typeof main !== "string" || !main || /(^|[/\\])\.\.([/\\]|$)/.test(main)) return { recognized: false, markerFree: false };
    const source = (await readEntry(archive, main, 12 * 1024 * 1024)).toString();
    return { recognized: true, markerFree: !source.includes(marker2), version: pkg.version || "unknown", main };
  } catch {
    return { recognized: false, markerFree: false };
  }
}
async function legacyDarwin() {
  const filename = path4.join(dataRoot2, "platform.json");
  if (!await exists(filename)) return null;
  try {
    const record = JSON.parse(await readFile2(filename, "utf8"));
    if (record.kind !== "darwin" || typeof record.original !== "string" || !record.original) return null;
    return record;
  } catch {
    return null;
  }
}
async function assertInstallLocation(installedApp) {
  let info;
  try {
    info = await lstat(installedApp);
  } catch {
    throw new Error(`T3 app not found at ${installedApp}.`);
  }
  if (info.isSymbolicLink()) throw new Error("Refusing to patch a symlinked macOS app.");
  if (!info.isDirectory()) throw new Error("Choose the T3 .app bundle.");
  if (path4.basename(installedApp).includes(".mods-stage-") || path4.basename(path4.dirname(installedApp)).includes(".mods-")) {
    throw new Error("Choose the installed T3 app, not a temporary staging copy.");
  }
  const real = await realpath2(installedApp);
  if (isInside(installedApp, dataRoot2) || isInside(real, dataRoot2)) throw new Error("Refusing to patch the mods data directory.");
}
async function signatureDetails(target, options) {
  const run = runnerFor(options);
  let text = "";
  try {
    const result = await run("/usr/bin/codesign", ["-dv", "--verbose=4", target]);
    text = `${result.stdout ?? ""}
${result.stderr ?? ""}`;
  } catch (error) {
    const failed = commandFailure(error);
    text = `${failed.stdout}
${failed.stderr}`;
  }
  const parsed = parseSignatureDetails(text);
  if (!parsed.cdhash) throw new Error(`Code signature check failed for ${target}.`);
  return parsed;
}
async function verifySignature(target, options) {
  await runnerFor(options)("/usr/bin/codesign", ["--verify", "--deep", "--strict", target]);
}
async function dittoBundle(source, destination, options) {
  await runnerFor(options)("/usr/bin/ditto", [source, destination]);
}
async function ensureBackup(installedApp, originalHash, options) {
  await mkdir2(backupsRoot, { recursive: true, mode: 448 });
  const destination = backupPath(originalHash);
  const archived = path4.join(destination, "Contents", "Resources", "app.asar");
  if (await exists(destination)) {
    if (await sha256(archived) !== originalHash) throw new Error(`Backup already exists at ${destination}. It will not be overwritten.`);
    const signed = await signatureDetails(destination, options);
    const source = await signatureDetails(installedApp, options);
    if (signed.cdhash !== source.cdhash) throw new Error("The saved backup signature does not match the installed app.");
    return { bundleBackup: destination, vendorCdHash: signed.cdhash, vendorSignature: signed.authority[0] || signed.label };
  }
  const temporary = path4.join(backupsRoot, `.mac-${originalHash.slice(0, 16)}-${process.pid}-${randomBytes(3).toString("hex")}.app`);
  try {
    await dittoBundle(installedApp, temporary, options);
    if (await sha256(path4.join(temporary, "Contents", "Resources", "app.asar")) !== originalHash) throw new Error("The macOS backup does not match the installed archive.");
    const source = await signatureDetails(installedApp, options);
    const copied = await signatureDetails(temporary, options);
    if (!source.cdhash || source.cdhash !== copied.cdhash) throw new Error("The macOS backup signature does not match the installed app.");
    await verifySignature(temporary, options);
    await rename2(temporary, destination);
    return { bundleBackup: destination, vendorCdHash: copied.cdhash, vendorSignature: source.authority[0] || source.label };
  } catch (error) {
    await rm2(temporary, { recursive: true, force: true });
    throw error;
  }
}
async function commitInstalledBundle(target, replacement) {
  const parent = path4.dirname(path4.resolve(target));
  if (path4.dirname(path4.resolve(replacement)) !== parent) throw new Error("The staged macOS app must stay in the same directory as the installed app.");
  const holding = path4.join(parent, `.${path4.basename(target)}.mods-hold-${process.pid}-${randomBytes(4).toString("hex")}`);
  await rename2(target, holding);
  try {
    await rename2(replacement, target);
  } catch (error) {
    try {
      await rename2(holding, target);
    } catch (rollbackError) {
      throw new Error(`${failureText(error)} The original app is at ${holding} and could not be moved back: ${failureText(rollbackError)}`);
    }
    await rm2(holding, { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
  return holding;
}
async function rollbackCommit(target, holding) {
  const parent = path4.dirname(target);
  const failed = path4.join(parent, `.${path4.basename(target)}.mods-failed-${process.pid}-${randomBytes(3).toString("hex")}`);
  if (await exists(target)) await rename2(target, failed);
  try {
    await rename2(holding, target);
  } finally {
    await rm2(failed, { recursive: true, force: true });
  }
}
async function executableName(plist, options) {
  const { stdout } = await runnerFor(options)("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]);
  const name = String(stdout ?? "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new Error("Unsupported CFBundleExecutable.");
  return name;
}
async function applyAsarIntegrity(plist, archive, options) {
  const { headerString } = await archiveHeader(archive);
  const digest = createHash2("sha256").update(headerString).digest("hex");
  const run = runnerFor(options);
  const buddy = "/usr/libexec/PlistBuddy";
  try {
    await run(buddy, ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${digest}`, plist]);
  } catch {
    try {
      await run(buddy, ["-c", "Add :ElectronAsarIntegrity dict", plist]);
    } catch {
    }
    try {
      await run(buddy, ["-c", "Add :ElectronAsarIntegrity:Resources/app.asar dict", plist]);
    } catch {
    }
    try {
      await run(buddy, ["-c", "Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256", plist]);
    } catch {
    }
    await run(buddy, ["-c", `Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${digest}`, plist]);
  }
}
async function clearSigningDetritus(app, options) {
  const run = runnerFor(options);
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork"]) {
    try {
      await run("/usr/bin/xattr", ["-dr", attribute, app]);
    } catch {
    }
  }
}
async function signAdHoc(app, entitlementsXml, options) {
  const sanitized = sanitizeEntitlements(entitlementsXml);
  const keys = entitlementKeys(sanitized);
  if (keys.some((key) => isRestrictedEntitlement(key))) throw new Error("Restricted entitlements were still present after sanitizing.");
  for (const key of requiredEntitlements) if (!keys.includes(key)) throw new Error(`Sanitized entitlements are missing ${key}.`);
  const entitlementsFile = path4.join(dataRoot2, `.entitlements-${process.pid}-${randomBytes(4).toString("hex")}.plist`);
  await writeFile2(entitlementsFile, sanitized, { mode: 384 });
  try {
    const targets = [];
    async function visit(directory) {
      const entries = await readdir2(directory, { withFileTypes: true });
      for (const entry2 of entries) {
        if (entry2.isSymbolicLink()) continue;
        const full = path4.join(directory, entry2.name);
        if (entry2.isDirectory()) {
          await visit(full);
          if (full !== app && /\.(app|framework|xpc|appex)$/i.test(entry2.name)) targets.push(full);
        } else if (entry2.isFile() && await isMachO(full)) targets.push(full);
      }
    }
    await visit(app);
    targets.sort((left, right) => right.length - left.length);
    const run = runnerFor(options);
    for (const target of [...targets, app]) await run("/usr/bin/codesign", adHocSignArguments(target, entitlementsFile));
    await verifySignature(app, options);
    const signed = await signatureDetails(app, options);
    if (!signed.adhoc) throw new Error("Ad-hoc signature was not applied.");
    return signed;
  } finally {
    await rm2(entitlementsFile, { force: true });
  }
}
async function normalizeStagedSidecar(stagedArchive, finalArchive, originalHash) {
  const staged = sidecarPaths(stagedArchive);
  const state = JSON.parse(await readFile2(staged.stateFile, "utf8"));
  if (await sha256(staged.backup) !== originalHash) throw new Error("The staged backup does not match the original archive.");
  const normalized = relocatedSidecarState(state, finalArchive);
  const temporary = `${staged.stateFile}.${process.pid}.tmp`;
  await writeFile2(temporary, JSON.stringify(normalized, null, 2), { mode: 384 });
  try {
    await rename2(temporary, staged.stateFile);
  } catch (error) {
    await rm2(temporary, { force: true });
    throw error;
  }
  return normalized;
}
async function retireLegacyManagedCopy(installedApp) {
  const legacy = await legacyDarwin();
  if (!legacy || path4.resolve(legacy.original) !== path4.resolve(installedApp)) return false;
  let pending = false;
  for (const candidate of [legacy.previousCopy, legacy.copy]) {
    if (!candidate) continue;
    try {
      const removed = await removeStaleOwnedCopy(candidate, { root: dataRoot2, retain: [installedApp], pattern: managedCopyPattern });
      if (!removed && await exists(candidate)) pending = true;
    } catch (error) {
      pending = true;
      console.warn(`Older managed copy was left in place: ${failureText(error)}`);
    }
  }
  if (!pending) await rm2(path4.join(dataRoot2, "platform.json"), { force: true });
  return !pending;
}
async function removeOwnedBackup(candidate, retain = []) {
  try {
    await removeStaleOwnedCopy(candidate, { root: backupsRoot, retain, pattern: backupPattern });
  } catch (error) {
    console.warn(`Older macOS backup was left in place: ${failureText(error)}`);
  }
}
async function restoreInterruptedInstall(installedApp) {
  if (await exists(installedApp)) return;
  const parent = path4.dirname(installedApp);
  const prefix = `.${path4.basename(installedApp)}.mods-hold-`;
  let names = [];
  try {
    names = (await readdir2(parent)).filter((name) => name.startsWith(prefix));
  } catch {
    return;
  }
  if (names.length !== 1) {
    throw new Error(names.length ? `The macOS app is missing. The original was left at ${path4.join(parent, names[0])}.` : `T3 app not found at ${installedApp}.`);
  }
  await rename2(path4.join(parent, names[0]), installedApp);
}
async function removeLeftoverTemps(installedApp) {
  const parent = path4.dirname(installedApp);
  const prefix = `.${path4.basename(installedApp)}.mods-`;
  let names = [];
  try {
    names = await readdir2(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (name.includes(".mods-stage-") || name.includes(".mods-failed-") || name.includes(".mods-restore-")) {
      await rm2(path4.join(parent, name), { recursive: true, force: true });
    }
  }
}
function refuseError(inspection, hasRecord) {
  if (hasRecord) return new Error("T3 changed since this patch. Restore/reinstall the official app, then patch the new version. Your backup has been kept.");
  if (inspection.recognized && !inspection.markerFree) return new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
  return new Error("Choose the T3 .app bundle containing Contents/Resources/app.asar.");
}
async function finishCurrent(record) {
  const paths2 = sidecarPaths(record.archive);
  if (await exists(paths2.stateFile)) await patchArchive(record.archive, { managedCopy: true, checkOnly: true });
  await installRuntime();
  await retireLegacyManagedCopy(record.installedApp);
  return withUpdater({ ...record, alreadyPatched: true, adoptedUpdate: false });
}
async function patchIntoPlace(installedApp, originalHash, previousRecord, options) {
  const parent = path4.dirname(installedApp);
  const token = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const stage = path4.join(parent, `.${path4.basename(installedApp)}.mods-stage-${token}`);
  const finalArchive = path4.join(installedApp, "Contents", "Resources", "app.asar");
  let holding = null;
  let committed = false;
  options.onProgress?.("Backing up the original T3 app");
  const saved = await ensureBackup(installedApp, originalHash, options);
  try {
    options.onProgress?.("Preparing the app patch");
    await dittoBundle(installedApp, stage, options);
    const stagedArchive = path4.join(stage, "Contents", "Resources", "app.asar");
    if (await sha256(stagedArchive) !== originalHash) throw new Error("The staged macOS archive does not match the installed app.");
    const listed = await runnerFor(options)("/usr/bin/codesign", ["-d", "--entitlements", ":-", stage]);
    const entitlementsXml = `${listed.stdout ?? ""}
${listed.stderr ?? ""}`;
    options.onProgress?.("Patching the Mods host into T3");
    const patch = await patchArchive(stagedArchive, { managedCopy: true });
    if (patch.originalHash !== originalHash) throw new Error("The staged macOS archive does not match the backup.");
    const normalized = await normalizeStagedSidecar(stagedArchive, finalArchive, originalHash);
    await applyAsarIntegrity(path4.join(stage, "Contents", "Info.plist"), stagedArchive, options);
    await rm2(path4.join(stage, "Contents", "embedded.provisionprofile"), { force: true });
    const executable = path4.join(installedApp, "Contents", "MacOS", await executableName(path4.join(stage, "Contents", "Info.plist"), options));
    if (!await exists(path4.join(stage, "Contents", "MacOS", path4.basename(executable)))) throw new Error("The macOS T3 executable could not be identified.");
    if (await sha256(finalArchive) !== originalHash) throw new Error("T3 changed while the patch was being prepared. The installed app was left untouched.");
    options.onProgress?.("Signing and verifying the patched app");
    await clearSigningDetritus(stage, options);
    await signAdHoc(stage, entitlementsXml, options);
    if (await sha256(stagedArchive) !== normalized.patchedHash) throw new Error("Patched macOS archive checksum mismatch.");
    options.onProgress?.("Installing at the existing T3 app location");
    holding = await commitInstalledBundle(installedApp, stage);
    if (await sha256(finalArchive) !== normalized.patchedHash) throw new Error("Patched macOS archive checksum mismatch.");
    await verifySignature(installedApp, options);
    const record = withUpdater({
      kind: "darwin",
      installedApp,
      original: installedApp,
      archive: finalArchive,
      executable,
      appVersion: normalized.appVersion,
      patchedInPlace: true,
      originalHash,
      patchedHash: normalized.patchedHash,
      bundleBackup: saved.bundleBackup,
      previousBackup: ownedBackupOrNull(previousRecord?.bundleBackup),
      signature: "adhoc",
      vendorCdHash: saved.vendorCdHash,
      vendorSignature: saved.vendorSignature,
      adoptedUpdate: Boolean(previousRecord),
      alreadyPatched: false
    });
    await writeRecord(record);
    committed = true;
    await rm2(holding, { recursive: true, force: true }).catch((error) => {
      console.warn(`The pre-patch macOS app was left at ${holding}: ${failureText(error)}`);
    });
    await removeOwnedBackup(previousRecord?.previousBackup, [record.bundleBackup, record.previousBackup]);
    const migrated = await retireLegacyManagedCopy(installedApp);
    return { ...record, migrated };
  } catch (error) {
    if (!committed && holding) {
      try {
        await rollbackCommit(installedApp, holding);
      } catch (rollbackError) {
        throw new Error(`${failureText(error)} The original app is at ${holding} and could not be restored: ${failureText(rollbackError)}`);
      }
    }
    throw error;
  } finally {
    await rm2(stage, { recursive: true, force: true });
  }
}
async function installLocked(appPath, options) {
  const legacy = await legacyDarwin();
  const installedApp = resolveMacInstallTarget(appPath, legacy);
  if (!installedApp.endsWith(".app")) throw new Error("Choose the T3 .app bundle.");
  await restoreInterruptedInstall(installedApp);
  await assertInstallLocation(installedApp);
  await removeLeftoverTemps(installedApp);
  const archive = path4.join(installedApp, "Contents", "Resources", "app.asar");
  if (!await exists(archive)) throw new Error("Choose the T3 .app bundle containing Contents/Resources/app.asar.");
  const liveHash = await sha256(archive);
  const inspection = await inspectArchive2(archive);
  const record = await readRecord();
  const sameApp = Boolean(record && record.installedApp === installedApp);
  const paths2 = sidecarPaths(archive);
  let sidecar = null;
  if (await exists(paths2.stateFile)) {
    try {
      sidecar = JSON.parse(await readFile2(paths2.stateFile, "utf8"));
    } catch {
      sidecar = null;
    }
  }
  let action = macInstallPlan({
    hasRecord: Boolean(record),
    sameApp,
    liveHash,
    recordedPatchedHash: record?.patchedHash,
    sidecarPatchedHash: sidecar?.patchedHash,
    recognized: inspection.recognized,
    markerFree: inspection.markerFree
  });
  if (action === "other-app") {
    if (await exists(record.installedApp)) throw new Error("A different macOS app is already recorded. Uninstall it before patching another app.");
    action = "fresh";
  }
  if (action === "refuse") throw refuseError(inspection, Boolean(record && sameApp));
  if (action === "current") {
    options.onProgress?.("Updating the Mods host in the existing app");
    return finishCurrent(record);
  }
  if (action === "record-missing") {
    if (!sidecar?.originalHash || path4.resolve(sidecar.archive || "") !== archive) {
      throw new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
    }
    const bundleBackup = backupPath(sidecar.originalHash);
    const backupArchive = path4.join(bundleBackup, "Contents", "Resources", "app.asar");
    if (!await exists(backupArchive) || await sha256(backupArchive) !== sidecar.originalHash) {
      throw new Error("The archive is patched but its original backup is missing. Restore the original app before patching again.");
    }
    const executable = path4.join(installedApp, "Contents", "MacOS", await executableName(path4.join(installedApp, "Contents", "Info.plist"), options));
    const restored = await writeRecord({
      kind: "darwin",
      installedApp,
      original: installedApp,
      archive,
      executable,
      appVersion: sidecar.appVersion || inspection.version || "unknown",
      patchedInPlace: true,
      originalHash: sidecar.originalHash,
      patchedHash: liveHash,
      bundleBackup,
      previousBackup: null,
      signature: "adhoc",
      vendorCdHash: sidecar.vendorCdHash,
      vendorSignature: sidecar.vendorSignature
    });
    await retireLegacyManagedCopy(installedApp);
    return withUpdater({ ...restored, alreadyPatched: true, adoptedUpdate: false });
  }
  return patchIntoPlace(installedApp, liveHash, action === "adopt" ? record : null, options);
}
async function installMacApp(appPath, options = {}) {
  assertMac(options);
  if (typeof appPath !== "string" || !appPath.trim()) throw new Error("Choose the T3 .app bundle.");
  return withLock(() => installLocked(appPath, options));
}
async function launchMacApp(args2 = [], options = {}) {
  assertMac(options);
  const spawn2 = options.spawn ?? defaultSpawn;
  const record = await readRecord();
  if (!record) throw new Error("No macOS installation record found. Run install before launch.");
  let current = record;
  let reapplied = false;
  try {
    if (!await exists(record.archive) || await sha256(record.archive) !== record.patchedHash) {
      console.log("T3 updated. Reapplying mods to the installed app\u2026");
      current = await installMacApp(record.installedApp, options);
      reapplied = true;
    } else if (await exists(sidecarPaths(record.archive).stateFile)) {
      await patchArchive(record.archive, { managedCopy: true, checkOnly: true });
    }
  } catch (error) {
    console.warn(`Mods could not be loaded: ${failureText(error)}
Opening the installed T3 app with mods disabled.`);
    await spawn2(record.executable, args2, { env: { ...process.env, T3_MODS_DISABLE: "1" } });
    return withUpdater({ ...record, modsDisabled: true, reapplied: false });
  }
  try {
    await spawn2("/usr/bin/open", macOpenArguments(current.installedApp, args2));
  } catch (error) {
    console.warn(`Could not open ${current.installedApp}: ${failureText(error)}`);
    await spawn2(current.executable, args2);
  }
  return withUpdater({ ...current, reapplied });
}
async function restoreInstalledApp(record, options) {
  const parent = path4.dirname(record.installedApp);
  const stage = path4.join(parent, `.${path4.basename(record.installedApp)}.mods-restore-${process.pid}-${randomBytes(4).toString("hex")}`);
  let holding = null;
  let committed = false;
  try {
    await dittoBundle(record.bundleBackup, stage, options);
    if (await sha256(path4.join(stage, "Contents", "Resources", "app.asar")) !== record.originalHash) throw new Error("The backup checksum no longer matches. Restore refused.");
    const backupSignature = await signatureDetails(stage, options);
    if (record.vendorCdHash && backupSignature.cdhash !== record.vendorCdHash) throw new Error("The backup signature does not match the saved vendor app. Restore refused.");
    holding = await commitInstalledBundle(record.installedApp, stage);
    if (await sha256(record.archive) !== record.originalHash) throw new Error("Restored macOS archive checksum mismatch.");
    await verifySignature(record.installedApp, options);
    await rm2(recordPath);
    committed = true;
    await rm2(holding, { recursive: true, force: true }).catch((error) => {
      console.warn(`The patched macOS app was left at ${holding}: ${failureText(error)}`);
    });
    await removeOwnedBackup(record.bundleBackup, []);
    await removeOwnedBackup(record.previousBackup, []);
    return withUpdater({
      installedApp: record.installedApp,
      original: record.installedApp,
      archive: record.archive,
      executable: record.executable,
      appVersion: record.appVersion,
      patchedInPlace: true,
      signature: backupSignature.label,
      restored: true
    });
  } catch (error) {
    if (!committed && holding) {
      try {
        await rollbackCommit(record.installedApp, holding);
      } catch (rollbackError) {
        throw new Error(`${failureText(error)} The patched app is at ${holding} and could not be restored: ${failureText(rollbackError)}`);
      }
    }
    throw error;
  } finally {
    await rm2(stage, { recursive: true, force: true });
  }
}
async function uninstallMacApp(options = {}) {
  assertMac(options);
  return withLock(async () => {
    const record = await readRecord();
    if (!record) throw new Error("No macOS installation record found.");
    await restoreInterruptedInstall(record.installedApp);
    const liveHash = await sha256(record.archive);
    const inspection = await inspectArchive2(record.archive);
    const backupArchive = path4.join(record.bundleBackup, "Contents", "Resources", "app.asar");
    const backupHash = await exists(backupArchive) ? await sha256(backupArchive) : null;
    const plan = macRestorePlan({
      liveHash,
      recordedPatchedHash: record.patchedHash,
      backupHash,
      recordedOriginalHash: record.originalHash,
      recognized: inspection.recognized,
      markerFree: inspection.markerFree
    });
    if (plan === "keep-update") {
      await rm2(sidecarPaths(record.archive).stateFile, { force: true });
      await rm2(sidecarPaths(record.archive).backup, { force: true });
      await rm2(recordPath, { force: true });
      return withUpdater({
        installedApp: record.installedApp,
        original: record.installedApp,
        archive: record.archive,
        executable: record.executable,
        appVersion: inspection.version || record.appVersion,
        patchedInPlace: true,
        signature: record.signature,
        restored: false,
        keptUpdate: true
      });
    }
    if (plan !== "restore") {
      throw new Error(liveHash === record.patchedHash ? "The backup checksum no longer matches. Restore refused." : "The app changed after patching. Restore would overwrite an update, so it has been refused.");
    }
    return restoreInstalledApp(record, options);
  });
}
async function assertMacAppNotRunning(installedApp, options) {
  if (options.assertClosed) {
    await options.assertClosed(installedApp);
    return;
  }
  const listed = await runnerFor(options)("/bin/ps", ["-axo", "pid=,comm="]);
  if (appPids(`${listed.stdout ?? ""}
${listed.stderr ?? ""}`, installedApp).length > 0) {
    throw new Error("T3 is open. Close it before preparing the native update. No app files have been changed.");
  }
}
function preparationRefusal(liveHash, record, basePlan) {
  if (basePlan === "restore") return new Error("The saved backup is not a verified vendor-signed app. Native update preparation refused.");
  if (liveHash === record.patchedHash) return new Error("The backup checksum no longer matches. Restore refused.");
  return new Error("The app changed after patching. Restore would overwrite an update, so it has been refused.");
}
async function prepareMacNativeUpdate(options = {}) {
  assertMac(options);
  return withLock(async () => {
    const record = await readRecord();
    if (!record) throw new Error("No macOS installation record found.");
    await assertMacAppNotRunning(record.installedApp, options);
    await restoreInterruptedInstall(record.installedApp);
    const liveHash = await sha256(record.archive);
    const inspection = await inspectArchive2(record.archive);
    const backupArchive = path4.join(record.bundleBackup, "Contents", "Resources", "app.asar");
    const backupHash = await exists(backupArchive) ? await sha256(backupArchive) : null;
    const basePlan = macRestorePlan({
      liveHash,
      recordedPatchedHash: record.patchedHash,
      backupHash,
      recordedOriginalHash: record.originalHash,
      recognized: inspection.recognized,
      markerFree: inspection.markerFree
    });
    let backupAdhoc = true;
    let backupCdHash = null;
    if (basePlan === "restore") {
      const signed = await signatureDetails(record.bundleBackup, options);
      backupAdhoc = signed.adhoc;
      backupCdHash = signed.cdhash;
    }
    const plan = macNativeUpdatePreparationPlan({
      liveHash,
      recordedPatchedHash: record.patchedHash,
      backupHash,
      recordedOriginalHash: record.originalHash,
      recognized: inspection.recognized,
      markerFree: inspection.markerFree,
      backupAdhoc,
      backupCdHash,
      vendorCdHash: record.vendorCdHash
    });
    switch (plan) {
      case "keep-update":
        return withUpdater({
          action: "kept-update",
          prepared: true,
          restored: false,
          keptUpdate: true,
          installedApp: record.installedApp,
          original: record.installedApp,
          archive: record.archive,
          executable: record.executable,
          appVersion: inspection.version || record.appVersion,
          patchedInPlace: true,
          signature: record.signature
        });
      case "refuse":
        throw preparationRefusal(liveHash, record, basePlan);
      case "restore": {
        options.onProgress?.("Restoring the verified original signed app");
        const restored = await restoreInstalledApp(record, options);
        return {
          action: "restored-vendor",
          prepared: true,
          restored: true,
          keptUpdate: false,
          installedApp: restored.installedApp,
          original: restored.original,
          archive: restored.archive,
          executable: restored.executable,
          appVersion: restored.appVersion,
          patchedInPlace: true,
          signature: restored.signature,
          updaterEnabled: true,
          nativeUpdaterVerified: false
        };
      }
      default: {
        const unreachable = plan;
        throw new Error(`Unexpected native update preparation: ${String(unreachable)}`);
      }
    }
  });
}
async function doctorMacApp(options = {}) {
  assertMac(options);
  const record = await readRecord();
  if (!record) throw new Error("No macOS installation record found.");
  const liveHash = await exists(record.archive) ? await sha256(record.archive) : null;
  let signature = record.signature;
  try {
    if (await exists(record.installedApp)) signature = (await signatureDetails(record.installedApp, options)).label;
  } catch {
    signature = record.signature;
  }
  return {
    compatible: true,
    patched: liveHash === record.patchedHash,
    needsRepatch: liveHash !== record.patchedHash,
    installedApp: record.installedApp,
    original: record.installedApp,
    archive: record.archive,
    executable: record.executable,
    appVersion: record.appVersion,
    patchedHash: record.patchedHash,
    originalHash: record.originalHash,
    signature,
    bundleBackup: record.bundleBackup,
    patchedInPlace: true,
    ...updaterStatus
  };
}

// src/windows-resources.ts
import { readFile as readFile3, writeFile as writeFile3 } from "node:fs/promises";

// node_modules/pe-library/dist/format/FormatBase.js
var FormatBase = (
  /** @class */
  (function() {
    function FormatBase2(view) {
      this.view = view;
    }
    FormatBase2.prototype.copyTo = function(bin, offset) {
      new Uint8Array(bin, offset, this.view.byteLength).set(new Uint8Array(this.view.buffer, this.view.byteOffset, this.view.byteLength));
    };
    Object.defineProperty(FormatBase2.prototype, "byteLength", {
      get: function() {
        return this.view.byteLength;
      },
      enumerable: false,
      configurable: true
    });
    return FormatBase2;
  })()
);
var FormatBase_default = FormatBase;

// node_modules/pe-library/dist/format/ArrayFormatBase.js
var __extends = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var ArrayFormatBase = (
  /** @class */
  (function(_super) {
    __extends(ArrayFormatBase2, _super);
    function ArrayFormatBase2(view) {
      return _super.call(this, view) || this;
    }
    ArrayFormatBase2.prototype.forEach = function(callback) {
      var len = this.length;
      var a = [];
      a.length = len;
      for (var i = 0; i < len; ++i) {
        a[i] = this.get(i);
      }
      for (var i = 0; i < len; ++i) {
        callback(a[i], i, this);
      }
    };
    ArrayFormatBase2.prototype._iterator = function() {
      return new /** @class */
      ((function() {
        function class_1(base) {
          this.base = base;
          this.i = 0;
        }
        class_1.prototype.next = function() {
          if (this.i === this.base.length) {
            return {
              value: void 0,
              done: true
            };
          } else {
            return {
              value: this.base.get(this.i++),
              done: false
            };
          }
        };
        return class_1;
      })())(this);
    };
    return ArrayFormatBase2;
  })(FormatBase_default)
);
if (typeof Symbol !== "undefined") {
  ArrayFormatBase.prototype[Symbol.iterator] = // eslint-disable-next-line @typescript-eslint/unbound-method
  ArrayFormatBase.prototype._iterator;
}
var ArrayFormatBase_default = ArrayFormatBase;

// node_modules/pe-library/dist/format/ImageDataDirectoryArray.js
var __extends2 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var ImageDataDirectoryArray = (
  /** @class */
  (function(_super) {
    __extends2(ImageDataDirectoryArray2, _super);
    function ImageDataDirectoryArray2(view) {
      var _this = _super.call(this, view) || this;
      _this.length = 16;
      return _this;
    }
    ImageDataDirectoryArray2.from = function(bin, offset) {
      if (offset === void 0) {
        offset = 0;
      }
      return new ImageDataDirectoryArray2(new DataView(bin, offset, 128));
    };
    ImageDataDirectoryArray2.prototype.get = function(index) {
      return {
        virtualAddress: this.view.getUint32(index * 8, true),
        size: this.view.getUint32(4 + index * 8, true)
      };
    };
    ImageDataDirectoryArray2.prototype.set = function(index, data) {
      this.view.setUint32(index * 8, data.virtualAddress, true);
      this.view.setUint32(4 + index * 8, data.size, true);
    };
    ImageDataDirectoryArray2.prototype.findIndexByVirtualAddress = function(virtualAddress) {
      for (var i = 0; i < 16; ++i) {
        var va = this.view.getUint32(i * 8, true);
        var vs = this.view.getUint32(4 + i * 8, true);
        if (virtualAddress >= va && virtualAddress < va + vs) {
          return i;
        }
      }
      return null;
    };
    ImageDataDirectoryArray2.size = 128;
    ImageDataDirectoryArray2.itemSize = 8;
    return ImageDataDirectoryArray2;
  })(ArrayFormatBase_default)
);
var ImageDataDirectoryArray_default = ImageDataDirectoryArray;

// node_modules/pe-library/dist/format/ImageDirectoryEntry.js
var ImageDirectoryEntry = {
  Export: 0,
  Import: 1,
  Resource: 2,
  Exception: 3,
  Certificate: 4,
  Security: 4,
  BaseRelocation: 5,
  Debug: 6,
  Architecture: 7,
  GlobalPointer: 8,
  Tls: 9,
  TLS: 9,
  LoadConfig: 10,
  BoundImport: 11,
  Iat: 12,
  IAT: 12,
  DelayImport: 13,
  ComDescriptor: 14,
  COMDescriptor: 14
  // alias
};
var ImageDirectoryEntry_default = ImageDirectoryEntry;

// node_modules/pe-library/dist/util/functions.js
function cloneObject(object) {
  var r = {};
  Object.keys(object).forEach(function(key) {
    r[key] = object[key];
  });
  return r;
}
function createDataView(bin, byteOffset, byteLength) {
  if ("buffer" in bin) {
    var newOffset = bin.byteOffset;
    var newLength = bin.byteLength;
    if (typeof byteOffset !== "undefined") {
      newOffset += byteOffset;
      newLength -= byteOffset;
    }
    if (typeof byteLength !== "undefined") {
      newLength = byteLength;
    }
    return new DataView(bin.buffer, newOffset, newLength);
  } else {
    return new DataView(bin, byteOffset, byteLength);
  }
}
function calculateCheckSumForPE(bin, storeToBinary) {
  var dosHeader = ImageDosHeader_default.from(bin);
  var view = new DataView(bin);
  var checkSumOffset = dosHeader.newHeaderAddress + 88;
  var result = 0;
  var limit = 4294967296;
  var update2 = function(dword) {
    result += dword;
    if (result >= limit) {
      result = result % limit + (result / limit | 0);
    }
  };
  var len = view.byteLength;
  var lenExtra = len % 4;
  var lenAlign = len - lenExtra;
  for (var i = 0; i < lenAlign; i += 4) {
    if (i !== checkSumOffset) {
      update2(view.getUint32(i, true));
    }
  }
  if (lenExtra !== 0) {
    var extra = 0;
    for (var i = 0; i < lenExtra; i++) {
      extra |= view.getUint8(lenAlign + i) << (3 - i) * 8;
    }
    update2(extra);
  }
  result = (result & 65535) + (result >>> 16);
  result += result >>> 16;
  result = (result & 65535) + len;
  if (storeToBinary) {
    view.setUint32(checkSumOffset, result, true);
  }
  return result;
}
function roundUp(val, align) {
  return Math.floor((val + align - 1) / align) * align;
}
function copyBuffer(dest, destOffset, src, srcOffset, length) {
  var ua8Dest = "buffer" in dest ? new Uint8Array(dest.buffer, dest.byteOffset + (destOffset || 0), length) : new Uint8Array(dest, destOffset, length);
  var ua8Src = "buffer" in src ? new Uint8Array(src.buffer, src.byteOffset + (srcOffset || 0), length) : new Uint8Array(src, srcOffset, length);
  ua8Dest.set(ua8Src);
}
function allocatePartialBinary(binBase, offset, length) {
  var b = new ArrayBuffer(length);
  copyBuffer(b, 0, binBase, offset, length);
  return b;
}
function cloneToArrayBuffer(binBase) {
  if ("buffer" in binBase) {
    var b = new ArrayBuffer(binBase.byteLength);
    new Uint8Array(b).set(new Uint8Array(binBase.buffer, binBase.byteOffset, binBase.byteLength));
    return b;
  } else {
    var b = new ArrayBuffer(binBase.byteLength);
    new Uint8Array(b).set(new Uint8Array(binBase));
    return b;
  }
}
function getFixedString(view, offset, length) {
  var actualLen = 0;
  for (var i = 0; i < length; ++i) {
    if (view.getUint8(offset + i) === 0) {
      break;
    }
    ++actualLen;
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(view.buffer, view.byteOffset + offset, actualLen).toString("utf8");
  } else if (typeof decodeURIComponent !== "undefined") {
    var s = "";
    for (var i = 0; i < actualLen; ++i) {
      var c = view.getUint8(offset + i);
      if (c < 16) {
        s += "%0" + c.toString(16);
      } else {
        s += "%" + c.toString(16);
      }
    }
    return decodeURIComponent(s);
  } else {
    var s = "";
    for (var i = 0; i < actualLen; ++i) {
      var c = view.getUint8(offset + i);
      s += String.fromCharCode(c);
    }
    return s;
  }
}
function setFixedString(view, offset, length, text) {
  if (typeof Buffer !== "undefined") {
    var u = new Uint8Array(view.buffer, view.byteOffset + offset, length);
    u.set(new Uint8Array(length));
    u.set(Buffer.from(text, "utf8").subarray(0, length));
  } else if (typeof encodeURIComponent !== "undefined") {
    var s = encodeURIComponent(text);
    for (var i = 0, j = 0; i < length; ++i) {
      if (j >= s.length) {
        view.setUint8(i + offset, 0);
      } else {
        var c = s.charCodeAt(j);
        if (c === 37) {
          var n = parseInt(s.substr(j + 1, 2), 16);
          if (typeof n === "number" && !isNaN(n)) {
            view.setUint8(i + offset, n);
          } else {
            view.setUint8(i + offset, 0);
          }
          j += 3;
        } else {
          view.setUint8(i + offset, c);
        }
      }
    }
  } else {
    for (var i = 0, j = 0; i < length; ++i) {
      if (j >= text.length) {
        view.setUint8(i + offset, 0);
      } else {
        var c = text.charCodeAt(j);
        view.setUint8(i + offset, c & 255);
      }
    }
  }
}
function binaryToString(bin) {
  if (typeof TextDecoder !== "undefined") {
    var dec = new TextDecoder();
    return dec.decode(bin);
  } else if (typeof Buffer !== "undefined") {
    var b = void 0;
    if ("buffer" in bin) {
      b = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
    } else {
      b = Buffer.from(bin);
    }
    return b.toString("utf8");
  } else {
    var view = void 0;
    if ("buffer" in bin) {
      view = new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
    } else {
      view = new Uint8Array(bin);
    }
    if (typeof decodeURIComponent !== "undefined") {
      var s = "";
      for (var i = 0; i < view.length; ++i) {
        var c = view[i];
        if (c < 16) {
          s += "%0" + c.toString(16);
        } else {
          s += "%" + c.toString(16);
        }
      }
      return decodeURIComponent(s);
    } else {
      var s = "";
      for (var i = 0; i < view.length; ++i) {
        var c = view[i];
        s += String.fromCharCode(c);
      }
      return s;
    }
  }
}
function stringToBinary(string) {
  if (typeof TextEncoder !== "undefined") {
    var enc = new TextEncoder();
    return cloneToArrayBuffer(enc.encode(string));
  } else if (typeof Buffer !== "undefined") {
    return cloneToArrayBuffer(Buffer.from(string, "utf8"));
  } else if (typeof encodeURIComponent !== "undefined") {
    var data = encodeURIComponent(string);
    var len = 0;
    for (var i = 0; i < data.length; ++len) {
      var c = data.charCodeAt(i);
      if (c === 37) {
        i += 3;
      } else {
        ++i;
      }
    }
    var bin = new ArrayBuffer(len);
    var view = new Uint8Array(bin);
    for (var i = 0, j = 0; i < data.length; ++j) {
      var c = data.charCodeAt(i);
      if (c === 37) {
        var n = parseInt(data.substring(i + 1, i + 3), 16);
        view[j] = n;
        i += 3;
      } else {
        view[j] = c;
        ++i;
      }
    }
    return bin;
  } else {
    var bin = new ArrayBuffer(string.length);
    new Uint8Array(bin).set([].map.call(string, function(c2) {
      return c2.charCodeAt(0);
    }));
    return bin;
  }
}

// node_modules/pe-library/dist/format/ImageDosHeader.js
var __extends3 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var ImageDosHeader = (
  /** @class */
  (function(_super) {
    __extends3(ImageDosHeader2, _super);
    function ImageDosHeader2(view) {
      return _super.call(this, view) || this;
    }
    ImageDosHeader2.from = function(bin, offset) {
      if (offset === void 0) {
        offset = 0;
      }
      return new ImageDosHeader2(createDataView(bin, offset, 64));
    };
    ImageDosHeader2.prototype.isValid = function() {
      return this.magic === ImageDosHeader2.DEFAULT_MAGIC;
    };
    Object.defineProperty(ImageDosHeader2.prototype, "magic", {
      get: function() {
        return this.view.getUint16(0, true);
      },
      set: function(val) {
        this.view.setUint16(0, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "lastPageSize", {
      get: function() {
        return this.view.getUint16(2, true);
      },
      set: function(val) {
        this.view.setUint16(2, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "pages", {
      get: function() {
        return this.view.getUint16(4, true);
      },
      set: function(val) {
        this.view.setUint16(4, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "relocations", {
      get: function() {
        return this.view.getUint16(6, true);
      },
      set: function(val) {
        this.view.setUint16(6, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "headerSizeInParagraph", {
      get: function() {
        return this.view.getUint16(8, true);
      },
      set: function(val) {
        this.view.setUint16(8, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "minAllocParagraphs", {
      get: function() {
        return this.view.getUint16(10, true);
      },
      set: function(val) {
        this.view.setUint16(10, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "maxAllocParagraphs", {
      get: function() {
        return this.view.getUint16(12, true);
      },
      set: function(val) {
        this.view.setUint16(12, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "initialSS", {
      get: function() {
        return this.view.getUint16(14, true);
      },
      set: function(val) {
        this.view.setUint16(14, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "initialSP", {
      get: function() {
        return this.view.getUint16(16, true);
      },
      set: function(val) {
        this.view.setUint16(16, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "checkSum", {
      get: function() {
        return this.view.getUint16(18, true);
      },
      set: function(val) {
        this.view.setUint16(18, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "initialIP", {
      get: function() {
        return this.view.getUint16(20, true);
      },
      set: function(val) {
        this.view.setUint16(20, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "initialCS", {
      get: function() {
        return this.view.getUint16(22, true);
      },
      set: function(val) {
        this.view.setUint16(22, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "relocationTableAddress", {
      get: function() {
        return this.view.getUint16(24, true);
      },
      set: function(val) {
        this.view.setUint16(24, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "overlayNum", {
      get: function() {
        return this.view.getUint16(26, true);
      },
      set: function(val) {
        this.view.setUint16(26, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "oemId", {
      // WORD e_res[4] (28,30,32,34)
      get: function() {
        return this.view.getUint16(36, true);
      },
      set: function(val) {
        this.view.setUint16(36, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "oemInfo", {
      get: function() {
        return this.view.getUint16(38, true);
      },
      set: function(val) {
        this.view.setUint16(38, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageDosHeader2.prototype, "newHeaderAddress", {
      // WORD e_res2[10] (40,42,44,46,48,50,52,54,56,58)
      get: function() {
        return this.view.getUint32(60, true);
      },
      set: function(val) {
        this.view.setUint32(60, val, true);
      },
      enumerable: false,
      configurable: true
    });
    ImageDosHeader2.size = 64;
    ImageDosHeader2.DEFAULT_MAGIC = 23117;
    return ImageDosHeader2;
  })(FormatBase_default)
);
var ImageDosHeader_default = ImageDosHeader;

// node_modules/pe-library/dist/format/ImageFileHeader.js
var __extends4 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var ImageFileHeader = (
  /** @class */
  (function(_super) {
    __extends4(ImageFileHeader2, _super);
    function ImageFileHeader2(view) {
      return _super.call(this, view) || this;
    }
    ImageFileHeader2.from = function(bin, offset) {
      if (offset === void 0) {
        offset = 0;
      }
      return new ImageFileHeader2(new DataView(bin, offset, 20));
    };
    Object.defineProperty(ImageFileHeader2.prototype, "machine", {
      get: function() {
        return this.view.getUint16(0, true);
      },
      set: function(val) {
        this.view.setUint16(0, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageFileHeader2.prototype, "numberOfSections", {
      get: function() {
        return this.view.getUint16(2, true);
      },
      set: function(val) {
        this.view.setUint16(2, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageFileHeader2.prototype, "timeDateStamp", {
      get: function() {
        return this.view.getUint32(4, true);
      },
      set: function(val) {
        this.view.setUint32(4, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageFileHeader2.prototype, "pointerToSymbolTable", {
      get: function() {
        return this.view.getUint32(8, true);
      },
      set: function(val) {
        this.view.setUint32(8, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageFileHeader2.prototype, "numberOfSymbols", {
      get: function() {
        return this.view.getUint32(12, true);
      },
      set: function(val) {
        this.view.setUint32(12, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageFileHeader2.prototype, "sizeOfOptionalHeader", {
      get: function() {
        return this.view.getUint16(16, true);
      },
      set: function(val) {
        this.view.setUint16(16, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageFileHeader2.prototype, "characteristics", {
      get: function() {
        return this.view.getUint16(18, true);
      },
      set: function(val) {
        this.view.setUint16(18, val, true);
      },
      enumerable: false,
      configurable: true
    });
    ImageFileHeader2.size = 20;
    return ImageFileHeader2;
  })(FormatBase_default)
);
var ImageFileHeader_default = ImageFileHeader;

// node_modules/pe-library/dist/format/ImageOptionalHeader.js
var __extends5 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var ImageOptionalHeader = (
  /** @class */
  (function(_super) {
    __extends5(ImageOptionalHeader2, _super);
    function ImageOptionalHeader2(view) {
      return _super.call(this, view) || this;
    }
    ImageOptionalHeader2.from = function(bin, offset) {
      if (offset === void 0) {
        offset = 0;
      }
      return new ImageOptionalHeader2(new DataView(bin, offset, 96));
    };
    Object.defineProperty(ImageOptionalHeader2.prototype, "magic", {
      get: function() {
        return this.view.getUint16(0, true);
      },
      set: function(val) {
        this.view.setUint16(0, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "majorLinkerVersion", {
      get: function() {
        return this.view.getUint8(2);
      },
      set: function(val) {
        this.view.setUint8(2, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "minorLinkerVersion", {
      get: function() {
        return this.view.getUint8(3);
      },
      set: function(val) {
        this.view.setUint8(3, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfCode", {
      get: function() {
        return this.view.getUint32(4, true);
      },
      set: function(val) {
        this.view.setUint32(4, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfInitializedData", {
      get: function() {
        return this.view.getUint32(8, true);
      },
      set: function(val) {
        this.view.setUint32(8, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfUninitializedData", {
      get: function() {
        return this.view.getUint32(12, true);
      },
      set: function(val) {
        this.view.setUint32(12, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "addressOfEntryPoint", {
      get: function() {
        return this.view.getUint32(16, true);
      },
      set: function(val) {
        this.view.setUint32(16, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "baseOfCode", {
      get: function() {
        return this.view.getUint32(20, true);
      },
      set: function(val) {
        this.view.setUint32(20, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "baseOfData", {
      get: function() {
        return this.view.getUint32(24, true);
      },
      set: function(val) {
        this.view.setUint32(24, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "imageBase", {
      get: function() {
        return this.view.getUint32(28, true);
      },
      set: function(val) {
        this.view.setUint32(28, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sectionAlignment", {
      get: function() {
        return this.view.getUint32(32, true);
      },
      set: function(val) {
        this.view.setUint32(32, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "fileAlignment", {
      get: function() {
        return this.view.getUint32(36, true);
      },
      set: function(val) {
        this.view.setUint32(36, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "majorOperatingSystemVersion", {
      get: function() {
        return this.view.getUint16(40, true);
      },
      set: function(val) {
        this.view.setUint16(40, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "minorOperatingSystemVersion", {
      get: function() {
        return this.view.getUint16(42, true);
      },
      set: function(val) {
        this.view.setUint16(42, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "majorImageVersion", {
      get: function() {
        return this.view.getUint16(44, true);
      },
      set: function(val) {
        this.view.setUint16(44, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "minorImageVersion", {
      get: function() {
        return this.view.getUint16(46, true);
      },
      set: function(val) {
        this.view.setUint16(46, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "majorSubsystemVersion", {
      get: function() {
        return this.view.getUint16(48, true);
      },
      set: function(val) {
        this.view.setUint16(48, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "minorSubsystemVersion", {
      get: function() {
        return this.view.getUint16(50, true);
      },
      set: function(val) {
        this.view.setUint16(50, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "win32VersionValue", {
      get: function() {
        return this.view.getUint32(52, true);
      },
      set: function(val) {
        this.view.setUint32(52, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfImage", {
      get: function() {
        return this.view.getUint32(56, true);
      },
      set: function(val) {
        this.view.setUint32(56, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfHeaders", {
      get: function() {
        return this.view.getUint32(60, true);
      },
      set: function(val) {
        this.view.setUint32(60, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "checkSum", {
      get: function() {
        return this.view.getUint32(64, true);
      },
      set: function(val) {
        this.view.setUint32(64, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "subsystem", {
      get: function() {
        return this.view.getUint16(68, true);
      },
      set: function(val) {
        this.view.setUint16(68, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "dllCharacteristics", {
      get: function() {
        return this.view.getUint16(70, true);
      },
      set: function(val) {
        this.view.setUint16(70, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfStackReserve", {
      get: function() {
        return this.view.getUint32(72, true);
      },
      set: function(val) {
        this.view.setUint32(72, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfStackCommit", {
      get: function() {
        return this.view.getUint32(76, true);
      },
      set: function(val) {
        this.view.setUint32(76, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfHeapReserve", {
      get: function() {
        return this.view.getUint32(80, true);
      },
      set: function(val) {
        this.view.setUint32(80, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "sizeOfHeapCommit", {
      get: function() {
        return this.view.getUint32(84, true);
      },
      set: function(val) {
        this.view.setUint32(84, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "loaderFlags", {
      get: function() {
        return this.view.getUint32(88, true);
      },
      set: function(val) {
        this.view.setUint32(88, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader2.prototype, "numberOfRvaAndSizes", {
      get: function() {
        return this.view.getUint32(92, true);
      },
      set: function(val) {
        this.view.setUint32(92, val, true);
      },
      enumerable: false,
      configurable: true
    });
    ImageOptionalHeader2.size = 96;
    ImageOptionalHeader2.DEFAULT_MAGIC = 267;
    return ImageOptionalHeader2;
  })(FormatBase_default)
);
var ImageOptionalHeader_default = ImageOptionalHeader;

// node_modules/pe-library/dist/format/ImageOptionalHeader64.js
var __extends6 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
function getUint64LE(view, offset) {
  return view.getUint32(offset + 4, true) * 4294967296 + view.getUint32(offset, true);
}
function setUint64LE(view, offset, val) {
  view.setUint32(offset, val & 4294967295, true);
  view.setUint32(offset + 4, Math.floor(val / 4294967296), true);
}
function getUint64LEBigInt(view, offset) {
  if (typeof BigInt === "undefined") {
    throw new Error("BigInt not supported");
  }
  return BigInt(4294967296) * BigInt(view.getUint32(offset + 4, true)) + BigInt(view.getUint32(offset, true));
}
function setUint64LEBigInt(view, offset, val) {
  if (typeof BigInt === "undefined") {
    throw new Error("BigInt not supported");
  }
  view.setUint32(offset, Number(val & BigInt(4294967295)), true);
  view.setUint32(offset + 4, Math.floor(Number(val / BigInt(4294967296) & BigInt(4294967295))), true);
}
var ImageOptionalHeader64 = (
  /** @class */
  (function(_super) {
    __extends6(ImageOptionalHeader642, _super);
    function ImageOptionalHeader642(view) {
      return _super.call(this, view) || this;
    }
    ImageOptionalHeader642.from = function(bin, offset) {
      if (offset === void 0) {
        offset = 0;
      }
      return new ImageOptionalHeader642(new DataView(bin, offset, 112));
    };
    Object.defineProperty(ImageOptionalHeader642.prototype, "magic", {
      get: function() {
        return this.view.getUint16(0, true);
      },
      set: function(val) {
        this.view.setUint16(0, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "majorLinkerVersion", {
      get: function() {
        return this.view.getUint8(2);
      },
      set: function(val) {
        this.view.setUint8(2, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "minorLinkerVersion", {
      get: function() {
        return this.view.getUint8(3);
      },
      set: function(val) {
        this.view.setUint8(3, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfCode", {
      get: function() {
        return this.view.getUint32(4, true);
      },
      set: function(val) {
        this.view.setUint32(4, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfInitializedData", {
      get: function() {
        return this.view.getUint32(8, true);
      },
      set: function(val) {
        this.view.setUint32(8, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfUninitializedData", {
      get: function() {
        return this.view.getUint32(12, true);
      },
      set: function(val) {
        this.view.setUint32(12, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "addressOfEntryPoint", {
      get: function() {
        return this.view.getUint32(16, true);
      },
      set: function(val) {
        this.view.setUint32(16, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "baseOfCode", {
      get: function() {
        return this.view.getUint32(20, true);
      },
      set: function(val) {
        this.view.setUint32(20, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "imageBase", {
      get: function() {
        return getUint64LE(this.view, 24);
      },
      set: function(val) {
        setUint64LE(this.view, 24, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "imageBaseBigInt", {
      get: function() {
        return getUint64LEBigInt(this.view, 24);
      },
      set: function(val) {
        setUint64LEBigInt(this.view, 24, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sectionAlignment", {
      get: function() {
        return this.view.getUint32(32, true);
      },
      set: function(val) {
        this.view.setUint32(32, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "fileAlignment", {
      get: function() {
        return this.view.getUint32(36, true);
      },
      set: function(val) {
        this.view.setUint32(36, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "majorOperatingSystemVersion", {
      get: function() {
        return this.view.getUint16(40, true);
      },
      set: function(val) {
        this.view.setUint16(40, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "minorOperatingSystemVersion", {
      get: function() {
        return this.view.getUint16(42, true);
      },
      set: function(val) {
        this.view.setUint16(42, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "majorImageVersion", {
      get: function() {
        return this.view.getUint16(44, true);
      },
      set: function(val) {
        this.view.setUint16(44, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "minorImageVersion", {
      get: function() {
        return this.view.getUint16(46, true);
      },
      set: function(val) {
        this.view.setUint16(46, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "majorSubsystemVersion", {
      get: function() {
        return this.view.getUint16(48, true);
      },
      set: function(val) {
        this.view.setUint16(48, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "minorSubsystemVersion", {
      get: function() {
        return this.view.getUint16(50, true);
      },
      set: function(val) {
        this.view.setUint16(50, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "win32VersionValue", {
      get: function() {
        return this.view.getUint32(52, true);
      },
      set: function(val) {
        this.view.setUint32(52, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfImage", {
      get: function() {
        return this.view.getUint32(56, true);
      },
      set: function(val) {
        this.view.setUint32(56, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfHeaders", {
      get: function() {
        return this.view.getUint32(60, true);
      },
      set: function(val) {
        this.view.setUint32(60, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "checkSum", {
      get: function() {
        return this.view.getUint32(64, true);
      },
      set: function(val) {
        this.view.setUint32(64, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "subsystem", {
      get: function() {
        return this.view.getUint16(68, true);
      },
      set: function(val) {
        this.view.setUint16(68, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "dllCharacteristics", {
      get: function() {
        return this.view.getUint16(70, true);
      },
      set: function(val) {
        this.view.setUint16(70, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfStackReserve", {
      get: function() {
        return getUint64LE(this.view, 72);
      },
      set: function(val) {
        setUint64LE(this.view, 72, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfStackReserveBigInt", {
      get: function() {
        return getUint64LEBigInt(this.view, 72);
      },
      set: function(val) {
        setUint64LEBigInt(this.view, 72, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfStackCommit", {
      get: function() {
        return getUint64LE(this.view, 80);
      },
      set: function(val) {
        setUint64LE(this.view, 80, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfStackCommitBigInt", {
      get: function() {
        return getUint64LEBigInt(this.view, 80);
      },
      set: function(val) {
        setUint64LEBigInt(this.view, 80, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfHeapReserve", {
      get: function() {
        return getUint64LE(this.view, 88);
      },
      set: function(val) {
        setUint64LE(this.view, 88, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfHeapReserveBigInt", {
      get: function() {
        return getUint64LEBigInt(this.view, 88);
      },
      set: function(val) {
        setUint64LEBigInt(this.view, 88, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfHeapCommit", {
      get: function() {
        return getUint64LE(this.view, 96);
      },
      set: function(val) {
        setUint64LE(this.view, 96, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "sizeOfHeapCommitBigInt", {
      get: function() {
        return getUint64LEBigInt(this.view, 96);
      },
      set: function(val) {
        setUint64LEBigInt(this.view, 96, val);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "loaderFlags", {
      get: function() {
        return this.view.getUint32(104, true);
      },
      set: function(val) {
        this.view.setUint32(104, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageOptionalHeader642.prototype, "numberOfRvaAndSizes", {
      get: function() {
        return this.view.getUint32(108, true);
      },
      set: function(val) {
        this.view.setUint32(108, val, true);
      },
      enumerable: false,
      configurable: true
    });
    ImageOptionalHeader642.size = 112;
    ImageOptionalHeader642.DEFAULT_MAGIC = 523;
    return ImageOptionalHeader642;
  })(FormatBase_default)
);
var ImageOptionalHeader64_default = ImageOptionalHeader64;

// node_modules/pe-library/dist/format/ImageNtHeaders.js
var __extends7 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var ImageNtHeaders = (
  /** @class */
  (function(_super) {
    __extends7(ImageNtHeaders2, _super);
    function ImageNtHeaders2(view) {
      return _super.call(this, view) || this;
    }
    ImageNtHeaders2.from = function(bin, offset) {
      if (offset === void 0) {
        offset = 0;
      }
      var magic = createDataView(bin, offset + ImageFileHeader_default.size, 6).getUint16(4, true);
      var len = 4 + ImageFileHeader_default.size + ImageDataDirectoryArray_default.size;
      if (magic === ImageOptionalHeader64_default.DEFAULT_MAGIC) {
        len += ImageOptionalHeader64_default.size;
      } else {
        len += ImageOptionalHeader_default.size;
      }
      return new ImageNtHeaders2(createDataView(bin, offset, len));
    };
    ImageNtHeaders2.prototype.isValid = function() {
      return this.signature === ImageNtHeaders2.DEFAULT_SIGNATURE;
    };
    ImageNtHeaders2.prototype.is32bit = function() {
      return this.view.getUint16(ImageFileHeader_default.size + 4, true) === ImageOptionalHeader_default.DEFAULT_MAGIC;
    };
    Object.defineProperty(ImageNtHeaders2.prototype, "signature", {
      get: function() {
        return this.view.getUint32(0, true);
      },
      set: function(val) {
        this.view.setUint32(0, val, true);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageNtHeaders2.prototype, "fileHeader", {
      get: function() {
        return ImageFileHeader_default.from(this.view.buffer, this.view.byteOffset + 4);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageNtHeaders2.prototype, "optionalHeader", {
      get: function() {
        var off = ImageFileHeader_default.size + 4;
        var magic = this.view.getUint16(off, true);
        if (magic === ImageOptionalHeader64_default.DEFAULT_MAGIC) {
          return ImageOptionalHeader64_default.from(this.view.buffer, this.view.byteOffset + off);
        } else {
          return ImageOptionalHeader_default.from(this.view.buffer, this.view.byteOffset + off);
        }
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(ImageNtHeaders2.prototype, "optionalHeaderDataDirectory", {
      get: function() {
        return ImageDataDirectoryArray_default.from(this.view.buffer, this.view.byteOffset + this.getDataDirectoryOffset());
      },
      enumerable: false,
      configurable: true
    });
    ImageNtHeaders2.prototype.getDataDirectoryOffset = function() {
      var off = ImageFileHeader_default.size + 4;
      var magic = this.view.getUint16(off, true);
      if (magic === ImageOptionalHeader64_default.DEFAULT_MAGIC) {
        off += ImageOptionalHeader64_default.size;
      } else {
        off += ImageOptionalHeader_default.size;
      }
      return off;
    };
    ImageNtHeaders2.prototype.getSectionHeaderOffset = function() {
      return this.getDataDirectoryOffset() + ImageDataDirectoryArray_default.size;
    };
    ImageNtHeaders2.DEFAULT_SIGNATURE = 17744;
    return ImageNtHeaders2;
  })(FormatBase_default)
);
var ImageNtHeaders_default = ImageNtHeaders;

// node_modules/pe-library/dist/format/ImageSectionHeaderArray.js
var __extends8 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var ImageSectionHeaderArray = (
  /** @class */
  (function(_super) {
    __extends8(ImageSectionHeaderArray2, _super);
    function ImageSectionHeaderArray2(view, length) {
      var _this = _super.call(this, view) || this;
      _this.length = length;
      return _this;
    }
    ImageSectionHeaderArray2.from = function(bin, length, offset) {
      if (offset === void 0) {
        offset = 0;
      }
      var size = length * 40;
      return new ImageSectionHeaderArray2(new DataView(bin, offset, size), length);
    };
    ImageSectionHeaderArray2.prototype.get = function(index) {
      return {
        name: getFixedString(this.view, index * 40, 8),
        virtualSize: this.view.getUint32(8 + index * 40, true),
        virtualAddress: this.view.getUint32(12 + index * 40, true),
        sizeOfRawData: this.view.getUint32(16 + index * 40, true),
        pointerToRawData: this.view.getUint32(20 + index * 40, true),
        pointerToRelocations: this.view.getUint32(24 + index * 40, true),
        pointerToLineNumbers: this.view.getUint32(28 + index * 40, true),
        numberOfRelocations: this.view.getUint16(32 + index * 40, true),
        numberOfLineNumbers: this.view.getUint16(34 + index * 40, true),
        characteristics: this.view.getUint32(36 + index * 40, true)
      };
    };
    ImageSectionHeaderArray2.prototype.set = function(index, data) {
      setFixedString(this.view, index * 40, 8, data.name);
      this.view.setUint32(8 + index * 40, data.virtualSize, true);
      this.view.setUint32(12 + index * 40, data.virtualAddress, true);
      this.view.setUint32(16 + index * 40, data.sizeOfRawData, true);
      this.view.setUint32(20 + index * 40, data.pointerToRawData, true);
      this.view.setUint32(24 + index * 40, data.pointerToRelocations, true);
      this.view.setUint32(28 + index * 40, data.pointerToLineNumbers, true);
      this.view.setUint16(32 + index * 40, data.numberOfRelocations, true);
      this.view.setUint16(34 + index * 40, data.numberOfLineNumbers, true);
      this.view.setUint32(36 + index * 40, data.characteristics, true);
    };
    ImageSectionHeaderArray2.itemSize = 40;
    return ImageSectionHeaderArray2;
  })(ArrayFormatBase_default)
);
var ImageSectionHeaderArray_default = ImageSectionHeaderArray;

// node_modules/pe-library/dist/util/generate.js
var DOS_STUB_PROGRAM = new Uint8Array([
  14,
  31,
  186,
  14,
  0,
  180,
  9,
  205,
  33,
  184,
  1,
  76,
  205,
  33,
  68,
  79,
  83,
  32,
  109,
  111,
  100,
  101,
  32,
  110,
  111,
  116,
  32,
  115,
  117,
  112,
  112,
  111,
  114,
  116,
  101,
  100,
  46,
  13,
  13,
  10,
  36,
  0,
  0,
  0,
  0,
  0,
  0,
  0
]);
var DOS_STUB_SIZE = roundUp(ImageDosHeader_default.size + DOS_STUB_PROGRAM.length, 128);
var DEFAULT_FILE_ALIGNMENT = 512;
function fillDosStubData(bin) {
  var dos = ImageDosHeader_default.from(bin);
  dos.magic = ImageDosHeader_default.DEFAULT_MAGIC;
  dos.lastPageSize = DOS_STUB_SIZE % 512;
  dos.pages = Math.ceil(DOS_STUB_SIZE / 512);
  dos.relocations = 0;
  dos.headerSizeInParagraph = Math.ceil(ImageDosHeader_default.size / 16);
  dos.minAllocParagraphs = 0;
  dos.maxAllocParagraphs = 65535;
  dos.initialSS = 0;
  dos.initialSP = 128;
  dos.relocationTableAddress = ImageDosHeader_default.size;
  dos.newHeaderAddress = DOS_STUB_SIZE;
  copyBuffer(bin, ImageDosHeader_default.size, DOS_STUB_PROGRAM, 0, DOS_STUB_PROGRAM.length);
}
function estimateNewHeaderSize(is32Bit) {
  return (
    // magic
    4 + ImageFileHeader_default.size + (is32Bit ? ImageOptionalHeader_default.size : ImageOptionalHeader64_default.size) + ImageDataDirectoryArray_default.size
  );
}
function fillPeHeaderEmptyData(bin, offset, totalBinSize, is32Bit, isDLL) {
  var _bin;
  var _offset;
  if ("buffer" in bin) {
    _bin = bin.buffer;
    _offset = bin.byteOffset + offset;
  } else {
    _bin = bin;
    _offset = offset;
  }
  new DataView(_bin, _offset).setUint32(0, ImageNtHeaders_default.DEFAULT_SIGNATURE, true);
  var fh = ImageFileHeader_default.from(_bin, _offset + 4);
  fh.machine = is32Bit ? 332 : 34404;
  fh.numberOfSections = 0;
  fh.timeDateStamp = 0;
  fh.pointerToSymbolTable = 0;
  fh.numberOfSymbols = 0;
  fh.sizeOfOptionalHeader = (is32Bit ? ImageOptionalHeader_default.size : ImageOptionalHeader64_default.size) + ImageDataDirectoryArray_default.size;
  fh.characteristics = isDLL ? 8450 : 258;
  var oh = (is32Bit ? ImageOptionalHeader_default : ImageOptionalHeader64_default).from(_bin, _offset + 4 + ImageFileHeader_default.size);
  oh.magic = is32Bit ? ImageOptionalHeader_default.DEFAULT_MAGIC : ImageOptionalHeader64_default.DEFAULT_MAGIC;
  oh.sizeOfCode = 0;
  oh.sizeOfInitializedData = 0;
  oh.sizeOfUninitializedData = 0;
  oh.addressOfEntryPoint = 0;
  oh.baseOfCode = 4096;
  oh.imageBase = is32Bit ? 16777216 : 6442450944;
  oh.sectionAlignment = 4096;
  oh.fileAlignment = DEFAULT_FILE_ALIGNMENT;
  oh.majorOperatingSystemVersion = 6;
  oh.minorOperatingSystemVersion = 0;
  oh.majorSubsystemVersion = 6;
  oh.minorSubsystemVersion = 0;
  oh.sizeOfHeaders = roundUp(totalBinSize, oh.fileAlignment);
  oh.subsystem = 2;
  oh.dllCharacteristics = (is32Bit ? 0 : 32) + // IMAGE_DLL_CHARACTERISTICS_HIGH_ENTROPY_VA
  64 + // IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE
  256;
  oh.sizeOfStackReserve = 1048576;
  oh.sizeOfStackCommit = 4096;
  oh.sizeOfHeapReserve = 1048576;
  oh.sizeOfHeapCommit = 4096;
  oh.numberOfRvaAndSizes = ImageDataDirectoryArray_default.size / ImageDataDirectoryArray_default.itemSize;
}
function makeEmptyNtExecutableBinary(is32Bit, isDLL) {
  var bufferSize = roundUp(DOS_STUB_SIZE + estimateNewHeaderSize(is32Bit), DEFAULT_FILE_ALIGNMENT);
  var bin = new ArrayBuffer(bufferSize);
  fillDosStubData(bin);
  fillPeHeaderEmptyData(bin, DOS_STUB_SIZE, bufferSize, is32Bit, isDLL);
  return bin;
}

// node_modules/pe-library/dist/NtExecutable.js
var NtExecutable = (
  /** @class */
  (function() {
    function NtExecutable2(_headers, _sections, _ex) {
      this._headers = _headers;
      this._sections = _sections;
      this._ex = _ex;
      var dh = ImageDosHeader_default.from(_headers);
      var nh = ImageNtHeaders_default.from(_headers, dh.newHeaderAddress);
      this._dh = dh;
      this._nh = nh;
      this._dda = nh.optionalHeaderDataDirectory;
      _sections.sort(function(a, b) {
        var ra = a.info.pointerToRawData;
        var rb = a.info.pointerToRawData;
        if (ra !== rb) {
          return ra - rb;
        }
        var va = a.info.virtualAddress;
        var vb = b.info.virtualAddress;
        if (va === vb) {
          return a.info.virtualSize - b.info.virtualSize;
        }
        return va - vb;
      });
    }
    NtExecutable2.createEmpty = function(is32Bit, isDLL) {
      if (is32Bit === void 0) {
        is32Bit = false;
      }
      if (isDLL === void 0) {
        isDLL = true;
      }
      return this.from(makeEmptyNtExecutableBinary(is32Bit, isDLL));
    };
    NtExecutable2.from = function(bin, options) {
      var dh = ImageDosHeader_default.from(bin);
      var nh = ImageNtHeaders_default.from(bin, dh.newHeaderAddress);
      if (!dh.isValid() || !nh.isValid()) {
        throw new TypeError("Invalid binary format");
      }
      if (nh.fileHeader.numberOfSymbols > 0) {
        throw new Error("Binary with symbols is not supported now");
      }
      var fileAlignment = nh.optionalHeader.fileAlignment;
      var securityEntry = nh.optionalHeaderDataDirectory.get(ImageDirectoryEntry_default.Certificate);
      if (securityEntry.size > 0) {
        if (!(options === null || options === void 0 ? void 0 : options.ignoreCert)) {
          throw new Error("Parsing signed executable binary is not allowed by default.");
        }
      }
      var secOff = dh.newHeaderAddress + nh.getSectionHeaderOffset();
      var secCount = nh.fileHeader.numberOfSections;
      var sections = [];
      var tempSectionHeaderBinary = allocatePartialBinary(bin, secOff, secCount * ImageSectionHeaderArray_default.itemSize);
      var secArray = ImageSectionHeaderArray_default.from(tempSectionHeaderBinary, secCount, 0);
      var lastOffset = roundUp(secOff + secCount * ImageSectionHeaderArray_default.itemSize, fileAlignment);
      secArray.forEach(function(info) {
        if (!info.pointerToRawData || !info.sizeOfRawData) {
          info.pointerToRawData = 0;
          info.sizeOfRawData = 0;
          sections.push({
            info,
            data: null
          });
        } else {
          var secBin = allocatePartialBinary(bin, info.pointerToRawData, info.sizeOfRawData);
          sections.push({
            info,
            data: secBin
          });
          var secEndOffset = roundUp(info.pointerToRawData + info.sizeOfRawData, fileAlignment);
          if (secEndOffset > lastOffset) {
            lastOffset = secEndOffset;
          }
        }
      });
      var headers = allocatePartialBinary(bin, 0, secOff);
      var exData = null;
      var lastExDataOffset = bin.byteLength;
      if (securityEntry.size > 0) {
        lastExDataOffset = securityEntry.virtualAddress;
      }
      if (lastOffset < lastExDataOffset) {
        exData = allocatePartialBinary(bin, lastOffset, lastExDataOffset - lastOffset);
      }
      return new NtExecutable2(headers, sections, exData);
    };
    NtExecutable2.prototype.is32bit = function() {
      return this._nh.is32bit();
    };
    NtExecutable2.prototype.getTotalHeaderSize = function() {
      return this._headers.byteLength;
    };
    Object.defineProperty(NtExecutable2.prototype, "dosHeader", {
      get: function() {
        return this._dh;
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(NtExecutable2.prototype, "newHeader", {
      get: function() {
        return this._nh;
      },
      enumerable: false,
      configurable: true
    });
    NtExecutable2.prototype.getRawHeader = function() {
      return this._headers;
    };
    NtExecutable2.prototype.getImageBase = function() {
      return this._nh.optionalHeader.imageBase;
    };
    NtExecutable2.prototype.getFileAlignment = function() {
      return this._nh.optionalHeader.fileAlignment;
    };
    NtExecutable2.prototype.getSectionAlignment = function() {
      return this._nh.optionalHeader.sectionAlignment;
    };
    NtExecutable2.prototype.getAllSections = function() {
      return this._sections;
    };
    NtExecutable2.prototype.getSectionByEntry = function(entry2) {
      var dd = this._dda.get(entry2);
      var r = this._sections.filter(function(sec) {
        var vaEnd = sec.info.virtualAddress + sec.info.virtualSize;
        return dd.virtualAddress >= sec.info.virtualAddress && dd.virtualAddress < vaEnd;
      }).shift();
      return r !== void 0 ? r : null;
    };
    NtExecutable2.prototype.setSectionByEntry = function(entry2, section) {
      var sec = section ? { data: section.data, info: section.info } : null;
      var dd = this._dda.get(entry2);
      var hasEntry = dd.size > 0;
      if (!sec) {
        if (!hasEntry) {
        } else {
          this._dda.set(entry2, { size: 0, virtualAddress: 0 });
          var len = this._sections.length;
          for (var i = 0; i < len; ++i) {
            var sec_1 = this._sections[i];
            var vaStart = sec_1.info.virtualAddress;
            var vaLast = vaStart + sec_1.info.virtualSize;
            if (dd.virtualAddress >= vaStart && dd.virtualAddress < vaLast) {
              this._sections.splice(i, 1);
              this._nh.fileHeader.numberOfSections = this._sections.length;
              break;
            }
          }
        }
      } else {
        var rawSize = !sec.data ? 0 : sec.data.byteLength;
        var fileAlign = this._nh.optionalHeader.fileAlignment;
        var secAlign = this._nh.optionalHeader.sectionAlignment;
        var alignedFileSize = !sec.data ? 0 : roundUp(rawSize, fileAlign);
        var alignedSecSize = !sec.data ? 0 : roundUp(sec.info.virtualSize, secAlign);
        if (sec.info.sizeOfRawData < alignedFileSize) {
          sec.info.sizeOfRawData = alignedFileSize;
        } else {
          alignedFileSize = sec.info.sizeOfRawData;
        }
        if (!hasEntry) {
          var virtAddr_1 = 0;
          var rawAddr_1 = roundUp(this._headers.byteLength, fileAlign);
          this._sections.forEach(function(secExist) {
            if (secExist.info.pointerToRawData) {
              if (rawAddr_1 <= secExist.info.pointerToRawData) {
                rawAddr_1 = secExist.info.pointerToRawData + secExist.info.sizeOfRawData;
              }
            }
            if (virtAddr_1 <= secExist.info.virtualAddress) {
              virtAddr_1 = secExist.info.virtualAddress + secExist.info.virtualSize;
            }
          });
          if (!alignedFileSize) {
            rawAddr_1 = 0;
          }
          if (!virtAddr_1) {
            virtAddr_1 = this.newHeader.optionalHeader.baseOfCode;
          }
          virtAddr_1 = roundUp(virtAddr_1, secAlign);
          sec.info.pointerToRawData = rawAddr_1;
          sec.info.virtualAddress = virtAddr_1;
          this._dda.set(entry2, {
            size: rawSize,
            virtualAddress: virtAddr_1
          });
          this._sections.push(sec);
          this._nh.fileHeader.numberOfSections = this._sections.length;
          this._nh.optionalHeader.sizeOfImage = roundUp(virtAddr_1 + alignedSecSize, this._nh.optionalHeader.sectionAlignment);
        } else {
          this.replaceSectionImpl(dd.virtualAddress, sec.info, sec.data);
        }
      }
    };
    NtExecutable2.prototype.getExtraData = function() {
      return this._ex;
    };
    NtExecutable2.prototype.setExtraData = function(bin) {
      if (bin === null) {
        this._ex = null;
      } else {
        this._ex = cloneToArrayBuffer(bin);
      }
    };
    NtExecutable2.prototype.generate = function(paddingSize) {
      var dh = this._dh;
      var nh = this._nh;
      var secOff = dh.newHeaderAddress + nh.getSectionHeaderOffset();
      var size = secOff;
      size += this._sections.length * ImageSectionHeaderArray_default.itemSize;
      var align = nh.optionalHeader.fileAlignment;
      size = roundUp(size, align);
      this._sections.forEach(function(sec) {
        if (!sec.info.pointerToRawData) {
          return;
        }
        var lastOff = sec.info.pointerToRawData + sec.info.sizeOfRawData;
        if (size < lastOff) {
          size = lastOff;
          size = roundUp(size, align);
        }
      });
      var lastPosition = size;
      if (this._ex !== null) {
        size += this._ex.byteLength;
      }
      if (typeof paddingSize === "number") {
        size += paddingSize;
      }
      var bin = new ArrayBuffer(size);
      var u8bin = new Uint8Array(bin);
      u8bin.set(new Uint8Array(this._headers, 0, secOff));
      ImageDataDirectoryArray_default.from(bin, dh.newHeaderAddress + nh.getDataDirectoryOffset()).set(ImageDirectoryEntry_default.Certificate, {
        size: 0,
        virtualAddress: 0
      });
      var secArray = ImageSectionHeaderArray_default.from(bin, this._sections.length, secOff);
      this._sections.forEach(function(sec, i) {
        if (!sec.data) {
          sec.info.pointerToRawData = 0;
          sec.info.sizeOfRawData = 0;
        }
        secArray.set(i, sec.info);
        if (!sec.data || !sec.info.pointerToRawData) {
          return;
        }
        u8bin.set(new Uint8Array(sec.data), sec.info.pointerToRawData);
      });
      if (this._ex !== null) {
        u8bin.set(new Uint8Array(this._ex), lastPosition);
      }
      if (nh.optionalHeader.checkSum !== 0) {
        calculateCheckSumForPE(bin, true);
      }
      return bin;
    };
    NtExecutable2.prototype.rearrangeSections = function(rawAddressStart, rawDiff, virtualAddressStart, virtualDiff) {
      if (!rawDiff && !virtualDiff) {
        return;
      }
      var nh = this._nh;
      var secAlign = nh.optionalHeader.sectionAlignment;
      var dirs = this._dda;
      var len = this._sections.length;
      var lastVirtAddress = 0;
      for (var i = 0; i < len; ++i) {
        var sec = this._sections[i];
        var virtAddr = sec.info.virtualAddress;
        if (virtualDiff && virtAddr >= virtualAddressStart) {
          var iDir = dirs.findIndexByVirtualAddress(virtAddr);
          virtAddr += virtualDiff;
          if (iDir !== null) {
            dirs.set(iDir, {
              virtualAddress: virtAddr,
              size: sec.info.virtualSize
            });
          }
          sec.info.virtualAddress = virtAddr;
        }
        var fileAddr = sec.info.pointerToRawData;
        if (rawDiff && fileAddr >= rawAddressStart) {
          sec.info.pointerToRawData = fileAddr + rawDiff;
        }
        lastVirtAddress = roundUp(sec.info.virtualAddress + sec.info.virtualSize, secAlign);
      }
      nh.optionalHeader.sizeOfImage = lastVirtAddress;
    };
    NtExecutable2.prototype.replaceSectionImpl = function(virtualAddress, info, data) {
      var len = this._sections.length;
      for (var i = 0; i < len; ++i) {
        var s = this._sections[i];
        if (s.info.virtualAddress === virtualAddress) {
          var secAlign = this._nh.optionalHeader.sectionAlignment;
          var fileAddr = s.info.pointerToRawData;
          var oldFileAddr = fileAddr + s.info.sizeOfRawData;
          var oldVirtAddr = virtualAddress + roundUp(s.info.virtualSize, secAlign);
          s.info = cloneObject(info);
          s.info.virtualAddress = virtualAddress;
          s.info.pointerToRawData = fileAddr;
          s.data = data;
          var newFileAddr = fileAddr + info.sizeOfRawData;
          var newVirtAddr = virtualAddress + roundUp(info.virtualSize, secAlign);
          this.rearrangeSections(oldFileAddr, newFileAddr - oldFileAddr, oldVirtAddr, newVirtAddr - oldVirtAddr);
          {
            var dirs = this._dda;
            var iDir = dirs.findIndexByVirtualAddress(virtualAddress);
            if (iDir !== null) {
              dirs.set(iDir, {
                virtualAddress,
                size: info.virtualSize
              });
            }
          }
          break;
        }
      }
    };
    return NtExecutable2;
  })()
);
var NtExecutable_default = NtExecutable;

// node_modules/pe-library/dist/NtExecutableResource.js
function removeDuplicates(a) {
  return a.reduce(function(p, c) {
    return p.indexOf(c) >= 0 ? p : p.concat(c);
  }, []);
}
function readString(view, offset) {
  var length = view.getUint16(offset, true);
  var r = "";
  offset += 2;
  for (var i = 0; i < length; ++i) {
    r += String.fromCharCode(view.getUint16(offset, true));
    offset += 2;
  }
  return r;
}
function readLanguageTable(view, typeEntry, name, languageTable, cb) {
  var off = languageTable;
  var nameEntry = {
    name,
    languageTable,
    characteristics: view.getUint32(off, true),
    dateTime: view.getUint32(off + 4, true),
    majorVersion: view.getUint16(off + 8, true),
    minorVersion: view.getUint16(off + 10, true)
  };
  var nameCount = view.getUint16(off + 12, true);
  var idCount = view.getUint16(off + 14, true);
  off += 16;
  for (var i = 0; i < nameCount; ++i) {
    var nameOffset = view.getUint32(off, true) & 2147483647;
    var dataOffset = view.getUint32(off + 4, true);
    if ((dataOffset & 2147483648) !== 0) {
      off += 8;
      continue;
    }
    var name_1 = readString(view, nameOffset);
    cb(typeEntry, nameEntry, { lang: name_1, dataOffset });
    off += 8;
  }
  for (var i = 0; i < idCount; ++i) {
    var id = view.getUint32(off, true) & 2147483647;
    var dataOffset = view.getUint32(off + 4, true);
    if ((dataOffset & 2147483648) !== 0) {
      off += 8;
      continue;
    }
    cb(typeEntry, nameEntry, { lang: id, dataOffset });
    off += 8;
  }
}
function readNameTable(view, type, nameTable, cb) {
  var off = nameTable;
  var typeEntry = {
    type,
    nameTable,
    characteristics: view.getUint32(off, true),
    dateTime: view.getUint32(off + 4, true),
    majorVersion: view.getUint16(off + 8, true),
    minorVersion: view.getUint16(off + 10, true)
  };
  var nameCount = view.getUint16(off + 12, true);
  var idCount = view.getUint16(off + 14, true);
  off += 16;
  for (var i = 0; i < nameCount; ++i) {
    var nameOffset = view.getUint32(off, true) & 2147483647;
    var nextTable = view.getUint32(off + 4, true);
    if (!(nextTable & 2147483648)) {
      off += 8;
      continue;
    }
    nextTable &= 2147483647;
    var name_2 = readString(view, nameOffset);
    readLanguageTable(view, typeEntry, name_2, nextTable, cb);
    off += 8;
  }
  for (var i = 0; i < idCount; ++i) {
    var id = view.getUint32(off, true) & 2147483647;
    var nextTable = view.getUint32(off + 4, true);
    if (!(nextTable & 2147483648)) {
      off += 8;
      continue;
    }
    nextTable &= 2147483647;
    readLanguageTable(view, typeEntry, id, nextTable, cb);
    off += 8;
  }
}
function divideEntriesImplByID(r, names, entries) {
  var entriesByString = {};
  var entriesByNumber = {};
  entries.forEach(function(e) {
    if (typeof e.lang === "string") {
      entriesByString[e.lang] = e;
      names.push(e.lang);
    } else {
      entriesByNumber[e.lang] = e;
    }
  });
  var strKeys = Object.keys(entriesByString);
  strKeys.sort().forEach(function(type) {
    r.s.push(entriesByString[type]);
  });
  var numKeys = Object.keys(entriesByNumber);
  numKeys.map(function(k) {
    return Number(k);
  }).sort(function(a, b) {
    return a - b;
  }).forEach(function(type) {
    r.n.push(entriesByNumber[type]);
  });
  return 16 + 8 * (strKeys.length + numKeys.length);
}
function divideEntriesImplByName(r, names, entries) {
  var entriesByString = {};
  var entriesByNumber = {};
  entries.forEach(function(e) {
    var _a, _b;
    if (typeof e.id === "string") {
      var a = (_a = entriesByString[e.id]) !== null && _a !== void 0 ? _a : entriesByString[e.id] = [];
      names.push(e.id);
      a.push(e);
    } else {
      var a = (_b = entriesByNumber[e.id]) !== null && _b !== void 0 ? _b : entriesByNumber[e.id] = [];
      a.push(e);
    }
  });
  var sSum = Object.keys(entriesByString).sort().map(function(id) {
    var o = {
      id,
      s: [],
      n: []
    };
    r.s.push(o);
    return divideEntriesImplByID(o, names, entriesByString[id]);
  }).reduce(function(p, c) {
    return p + 8 + c;
  }, 0);
  var nSum = Object.keys(entriesByNumber).map(function(k) {
    return Number(k);
  }).sort(function(a, b) {
    return a - b;
  }).map(function(id) {
    var o = {
      id,
      s: [],
      n: []
    };
    r.n.push(o);
    return divideEntriesImplByID(o, names, entriesByNumber[id]);
  }).reduce(function(p, c) {
    return p + 8 + c;
  }, 0);
  return 16 + sSum + nSum;
}
function divideEntriesImplByType(r, names, entries) {
  var entriesByString = {};
  var entriesByNumber = {};
  entries.forEach(function(e) {
    var _a, _b;
    if (typeof e.type === "string") {
      var a = (_a = entriesByString[e.type]) !== null && _a !== void 0 ? _a : entriesByString[e.type] = [];
      names.push(e.type);
      a.push(e);
    } else {
      var a = (_b = entriesByNumber[e.type]) !== null && _b !== void 0 ? _b : entriesByNumber[e.type] = [];
      a.push(e);
    }
  });
  var sSum = Object.keys(entriesByString).sort().map(function(type) {
    var o = { type, s: [], n: [] };
    r.s.push(o);
    return divideEntriesImplByName(o, names, entriesByString[type]);
  }).reduce(function(p, c) {
    return p + 8 + c;
  }, 0);
  var nSum = Object.keys(entriesByNumber).map(function(k) {
    return Number(k);
  }).sort(function(a, b) {
    return a - b;
  }).map(function(type) {
    var o = { type, s: [], n: [] };
    r.n.push(o);
    return divideEntriesImplByName(o, names, entriesByNumber[type]);
  }).reduce(function(p, c) {
    return p + 8 + c;
  }, 0);
  return 16 + sSum + nSum;
}
function calculateStringLengthForWrite(text) {
  var length = text.length;
  return length > 65535 ? 65535 : length;
}
function getStringOffset(target, strings) {
  var l = strings.length;
  for (var i = 0; i < l; ++i) {
    var s = strings[i];
    if (s.text === target) {
      return s.offset;
    }
  }
  throw new Error("Unexpected");
}
function writeString(view, offset, text) {
  var length = calculateStringLengthForWrite(text);
  view.setUint16(offset, length, true);
  offset += 2;
  for (var i = 0; i < length; ++i) {
    view.setUint16(offset, text.charCodeAt(i), true);
    offset += 2;
  }
  return offset;
}
function writeLanguageTable(view, offset, strings, data) {
  view.setUint32(offset, 0, true);
  view.setUint32(offset + 4, 0, true);
  view.setUint32(offset + 8, 0, true);
  view.setUint16(offset + 12, data.s.length, true);
  view.setUint16(offset + 14, data.n.length, true);
  offset += 16;
  data.s.forEach(function(e) {
    var strOff = getStringOffset(e.lang, strings);
    view.setUint32(offset, strOff, true);
    view.setUint32(offset + 4, e.offset, true);
    offset += 8;
  });
  data.n.forEach(function(e) {
    view.setUint32(offset, e.lang, true);
    view.setUint32(offset + 4, e.offset, true);
    offset += 8;
  });
  return offset;
}
function writeNameTable(view, offset, leafOffset, strings, data) {
  view.setUint32(offset, 0, true);
  view.setUint32(offset + 4, 0, true);
  view.setUint32(offset + 8, 0, true);
  view.setUint16(offset + 12, data.s.length, true);
  view.setUint16(offset + 14, data.n.length, true);
  offset += 16;
  data.s.forEach(function(e) {
    e.offset = leafOffset;
    leafOffset = writeLanguageTable(view, leafOffset, strings, e);
  });
  data.n.forEach(function(e) {
    e.offset = leafOffset;
    leafOffset = writeLanguageTable(view, leafOffset, strings, e);
  });
  data.s.forEach(function(e) {
    var strOff = getStringOffset(e.id, strings);
    view.setUint32(offset, strOff + 2147483648, true);
    view.setUint32(offset + 4, e.offset + 2147483648, true);
    offset += 8;
  });
  data.n.forEach(function(e) {
    view.setUint32(offset, e.id, true);
    view.setUint32(offset + 4, e.offset + 2147483648, true);
    offset += 8;
  });
  return leafOffset;
}
function writeTypeTable(view, offset, strings, data) {
  view.setUint32(offset, 0, true);
  view.setUint32(offset + 4, 0, true);
  view.setUint32(offset + 8, 0, true);
  view.setUint16(offset + 12, data.s.length, true);
  view.setUint16(offset + 14, data.n.length, true);
  offset += 16;
  var nextTableOffset = offset + 8 * (data.s.length + data.n.length);
  data.s.forEach(function(e) {
    e.offset = nextTableOffset;
    nextTableOffset += 16 + 8 * (e.s.length + e.n.length);
  });
  data.n.forEach(function(e) {
    e.offset = nextTableOffset;
    nextTableOffset += 16 + 8 * (e.s.length + e.n.length);
  });
  data.s.forEach(function(e) {
    var strOff = getStringOffset(e.type, strings);
    view.setUint32(offset, strOff + 2147483648, true);
    view.setUint32(offset + 4, e.offset + 2147483648, true);
    offset += 8;
    nextTableOffset = writeNameTable(view, e.offset, nextTableOffset, strings, e);
  });
  data.n.forEach(function(e) {
    view.setUint32(offset, e.type, true);
    view.setUint32(offset + 4, e.offset + 2147483648, true);
    offset += 8;
    nextTableOffset = writeNameTable(view, e.offset, nextTableOffset, strings, e);
  });
  return nextTableOffset;
}
var NtExecutableResource = (
  /** @class */
  (function() {
    function NtExecutableResource2() {
      this.dateTime = 0;
      this.majorVersion = 0;
      this.minorVersion = 0;
      this.entries = [];
      this.sectionDataHeader = null;
      this.originalSize = 0;
    }
    NtExecutableResource2.prototype.parse = function(section, ignoreUnparsableData) {
      if (!section.data) {
        return;
      }
      var view = new DataView(section.data);
      this.dateTime = view.getUint32(4, true);
      this.majorVersion = view.getUint16(8, true);
      this.minorVersion = view.getUint16(10, true);
      var nameCount = view.getUint16(12, true);
      var idCount = view.getUint16(14, true);
      var off = 16;
      var res = [];
      var cb = function(t, n, l) {
        var off2 = view.getUint32(l.dataOffset, true) - section.info.virtualAddress;
        var size = view.getUint32(l.dataOffset + 4, true);
        var cp3 = view.getUint32(l.dataOffset + 8, true);
        if (off2 >= 0) {
          var bin = new Uint8Array(size);
          bin.set(new Uint8Array(section.data, off2, size));
          res.push({
            type: t.type,
            id: n.name,
            lang: l.lang,
            codepage: cp3,
            bin: bin.buffer
          });
        } else {
          if (!ignoreUnparsableData) {
            throw new Error("Cannot parse resource directory entry; RVA seems to be invalid.");
          }
          res.push({
            type: t.type,
            id: n.name,
            lang: l.lang,
            codepage: cp3,
            bin: new ArrayBuffer(0),
            rva: l.dataOffset
          });
        }
      };
      for (var i = 0; i < nameCount; ++i) {
        var nameOffset = view.getUint32(off, true) & 2147483647;
        var nextTable = view.getUint32(off + 4, true);
        if (!(nextTable & 2147483648)) {
          off += 8;
          continue;
        }
        nextTable &= 2147483647;
        var name_3 = readString(view, nameOffset);
        readNameTable(view, name_3, nextTable, cb);
        off += 8;
      }
      for (var i = 0; i < idCount; ++i) {
        var typeId = view.getUint32(off, true) & 2147483647;
        var nextTable = view.getUint32(off + 4, true);
        if (!(nextTable & 2147483648)) {
          off += 8;
          continue;
        }
        nextTable &= 2147483647;
        readNameTable(view, typeId, nextTable, cb);
        off += 8;
      }
      this.entries = res;
      this.originalSize = section.data.byteLength;
    };
    NtExecutableResource2.from = function(exe, ignoreUnparsableData) {
      if (ignoreUnparsableData === void 0) {
        ignoreUnparsableData = false;
      }
      var secs = [].concat(exe.getAllSections()).sort(function(a, b) {
        return a.info.virtualAddress - b.info.virtualAddress;
      });
      var entry2 = exe.getSectionByEntry(ImageDirectoryEntry_default.Resource);
      if (entry2) {
        var reloc = exe.getSectionByEntry(ImageDirectoryEntry_default.BaseRelocation);
        for (var i = 0; i < secs.length; ++i) {
          var s = secs[i];
          if (s === entry2) {
            for (var j = i + 1; j < secs.length; ++j) {
              if (!reloc || secs[j] !== reloc) {
                throw new Error("After Resource section, sections except for relocation are not supported");
              }
            }
            break;
          }
        }
      }
      var r = new NtExecutableResource2();
      r.sectionDataHeader = entry2 ? cloneObject(entry2.info) : null;
      if (entry2) {
        r.parse(entry2, ignoreUnparsableData);
      }
      return r;
    };
    NtExecutableResource2.prototype.replaceResourceEntry = function(entry2) {
      for (var len = this.entries.length, i = 0; i < len; ++i) {
        var e = this.entries[i];
        if (e.type === entry2.type && e.id === entry2.id && e.lang === entry2.lang) {
          this.entries[i] = entry2;
          return;
        }
      }
      this.entries.push(entry2);
    };
    NtExecutableResource2.prototype.getResourceEntriesAsString = function(type, id) {
      return this.entries.filter(function(entry2) {
        return entry2.type === type && entry2.id === id;
      }).map(function(entry2) {
        return [entry2.lang, binaryToString(entry2.bin)];
      });
    };
    NtExecutableResource2.prototype.replaceResourceEntryFromString = function(type, id, lang, value) {
      var entry2 = {
        type,
        id,
        lang,
        codepage: 1200,
        bin: stringToBinary(value)
      };
      this.replaceResourceEntry(entry2);
    };
    NtExecutableResource2.prototype.removeResourceEntry = function(type, id, lang) {
      this.entries = this.entries.filter(function(entry2) {
        return !(entry2.type === type && entry2.id === id && (typeof lang === "undefined" || entry2.lang === lang));
      });
    };
    NtExecutableResource2.prototype.generateResourceData = function(virtualAddress, alignment, noGrow, allowShrink) {
      if (noGrow === void 0) {
        noGrow = false;
      }
      if (allowShrink === void 0) {
        allowShrink = false;
      }
      var r = {
        s: [],
        n: []
      };
      var strings = [];
      var size = divideEntriesImplByType(r, strings, this.entries);
      strings = removeDuplicates(strings);
      var stringsOffset = size;
      size += strings.reduce(function(prev, cur) {
        return prev + 2 + calculateStringLengthForWrite(cur) * 2;
      }, 0);
      size = roundUp(size, 8);
      var descOffset = size;
      size = this.entries.reduce(function(p, e) {
        e.offset = p;
        return p + 16;
      }, descOffset);
      var dataOffset = size;
      size = this.entries.reduce(function(p, e) {
        return roundUp(p, 8) + e.bin.byteLength;
      }, dataOffset);
      var alignedSize = roundUp(size, alignment);
      var originalAlignedSize = roundUp(this.originalSize, alignment);
      if (noGrow) {
        if (alignedSize > originalAlignedSize) {
          throw new Error("New resource data is larger than original");
        }
      }
      if (!allowShrink) {
        if (alignedSize < originalAlignedSize) {
          alignedSize = originalAlignedSize;
        }
      }
      var bin = new ArrayBuffer(alignedSize);
      var view = new DataView(bin);
      var o = descOffset;
      var va = virtualAddress + dataOffset;
      this.entries.forEach(function(e) {
        var len = e.bin.byteLength;
        if (typeof e.rva !== "undefined") {
          view.setUint32(o, e.rva, true);
        } else {
          va = roundUp(va, 8);
          view.setUint32(o, va, true);
          va += len;
        }
        view.setUint32(o + 4, len, true);
        view.setUint32(o + 8, e.codepage, true);
        view.setUint32(o + 12, 0, true);
        o += 16;
      });
      o = dataOffset;
      this.entries.forEach(function(e) {
        var len = e.bin.byteLength;
        copyBuffer(bin, o, e.bin, 0, len);
        o += roundUp(len, 8);
      });
      var stringsData = [];
      o = stringsOffset;
      strings.forEach(function(s) {
        stringsData.push({
          offset: o,
          text: s
        });
        o = writeString(view, o, s);
      });
      writeTypeTable(view, 0, stringsData, r);
      if (alignedSize > size) {
        var pad = "PADDINGX";
        for (var i = size, j = 0; i < alignedSize; ++i, ++j) {
          if (j === 8) {
            j = 0;
          }
          view.setUint8(i, pad.charCodeAt(j));
        }
      }
      return {
        bin,
        rawSize: size,
        dataOffset,
        descEntryOffset: descOffset,
        descEntryCount: this.entries.length
      };
    };
    NtExecutableResource2.prototype.outputResource = function(exeDest, noGrow, allowShrink) {
      if (noGrow === void 0) {
        noGrow = false;
      }
      if (allowShrink === void 0) {
        allowShrink = false;
      }
      var fileAlign = exeDest.getFileAlignment();
      var sectionData;
      if (this.sectionDataHeader) {
        sectionData = {
          data: null,
          info: cloneObject(this.sectionDataHeader)
        };
      } else {
        sectionData = {
          data: null,
          info: {
            name: ".rsrc",
            virtualSize: 0,
            virtualAddress: 0,
            sizeOfRawData: 0,
            pointerToRawData: 0,
            pointerToRelocations: 0,
            pointerToLineNumbers: 0,
            numberOfRelocations: 0,
            numberOfLineNumbers: 0,
            characteristics: 1073741888
            // read access and initialized data
          }
        };
      }
      var data = this.generateResourceData(0, fileAlign, noGrow, allowShrink);
      sectionData.data = data.bin;
      sectionData.info.sizeOfRawData = data.bin.byteLength;
      sectionData.info.virtualSize = data.rawSize;
      exeDest.setSectionByEntry(ImageDirectoryEntry_default.Resource, sectionData);
      var generatedSection = exeDest.getSectionByEntry(ImageDirectoryEntry_default.Resource);
      var view = new DataView(generatedSection.data);
      var o = data.descEntryOffset;
      var va = generatedSection.info.virtualAddress + data.dataOffset;
      for (var i = 0; i < data.descEntryCount; ++i) {
        var len = view.getUint32(o + 4, true);
        va = roundUp(va, 8);
        view.setUint32(o, va, true);
        va += len;
        o += 16;
      }
    };
    return NtExecutableResource2;
  })()
);
var NtExecutableResource_default = NtExecutableResource;

// node_modules/resedit/dist/util/functions.js
function cloneObject2(object) {
  var r = {};
  Object.keys(object).forEach(function(key) {
    r[key] = object[key];
  });
  return r;
}
function createDataView2(bin, byteOffset, byteLength) {
  if ("buffer" in bin) {
    var newOffset = bin.byteOffset;
    var newLength = bin.byteLength;
    if (typeof byteOffset !== "undefined") {
      newOffset += byteOffset;
      newLength -= byteOffset;
    }
    if (typeof byteLength !== "undefined") {
      newLength = byteLength;
    }
    return new DataView(bin.buffer, newOffset, newLength);
  } else {
    return new DataView(bin, byteOffset, byteLength);
  }
}
function roundUp2(val, align) {
  return Math.floor((val + align - 1) / align) * align;
}
function copyBuffer2(dest, destOffset, src, srcOffset, length) {
  var ua8Dest = "buffer" in dest ? new Uint8Array(dest.buffer, dest.byteOffset + (destOffset || 0), length) : new Uint8Array(dest, destOffset, length);
  var ua8Src = "buffer" in src ? new Uint8Array(src.buffer, src.byteOffset + (srcOffset || 0), length) : new Uint8Array(src, srcOffset, length);
  ua8Dest.set(ua8Src);
}
function allocatePartialBinary2(binBase, offset, length) {
  var b = new ArrayBuffer(length);
  copyBuffer2(b, 0, binBase, offset, length);
  return b;
}
function readInt32WithLastOffset(view, offset, last) {
  return offset + 4 <= last ? view.getInt32(offset, true) : 0;
}
function readUint8WithLastOffset(view, offset, last) {
  return offset < last ? view.getUint8(offset) : 0;
}
function readUint16WithLastOffset(view, offset, last) {
  return offset + 2 <= last ? view.getUint16(offset, true) : 0;
}
function readUint32WithLastOffset(view, offset, last) {
  return offset + 4 <= last ? view.getUint32(offset, true) : 0;
}

// node_modules/resedit/dist/data/IconItem.js
function calcMaskSize(width, height) {
  var actualWidthBytes = roundUp2(Math.abs(width), 32) / 8;
  return actualWidthBytes * Math.abs(height);
}
var IconItem = (
  /** @class */
  (function() {
    function IconItem2(width, height, bin, byteOffset, byteLength) {
      var view = createDataView2(bin, byteOffset, byteLength);
      var totalSize = view.byteLength;
      var headerSize = view.getUint32(0, true);
      if (headerSize > totalSize) {
        headerSize = totalSize;
      }
      var sizeImage = readUint32WithLastOffset(view, 20, headerSize);
      var bi = {
        width: readInt32WithLastOffset(view, 4, headerSize),
        height: readInt32WithLastOffset(view, 8, headerSize),
        planes: readUint16WithLastOffset(view, 12, headerSize),
        bitCount: readUint16WithLastOffset(view, 14, headerSize),
        compression: readUint32WithLastOffset(view, 16, headerSize),
        sizeImage,
        xPelsPerMeter: readInt32WithLastOffset(view, 24, headerSize),
        yPelsPerMeter: readInt32WithLastOffset(view, 28, headerSize),
        colorUsed: readUint32WithLastOffset(view, 32, headerSize),
        colorImportant: readUint32WithLastOffset(view, 36, headerSize),
        colors: []
      };
      var offset = 40;
      var colors = bi.colorUsed;
      if (!colors) {
        switch (bi.bitCount) {
          case 1:
            colors = 2;
            break;
          case 4:
            colors = 16;
            break;
          case 8:
            colors = 256;
            break;
        }
      }
      for (var i = 0; i < colors; ++i) {
        bi.colors.push({
          b: readUint8WithLastOffset(view, offset, totalSize),
          g: readUint8WithLastOffset(view, offset + 1, totalSize),
          r: readUint8WithLastOffset(view, offset + 2, totalSize)
        });
        offset += 4;
      }
      this.width = width;
      this.height = height;
      this.bitmapInfo = bi;
      var widthBytes = roundUp2(bi.bitCount * Math.abs(bi.width), 32) / 8;
      var absActualHeight = Math.abs(bi.height) / 2;
      var size = bi.compression !== 0 && sizeImage !== 0 ? sizeImage : widthBytes * absActualHeight;
      if (size + offset > totalSize) {
        throw new Error("Unexpected bitmap data in icon: bitmap size ".concat(size, " is larger than ").concat(totalSize, " - ").concat(offset));
      }
      this._pixels = allocatePartialBinary2(view, offset, size);
      offset += size;
      var maskSize = calcMaskSize(bi.width, absActualHeight);
      if (maskSize + offset <= totalSize) {
        this.masks = allocatePartialBinary2(view, offset, maskSize);
      } else {
        this.masks = new ArrayBuffer(maskSize);
      }
    }
    Object.defineProperty(IconItem2.prototype, "pixels", {
      /**
       * Bitmap pixel data.
       * @note
       * On set, if `bitmapInfo.sizeImage` is non-zero, `bitmapInfo.sizeImage` will be updated.
       */
      get: function() {
        return this._pixels;
      },
      /**
       * Bitmap pixel data.
       * @note
       * On set, if `bitmapInfo.sizeImage` is non-zero, `bitmapInfo.sizeImage` will be updated.
       */
      set: function(newValue) {
        this._pixels = newValue;
        if (this.bitmapInfo.sizeImage !== 0) {
          this.bitmapInfo.sizeImage = newValue.byteLength;
        }
      },
      enumerable: false,
      configurable: true
    });
    IconItem2.from = function(arg1, arg2, arg3, byteOffset, byteLength) {
      var width;
      var height;
      var bin;
      if (typeof arg3 === "object") {
        width = arg1;
        height = arg2;
        bin = arg3;
      } else {
        width = null;
        height = null;
        bin = arg1;
        byteOffset = arg2;
        byteLength = arg3;
      }
      return new IconItem2(width, height, bin, byteOffset, byteLength);
    };
    IconItem2.prototype.isIcon = function() {
      return true;
    };
    IconItem2.prototype.isRaw = function() {
      return false;
    };
    IconItem2.prototype.generate = function() {
      var bi = this.bitmapInfo;
      var absWidth = Math.abs(bi.width);
      var absWidthBytes = roundUp2(bi.bitCount * absWidth, 32) / 8;
      var absActualHeight = Math.abs(bi.height) / 2;
      var actualSizeImage = absWidthBytes * absActualHeight;
      var sizeMask = calcMaskSize(bi.width, absActualHeight);
      var colorCount = bi.colors.length;
      var totalSize = 40 + 4 * colorCount + actualSizeImage + sizeMask;
      var bin = new ArrayBuffer(totalSize);
      var view = new DataView(bin);
      view.setUint32(0, 40, true);
      view.setInt32(4, bi.width, true);
      view.setInt32(8, bi.height, true);
      view.setUint16(12, bi.planes, true);
      view.setUint16(14, bi.bitCount, true);
      view.setUint32(16, bi.compression, true);
      view.setUint32(20, bi.sizeImage, true);
      view.setInt32(24, bi.xPelsPerMeter, true);
      view.setInt32(28, bi.yPelsPerMeter, true);
      view.setUint32(32, bi.colorUsed, true);
      view.setUint32(36, bi.colorImportant > colorCount ? colorCount : bi.colorImportant, true);
      var offset = 40;
      bi.colors.forEach(function(c) {
        view.setUint8(offset, c.b);
        view.setUint8(offset + 1, c.g);
        view.setUint8(offset + 2, c.r);
        offset += 4;
      });
      copyBuffer2(bin, offset, this.pixels, 0, actualSizeImage);
      copyBuffer2(bin, offset + actualSizeImage, this.masks, 0, sizeMask);
      return bin;
    };
    return IconItem2;
  })()
);
var IconItem_default = IconItem;

// node_modules/resedit/dist/data/RawIconItem.js
var RawIconItem = (
  /** @class */
  (function() {
    function RawIconItem2(bin, width, height, bitCount, byteOffset, byteLength) {
      this.width = width;
      this.height = height;
      this.bitCount = bitCount;
      if (typeof byteOffset !== "number") {
        byteOffset = 0;
        byteLength = bin.byteLength;
      } else if (typeof byteLength !== "number") {
        byteLength = bin.byteLength - byteOffset;
      }
      this.bin = allocatePartialBinary2(bin, byteOffset, byteLength);
    }
    RawIconItem2.from = function(bin, width, height, bitCount, byteOffset, byteLength) {
      return new RawIconItem2(bin, width, height, bitCount, byteOffset, byteLength);
    };
    RawIconItem2.prototype.isIcon = function() {
      return false;
    };
    RawIconItem2.prototype.isRaw = function() {
      return true;
    };
    return RawIconItem2;
  })()
);
var RawIconItem_default = RawIconItem;

// node_modules/resedit/dist/data/IconFile.js
function generateEntryBinary(icons) {
  var count = icons.length;
  if (count > 65535) {
    count = 65535;
  }
  var tmpIcons = icons.map(function(item) {
    if (item.data.isIcon()) {
      return {
        item,
        bin: item.data.generate(),
        offset: 0
      };
    } else {
      return {
        item,
        bin: item.data.bin,
        offset: 0
      };
    }
  });
  var size = tmpIcons.reduce(function(p, icon) {
    icon.offset = p;
    return p + icon.bin.byteLength;
  }, 6 + 16 * count);
  var bin = new ArrayBuffer(size);
  var view = new DataView(bin);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, count, true);
  var offset = 6;
  tmpIcons.forEach(function(icon) {
    var item = icon.item;
    var width;
    var height;
    var colors;
    var planes;
    var bitCount;
    if (item.data.isIcon()) {
      var bi = item.data.bitmapInfo;
      width = typeof item.width !== "undefined" ? item.width : Math.abs(bi.width);
      height = typeof item.height !== "undefined" ? item.height : Math.abs(bi.height / 2);
      colors = typeof item.colors !== "undefined" ? item.colors : bi.colorUsed || bi.colors.length;
      planes = typeof item.planes !== "undefined" ? item.planes : bi.planes;
      bitCount = typeof item.bitCount !== "undefined" ? item.bitCount : bi.bitCount;
    } else {
      width = typeof item.width !== "undefined" ? item.width : Math.abs(item.data.width);
      height = typeof item.height !== "undefined" ? item.height : Math.abs(item.data.height);
      colors = typeof item.colors !== "undefined" ? item.colors : 0;
      planes = typeof item.planes !== "undefined" ? item.planes : 1;
      bitCount = typeof item.bitCount !== "undefined" ? item.bitCount : item.data.bitCount;
    }
    var dataSize = icon.bin.byteLength;
    view.setUint8(offset, width >= 256 ? 0 : width);
    view.setUint8(offset + 1, height >= 256 ? 0 : height);
    view.setUint8(offset + 2, colors >= 256 ? 0 : colors);
    view.setUint8(offset + 3, 0);
    view.setUint16(offset + 4, planes, true);
    view.setUint16(offset + 6, bitCount, true);
    view.setUint32(offset + 8, dataSize, true);
    view.setUint32(offset + 12, icon.offset, true);
    offset += 16;
    copyBuffer2(bin, icon.offset, icon.bin, 0, dataSize);
  });
  return bin;
}
var IconFile = (
  /** @class */
  (function() {
    function IconFile2(bin) {
      if (!bin) {
        this.icons = [];
        return;
      }
      var view = createDataView2(bin);
      var totalSize = view.byteLength;
      var icons = [];
      if (view.getUint16(2, true) === 1) {
        var count = view.getUint16(4, true);
        var offset = 6;
        for (var i = 0; i < count; ++i) {
          var dataSize = readUint32WithLastOffset(view, offset + 8, totalSize);
          var dataOffset = readUint32WithLastOffset(view, offset + 12, totalSize);
          var width = readUint8WithLastOffset(view, offset, totalSize);
          var height = readUint8WithLastOffset(view, offset + 1, totalSize);
          var bitCount = readUint8WithLastOffset(view, offset + 6, totalSize);
          var data = void 0;
          if (view.getUint32(dataOffset, true) === 40) {
            data = IconItem_default.from(width, height, bin, dataOffset, dataSize);
          } else {
            data = RawIconItem_default.from(bin, width || 256, height || 256, bitCount, dataOffset, dataSize);
          }
          icons.push({
            width,
            height,
            colors: readUint8WithLastOffset(view, offset + 2, totalSize),
            planes: readUint16WithLastOffset(view, offset + 4, totalSize),
            bitCount,
            data
          });
          offset += 16;
        }
      }
      this.icons = icons;
    }
    IconFile2.from = function(bin) {
      return new IconFile2(bin);
    };
    IconFile2.prototype.generate = function() {
      return generateEntryBinary(this.icons);
    };
    return IconFile2;
  })()
);

// node_modules/resedit/dist/mui/MuiResourceInfo.js
function isValidMuiResourceEntry(resourceEntry) {
  var view = new DataView(resourceEntry.bin);
  if (view.getUint32(0, true) !== 4274912973) {
    return false;
  }
  var len = view.getUint32(4, true);
  if (len !== resourceEntry.bin.byteLength) {
    return false;
  }
  var version = view.getUint32(8, true);
  if (version !== 65536) {
    return false;
  }
  var fileType = view.getUint32(16, true);
  if ((fileType & 15) !== 1 && (fileType & 15) !== 2) {
    return false;
  }
  return true;
}
function parseMuiResourceData(resourceEntry) {
  var view = new DataView(resourceEntry.bin);
  var len = view.getUint32(4, true);
  var fileTypeNum = readUint32WithLastOffset(view, 16, len) & 240;
  var fileType = fileTypeNum === 16 ? "system" : "application";
  var isLn = (fileTypeNum & 15) !== 2;
  var systemAttributes = readUint32WithLastOffset(view, 20, len);
  var ultimateFallbackLocationNum = readUint32WithLastOffset(view, 24, len);
  var ultimateFallbackLocation = ultimateFallbackLocationNum === 2 ? "external" : "internal";
  var checksumMain = new Uint8Array(allocatePartialBinary2(resourceEntry.bin, 28, 16));
  var checksumService = new Uint8Array(allocatePartialBinary2(resourceEntry.bin, 44, 16));
  var mainNameTypesOffset = readUint32WithLastOffset(view, 84, len);
  var mainNameTypesLength = readUint32WithLastOffset(view, 88, len);
  var mainIDTypesOffset = readUint32WithLastOffset(view, 92, len);
  var mainIDTypesLength = readUint32WithLastOffset(view, 96, len);
  var muiNameTypesOffset = readUint32WithLastOffset(view, 100, len);
  var muiNameTypesLength = readUint32WithLastOffset(view, 104, len);
  var muiIDTypesOffset = readUint32WithLastOffset(view, 108, len);
  var muiIDTypesLength = readUint32WithLastOffset(view, 112, len);
  var languageOffset = readUint32WithLastOffset(view, 116, len);
  var languageLength = readUint32WithLastOffset(view, 120, len);
  var ultimateFallbackLanguageOffset = readUint32WithLastOffset(view, 124, len);
  var ultimateFallbackLanguageLength = readUint32WithLastOffset(view, 128, len);
  var o;
  var e;
  var s = "";
  var mainTypes = [];
  for (o = mainNameTypesOffset, e = mainNameTypesOffset + mainNameTypesLength; o < e; o += 2) {
    var char = readUint16WithLastOffset(view, o, len);
    if (char === 0) {
      if (o > mainNameTypesOffset && s === "") {
        break;
      }
      mainTypes.push(s);
      s = "";
    } else {
      s += String.fromCharCode(char);
    }
  }
  if (s !== "") {
    mainTypes.push(s);
  }
  for (o = mainIDTypesOffset, e = mainIDTypesOffset + mainIDTypesLength; o < e; o += 4) {
    var t = readUint32WithLastOffset(view, o, len);
    if (t > 0) {
      mainTypes.push(t);
    }
  }
  var muiTypes = [];
  for (s = "", o = muiNameTypesOffset, e = muiNameTypesOffset + muiNameTypesLength; o < e; o += 2) {
    var char = readUint16WithLastOffset(view, o, len);
    if (char === 0) {
      if (o > muiNameTypesOffset && s === "") {
        break;
      }
      muiTypes.push(s);
      s = "";
    } else {
      s += String.fromCharCode(char);
    }
  }
  if (s !== "") {
    muiTypes.push(s);
  }
  for (o = muiIDTypesOffset, e = muiIDTypesOffset + muiIDTypesLength; o < e; o += 4) {
    var t = readUint32WithLastOffset(view, o, len);
    if (t > 0) {
      muiTypes.push(t);
    }
  }
  for (s = "", o = languageOffset, e = languageOffset + languageLength; o < e; o += 2) {
    var char = readUint16WithLastOffset(view, o, len);
    if (char === 0) {
      break;
    }
    s += String.fromCharCode(char);
  }
  var language = s;
  for (s = "", o = ultimateFallbackLanguageOffset, e = ultimateFallbackLanguageOffset + ultimateFallbackLanguageLength; o < e; o += 2) {
    var char = readUint16WithLastOffset(view, o, len);
    if (char === 0) {
      break;
    }
    s += String.fromCharCode(char);
  }
  var ultimateFallbackLanguage = s;
  return {
    resLang: resourceEntry.lang,
    isLn,
    fileType,
    systemAttributes,
    checksumMain,
    checksumService,
    language,
    ultimateFallbackLanguage,
    ultimateFallbackLocation,
    mainTypes,
    muiTypes
  };
}
function generateMuiResourceData(data) {
  var binaryLength = 136;
  var mainNameTypesOffset = 0;
  var mainNameTypesLength = 0;
  var mainIDTypesOffset = 0;
  var mainIDTypesLength = 0;
  var muiNameTypesOffset = 0;
  var muiNameTypesLength = 0;
  var muiIDTypesOffset = 0;
  var muiIDTypesLength = 0;
  var languageOffset = 0;
  var languageLength = 0;
  var ultimateFallbackLanguageOffset = 0;
  var ultimateFallbackLanguageLength = 0;
  data.mainTypes.forEach(function(type) {
    if (typeof type === "number") {
      mainIDTypesLength += 4;
    } else {
      mainNameTypesLength += (type.length + 1) * 2;
    }
  });
  if (mainNameTypesLength > 0) {
    mainNameTypesLength += 6;
  }
  data.muiTypes.forEach(function(type) {
    if (typeof type === "number") {
      muiIDTypesLength += 4;
    } else {
      muiNameTypesLength += (type.length + 1) * 2;
    }
  });
  if (muiNameTypesLength > 0) {
    muiNameTypesLength += 6;
  }
  if (data.isLn) {
    if (data.ultimateFallbackLocation === "external") {
      ultimateFallbackLanguageLength = (data.ultimateFallbackLanguage.length + 1) * 2;
    }
  } else {
    languageLength = (data.language.length + 1) * 2;
  }
  if (mainNameTypesLength > 0) {
    mainNameTypesOffset = binaryLength;
    binaryLength += roundUp2(mainNameTypesLength, 8);
  }
  if (mainIDTypesLength > 0) {
    mainIDTypesOffset = binaryLength;
    binaryLength += roundUp2(mainIDTypesLength, 8);
  }
  if (muiNameTypesLength > 0) {
    muiNameTypesOffset = binaryLength;
    binaryLength += roundUp2(muiNameTypesLength, 8);
  }
  if (muiIDTypesLength > 0) {
    muiIDTypesOffset = binaryLength;
    binaryLength += roundUp2(muiIDTypesLength, 8);
  }
  if (languageLength > 0) {
    languageOffset = binaryLength;
    binaryLength += roundUp2(languageLength, 8);
  }
  if (ultimateFallbackLanguageLength > 0) {
    ultimateFallbackLanguageOffset = binaryLength;
    binaryLength += roundUp2(ultimateFallbackLanguageLength, 8);
  }
  var bin = new ArrayBuffer(binaryLength);
  var view = new DataView(bin);
  view.setUint32(0, 4274912973, true);
  view.setUint32(4, binaryLength, true);
  view.setUint32(8, 65536, true);
  view.setUint32(16, ((data.fileType === "system" ? 1 : 2) << 4) + (data.isLn ? 1 : 2), true);
  view.setUint32(20, data.systemAttributes, true);
  view.setUint32(24, data.isLn ? data.ultimateFallbackLocation === "internal" ? 1 : 2 : 0, true);
  copyBuffer2(bin, 28, data.checksumMain, 0, data.checksumMain.length < 16 ? data.checksumMain.length : 16);
  copyBuffer2(bin, 44, data.checksumService, 0, data.checksumService.length < 16 ? data.checksumService.length : 16);
  view.setUint32(84, mainNameTypesOffset, true);
  view.setUint32(88, mainNameTypesLength, true);
  view.setUint32(92, mainIDTypesOffset, true);
  view.setUint32(96, mainIDTypesLength, true);
  view.setUint32(100, muiNameTypesOffset, true);
  view.setUint32(104, muiNameTypesLength, true);
  view.setUint32(108, muiIDTypesOffset, true);
  view.setUint32(112, muiIDTypesLength, true);
  view.setUint32(116, languageOffset, true);
  view.setUint32(120, languageLength, true);
  view.setUint32(124, ultimateFallbackLanguageOffset, true);
  view.setUint32(128, ultimateFallbackLanguageLength, true);
  var offset = 136;
  if (mainNameTypesLength > 0) {
    data.mainTypes.forEach(function(type) {
      if (typeof type !== "number") {
        for (var i2 = 0; i2 < type.length; ++i2) {
          view.setUint16(offset, type.charCodeAt(i2), true);
          offset += 2;
        }
        offset += 2;
      }
    });
    offset += 6;
    offset = roundUp2(offset, 8);
  }
  if (mainIDTypesLength > 0) {
    data.mainTypes.forEach(function(type) {
      if (typeof type === "number") {
        view.setUint32(offset, type, true);
        offset += 4;
      }
    });
    offset = roundUp2(offset, 8);
  }
  if (muiNameTypesLength > 0) {
    data.muiTypes.forEach(function(type) {
      if (typeof type !== "number") {
        for (var i2 = 0; i2 < type.length; ++i2) {
          view.setUint16(offset, type.charCodeAt(i2), true);
          offset += 2;
        }
        offset += 2;
      }
    });
    offset += 6;
    offset = roundUp2(offset, 8);
  }
  if (muiIDTypesLength > 0) {
    data.muiTypes.forEach(function(type) {
      if (typeof type === "number") {
        view.setUint32(offset, type, true);
        offset += 4;
      }
    });
    offset = roundUp2(offset, 8);
  }
  if (languageLength > 0) {
    for (var i = 0; i < data.language.length; ++i) {
      view.setUint16(offset, data.language.charCodeAt(i), true);
      offset += 2;
    }
    offset += 2;
    offset = roundUp2(offset, 8);
  }
  if (ultimateFallbackLanguageLength > 0) {
    for (var i = 0; i < data.ultimateFallbackLanguage.length; ++i) {
      view.setUint16(offset, data.ultimateFallbackLanguage.charCodeAt(i), true);
      offset += 2;
    }
    offset += 2;
    offset = roundUp2(offset, 8);
  }
  return {
    type: "MUI",
    id: 1,
    lang: data.resLang,
    codepage: 1200,
    bin
  };
}
var MuiResourceInfo = (
  /** @class */
  (function() {
    function MuiResourceInfo2(_data) {
      this.data = _data;
    }
    MuiResourceInfo2.from = function(executableResource) {
      var muiResourceData = null;
      try {
        executableResource.entries.forEach(function(entry2) {
          if (muiResourceData != null) {
            return;
          }
          if (entry2.type === "MUI" && isValidMuiResourceEntry(entry2)) {
            muiResourceData = parseMuiResourceData(entry2);
          }
        });
      } catch (_a) {
      }
      return new MuiResourceInfo2(muiResourceData);
    };
    MuiResourceInfo2.createEmpty = function() {
      return new MuiResourceInfo2(null);
    };
    MuiResourceInfo2.prototype.generateEntry = function() {
      return this.data == null ? null : generateMuiResourceData(this.data);
    };
    MuiResourceInfo2.prototype.replaceMuiEntryForExecutables = function(targetExecutableResource) {
      var generated = this.generateEntry();
      {
        var found = false;
        for (var i = targetExecutableResource.entries.length - 1; i >= 0; --i) {
          var entry2 = targetExecutableResource.entries[i];
          if (entry2.type === "MUI") {
            if (found || generated == null) {
              targetExecutableResource.entries.splice(i, 1);
            } else {
              targetExecutableResource.entries[i] = generated;
            }
            found = true;
          }
        }
        if (!found && generated != null) {
          targetExecutableResource.entries.unshift(generated);
        }
      }
    };
    return MuiResourceInfo2;
  })()
);

// node_modules/resedit/dist/resource/VersionInfo.js
function readStringToNullChar(view, offset, last) {
  var r = "";
  while (offset + 2 <= last) {
    var c = view.getUint16(offset, true);
    if (!c) {
      break;
    }
    r += String.fromCharCode(c);
    offset += 2;
  }
  return r;
}
function writeStringWithNullChar(view, offset, value) {
  for (var i = 0; i < value.length; ++i) {
    view.setUint16(offset, value.charCodeAt(i), true);
    offset += 2;
  }
  view.setUint16(offset, 0, true);
  return offset + 2;
}
function createFixedInfo() {
  return {
    fileVersionMS: 0,
    fileVersionLS: 0,
    productVersionMS: 0,
    productVersionLS: 0,
    fileFlagsMask: 0,
    fileFlags: 0,
    fileOS: 0,
    fileType: 0,
    fileSubtype: 0,
    fileDateMS: 0,
    fileDateLS: 0
  };
}
function parseStringTable(view, offset, last) {
  var tableLen = view.getUint16(offset, true);
  var valueLen = view.getUint16(offset + 2, true);
  if (offset + tableLen < last) {
    last = offset + tableLen;
  }
  var tableName = readStringToNullChar(view, offset + 6, last);
  offset += roundUp2(6 + 2 * (tableName.length + 1), 4);
  var langAndCp = parseInt(tableName, 16);
  if (isNaN(langAndCp)) {
    throw new Error("Invalid StringTable data format");
  }
  offset += roundUp2(valueLen, 4);
  var r = {
    lang: Math.floor(langAndCp / 65536),
    codepage: langAndCp & 65535,
    values: {}
  };
  while (offset < last) {
    var childDataLen = view.getUint16(offset, true);
    var childValueLen = view.getUint16(offset + 2, true);
    var valueType = view.getUint16(offset + 4, true);
    if (valueType !== 1) {
      if (valueType !== 0 || childValueLen !== 2) {
        offset += roundUp2(childDataLen, 4);
        continue;
      }
    }
    var childDataLast = offset + childDataLen;
    if (childDataLast > last) {
      childDataLast = last;
    }
    var name_1 = readStringToNullChar(view, offset + 6, childDataLast);
    offset = roundUp2(offset + 6 + 2 * (name_1.length + 1), 4);
    if (valueType === 0) {
      var valueData = view.getUint16(offset, true);
      if (valueData === 0) {
        r.values[name_1] = "";
      }
      offset = roundUp2(offset + 2, 4);
    } else {
      var childValueLast = offset + childValueLen * 2;
      if (childValueLast > childDataLast) {
        childValueLast = childDataLast;
      }
      var value = readStringToNullChar(view, offset, childValueLast);
      offset = roundUp2(childValueLast, 4);
      r.values[name_1] = value;
    }
  }
  return [last, r];
}
function parseStringFileInfo(view, offset, last) {
  var valueLen = view.getUint16(offset + 2, true);
  offset += 36;
  offset += roundUp2(valueLen, 4);
  var r = [];
  var _loop_1 = function() {
    var childData = parseStringTable(view, offset, last);
    var table = childData[1];
    var a = r.filter(function(e) {
      return e.lang === table.lang && e.codepage === table.codepage;
    });
    if (a.length === 0) {
      r.push(table);
    } else {
      for (var key in table.values) {
        var value = table.values[key];
        if (value != null) {
          a[0].values[key] = value;
        }
      }
    }
    offset = roundUp2(childData[0], 4);
  };
  while (offset < last) {
    _loop_1();
  }
  return r;
}
function parseVarFileInfo(view, offset, last) {
  var valueLen = view.getUint16(offset + 2, true);
  offset += 32;
  offset += roundUp2(valueLen, 4);
  var r = [];
  while (offset < last) {
    var childDataLen = view.getUint16(offset, true);
    var childValueLen = view.getUint16(offset + 2, true);
    if (view.getUint16(offset + 4, true) !== 0) {
      offset += roundUp2(childDataLen, 4);
      continue;
    }
    var childDataLast = offset + childDataLen;
    if (childDataLast > last) {
      childDataLast = last;
    }
    var name_2 = readStringToNullChar(view, offset + 6, childDataLast);
    offset = roundUp2(offset + 6 + 2 * (name_2.length + 1), 4);
    if (name_2 !== "Translation" || childValueLen % 4 !== 0) {
      offset = roundUp2(childDataLast, 4);
      continue;
    }
    var _loop_2 = function(child2) {
      if (offset + 4 > childDataLast) {
        return "break";
      }
      var lang = view.getUint16(offset, true);
      var codepage = view.getUint16(offset + 2, true);
      offset += 4;
      if (r.filter(function(e) {
        return e.lang === lang && e.codepage === codepage;
      }).length === 0) {
        r.push({ lang, codepage });
      }
    };
    for (var child = 0; child < childValueLen; child += 4) {
      var state_1 = _loop_2(child);
      if (state_1 === "break")
        break;
    }
    offset = roundUp2(childDataLast, 4);
  }
  return r;
}
function parseVersionEntry(view, entry2) {
  var totalLen = view.getUint16(0, true);
  var dataLen = view.getUint16(2, true);
  if (view.getUint16(4, true) !== 0) {
    throw new Error("Invalid version data format");
  }
  if (totalLen < dataLen + 40) {
    throw new Error("Invalid version data format");
  }
  if (readStringToNullChar(view, 6, totalLen) !== "VS_VERSION_INFO") {
    throw new Error("Invalid version data format");
  }
  var d = {
    lang: entry2.lang,
    fixedInfo: createFixedInfo(),
    strings: [],
    translations: [],
    unknowns: []
  };
  var offset = 38;
  if (dataLen) {
    dataLen += 40;
    var sig = readUint32WithLastOffset(view, 40, dataLen);
    var sVer = readUint32WithLastOffset(view, 44, dataLen);
    if (sig === 4277077181 && sVer <= 65536) {
      d.fixedInfo = {
        fileVersionMS: readUint32WithLastOffset(view, 48, dataLen),
        fileVersionLS: readUint32WithLastOffset(view, 52, dataLen),
        productVersionMS: readUint32WithLastOffset(view, 56, dataLen),
        productVersionLS: readUint32WithLastOffset(view, 60, dataLen),
        fileFlagsMask: readUint32WithLastOffset(view, 64, dataLen),
        fileFlags: readUint32WithLastOffset(view, 68, dataLen),
        fileOS: readUint32WithLastOffset(view, 72, dataLen),
        fileType: readUint32WithLastOffset(view, 76, dataLen),
        fileSubtype: readUint32WithLastOffset(view, 80, dataLen),
        fileDateMS: readUint32WithLastOffset(view, 84, dataLen),
        fileDateLS: readUint32WithLastOffset(view, 88, dataLen)
      };
    }
    offset = dataLen;
  }
  offset = roundUp2(offset, 4);
  while (offset < totalLen) {
    var childLen = view.getUint16(offset, true);
    var childLast = offset + childLen;
    if (childLast > totalLen) {
      childLast = totalLen;
    }
    var name_3 = readStringToNullChar(view, offset + 6, childLast);
    switch (name_3) {
      case "StringFileInfo":
        d.strings = d.strings.concat(parseStringFileInfo(view, offset, childLast));
        break;
      case "VarFileInfo":
        d.translations = d.translations.concat(parseVarFileInfo(view, offset, childLast));
        break;
      default:
        d.unknowns.push({
          name: name_3,
          entireBin: allocatePartialBinary2(view, offset, childLen)
        });
        break;
    }
    offset += roundUp2(childLen, 4);
  }
  return d;
}
function generateStringTable(table) {
  var size = 24;
  var keys = Object.keys(table.values);
  size = keys.reduce(function(prev, key) {
    var value = table.values[key];
    if (value == null) {
      return prev;
    }
    var childHeaderSize = roundUp2(6 + 2 * (key.length + 1), 4);
    var newSize = roundUp2(prev + childHeaderSize + 2 * (value.length + 1), 4);
    return newSize > 65532 ? prev : newSize;
  }, size);
  var bin = new ArrayBuffer(size);
  var view = new DataView(bin);
  view.setUint16(0, size, true);
  view.setUint16(2, 0, true);
  view.setUint16(4, 1, true);
  var langAndCp = ((table.lang & 65535) * 65536 + (table.codepage & 65535)).toString(16).toLowerCase();
  if (langAndCp.length < 8) {
    var l = 8 - langAndCp.length;
    langAndCp = "00000000".substr(0, l) + langAndCp;
  }
  var offset = roundUp2(writeStringWithNullChar(view, 6, langAndCp), 4);
  keys.forEach(function(key) {
    var value = table.values[key];
    if (value == null) {
      return;
    }
    var childHeaderSize = roundUp2(6 + 2 * (key.length + 1), 4);
    var newSize = childHeaderSize + 2 * (value.length + 1);
    if (offset + newSize <= 65532) {
      view.setUint16(offset, newSize, true);
      if (value.length === 0) {
        view.setUint16(offset + 2, 2, true);
        view.setUint16(offset + 4, 0, true);
      } else {
        view.setUint16(offset + 2, value.length + 1, true);
        view.setUint16(offset + 4, 1, true);
      }
      offset = roundUp2(writeStringWithNullChar(view, offset + 6, key), 4);
      offset = roundUp2(writeStringWithNullChar(view, offset, value), 4);
    }
  });
  return bin;
}
function generateStringTableInfo(tables) {
  var size = 36;
  var tableBins = tables.map(function(table) {
    return generateStringTable(table);
  });
  size += tableBins.reduce(function(p, c) {
    return p + c.byteLength;
  }, 0);
  var bin = new ArrayBuffer(size);
  var view = new DataView(bin);
  view.setUint16(0, size, true);
  view.setUint16(2, 0, true);
  view.setUint16(4, 1, true);
  var offset = roundUp2(writeStringWithNullChar(view, 6, "StringFileInfo"), 4);
  tableBins.forEach(function(table) {
    var len = table.byteLength;
    copyBuffer2(bin, offset, table, 0, len);
    offset += len;
  });
  return bin;
}
function generateVarFileInfo(translations) {
  var size = 32;
  var translationsValueSize = translations.length * 4;
  size += 32 + translationsValueSize;
  var bin = new ArrayBuffer(size);
  var view = new DataView(bin);
  view.setUint16(0, size, true);
  view.setUint16(2, 0, true);
  view.setUint16(4, 1, true);
  var offset = roundUp2(writeStringWithNullChar(view, 6, "VarFileInfo"), 4);
  view.setUint16(offset, 32 + translationsValueSize, true);
  view.setUint16(offset + 2, translationsValueSize, true);
  view.setUint16(offset + 4, 0, true);
  offset = roundUp2(writeStringWithNullChar(view, offset + 6, "Translation"), 4);
  translations.forEach(function(translation) {
    view.setUint16(offset, translation.lang, true);
    view.setUint16(offset + 2, translation.codepage, true);
    offset += 4;
  });
  return bin;
}
function generateVersionEntryBinary(entry2) {
  var size = 92;
  var stringTableInfoBin = generateStringTableInfo(entry2.strings);
  var stringTableInfoLen = stringTableInfoBin.byteLength;
  size += stringTableInfoLen;
  var varFileInfoBin = generateVarFileInfo(entry2.translations);
  var varFileInfoLen = varFileInfoBin.byteLength;
  size += varFileInfoLen;
  size = entry2.unknowns.reduce(function(p, data) {
    return p + roundUp2(data.entireBin.byteLength, 4);
  }, size);
  var bin = new ArrayBuffer(size);
  var view = new DataView(bin);
  view.setUint16(0, size, true);
  view.setUint16(2, 52, true);
  view.setUint16(4, 0, true);
  var offset = roundUp2(writeStringWithNullChar(view, 6, "VS_VERSION_INFO"), 4);
  view.setUint32(offset, 4277077181, true);
  view.setUint32(offset + 4, 65536, true);
  view.setUint32(offset + 8, entry2.fixedInfo.fileVersionMS, true);
  view.setUint32(offset + 12, entry2.fixedInfo.fileVersionLS, true);
  view.setUint32(offset + 16, entry2.fixedInfo.productVersionMS, true);
  view.setUint32(offset + 20, entry2.fixedInfo.productVersionLS, true);
  view.setUint32(offset + 24, entry2.fixedInfo.fileFlagsMask, true);
  view.setUint32(offset + 28, entry2.fixedInfo.fileFlags, true);
  view.setUint32(offset + 32, entry2.fixedInfo.fileOS, true);
  view.setUint32(offset + 36, entry2.fixedInfo.fileType, true);
  view.setUint32(offset + 40, entry2.fixedInfo.fileSubtype, true);
  view.setUint32(offset + 44, entry2.fixedInfo.fileDateMS, true);
  view.setUint32(offset + 48, entry2.fixedInfo.fileDateLS, true);
  offset += 52;
  copyBuffer2(bin, offset, stringTableInfoBin, 0, stringTableInfoLen);
  offset += stringTableInfoLen;
  copyBuffer2(bin, offset, varFileInfoBin, 0, varFileInfoLen);
  offset += varFileInfoLen;
  entry2.unknowns.forEach(function(e) {
    var len = e.entireBin.byteLength;
    copyBuffer2(bin, offset, e.entireBin, 0, len);
    offset += roundUp2(len, 4);
  });
  return bin;
}
function clampInt(val, min, max) {
  if (isNaN(val) || val < min) {
    return min;
  } else if (val >= max) {
    return max;
  }
  return Math.floor(val);
}
function parseVersionArguments(arg1, arg2, arg3, arg4, arg5) {
  var _a;
  var major;
  var minor;
  var micro;
  var revision;
  var lang;
  if (typeof arg1 === "string" && (typeof arg2 === "undefined" || typeof arg2 === "number") && typeof arg3 === "undefined") {
    _a = arg1.split(".").map(function(token) {
      return clampInt(Number(token), 0, 65535);
    }).concat(0, 0, 0), major = _a[0], minor = _a[1], micro = _a[2], revision = _a[3];
    lang = arg2;
  } else {
    major = clampInt(Number(arg1), 0, 65535);
    minor = clampInt(Number(arg2), 0, 65535);
    micro = clampInt(typeof arg3 === "undefined" ? 0 : Number(arg3), 0, 65535);
    revision = clampInt(typeof arg4 === "undefined" ? 0 : Number(arg4), 0, 65535);
    lang = arg5;
  }
  return [major, minor, micro, revision, lang];
}
var VersionInfo = (
  /** @class */
  (function() {
    function VersionInfo2(entry2) {
      if (!entry2) {
        this.data = {
          lang: 0,
          fixedInfo: createFixedInfo(),
          strings: [],
          translations: [],
          unknowns: []
        };
      } else {
        var view = new DataView(entry2.bin);
        this.data = parseVersionEntry(view, entry2);
      }
    }
    VersionInfo2.createEmpty = function() {
      return new VersionInfo2();
    };
    VersionInfo2.create = function(arg1, fixedInfo, strings) {
      var lang;
      if (typeof arg1 === "object") {
        lang = arg1.lang;
        fixedInfo = arg1.fixedInfo;
        strings = arg1.strings;
      } else {
        lang = arg1;
      }
      var vi = new VersionInfo2();
      vi.data.lang = lang;
      for (var _fixedInfoKey in fixedInfo) {
        var fixedInfoKey = _fixedInfoKey;
        if (fixedInfoKey in fixedInfo) {
          var value = fixedInfo[fixedInfoKey];
          if (value != null) {
            vi.data.fixedInfo[fixedInfoKey] = value;
          }
        }
      }
      vi.data.strings = strings.map(function(_a) {
        var lang2 = _a.lang, codepage = _a.codepage, values = _a.values;
        return {
          lang: lang2,
          codepage,
          values: cloneObject2(values)
        };
      });
      vi.data.translations = strings.map(function(_a) {
        var lang2 = _a.lang, codepage = _a.codepage;
        return { lang: lang2, codepage };
      });
      return vi;
    };
    VersionInfo2.fromEntries = function(entries) {
      return entries.filter(function(e) {
        return e.type === 16;
      }).map(function(e) {
        return new VersionInfo2(e);
      });
    };
    Object.defineProperty(VersionInfo2.prototype, "lang", {
      /** A language value for this resource entry. */
      get: function() {
        return this.data.lang;
      },
      set: function(value) {
        this.data.lang = value;
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(VersionInfo2.prototype, "fixedInfo", {
      /**
       * The property of fixed version info, containing file version, product version, etc.
       * (data: `VS_FIXEDFILEINFO`)
       *
       * Although this property is read-only, you can rewrite
       * each child fields directly to apply data.
       */
      get: function() {
        return this.data.fixedInfo;
      },
      enumerable: false,
      configurable: true
    });
    VersionInfo2.prototype.getAvailableLanguages = function() {
      return this.data.translations.slice(0);
    };
    VersionInfo2.prototype.replaceAvailableLanguages = function(languages) {
      this.data.translations = languages.slice(0);
    };
    VersionInfo2.prototype.getStringValues = function(language) {
      var a = this.data.strings.filter(function(e) {
        return e.lang === language.lang && e.codepage === language.codepage;
      }).map(function(e) {
        return e.values;
      });
      return a.length > 0 ? a[0] : {};
    };
    VersionInfo2.prototype.getAllLanguagesForStringValues = function() {
      return this.data.strings.map(function(_a) {
        var codepage = _a.codepage, lang = _a.lang;
        return { codepage, lang };
      });
    };
    VersionInfo2.prototype.setStringValues = function(language, values, addToAvailableLanguage) {
      if (addToAvailableLanguage === void 0) {
        addToAvailableLanguage = true;
      }
      var a = this.data.strings.filter(function(e) {
        return e.lang === language.lang && e.codepage === language.codepage;
      });
      var table;
      if (a.length === 0) {
        table = {
          lang: language.lang,
          codepage: language.codepage,
          values: {}
        };
        this.data.strings.push(table);
      } else {
        table = a[0];
      }
      for (var key in values) {
        var value = values[key];
        if (value != null) {
          table.values[key] = value;
        }
      }
      if (addToAvailableLanguage) {
        var t = this.data.translations.filter(function(e) {
          return e.lang === language.lang && e.codepage === language.codepage;
        });
        if (t.length === 0) {
          this.data.translations.push({
            lang: language.lang,
            codepage: language.codepage
          });
        }
      }
    };
    VersionInfo2.prototype.setStringValue = function(language, key, value, addToAvailableLanguage) {
      var _a;
      if (addToAvailableLanguage === void 0) {
        addToAvailableLanguage = true;
      }
      this.setStringValues(language, (_a = {}, _a[key] = value, _a), addToAvailableLanguage);
    };
    VersionInfo2.prototype.removeAllStringValues = function(language, removeFromAvailableLanguage) {
      if (removeFromAvailableLanguage === void 0) {
        removeFromAvailableLanguage = true;
      }
      var strings = this.data.strings;
      var len = strings.length;
      for (var i = 0; i < len; ++i) {
        var e = strings[i];
        if (e != null && e.lang === language.lang && e.codepage === language.codepage) {
          strings.splice(i, 1);
          if (removeFromAvailableLanguage) {
            var translations = this.data.translations;
            for (var j = 0; j < translations.length; j++) {
              var t = translations[j];
              if (t != null && t.lang === language.lang && t.codepage === language.codepage) {
                translations.splice(j, 1);
                break;
              }
            }
          }
          break;
        }
      }
    };
    VersionInfo2.prototype.removeStringValue = function(language, key, removeFromAvailableLanguage) {
      if (removeFromAvailableLanguage === void 0) {
        removeFromAvailableLanguage = true;
      }
      var strings = this.data.strings;
      var len = strings.length;
      for (var i = 0; i < len; ++i) {
        var e = strings[i];
        if (e != null && e.lang === language.lang && e.codepage === language.codepage) {
          try {
            delete e.values[key];
          } catch (_ex) {
          }
          if (removeFromAvailableLanguage && Object.keys(e.values).length === 0) {
            strings.splice(i, 1);
            var translations = this.data.translations;
            for (var j = 0; j < translations.length; j++) {
              var t = translations[j];
              if (t != null && t.lang === language.lang && t.codepage === language.codepage) {
                translations.splice(j, 1);
                break;
              }
            }
          }
          break;
        }
      }
    };
    VersionInfo2.prototype.generateResource = function() {
      var bin = generateVersionEntryBinary(this.data);
      return {
        type: 16,
        id: 1,
        lang: this.lang,
        codepage: 1200,
        bin
      };
    };
    VersionInfo2.prototype.outputToResourceEntries = function(entries) {
      var res = this.generateResource();
      var len = entries.length;
      for (var i = 0; i < len; ++i) {
        var e = entries[i];
        if (e != null && e.type === 16 && e.id === res.id && e.lang === res.lang) {
          entries[i] = res;
          return;
        }
      }
      entries.push(res);
    };
    VersionInfo2.prototype.getDefaultVersionLang = function(propName) {
      var num = Number(this.lang);
      if (this.lang !== "" && !isNaN(num)) {
        return num;
      }
      var a = this.data.strings.filter(function(e) {
        return propName in e.values && e.values[propName] != null;
      }).map(function(e) {
        return e.lang;
      });
      if (a.length === 1) {
        return a[0];
      }
      return 1033;
    };
    VersionInfo2.prototype.setFileVersion = function(arg1, arg2, arg3, arg4, arg5) {
      this.setFileVersionImpl.apply(this, parseVersionArguments(arg1, arg2, arg3, arg4, arg5));
    };
    VersionInfo2.prototype.setFileVersionImpl = function(major, minor, micro, revision, lang) {
      lang = typeof lang !== "undefined" ? lang : this.getDefaultVersionLang("FileVersion");
      this.fixedInfo.fileVersionMS = major << 16 | minor;
      this.fixedInfo.fileVersionLS = micro << 16 | revision;
      this.setStringValue({ lang, codepage: 1200 }, "FileVersion", "".concat(major, ".").concat(minor, ".").concat(micro, ".").concat(revision), true);
    };
    VersionInfo2.prototype.setProductVersion = function(arg1, arg2, arg3, arg4, arg5) {
      this.setProductVersionImpl.apply(this, parseVersionArguments(arg1, arg2, arg3, arg4, arg5));
    };
    VersionInfo2.prototype.setProductVersionImpl = function(major, minor, micro, revision, lang) {
      lang = typeof lang !== "undefined" ? lang : this.getDefaultVersionLang("ProductVersion");
      this.fixedInfo.productVersionMS = major << 16 | minor;
      this.fixedInfo.productVersionLS = micro << 16 | revision;
      this.setStringValue({ lang, codepage: 1200 }, "ProductVersion", "".concat(major, ".").concat(minor, ".").concat(micro, ".").concat(revision), true);
    };
    return VersionInfo2;
  })()
);

// node_modules/resedit/dist/resource/IconGroupEntry.js
function generateEntryBinary2(icons) {
  var count = icons.length;
  if (count > 65535) {
    count = 65535;
  }
  var size = 6 + 14 * icons.length;
  var bin = new ArrayBuffer(size);
  var view = new DataView(bin);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, count, true);
  var offset = 6;
  icons.forEach(function(icon) {
    view.setUint8(offset, icon.width >= 256 ? 0 : icon.width);
    view.setUint8(offset + 1, icon.height >= 256 ? 0 : icon.height);
    view.setUint8(offset + 2, icon.colors >= 256 ? 0 : icon.colors);
    view.setUint8(offset + 3, 0);
    view.setUint16(offset + 4, icon.planes, true);
    view.setUint16(offset + 6, icon.bitCount, true);
    view.setUint32(offset + 8, icon.dataSize, true);
    view.setUint16(offset + 12, icon.iconID, true);
    offset += 14;
  });
  return bin;
}
function findUnusedIconID(entries, lang, isCursor) {
  var type = isCursor ? 1 : 3;
  var filteredIDs = entries.filter(function(e) {
    return e.type === type && e.lang === lang && typeof e.id === "number";
  }).map(function(e) {
    return e.id;
  }).sort(function(a, b) {
    return a - b;
  });
  var idCurrent = 1;
  for (var _i = 0, filteredIDs_1 = filteredIDs; _i < filteredIDs_1.length; _i++) {
    var id = filteredIDs_1[_i];
    if (idCurrent < id) {
      return {
        id: idCurrent,
        last: false
      };
    } else if (idCurrent === id) {
      ++idCurrent;
    }
  }
  return {
    id: idCurrent,
    last: true
  };
}
var IconGroupEntry = (
  /** @class */
  (function() {
    function IconGroupEntry2(groupEntry) {
      var view = new DataView(groupEntry.bin);
      var totalSize = view.byteLength;
      var icons = [];
      if (view.getUint16(2, true) === 1) {
        var count = view.getUint16(4, true);
        var offset = 6;
        for (var i = 0; i < count; ++i) {
          icons.push({
            width: readUint8WithLastOffset(view, offset, totalSize),
            height: readUint8WithLastOffset(view, offset + 1, totalSize),
            colors: readUint8WithLastOffset(view, offset + 2, totalSize),
            planes: readUint16WithLastOffset(view, offset + 4, totalSize),
            bitCount: readUint16WithLastOffset(view, offset + 6, totalSize),
            dataSize: readUint32WithLastOffset(view, offset + 8, totalSize),
            iconID: readUint16WithLastOffset(view, offset + 12, totalSize)
          });
          offset += 14;
        }
      }
      this.id = groupEntry.id;
      this.lang = groupEntry.lang;
      this.icons = icons;
    }
    IconGroupEntry2.fromEntries = function(entries) {
      return entries.filter(function(e) {
        return e.type === 14;
      }).map(function(e) {
        return new IconGroupEntry2(e);
      });
    };
    IconGroupEntry2.prototype.generateEntry = function() {
      var bin = generateEntryBinary2(this.icons);
      return {
        type: 14,
        id: this.id,
        lang: this.lang,
        codepage: 0,
        bin
      };
    };
    IconGroupEntry2.prototype.getIconItemsFromEntries = function(entries) {
      var _this = this;
      return entries.map(function(e) {
        if (e.type !== 3 || e.lang !== _this.lang) {
          return null;
        }
        var c = _this.icons.filter(function(icon) {
          return e.id === icon.iconID;
        }).shift();
        if (!c) {
          return null;
        }
        return {
          entry: e,
          icon: c
        };
      }).filter(function(item) {
        return !!item;
      }).map(function(item) {
        var bin = item.entry.bin;
        var view = new DataView(bin);
        if (view.getUint32(0, true) === 40) {
          return IconItem_default.from(bin);
        } else {
          var c = item.icon;
          return RawIconItem_default.from(bin, c.width, c.height, c.bitCount);
        }
      });
    };
    IconGroupEntry2.replaceIconsForResource = function(destEntries, iconGroupID, lang, icons) {
      var entry2 = destEntries.filter(function(e2) {
        return e2.type === 14 && e2.id === iconGroupID && e2.lang === lang;
      }).shift();
      var tmpIconArray = icons.map(function(icon) {
        if (icon.isIcon()) {
          var width = icon.width, height = icon.height;
          if (width === null) {
            width = icon.bitmapInfo.width;
          }
          if (height === null) {
            height = icon.bitmapInfo.height;
            if (icon.masks !== null) {
              height = Math.floor(height / 2);
            }
          }
          return {
            base: icon,
            bm: {
              width,
              height,
              planes: icon.bitmapInfo.planes,
              bitCount: icon.bitmapInfo.bitCount
            },
            bin: icon.generate(),
            id: 0
          };
        } else {
          return {
            base: icon,
            bm: {
              width: icon.width,
              height: icon.height,
              planes: 1,
              bitCount: icon.bitCount
            },
            bin: icon.bin,
            id: 0
          };
        }
      });
      if (entry2) {
        for (var i = destEntries.length - 1; i >= 0; --i) {
          var e = destEntries[i];
          if (e != null && e.type === 3) {
            if (!isIconUsed(e, destEntries, entry2)) {
              destEntries.splice(i, 1);
            }
          }
        }
      } else {
        entry2 = {
          type: 14,
          id: iconGroupID,
          lang,
          codepage: 0,
          // set later
          bin: null
        };
        destEntries.push(entry2);
      }
      var idInfo;
      tmpIconArray.forEach(function(icon) {
        if (!(idInfo === null || idInfo === void 0 ? void 0 : idInfo.last)) {
          idInfo = findUnusedIconID(destEntries, lang, false);
        } else {
          ++idInfo.id;
        }
        destEntries.push({
          type: 3,
          id: idInfo.id,
          lang,
          codepage: 0,
          bin: icon.bin
        });
        icon.id = idInfo.id;
      });
      var binEntry = generateEntryBinary2(tmpIconArray.map(function(icon) {
        var width = Math.abs(icon.bm.width);
        if (width >= 256) {
          width = 0;
        }
        var height = Math.abs(icon.bm.height);
        if (height >= 256) {
          height = 0;
        }
        var colors = 0;
        if (icon.base.isIcon()) {
          var bmBase = icon.base.bitmapInfo;
          colors = bmBase.colorUsed || bmBase.colors.length;
          if (!colors) {
            switch (bmBase.bitCount) {
              case 1:
                colors = 2;
                break;
              case 4:
                colors = 16;
                break;
            }
          }
          if (colors >= 256) {
            colors = 0;
          }
        }
        return {
          width,
          height,
          colors,
          planes: icon.bm.planes,
          bitCount: icon.bm.bitCount,
          dataSize: icon.bin.byteLength,
          iconID: icon.id
        };
      }));
      entry2.bin = binEntry;
      function isIconUsed(icon, allEntries, excludeGroup) {
        return allEntries.some(function(e2) {
          if (e2.type !== 14 || e2.id === excludeGroup.id && e2.lang === excludeGroup.lang) {
            return false;
          }
          var g = new IconGroupEntry2(e2);
          return g.icons.some(function(c) {
            return c.iconID === icon.id;
          });
        });
      }
    };
    return IconGroupEntry2;
  })()
);

// node_modules/resedit/dist/resource/StringTableItem.js
var StringTableItem = (
  /** @class */
  (function() {
    function StringTableItem2() {
      this.length = 16;
      this._a = [];
      this._a.length = 16;
      for (var i = 0; i < 16; ++i) {
        this._a[i] = "";
      }
    }
    StringTableItem2.fromEntry = function(bin, offset, byteLength) {
      var view = new DataView(bin, offset, byteLength);
      var ret = new StringTableItem2();
      var o = 0;
      for (var i = 0; i < 16; ++i) {
        var len = view.getUint16(o, true);
        o += 2;
        var s = "";
        for (var j = 0; j < len; ++j) {
          s += String.fromCharCode(view.getUint16(o, true));
          o += 2;
        }
        ret._a[i] = s;
      }
      return ret;
    };
    StringTableItem2.prototype.get = function(index) {
      var value = this._a[index];
      return value != null && value !== "" ? value : null;
    };
    StringTableItem2.prototype.getAll = function() {
      return this._a.map(function(s) {
        return s || null;
      });
    };
    StringTableItem2.prototype.set = function(index, val) {
      this._a[index] = "".concat(val !== null && val !== void 0 ? val : "").substr(0, 4097);
    };
    StringTableItem2.prototype.calcByteLength = function() {
      var len = 0;
      for (var i = 0; i < 16; ++i) {
        var item = this._a[i];
        len += 2;
        if (item != null) {
          len += 2 * item.length;
        }
      }
      return Math.floor((len + 15) / 16) * 16;
    };
    StringTableItem2.prototype.generate = function(bin, offset) {
      var out = new DataView(bin, offset);
      var len = 0;
      for (var i = 0; i < 16; ++i) {
        var s = this._a[i];
        var l = s == null ? 0 : s.length > 4097 ? 4097 : s.length;
        out.setUint16(len, l, true);
        len += 2;
        if (s != null) {
          for (var j = 0; j < l; ++j) {
            out.setUint16(len, s.charCodeAt(j), true);
            len += 2;
          }
        }
      }
      return Math.floor((len + 15) / 16) * 16;
    };
    return StringTableItem2;
  })()
);
var StringTableItem_default = StringTableItem;

// node_modules/resedit/dist/resource/StringTable.js
var StringTable = (
  /** @class */
  (function() {
    function StringTable2() {
      this.lang = 0;
      this.items = [];
    }
    StringTable2.fromEntries = function(lang, entries) {
      var r = new StringTable2();
      entries.forEach(function(e) {
        if (e.type !== 6 || e.lang !== lang || typeof e.id !== "number" || e.id <= 0) {
          return;
        }
        r.items[e.id - 1] = StringTableItem_default.fromEntry(e.bin, 0, e.bin.byteLength);
      });
      r.lang = lang;
      return r;
    };
    StringTable2.prototype.getAllStrings = function() {
      return this.items.map(function(e, i) {
        return e.getAll().map(function(x, j) {
          return x !== null && x !== "" ? { id: (i << 4) + j, text: x } : null;
        }).filter(function(x) {
          return !!x;
        });
      }).reduce(function(p, c) {
        return p.concat(c);
      }, []);
    };
    StringTable2.prototype.getById = function(id) {
      var _a;
      if (id < 0) {
        return null;
      }
      var entryIndex = id >> 4;
      var entryPos = id & 15;
      var e = this.items[entryIndex];
      return (_a = e === null || e === void 0 ? void 0 : e.get(entryPos)) !== null && _a !== void 0 ? _a : null;
    };
    StringTable2.prototype.setById = function(id, text) {
      if (id < 0) {
        return;
      }
      var entryIndex = id >> 4;
      var entryPos = id & 15;
      var e = this.items[entryIndex];
      if (!e) {
        this.items[entryIndex] = e = new StringTableItem_default();
      }
      e.set(entryPos, text);
    };
    StringTable2.prototype.generateEntries = function() {
      var _this = this;
      return this.items.map(function(e, i) {
        var len = e.calcByteLength();
        var bin = new ArrayBuffer(len);
        e.generate(bin, 0);
        return {
          type: 6,
          id: i + 1,
          lang: _this.lang,
          codepage: 1200,
          bin
        };
      }).filter(function(e) {
        return !!e;
      });
    };
    StringTable2.prototype.replaceStringEntriesForExecutable = function(res) {
      var entries = this.generateEntries();
      var dest = res.entries;
      for (var i = 0; i < dest.length; ++i) {
        var e = dest[i];
        if (e != null && e.type === 6 && e.lang === this.lang) {
          for (var j = dest.length - 1; j >= i; --j) {
            var e2 = dest[j];
            if (e2 != null && e2.type === 6 && e2.lang === this.lang) {
              dest.splice(j, 1);
            }
          }
          var f = dest.splice.bind(dest, i, 0);
          f.apply(void 0, entries);
          return;
        }
      }
      for (var i = 0; i < dest.length; ++i) {
        var e = dest[i];
        if (e != null && e.type === 6 && e.lang < this.lang) {
          var f = dest.splice.bind(dest, i + 1, 0);
          f.apply(void 0, entries);
          return;
        }
      }
      for (var i = dest.length - 1; i >= 0; --i) {
        var e = dest[i];
        if (e != null && e.type === 6) {
          var f = dest.splice.bind(dest, i + 1, 0);
          f.apply(void 0, entries);
          return;
        }
      }
      dest.push.apply(dest, entries);
    };
    return StringTable2;
  })()
);

// node_modules/resedit/dist/sign/data/DERObject.js
var RawDERObject = (
  /** @class */
  (function() {
    function RawDERObject2(data) {
      this.data = data;
    }
    RawDERObject2.prototype.toDER = function() {
      return [].slice.call(this.data);
    };
    return RawDERObject2;
  })()
);

// node_modules/resedit/dist/sign/data/derUtil.js
function makeDERLength(length) {
  if (length < 128) {
    return [length];
  }
  var r = [];
  while (true) {
    r.push(length & 255);
    if (length < 256) {
      break;
    }
    length >>= 8;
  }
  r.push(128 + r.length);
  return r.reverse();
}
function makeDERIA5String(text) {
  var r = [].map.call(text, function(c) {
    return c.charCodeAt(0);
  }).filter(function(n) {
    return n < 128;
  });
  return [22].concat(makeDERLength(r.length)).concat(r);
}
function makeDERBMPString(text) {
  var r = [].map.call(text, function(c) {
    return c.charCodeAt(0);
  });
  var ua = new Uint8Array(r.length * 2);
  var dv = new DataView(ua.buffer);
  r.forEach(function(v, i) {
    dv.setUint16(i * 2, v, false);
  });
  return [30].concat(makeDERLength(ua.length)).concat(
    // convert Uint8Array to number[] (not using spread operator)
    [].slice.call(ua)
  );
}
function makeDEROctetString(bin) {
  if (!(bin instanceof Array)) {
    bin = [].slice.call(bin);
  }
  return [4].concat(makeDERLength(bin.length)).concat(bin);
}
function makeDERTaggedData(tag, body) {
  return [160 + tag].concat(makeDERLength(body.length)).concat(body);
}
function makeDERSequence(body) {
  return [48].concat(makeDERLength(body.length)).concat(body);
}
function arrayToDERSet(items) {
  var r = items.reduce(function(prev, item) {
    return prev.concat(item instanceof Array ? item : item.toDER());
  }, []);
  return [49].concat(makeDERLength(r.length)).concat(r);
}

// node_modules/resedit/dist/sign/data/ObjectIdentifier.js
var ObjectIdentifier = (
  /** @class */
  (function() {
    function ObjectIdentifier2(value) {
      if (typeof value === "string") {
        this.value = value.split(/\./g).map(function(s) {
          return Number(s);
        });
      } else {
        this.value = value;
      }
    }
    ObjectIdentifier2.prototype.toDER = function() {
      var id = this.value;
      var r = [];
      if (id.length < 2) {
        throw new Error("Unexpected 'value' field");
      }
      r.push(id[0] * 40 + id[1]);
      for (var i = 2; i < id.length; ++i) {
        var val = id[i];
        var isFirst = true;
        var insertPos = r.length;
        while (true) {
          var v = val & 127;
          if (!isFirst) {
            v += 128;
          }
          r.splice(insertPos, 0, v);
          if (val < 128) {
            break;
          }
          isFirst = false;
          val = Math.floor(val / 128);
        }
      }
      return [6].concat(makeDERLength(r.length)).concat(r);
    };
    return ObjectIdentifier2;
  })()
);
var ObjectIdentifier_default = ObjectIdentifier;

// node_modules/resedit/dist/sign/data/KnownOids.js
var OID_SHA1_NO_SIGN = new ObjectIdentifier_default([1, 3, 14, 3, 2, 26]);
var OID_SHA256_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 1]);
var OID_SHA384_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 2]);
var OID_SHA512_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 3]);
var OID_SHA224_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 4]);
var OID_SHA512_224_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 5]);
var OID_SHA512_256_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 6]);
var OID_SHA3_224_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 7]);
var OID_SHA3_256_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 8]);
var OID_SHA3_384_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 9]);
var OID_SHA3_512_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 10]);
var OID_SHAKE128_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 11]);
var OID_SHAKE256_NO_SIGN = new ObjectIdentifier_default([2, 16, 840, 1, 101, 3, 4, 2, 12]);
var OID_RSA = new ObjectIdentifier_default([1, 2, 840, 113549, 1, 1, 1]);
var OID_DSA = new ObjectIdentifier_default([1, 2, 840, 10040, 4, 1]);
var OID_SIGNED_DATA = new ObjectIdentifier_default([1, 2, 840, 113549, 1, 7, 2]);
var OID_CONTENT_TYPE = new ObjectIdentifier_default([1, 2, 840, 113549, 1, 9, 3]);
var OID_MESSAGE_DIGEST = new ObjectIdentifier_default([1, 2, 840, 113549, 1, 9, 4]);
var OID_SPC_STATEMENT_TYPE_OBJID = new ObjectIdentifier_default([1, 3, 6, 1, 4, 1, 311, 2, 1, 11]);
var OID_SPC_SP_OPUS_INFO_OBJID = new ObjectIdentifier_default([1, 3, 6, 1, 4, 1, 311, 2, 1, 12]);
var OID_SPC_INDIVIDUAL_SP_KEY_PURPOSE_OBJID = new ObjectIdentifier_default([1, 3, 6, 1, 4, 1, 311, 2, 1, 21]);
var OID_RFC3161_COUNTER_SIGNATURE = new ObjectIdentifier_default([1, 3, 6, 1, 4, 1, 311, 3, 3, 1]);

// node_modules/resedit/dist/sign/data/AlgorithmIdentifier.js
var AlgorithmIdentifier = (
  /** @class */
  (function() {
    function AlgorithmIdentifier2(algorithm) {
      this.algorithm = algorithm;
    }
    AlgorithmIdentifier2.prototype.toDER = function() {
      var r = this.algorithm.toDER();
      return makeDERSequence(r.concat(
        // parameters is not used now
        [5, 0]
      ));
    };
    return AlgorithmIdentifier2;
  })()
);

// node_modules/resedit/dist/sign/data/Attribute.js
var Attribute = (
  /** @class */
  (function() {
    function Attribute2(attrType, attrValues) {
      this.attrType = attrType;
      this.attrValues = attrValues;
    }
    Attribute2.prototype.toDER = function() {
      return makeDERSequence(this.attrType.toDER().concat(arrayToDERSet(this.attrValues)));
    };
    return Attribute2;
  })()
);

// node_modules/resedit/dist/sign/data/ContentInfo.js
var ContentInfo = (
  /** @class */
  (function() {
    function ContentInfo2(contentType, content) {
      this.contentType = contentType;
      this.content = content;
    }
    ContentInfo2.prototype.toDER = function() {
      return makeDERSequence(this.contentType.toDER().concat(makeDERTaggedData(0, this.content.toDER())));
    };
    return ContentInfo2;
  })()
);
var ContentInfo_default = ContentInfo;

// node_modules/resedit/dist/sign/data/CertificateDataRoot.js
var __extends9 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var CertificateDataRoot = (
  /** @class */
  (function(_super) {
    __extends9(CertificateDataRoot2, _super);
    function CertificateDataRoot2() {
      return _super !== null && _super.apply(this, arguments) || this;
    }
    return CertificateDataRoot2;
  })(ContentInfo_default)
);

// node_modules/resedit/dist/sign/data/DigestInfo.js
var DigestInfo = (
  /** @class */
  (function() {
    function DigestInfo2(digestAlgorithm, digest) {
      this.digestAlgorithm = digestAlgorithm;
      this.digest = digest;
    }
    DigestInfo2.prototype.toDER = function() {
      var digest = this.digest;
      var digestArray;
      if ("buffer" in digest) {
        digestArray = new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
      } else {
        digestArray = new Uint8Array(digest);
      }
      var derData = this.digestAlgorithm.toDER().concat(makeDEROctetString(digestArray));
      return makeDERSequence(derData);
    };
    return DigestInfo2;
  })()
);

// node_modules/resedit/dist/sign/data/IssuerAndSerialNumber.js
var IssuerAndSerialNumber = (
  /** @class */
  (function() {
    function IssuerAndSerialNumber2(issuer, serialNumber) {
      this.issuer = issuer;
      this.serialNumber = serialNumber;
    }
    IssuerAndSerialNumber2.prototype.toDER = function() {
      return makeDERSequence(this.issuer.toDER().concat(this.serialNumber.toDER()));
    };
    return IssuerAndSerialNumber2;
  })()
);

// node_modules/resedit/dist/sign/data/SignedData.js
var SignedData = (
  /** @class */
  (function() {
    function SignedData2(version, digestAlgorithms, contentInfo, signerInfos, certificates, crls) {
      this.version = version;
      this.digestAlgorithms = digestAlgorithms;
      this.contentInfo = contentInfo;
      this.signerInfos = signerInfos;
      this.certificates = certificates;
      this.crls = crls;
    }
    SignedData2.prototype.toDER = function() {
      var r = [2, 1, this.version & 255].concat(arrayToDERSet(this.digestAlgorithms)).concat(this.contentInfo.toDER());
      if (this.certificates && this.certificates.length > 0) {
        var allCertsDER = arrayToDERSet(this.certificates);
        allCertsDER[0] = 160;
        r = r.concat(allCertsDER);
      }
      if (this.crls) {
        r = r.concat(makeDERTaggedData(1, arrayToDERSet(this.crls)));
      }
      r = r.concat(arrayToDERSet(this.signerInfos));
      return makeDERSequence(r);
    };
    return SignedData2;
  })()
);

// node_modules/resedit/dist/sign/data/SignerInfo.js
var SignerInfo = (
  /** @class */
  (function() {
    function SignerInfo2(version, issuerAndSerialNumber, digestAlgorithm, digestEncryptionAlgorithm, encryptedDigest, authenticatedAttributes, unauthenticatedAttributes) {
      this.version = version;
      this.issuerAndSerialNumber = issuerAndSerialNumber;
      this.digestAlgorithm = digestAlgorithm;
      this.digestEncryptionAlgorithm = digestEncryptionAlgorithm;
      this.encryptedDigest = encryptedDigest;
      this.authenticatedAttributes = authenticatedAttributes;
      this.unauthenticatedAttributes = unauthenticatedAttributes;
    }
    SignerInfo2.prototype.toDER = function() {
      var r = [2, 1, this.version & 255].concat(this.issuerAndSerialNumber.toDER()).concat(this.digestAlgorithm.toDER());
      if (this.authenticatedAttributes && this.authenticatedAttributes.length > 0) {
        var a = arrayToDERSet(this.authenticatedAttributes);
        a[0] = 160;
        r = r.concat(a);
      }
      r = r.concat(this.digestEncryptionAlgorithm.toDER()).concat(makeDEROctetString(this.encryptedDigest));
      if (this.unauthenticatedAttributes && this.unauthenticatedAttributes.length > 0) {
        var u = arrayToDERSet(this.unauthenticatedAttributes);
        u[0] = 161;
        r = r.concat(u);
      }
      return makeDERSequence(r);
    };
    return SignerInfo2;
  })()
);

// node_modules/resedit/dist/sign/data/SpcIndirectDataContent.js
var __extends10 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var SPC_INDIRECT_DATA_OBJID = new ObjectIdentifier_default([1, 3, 6, 1, 4, 1, 311, 2, 1, 4]);
var SpcAttributeTypeAndOptionalValue = (
  /** @class */
  (function() {
    function SpcAttributeTypeAndOptionalValue2(type, value) {
      this.type = type;
      this.value = value;
    }
    SpcAttributeTypeAndOptionalValue2.prototype.toDER = function() {
      return makeDERSequence(this.type.toDER().concat(this.value.toDER()));
    };
    return SpcAttributeTypeAndOptionalValue2;
  })()
);
var SpcIndirectDataContent = (
  /** @class */
  (function() {
    function SpcIndirectDataContent2(data, messageDigest) {
      this.data = data;
      this.messageDigest = messageDigest;
    }
    SpcIndirectDataContent2.prototype.toDER = function() {
      return makeDERSequence(this.toDERWithoutHeader());
    };
    SpcIndirectDataContent2.prototype.toDERWithoutHeader = function() {
      return this.data.toDER().concat(this.messageDigest.toDER());
    };
    return SpcIndirectDataContent2;
  })()
);
var SpcIndirectDataContentInfo = (
  /** @class */
  (function(_super) {
    __extends10(SpcIndirectDataContentInfo2, _super);
    function SpcIndirectDataContentInfo2(content) {
      return _super.call(this, SPC_INDIRECT_DATA_OBJID, content) || this;
    }
    return SpcIndirectDataContentInfo2;
  })(ContentInfo_default)
);

// node_modules/resedit/dist/sign/data/SpcLink.js
var __extends11 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var SpcLink = (
  /** @class */
  (function() {
    function SpcLink2(tag, value) {
      this.tag = tag;
      this.value = value;
    }
    SpcLink2.prototype.toDER = function() {
      var v = this.value.toDER();
      if (this.tag === 2) {
        return makeDERTaggedData(this.tag, v);
      } else {
        v[0] = 128 + this.tag;
        return v;
      }
    };
    return SpcLink2;
  })()
);
var SpcLinkUrl = (
  /** @class */
  (function(_super) {
    __extends11(SpcLinkUrl2, _super);
    function SpcLinkUrl2(url) {
      return _super.call(this, 0, new RawDERObject(makeDERIA5String(url))) || this;
    }
    return SpcLinkUrl2;
  })(SpcLink)
);
var SpcLinkFile = (
  /** @class */
  (function(_super) {
    __extends11(SpcLinkFile2, _super);
    function SpcLinkFile2(file) {
      var v = makeDERBMPString(file);
      v[0] = 128;
      return _super.call(this, 2, new RawDERObject(v)) || this;
    }
    return SpcLinkFile2;
  })(SpcLink)
);

// node_modules/resedit/dist/sign/data/SpcPeImageData.js
var __extends12 = /* @__PURE__ */ (function() {
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
    };
    return extendStatics(d, b);
  };
  return function(d, b) {
    if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();
var SPC_PE_IMAGE_DATA_OBJID = new ObjectIdentifier_default([1, 3, 6, 1, 4, 1, 311, 2, 1, 15]);
var SpcPeImageData = (
  /** @class */
  (function() {
    function SpcPeImageData2(flags, file) {
      this.flags = flags;
      this.file = file;
    }
    SpcPeImageData2.prototype.toDER = function() {
      return makeDERSequence([3, 1, this.flags & 255].concat(
        // undocumented -- SpcLink must be tagged
        makeDERTaggedData(0, this.file.toDER())
      ));
    };
    return SpcPeImageData2;
  })()
);
var SpcPeImageAttributeTypeAndOptionalValue = (
  /** @class */
  (function(_super) {
    __extends12(SpcPeImageAttributeTypeAndOptionalValue2, _super);
    function SpcPeImageAttributeTypeAndOptionalValue2(value) {
      return _super.call(this, SPC_PE_IMAGE_DATA_OBJID, value) || this;
    }
    return SpcPeImageAttributeTypeAndOptionalValue2;
  })(SpcAttributeTypeAndOptionalValue)
);

// src/windows-resources.ts
async function update(executable, digest) {
  const binary = NtExecutable_default.from(await readFile3(executable), { ignoreCert: true });
  const resources = NtExecutableResource_default.from(binary);
  const matches = resources.entries.filter((value2) => String(value2.type).toUpperCase() === "INTEGRITY" && String(value2.id).toUpperCase() === "ELECTRONASAR");
  const value = new TextEncoder().encode(JSON.stringify([{ file: "resources\\app.asar", alg: "sha256", value: digest }])).buffer;
  if (matches.length) for (const resource of matches) resource.bin = value;
  else resources.entries.push({ type: "INTEGRITY", id: "ELECTRONASAR", lang: 1033, codepage: 1200, bin: value });
  resources.outputResource(binary);
  await writeFile3(executable, Buffer.from(binary.generate()));
}

// src/platform.ts
var recordPath2 = path5.join(dataRoot2, "platform.json");
var macRecordPath = path5.join(dataRoot2, "mac-install.json");
var managedCopyName = /^managed-(darwin|win32)-[a-f0-9]{16}(?:\.app)?$/;
function nativeInstallChanged(record, liveHash) {
  return Boolean(liveHash) && liveHash !== (record.originalFingerprint ?? record.fingerprint);
}
async function writeRecord2(record) {
  await writeFile4(`${recordPath2}.tmp`, JSON.stringify(record, null, 2), { mode: 384 });
  await rename3(`${recordPath2}.tmp`, recordPath2);
}
async function windowsIntegrity(executable, archive) {
  const { headerString } = await archiveHeader(archive);
  const digest = createHash3("sha256").update(headerString).digest("hex");
  await update(executable, digest);
}
async function installPlatform(sourcePath, kind, options = {}) {
  if (kind === "darwin") return installMacApp(options.original ?? sourcePath);
  if (kind !== platform4()) throw new Error(`${kind} installation must run on ${kind}.`);
  const source = path5.resolve(sourcePath);
  const original = path5.resolve(options.original ?? source);
  const sourceArchive = path5.join(source, "resources", "app.asar");
  if (!await exists(sourceArchive)) throw new Error("Choose the Windows installation directory containing resources/app.asar.");
  const fingerprint = await sha256(sourceArchive);
  const originalFingerprint = options.originalFingerprint ?? fingerprint;
  const previous = await exists(recordPath2) ? JSON.parse(await readFile4(recordPath2, "utf8")) : null;
  if (previous && previous.fingerprint === fingerprint && await exists(previous.archive)) {
    await patchArchive(previous.archive, { managedCopy: true });
    if (path5.resolve(previous.original) !== original || previous.originalFingerprint !== originalFingerprint) {
      const refreshed = { ...previous, original, originalFingerprint };
      await writeRecord2(refreshed);
      return refreshed;
    }
    return previous;
  }
  await mkdir3(dataRoot2, { recursive: true, mode: 448 });
  const copy = path5.join(dataRoot2, `managed-${kind}-${fingerprint.slice(0, 16)}`);
  if (await exists(copy)) throw new Error(`Managed copy already exists at ${copy}. It has not been overwritten.`);
  let record;
  try {
    await cp(source, copy, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    const archive = path5.join(copy, "resources", "app.asar");
    const patch = await patchArchive(archive, { managedCopy: true });
    const files = (await readdir3(copy)).filter((name) => /^(?:T3[ -]?Code|t3code)\.exe$/i.test(name));
    if (files.length !== 1) throw new Error("The Windows T3 executable could not be identified.");
    const executableName2 = files[0];
    if (!executableName2) throw new Error("The Windows T3 executable could not be identified.");
    const executable = path5.join(copy, executableName2);
    await windowsIntegrity(executable, archive);
    record = { kind, original, originalFingerprint, fingerprint, copy, archive, executable, appVersion: patch.appVersion, previousCopy: previous?.copy ?? null };
    await writeRecord2(record);
  } catch (error) {
    await rm3(copy, { recursive: true, force: true });
    throw error;
  }
  try {
    await removeStaleOwnedCopy(previous?.previousCopy, { root: dataRoot2, retain: [copy, record.previousCopy], pattern: managedCopyName });
  } catch (error) {
    console.warn(`Older managed copy was left in place: ${failureText(error)}`);
  }
  return record;
}
async function launchPlatform(args2 = []) {
  if (await exists(macRecordPath)) return launchMacApp(args2);
  let record = JSON.parse(await readFile4(recordPath2, "utf8"));
  if (record.kind === "darwin") {
    await installMacApp(record.original);
    return launchMacApp(args2);
  }
  try {
    const archive = path5.join(record.original, "resources", "app.asar");
    if (nativeInstallChanged(record, await sha256(archive))) {
      console.log("T3 updated. Refreshing its modded copy\u2026");
      record = await installPlatform(record.original, record.kind);
    }
    await patchArchive(record.archive, { managedCopy: true, checkOnly: true });
    await command(record.executable, args2, { env: { ...process.env, MODS_FOR_T3_MANAGED_COPY: "1", MODS_FOR_T3_ORIGINAL: record.original } });
  } catch (error) {
    console.warn(`Mod copy could not start: ${failureText(error)}
Opening the original T3 app. Your mods are preserved.`);
    const name = path5.basename(record.executable);
    await command(path5.join(record.original, name), args2);
  }
}
async function uninstallPlatform() {
  if (await exists(macRecordPath)) return uninstallMacApp();
  const record = JSON.parse(await readFile4(recordPath2, "utf8"));
  for (const copy of [record.copy, record.previousCopy]) {
    if (!copy) continue;
    if (path5.dirname(copy) !== dataRoot2 || !/^managed-(darwin|win32)-[a-f0-9]{16}(?:\.app)?$/.test(path5.basename(copy))) throw new Error("Invalid managed-copy record.");
    await rm3(copy, { recursive: true, force: true });
  }
  await rm3(recordPath2);
}
async function detectPlatform({ kind = platform4(), home = homedir2(), applications = "/Applications", localAppData = process.env.LOCALAPPDATA || home, programFiles = process.env.ProgramFiles || "C:\\Program Files" } = {}) {
  const names = ["T3 Code", "T3-Code", "T3Code", "T3", "T3 Code (Alpha)", "T3 Code (Nightly)", "T3 Code Nightly"];
  if (kind === "darwin") {
    const directories = [applications, path5.join(home, "Applications")];
    for (const directory of directories) for (const name of names) {
      const candidate = path5.join(directory, `${name}.app`);
      if (await exists(path5.join(candidate, "Contents", "Resources", "app.asar"))) return candidate;
    }
    throw new Error(`T3 was not found in ${directories.join(" or ")}. Pass --mac-app '/path/to/your T3.app' (including the full app name).`);
  }
  if (kind === "win32") {
    const directories = [path5.join(localAppData, "Programs"), programFiles];
    for (const directory of directories) for (const name of [...names, "t3-code", "t3code"]) {
      const candidate = path5.join(directory, name);
      if (await exists(path5.join(candidate, "resources", "app.asar"))) return candidate;
    }
    throw new Error(`T3 was not found in ${directories.join(" or ")}. Pass --windows-dir 'C:\\path\\to\\your T3 installation'.`);
  }
  throw new Error(`Native installation detection is unsupported on ${kind}. On Linux use --appimage or --asar.`);
}

// src/windows-install.ts
import { cp as cp2, lstat as lstat2, mkdir as mkdir4, readdir as readdir4, readFile as readFile5, realpath as realpath3, rename as rename4, rm as rm4, writeFile as writeFile5 } from "node:fs/promises";
import { randomBytes as randomBytes2 } from "node:crypto";
import { platform as platform5 } from "node:os";
import path6 from "node:path";
var marker3 = "/* mods-for-t3-code:v1 */";
var recordPath3 = path6.join(dataRoot2, "windows-install.json");
var backupsRoot2 = path6.join(dataRoot2, "backups");
var backupPattern2 = /^win-[a-f0-9]{16}$/;
var executablePattern = /^(?:T3[ -]?Code|t3code)\.exe$/i;
var managedCopyPattern2 = /^managed-win32-[a-f0-9]{16}$/;
function sidecarPathsForArchive(archive) {
  const target = path6.resolve(archive);
  return { archive: target, backup: `${target}.mods-for-t3-code.bak`, stateFile: `${target}.mods-for-t3-code.json` };
}
function relocatedSidecarState2(state, archive) {
  const paths2 = sidecarPathsForArchive(archive);
  return { ...state, archive: paths2.archive, backup: paths2.backup };
}
function windowsInstallPlan({ hasRecord, sameApp, liveHash, recordedPatchedHash, sidecarPatchedHash, recognized, markerFree }) {
  if (sameApp && recordedPatchedHash && liveHash === recordedPatchedHash) return "current";
  if (sidecarPatchedHash && liveHash === sidecarPatchedHash) return "record-missing";
  if (!recognized || !markerFree) return "refuse";
  if (hasRecord && sameApp) return "adopt";
  if (hasRecord && !sameApp) return "other-app";
  return "fresh";
}
function windowsRestorePlan({ liveHash, recordedPatchedHash, backupHash, recordedOriginalHash, recognized, markerFree }) {
  if (liveHash === recordedPatchedHash && backupHash === recordedOriginalHash) return "restore";
  if (liveHash !== recordedPatchedHash && recognized && markerFree) return "keep-update";
  return "refuse";
}
function assertWindows(options = {}) {
  if ((options.hostPlatform ?? platform5()) !== "win32") throw new Error("Windows installation must run on Windows.");
}
function isInside2(child, parent) {
  const resolved = path6.resolve(child);
  const root = path6.resolve(parent);
  return resolved === root || resolved.startsWith(`${root}${path6.sep}`);
}
function backupPath2(originalHash) {
  return path6.join(backupsRoot2, `win-${originalHash.slice(0, 16)}`);
}
function ownedBackupOrNull2(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const resolved = path6.resolve(candidate);
  if (path6.dirname(resolved) !== path6.resolve(backupsRoot2) || !backupPattern2.test(path6.basename(resolved))) return null;
  return resolved;
}
async function removeOwnedWindowsBackup(candidate, retain = []) {
  return removeStaleOwnedCopy(candidate, { root: backupsRoot2, retain, pattern: backupPattern2 });
}
function assertRecord2(record) {
  if (!record || record.kind !== "win32" || record.patchedInPlace !== true) throw new Error("Invalid Windows installation record.");
  const installedApp = path6.resolve(record.installedApp);
  const archive = path6.resolve(record.archive);
  const executable = path6.resolve(record.executable);
  const directoryBackup = path6.resolve(record.directoryBackup);
  if (archive !== path6.join(installedApp, "resources", "app.asar")) throw new Error("Invalid Windows installation record.");
  if (path6.dirname(executable) !== installedApp || !executablePattern.test(path6.basename(executable))) throw new Error("Invalid Windows installation record.");
  if (path6.dirname(directoryBackup) !== path6.resolve(backupsRoot2) || !backupPattern2.test(path6.basename(directoryBackup))) throw new Error("Invalid Windows installation record.");
  if (!/^[a-f0-9]{64}$/.test(record.originalHash || "") || !/^[a-f0-9]{64}$/.test(record.patchedHash || "")) throw new Error("Invalid Windows installation record.");
  return {
    ...record,
    installedApp,
    archive,
    executable,
    directoryBackup,
    previousBackup: ownedBackupOrNull2(record.previousBackup),
    patchedInPlace: true
  };
}
async function readRecord2() {
  if (!await exists(recordPath3)) return null;
  try {
    return assertRecord2(JSON.parse(await readFile5(recordPath3, "utf8")));
  } catch (error) {
    if (failureText(error) === "Invalid Windows installation record.") throw error;
    throw new Error("Windows installation record is unreadable.");
  }
}
async function writeRecord3(record) {
  const temporary = `${recordPath3}.${process.pid}.tmp`;
  await mkdir4(dataRoot2, { recursive: true, mode: 448 });
  await writeFile5(temporary, JSON.stringify(record, null, 2), { mode: 384 });
  try {
    await rename4(temporary, recordPath3);
  } catch (error) {
    await rm4(temporary, { force: true });
    throw error;
  }
  return record;
}
async function withLock2(work) {
  await mkdir4(dataRoot2, { recursive: true, mode: 448 });
  const lock = path6.join(dataRoot2, "windows-install.lock");
  await mkdir4(lock).catch(() => {
    throw new Error("Another Windows patch operation is active. If it crashed, remove the windows-install.lock directory in the mods data folder.");
  });
  try {
    return await work();
  } finally {
    await rm4(lock, { recursive: true, force: true });
  }
}
async function inspectArchive3(archive) {
  try {
    const pkg = JSON.parse((await readEntry(archive, "package.json")).toString());
    const identity = `${pkg.name || ""} ${pkg.productName || ""}`;
    if (!/t3[ -]?(?:code|desktop)|@t3tools\/desktop/i.test(identity)) return { recognized: false, markerFree: false };
    const main = pkg.main;
    if (typeof main !== "string" || !main || /(^|[/\\])\.\.([/\\]|$)/.test(main)) return { recognized: false, markerFree: false };
    const source = (await readEntry(archive, main, 12 * 1024 * 1024)).toString();
    return { recognized: true, markerFree: !source.includes(marker3), version: pkg.version || "unknown", main };
  } catch {
    return { recognized: false, markerFree: false };
  }
}
async function findExecutable(directory) {
  const files = (await readdir4(directory)).filter((name) => executablePattern.test(name));
  if (files.length !== 1) throw new Error("The Windows T3 executable could not be identified.");
  return path6.join(directory, files[0]);
}
async function legacyOriginal() {
  const filename = path6.join(dataRoot2, "platform.json");
  if (!await exists(filename)) return null;
  try {
    const record = JSON.parse(await readFile5(filename, "utf8"));
    if (record.kind !== "win32" || typeof record.original !== "string" || !record.original) return null;
    return path6.resolve(record.original);
  } catch {
    return null;
  }
}
async function resolveInstalledApp(dir) {
  if (typeof dir === "string" && dir.trim()) return path6.resolve(dir);
  if (dir != null) throw new Error("Choose the Windows T3 installation directory containing resources/app.asar.");
  const legacy = await legacyOriginal();
  if (legacy) return legacy;
  throw new Error("Choose the Windows T3 installation directory containing resources/app.asar.");
}
async function assertInstallLocation2(installedApp) {
  let info;
  try {
    info = await lstat2(installedApp);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) throw new Error("Refusing to patch a symlinked Windows installation.");
  const real = await realpath3(installedApp);
  if (isInside2(installedApp, dataRoot2) || isInside2(real, dataRoot2)) throw new Error("Refusing to patch the mods data directory.");
}
async function restoreInterruptedInstall2(installedApp) {
  if (await exists(installedApp)) return;
  const parent = path6.dirname(installedApp);
  const prefix = `.${path6.basename(installedApp)}.mods-hold-`;
  let names = [];
  try {
    names = (await readdir4(parent)).filter((name) => name.startsWith(prefix));
  } catch {
    return;
  }
  if (names.length !== 1) {
    throw new Error(names.length ? `The Windows installation directory is missing. The original was left at ${path6.join(parent, names[0])}.` : "Choose the Windows T3 installation directory containing resources/app.asar.");
  }
  await rename4(path6.join(parent, names[0]), installedApp);
}
async function removeLeftoverTemps2(installedApp) {
  const parent = path6.dirname(installedApp);
  const prefix = `.${path6.basename(installedApp)}.mods-`;
  let names = [];
  try {
    names = await readdir4(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (name.startsWith(`${prefix}stage-`) || name.startsWith(`${prefix}failed-`) || name.startsWith(`${prefix}restore-`)) {
      await rm4(path6.join(parent, name), { recursive: true, force: true });
    }
  }
}
async function copyTree(source, destination) {
  await cp2(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  const resources = path6.join(destination, "resources");
  await rm4(path6.join(resources, "app.asar.mods-for-t3-code.json"), { force: true });
  await rm4(path6.join(resources, "app.asar.mods-for-t3-code.bak"), { force: true });
  await rm4(path6.join(resources, "app.asar.mods-for-t3-code.json.tmp"), { force: true });
  await rm4(path6.join(resources, "app.asar.mods-for-t3-code.json.lock"), { recursive: true, force: true });
  const names = await readdir4(resources).catch(() => []);
  for (const name of names) {
    if (name.startsWith("app.asar.mods-tmp-") || name.startsWith("app.asar.restore-")) await rm4(path6.join(resources, name), { recursive: true, force: true });
  }
}
async function ensureBackup2(installedApp, originalHash) {
  await mkdir4(backupsRoot2, { recursive: true, mode: 448 });
  const destination = backupPath2(originalHash);
  const archived = path6.join(destination, "resources", "app.asar");
  if (await exists(destination)) {
    if (await sha256(archived) !== originalHash) throw new Error(`Backup already exists at ${destination}. It will not be overwritten.`);
    return destination;
  }
  const temporary = path6.join(backupsRoot2, `.win-${originalHash.slice(0, 16)}-${process.pid}-${randomBytes2(3).toString("hex")}`);
  try {
    await copyTree(installedApp, temporary);
    if (await sha256(path6.join(temporary, "resources", "app.asar")) !== originalHash) throw new Error("The Windows backup does not match the installed archive.");
    await rename4(temporary, destination);
  } catch (error) {
    await rm4(temporary, { recursive: true, force: true });
    if (await exists(archived) && await sha256(archived) === originalHash) return destination;
    throw error;
  }
  return destination;
}
async function commitInstalledDirectory(target, replacement) {
  const parent = path6.dirname(path6.resolve(target));
  if (path6.dirname(path6.resolve(replacement)) !== parent) throw new Error("The staged Windows install must stay in the same directory as the installed app.");
  const holding = path6.join(parent, `.${path6.basename(target)}.mods-hold-${process.pid}-${randomBytes2(4).toString("hex")}`);
  await rename4(target, holding);
  try {
    await rename4(replacement, target);
  } catch (error) {
    try {
      await rename4(holding, target);
    } catch (rollbackError) {
      throw new Error(`${failureText(error)} The original directory is at ${holding} and could not be moved back: ${failureText(rollbackError)}`);
    }
    throw error;
  }
  return holding;
}
async function rollbackCommit2(target, holding) {
  const parent = path6.dirname(target);
  const failed = path6.join(parent, `.${path6.basename(target)}.mods-failed-${process.pid}-${randomBytes2(3).toString("hex")}`);
  if (await exists(target)) await rename4(target, failed);
  try {
    await rename4(holding, target);
  } finally {
    await rm4(failed, { recursive: true, force: true });
  }
}
async function normalizeInstalledSidecar(archive, originalHash) {
  const paths2 = sidecarPathsForArchive(archive);
  const state = JSON.parse(await readFile5(paths2.stateFile, "utf8"));
  if (await sha256(paths2.backup) !== originalHash) throw new Error("The staged backup does not match the original archive.");
  const normalized = relocatedSidecarState2(state, archive);
  const temporary = `${paths2.stateFile}.${process.pid}.tmp`;
  await writeFile5(temporary, JSON.stringify(normalized, null, 2), { mode: 384 });
  try {
    await rename4(temporary, paths2.stateFile);
  } catch (error) {
    await rm4(temporary, { force: true });
    throw error;
  }
  return normalized;
}
async function retireLegacyManagedCopy2(installedApp) {
  const filename = path6.join(dataRoot2, "platform.json");
  if (!await exists(filename)) return;
  let record;
  try {
    record = JSON.parse(await readFile5(filename, "utf8"));
  } catch {
    return;
  }
  if (record.kind !== "win32" || typeof record.original !== "string" || path6.resolve(record.original) !== path6.resolve(installedApp)) return;
  for (const candidate of [record.previousCopy, record.copy]) {
    try {
      await removeStaleOwnedCopy(candidate, { root: dataRoot2, retain: [], pattern: managedCopyPattern2 });
    } catch (error) {
      console.warn(`Older managed copy was left in place: ${failureText(error)}`);
    }
  }
}
function refuseError2(inspection, hasRecord) {
  if (hasRecord) return new Error("T3 changed since this patch. Restore/reinstall the official app, then patch the new version. Your backup has been kept.");
  if (inspection.recognized && !inspection.markerFree) return new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
  return new Error("This is not a recognized T3 Code Windows installation.");
}
async function finishCurrent2(record, archive) {
  const paths2 = sidecarPathsForArchive(archive);
  if (await exists(paths2.stateFile)) {
    const state = JSON.parse(await readFile5(paths2.stateFile, "utf8"));
    if (path6.resolve(state.archive) !== paths2.archive || path6.resolve(state.backup) !== paths2.backup) await normalizeInstalledSidecar(archive, record.originalHash);
    await patchArchive(archive, { managedCopy: true });
  }
  await retireLegacyManagedCopy2(record.installedApp);
  return record;
}
async function finishRecordMissing(installedApp, executable, archive, sidecar, liveHash) {
  if (!sidecar?.originalHash || sidecar.patchedHash !== liveHash) throw new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
  const directoryBackup = backupPath2(sidecar.originalHash);
  const backupArchive = path6.join(directoryBackup, "resources", "app.asar");
  if (!await exists(backupArchive) || await sha256(backupArchive) !== sidecar.originalHash) throw new Error("The archive is patched but its original backup is missing. Restore the original app before patching again.");
  const normalized = await normalizeInstalledSidecar(archive, sidecar.originalHash);
  if (normalized.patchedHash !== liveHash) throw new Error("Patched Windows archive checksum mismatch.");
  const record = await writeRecord3({
    kind: "win32",
    installedApp,
    archive: normalized.archive,
    executable,
    appVersion: normalized.appVersion || sidecar.appVersion || "unknown",
    patchedInPlace: true,
    originalHash: sidecar.originalHash,
    patchedHash: liveHash,
    directoryBackup,
    previousBackup: null
  });
  await retireLegacyManagedCopy2(installedApp);
  return record;
}
async function patchIntoPlace2(installedApp, originalHash, previousRecord) {
  const parent = path6.dirname(installedApp);
  const token = `${process.pid}-${randomBytes2(4).toString("hex")}`;
  const stage = path6.join(parent, `.${path6.basename(installedApp)}.mods-stage-${token}`);
  let holding = null;
  let committed = false;
  try {
    await copyTree(installedApp, stage);
    const stagedExecutable = await findExecutable(stage);
    const stagedArchive = path6.join(stage, "resources", "app.asar");
    if (await sha256(stagedArchive) !== originalHash) throw new Error("The staged Windows archive does not match the installed app.");
    const patch = await patchArchive(stagedArchive, { managedCopy: true });
    if (patch.originalHash !== originalHash) throw new Error("The staged Windows archive does not match the backup.");
    await windowsIntegrity(stagedExecutable, stagedArchive);
    const liveArchive = path6.join(installedApp, "resources", "app.asar");
    if (await sha256(liveArchive) !== originalHash) throw new Error("T3 changed while the patch was being prepared. The installed app was left untouched.");
    holding = await commitInstalledDirectory(installedApp, stage);
    const normalized = await normalizeInstalledSidecar(liveArchive, originalHash);
    if (await sha256(liveArchive) !== normalized.patchedHash) throw new Error("Patched Windows archive checksum mismatch.");
    const record = {
      kind: "win32",
      installedApp,
      archive: path6.join(installedApp, "resources", "app.asar"),
      executable: path6.join(installedApp, path6.basename(stagedExecutable)),
      appVersion: normalized.appVersion,
      patchedInPlace: true,
      originalHash,
      patchedHash: normalized.patchedHash,
      directoryBackup: backupPath2(originalHash),
      previousBackup: ownedBackupOrNull2(previousRecord?.directoryBackup)
    };
    await writeRecord3(record);
    committed = true;
    await rm4(holding, { recursive: true, force: true }).catch((error) => {
      console.warn(`The pre-patch Windows directory was left at ${holding}: ${failureText(error)}`);
    });
    try {
      await removeOwnedWindowsBackup(previousRecord?.previousBackup, [record.directoryBackup, record.previousBackup]);
    } catch (error) {
      console.warn(`Older Windows backup was left in place: ${failureText(error)}`);
    }
    await retireLegacyManagedCopy2(installedApp);
    return record;
  } catch (error) {
    if (!committed && holding) {
      try {
        await rollbackCommit2(installedApp, holding);
      } catch (rollbackError) {
        throw new Error(`${failureText(error)} The original directory is at ${holding} and could not be restored: ${failureText(rollbackError)}`);
      }
    }
    throw error;
  } finally {
    await rm4(stage, { recursive: true, force: true });
  }
}
async function installLocked2(dir) {
  const installedApp = await resolveInstalledApp(dir);
  await restoreInterruptedInstall2(installedApp);
  await assertInstallLocation2(installedApp);
  await removeLeftoverTemps2(installedApp);
  const archive = path6.join(installedApp, "resources", "app.asar");
  if (!await exists(archive)) throw new Error("Choose the Windows T3 installation directory containing resources/app.asar.");
  const executable = await findExecutable(installedApp);
  const liveHash = await sha256(archive);
  const inspection = await inspectArchive3(archive);
  const record = await readRecord2();
  const sameApp = Boolean(record && record.installedApp === installedApp);
  const paths2 = sidecarPathsForArchive(archive);
  let sidecar = null;
  if (await exists(paths2.stateFile)) {
    try {
      sidecar = JSON.parse(await readFile5(paths2.stateFile, "utf8"));
    } catch {
      sidecar = null;
    }
  }
  let action = windowsInstallPlan({
    hasRecord: Boolean(record),
    sameApp,
    liveHash,
    recordedPatchedHash: record?.patchedHash,
    sidecarPatchedHash: sidecar?.patchedHash,
    recognized: inspection.recognized,
    markerFree: inspection.markerFree
  });
  if (action === "other-app") {
    if (await exists(record.installedApp)) throw new Error("A different Windows installation is already recorded. Uninstall it before patching another directory.");
    action = "fresh";
  }
  if (action === "refuse") throw refuseError2(inspection, Boolean(record && sameApp));
  if (action === "current") return finishCurrent2(record, archive);
  if (action === "record-missing") return finishRecordMissing(installedApp, executable, archive, sidecar, liveHash);
  await ensureBackup2(installedApp, liveHash);
  return patchIntoPlace2(installedApp, liveHash, action === "adopt" || record ? record : null);
}
async function installWindowsApp(dir, options = {}) {
  assertWindows(options);
  return withLock2(() => installLocked2(dir));
}
async function launchWindowsApp(args2 = [], options = {}) {
  assertWindows(options);
  const record = await readRecord2();
  if (!record) throw new Error("No Windows installation record found. Run install before launch.");
  const run = options.spawn ?? command;
  let current = record;
  try {
    if (await sha256(record.archive) !== record.patchedHash) {
      console.log("T3 updated. Reapplying mods to the installed app\u2026");
      current = await installWindowsApp(record.installedApp, options);
    } else if (await exists(sidecarPathsForArchive(record.archive).stateFile)) {
      await patchArchive(record.archive, { managedCopy: true, checkOnly: true });
    }
  } catch (error) {
    console.warn(`Mods could not be loaded: ${failureText(error)}
Opening the installed T3 app with mods disabled.`);
    await run(record.executable, args2, { env: { ...process.env, T3_MODS_DISABLE: "1" } });
    return { ...record, patchedInPlace: true, modsDisabled: true };
  }
  await run(current.executable, args2);
  return current;
}
async function restoreInstalledApp2(record) {
  const parent = path6.dirname(record.installedApp);
  const stage = path6.join(parent, `.${path6.basename(record.installedApp)}.mods-restore-${process.pid}-${randomBytes2(4).toString("hex")}`);
  let holding = null;
  let committed = false;
  try {
    await cp2(record.directoryBackup, stage, { recursive: true, errorOnExist: true, force: false });
    if (await sha256(path6.join(stage, "resources", "app.asar")) !== record.originalHash) throw new Error("The backup checksum no longer matches. Restore refused.");
    holding = await commitInstalledDirectory(record.installedApp, stage);
    if (await sha256(record.archive) !== record.originalHash) throw new Error("Restored Windows archive checksum mismatch.");
    await rm4(recordPath3);
    committed = true;
    await rm4(holding, { recursive: true, force: true }).catch((error) => {
      console.warn(`The patched Windows directory was left at ${holding}: ${failureText(error)}`);
    });
    try {
      await removeOwnedWindowsBackup(record.directoryBackup, []);
      await removeOwnedWindowsBackup(record.previousBackup, []);
    } catch (error) {
      console.warn(`Windows backup was left in place: ${failureText(error)}`);
    }
    return {
      archive: record.archive,
      appVersion: record.appVersion,
      executable: record.executable,
      installedApp: record.installedApp,
      patchedInPlace: true,
      restored: true
    };
  } catch (error) {
    if (!committed && holding) {
      try {
        await rollbackCommit2(record.installedApp, holding);
      } catch (rollbackError) {
        throw new Error(`${failureText(error)} The patched directory is at ${holding} and could not be restored: ${failureText(rollbackError)}`);
      }
    }
    throw error;
  } finally {
    await rm4(stage, { recursive: true, force: true });
  }
}
async function uninstallWindowsApp(options = {}) {
  assertWindows(options);
  return withLock2(async () => {
    const record = await readRecord2();
    if (!record) throw new Error("No Windows installation record found.");
    await restoreInterruptedInstall2(record.installedApp);
    const liveHash = await sha256(record.archive);
    const inspection = await inspectArchive3(record.archive);
    const backupArchive = path6.join(record.directoryBackup, "resources", "app.asar");
    const backupHash = await exists(backupArchive) ? await sha256(backupArchive) : null;
    const plan = windowsRestorePlan({
      liveHash,
      recordedPatchedHash: record.patchedHash,
      backupHash,
      recordedOriginalHash: record.originalHash,
      recognized: inspection.recognized,
      markerFree: inspection.markerFree
    });
    if (plan === "keep-update") {
      await rm4(sidecarPathsForArchive(record.archive).stateFile, { force: true });
      await rm4(sidecarPathsForArchive(record.archive).backup, { force: true });
      await rm4(recordPath3, { force: true });
      return {
        archive: record.archive,
        appVersion: inspection.version || record.appVersion,
        executable: record.executable,
        installedApp: record.installedApp,
        patchedInPlace: true,
        restored: false,
        keptUpdate: true
      };
    }
    if (plan !== "restore") {
      throw new Error(liveHash === record.patchedHash ? "The backup checksum no longer matches. Restore refused." : "The app changed after patching. Restore would overwrite an update, so it has been refused.");
    }
    return restoreInstalledApp2(record);
  });
}
async function doctorWindowsApp(options = {}) {
  assertWindows(options);
  const record = await readRecord2();
  if (!record) throw new Error("No Windows installation record found.");
  const liveHash = await exists(record.archive) ? await sha256(record.archive) : null;
  return {
    installedApp: record.installedApp,
    archive: record.archive,
    executable: record.executable,
    appVersion: record.appVersion,
    originalHash: record.originalHash,
    patchedHash: record.patchedHash,
    patched: liveHash === record.patchedHash,
    patchedInPlace: true,
    nativeChecks: "unavailable"
  };
}

// src/appimage-install.ts
import { access as access2, chmod as chmod2, copyFile as copyFile2, mkdir as mkdir5, mkdtemp as mkdtemp2, open as open4, readFile as readFile6, rename as rename5, rm as rm5, stat as stat3, writeFile as writeFile6 } from "node:fs/promises";
import { constants as constants2, createReadStream as createReadStream3, createWriteStream as createWriteStream2 } from "node:fs";
import { pipeline as pipeline2 } from "node:stream/promises";
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
import { platform as platform6, arch } from "node:os";
import path7 from "node:path";
var execute3 = promisify3(execFile3);
var recordPath4 = path7.join(dataRoot2, "appimage-install.json");
var marker4 = "/* mods-for-t3-code:v1 */";
var backups = path7.join(dataRoot2, "backups");
async function inspect(image, staging) {
  await command(image, ["--appimage-extract"], { cwd: staging, stdio: ["ignore", "ignore", "inherit"] });
  const appDir = path7.join(staging, "squashfs-root");
  const candidates = [path7.join(appDir, "resources/app.asar"), path7.join(appDir, "usr/lib/t3code/resources/app.asar")];
  let found;
  for (const candidate of candidates) if (await exists(candidate)) {
    found = candidate;
    break;
  }
  if (!found || !await exists(path7.join(appDir, "AppRun"))) throw new Error("Unsupported T3 AppImage layout. The installed app was left unchanged.");
  const pkg = JSON.parse((await readEntry(found, "package.json")).toString());
  if (!/t3[ -]?(?:code|desktop)|@t3tools\/desktop/i.test(`${pkg.name || ""} ${pkg.productName || ""}`)) throw new Error("This AppImage is not T3 Code.");
  const main = pkg.main;
  const source = (await readEntry(found, main, 12 * 1024 * 1024)).toString();
  return { appDir, archive: found, main, appVersion: pkg.version, patched: source.includes(marker4) };
}
async function squashBuilder() {
  const architecture = arch() === "x64" ? "x86_64" : arch() === "arm64" ? "aarch64" : null;
  if (!architecture) throw new Error("AppImage patching supports x64 and arm64.");
  const checksum = architecture === "x86_64" ? "b90f4a8b18967545fda78a445b27680a1642f1ef9488ced28b65398f2be7add2" : "a48972e5ae91c944c5a7c80214e7e0a42dd6aa3ae979d8756203512a74ff574d";
  const downloadUrl = `https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${architecture}.AppImage`;
  const tools = path7.join(dataRoot2, "tools");
  await mkdir5(tools, { recursive: true, mode: 448 });
  const root = path7.join(tools, `appimage-builder-${checksum.slice(0, 16)}`);
  const executable = path7.join(root, "squashfs-root/usr/lib/appimagekit/mksquashfs");
  if (await exists(executable)) return executable;
  const staging = await mkdtemp2(path7.join(tools, ".builder-"));
  try {
    const download = path7.join(staging, "builder.AppImage");
    const payload = await fetch(downloadUrl, { signal: AbortSignal.timeout(12e4) });
    if (!payload.ok || !payload.body) throw new Error(`AppImage builder download failed (${payload.status}).`);
    await pipeline2(payload.body, createWriteStream2(download, { mode: 448 }));
    if (await sha256(download) !== checksum) throw new Error("AppImage builder checksum mismatch.");
    await command(download, ["--appimage-extract"], { cwd: staging, stdio: "ignore" });
    await rename5(staging, root);
    return executable;
  } finally {
    await rm5(staging, { recursive: true, force: true });
  }
}
async function removeBackup(filename, retain = []) {
  if (!filename || retain.includes(filename)) return;
  if (path7.dirname(filename) !== backups || !/^appimage-[a-f0-9]{64}\.AppImage$/.test(path7.basename(filename))) return;
  await rm5(filename, { force: true });
}
async function installInstalledAppImage(filename) {
  if (platform6() !== "linux") throw new Error("AppImage installation requires Linux.");
  const image = path7.resolve(filename);
  const handle = await open4(image, "r");
  const prefix = Buffer.alloc(16);
  try {
    await handle.read(prefix, 0, 16, 0);
  } finally {
    await handle.close();
  }
  if (prefix.toString("hex", 0, 4) !== "7f454c46" || prefix.toString("hex", 8, 11) !== "414902") throw new Error("Choose the actual type-2 AppImage binary, not a shell launcher. For a shim, use its .AppImage.real file.");
  await mkdir5(dataRoot2, { recursive: true, mode: 448 });
  const lock = path7.join(dataRoot2, "appimage-install.lock");
  await mkdir5(lock).catch(() => {
    throw new Error("Another AppImage installation is active.");
  });
  let staging;
  let rollback;
  let swapped = false;
  let committed = false;
  try {
    const previous = await exists(recordPath4) ? JSON.parse(await readFile6(recordPath4, "utf8")) : null;
    const originalHash = await sha256(image);
    if (previous?.image === image && originalHash === previous.patchedHash) {
      await installRuntime();
      return { ...previous, alreadyPatched: true, installedApp: image, patchedInPlace: true };
    }
    await access2(path7.dirname(image), constants2.W_OK);
    staging = await mkdtemp2(path7.join(path7.dirname(image), ".t3-mods-install-"));
    const info = await inspect(image, staging);
    if (info.patched) throw new Error("The AppImage patch does not match its backup record. Restore the official app before installing again.");
    const { stdout } = await execute3(image, ["--appimage-offset"]);
    const offset = Number(stdout.trim());
    if (!Number.isSafeInteger(offset) || offset < 16 || offset >= (await stat3(image)).size) throw new Error("Invalid AppImage runtime offset.");
    const builder = await squashBuilder();
    const patch = await patchArchive(info.archive);
    await rm5(`${info.archive}.mods-for-t3-code.bak`);
    await rm5(`${info.archive}.mods-for-t3-code.json`);
    const squash = path7.join(staging, "payload.squashfs");
    await command(builder, [info.appDir, squash, "-noappend", "-comp", "xz", "-processors", "2", "-no-progress"], { stdio: "ignore" });
    const output = path7.join(staging, "patched.AppImage");
    await pipeline2(createReadStream3(image, { start: 0, end: offset - 1 }), createWriteStream2(output));
    await pipeline2(createReadStream3(squash), createWriteStream2(output, { flags: "a" }));
    await chmod2(output, (await stat3(image)).mode & 511);
    const verifyStage = await mkdtemp2(path7.join(staging, "verify-"));
    const verified = await inspect(output, verifyStage);
    if (!verified.patched || verified.appVersion !== patch.appVersion) throw new Error("Rebuilt AppImage verification failed.");
    await mkdir5(backups, { recursive: true, mode: 448 });
    const backup = path7.join(backups, `appimage-${originalHash}.AppImage`);
    if (await exists(backup)) {
      if (await sha256(backup) !== originalHash) throw new Error("Original AppImage backup checksum mismatch.");
    } else await copyFile2(image, backup, constants2.COPYFILE_EXCL);
    const record = { image, originalHash, patchedHash: await sha256(output), backup, previousBackup: previous?.backup !== backup ? previous?.backup ?? null : previous?.previousBackup ?? null, appVersion: patch.appVersion, installedAt: (/* @__PURE__ */ new Date()).toISOString() };
    if (await sha256(image) !== originalHash) throw new Error("T3 changed while the patch was being prepared. The installed app was left unchanged.");
    rollback = path7.join(staging, "original.AppImage");
    await rename5(image, rollback);
    try {
      await rename5(output, image);
      swapped = true;
    } catch (error) {
      await rename5(rollback, image);
      throw error;
    }
    await writeFile6(`${recordPath4}.tmp`, JSON.stringify(record, null, 2), { mode: 384 });
    await rename5(`${recordPath4}.tmp`, recordPath4);
    committed = true;
    await removeBackup(previous?.previousBackup, [backup, record.previousBackup]).catch((error) => console.warn(`Older AppImage backup was kept: ${failureText(error)}`));
    return { ...record, installedApp: image, patchedInPlace: true };
  } catch (error) {
    if (swapped && !committed && rollback) {
      await rm5(image, { force: true });
      await rename5(rollback, image);
    }
    throw error;
  } finally {
    if (staging) await rm5(staging, { recursive: true, force: true });
    await rm5(`${recordPath4}.tmp`, { force: true });
    await rm5(lock, { recursive: true, force: true });
  }
}
async function doctorInstalledAppImage() {
  const record = JSON.parse(await readFile6(recordPath4, "utf8"));
  const liveHash = await sha256(record.image);
  return { compatible: liveHash === record.patchedHash, patched: liveHash === record.patchedHash, installedApp: record.image, appVersion: record.appVersion, backupVerified: await sha256(record.backup) === record.originalHash };
}
async function launchInstalledAppImage(args2 = []) {
  const record = JSON.parse(await readFile6(recordPath4, "utf8"));
  try {
    await installInstalledAppImage(record.image);
  } catch (error) {
    console.warn(`Mods could not be refreshed: ${failureText(error)}
Opening the installed T3 app with mods disabled.`);
    await command(record.image, args2, { env: { ...process.env, T3_MODS_DISABLE: "1" } });
    return;
  }
  await command(record.image, args2);
}
async function uninstallInstalledAppImage() {
  const record = JSON.parse(await readFile6(recordPath4, "utf8"));
  if (await sha256(record.image) === record.patchedHash) {
    if (await sha256(record.backup) !== record.originalHash) throw new Error("Original AppImage backup checksum mismatch. Restore refused.");
    const temporary = `${record.image}.t3-mods-restore-${process.pid}`;
    await copyFile2(record.backup, temporary);
    await chmod2(temporary, (await stat3(record.image)).mode & 511);
    await rename5(temporary, record.image);
  } else {
    const staging = await mkdtemp2(path7.join(dataRoot2, ".uninstall-inspect-"));
    try {
      if ((await inspect(record.image, staging)).patched) throw new Error("AppImage changed after patching. Restore refused to avoid overwriting changes.");
    } finally {
      await rm5(staging, { recursive: true, force: true });
    }
  }
  await rm5(recordPath4);
  await removeBackup(record.backup);
  await removeBackup(record.previousBackup);
}

// bin/cli.ts
var [command2 = "help", ...args] = process.argv.slice(2);
var archiveRecord = path8.join(dataRoot2, "archive.json");
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return void 0;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}
async function nativeTarget(kind) {
  const filename = path8.join(dataRoot2, kind === "darwin" ? "mac-install.json" : "windows-install.json");
  for (const recordFile of [filename, path8.join(dataRoot2, "platform.json")]) {
    if (!await exists(recordFile)) continue;
    const record = JSON.parse(await readFile7(recordFile, "utf8"));
    const target = record.installedApp || record.original;
    if (record.kind === kind && target && await exists(target)) return target;
  }
  return detectPlatform();
}
var help = `Mods for T3 Code

  install [--appimage FILE | --asar FILE | --mac-app APP | --windows-dir DIR]
                                          Detect and patch an Electron install
  doctor  [--asar FILE]                    Check compatibility / patch checksums
  uninstall [--asar FILE]                  Restore your installed T3 app
  prepare-update                           Restore the verified original signed macOS app so T3 can use its own updater
  launch [-- Electron flags]               Open existing T3; refresh after updates
  safe-mode on|off                         Turn all mod code off for next launch
  pack MOD_DIRECTORY [--out FILE]          Bundle a JS/TS mod for sharing
  validate FILE.t3mod                      Validate a bundle without executing it

Close T3 before install, uninstall, or prepare-update. One initial relaunch loads the host.
Mod installation, creation, updates and toggles are then live.
T3_MODS_DISABLE=1 bypasses the host entirely. Mod data lives in:
${dataRoot2}
`;
try {
  if (command2 === "help" || command2 === "--help" || command2 === "-h") console.log(help);
  else if (command2 === "install") {
    let result;
    if (option("--mac-app") || platform7() === "darwin") {
      const app = option("--mac-app") || await nativeTarget("darwin");
      console.log(`
Mods for T3 Code
Patching your existing app: ${app}`);
      result = await withMacAppClosed(app, (onProgress) => installMacApp(app, { onProgress }));
    } else if (option("--windows-dir") || platform7() === "win32" && !option("--asar")) result = await installWindowsApp(option("--windows-dir") || await nativeTarget("win32"));
    else {
      const target = option("--asar") || option("--appimage") || await detectInstallation();
      result = target.endsWith(".asar") ? await patchArchive(target) : await installInstalledAppImage(target);
      if (target.endsWith(".asar")) {
        await mkdir6(dataRoot2, { recursive: true, mode: 448 });
        await writeFile7(archiveRecord, JSON.stringify({ archive: path8.resolve(target) }), { mode: 384 });
      }
    }
    console.log(`Mods for T3 Code installed for T3 ${result.appVersion}.`);
    console.log(`Patched your existing T3 app${result.installedApp ? `: ${result.installedApp}` : ""}. Reopen it using its normal icon.`);
    console.log("Use the Mods sidebar icon or Settings \u2192 Mods. Changes to mods apply live.");
  } else if (command2 === "doctor") {
    const nativeDoctor = !option("--asar") && (await exists(path8.join(dataRoot2, "mac-install.json")) ? doctorMacApp : await exists(path8.join(dataRoot2, "windows-install.json")) ? doctorWindowsApp : await exists(path8.join(dataRoot2, "appimage-install.json")) ? doctorInstalledAppImage : null);
    if (nativeDoctor) {
      console.log(JSON.stringify(await nativeDoctor(), null, 2));
      process.exit(0);
    }
    let target = option("--asar");
    if (!target && await exists(path8.join(dataRoot2, "appimage.json"))) target = JSON.parse(await readFile7(path8.join(dataRoot2, "appimage.json"), "utf8")).archive;
    if (!target && await exists(path8.join(dataRoot2, "platform.json"))) target = JSON.parse(await readFile7(path8.join(dataRoot2, "platform.json"), "utf8")).archive;
    if (!target && await exists(archiveRecord)) target = JSON.parse(await readFile7(archiveRecord, "utf8")).archive;
    target ||= await detectInstallation();
    if (!target.endsWith(".asar")) throw new Error("AppImage not patched yet. Run install; doctor can inspect an extracted --asar path.");
    const result = await patchArchive(target, { checkOnly: true, managedCopy: await exists(path8.join(dataRoot2, "platform.json")) });
    console.log(JSON.stringify({ compatible: true, patched: Boolean(result.alreadyPatched), ...result }, null, 2));
  } else if (command2 === "uninstall") {
    const archive = option("--asar");
    if (archive) await restoreArchive(archive);
    else if (await exists(path8.join(dataRoot2, "mac-install.json"))) await uninstallMacApp();
    else if (await exists(path8.join(dataRoot2, "windows-install.json"))) await uninstallWindowsApp();
    else if (await exists(path8.join(dataRoot2, "appimage-install.json"))) await uninstallInstalledAppImage();
    else if (await exists(path8.join(dataRoot2, "platform.json"))) await uninstallPlatform();
    else if (await exists(path8.join(dataRoot2, "appimage.json"))) await uninstallAppImage();
    else if (await exists(archiveRecord)) {
      await restoreArchive(JSON.parse(await readFile7(archiveRecord, "utf8")).archive);
      await rm6(archiveRecord);
    } else throw new Error("No installation record found. For a direct archive use uninstall --asar FILE.");
    console.log("Patch removed. Your installed T3 app is restored and private mod data is preserved.");
  } else if (command2 === "prepare-update") {
    const result = await prepareMacNativeUpdate();
    if (result.keptUpdate) {
      console.log(`T3 at ${result.installedApp} is already an upstream build. The older backup was not restored over it.`);
      console.log("Private mod data is unchanged. The maintenance launch command would reapply mods; open T3 with its normal icon and use T3's own updater first, then rerun install when you want mods again.");
    } else {
      console.log(`Restored the verified original signed app at ${result.installedApp}.`);
      console.log("The app path is unchanged and private mod data is preserved. Reopen T3 with its normal icon and use T3's own updater. After that update, rerun install to reapply mods.");
    }
  } else if (command2 === "launch") {
    const flags = args[0] === "--" ? args.slice(1) : args;
    if (await exists(path8.join(dataRoot2, "mac-install.json"))) await launchMacApp(flags);
    else if (await exists(path8.join(dataRoot2, "windows-install.json"))) await launchWindowsApp(flags);
    else if (await exists(path8.join(dataRoot2, "appimage-install.json"))) await launchInstalledAppImage(flags);
    else if (await exists(path8.join(dataRoot2, "platform.json"))) await launchPlatform(flags);
    else if (await exists(path8.join(dataRoot2, "appimage.json"))) await launchApp(flags);
    else if (await exists(archiveRecord)) {
      const archive = JSON.parse(await readFile7(archiveRecord, "utf8")).archive;
      const directory = path8.dirname(path8.dirname(archive));
      const names = (await readdir5(directory)).filter((name) => /^(?:t3code|t3-code|T3 Code)$/.test(name));
      if (names.length !== 1) throw new Error("Cannot identify the T3 executable beside this archive. Reopen T3 using its normal shortcut.");
      try {
        await patchArchive(archive);
      } catch (error) {
        console.warn(`Mods could not be refreshed: ${failureText(error)}
Opening T3 with mods disabled.`);
        await command(path8.join(directory, names[0]), flags, { env: { ...process.env, T3_MODS_DISABLE: "1" } });
        process.exit(0);
      }
      await command(path8.join(directory, names[0]), flags);
    } else throw new Error("Run install before launch.");
  } else if (command2 === "safe-mode") {
    const sentinel = path8.join(dataRoot2, "SAFE_MODE");
    if (args[0] === "on") {
      await mkdir6(dataRoot2, { recursive: true });
      await writeFile7(sentinel, "safe mode\n");
    } else if (args[0] === "off") {
      const { rm: rm7 } = await import("node:fs/promises");
      await rm7(sentinel, { force: true });
    } else throw new Error("Use safe-mode on or safe-mode off.");
    console.log(`Safe mode ${args[0]}. In a running app, use Pause all mods for immediate effect.`);
  } else if (command2 === "validate") {
    const bundle = validateBundle(JSON.parse(await readFile7(args[0], "utf8")));
    console.log(`${bundle.manifest.name} ${bundle.manifest.version}: valid API ${bundle.manifest.apiVersion} bundle`);
    console.log(`Permissions: ${bundle.manifest.permissions.join(", ") || "none"}`);
  } else if (command2 === "pack") {
    if (!args[0] || args[0].startsWith("--")) throw new Error("Choose a mod directory.");
    const directory = path8.resolve(args[0]);
    const config = JSON.parse(await readFile7(path8.join(directory, "mod.json"), "utf8"));
    const manifest = validateManifest(config);
    const entry2 = path8.resolve(directory, config.entry || "mod.js");
    if (!entry2.startsWith(directory + path8.sep)) throw new Error("The mod entry must be inside its directory.");
    const { build } = await import("esbuild").catch(() => {
      throw new Error("The pack command needs esbuild. Run npm ci in the downloaded package, or install this package with npm.");
    });
    const result = await build({ entryPoints: [entry2], bundle: true, platform: "browser", format: "iife", globalName: "T3Mod", target: "es2022", write: false, minify: false });
    const code = result.outputFiles[0].text + "\nglobalThis.T3Mod = T3Mod;\n";
    const bundle = validateBundle({ format: "t3mod/1", manifest, code });
    const output = path8.resolve(option("--out") || `${manifest.id}.t3mod`);
    await writeFile7(output, JSON.stringify(bundle, null, 2));
    console.log(output);
  } else throw new Error(`Unknown command: ${command2}. Use --help.`);
} catch (error) {
  console.error(`Mods for T3 Code: ${failureText(error)}`);
  process.exitCode = 1;
}
