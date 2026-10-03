#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { platform } from "node:os";
import { validateBundle, validateManifest } from "../payload/web/manifest.js";
import { patchArchive, restoreArchive, installAppImage, detectInstallation, dataRoot, launchApp, uninstallAppImage, exists, command as runCommand } from "../src/install.mjs";
import { installPlatform, launchPlatform, uninstallPlatform, detectPlatform } from "../src/platform.mjs";

const [command = "help", ...args] = process.argv.slice(2);
const archiveRecord = path.join(dataRoot, "archive.json");
function option(name) { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} needs a value.`); return args[index + 1]; }
const help = `Mods for T3 Code

  install [--appimage FILE | --asar FILE | --mac-app APP | --windows-dir DIR]
                                          Detect and patch an Electron install
  doctor  [--asar FILE]                    Check compatibility / patch checksums
  uninstall [--asar FILE]                  Restore archive or remove AppImage copy
  launch [-- Electron flags]               Open managed copy; refresh after updates
  safe-mode on|off                         Turn all mod code off for next launch
  pack MOD_DIRECTORY [--out FILE]          Bundle a JS/TS mod for sharing
  validate FILE.t3mod                      Validate a bundle without executing it

Close T3 before install or uninstall. One initial relaunch loads the host.
Mod installation, creation, updates and toggles are then live.
T3_MODS_DISABLE=1 bypasses the host entirely. Mod data lives in:
${dataRoot}
`;

try {
  if (command === "help" || command === "--help" || command === "-h") console.log(help);
  else if (command === "install") {
    let result;
    if (option("--mac-app") || platform() === "darwin") result = await installPlatform(option("--mac-app") || await detectPlatform(), "darwin");
    else if (option("--windows-dir") || platform() === "win32" && !option("--asar")) result = await installPlatform(option("--windows-dir") || await detectPlatform(), "win32");
    else {
      const target = option("--asar") || option("--appimage") || await detectInstallation();
      result = target.endsWith(".asar") ? await patchArchive(target) : await installAppImage(target);
      if (target.endsWith(".asar")) {
        await mkdir(dataRoot, { recursive: true, mode: 0o700 });
        await writeFile(archiveRecord, JSON.stringify({ archive: path.resolve(target) }), { mode: 0o600 });
      }
    }
    console.log(`Mods for T3 Code installed for T3 ${result.appVersion}.`);
    console.log("Open with: mods-for-t3-code launch");
    console.log("Use the Mods sidebar icon or Settings → Mods. Changes to mods apply live.");
  } else if (command === "doctor") {
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
    else if (await exists(path.join(dataRoot, "platform.json"))) await uninstallPlatform();
    else if (await exists(path.join(dataRoot, "appimage.json"))) await uninstallAppImage();
    else if (await exists(archiveRecord)) { await restoreArchive(JSON.parse(await readFile(archiveRecord, "utf8")).archive); await rm(archiveRecord); }
    else throw new Error("No managed installation found. For a direct archive use uninstall --asar FILE.");
    console.log("Patch removed. The original T3 app and private mod data are preserved.");
  } else if (command === "launch") {
    const flags = args[0] === "--" ? args.slice(1) : args;
    if (await exists(path.join(dataRoot, "platform.json"))) await launchPlatform(flags);
    else if (await exists(path.join(dataRoot, "appimage.json"))) await launchApp(flags);
    else if (await exists(archiveRecord)) {
      const archive = JSON.parse(await readFile(archiveRecord, "utf8")).archive;
      const directory = path.dirname(path.dirname(archive));
      const names = (await readdir(directory)).filter(name => /^(?:t3code|t3-code|T3 Code)$/.test(name));
      if (names.length !== 1) throw new Error("Cannot identify the T3 executable beside this archive. Reopen T3 using its normal shortcut.");
      try { await patchArchive(archive); }
      catch (error) { console.warn(`Mods could not be refreshed: ${error.message}\nOpening T3 with mods disabled.`); await runCommand(path.join(directory, names[0]), flags, { env: { ...process.env, T3_MODS_DISABLE: "1" } }); process.exit(0); }
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
    const config = JSON.parse(await readFile(path.join(directory, "mod.json"), "utf8"));
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
  console.error(`Mods for T3 Code: ${error.message}`);
  process.exitCode = 1;
}
