// Exercise the read-only preload in an isolated Electron fixture, using a
// supplied Electron executable. Never starts T3 or opens its user database.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const executable = process.argv[2];
if (!executable) throw new Error("Pass an Electron executable path.");
const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-electron-"));
const preload = fileURLToPath(new URL("../dist/telemetry-preload.cjs", import.meta.url));
try {
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "mods-telemetry-fixture", main: "main.cjs" }));
  await writeFile(path.join(directory, "main.cjs"), `
    const {app,BrowserWindow,protocol}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(directory, "profile"))});
    protocol.registerSchemesAsPrivileged([{scheme:'t3code',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
    app.on('web-contents-created',(_,contents)=>contents.session.registerPreloadScript({type:'frame',filePath:${JSON.stringify(preload)}}));
    app.whenReady().then(async()=>{
      protocol.handle('t3code',()=>new Response('<!doctype html><title>isolated telemetry fixture</title>'));
      const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      w.webContents.on('console-message',details=>console.error(details.message));
      await w.loadURL('t3code://app/#/local/thread-fixture');
      const result=await w.webContents.executeJavaScript(\`(async()=>{
        const telemetry=window.__T3_MODS_TELEMETRY__; if(!telemetry)throw Error('Preload did not install');
        const events=[]; telemetry.subscribe(e=>events.push(e));
        const socket=new WebSocket('ws://127.0.0.1:9');
        socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({values:[{event:{type:'thread.activity-appended',payload:{threadId:'thread-fixture',activity:{kind:'context-window.updated',turnId:'turn-1',payload:{usedTokens:134400,maxTokens:200000}}}}}]})}));
        socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({values:[{event:{type:'thread.session-set',payload:{threadId:'thread-fixture',completedTurnId:'turn-1'}}}]})}));
        await new Promise(resolve=>setTimeout(resolve,10));
        const value=telemetry.get(); if(value?.usedTokens!==134400||value.maxTokens!==200000||!value.complete||events.at(-1)?.name!=='turn.complete')throw Error('Usage bridge mismatch');
        return {ok:true,contextIsolation:typeof require==='undefined',value};
      })()\`);
      console.log('Electron telemetry fixture passed: '+JSON.stringify(result)); app.quit();
    }).catch(e=>{console.error(e);app.exit(1)});
    setTimeout(()=>{console.error('Fixture timed out');app.exit(1)},15000).unref();
  `);
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [directory, "--disable-gpu"], { stdio: ["ignore", "pipe", "inherit"], env: environment });
  let passed = false;
  child.stdout.on("data", data => { process.stdout.write(data); if (String(data).includes("Electron telemetry fixture passed:")) passed = true; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0 || !passed) { console.error("Electron fixture did not report success."); process.exitCode = 1; }
} finally { await rm(directory, { recursive: true, force: true }); }
