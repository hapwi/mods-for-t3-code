import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const profile = await mkdtemp(path.join(tmpdir(), "mods-for-t3-browser-"));
const browser = spawn(process.env.CHROMIUM || "chromium", ["--headless", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "http://127.0.0.1:4318/?smoke=1"], { stdio: "ignore" });
let socket: WebSocket | undefined;
let sequence = 0;
interface RpcResult {result: {value: string}}
const pending = new Map<number, {resolve: (value: RpcResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
  return new Promise<RpcResult>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
  });
}
try {
  let port;
  const startupDeadline = Date.now() + 10000;
  while (!port) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch {}
    if (Date.now() > startupDeadline) throw new Error("Chromium did not start.");
    if (!port) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as {url:string;webSocketDebuggerUrl:string}[];
  const target = targets.find((item) => item.url.includes("127.0.0.1:4318"));
  if (!target) throw new Error("Browser test page missing. Start npm run demo first.");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket!.onopen = () => resolve(undefined); socket!.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data); const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  };
  const deadline = Date.now() + 40000;
  for (;;) {
    const result = await rpc("Runtime.evaluate", { expression: 'JSON.stringify({status:document.querySelector("#smoke-result")?.dataset.status,text:document.querySelector("#smoke-result")?.textContent})', returnByValue: true });
    const value = JSON.parse(result.result.value);
    if (value.status === "failed") throw new Error(value.text);
    if (value.status === "passed") { console.log(value.text); break; }
    if (Date.now() > deadline) throw new Error(`Browser test did not complete: ${value.text || "no output"}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally {
  socket?.close(); browser.kill("SIGTERM");
  await new Promise((resolve) => { browser.once("exit", resolve); setTimeout(resolve, 2000); });
  await rm(profile, { recursive: true, force: true });
}
