import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../payload/telemetry-preload.cjs", import.meta.url), "utf8");
function harness() {
  class Store {
    constructor(name = "thread", database = "t3code:connection-runtime") { this.name = name; this.transaction = { db: { name: database } }; }
    get(key) { const request = new EventTarget(); request.key = key; return request; }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; }
    send(value) { this.sent = value; }
    receive(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  }
  const location = { protocol: "t3code:", hostname: "app", pathname: "/local/thread-a", href: "t3code://app/local/thread-a" };
  let context;
  const window = { WebSocket: Socket, IDBObjectStore: Store }; window.top = window;
  context = vm.createContext({ window, location, URL, console, TextDecoder, Uint8Array, ArrayBuffer, require: () => ({ contextBridge: {
    executeInMainWorld: ({ func }) => vm.runInContext(`(${func.toString()})()`, context),
  } }) });
  vm.runInContext(source, context);
  const socket = new window.WebSocket("ws://localhost/api/ws");
  return { window, socket, Socket, Store };
}
async function send(socket, value) { socket.receive(value); await new Promise(resolve => setTimeout(resolve, 0)); }
const activity = (usedTokens, turnId = "turn-a", maxTokens = 200000, time = "2026-10-03T10:00:00Z") => ({ kind: "context-window.updated", turnId, createdAt: time, payload: { usedTokens, maxTokens, privateField: "never forwarded" } });
const update = a => ({ _tag: "Chunk", values: [{ kind: "event", event: { type: "thread.activity-appended", payload: { threadId: "thread-a", activity: a } } }] });

test("observe normalized measurements and completion without changing websocket behavior", async () => {
  const { window, socket, Socket } = harness(); const events = [];
  assert.equal(socket instanceof Socket, true);
  assert.equal(window.WebSocket.OPEN, 1);
  socket.send("native RPC unchanged"); assert.equal(socket.sent, "native RPC unchanged");
  const unsubscribe = window.__T3_MODS_TELEMETRY__.subscribe(event => events.push(event));
  await send(socket, update(activity(134400)));
  const usage = window.__T3_MODS_TELEMETRY__.get();
  assert.equal(usage.usedTokens, 134400); assert.equal(usage.maxTokens, 200000);
  assert.equal("privateField" in usage, false);
  assert.equal(usage.complete, false);
  await send(socket, { values: [{ event: { type: "thread.session-set", payload: { threadId: "thread-a", completedTurnId: "turn-a" } } }] });
  assert.equal(events.at(-1).name, "turn.complete");
  assert.equal(window.__T3_MODS_TELEMETRY__.get().complete, true);
  assert.equal(window.__T3_MODS_TELEMETRY__.get("/local/thread-b"), null);
  assert.equal(window.__T3_MODS_TELEMETRY__.get("/settings/appearance"), null);
  unsubscribe(); const count = events.length;
  await send(socket, update(activity(150000, "turn-b", 200000, "2026-10-03T10:01:00Z")));
  assert.equal(events.length, count);
});

test("ignore arbitrary payloads, invalid data and stale usage; no invented window", async () => {
  const { window, socket } = harness();
  await send(socket, { type: "auth", payload: { thread: { id: "thread-a", activities: [activity(999)] } } });
  assert.equal(window.__T3_MODS_TELEMETRY__.get(), null);
  await send(socket, update(activity(-1))); assert.equal(window.__T3_MODS_TELEMETRY__.get(), null);
  await send(socket, { kind: "snapshot", snapshot: { thread: { id: "thread-a", latestTurn: { state: "completed", turnId: "turn-a" }, activities: [activity(120000, "turn-a", null)] } } });
  assert.equal(window.__T3_MODS_TELEMETRY__.get().maxTokens, null);
  assert.equal(window.__T3_MODS_TELEMETRY__.get().complete, true);
  await send(socket, update(activity(42, "turn-b", 200000, "2026-10-03T09:00:00Z")));
  assert.equal(window.__T3_MODS_TELEMETRY__.get().usedTokens, 120000);
  await send(socket, { event: { type: "thread.session-set", payload: { threadId: "thread-a", completedTurnId: "turn-b" } } });
  assert.equal(window.__T3_MODS_TELEMETRY__.get().turnId, "turn-a");
});

