import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { platform } from "node:os";
import path from "node:path";
import { archiveHeader, readEntry, sha256 } from "./archive.mjs";
import { command, dataRoot, exists, patchArchive, installRuntime, removeStaleOwnedCopy } from "./install.mjs";

// Patch the macOS app the user already opens. The .app path stays the same.
// A full pre-patch bundle is stored under the mods data directory, then the
// staged copy is ad-hoc signed without provisioned team entitlements.
// Ad-hoc signing can stop Squirrel from applying updates. Squirrel.framework
// and the app's updater settings are left in place; that updater path is not
// verified here. Uninstall restores the vendor-signed backup.
// Gatekeeper, the sandbox, the ASAR integrity fuse, and quarantine are not disabled.
const marker = "/* mods-for-t3-code:v1 */";
const execute = promisify(execFile);
const recordPath = path.join(dataRoot, "mac-install.json");
const backupsRoot = path.join(dataRoot, "backups");
const backupPattern = /^mac-[a-f0-9]{16}\.app$/;
const managedCopyPattern = /^managed-darwin-[a-f0-9]{16}\.app$/;
const machoMagics = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe, 0xbebafeca]);

export const requiredEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

export const updaterStatus = { updaterEnabled: true, nativeUpdaterVerified: false };

const restrictedExact = new Set([
  "com.apple.application-identifier",
  "keychain-access-groups",
  "com.apple.security.application-groups",
  "beta-reports-active",
  "aps-environment",
]);

export function isRestrictedEntitlement(key) {
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

export function entitlementKeys(xml) {
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
    if (!/^[A-Za-z0-9.-]+$/.test(key[1])) throw new Error(`Unsupported entitlement key: ${key[1]}`);
    cursor += key[0].length;
    const value = readValue(inner, cursor);
    pairs.push([key[1], value.raw.trim()]);
    cursor = value.next;
  }
  return pairs;
}

