import { test } from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackageWithOptions } from "@electron/asar";

const dataRoot = await mkdtemp(path.join(tmpdir(), "t3-mods-update-"));
process.env.MODS_FOR_T3_DATA = dataRoot;
const { macNativeUpdatePreparationPlan, prepareMacNativeUpdate, installMacApp } = await import("../src/mac-install.ts");
const { readEntry } = await import("../src/archive.ts");
const marker = "/* mods-for-t3-code:v1 */";
const mac = { hostPlatform: "darwin" };
const entitlements = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>`;

function createRunner({ failVerify = false, backupAdhoc = false, processes = "" } = {}) {
  const calls = [];
  const run = async (binary, args) => {
    const text = args.join(" ");
    if (text.includes("preserve-metadata") || text.includes("quarantine") || binary.includes("spctl")) throw new Error(`forbidden command ${binary} ${text}`);
    calls.push([binary, ...args]);
    if (binary === "/bin/ps") return { stdout: processes, stderr: "" };
    if (binary === "/usr/bin/xattr") return { stdout: "", stderr: "" };
    if (binary === "/usr/bin/ditto") {
      await cp(args[0], args[1], { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (binary === "/usr/bin/codesign" && args[0] === "--verify") {
      if (failVerify) throw new Error("codesign verify failed");
      return { stdout: "", stderr: "" };
    }
    if (binary === "/usr/bin/codesign" && args.includes(":-")) return { stdout: entitlements, stderr: "" };
    if (binary === "/usr/bin/codesign" && args.includes("-dv")) {
      const target = String(args.at(-1));
      const xml = await readFile(path.join(target, "Contents", "Info.plist"), "utf8");
      const hash = xml.match(/<key>hash<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? "";
      const adhoc = (backupAdhoc && target.includes(`${path.sep}backups${path.sep}`)) || /^[a-f0-9]{64}$/.test(hash);
      const stderr = adhoc
        ? "Signature=adhoc\nCDHash=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
        : "Authority=Developer ID Application: Example (ARK85ZXQ4Z)\nCDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      return { stdout: "", stderr };
    }
    if (binary === "/usr/bin/codesign" && args.includes("--sign")) return { stdout: "", stderr: "Signature=adhoc\n" };
    if (binary === "/usr/libexec/PlistBuddy") {
      const command = args[1];
      const plist = args[2];
      if (command.startsWith("Print :CFBundleExecutable")) return { stdout: "T3 Code\n", stderr: "" };
      if (command.startsWith("Set :ElectronAsarIntegrity")) {
        const digest = command.split(" ").at(-1);
        const xml = await readFile(plist, "utf8");
        await writeFile(plist, xml.replace(/<key>hash<\/key><string>[^<]*<\/string>/, `<key>hash</key><string>${digest}</string>`));
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected plist command ${command}`);
    }
    throw new Error(`unexpected ${binary} ${text}`);
  };
  return { run, calls };
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
  return app;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

test("native update preparation refuses an unverified backup and does not downgrade an upstream app", () => {
  const patched = "a".repeat(64);
  const original = "b".repeat(64);
  const vendor = "c".repeat(40);
  const shared = { liveHash: patched, recordedPatchedHash: patched, backupHash: original, recordedOriginalHash: original, recognized: true, markerFree: false, backupAdhoc: false, backupCdHash: vendor, vendorCdHash: vendor };
  assert.equal(macNativeUpdatePreparationPlan(shared), "restore");
  assert.equal(macNativeUpdatePreparationPlan({ ...shared, backupAdhoc: true }), "refuse");
  assert.equal(macNativeUpdatePreparationPlan({ ...shared, backupCdHash: "d".repeat(40) }), "refuse");
  assert.equal(macNativeUpdatePreparationPlan({ ...shared, vendorCdHash: null }), "refuse");
  assert.equal(macNativeUpdatePreparationPlan({ ...shared, liveHash: "e".repeat(64), recognized: true, markerFree: true, backupAdhoc: true }), "keep-update");
  assert.equal(macNativeUpdatePreparationPlan({ ...shared, liveHash: "e".repeat(64), recognized: true, markerFree: false }), "refuse");
});

