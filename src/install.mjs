import { access, copyFile, mkdir, readFile, writeFile, rename, rm, stat, mkdtemp, readdir, chmod, realpath } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { homedir, tmpdir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { archiveHeader, readEntry, replaceEntry, sha256 } from "./archive.mjs";
import paths from "./paths.cjs";

export const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dataRoot = paths.dataRoot;
const marker = "/* mods-for-t3-code:v1 */";
const appImageCopyName = /^app(?:-[a-f0-9]{16})?$/;

export function ownedInstallCopy(candidate, root, pattern) {
  if (!candidate || typeof candidate !== "string") return null;
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(root) || !pattern.test(path.basename(resolved))) return null;
  return resolved;
}

// Only an older copy this installer recorded is removed, and only when its real
// path stays inside the data directory. Current and previous copies are retained.
export async function removeStaleOwnedCopy(candidate, { root, retain = [], pattern }) {
  const resolved = ownedInstallCopy(candidate, root, pattern);
  if (!resolved || retain.some((item) => item && path.resolve(item) === resolved)) return false;
  let location = resolved;
  let rootLocation = path.resolve(root);
  try { location = await realpath(resolved); rootLocation = await realpath(root); } catch { return false; }
  if (location !== rootLocation && !location.startsWith(`${rootLocation}${path.sep}`)) return false;
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
  } catch { return null; }
}