export function sanitizeEntitlements(xml) {
  const source = typeof xml === "string" && xml.includes("<dict>")
    ? xml
    : `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n</dict>\n</plist>\n`;
  const kept = [];
  const seen = new Set();
  for (const [key, raw] of topPairs(source)) {
    if (isRestrictedEntitlement(key)) continue;
    kept.push([key, raw]);
    seen.add(key);
  }
  for (const key of requiredEntitlements) {
    if (!seen.has(key)) kept.push([key, "<true/>"]);
  }
  const body = kept.map(([key, raw]) => `\t<key>${key}</key>\n\t${raw}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

export function adHocSignArguments(target, entitlementsFile) {
  return ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlementsFile, target];
}

export function parseSignatureDetails(text) {
  const cdhash = text.match(/^CDHash=([0-9a-fA-F\s]+)$/m)?.[1]?.replace(/\s+/g, "").toLowerCase() ?? null;
  const adhoc = /Signature=adhoc/i.test(text) || /flags=[^\n]*\badhoc\b/i.test(text);
  const authority = [...text.matchAll(/^Authority=(.*)$/gm)].map((match) => match[1].trim()).filter(Boolean);
  return { cdhash, adhoc, authority, label: adhoc ? "adhoc" : (authority[0] || (cdhash ? "signed" : "unknown")) };
}

export function macOpenArguments(installedApp, args = []) {
  return args.length ? [installedApp, "--args", ...args] : [installedApp];
}

export function relocatedSidecarState(state, archive) {
  const target = path.resolve(archive);
  return { ...state, archive: target, backup: `${target}.mods-for-t3-code.bak` };
}

export function macInstallPlan({ hasRecord, sameApp, liveHash, recordedPatchedHash, sidecarPatchedHash, recognized, markerFree }) {
  if (sameApp && recordedPatchedHash && liveHash === recordedPatchedHash) return "current";
  if (sidecarPatchedHash && liveHash === sidecarPatchedHash) return "record-missing";
  if (!recognized || !markerFree) return "refuse";
  if (hasRecord && sameApp) return "adopt";
  if (hasRecord && !sameApp) return "other-app";
  return "fresh";
}

export function macRestorePlan({ liveHash, recordedPatchedHash, backupHash, recordedOriginalHash, recognized, markerFree }) {
  if (liveHash === recordedPatchedHash && backupHash === recordedOriginalHash) return "restore";
  if (liveHash !== recordedPatchedHash && recognized && markerFree) return "keep-update";
  return "refuse";
}

export function resolveMacInstallTarget(requested, legacy, root = dataRoot) {
  const resolved = path.resolve(requested);
  if (!legacy?.original) return resolved;
  const base = path.basename(resolved);
  if (path.dirname(resolved) === path.resolve(root) && managedCopyPattern.test(base)) return path.resolve(legacy.original);
  return resolved;
}

function assertMac(options = {}) {
  if ((options.hostPlatform ?? platform()) !== "darwin") throw new Error("macOS installation must run on macOS.");
}

function isInside(child, parent) {
  const resolved = path.resolve(child);
  const root = path.resolve(parent);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function backupPath(originalHash) {
  return path.join(backupsRoot, `mac-${originalHash.slice(0, 16)}.app`);
}

function ownedBackupOrNull(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(backupsRoot) || !backupPattern.test(path.basename(resolved))) return null;
  return resolved;
}

function sidecarPaths(archive) {
  const target = path.resolve(archive);
  return { archive: target, backup: `${target}.mods-for-t3-code.bak`, stateFile: `${target}.mods-for-t3-code.json` };
}

async function defaultRunner(binary, args) {
  try {
    const { stdout, stderr } = await execute(binary, args, { maxBuffer: 32 * 1024 * 1024 });
    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? "");
    const detail = (stderr || stdout).trim();
    const wrapped = new Error(detail ? `${path.basename(binary)} failed: ${detail}` : error.message);
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    throw wrapped;
  }
}

function runnerFor(options) {
  return options.runner ?? defaultRunner;
}

async function defaultSpawn(binary, args, spawnOptions = {}) {
  await command(binary, args, spawnOptions);
}

function withUpdater(record) {
  return { ...record, ...updaterStatus, nativeUpdaterVerified: false, updaterEnabled: true };
}

function assertRecord(record) {
  if (!record || record.kind !== "darwin" || record.patchedInPlace !== true) throw new Error("Invalid macOS installation record.");
  const installedApp = path.resolve(record.installedApp || record.original || "");
  const archive = path.resolve(record.archive || "");
  const executable = path.resolve(record.executable || "");
  const bundleBackup = path.resolve(record.bundleBackup || "");
  if (!installedApp.endsWith(".app")) throw new Error("Invalid macOS installation record.");
  if (archive !== path.join(installedApp, "Contents", "Resources", "app.asar")) throw new Error("Invalid macOS installation record.");
  if (path.dirname(executable) !== path.join(installedApp, "Contents", "MacOS")) throw new Error("Invalid macOS installation record.");
  if (record.original && path.resolve(record.original) !== installedApp) throw new Error("Invalid macOS installation record.");
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
    signature: "adhoc",
  });
}

async function readRecord() {
  if (!await exists(recordPath)) return null;
  try { return assertRecord(JSON.parse(await readFile(recordPath, "utf8"))); }
  catch (error) {
    if (error.message === "Invalid macOS installation record.") throw error;
    throw new Error("macOS installation record is unreadable.");
  }
}

async function writeRecord(record) {
  const temporary = `${recordPath}.${process.pid}.tmp`;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(withUpdater(record), null, 2), { mode: 0o600 });
  try { await rename(temporary, recordPath); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return assertRecord(record);
}

async function withLock(work) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(dataRoot, "mac-install.lock");
  await mkdir(lock).catch(() => { throw new Error("Another macOS patch operation is active. If it crashed, remove the mac-install.lock directory in the mods data folder."); });
  try { return await work(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function isMachO(file) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead < 4) return false;
    return machoMagics.has(header.readUInt32BE(0));
  } finally { await handle.close(); }
}

async function inspectArchive(archive) {
  try {
    const pkg = JSON.parse((await readEntry(archive, "package.json")).toString());
    const identity = `${pkg.name || ""} ${pkg.productName || ""}`;
    if (!/t3[ -]?(?:code|desktop)|@t3tools\/desktop/i.test(identity)) return { recognized: false, markerFree: false };
    const main = pkg.main;
    if (typeof main !== "string" || !main || /(^|[/\\])\.\.([/\\]|$)/.test(main)) return { recognized: false, markerFree: false };
    const source = (await readEntry(archive, main, 12 * 1024 * 1024)).toString();
    return { recognized: true, markerFree: !source.includes(marker), version: pkg.version || "unknown", main };
  } catch { return { recognized: false, markerFree: false }; }
}

async function legacyDarwin() {
  const filename = path.join(dataRoot, "platform.json");
  if (!await exists(filename)) return null;
  try {
    const record = JSON.parse(await readFile(filename, "utf8"));
    if (record.kind !== "darwin" || typeof record.original !== "string" || !record.original) return null;
    return record;
  } catch { return null; }
}

async function assertInstallLocation(installedApp) {
  let info;
  try { info = await lstat(installedApp); }
  catch { throw new Error(`T3 app not found at ${installedApp}.`); }
  if (info.isSymbolicLink()) throw new Error("Refusing to patch a symlinked macOS app.");
  if (!info.isDirectory()) throw new Error("Choose the T3 .app bundle.");
  if (path.basename(installedApp).includes(".mods-stage-") || path.basename(path.dirname(installedApp)).includes(".mods-")) {
    throw new Error("Choose the installed T3 app, not a temporary staging copy.");
  }
  const real = await realpath(installedApp);
  if (isInside(installedApp, dataRoot) || isInside(real, dataRoot)) throw new Error("Refusing to patch the mods data directory.");
}

async function signatureDetails(target, options) {
  const run = runnerFor(options);
  let text = "";
  try {
    const result = await run("/usr/bin/codesign", ["-dv", "--verbose=4", target]);
    text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch (error) {
    text = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
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
  await mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  const destination = backupPath(originalHash);
  const archived = path.join(destination, "Contents", "Resources", "app.asar");
  if (await exists(destination)) {
    if (await sha256(archived) !== originalHash) throw new Error(`Backup already exists at ${destination}. It will not be overwritten.`);
    const signed = await signatureDetails(destination, options);
    const source = await signatureDetails(installedApp, options);
    if (signed.cdhash !== source.cdhash) throw new Error("The saved backup signature does not match the installed app.");
    return { bundleBackup: destination, vendorCdHash: signed.cdhash, vendorSignature: signed.authority[0] || signed.label };
  }
  const temporary = path.join(backupsRoot, `.mac-${originalHash.slice(0, 16)}-${process.pid}-${randomBytes(3).toString("hex")}.app`);
  try {
    await dittoBundle(installedApp, temporary, options);
    if (await sha256(path.join(temporary, "Contents", "Resources", "app.asar")) !== originalHash) throw new Error("The macOS backup does not match the installed archive.");
    const source = await signatureDetails(installedApp, options);
    const copied = await signatureDetails(temporary, options);
    if (!source.cdhash || source.cdhash !== copied.cdhash) throw new Error("The macOS backup signature does not match the installed app.");
    await verifySignature(temporary, options);
    await rename(temporary, destination);
    return { bundleBackup: destination, vendorCdHash: copied.cdhash, vendorSignature: source.authority[0] || source.label };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function commitInstalledBundle(target, replacement) {
  const parent = path.dirname(path.resolve(target));
  if (path.dirname(path.resolve(replacement)) !== parent) throw new Error("The staged macOS app must stay in the same directory as the installed app.");
  const holding = path.join(parent, `.${path.basename(target)}.mods-hold-${process.pid}-${randomBytes(4).toString("hex")}`);
  await rename(target, holding);
  try { await rename(replacement, target); }
  catch (error) {
    try { await rename(holding, target); }
    catch (rollbackError) { throw new Error(`${error.message} The original app is at ${holding} and could not be moved back: ${rollbackError.message}`); }
    await rm(holding, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return holding;
}

async function rollbackCommit(target, holding) {
  const parent = path.dirname(target);
  const failed = path.join(parent, `.${path.basename(target)}.mods-failed-${process.pid}-${randomBytes(3).toString("hex")}`);
  if (await exists(target)) await rename(target, failed);
  try { await rename(holding, target); }
  finally { await rm(failed, { recursive: true, force: true }); }
}

async function executableName(plist, options) {
  const { stdout } = await runnerFor(options)("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]);
  const name = String(stdout ?? "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new Error("Unsupported CFBundleExecutable.");
  return name;
}

async function applyAsarIntegrity(plist, archive, options) {
  const { headerString } = await archiveHeader(archive);
  const digest = createHash("sha256").update(headerString).digest("hex");
  const run = runnerFor(options);
  const buddy = "/usr/libexec/PlistBuddy";
  try { await run(buddy, ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${digest}`, plist]); }
  catch {
    try { await run(buddy, ["-c", "Add :ElectronAsarIntegrity dict", plist]); } catch { /* created below if still absent */ }
    try { await run(buddy, ["-c", "Add :ElectronAsarIntegrity:Resources/app.asar dict", plist]); } catch { /* nested dict may already exist */ }
    try { await run(buddy, ["-c", "Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256", plist]); } catch { /* algorithm may already exist */ }
    await run(buddy, ["-c", `Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${digest}`, plist]);
  }
}

