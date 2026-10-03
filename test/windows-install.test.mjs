import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { NtExecutable, NtExecutableResource } from "resedit";
import { readEntry, sha256 } from "../src/archive.ts";

const dataRoot = await mkdtemp(path.join(tmpdir(), "t3-mods-win-"));
process.env.MODS_FOR_T3_DATA = dataRoot;
const {
  commitInstalledDirectory,
  doctorWindowsApp,
  installWindowsApp,
  launchWindowsApp,
  relocatedSidecarState,
  removeOwnedWindowsBackup,
  uninstallWindowsApp,
  windowsInstallPlan,
  windowsRestorePlan,
} = await import("../src/windows-install.ts");
const { patchArchive } = await import("../src/install.ts");
const marker = "/* mods-for-t3-code:v1 */";
const win = { hostPlatform: "win32" };

async function makeArchive(directory, name, version) {
  const input = path.join(directory, `${name}-src`);
  await mkdir(input, { recursive: true });
  await writeFile(path.join(input, "package.json"), JSON.stringify({ name: "t3-code-desktop", version, main: "boot.cjs" }));
  await writeFile(path.join(input, "boot.cjs"), `module.exports={version:${JSON.stringify(version)}};`);
  const archive = path.join(directory, name);
  await createPackageWithOptions(input, archive, {});
  return archive;
}

async function makeExecutable(file) {
  const executable = NtExecutable.createEmpty(false, false);
  const resources = NtExecutableResource.from(executable);
  resources.entries.push({ type: "CUSTOM", id: "KEEP", lang: 1033, codepage: 1200, bin: new TextEncoder().encode("unrelated resource").buffer });
  resources.outputResource(executable);
  await writeFile(file, Buffer.from(executable.generate()));
}

async function makeInstall(root, version) {
  const directory = path.join(root, "T3 Code");
  await mkdir(path.join(directory, "resources"), { recursive: true });
  await makeExecutable(path.join(directory, "T3 Code.exe"));
  await makeArchive(root, "app.asar", version);
  const built = path.join(root, "app.asar");
  const archive = path.join(directory, "resources", "app.asar");
  await writeFile(archive, await readFile(built));
  await rm(built);
  await writeFile(path.join(directory, "unchanged.txt"), "keep");
  return directory;
}

test("windows install and restore plans follow the verified hash", () => {
  const hash = "a".repeat(64);
  const next = "b".repeat(64);
  assert.equal(windowsInstallPlan({ hasRecord: true, sameApp: true, liveHash: hash, recordedPatchedHash: hash, sidecarPatchedHash: hash, recognized: true, markerFree: false }), "current");
  assert.equal(windowsInstallPlan({ hasRecord: false, sameApp: false, liveHash: hash, sidecarPatchedHash: hash, recognized: true, markerFree: false }), "record-missing");
  assert.equal(windowsInstallPlan({ hasRecord: true, sameApp: true, liveHash: next, recordedPatchedHash: hash, recognized: true, markerFree: true }), "adopt");
  assert.equal(windowsInstallPlan({ hasRecord: true, sameApp: true, liveHash: next, recordedPatchedHash: hash, recognized: true, markerFree: false }), "refuse");
  assert.equal(windowsInstallPlan({ hasRecord: false, sameApp: false, liveHash: next, recognized: true, markerFree: true }), "fresh");
  assert.equal(windowsRestorePlan({ liveHash: hash, recordedPatchedHash: hash, backupHash: next, recordedOriginalHash: next, recognized: true, markerFree: false }), "restore");
  assert.equal(windowsRestorePlan({ liveHash: next, recordedPatchedHash: hash, backupHash: hash, recordedOriginalHash: hash, recognized: true, markerFree: true }), "keep-update");
  assert.equal(windowsRestorePlan({ liveHash: next, recordedPatchedHash: hash, backupHash: hash, recordedOriginalHash: hash, recognized: true, markerFree: false }), "refuse");
  assert.equal(windowsRestorePlan({ liveHash: hash, recordedPatchedHash: hash, backupHash: "c".repeat(64), recordedOriginalHash: next, recognized: true, markerFree: false }), "refuse");
});

