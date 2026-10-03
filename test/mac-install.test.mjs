import { test } from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { readEntry, sha256 } from "../src/archive.ts";

const dataRoot = await mkdtemp(path.join(tmpdir(), "t3-mods-mac-"));
process.env.MODS_FOR_T3_DATA = dataRoot;
const {
  adHocSignArguments,
  commitInstalledBundle,
  doctorMacApp,
  installMacApp,
  isRestrictedEntitlement,
  launchMacApp,
  macInstallPlan,
  macOpenArguments,
  macRestorePlan,
  parseSignatureDetails,
  relocatedSidecarState,
  resolveMacInstallTarget,
  sanitizeEntitlements,
  uninstallMacApp,
} = await import("../src/mac-install.ts");
const { patchArchive } = await import("../src/install.ts");
const marker = "/* mods-for-t3-code:v1 */";
const mac = { hostPlatform: "darwin" };
const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>ARK85ZXQ4Z.com.t3tools.t3code</string>
<key>com.apple.developer.team-identifier</key><string>ARK85ZXQ4Z</string>
<key>com.apple.developer.associated-domains</key><array><string>webcredentials:example.com</string></array>
<key>keychain-access-groups</key><array><string>ARK85ZXQ4Z.*</string></array>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
<key>com.apple.security.device.camera</key><true/>
</dict></plist>`;

function createRunner({ failSign = false } = {}) {
  const calls = [];
  let signed = "";
  const run = async (binary, args) => {
    const text = args.join(" ");
    if (text.includes("preserve-metadata") || text.includes("quarantine") || binary.includes("spctl")) throw new Error(`forbidden command ${binary} ${text}`);
    calls.push([binary, ...args]);
    if (binary === "/usr/bin/xattr") {
      if (args[0] !== "-dr" || !["com.apple.FinderInfo", "com.apple.ResourceFork"].includes(args[1])) throw new Error(`unexpected xattr ${text}`);
      return { stdout: "", stderr: "" };
    }
    if (binary === "/usr/bin/ditto") {
      await cp(args[0], args[1], { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (binary === "/usr/bin/codesign" && args[0] === "--verify") return { stdout: "", stderr: "" };
    if (binary === "/usr/bin/codesign" && args.includes(":-")) return { stdout: entitlements, stderr: "" };
    if (binary === "/usr/bin/codesign" && args.includes("-dv")) {
      const xml = await readFile(path.join(args.at(-1), "Contents", "Info.plist"), "utf8");
      const hash = xml.match(/<key>hash<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? "";
      const stderr = /^[a-f0-9]{64}$/.test(hash)
        ? "Signature=adhoc\nCDHash=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
        : "Authority=Developer ID Application: Example (ARK85ZXQ4Z)\nCDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      return { stdout: "", stderr };
    }
    if (binary === "/usr/bin/codesign" && args.includes("--sign")) {
      if (args.includes("--deep")) throw new Error("deep sign");
      signed = await readFile(args[args.indexOf("--entitlements") + 1], "utf8");
      if (failSign) throw new Error("sign failed");
      return { stdout: "", stderr: "Signature=adhoc\n" };
    }
    if (binary === "/usr/libexec/PlistBuddy") {
      const command = args[1];
      const plist = args[2];
      if (command.startsWith("Print :CFBundleExecutable")) return { stdout: "T3 Code\n", stderr: "" };
      if (command.startsWith("Set :ElectronAsarIntegrity")) {
        const digest = command.split(" ").at(-1);
        const xml = await readFile(plist, "utf8");
        if (!xml.includes("<key>hash</key>")) throw new Error("Does Not Exist");
        await writeFile(plist, xml.replace(/<key>hash<\/key><string>[^<]*<\/string>/, `<key>hash</key><string>${digest}</string>`));
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected plist command ${command}`);
    }
    throw new Error(`unexpected ${binary} ${text}`);
  };
  return { run, calls, signed: () => signed };
}

async function makeArchive(directory, name, version) {
  const input = path.join(directory, `${name}-src`);
  await mkdir(input, { recursive: true });
  await writeFile(path.join(input, "package.json"), JSON.stringify({ name: "t3-code-desktop", version, main: "boot.cjs" }));
  await writeFile(path.join(input, "boot.cjs"), `module.exports={version:${JSON.stringify(version)}};`);
  const archive = path.join(directory, name);
  await createPackageWithOptions(input, archive, {});
  return archive;
}