async function clearSigningDetritus(app, options) {
  // codesign rejects Finder info and resource forks. Quarantine stays so Gatekeeper is unchanged.
  const run = runnerFor(options);
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork"]) {
    try { await run("/usr/bin/xattr", ["-dr", attribute, app]); }
    catch { /* the attribute or xattr tool may be absent */ }
  }
}

async function signAdHoc(app, entitlementsXml, options) {
  const sanitized = sanitizeEntitlements(entitlementsXml);
  const keys = entitlementKeys(sanitized);
  if (keys.some((key) => isRestrictedEntitlement(key))) throw new Error("Restricted entitlements were still present after sanitizing.");
  for (const key of requiredEntitlements) if (!keys.includes(key)) throw new Error(`Sanitized entitlements are missing ${key}.`);
  const entitlementsFile = path.join(dataRoot, `.entitlements-${process.pid}-${randomBytes(4).toString("hex")}.plist`);
  await writeFile(entitlementsFile, sanitized, { mode: 0o600 });
  try {
    const targets = [];
    async function visit(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          if (full !== app && /\.(app|framework|xpc|appex)$/i.test(entry.name)) targets.push(full);
        } else if (entry.isFile() && await isMachO(full)) targets.push(full);
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
  } finally { await rm(entitlementsFile, { force: true }); }
}

