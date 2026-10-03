import { mkdtemp, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Uses a temporary profile, the actual shipped bootstrap and genuine wire frames.
const executable = process.argv[2];
if (!executable) throw new Error("Pass an unpackaged Electron executable.");
const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-integration-"));
try {
  await mkdir(path.join(directory, "inbox"));
  for (const file of ["bootstrap.cjs", "telemetry-preload.cjs", "renderer.js", "examples.json"]) await copyFile(fileURLToPath(new URL("../dist/" + file, import.meta.url)), path.join(directory, file));
  await writeFile(path.join(directory, "paths.cjs"), "exports.dataRoot=" + JSON.stringify(directory) + ";");
  await writeFile(path.join(directory, "native.cjs"), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('__nativePreload',true);contextBridge.exposeInMainWorld('__fixtureRemount',()=>ipcRenderer.invoke('fixture-remount'));");
  await writeFile(path.join(directory, "package.json"), JSON.stringify({main: "main.cjs"}));
  await copyFile(fileURLToPath(new URL("../test/electron-integration.cjs", import.meta.url)), path.join(directory, "main.cjs"));
  await copyFile(fileURLToPath(new URL("../test/electron-composer.html", import.meta.url)), path.join(directory, "composer.html"));
  const environment = {...process.env}; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [directory, "--disable-gpu"], {stdio: ["ignore", "pipe", "inherit"], env: environment});
  let passed = false;
  child.stdout.on("data", data => { process.stdout.write(data); if (String(data).includes("Electron integration passed:")) passed = true; });
  const code = await new Promise<number|null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0 || !passed) process.exitCode = 1;
} finally { await rm(directory, {recursive: true, force: true}); }
