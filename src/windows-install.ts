import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { platform } from "node:os";
import path from "node:path";
import { readEntry, sha256 } from "./archive.ts";
import { command, dataRoot, exists, patchArchive, removeStaleOwnedCopy } from "./install.ts";
import { windowsIntegrity } from "./platform.ts";
import { failureText } from "./failure.ts";
import { type SpawnOptions } from "node:child_process";

export interface WindowsInstallOptions {
  hostPlatform?: NodeJS.Platform;
  spawn?: (binary: string, args: readonly string[], spawnOptions?: SpawnOptions) => Promise<void>;
}

export interface SidecarPaths {
  archive: string;
  backup: string;
  stateFile: string;
}

export interface SidecarState {
  archive?: string;
  backup?: string;
  originalHash?: string;
  patchedHash?: string;
  appVersion?: string;
}

export type NativeInstallAction = "current" | "record-missing" | "refuse" | "adopt" | "other-app" | "fresh";
export type NativeRestoreAction = "restore" | "keep-update" | "refuse";

export interface InstallPlanInput {
  hasRecord: boolean;
  sameApp: boolean;
  liveHash: string;
  recordedPatchedHash?: string;
  sidecarPatchedHash?: string;
  recognized: boolean;
  markerFree: boolean;
}

export interface RestorePlanInput {
  liveHash: string;
  recordedPatchedHash: string;
  backupHash: string | null;
  recordedOriginalHash: string;
  recognized: boolean;
  markerFree: boolean;
}

interface ArchiveInspection {
  recognized: boolean;
  markerFree: boolean;
  version?: string;
  main?: string;
}

export interface WindowsInstallRecord {
  kind: string;
  installedApp: string;
  archive: string;
  executable: string;
  appVersion?: string;
  patchedInPlace: boolean;
  originalHash: string;
  patchedHash: string;
  directoryBackup: string;
  previousBackup: string | null;
}


// Patch the Windows app the user already installed. The executable path stays the
// same, so the normal shortcut and Windows auto-updater keep that directory.
// A full pre-patch copy is stored under the mods data directory before the swap.
// Fuses, the sandbox, services, and registry settings are not changed.
const marker = "/* mods-for-t3-code:v1 */";
const recordPath = path.join(dataRoot, "windows-install.json");
const backupsRoot = path.join(dataRoot, "backups");
const backupPattern = /^win-[a-f0-9]{16}$/;
const executablePattern = /^(?:T3[ -]?Code|t3code)\.exe$/i;
const managedCopyPattern = /^managed-win32-[a-f0-9]{16}$/;

export function sidecarPathsForArchive(archive: string): SidecarPaths {
  const target = path.resolve(archive);
  return { archive: target, backup: `${target}.mods-for-t3-code.bak`, stateFile: `${target}.mods-for-t3-code.json` };
}

// patchArchive records the staged directory. After that directory becomes the
// installed app, the sidecar has to name the installed archive and its backup.
export function relocatedSidecarState<State extends SidecarState>(state: State, archive: string): State & { archive: string; backup: string } {
  const paths = sidecarPathsForArchive(archive);
  return { ...state, archive: paths.archive, backup: paths.backup };
}

export function windowsInstallPlan({ hasRecord, sameApp, liveHash, recordedPatchedHash, sidecarPatchedHash, recognized, markerFree }: InstallPlanInput): NativeInstallAction {
  if (sameApp && recordedPatchedHash && liveHash === recordedPatchedHash) return "current";
  if (sidecarPatchedHash && liveHash === sidecarPatchedHash) return "record-missing";
  if (!recognized || !markerFree) return "refuse";
  if (hasRecord && sameApp) return "adopt";
  if (hasRecord && !sameApp) return "other-app";
  return "fresh";
}

export function windowsRestorePlan({ liveHash, recordedPatchedHash, backupHash, recordedOriginalHash, recognized, markerFree }: RestorePlanInput): NativeRestoreAction {
  if (liveHash === recordedPatchedHash && backupHash === recordedOriginalHash) return "restore";
  if (liveHash !== recordedPatchedHash && recognized && markerFree) return "keep-update";
  return "refuse";
}