export async function exists(filename) { try { await access(filename); return true; } catch { return false; } }
export async function command(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(binary)} failed (${signal || code}).`)));
  });
}

async function installRuntime() {
  const target = path.join(dataRoot, "runtime");
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const file of ["bootstrap.cjs", "telemetry-preload.cjs", "renderer.js", "paths.cjs", "examples.json"]) {
    const source = path.join(packageRoot, "dist", file);
    if (!(await exists(source))) throw new Error("Runtime bundle missing. Run npm run build in a development checkout.");
    const temporary = path.join(target, `${file}.tmp-${process.pid}`);
    if (file === "paths.cjs") await writeFile(temporary, `exports.dataRoot = ${JSON.stringify(dataRoot)};\n`, { mode: 0o600 });
    else await copyFile(source, temporary);
    await rename(temporary, path.join(target, file));
  }
  await mkdir(path.join(dataRoot, "inbox"), { recursive: true, mode: 0o700 });
  return target;
}

export async function patchArchive(filename, { checkOnly = false, managedCopy = false } = {}) {
  const archive = path.resolve(filename);
  if (!managedCopy && archive.includes(`${path.sep}Contents${path.sep}Resources${path.sep}`)) throw new Error("Use --mac-app for a managed, locally signed copy. Direct patching of the original signed macOS bundle is refused.");
  const stateFile = `${archive}.mods-for-t3-code.json`;
  const backup = `${archive}.mods-for-t3-code.bak`;
  let adoptUpstream = false;
  if (await exists(stateFile)) {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (await sha256(archive) === state.patchedHash) {
      if (checkOnly) return { ...state, archive, alreadyPatched: true };
      await installRuntime(); return { ...state, archive, alreadyPatched: true };
    }
    // A replaced official archive has no marker. A mismatched modded archive is left untouched.
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
  await mkdir(lock).catch(() => { throw new Error("Another patch operation is active. If it crashed, remove the .lock directory beside the archive."); });
  const temp = `${archive}.mods-tmp-${process.pid}`;
  let swapped = false;
  let backupCreated = false;
  try {
    if (adoptUpstream) { await rm(backup, { force: true }); await rm(stateFile, { force: true }); }
    if (await exists(backup)) throw new Error(`Backup already exists: ${backup}. It will not be overwritten.`);
    const runtime = await installRuntime();
    const bootstrap = path.join(runtime, "bootstrap.cjs");
    const requireCode = `try { if (!process.env.T3_MODS_DISABLE) require(${JSON.stringify(bootstrap)}); } catch (error) { console.error('[Mods for T3 Code]', error.message); }`;
    const prefix = pkg.type === "module" && !main.endsWith(".cjs") || main.endsWith(".mjs")
      ? `${marker}\nimport { createRequire as __modsForT3CreateRequire } from 'node:module';\ntry { if (!process.env.T3_MODS_DISABLE) __modsForT3CreateRequire(import.meta.url)(${JSON.stringify(bootstrap)}); } catch (error) { console.error('[Mods for T3 Code]', error.message); }\n`
      : `${marker}\n${requireCode}\n`;
    const content = Buffer.from(original.startsWith("#!") ? original.replace(/^(#![^\n]*\n)/, `$1${prefix}`) : prefix + original);
    const originalHash = await sha256(archive);
    await copyFile(archive, backup, constants.COPYFILE_EXCL);
    backupCreated = true;
    await replaceEntry(archive, temp, main, content);
    // Read the replacement back before replacing the app's archive.
    if (!(await readEntry(temp, main, 13 * 1024 * 1024)).equals(content)) throw new Error("Archive patch verification failed.");
    const state = { ...result, originalHash, patchedHash: await sha256(temp), installedAt: new Date().toISOString() };
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temp, archive); swapped = true;
    await rename(`${stateFile}.tmp`, stateFile);
    return state;
  } catch (error) {
    if (swapped) await copyFile(backup, archive);
    if (backupCreated && !swapped) await rm(backup, { force: true });
    throw error;
  } finally {
    await rm(temp, { force: true }); await rm(`${stateFile}.tmp`, { force: true }); await rm(lock, { recursive: true, force: true });
  }
}

export async function restoreArchive(filename) {
  const archive = path.resolve(filename);
  const stateFile = `${archive}.mods-for-t3-code.json`;
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const backup = `${archive}.mods-for-t3-code.bak`;
  if (await sha256(archive) !== state.patchedHash) {
    const upstream = await inspectArchive(archive);
    if (!upstream?.markerFree) throw new Error("The app changed after patching. Restore would overwrite an update, so it has been refused.");
    await rm(backup, { force: true }); await rm(stateFile, { force: true });
    return archive;
  }
  if (await sha256(backup) !== state.originalHash) throw new Error("The backup checksum no longer matches. Restore refused.");
  const temp = `${archive}.restore-${process.pid}`;
  await copyFile(backup, temp); await rename(temp, archive);
  await rm(stateFile); await rm(backup);
  return archive;
}

async function findAsar(directory, depth = 0) {
  if (depth > 4) return null;
  const direct = path.join(directory, "resources", "app.asar");
  if (await exists(direct)) return direct;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = await findAsar(path.join(directory, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

export async function installAppImage(filename) {
  if (platform() !== "linux") throw new Error("AppImage installation requires Linux.");
  const image = path.resolve(filename);
  const file = await readPrefix(image);
  if (file.toString("hex", 0, 4) !== "7f454c46" || !["414901", "414902"].includes(file.toString("hex", 8, 11))) throw new Error("Choose the actual AppImage binary, not a shell launcher. If yours is a shim, use the .AppImage.real file.");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const imageHash = await sha256(image);
  const metadataFile = path.join(dataRoot, "appimage.json");
  let previous;
  if (await exists(metadataFile)) {
    previous = JSON.parse(await readFile(metadataFile, "utf8"));
    if (previous.imageHash === imageHash && await exists(previous.archive)) { await patchArchive(previous.archive); return previous; }
  }
  const staging = await mkdtemp(path.join(dataRoot, ".extract-"));
  const destination = path.join(dataRoot, `app-${imageHash.slice(0, 16)}`);
  try {
    await command(image, ["--appimage-extract"], { cwd: staging, stdio: "ignore" });
    const extracted = path.join(staging, "squashfs-root");
    const archive = await findAsar(extracted);
    if (!archive || !(await exists(path.join(extracted, "AppRun")))) throw new Error("This AppImage does not contain the supported T3 Electron layout.");
    await patchArchive(archive, { checkOnly: true });
    if (await exists(destination)) throw new Error(`App copy already exists at ${destination}; it has not been overwritten.`);
    await rename(extracted, destination);
    const installedArchive = path.join(destination, path.relative(extracted, archive));
    try {
      const patch = await patchArchive(installedArchive);
      const previousApp = previous?.launcher ? path.dirname(previous.launcher) : null;
      const metadata = { image, imageHash, archive: installedArchive, launcher: path.join(destination, "AppRun"), appVersion: patch.appVersion, previousApp };
      await writeFile(`${metadataFile}.tmp`, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      await rename(`${metadataFile}.tmp`, metadataFile);
      try { await removeStaleOwnedCopy(previous?.previousApp, { root: dataRoot, retain: [destination, previousApp], pattern: appImageCopyName }); }
      catch (error) { console.warn(`Older AppImage copy was left in place: ${error.message}`); }
      return metadata;
    } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function readPrefix(filename) {
  const chunks = [];
  for await (const chunk of createReadStream(filename, { start: 0, end: 15 })) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function detectInstallation() {
  const root = homedir();
  const candidates = platform() === "linux" ? [
    path.join(root, "Applications", "T3-Code.AppImage.real"), path.join(root, "Applications", "T3-Code.AppImage"),
    "/opt/T3 Code/resources/app.asar", "/opt/t3-code/resources/app.asar", "/opt/t3code/resources/app.asar",
  ] : platform() === "win32" ? [path.join(process.env.LOCALAPPDATA || root, "Programs", "T3 Code", "resources", "app.asar")] : [];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("T3 was not found automatically. Pass --appimage /path/to/T3-Code.AppImage or --asar /path/to/resources/app.asar; use --mac-app or --windows-dir for native installations.");
}

export async function launchApp(args = []) {
  let metadata = JSON.parse(await readFile(path.join(dataRoot, "appimage.json"), "utf8"));
  try {
    if (await sha256(metadata.image) !== metadata.imageHash) {
      console.log("T3 was updated. Preparing the mod host for the new version…");
      metadata = await installAppImage(metadata.image);
    }
    await patchArchive(metadata.archive, { checkOnly: true });
  } catch (error) {
    console.warn(`Mods could not be loaded: ${error.message}\nOpening the updated, original T3 app instead. Your mods are kept.`);
    await command(metadata.image, args); return;
  }
  // Keep Chromium's sandbox enabled. Users may pass the flags their system needs.
  await command(metadata.launcher, args, { env: { ...process.env, APPDIR: path.dirname(metadata.launcher), APPIMAGE: metadata.image } });
}

export async function uninstallAppImage() {
  const filename = path.join(dataRoot, "appimage.json");
  const metadata = JSON.parse(await readFile(filename, "utf8"));
  const copy = path.dirname(metadata.launcher);
  if (path.dirname(copy) !== dataRoot || !/^app(?:-[a-f0-9]{16})?$/.test(path.basename(copy))) throw new Error("Invalid installation record.");
  await rm(copy, { recursive: true });
  if (metadata.previousApp && path.dirname(metadata.previousApp) === dataRoot && /^app(?:-[a-f0-9]{16})?$/.test(path.basename(metadata.previousApp))) await rm(metadata.previousApp, { recursive: true, force: true });
  await rm(filename);
}