async function makeApp(parent, version) {
  const app = path.join(parent, "T3 Code (Nightly).app");
  const contents = path.join(app, "Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(path.join(contents, "Resources"), { recursive: true });
  await mkdir(path.join(contents, "Frameworks", "Squirrel.framework"), { recursive: true });
  await writeFile(path.join(contents, "MacOS", "T3 Code"), "#!/bin/sh\nexit 0\n");
  await writeFile(path.join(contents, "Frameworks", "Squirrel.framework", "Squirrel"), "enabled");
  await writeFile(path.join(contents, "embedded.provisionprofile"), "profile");
  await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>T3 Code</string><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>vendor-hash-placeholder</string></dict></dict></dict></plist>`);
  const built = await makeArchive(parent, `built-${version}.asar`, version);
  await writeFile(path.join(contents, "Resources", "app.asar"), await readFile(built));
  await rm(built, { force: true });
  await writeFile(path.join(contents, "unchanged.txt"), "keep");
  return app;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

test("ad-hoc signing drops provisioned team entitlements and keeps the Electron runtime exceptions", () => {
  for (const key of ["com.apple.application-identifier", "com.apple.developer.team-identifier", "com.apple.developer.associated-domains", "keychain-access-groups"]) {
    assert.equal(isRestrictedEntitlement(key), true);
  }
  for (const key of ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation", "com.apple.security.device.camera"]) {
    assert.equal(isRestrictedEntitlement(key), false);
  }
  const sanitized = sanitizeEntitlements(entitlements);
  assert.equal(sanitized.includes("com.apple.application-identifier"), false);
  assert.equal(sanitized.includes("com.apple.developer.team-identifier"), false);
  assert.equal(sanitized.includes("associated-domains"), false);
  assert.equal(sanitized.includes("webcredentials"), false);
  assert.equal(sanitized.includes("ARK85ZXQ4Z"), false);
  assert.equal(sanitized.includes("keychain-access-groups"), false);
  assert.match(sanitized, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(sanitized, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(sanitized, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(sanitized, /com\.apple\.security\.device\.camera/);
  const added = sanitizeEntitlements("<plist><dict></dict></plist>");
  assert.match(added, /allow-jit/);
  assert.match(added, /allow-unsigned-executable-memory/);
  assert.match(added, /disable-library-validation/);
  const args = adHocSignArguments("/Applications/T3 Code (Nightly).app", "/tmp/entitlements.plist");
  assert.equal(args.includes("--deep"), false);
  assert.equal(args.includes("--sign"), true);
  assert.equal(args.includes("-"), true);
  assert.equal(args.includes("runtime"), true);
  assert.equal(args.join(" ").includes("preserve-metadata"), false);
  assert.equal(parseSignatureDetails("Signature=adhoc\nCDHash=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n").label, "adhoc");
  assert.equal(parseSignatureDetails("Authority=Developer ID Application: Example (ARK85ZXQ4Z)\nCDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n").adhoc, false);
});

test("mac install and restore plans follow the verified hash", () => {
  const hash = "a".repeat(64);
  const next = "b".repeat(64);
  assert.equal(macInstallPlan({ hasRecord: true, sameApp: true, liveHash: hash, recordedPatchedHash: hash, sidecarPatchedHash: hash, recognized: true, markerFree: false }), "current");
  assert.equal(macInstallPlan({ hasRecord: false, sameApp: false, liveHash: hash, sidecarPatchedHash: hash, recognized: true, markerFree: false }), "record-missing");
  assert.equal(macInstallPlan({ hasRecord: true, sameApp: true, liveHash: next, recordedPatchedHash: hash, recognized: true, markerFree: true }), "adopt");
  assert.equal(macInstallPlan({ hasRecord: true, sameApp: true, liveHash: next, recordedPatchedHash: hash, recognized: true, markerFree: false }), "refuse");
  assert.equal(macInstallPlan({ hasRecord: false, sameApp: false, liveHash: next, recognized: true, markerFree: true }), "fresh");
  assert.equal(macRestorePlan({ liveHash: hash, recordedPatchedHash: hash, backupHash: next, recordedOriginalHash: next, recognized: true, markerFree: false }), "restore");
  assert.equal(macRestorePlan({ liveHash: next, recordedPatchedHash: hash, backupHash: hash, recordedOriginalHash: hash, recognized: true, markerFree: true }), "keep-update");
  assert.equal(macRestorePlan({ liveHash: next, recordedPatchedHash: hash, backupHash: hash, recordedOriginalHash: hash, recognized: true, markerFree: false }), "refuse");
});

test("staged archive sidecar paths are rewritten to the installed app", () => {
  const installed = "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar";
  const staged = "/Applications/.T3 Code (Nightly).app.mods-stage-1/Contents/Resources/app.asar";
  const state = relocatedSidecarState({ archive: staged, backup: `${staged}.mods-for-t3-code.bak`, patchedHash: "ab", appVersion: "1.2.3" }, installed);
  assert.equal(state.archive, path.resolve(installed));
  assert.equal(state.backup, `${path.resolve(installed)}.mods-for-t3-code.bak`);
  assert.equal(state.archive.includes(".mods-stage-"), false);
});

test("managed-copy migration uses the recorded original app", () => {
  const root = "/tmp/mods-data";
  const managed = path.join(root, `managed-darwin-${"a".repeat(16)}.app`);
  const original = "/Applications/T3 Code (Nightly).app";
  assert.equal(resolveMacInstallTarget(managed, { original }, root), path.resolve(original));
  assert.equal(resolveMacInstallTarget(original, { original: "/Applications/Other.app" }, root), path.resolve(original));
  assert.deepEqual(macOpenArguments(original, ["--ready"]), [original, "--args", "--ready"]);
  assert.deepEqual(macOpenArguments(original, []), [original]);
});

test("a failed bundle swap puts the original app back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mods-mac-swap-"));
  try {
    const target = path.join(root, "T3 Code (Nightly).app");
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "original");
    await assert.rejects(commitInstalledBundle(target, path.join(root, "missing-stage")));
    assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "original");
    assert.deepEqual(await readdir(root), ["T3 Code (Nightly).app"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mac install backs up, signs, and launches the existing app", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mods-mac-app-"));
  const outside = await mkdtemp(path.join(tmpdir(), "t3-mods-mac-outside-"));
  try {
    await assert.rejects(installMacApp("/Applications/T3 Code (Nightly).app"), /macOS/);
    const { run } = createRunner();
    await assert.rejects(installMacApp(dataRoot, { ...mac, runner: run }), /mods data directory|Choose the T3/);
    const installed = await makeApp(root, "1.0.0");
    const linked = path.join(root, "linked.app");
    await symlink(installed, linked);
    await assert.rejects(installMacApp(linked, { ...mac, runner: run }), /symlinked/);

    const failing = await makeApp(path.join(root, "fail"), "9.0.0");
    const failingArchive = path.join(failing, "Contents", "Resources", "app.asar");
    const failingBytes = await readFile(failingArchive);
    const failingRunner = createRunner({ failSign: true });
    await assert.rejects(installMacApp(failing, { ...mac, runner: failingRunner.run }), /sign failed/);
    assert.deepEqual(await readFile(failingArchive), failingBytes);
    assert.equal((await readdir(path.dirname(failing))).some((name) => name.includes(".mods-stage-") || name.includes(".mods-hold-")), false);
    assert.equal(failingRunner.calls.some((args) => args.join(" ").includes("preserve-metadata")), false);

    const managed = path.join(dataRoot, `managed-darwin-${"a".repeat(16)}.app`);
    const windowsCopy = path.join(dataRoot, `managed-win32-${"b".repeat(16)}`);
    await mkdir(managed);
    await mkdir(windowsCopy);
    await writeFile(path.join(managed, "sentinel"), "managed");
    await writeFile(path.join(windowsCopy, "sentinel"), "windows");
    await writeFile(path.join(outside, "secret"), "keep");
    await writeFile(path.join(dataRoot, "platform.json"), JSON.stringify({ kind: "darwin", original: installed, copy: managed, previousCopy: null }));

    const originalHash = await sha256(path.join(installed, "Contents", "Resources", "app.asar"));
    const runner = createRunner();
    const result = await installMacApp(path.join(dataRoot, `managed-darwin-${"c".repeat(16)}.app`), { ...mac, runner: runner.run });
    assert.equal(result.patchedInPlace, true);
    assert.equal(result.installedApp, installed);
    assert.equal(result.original, installed);
    assert.equal(result.appVersion, "1.0.0");
    assert.equal(result.signature, "adhoc");
    assert.equal(result.updaterEnabled, true);
    assert.equal(result.nativeUpdaterVerified, false);
    assert.equal(result.vendorSignature.includes("ARK85ZXQ4Z"), true);
    assert.match((await readEntry(result.archive, "boot.cjs")).toString(), /mods-for-t3-code:v1/);
    assert.equal(await readFile(path.join(installed, "Contents", "unchanged.txt"), "utf8"), "keep");
    assert.equal(await readFile(path.join(installed, "Contents", "Frameworks", "Squirrel.framework", "Squirrel"), "utf8"), "enabled");
    assert.equal(await exists(path.join(installed, "Contents", "embedded.provisionprofile")), false);
    assert.equal(await readFile(path.join(result.bundleBackup, "Contents", "embedded.provisionprofile"), "utf8"), "profile");
    assert.equal(await readFile(path.join(result.bundleBackup, "Contents", "Frameworks", "Squirrel.framework", "Squirrel"), "utf8"), "enabled");
    const backupArchive = path.join(result.bundleBackup, "Contents", "Resources", "app.asar");
    assert.equal(await sha256(backupArchive), originalHash);
    assert.equal((await readEntry(backupArchive, "boot.cjs")).toString().includes(marker), false);
    assert.match(await readFile(path.join(result.bundleBackup, "Contents", "Info.plist"), "utf8"), /vendor-hash-placeholder/);
    assert.match(await readFile(path.join(installed, "Contents", "Info.plist"), "utf8"), /[a-f0-9]{64}/);
    const sidecar = JSON.parse(await readFile(`${result.archive}.mods-for-t3-code.json`, "utf8"));
    assert.equal(sidecar.archive, result.archive);
    assert.equal(sidecar.backup, `${result.archive}.mods-for-t3-code.bak`);
    assert.equal(sidecar.archive.includes(".mods-stage-"), false);
    assert.equal(runner.signed().includes("com.apple.application-identifier"), false);
    assert.equal(runner.signed().includes("webcredentials"), false);
    assert.match(runner.signed(), /allow-jit/);
    assert.equal(runner.calls.some((args) => args.join(" ").includes("preserve-metadata")), false);
    assert.equal(runner.calls.some((args) => args.join(" ").includes("quarantine") || String(args[0]).includes("spctl")), false);
    const xattrCalls = runner.calls.filter((args) => args[0] === "/usr/bin/xattr");
    assert.deepEqual(xattrCalls.map((args) => args[2]), ["com.apple.FinderInfo", "com.apple.ResourceFork"]);
    assert.equal(xattrCalls.every((args) => String(args.at(-1)).includes(".mods-stage-")), true);
    assert.equal(await exists(path.join(managed, "sentinel")), false);
    assert.equal(await readFile(path.join(windowsCopy, "sentinel"), "utf8"), "windows");
    assert.equal(await readFile(path.join(outside, "secret"), "utf8"), "keep");
    assert.equal(await exists(path.join(dataRoot, "platform.json")), false);

    const patchedHash = await sha256(result.archive);
    const again = await installMacApp(installed, { ...mac, runner: runner.run });
    assert.equal(again.patchedHash, patchedHash);
    assert.equal(again.bundleBackup, result.bundleBackup);
    assert.equal(again.alreadyPatched, true);
    const doctor = await doctorMacApp({ ...mac, runner: runner.run });
    assert.equal(doctor.patched, true);
    assert.equal(doctor.needsRepatch, false);
    assert.equal(doctor.original, installed);
    assert.equal(doctor.installedApp, installed);
    assert.equal(doctor.patchedHash, patchedHash);
    assert.equal(doctor.signature, "adhoc");
    assert.equal(doctor.updaterEnabled, true);
    assert.equal(doctor.nativeUpdaterVerified, false);
    const launches = [];
    const launched = await launchMacApp(["--ready"], { ...mac, spawn: async (binary, args) => { launches.push({ binary, args }); } });
    assert.equal(launches[0].binary, "/usr/bin/open");
    assert.deepEqual(launches[0].args, [installed, "--args", "--ready"]);
    assert.equal(launched.installedApp, installed);
    assert.equal(launched.reapplied, false);

    const other = await makeApp(path.join(root, "other"), "1.5.0");
    const otherHash = await sha256(path.join(other, "Contents", "Resources", "app.asar"));
    await assert.rejects(installMacApp(other, { ...mac, runner: runner.run }), /different macOS app/);
    assert.equal(await sha256(path.join(other, "Contents", "Resources", "app.asar")), otherHash);

    await rm(installed, { recursive: true, force: true });
    const version2 = await makeApp(root, "2.0.0");
    assert.equal(version2, installed);
    const version2Hash = await sha256(path.join(installed, "Contents", "Resources", "app.asar"));
    const adopted = await installMacApp(installed, { ...mac, runner: createRunner().run });
    assert.equal(adopted.appVersion, "2.0.0");
    assert.equal(adopted.adoptedUpdate, true);
    assert.equal(adopted.previousBackup, result.bundleBackup);
    assert.equal(await sha256(path.join(adopted.bundleBackup, "Contents", "Resources", "app.asar")), version2Hash);
    assert.equal(JSON.parse(await readFile(`${adopted.archive}.mods-for-t3-code.json`, "utf8")).archive, adopted.archive);

    await rm(installed, { recursive: true, force: true });
    await makeApp(root, "3.0.0");
    const version3Hash = await sha256(path.join(installed, "Contents", "Resources", "app.asar"));
    const latest = await installMacApp(installed, { ...mac, runner: createRunner().run });
    assert.equal(latest.appVersion, "3.0.0");
    assert.equal(await exists(result.bundleBackup), false);
    assert.equal(await exists(adopted.bundleBackup), true);
    assert.equal(await exists(latest.bundleBackup), true);

    const patched = await readFile(latest.archive);
    const modded = await makeArchive(root, "modded.asar", "3.1.0");
    await patchArchive(modded);
    const moddedBytes = await readFile(modded);
    await writeFile(latest.archive, moddedBytes);
    await assert.rejects(installMacApp(installed, { ...mac, runner: createRunner().run }), /backup has been kept/);
    await assert.rejects(uninstallMacApp({ ...mac, runner: createRunner().run }), /overwrite an update/);
    const refused = [];
    const disabled = await launchMacApp([], { ...mac, runner: createRunner().run, spawn: async (binary, args, options) => { refused.push({ binary, args, options }); } });
    assert.equal(disabled.modsDisabled, true);
    assert.equal(refused[0].options.env.T3_MODS_DISABLE, "1");
    assert.equal(refused[0].binary, latest.executable);
    assert.deepEqual(await readFile(latest.archive), moddedBytes);

    await writeFile(latest.archive, patched);
    const restored = await uninstallMacApp({ ...mac, runner: createRunner().run });
    assert.equal(restored.restored, true);
    assert.equal(restored.installedApp, installed);
    assert.equal(restored.original, installed);
    assert.equal(await sha256(restored.archive), version3Hash);
    assert.equal((await readEntry(restored.archive, "boot.cjs")).toString().includes(marker), false);
    assert.equal(await exists(`${restored.archive}.mods-for-t3-code.json`), false);
    assert.equal(await exists(path.join(dataRoot, "mac-install.json")), false);
    assert.match(await readFile(path.join(installed, "Contents", "Info.plist"), "utf8"), /vendor-hash-placeholder/);
    assert.equal(await readFile(path.join(installed, "Contents", "embedded.provisionprofile"), "utf8"), "profile");

    const repatched = await installMacApp(installed, { ...mac, runner: createRunner().run });
    assert.equal(repatched.appVersion, "3.0.0");
    await rm(installed, { recursive: true, force: true });
    await makeApp(root, "4.0.0");
    const version4Hash = await sha256(path.join(installed, "Contents", "Resources", "app.asar"));
    const kept = await uninstallMacApp({ ...mac, runner: createRunner().run });
    assert.equal(kept.keptUpdate, true);
    assert.equal(kept.restored, false);
    assert.equal(kept.updaterEnabled, true);
    assert.equal(kept.nativeUpdaterVerified, false);
    assert.equal(await sha256(kept.archive), version4Hash);
    assert.equal(await exists(path.join(dataRoot, "mac-install.json")), false);
    assert.equal((await readdir(path.dirname(installed))).some((name) => name.startsWith(`.${path.basename(installed)}.mods-`)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