test("prepare restores the verified vendor app in place and leaves private mod data", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mods-prepare-"));
  const library = path.join(dataRoot, "library", "keep.json");
  try {
    await assert.rejects(prepareMacNativeUpdate(), /macOS installation must run on macOS/);
    await mkdir(path.dirname(library), { recursive: true });
    await writeFile(library, "{\"kept\":true}\n");
    const installed = await makeApp(root, "1.0.0");
    const installedRunner = createRunner();
    const installedRecord = await installMacApp(installed, { ...mac, runner: installedRunner.run });
    assert.equal(installedRecord.nativeUpdaterVerified, false);
    const patched = await readFile(installedRecord.archive);
    assert.match((await readEntry(installedRecord.archive, "boot.cjs")).toString(), /mods-for-t3-code:v1/);

    const open = createRunner({ processes: `  42 ${installed}/Contents/MacOS/T3 Code\n` });
    await assert.rejects(prepareMacNativeUpdate({ ...mac, runner: open.run }), /T3 is open/);
    assert.equal(open.calls.some((args) => args[0] === "/usr/bin/ditto"), false);
    assert.deepEqual(await readFile(installedRecord.archive), patched);
    assert.equal(await exists(path.join(dataRoot, "mac-install.json")), true);

    const backupArchive = path.join(installedRecord.bundleBackup, "Contents", "Resources", "app.asar");
    const backupBytes = await readFile(backupArchive);
    await writeFile(backupArchive, "not-the-vendor-archive");
    const broken = createRunner();
    await assert.rejects(prepareMacNativeUpdate({ ...mac, runner: broken.run }), /backup checksum no longer matches/);
    assert.equal(broken.calls.some((args) => args[0] === "/usr/bin/ditto"), false);
    assert.deepEqual(await readFile(installedRecord.archive), patched);
    await writeFile(backupArchive, backupBytes);

    const adhoc = createRunner({ backupAdhoc: true });
    await assert.rejects(prepareMacNativeUpdate({ ...mac, runner: adhoc.run }), /not a verified vendor-signed app/);
    assert.equal(adhoc.calls.some((args) => args[0] === "/usr/bin/ditto"), false);
    assert.deepEqual(await readFile(installedRecord.archive), patched);

    const unverified = createRunner({ failVerify: true });
    await assert.rejects(prepareMacNativeUpdate({ ...mac, runner: unverified.run }), /codesign verify failed/);
    assert.match((await readEntry(installedRecord.archive, "boot.cjs")).toString(), /mods-for-t3-code:v1/);
    assert.equal(await exists(path.join(dataRoot, "mac-install.json")), true);
    assert.equal((await readdir(root)).some((name) => name.includes(".mods-")), false);

    const ready = createRunner();
    const messages = [];
    const restored = await prepareMacNativeUpdate({ ...mac, runner: ready.run, onProgress: (message) => messages.push(message) });
    assert.equal(restored.action, "restored-vendor");
    assert.equal(restored.prepared, true);
    assert.equal(restored.restored, true);
    assert.equal(restored.keptUpdate, false);
    assert.equal(restored.installedApp, installed);
    assert.equal(restored.original, installed);
    assert.equal(restored.nativeUpdaterVerified, false);
    assert.equal(restored.updaterEnabled, true);
    assert.equal(restored.signature.includes("Developer ID Application"), true);
    assert.equal((await readEntry(restored.archive, "boot.cjs")).toString().includes(marker), false);
    assert.equal(await readFile(library, "utf8"), "{\"kept\":true}\n");
    assert.equal(await exists(path.join(dataRoot, "mac-install.json")), false);
    assert.equal(await readFile(path.join(installed, "Contents", "Frameworks", "Squirrel.framework", "Squirrel"), "utf8"), "enabled");
    assert.match(await readFile(path.join(installed, "Contents", "Info.plist"), "utf8"), /vendor-hash-placeholder/);
    assert.deepEqual(messages, ["Restoring the verified original signed app"]);
    assert.equal(ready.calls.some((args) => args.includes("--sign")), false);
    assert.equal(ready.calls.some((args) => String(args[0]).includes("spctl") || args.join(" ").includes("preserve-metadata")), false);

    const upstream = await makeApp(path.join(root, "upstream"), "2.0.0");
    await installMacApp(installed, { ...mac, runner: createRunner().run });
    const upstreamArchive = path.join(upstream, "Contents", "Resources", "app.asar");
    const upstreamBytes = await readFile(upstreamArchive);
    await writeFile(path.join(installed, "Contents", "Resources", "app.asar"), upstreamBytes);
    const keptRunner = createRunner();
    const kept = await prepareMacNativeUpdate({ ...mac, runner: keptRunner.run });
    assert.equal(kept.action, "kept-update");
    assert.equal(kept.keptUpdate, true);
    assert.equal(kept.restored, false);
    assert.equal(kept.nativeUpdaterVerified, false);
    assert.equal(kept.installedApp, installed);
    assert.deepEqual(await readFile(path.join(installed, "Contents", "Resources", "app.asar")), upstreamBytes);
    assert.equal(keptRunner.calls.some((args) => args[0] === "/usr/bin/ditto"), false);
    assert.equal(await exists(path.join(dataRoot, "mac-install.json")), true);
    assert.equal(await readFile(library, "utf8"), "{\"kept\":true}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