function assertWindows(options: WindowsInstallOptions = {}): void {
  if ((options.hostPlatform ?? platform()) !== "win32") throw new Error("Windows installation must run on Windows.");
}

function isInside(child: string, parent: string): boolean {
  const resolved = path.resolve(child);
  const root = path.resolve(parent);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function backupPath(originalHash: string): string {
  return path.join(backupsRoot, `win-${originalHash.slice(0, 16)}`);
}

function ownedBackupOrNull(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(backupsRoot) || !backupPattern.test(path.basename(resolved))) return null;
  return resolved;
}

export async function removeOwnedWindowsBackup(candidate: unknown, retain: readonly (string | null | undefined)[] = []): Promise<boolean> {
  return removeStaleOwnedCopy(candidate, { root: backupsRoot, retain, pattern: backupPattern });
}

function assertRecord(record: WindowsInstallRecord): WindowsInstallRecord {
  if (!record || record.kind !== "win32" || record.patchedInPlace !== true) throw new Error("Invalid Windows installation record.");
  const installedApp = path.resolve(record.installedApp);
  const archive = path.resolve(record.archive);
  const executable = path.resolve(record.executable);
  const directoryBackup = path.resolve(record.directoryBackup);
  if (archive !== path.join(installedApp, "resources", "app.asar")) throw new Error("Invalid Windows installation record.");
  if (path.dirname(executable) !== installedApp || !executablePattern.test(path.basename(executable))) throw new Error("Invalid Windows installation record.");
  if (path.dirname(directoryBackup) !== path.resolve(backupsRoot) || !backupPattern.test(path.basename(directoryBackup))) throw new Error("Invalid Windows installation record.");
  if (!/^[a-f0-9]{64}$/.test(record.originalHash || "") || !/^[a-f0-9]{64}$/.test(record.patchedHash || "")) throw new Error("Invalid Windows installation record.");
  return {
    ...record,
    installedApp,
    archive,
    executable,
    directoryBackup,
    previousBackup: ownedBackupOrNull(record.previousBackup),
    patchedInPlace: true,
  };
}

async function readRecord(): Promise<WindowsInstallRecord | null> {
  if (!await exists(recordPath)) return null;
  try { return assertRecord(JSON.parse(await readFile(recordPath, "utf8"))); }
  catch (error) {
    if (failureText(error) === "Invalid Windows installation record.") throw error;
    throw new Error("Windows installation record is unreadable.");
  }
}