test("current V2 provider-turn measurements exclude subagents and preserve completion", async () => {
  const { window, socket } = harness(); const events = [];
  window.__T3_MODS_TELEMETRY__.subscribe(event => events.push(event));
  await send(socket, { values: [{ kind: "snapshot", projection: {
    thread: { id: "thread-a" },
    nodes: [{ id: "root", kind: "root_turn", threadId: "thread-a" }, { id: "child", kind: "subagent", threadId: "thread-a" }],
    providerTurns: [{ id: "turn-a", nodeId: "root", status: "running", tokenUsage: { usedTokens: 134400, maxTokens: 200000, updatedAt: "2026-10-03T10:00:00Z" } }],
  } }] });
  assert.equal(window.__T3_MODS_TELEMETRY__.get().usedTokens, 134400);
  await send(socket, { values: [{ kind: "event", event: { type: "provider-turn.updated", threadId: "thread-a", payload: { id: "child-turn", nodeId: "child", status: "completed", tokenUsage: { usedTokens: 123, maxTokens: 1000, updatedAt: "2026-10-03T10:01:00Z" } } } }] });
  assert.equal(window.__T3_MODS_TELEMETRY__.get().usedTokens, 134400);
  await send(socket, { event: { type: "provider-turn.updated", threadId: "thread-a", payload: { id: "turn-a", nodeId: "root", status: "completed" } } });
  assert.equal(window.__T3_MODS_TELEMETRY__.get().complete, true);
  assert.equal(events.at(-1).name, "turn.complete");
});

test("warm cached thread hydrates usage and root ownership before resumed socket updates", async () => {
  const { window, socket, Store } = harness();
  const cached = { schemaVersion: 3, environmentId: "remote", threadId: "thread-a", snapshot: { projection: {
    thread: { id: "thread-a" },
    nodes: [{ id: "root", kind: "root_turn", threadId: "thread-a" }, ...Array.from({ length: 1200 }, (_, i) => ({ id: `tool-${i}`, kind: "tool_call", threadId: "thread-a" }))],
    providerTurns: [{ id: "turn-a", nodeId: "root", status: "completed", tokenUsage: { usedTokens: 198923, maxTokens: 258400, updatedAt: "2026-10-03T09:35:02.684Z" } }],
  } } };
  const ignored = new Store("catalog").get("auth");
  ignored.result = JSON.stringify(cached); ignored.dispatchEvent(new Event("success"));
  assert.equal(window.__T3_MODS_TELEMETRY__.get(), null);
  const request = new Store().get("remote:thread-a");
  assert.equal(request.key, "remote:thread-a");
  request.result = JSON.stringify(cached); request.dispatchEvent(new Event("success"));
  assert.equal(window.__T3_MODS_TELEMETRY__.get().usedTokens, 198923);
  assert.equal(window.__T3_MODS_TELEMETRY__.get().complete, true);
  await send(socket, { values: [{ event: { type: "provider-turn.updated", threadId: "thread-a", payload: { id: "turn-a", nodeId: "root", status: "completed", tokenUsage: { usedTokens: 198990, maxTokens: 258400, updatedAt: "2026-10-03T09:35:03.684Z" } } } }] });
  assert.equal(window.__T3_MODS_TELEMETRY__.get().usedTokens, 198990);
});

test("unary RPC success snapshots are observed without inspecting failure data", async () => {
  const { window, socket } = harness();
  const value = { projection: { thread: { id: "thread-a" }, nodes: [{ id: "root", kind: "root_turn", threadId: "thread-a" }], providerTurns: [{ id: "turn-a", nodeId: "root", status: "completed", tokenUsage: { usedTokens: 89260, maxTokens: null, updatedAt: "2026-10-03T10:52:52.242Z" } }] } };
  await send(socket, { _tag: "Exit", exit: { _tag: "Failure", value } });
  assert.equal(window.__T3_MODS_TELEMETRY__.get(), null);
  await send(socket, { _tag: "Exit", exit: { _tag: "Success", value } });
  assert.equal(window.__T3_MODS_TELEMETRY__.get().usedTokens, 89260);
  assert.equal(window.__T3_MODS_TELEMETRY__.get().maxTokens, null);
});