test("staged archive sidecar paths are rewritten to the installed directory", () => {
  const installed = path.join("/apps", "T3 Code", "resources", "app.asar");
  const staged = path.join("/apps", ".T3 Code.mods-stage-1", "resources", "app.asar");
  const state = relocatedSidecarState({ archive: staged, backup: `${staged}.mods-for-t3-code.bak`, patchedHash: "a".repeat(64), appVersion: "1.2.3" }, installed);
  assert.equal(state.archive, path.resolve(installed));
  assert.equal(state.backup, `${path.resolve(installed)}.mods-for-t3-code.bak`);
  assert.equal(state.patchedHash, "a".repeat(64));
  assert.equal(state.appVersion, "1.2.3");
});

test("windows backup cleanup keeps only owned backup directories", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "t3-mods-win-outside-"));
  try {
    const secret = path.join(outside, "secret");
    await writeFile(secret, "keep");
    const backups = path.join(dataRoot, "backups");
    const owned = path.join(backups, `win-${"a".repeat(16)}`);
    const retained = path.join(backups, `win-${"c".repeat(16)}`);
    const link = path.join(backups, `win-${"b".repeat(16)}`);
    const foreign = path.join(backups, "not-a-backup");
    await mkdir(owned, { recursive: true });
    await mkdir(retained, { recursive: true });
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(owned, "marker"), "old");
    await symlink(outside, link);
    assert.equal(await removeOwnedWindowsBackup(owned, [retained]), true);
    assert.equal(await removeOwnedWindowsBackup(retained, [retained]), false);
    assert.equal(await removeOwnedWindowsBackup(link, []), false);
    assert.equal(await removeOwnedWindowsBackup(foreign, []), false);
    assert.equal(await removeOwnedWindowsBackup(secret, []), false);
    assert.equal(await readFile(secret, "utf8"), "keep");
    assert.equal(await exists(link), true);
    assert.equal(await exists(retained), true);
    assert.equal(await exists(foreign), true);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