async function writeRecord(record: WindowsInstallRecord): Promise<WindowsInstallRecord> {
  const temporary = `${recordPath}.${process.pid}.tmp`;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { await rename(temporary, recordPath); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return record;
}

async function withLock<Result>(work: () => Promise<Result>): Promise<Result> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(dataRoot, "windows-install.lock");
  await mkdir(lock).catch(() => { throw new Error("Another Windows patch operation is active. If it crashed, remove the windows-install.lock directory in the mods data folder."); });
  try { return await work(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function inspectArchive(archive: string): Promise<ArchiveInspection> {
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

async function findExecutable(directory: string): Promise<string> {
  const files = (await readdir(directory)).filter((name) => executablePattern.test(name));
  if (files.length !== 1) throw new Error("The Windows T3 executable could not be identified.");
  return path.join(directory, files[0]);
}

async function legacyOriginal(): Promise<string | null> {
  const filename = path.join(dataRoot, "platform.json");
  if (!await exists(filename)) return null;
  try {
    const record = JSON.parse(await readFile(filename, "utf8"));
    if (record.kind !== "win32" || typeof record.original !== "string" || !record.original) return null;
    return path.resolve(record.original);
  } catch { return null; }
}

async function resolveInstalledApp(dir: string | null | undefined): Promise<string> {
  if (typeof dir === "string" && dir.trim()) return path.resolve(dir);
  if (dir != null) throw new Error("Choose the Windows T3 installation directory containing resources/app.asar.");
  const legacy = await legacyOriginal();
  if (legacy) return legacy;
  throw new Error("Choose the Windows T3 installation directory containing resources/app.asar.");
}

async function assertInstallLocation(installedApp: string): Promise<void> {
  let info;
  try { info = await lstat(installedApp); }
  catch { return; }
  if (info.isSymbolicLink()) throw new Error("Refusing to patch a symlinked Windows installation.");
  const real = await realpath(installedApp);
  if (isInside(installedApp, dataRoot) || isInside(real, dataRoot)) throw new Error("Refusing to patch the mods data directory.");
}

async function restoreInterruptedInstall(installedApp: string): Promise<void> {
  if (await exists(installedApp)) return;
  const parent = path.dirname(installedApp);
  const prefix = `.${path.basename(installedApp)}.mods-hold-`;
  let names = [];
  try { names = (await readdir(parent)).filter((name) => name.startsWith(prefix)); }
  catch { return; }
  if (names.length !== 1) {
    throw new Error(names.length
      ? `The Windows installation directory is missing. The original was left at ${path.join(parent, names[0])}.`
      : "Choose the Windows T3 installation directory containing resources/app.asar.");
  }
  await rename(path.join(parent, names[0]), installedApp);
}

async function removeLeftoverTemps(installedApp: string): Promise<void> {
  const parent = path.dirname(installedApp);
  const prefix = `.${path.basename(installedApp)}.mods-`;
  let names = [];
  try { names = await readdir(parent); }
  catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (name.startsWith(`${prefix}stage-`) || name.startsWith(`${prefix}failed-`) || name.startsWith(`${prefix}restore-`)) {
      await rm(path.join(parent, name), { recursive: true, force: true });
    }
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  const resources = path.join(destination, "resources");
  await rm(path.join(resources, "app.asar.mods-for-t3-code.json"), { force: true });
  await rm(path.join(resources, "app.asar.mods-for-t3-code.bak"), { force: true });
  await rm(path.join(resources, "app.asar.mods-for-t3-code.json.tmp"), { force: true });
  await rm(path.join(resources, "app.asar.mods-for-t3-code.json.lock"), { recursive: true, force: true });
  const names = await readdir(resources).catch(() => []);
  for (const name of names) {
    if (name.startsWith("app.asar.mods-tmp-") || name.startsWith("app.asar.restore-")) await rm(path.join(resources, name), { recursive: true, force: true });
  }
}

async function ensureBackup(installedApp: string, originalHash: string): Promise<string> {
  await mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  const destination = backupPath(originalHash);
  const archived = path.join(destination, "resources", "app.asar");
  if (await exists(destination)) {
    if (await sha256(archived) !== originalHash) throw new Error(`Backup already exists at ${destination}. It will not be overwritten.`);
    return destination;
  }
  const temporary = path.join(backupsRoot, `.win-${originalHash.slice(0, 16)}-${process.pid}-${randomBytes(3).toString("hex")}`);
  try {
    await copyTree(installedApp, temporary);
    if (await sha256(path.join(temporary, "resources", "app.asar")) !== originalHash) throw new Error("The Windows backup does not match the installed archive.");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (await exists(archived) && await sha256(archived) === originalHash) return destination;
    throw error;
  }
  return destination;
}

export async function commitInstalledDirectory(target: string, replacement: string): Promise<string> {
  const parent = path.dirname(path.resolve(target));
  if (path.dirname(path.resolve(replacement)) !== parent) throw new Error("The staged Windows install must stay in the same directory as the installed app.");
  const holding = path.join(parent, `.${path.basename(target)}.mods-hold-${process.pid}-${randomBytes(4).toString("hex")}`);
  await rename(target, holding);
  try { await rename(replacement, target); }
  catch (error) {
    try { await rename(holding, target); }
    catch (rollbackError) { throw new Error(`${failureText(error)} The original directory is at ${holding} and could not be moved back: ${failureText(rollbackError)}`); }
    throw error;
  }
  return holding;
}

async function rollbackCommit(target: string, holding: string): Promise<void> {
  const parent = path.dirname(target);
  const failed = path.join(parent, `.${path.basename(target)}.mods-failed-${process.pid}-${randomBytes(3).toString("hex")}`);
  if (await exists(target)) await rename(target, failed);
  try { await rename(holding, target); }
  finally { await rm(failed, { recursive: true, force: true }); }
}

async function normalizeInstalledSidecar(archive: string, originalHash: string): Promise<SidecarState & { archive: string; backup: string }> {
  const paths = sidecarPathsForArchive(archive);
  const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
  if (await sha256(paths.backup) !== originalHash) throw new Error("The staged backup does not match the original archive.");
  const normalized = relocatedSidecarState(state, archive);
  const temporary = `${paths.stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  try { await rename(temporary, paths.stateFile); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return normalized;
}

async function retireLegacyManagedCopy(installedApp: string): Promise<void> {
  const filename = path.join(dataRoot, "platform.json");
  if (!await exists(filename)) return;
  let record;
  try { record = JSON.parse(await readFile(filename, "utf8")); }
  catch { return; }
  if (record.kind !== "win32" || typeof record.original !== "string" || path.resolve(record.original) !== path.resolve(installedApp)) return;
  for (const candidate of [record.previousCopy, record.copy]) {
    try { await removeStaleOwnedCopy(candidate, { root: dataRoot, retain: [], pattern: managedCopyPattern }); }
    catch (error) { console.warn(`Older managed copy was left in place: ${failureText(error)}`); }
  }
}

function refuseError(inspection: ArchiveInspection, hasRecord: boolean): Error {
  if (hasRecord) return new Error("T3 changed since this patch. Restore/reinstall the official app, then patch the new version. Your backup has been kept.");
  if (inspection.recognized && !inspection.markerFree) return new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
  return new Error("This is not a recognized T3 Code Windows installation.");
}

async function finishCurrent(record: WindowsInstallRecord, archive: string): Promise<WindowsInstallRecord> {
  const paths = sidecarPathsForArchive(archive);
  if (await exists(paths.stateFile)) {
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    if (path.resolve(state.archive) !== paths.archive || path.resolve(state.backup) !== paths.backup) await normalizeInstalledSidecar(archive, record.originalHash);
    await patchArchive(archive, { managedCopy: true });
  }
  await retireLegacyManagedCopy(record.installedApp);
  return record;
}

async function finishRecordMissing(installedApp: string, executable: string, archive: string, sidecar: SidecarState | null, liveHash: string): Promise<WindowsInstallRecord> {
  if (!sidecar?.originalHash || sidecar.patchedHash !== liveHash) throw new Error("The archive is patched but its backup record is missing. Restore the original app before patching again.");
  const directoryBackup = backupPath(sidecar.originalHash);
  const backupArchive = path.join(directoryBackup, "resources", "app.asar");
  if (!await exists(backupArchive) || await sha256(backupArchive) !== sidecar.originalHash) throw new Error("The archive is patched but its original backup is missing. Restore the original app before patching again.");
  const normalized = await normalizeInstalledSidecar(archive, sidecar.originalHash);
  if (normalized.patchedHash !== liveHash) throw new Error("Patched Windows archive checksum mismatch.");
  const record = await writeRecord({
    kind: "win32",
    installedApp,
    archive: normalized.archive,
    executable,
    appVersion: normalized.appVersion || sidecar.appVersion || "unknown",
    patchedInPlace: true,
    originalHash: sidecar.originalHash,
    patchedHash: liveHash,
    directoryBackup,
    previousBackup: null,
  });
  await retireLegacyManagedCopy(installedApp);
  return record;
}

async function patchIntoPlace(installedApp: string, originalHash: string, previousRecord: WindowsInstallRecord | null): Promise<WindowsInstallRecord> {
  const parent = path.dirname(installedApp);
  const token = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const stage = path.join(parent, `.${path.basename(installedApp)}.mods-stage-${token}`);
  let holding: string | null = null;
  let committed = false;
  try {
    await copyTree(installedApp, stage);
    const stagedExecutable = await findExecutable(stage);
    const stagedArchive = path.join(stage, "resources", "app.asar");
    if (await sha256(stagedArchive) !== originalHash) throw new Error("The staged Windows archive does not match the installed app.");
    const patch = await patchArchive(stagedArchive, { managedCopy: true });
    if (patch.originalHash !== originalHash) throw new Error("The staged Windows archive does not match the backup.");
    await windowsIntegrity(stagedExecutable, stagedArchive);
    const liveArchive = path.join(installedApp, "resources", "app.asar");
    if (await sha256(liveArchive) !== originalHash) throw new Error("T3 changed while the patch was being prepared. The installed app was left untouched.");
    holding = await commitInstalledDirectory(installedApp, stage);
    const normalized = await normalizeInstalledSidecar(liveArchive, originalHash);
    if (await sha256(liveArchive) !== normalized.patchedHash) throw new Error("Patched Windows archive checksum mismatch.");
    const record = {
      kind: "win32",
      installedApp,
      archive: path.join(installedApp, "resources", "app.asar"),
      executable: path.join(installedApp, path.basename(stagedExecutable)),
      appVersion: normalized.appVersion,
      patchedInPlace: true,
      originalHash,
      patchedHash: normalized.patchedHash,
      directoryBackup: backupPath(originalHash),
      previousBackup: ownedBackupOrNull(previousRecord?.directoryBackup),
    };
    await writeRecord(record);
    committed = true;
    await rm(holding, { recursive: true, force: true }).catch((error) => {
      console.warn(`The pre-patch Windows directory was left at ${holding}: ${failureText(error)}`);
    });
    try { await removeOwnedWindowsBackup(previousRecord?.previousBackup, [record.directoryBackup, record.previousBackup]); }
    catch (error) { console.warn(`Older Windows backup was left in place: ${failureText(error)}`); }
    await retireLegacyManagedCopy(installedApp);
    return record;
  } catch (error) {
    if (!committed && holding) {
      try { await rollbackCommit(installedApp, holding); }
      catch (rollbackError) { throw new Error(`${failureText(error)} The original directory is at ${holding} and could not be restored: ${failureText(rollbackError)}`); }
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function installLocked(dir: string | null | undefined): Promise<WindowsInstallRecord> {
  const installedApp = await resolveInstalledApp(dir);
  await restoreInterruptedInstall(installedApp);
  await assertInstallLocation(installedApp);
  await removeLeftoverTemps(installedApp);
  const archive = path.join(installedApp, "resources", "app.asar");
  if (!await exists(archive)) throw new Error("Choose the Windows T3 installation directory containing resources/app.asar.");
  const executable = await findExecutable(installedApp);
  const liveHash = await sha256(archive);
  const inspection = await inspectArchive(archive);
  const record = await readRecord();
  const sameApp = Boolean(record && record.installedApp === installedApp);
  const paths = sidecarPathsForArchive(archive);
  let sidecar = null;
  if (await exists(paths.stateFile)) {
    try { sidecar = JSON.parse(await readFile(paths.stateFile, "utf8")); }
    catch { sidecar = null; }
  }
  let action = windowsInstallPlan({
    hasRecord: Boolean(record),
    sameApp,
    liveHash,
    recordedPatchedHash: record?.patchedHash,
    sidecarPatchedHash: sidecar?.patchedHash,
    recognized: inspection.recognized,
    markerFree: inspection.markerFree,
  });
  if (action === "other-app") {
    if (await exists((record as WindowsInstallRecord).installedApp)) throw new Error("A different Windows installation is already recorded. Uninstall it before patching another directory.");
    action = "fresh";
  }
  if (action === "refuse") throw refuseError(inspection, Boolean(record && sameApp));
  if (action === "current") return finishCurrent(record as WindowsInstallRecord, archive);
  if (action === "record-missing") return finishRecordMissing(installedApp, executable, archive, sidecar, liveHash);
  await ensureBackup(installedApp, liveHash);
  return patchIntoPlace(installedApp, liveHash, action === "adopt" || record ? record : null);
}

export async function installWindowsApp(dir?: string | null, options: WindowsInstallOptions = {}): Promise<WindowsInstallRecord> {
  assertWindows(options);
  return withLock(() => installLocked(dir));
}

export async function launchWindowsApp(args: readonly string[] = [], options: WindowsInstallOptions = {}) {
  assertWindows(options);
  const record = await readRecord();
  if (!record) throw new Error("No Windows installation record found. Run install before launch.");
  const run = options.spawn ?? command;
  let current = record;
  try {
    if (await sha256(record.archive) !== record.patchedHash) {
      console.log("T3 updated. Reapplying mods to the installed app…");
      current = await installWindowsApp(record.installedApp, options);
    } else if (await exists(sidecarPathsForArchive(record.archive).stateFile)) {
      await patchArchive(record.archive, { managedCopy: true, checkOnly: true });
    }
  } catch (error) {
    console.warn(`Mods could not be loaded: ${failureText(error)}\nOpening the installed T3 app with mods disabled.`);
    await run(record.executable, args, { env: { ...process.env, T3_MODS_DISABLE: "1" } });
    return { ...record, patchedInPlace: true, modsDisabled: true };
  }
  await run(current.executable, args);
  return current;
}

async function restoreInstalledApp(record: WindowsInstallRecord) {
  const parent = path.dirname(record.installedApp);
  const stage = path.join(parent, `.${path.basename(record.installedApp)}.mods-restore-${process.pid}-${randomBytes(4).toString("hex")}`);
  let holding: string | null = null;
  let committed = false;
  try {
    await cp(record.directoryBackup, stage, { recursive: true, errorOnExist: true, force: false });
    if (await sha256(path.join(stage, "resources", "app.asar")) !== record.originalHash) throw new Error("The backup checksum no longer matches. Restore refused.");
    holding = await commitInstalledDirectory(record.installedApp, stage);
    if (await sha256(record.archive) !== record.originalHash) throw new Error("Restored Windows archive checksum mismatch.");
    await rm(recordPath);
    committed = true;
    await rm(holding, { recursive: true, force: true }).catch((error) => {
      console.warn(`The patched Windows directory was left at ${holding}: ${failureText(error)}`);
    });
    try {
      await removeOwnedWindowsBackup(record.directoryBackup, []);
      await removeOwnedWindowsBackup(record.previousBackup, []);
    } catch (error) { console.warn(`Windows backup was left in place: ${failureText(error)}`); }
    return {
      archive: record.archive,
      appVersion: record.appVersion,
      executable: record.executable,
      installedApp: record.installedApp,
      patchedInPlace: true,
      restored: true,
    };
  } catch (error) {
    if (!committed && holding) {
      try { await rollbackCommit(record.installedApp, holding); }
      catch (rollbackError) { throw new Error(`${failureText(error)} The patched directory is at ${holding} and could not be restored: ${failureText(rollbackError)}`); }
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function uninstallWindowsApp(options: WindowsInstallOptions = {}) {
  assertWindows(options);
  return withLock(async () => {
    const record = await readRecord();
    if (!record) throw new Error("No Windows installation record found.");
    await restoreInterruptedInstall(record.installedApp);
    const liveHash = await sha256(record.archive);
    const inspection = await inspectArchive(record.archive);
    const backupArchive = path.join(record.directoryBackup, "resources", "app.asar");
    const backupHash = await exists(backupArchive) ? await sha256(backupArchive) : null;
    const plan = windowsRestorePlan({
      liveHash,
      recordedPatchedHash: record.patchedHash,
      backupHash,
      recordedOriginalHash: record.originalHash,
      recognized: inspection.recognized,
      markerFree: inspection.markerFree,
    });
    if (plan === "keep-update") {
      await rm(sidecarPathsForArchive(record.archive).stateFile, { force: true });
      await rm(sidecarPathsForArchive(record.archive).backup, { force: true });
      await rm(recordPath, { force: true });
      return {
        archive: record.archive,
        appVersion: inspection.version || record.appVersion,
        executable: record.executable,
        installedApp: record.installedApp,
        patchedInPlace: true,
        restored: false,
        keptUpdate: true,
      };
    }
    if (plan !== "restore") {
      throw new Error(liveHash === record.patchedHash
        ? "The backup checksum no longer matches. Restore refused."
        : "The app changed after patching. Restore would overwrite an update, so it has been refused.");
    }
    return restoreInstalledApp(record);
  });
}

export async function doctorWindowsApp(options: WindowsInstallOptions = {}) {
  assertWindows(options);
  const record = await readRecord();
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
    nativeChecks: "unavailable",
  };
}