async function normalizeStagedSidecar(stagedArchive, finalArchive, originalHash) {
  const staged = sidecarPaths(stagedArchive);
  const state = JSON.parse(await readFile(staged.stateFile, "utf8"));
  if (await sha256(staged.backup) !== originalHash) throw new Error("The staged backup does not match the original archive.");
  const normalized = relocatedSidecarState(state, finalArchive);
  const temporary = `${staged.stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  try { await rename(temporary, staged.stateFile); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return normalized;
}

async function retireLegacyManagedCopy(installedApp) {
  const legacy = await legacyDarwin();
  if (!legacy || path.resolve(legacy.original) !== path.resolve(installedApp)) return false;
  let pending = false;
  for (const candidate of [legacy.previousCopy, legacy.copy]) {
    if (!candidate) continue;
    try {
      const removed = await removeStaleOwnedCopy(candidate, { root: dataRoot, retain: [installedApp], pattern: managedCopyPattern });
      if (!removed && await exists(candidate)) pending = true;
    } catch (error) {
      pending = true;
      console.warn(`Older managed copy was left in place: ${error.message}`);
    }
  }
  if (!pending) await rm(path.join(dataRoot, "platform.json"), { force: true });
  return !pending;
}

async function removeOwnedBackup(candidate, retain = []) {
  try { await removeStaleOwnedCopy(candidate, { root: backupsRoot, retain, pattern: backupPattern }); }
  catch (error) { console.warn(`Older macOS backup was left in place: ${error.message}`); }
}

async function restoreInterruptedInstall(installedApp) {
  if (await exists(installedApp)) return;
  const parent = path.dirname(installedApp);
  const prefix = `.${path.basename(installedApp)}.mods-hold-`;
  let names = [];
  try { names = (await readdir(parent)).filter((name) => name.startsWith(prefix)); }
  catch { return; }
  if (names.length !== 1) {
    throw new Error(names.length
      ? `The macOS app is missing. The original was left at ${path.join(parent, names[0])}.`
      : `T3 app not found at ${installedApp}.`);
  }
  await rename(path.join(parent, names[0]), installedApp);
}

async function removeLeftoverTemps(installedApp) {
  const parent = path.dirname(installedApp);
  const prefix = `.${path.basename(installedApp)}.mods-`;
  let names = [];
  try { names = await readdir(parent); }
  catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (name.includes(".mods-stage-") || name.includes(".mods-failed-") || name.includes(".mods-restore-")) {
      await rm(path.join(parent, name), { recursive: true, force: true });
    }
  }
}

function refuseError(inspection, hasRecord) {
  if (hasRecord) return new Error("T3 changed since this patch. Restore/reinstall the official app, then patch the new version. Your backup has been kept.");
  if (inspection.recognized && !inspection.markerFree) return new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
  return new Error("Choose the T3 .app bundle containing Contents/Resources/app.asar.");
}

async function finishCurrent(record) {
  const paths = sidecarPaths(record.archive);
  if (await exists(paths.stateFile)) await patchArchive(record.archive, { managedCopy: true, checkOnly: true });
  await installRuntime();
  await retireLegacyManagedCopy(record.installedApp);
  return withUpdater({ ...record, alreadyPatched: true, adoptedUpdate: false });
}

async function patchIntoPlace(installedApp, originalHash, previousRecord, options) {
  const parent = path.dirname(installedApp);
  const token = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const stage = path.join(parent, `.${path.basename(installedApp)}.mods-stage-${token}`);
  const finalArchive = path.join(installedApp, "Contents", "Resources", "app.asar");
  let holding = null;
  let committed = false;
  options.onProgress?.("Backing up the original T3 app");
  const saved = await ensureBackup(installedApp, originalHash, options);
  try {
    options.onProgress?.("Preparing the app patch");
    await dittoBundle(installedApp, stage, options);
    const stagedArchive = path.join(stage, "Contents", "Resources", "app.asar");
    if (await sha256(stagedArchive) !== originalHash) throw new Error("The staged macOS archive does not match the installed app.");
    const listed = await runnerFor(options)("/usr/bin/codesign", ["-d", "--entitlements", ":-", stage]);
    const entitlementsXml = `${listed.stdout ?? ""}\n${listed.stderr ?? ""}`;
    options.onProgress?.("Patching the Mods host into T3");
    const patch = await patchArchive(stagedArchive, { managedCopy: true });
    if (patch.originalHash !== originalHash) throw new Error("The staged macOS archive does not match the backup.");
    const normalized = await normalizeStagedSidecar(stagedArchive, finalArchive, originalHash);
    await applyAsarIntegrity(path.join(stage, "Contents", "Info.plist"), stagedArchive, options);
    await rm(path.join(stage, "Contents", "embedded.provisionprofile"), { force: true });
    const executable = path.join(installedApp, "Contents", "MacOS", await executableName(path.join(stage, "Contents", "Info.plist"), options));
    if (!await exists(path.join(stage, "Contents", "MacOS", path.basename(executable)))) throw new Error("The macOS T3 executable could not be identified.");
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
      alreadyPatched: false,
    });
    await writeRecord(record);
    committed = true;
    await rm(holding, { recursive: true, force: true }).catch((error) => {
      console.warn(`The pre-patch macOS app was left at ${holding}: ${error.message}`);
    });
    await removeOwnedBackup(previousRecord?.previousBackup, [record.bundleBackup, record.previousBackup]);
    const migrated = await retireLegacyManagedCopy(installedApp);
    return { ...record, migrated };
  } catch (error) {
    if (!committed && holding) {
      try { await rollbackCommit(installedApp, holding); }
      catch (rollbackError) { throw new Error(`${error.message} The original app is at ${holding} and could not be restored: ${rollbackError.message}`); }
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function installLocked(appPath, options) {
  const legacy = await legacyDarwin();
  const installedApp = resolveMacInstallTarget(appPath, legacy);
  if (!installedApp.endsWith(".app")) throw new Error("Choose the T3 .app bundle.");
  await restoreInterruptedInstall(installedApp);
  await assertInstallLocation(installedApp);
  await removeLeftoverTemps(installedApp);
  const archive = path.join(installedApp, "Contents", "Resources", "app.asar");
  if (!await exists(archive)) throw new Error("Choose the T3 .app bundle containing Contents/Resources/app.asar.");
  const liveHash = await sha256(archive);
  const inspection = await inspectArchive(archive);
  const record = await readRecord();
  const sameApp = Boolean(record && record.installedApp === installedApp);
  const paths = sidecarPaths(archive);
  let sidecar = null;
  if (await exists(paths.stateFile)) {
    try { sidecar = JSON.parse(await readFile(paths.stateFile, "utf8")); }
    catch { sidecar = null; }
  }
  let action = macInstallPlan({
    hasRecord: Boolean(record),
    sameApp,
    liveHash,
    recordedPatchedHash: record?.patchedHash,
    sidecarPatchedHash: sidecar?.patchedHash,
    recognized: inspection.recognized,
    markerFree: inspection.markerFree,
  });
  if (action === "other-app") {
    if (await exists(record.installedApp)) throw new Error("A different macOS app is already recorded. Uninstall it before patching another app.");
    action = "fresh";
  }
  if (action === "refuse") throw refuseError(inspection, Boolean(record && sameApp));
  if (action === "current") { options.onProgress?.("Updating the Mods host in the existing app"); return finishCurrent(record); }
  if (action === "record-missing") {
    if (!sidecar?.originalHash || path.resolve(sidecar.archive || "") !== archive) {
      throw new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
    }
    const bundleBackup = backupPath(sidecar.originalHash);
    const backupArchive = path.join(bundleBackup, "Contents", "Resources", "app.asar");
    if (!await exists(backupArchive) || await sha256(backupArchive) !== sidecar.originalHash) {
      throw new Error("The archive is patched but its original backup is missing. Restore the original app before patching again.");
    }
    const executable = path.join(installedApp, "Contents", "MacOS", await executableName(path.join(installedApp, "Contents", "Info.plist"), options));
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
      vendorSignature: sidecar.vendorSignature,
    });
    await retireLegacyManagedCopy(installedApp);
    return withUpdater({ ...restored, alreadyPatched: true, adoptedUpdate: false });
  }
  return patchIntoPlace(installedApp, liveHash, action === "adopt" ? record : null, options);
}

export async function installMacApp(appPath, options = {}) {
  assertMac(options);
  if (typeof appPath !== "string" || !appPath.trim()) throw new Error("Choose the T3 .app bundle.");
  return withLock(() => installLocked(appPath, options));
}

export async function launchMacApp(args = [], options = {}) {
  assertMac(options);
  const spawn = options.spawn ?? defaultSpawn;
  const record = await readRecord();
  if (!record) throw new Error("No macOS installation record found. Run install before launch.");
  let current = record;
  let reapplied = false;
  try {
    if (!await exists(record.archive) || await sha256(record.archive) !== record.patchedHash) {
      console.log("T3 updated. Reapplying mods to the installed app…");
      current = await installMacApp(record.installedApp, options);
      reapplied = true;
    } else if (await exists(sidecarPaths(record.archive).stateFile)) {
      await patchArchive(record.archive, { managedCopy: true, checkOnly: true });
    }
  } catch (error) {
    console.warn(`Mods could not be loaded: ${error.message}\nOpening the installed T3 app with mods disabled.`);
    await spawn(record.executable, args, { env: { ...process.env, T3_MODS_DISABLE: "1" } });
    return withUpdater({ ...record, modsDisabled: true, reapplied: false });
  }
  try { await spawn("/usr/bin/open", macOpenArguments(current.installedApp, args)); }
  catch (error) {
    console.warn(`Could not open ${current.installedApp}: ${error.message}`);
    await spawn(current.executable, args);
  }
  return withUpdater({ ...current, reapplied });
}

async function restoreInstalledApp(record, options) {
  const parent = path.dirname(record.installedApp);
  const stage = path.join(parent, `.${path.basename(record.installedApp)}.mods-restore-${process.pid}-${randomBytes(4).toString("hex")}`);
  let holding = null;
  let committed = false;
  try {
    await dittoBundle(record.bundleBackup, stage, options);
    if (await sha256(path.join(stage, "Contents", "Resources", "app.asar")) !== record.originalHash) throw new Error("The backup checksum no longer matches. Restore refused.");
    const backupSignature = await signatureDetails(stage, options);
    if (record.vendorCdHash && backupSignature.cdhash !== record.vendorCdHash) throw new Error("The backup signature does not match the saved vendor app. Restore refused.");
    holding = await commitInstalledBundle(record.installedApp, stage);
    if (await sha256(record.archive) !== record.originalHash) throw new Error("Restored macOS archive checksum mismatch.");
    await verifySignature(record.installedApp, options);
    await rm(recordPath);
    committed = true;
    await rm(holding, { recursive: true, force: true }).catch((error) => {
      console.warn(`The patched macOS app was left at ${holding}: ${error.message}`);
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
      restored: true,
    });
  } catch (error) {
    if (!committed && holding) {
      try { await rollbackCommit(record.installedApp, holding); }
      catch (rollbackError) { throw new Error(`${error.message} The patched app is at ${holding} and could not be restored: ${rollbackError.message}`); }
    }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function uninstallMacApp(options = {}) {
  assertMac(options);
  return withLock(async () => {
    const record = await readRecord();
    if (!record) throw new Error("No macOS installation record found.");
    await restoreInterruptedInstall(record.installedApp);
    const liveHash = await sha256(record.archive);
    const inspection = await inspectArchive(record.archive);
    const backupArchive = path.join(record.bundleBackup, "Contents", "Resources", "app.asar");
    const backupHash = await exists(backupArchive) ? await sha256(backupArchive) : null;
    const plan = macRestorePlan({
      liveHash,
      recordedPatchedHash: record.patchedHash,
      backupHash,
      recordedOriginalHash: record.originalHash,
      recognized: inspection.recognized,
      markerFree: inspection.markerFree,
    });
    if (plan === "keep-update") {
      await rm(sidecarPaths(record.archive).stateFile, { force: true });
      await rm(sidecarPaths(record.archive).backup, { force: true });
      await rm(recordPath, { force: true });
      return withUpdater({
        installedApp: record.installedApp,
        original: record.installedApp,
        archive: record.archive,
        executable: record.executable,
        appVersion: inspection.version || record.appVersion,
        patchedInPlace: true,
        signature: record.signature,
        restored: false,
        keptUpdate: true,
      });
    }
    if (plan !== "restore") {
      throw new Error(liveHash === record.patchedHash
        ? "The backup checksum no longer matches. Restore refused."
        : "The app changed after patching. Restore would overwrite an update, so it has been refused.");
    }
    return restoreInstalledApp(record, options);
  });
}

export async function doctorMacApp(options = {}) {
  assertMac(options);
  const record = await readRecord();
  if (!record) throw new Error("No macOS installation record found.");
  const liveHash = await exists(record.archive) ? await sha256(record.archive) : null;
  let signature = record.signature;
  try {
    if (await exists(record.installedApp)) signature = (await signatureDetails(record.installedApp, options)).label;
  } catch { signature = record.signature; }
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
    ...updaterStatus,
  };
}
