#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { platform } from "node:os";
import { validateBundle, validateManifest } from "../payload/web/manifest.ts";
import { failureText } from "../src/failure.ts";
import { patchArchive, restoreArchive, detectInstallation, dataRoot, launchApp, uninstallAppImage, exists, command as runCommand } from "../src/install.ts";
import { launchPlatform, uninstallPlatform, detectPlatform } from "../src/platform.ts";

import { withMacAppClosed } from "../src/mac-session.ts";
import { installMacApp, launchMacApp, uninstallMacApp, doctorMacApp, prepareMacNativeUpdate } from "../src/mac-install.ts";
import { installWindowsApp, launchWindowsApp, uninstallWindowsApp, doctorWindowsApp } from "../src/windows-install.ts";
import { installInstalledAppImage, launchInstalledAppImage, uninstallInstalledAppImage, doctorInstalledAppImage } from "../src/appimage-install.ts";

const [command = "help", ...args] = process.argv.slice(2);
const archiveRecord = path.join(dataRoot, "archive.json");
function option(name: string): string | undefined { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`); return value; }
async function nativeTarget(kind: "darwin" | "win32"): Promise<string> {
  const filename = path.join(dataRoot, kind === "darwin" ? "mac-install.json" : "windows-install.json");
  for (const recordFile of [filename, path.join(dataRoot, "platform.json")]) {
    if (!await exists(recordFile)) continue;
    const record = JSON.parse(await readFile(recordFile, "utf8")) as { kind?: string; installedApp?: string; original?: string };
    const target = record.installedApp || record.original;
    if (record.kind === kind && target && await exists(target)) return target;
  }
  return detectPlatform();
}
const help = `Mods for T3 Code

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
${dataRoot}
`;

try {
  if (command === "help" || command === "--help" || command === "-h") console.log(help);
  else if (command === "install") {
    let result: { appVersion?: string; installedApp?: string };
    if (option("--mac-app") || platform() === "darwin") {
      const app = option("--mac-app") || await nativeTarget("darwin");
      console.log(`\nMods for T3 Code\nPatching your existing app: ${app}`);
      result = await withMacAppClosed(app, onProgress => installMacApp(app, { onProgress }));
    }
    else if (option("--windows-dir") || platform() === "win32" && !option("--asar")) result = await installWindowsApp(option("--windows-dir") || await nativeTarget("win32"));
    else {
      const target = option("--asar") || option("--appimage") || await detectInstallation();
      result = target.endsWith(".asar") ? await patchArchive(target) : await installInstalledAppImage(target);
      if (target.endsWith(".asar")) {
        await mkdir(dataRoot, { recursive: true, mode: 0o700 });
        await writeFile(archiveRecord, JSON.stringify({ archive: path.resolve(target) }), { mode: 0o600 });
      }
    }
    console.log(`Mods for T3 Code installed for T3 ${result.appVersion}.`);
    console.log(`Patched your existing T3 app${result.installedApp ? `: ${result.installedApp}` : ""}. Reopen it using its normal icon.`);
    console.log("Use the Mods sidebar icon or Settings → Mods. Changes to mods apply live.");
  } else if (command === "doctor") {
    const nativeDoctor = !option("--asar") && (await exists(path.join(dataRoot, "mac-install.json")) ? doctorMacApp : await exists(path.join(dataRoot, "windows-install.json")) ? doctorWindowsApp : await exists(path.join(dataRoot, "appimage-install.json")) ? doctorInstalledAppImage : null);
    if (nativeDoctor) { console.log(JSON.stringify(await nativeDoctor(), null, 2)); process.exit(0); }
    let target = option("--asar");
    if (!target && await exists(path.join(dataRoot, "appimage.json"))) target = JSON.parse(await readFile(path.join(dataRoot, "appimage.json"), "utf8")).archive;
    if (!target && await exists(path.join(dataRoot, "platform.json"))) target = JSON.parse(await readFile(path.join(dataRoot, "platform.json"), "utf8")).archive;
    if (!target && await exists(archiveRecord)) target = JSON.parse(await readFile(archiveRecord, "utf8")).archive;
    target ||= await detectInstallation();
    if (!target.endsWith(".asar")) throw new Error("AppImage not patched yet. Run install; doctor can inspect an extracted --asar path.");
    const result = await patchArchive(target, { checkOnly: true, managedCopy: await exists(path.join(dataRoot, "platform.json")) });
    console.log(JSON.stringify({ compatible: true, patched: Boolean(result.alreadyPatched), ...result }, null, 2));
  } else if (command === "uninstall") {
    const archive = option("--asar");
    if (archive) await restoreArchive(archive);
    else if (await exists(path.join(dataRoot, "mac-install.json"))) await uninstallMacApp();
    else if (await exists(path.join(dataRoot, "windows-install.json"))) await uninstallWindowsApp();
    else if (await exists(path.join(dataRoot, "appimage-install.json"))) await uninstallInstalledAppImage();
    else if (await exists(path.join(dataRoot, "platform.json"))) await uninstallPlatform();
    else if (await exists(path.join(dataRoot, "appimage.json"))) await uninstallAppImage();
    else if (await exists(archiveRecord)) { await restoreArchive(JSON.parse(await readFile(archiveRecord, "utf8")).archive); await rm(archiveRecord); }
    else throw new Error("No installation record found. For a direct archive use uninstall --asar FILE.");
    console.log("Patch removed. Your installed T3 app is restored and private mod data is preserved.");
  } else if (command === "prepare-update") {
    const result = await prepareMacNativeUpdate();
    if (result.keptUpdate) {
      console.log(`T3 at ${result.installedApp} is already an upstream build. The older backup was not restored over it.`);
      console.log("Private mod data is unchanged. The maintenance launch command would reapply mods; open T3 with its normal icon and use T3's own updater first, then rerun install when you want mods again.");
    } else {
      console.log(`Restored the verified original signed app at ${result.installedApp}.`);
      console.log("The app path is unchanged and private mod data is preserved. Reopen T3 with its normal icon and use T3's own updater. After that update, rerun install to reapply mods.");
    }
  } else if (command === "launch") {
    const flags = args[0] === "--" ? args.slice(1) : args;
    if (await exists(path.join(dataRoot, "mac-install.json"))) await launchMacApp(flags);
    else if (await exists(path.join(dataRoot, "windows-install.json"))) await launchWindowsApp(flags);
    else if (await exists(path.join(dataRoot, "appimage-install.json"))) await launchInstalledAppImage(flags);
    else if (await exists(path.join(dataRoot, "platform.json"))) await launchPlatform(flags);
    else if (await exists(path.join(dataRoot, "appimage.json"))) await launchApp(flags);
    else if (await exists(archiveRecord)) {
      const archive = JSON.parse(await readFile(archiveRecord, "utf8")).archive;
      const directory = path.dirname(path.dirname(archive));
      const names = (await readdir(directory)).filter((name: string) => /^(?:t3code|t3-code|T3 Code)$/.test(name));
      if (names.length !== 1) throw new Error("Cannot identify the T3 executable beside this archive. Reopen T3 using its normal shortcut.");
      try { await patchArchive(archive); }
      catch (error) { console.warn(`Mods could not be refreshed: ${failureText(error)}\nOpening T3 with mods disabled.`); await runCommand(path.join(directory, names[0]), flags, { env: { ...process.env, T3_MODS_DISABLE: "1" } }); process.exit(0); }
      await runCommand(path.join(directory, names[0]), flags);
    } else throw new Error("Run install before launch.");
  } else if (command === "safe-mode") {
    const sentinel = path.join(dataRoot, "SAFE_MODE");
    if (args[0] === "on") { await mkdir(dataRoot, { recursive: true }); await writeFile(sentinel, "safe mode\n"); }
    else if (args[0] === "off") { const { rm } = await import("node:fs/promises"); await rm(sentinel, { force: true }); }
    else throw new Error("Use safe-mode on or safe-mode off.");
    console.log(`Safe mode ${args[0]}. In a running app, use Pause all mods for immediate effect.`);
  } else if (command === "validate") {
    const bundle = validateBundle(JSON.parse(await readFile(args[0], "utf8")));
    console.log(`${bundle.manifest.name} ${bundle.manifest.version}: valid API ${bundle.manifest.apiVersion} bundle`);
    console.log(`Permissions: ${bundle.manifest.permissions.join(", ") || "none"}`);
  } else if (command === "pack") {
    if (!args[0] || args[0].startsWith("--")) throw new Error("Choose a mod directory.");
    const directory = path.resolve(args[0]);
    const config = JSON.parse(await readFile(path.join(directory, "mod.json"), "utf8")) as { entry?: string };
    const manifest = validateManifest(config);
    const entry = path.resolve(directory, config.entry || "mod.js");
    if (!entry.startsWith(directory + path.sep)) throw new Error("The mod entry must be inside its directory.");
    const { build } = await import("esbuild").catch(() => { throw new Error("The pack command needs esbuild. Run npm ci in the downloaded package, or install this package with npm."); });
    const result = await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "iife", globalName: "T3Mod", target: "es2022", write: false, minify: false });
    const code = result.outputFiles[0].text + "\nglobalThis.T3Mod = T3Mod;\n";
    const bundle = validateBundle({ format: "t3mod/1", manifest, code });
    const output = path.resolve(option("--out") || `${manifest.id}.t3mod`);
    await writeFile(output, JSON.stringify(bundle, null, 2)); console.log(output);
  } else throw new Error(`Unknown command: ${command}. Use --help.`);
} catch (error) {
  console.error(`Mods for T3 Code: ${failureText(error)}`);
  process.exitCode = 1;
}
