import { access, chmod, copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform, arch } from "node:os";
import path from "node:path";
import { readEntry, sha256 } from "./archive.ts";
import { failureText } from "./failure.ts";
import { dataRoot, exists, command, patchArchive, installRuntime } from "./install.ts";

const execute = promisify(execFile);
const recordPath = path.join(dataRoot, "appimage-install.json");
const marker = "/* mods-for-t3-code:v1 */";
const backups = path.join(dataRoot, "backups");

interface AppImageInspection {
  appDir: string;
  archive: string;
  main: string;
  appVersion: string | undefined;
  patched: boolean;
}

interface ElectronPackage {
  name?: string;
  productName?: string;
  version?: string;
  main?: unknown;
}

export interface AppImageInstallRecord {
  image: string;
  originalHash: string;
  patchedHash: string;
  backup: string;
  previousBackup: string | null;
  appVersion?: string;
  installedAt?: string;
  alreadyPatched?: boolean;
  installedApp?: string;
  patchedInPlace?: boolean;
}

async function inspect(image: string, staging: string): Promise<AppImageInspection> {
  await command(image, ["--appimage-extract"], { cwd: staging, stdio: ["ignore", "ignore", "inherit"] });
  const appDir = path.join(staging, "squashfs-root");
  const candidates = [path.join(appDir, "resources/app.asar"), path.join(appDir, "usr/lib/t3code/resources/app.asar")];
  // T3's published AppImage puts resources directly in its AppDir.
  let found: string | undefined;
  for (const candidate of candidates) if (await exists(candidate)) { found = candidate; break; }
  if (!found || !(await exists(path.join(appDir, "AppRun")))) throw new Error("Unsupported T3 AppImage layout. The installed app was left unchanged.");
  const pkg = JSON.parse((await readEntry(found, "package.json")).toString()) as ElectronPackage;
  if (!/t3[ -]?(?:code|desktop)|@t3tools\/desktop/i.test(`${pkg.name || ""} ${pkg.productName || ""}`)) throw new Error("This AppImage is not T3 Code.");
  const main = pkg.main as string;
  const source = (await readEntry(found, main, 12 * 1024 * 1024)).toString();
  return { appDir, archive: found, main, appVersion: pkg.version, patched: source.includes(marker) };
}

async function squashBuilder(): Promise<string> {
  const architecture = arch() === "x64" ? "x86_64" : arch() === "arm64" ? "aarch64" : null;
  if (!architecture) throw new Error("AppImage patching supports x64 and arm64.");
  // AppImageKit's xz builder matches the runtime shipped by current T3 builds.
  // Pin the official asset bytes: newer builders require a different runtime.
  const checksum = architecture === "x86_64"
    ? "b90f4a8b18967545fda78a445b27680a1642f1ef9488ced28b65398f2be7add2"
    : "a48972e5ae91c944c5a7c80214e7e0a42dd6aa3ae979d8756203512a74ff574d";
  const downloadUrl = `https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${architecture}.AppImage`;
  const tools = path.join(dataRoot, "tools");
  await mkdir(tools, { recursive: true, mode: 0o700 });
  const root = path.join(tools, `appimage-builder-${checksum.slice(0, 16)}`);
  const executable = path.join(root, "squashfs-root/usr/lib/appimagekit/mksquashfs");
  if (await exists(executable)) return executable;
  const staging = await mkdtemp(path.join(tools, ".builder-"));
  try {
    const download = path.join(staging, "builder.AppImage");
    const payload = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000) });
    if (!payload.ok || !payload.body) throw new Error(`AppImage builder download failed (${payload.status}).`);
    await pipeline(payload.body, createWriteStream(download, { mode: 0o700 }));
    if (await sha256(download) !== checksum) throw new Error("AppImage builder checksum mismatch.");
    await command(download, ["--appimage-extract"], { cwd: staging, stdio: "ignore" });
    await rename(staging, root);
    return executable;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function removeBackup(filename: string | null | undefined, retain: readonly (string | null | undefined)[] = []): Promise<void> {
  if (!filename || retain.includes(filename)) return;
  if (path.dirname(filename) !== backups || !/^appimage-[a-f0-9]{64}\.AppImage$/.test(path.basename(filename))) return;
  await rm(filename, { force: true });
}

