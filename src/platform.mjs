import { cp, mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { platform, homedir } from "node:os";
import path from "node:path";
import { archiveHeader, sha256 } from "./archive.mjs";
import { dataRoot, patchArchive, exists, command, removeStaleOwnedCopy } from "./install.mjs";
import { installMacApp, launchMacApp, uninstallMacApp } from "./mac-install.mjs";

const recordPath = path.join(dataRoot, "platform.json");
const macRecordPath = path.join(dataRoot, "mac-install.json");
const managedCopyName = /^managed-(darwin|win32)-[a-f0-9]{16}(?:\.app)?$/;

export function nativeInstallChanged(record, liveHash) {
  return Boolean(liveHash) && liveHash !== (record.originalFingerprint ?? record.fingerprint);
}

async function writeRecord(record) {
  await writeFile(`${recordPath}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
  await rename(`${recordPath}.tmp`, recordPath);
}

export async function windowsIntegrity(executable, archive) {
  const { headerString } = await archiveHeader(archive);
  const digest = createHash("sha256").update(headerString).digest("hex");
  const { update } = await import("../dist/windows-resources.mjs");
  await update(executable, digest);
}

export async function installPlatform(sourcePath, kind, options = {}) {
  if (kind === "darwin") return installMacApp(options.original ?? sourcePath);
  if (kind !== platform()) throw new Error(`${kind} installation must run on ${kind}.`);
  const source = path.resolve(sourcePath);
  const original = path.resolve(options.original ?? source);
  const sourceArchive = path.join(source, "resources", "app.asar");
  if (!(await exists(sourceArchive))) throw new Error("Choose the Windows installation directory containing resources/app.asar.");
  const fingerprint = await sha256(sourceArchive);
  const originalFingerprint = options.originalFingerprint ?? fingerprint;
  const previous = await exists(recordPath) ? JSON.parse(await readFile(recordPath, "utf8")) : null;
  if (previous?.fingerprint === fingerprint && await exists(previous.archive)) {
    await patchArchive(previous.archive, { managedCopy: true });
    if (path.resolve(previous.original) !== original || previous.originalFingerprint !== originalFingerprint) {
      const refreshed = { ...previous, original, originalFingerprint };
      await writeRecord(refreshed); return refreshed;
    }
    return previous;
  }
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const copy = path.join(dataRoot, `managed-${kind}-${fingerprint.slice(0, 16)}`);
  if (await exists(copy)) throw new Error(`Managed copy already exists at ${copy}. It has not been overwritten.`);
  let record;
  try {
    await cp(source, copy, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    const archive = path.join(copy, "resources", "app.asar");
    const patch = await patchArchive(archive, { managedCopy: true });
    const files = (await readdir(copy)).filter((name) => /^(?:T3[ -]?Code|t3code)\.exe$/i.test(name));
    if (files.length !== 1) throw new Error("The Windows T3 executable could not be identified.");
    const executable = path.join(copy, files[0]);
    await windowsIntegrity(executable, archive);
    record = { kind, original, originalFingerprint, fingerprint, copy, archive, executable, appVersion: patch.appVersion, previousCopy: previous?.copy ?? null };
    await writeRecord(record);
  } catch (error) { await rm(copy, { recursive: true, force: true }); throw error; }
  try { await removeStaleOwnedCopy(previous?.previousCopy, { root: dataRoot, retain: [copy, record.previousCopy], pattern: managedCopyName }); }
  catch (error) { console.warn(`Older managed copy was left in place: ${error.message}`); }
  return record;
}

export async function launchPlatform(args = []) {
  if (await exists(macRecordPath)) return launchMacApp(args);
  let record = JSON.parse(await readFile(recordPath, "utf8"));
  if (record.kind === "darwin") {
    await installMacApp(record.original);
    return launchMacApp(args);
  }
  try {
    const archive = path.join(record.original, "resources", "app.asar");
    if (nativeInstallChanged(record, await sha256(archive))) {
      console.log("T3 updated. Refreshing its modded copy…");
      record = await installPlatform(record.original, record.kind);
    }
    await patchArchive(record.archive, { managedCopy: true, checkOnly: true });
    await command(record.executable, args, { env: { ...process.env, MODS_FOR_T3_MANAGED_COPY: "1", MODS_FOR_T3_ORIGINAL: record.original } });
  } catch (error) {
    console.warn(`Mod copy could not start: ${error.message}\nOpening the original T3 app. Your mods are preserved.`);
    const name = path.basename(record.executable);
    await command(path.join(record.original, name), args);
  }
}

export async function uninstallPlatform() {
  if (await exists(macRecordPath)) return uninstallMacApp();
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  for (const copy of [record.copy, record.previousCopy]) {
    if (!copy) continue;
    if (path.dirname(copy) !== dataRoot || !/^managed-(darwin|win32)-[a-f0-9]{16}(?:\.app)?$/.test(path.basename(copy))) throw new Error("Invalid managed-copy record.");
    await rm(copy, { recursive: true, force: true });
  }
  await rm(recordPath);
}

export async function detectPlatform({ kind = platform(), home = homedir(), applications = "/Applications", localAppData = process.env.LOCALAPPDATA || home, programFiles = process.env.ProgramFiles || "C:\\Program Files" } = {}) {
  const names = ["T3 Code", "T3-Code", "T3Code", "T3", "T3 Code (Alpha)", "T3 Code (Nightly)", "T3 Code Nightly"];
  if (kind === "darwin") {
    const directories = [applications, path.join(home, "Applications")];
    for (const directory of directories) for (const name of names) {
      const candidate = path.join(directory, `${name}.app`);
      if (await exists(path.join(candidate, "Contents", "Resources", "app.asar"))) return candidate;
    }
    throw new Error(`T3 was not found in ${directories.join(" or ")}. Pass --mac-app '/path/to/your T3.app' (including the full app name).`);
  }
  if (kind === "win32") {
    const directories = [path.join(localAppData, "Programs"), programFiles];
    for (const directory of directories) for (const name of [...names, "t3-code", "t3code"]) {
      const candidate = path.join(directory, name);
      if (await exists(path.join(candidate, "resources", "app.asar"))) return candidate;
    }
    throw new Error(`T3 was not found in ${directories.join(" or ")}. Pass --windows-dir 'C:\\path\\to\\your T3 installation'.`);
  }
  throw new Error(`Native installation detection is unsupported on ${kind}. On Linux use --appimage or --asar.`);
}