test("a failed directory swap puts the original directory back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mods-win-swap-"));
  try {
    const target = path.join(root, "T3 Code");
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "original");
    await assert.rejects(commitInstalledDirectory(target, path.join(root, "missing-stage")));
    assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "original");
    const names = await readdir(root);
    assert.deepEqual(names, ["T3 Code"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("windows install requires Windows and patches the installed directory in place", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mods-win-app-"));
  try {
    await assert.rejects(installWindowsApp(root), /must run on Windows/);
    await assert.rejects(installWindowsApp(dataRoot, win), /mods data directory/);
    const installed = await makeInstall(root, "1.0.0");
    const linked = path.join(root, "linked");
    await symlink(installed, linked);
    await assert.rejects(installWindowsApp(linked, win), /symlinked/);

    const outside = await mkdtemp(path.join(tmpdir(), "t3-mods-win-foreign-"));
    const managed = path.join(dataRoot, `managed-win32-${"a".repeat(16)}`);
    const darwin = path.join(dataRoot, `managed-darwin-${"b".repeat(16)}.app`);
    await mkdir(managed);
    await mkdir(darwin);
    await writeFile(path.join(managed, "sentinel"), "managed");
    await writeFile(path.join(darwin, "sentinel"), "darwin");
    await writeFile(path.join(outside, "secret"), "keep");
    await writeFile(path.join(dataRoot, "platform.json"), JSON.stringify({
      kind: "win32",
      original: installed,
      copy: managed,
      previousCopy: outside,
    }));
    const missing = path.join(root, "missing");
    await mkdir(missing);
    await assert.rejects(installWindowsApp(missing, win), /resources\/app\.asar/);
    assert.equal(await readFile(path.join(managed, "sentinel"), "utf8"), "managed");

    const broken = await makeInstall(path.join(root, "broken-parent"), "9.0.0");
    await writeFile(path.join(broken, "T3 Code.exe"), "not-a-pe");
    const brokenArchive = path.join(broken, "resources", "app.asar");
    const brokenBytes = await readFile(brokenArchive);
    await assert.rejects(installWindowsApp(broken, win));
    assert.equal(await readFile(path.join(broken, "T3 Code.exe"), "utf8"), "not-a-pe");
    assert.deepEqual(await readFile(brokenArchive), brokenBytes);
    assert.equal((await readdir(path.dirname(broken))).some((name) => name.includes(".mods-stage-")), false);

    const originalHash = await sha256(path.join(installed, "resources", "app.asar"));
    const result = await installWindowsApp(undefined, win);
    assert.equal(result.patchedInPlace, true);
    assert.equal(result.installedApp, installed);
    assert.equal(result.archive, path.join(installed, "resources", "app.asar"));
    assert.equal(result.executable, path.join(installed, "T3 Code.exe"));
    assert.equal(result.appVersion, "1.0.0");
    assert.match((await readEntry(result.archive, "boot.cjs")).toString(), /mods-for-t3-code:v1/);
    assert.equal(await readFile(path.join(installed, "unchanged.txt"), "utf8"), "keep");
    const sidecar = JSON.parse(await readFile(`${result.archive}.mods-for-t3-code.json`, "utf8"));
    assert.equal(sidecar.archive, result.archive);
    assert.equal(sidecar.backup, `${result.archive}.mods-for-t3-code.bak`);
    assert.equal(sidecar.archive.includes(".mods-stage-"), false);
    const backupArchive = path.join(result.directoryBackup, "resources", "app.asar");
    assert.equal(await sha256(backupArchive), originalHash);
    assert.equal((await readEntry(backupArchive, "boot.cjs")).toString().includes(marker), false);
    const installedExe = NtExecutableResource.from(NtExecutable.from(await readFile(result.executable), { ignoreCert: true }));
    const backupExe = NtExecutableResource.from(NtExecutable.from(await readFile(path.join(result.directoryBackup, "T3 Code.exe")), { ignoreCert: true }));
    assert.equal(new TextDecoder().decode(installedExe.entries.find((entry) => entry.type === "CUSTOM").bin), "unrelated resource");
    assert.equal(installedExe.entries.some((entry) => entry.type === "INTEGRITY"), true);
    assert.equal(backupExe.entries.some((entry) => entry.type === "INTEGRITY"), false);
    assert.equal(await readFile(path.join(managed, "sentinel"), "utf8").catch(() => "removed"), "removed");
    assert.equal(await readFile(path.join(darwin, "sentinel"), "utf8"), "darwin");
    assert.equal(await readFile(path.join(outside, "secret"), "utf8"), "keep");
    assert.equal((await readdir(path.dirname(installed))).includes("T3 Code"), true);

    const patchedHash = await sha256(result.archive);
    const again = await installWindowsApp(installed, win);
    assert.equal(again.patchedHash, patchedHash);
    assert.equal(again.directoryBackup, result.directoryBackup);
    const doctor = await doctorWindowsApp(win);
    assert.equal(doctor.patched, true);
    assert.equal(doctor.nativeChecks, "unavailable");
    assert.equal(doctor.installedApp, installed);
    assert.equal(doctor.patchedInPlace, true);
    const launches = [];
    const launched = await launchWindowsApp(["--ready"], { ...win, spawn: async (executable, args) => { launches.push({ executable, args }); } });
    assert.equal(launches[0].executable, launched.executable);
    assert.deepEqual(launches[0].args, ["--ready"]);
    assert.equal(path.dirname(launches[0].executable), installed);

    const other = await makeInstall(path.join(root, "other-parent"), "1.5.0");
    const otherHash = await sha256(path.join(other, "resources", "app.asar"));
    await assert.rejects(installWindowsApp(other, win), /different Windows installation/);
    assert.equal(await sha256(path.join(other, "resources", "app.asar")), otherHash);

    const version2 = await makeArchive(root, "v2.asar", "2.0.0");
    const version2Bytes = await readFile(version2);
    const version2Hash = await sha256(version2);
    await writeFile(result.archive, version2Bytes);
    const adopted = await installWindowsApp(installed, win);
    assert.equal(adopted.appVersion, "2.0.0");
    assert.equal(adopted.patchedInPlace, true);
    assert.equal(adopted.previousBackup, result.directoryBackup);
    assert.equal(await sha256(path.join(adopted.directoryBackup, "resources", "app.asar")), version2Hash);
    const adoptedState = JSON.parse(await readFile(`${adopted.archive}.mods-for-t3-code.json`, "utf8"));
    assert.equal(adoptedState.archive, adopted.archive);

    const version3 = await makeArchive(root, "v3.asar", "3.0.0");
    const version3Bytes = await readFile(version3);
    const version3Hash = await sha256(version3);
    await writeFile(adopted.archive, version3Bytes);
    const latest = await installWindowsApp(installed, win);
    assert.equal(latest.appVersion, "3.0.0");
    assert.equal(await exists(result.directoryBackup), false);
    assert.equal(await exists(adopted.directoryBackup), true);
    assert.equal(await exists(latest.directoryBackup), true);

    const patched = await readFile(latest.archive);
    const modded = await makeArchive(root, "modded.asar", "3.1.0");
    await patchArchive(modded);
    const moddedBytes = await readFile(modded);
    await writeFile(latest.archive, moddedBytes);
    await assert.rejects(installWindowsApp(installed, win), /backup has been kept/);
    await assert.rejects(uninstallWindowsApp(win), /overwrite an update/);
    const refused = [];
    const disabled = await launchWindowsApp([], { ...win, spawn: async (executable, args, options) => { refused.push({ executable, args, options }); } });
    assert.equal(disabled.modsDisabled, true);
    assert.equal(refused[0].options.env.T3_MODS_DISABLE, "1");
    assert.equal(path.dirname(refused[0].executable), installed);
    assert.deepEqual(await readFile(latest.archive), moddedBytes);

    await writeFile(latest.archive, patched);
    const restored = await uninstallWindowsApp(win);
    assert.equal(restored.restored, true);
    assert.equal(restored.patchedInPlace, true);
    assert.equal(restored.installedApp, installed);
    assert.equal(await sha256(restored.archive), version3Hash);
    assert.equal((await readEntry(restored.archive, "boot.cjs")).toString().includes(marker), false);
    assert.equal(await exists(`${restored.archive}.mods-for-t3-code.json`), false);
    assert.equal(await exists(path.join(dataRoot, "windows-install.json")), false);

    const repatched = await installWindowsApp(installed, win);
    assert.equal(repatched.appVersion, "3.0.0");
    const version4 = await makeArchive(root, "v4.asar", "4.0.0");
    const version4Bytes = await readFile(version4);
    await writeFile(repatched.archive, version4Bytes);
    const kept = await uninstallWindowsApp(win);
    assert.equal(kept.keptUpdate, true);
    assert.equal(kept.restored, false);
    assert.equal(kept.patchedInPlace, true);
    assert.deepEqual(await readFile(kept.archive), version4Bytes);
    assert.equal(await exists(path.join(dataRoot, "windows-install.json")), false);
    const temps = (await readdir(path.dirname(installed))).filter((name) => /^\.T3 Code\.mods-(?:stage|hold|restore|failed)-/.test(name));
    assert.deepEqual(temps, []);
    await rm(outside, { recursive: true, force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