export async function installInstalledAppImage(filename: string): Promise<AppImageInstallRecord> {
  if (platform() !== "linux") throw new Error("AppImage installation requires Linux.");
  const image = path.resolve(filename);
  const handle = await open(image, "r");
  const prefix = Buffer.alloc(16);
  try { await handle.read(prefix, 0, 16, 0); } finally { await handle.close(); }
  if (prefix.toString("hex", 0, 4) !== "7f454c46" || prefix.toString("hex", 8, 11) !== "414902") throw new Error("Choose the actual type-2 AppImage binary, not a shell launcher. For a shim, use its .AppImage.real file.");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(dataRoot, "appimage-install.lock");
  await mkdir(lock).catch(() => { throw new Error("Another AppImage installation is active."); });
  let staging: string | undefined;
  let rollback: string | undefined;
  let swapped = false;
  let committed = false;
  try {
    const previous = await exists(recordPath) ? JSON.parse(await readFile(recordPath, "utf8")) as AppImageInstallRecord : null;
    const originalHash = await sha256(image);
    if (previous?.image === image && originalHash === previous.patchedHash) {
      // Refresh only the host runtime for an already patched image.
      await installRuntime();
      return { ...previous, alreadyPatched: true, installedApp: image, patchedInPlace: true };
    }
    await access(path.dirname(image), constants.W_OK);
    staging = await mkdtemp(path.join(path.dirname(image), ".t3-mods-install-"));
    const info = await inspect(image, staging);
    if (info.patched) throw new Error("The AppImage patch does not match its backup record. Restore the official app before installing again.");
    const { stdout } = await execute(image, ["--appimage-offset"]);
    const offset = Number(stdout.trim());
    if (!Number.isSafeInteger(offset) || offset < 16 || offset >= (await stat(image)).size) throw new Error("Invalid AppImage runtime offset.");
    const builder = await squashBuilder();
    const patch = await patchArchive(info.archive);
    // Full original-image backups live outside the AppImage; do not pack duplicate ASARs.
    await rm(`${info.archive}.mods-for-t3-code.bak`);
    await rm(`${info.archive}.mods-for-t3-code.json`);
    const squash = path.join(staging, "payload.squashfs");
    await command(builder, [info.appDir, squash, "-noappend", "-comp", "xz", "-processors", "2", "-no-progress"], { stdio: "ignore" });
    const output = path.join(staging, "patched.AppImage");
    await pipeline(createReadStream(image, { start: 0, end: offset - 1 }), createWriteStream(output));
    await pipeline(createReadStream(squash), createWriteStream(output, { flags: "a" }));
    await chmod(output, (await stat(image)).mode & 0o777);
    const verifyStage = await mkdtemp(path.join(staging, "verify-"));
    const verified = await inspect(output, verifyStage);
    if (!verified.patched || verified.appVersion !== patch.appVersion) throw new Error("Rebuilt AppImage verification failed.");
    await mkdir(backups, { recursive: true, mode: 0o700 });
    const backup = path.join(backups, `appimage-${originalHash}.AppImage`);
    if (await exists(backup)) { if (await sha256(backup) !== originalHash) throw new Error("Original AppImage backup checksum mismatch."); }
    else await copyFile(image, backup, constants.COPYFILE_EXCL);
    const record: AppImageInstallRecord = { image, originalHash, patchedHash: await sha256(output), backup, previousBackup: previous?.backup !== backup ? previous?.backup ?? null : previous?.previousBackup ?? null, appVersion: patch.appVersion, installedAt: new Date().toISOString() };
    if (await sha256(image) !== originalHash) throw new Error("T3 changed while the patch was being prepared. The installed app was left unchanged.");
    rollback = path.join(staging, "original.AppImage");
    await rename(image, rollback);
    try { await rename(output, image); swapped = true; }
    catch (error) { await rename(rollback, image); throw error; }
    await writeFile(`${recordPath}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(`${recordPath}.tmp`, recordPath);
    committed = true;
    await removeBackup(previous?.previousBackup, [backup, record.previousBackup]).catch((error: unknown) => console.warn(`Older AppImage backup was kept: ${failureText(error)}`));
    return { ...record, installedApp: image, patchedInPlace: true };
  } catch (error) {
    if (swapped && !committed && rollback) { await rm(image, { force: true }); await rename(rollback, image); }
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(`${recordPath}.tmp`, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function doctorInstalledAppImage(): Promise<{ compatible: boolean; patched: boolean; installedApp: string; appVersion?: string; backupVerified: boolean }> {
  const record = JSON.parse(await readFile(recordPath, "utf8")) as AppImageInstallRecord;
  const liveHash = await sha256(record.image);
  return { compatible: liveHash === record.patchedHash, patched: liveHash === record.patchedHash, installedApp: record.image, appVersion: record.appVersion, backupVerified: await sha256(record.backup) === record.originalHash };
}

export async function launchInstalledAppImage(args: readonly string[] = []): Promise<void> {
  const record = JSON.parse(await readFile(recordPath, "utf8")) as AppImageInstallRecord;
  try { await installInstalledAppImage(record.image); }
  catch (error) { console.warn(`Mods could not be refreshed: ${failureText(error)}\nOpening the installed T3 app with mods disabled.`); await command(record.image, args, { env: { ...process.env, T3_MODS_DISABLE: "1" } }); return; }
  await command(record.image, args);
}

export async function uninstallInstalledAppImage(): Promise<void> {
  const record = JSON.parse(await readFile(recordPath, "utf8")) as AppImageInstallRecord;
  if (await sha256(record.image) === record.patchedHash) {
    if (await sha256(record.backup) !== record.originalHash) throw new Error("Original AppImage backup checksum mismatch. Restore refused.");
    const temporary = `${record.image}.t3-mods-restore-${process.pid}`;
    await copyFile(record.backup, temporary);
    await chmod(temporary, (await stat(record.image)).mode & 0o777);
    await rename(temporary, record.image);
  } else {
    const staging = await mkdtemp(path.join(dataRoot, ".uninstall-inspect-"));
    try { if ((await inspect(record.image, staging)).patched) throw new Error("AppImage changed after patching. Restore refused to avoid overwriting changes."); }
    finally { await rm(staging, { recursive: true, force: true }); }
  }
  await rm(recordPath);
  await removeBackup(record.backup);
  await removeBackup(record.previousBackup);
}
