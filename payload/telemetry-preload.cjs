"use strict";

// Trusted, read-only adapter. Runs before T3's original preload, without replacing
// it. Only numeric context measurements cross into the mod API.
function installTelemetry() {
  if (window !== window.top || window.__T3_MODS_TELEMETRY__) return;
  const snapshots = new Map();
  const completed = new Map();
  const listeners = new Set();
  const nodes = new Map();
  const providerThreads = new Map();
  const id = value => typeof value === "string" && value.length > 0 && value.length <= 300 ? value : null;
  function emit(name, value) {
    for (const listener of listeners) { try { listener({ name, value: { ...value } }); } catch {} }
  }
  function complete(threadId, turnId) {
    if (!id(threadId) || !id(turnId)) return;
    completed.delete(threadId); completed.set(threadId, turnId);
    if (completed.size > 100) completed.delete(completed.keys().next().value);
    const previous = snapshots.get(threadId);
    // Never attribute a previous turn's stale measurement to a new turn.
    if (!previous || previous.turnId !== turnId || previous.complete) return;
    const value = { ...previous, complete: true };
    snapshots.set(threadId, value); emit("turn.complete", value);
  }
  function usage(threadId, activity) {
    if (!id(threadId) || activity?.kind !== "context-window.updated") return;
    const payload = activity.payload;
    if (!payload || !Number.isSafeInteger(payload.usedTokens) || payload.usedTokens < 0) return;
    const turnId = id(activity.turnId);
    const measuredAt = typeof activity.createdAt === "string" ? Date.parse(activity.createdAt) : NaN;
    const value = {
      threadId, turnId, usedTokens: payload.usedTokens,
      maxTokens: Number.isSafeInteger(payload.maxTokens) && payload.maxTokens > 0 ? payload.maxTokens : null,
      measuredAt: Number.isFinite(measuredAt) ? measuredAt : Date.now(),
      complete: Boolean(turnId && completed.get(threadId) === turnId),
    };
    const previous = snapshots.get(threadId);
    if (previous && value.measuredAt < previous.measuredAt) return;
    if (previous && previous.turnId === value.turnId && previous.usedTokens === value.usedTokens && previous.maxTokens === value.maxTokens && previous.complete === value.complete) return;
    snapshots.delete(threadId); snapshots.set(threadId, value);
    if (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
    emit("session.usage", value);
    if (value.complete) emit("turn.complete", value);
  }
  function thread(value) {
    if (!id(value?.id)) return;
    // A shell snapshot has latestTurn but no activities; a detail snapshot has
    // both. Process its latest measured activity only, not historic turns.
    if (value.latestTurn?.state === "completed") complete(value.id, value.latestTurn.turnId);
    if (Array.isArray(value.activities)) {
      const last = value.activities.findLast(activity => activity?.kind === "context-window.updated");
      if (last) usage(value.id, last);
    }
  }
  function node(value) {
    if (!id(value?.id) || !id(value.threadId)) return;
    nodes.delete(value.id); nodes.set(value.id, { threadId: value.threadId, root: value.kind === "root_turn" });
    if (nodes.size > 1000) nodes.delete(nodes.keys().next().value);
  }
  function providerThread(value) {
    if (!id(value?.id) || !id(value.appThreadId)) return;
    providerThreads.delete(value.id); providerThreads.set(value.id, value.appThreadId);
    if (providerThreads.size > 200) providerThreads.delete(providerThreads.keys().next().value);
    if (value.contextUsage) usage(value.appThreadId, { kind: "context-window.updated", payload: value.contextUsage, createdAt: value.updatedAt, turnId: null });
  }
  function providerTurn(value, eventThreadId) {
    const owner = nodes.get(value?.nodeId);
    // Provider subagents are excluded even when streamed with the parent thread.
    if (!owner?.root || !id(value?.id) || eventThreadId && owner.threadId !== eventThreadId) return;
    const turnId = value.id;
    if (value.status === "completed") complete(owner.threadId, turnId);
    if (value.tokenUsage) usage(owner.threadId, { kind: "context-window.updated", payload: value.tokenUsage, createdAt: value.tokenUsage.updatedAt, turnId });
    if (value.status === "completed") complete(owner.threadId, turnId);
  }
  function projection(value) {
    if (!id(value?.thread?.id) || !Array.isArray(value.nodes)) return;
    for (const item of value.nodes) node(item);
    if (Array.isArray(value.providerThreads)) for (const item of value.providerThreads) providerThread(item);
    if (Array.isArray(value.providerTurns)) {
      // Old turns can update the bounded cache, but the current report wins.
      for (const item of [...value.providerTurns].sort((a, b) => Date.parse(a.tokenUsage?.updatedAt ?? a.completedAt ?? a.startedAt ?? 0) - Date.parse(b.tokenUsage?.updatedAt ?? b.completedAt ?? b.startedAt ?? 0))) providerTurn(item, value.thread.id);
    }
  }
  function inspect(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1); return; }
    if (value.type === "thread.activity-appended") usage(value.payload?.threadId, value.payload?.activity);
    else if (value.type === "thread.session-set") complete(value.payload?.threadId, value.payload?.completedTurnId);
    else if (value.type === "node.updated") node(value.payload);
    else if (value.type === "provider-thread.updated") providerThread(value.payload);
    else if (value.type === "provider-turn.updated") providerTurn(value.payload, value.threadId);
    else if (value.kind === "thread-upserted") thread(value.thread);
    else if (value.kind === "thread-removed") { snapshots.delete(value.threadId); completed.delete(value.threadId); }
    // Explicit RPC and snapshot envelopes only. Ignore prompt/tool/auth payloads.
    if (value.thread && Array.isArray(value.thread.activities)) thread(value.thread);
    if (Array.isArray(value.threads)) for (const item of value.threads) thread(item);
    if (value.projection) projection(value.projection);
    for (const key of ["values", "value", "snapshot", "event"]) {
      if (value[key] && typeof value[key] === "object") inspect(value[key], depth + 1);
    }
  }
  function receive(data) {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength > 16 * 1024 * 1024) return;
      data = new TextDecoder().decode(data);
    } else if (ArrayBuffer.isView(data)) {
      if (data.byteLength > 16 * 1024 * 1024) return;
      data = new TextDecoder().decode(data);
    }
    if (typeof data !== "string" || data.length > 16 * 1024 * 1024) return;
    try { inspect(JSON.parse(data)); } catch { /* Unknown future protocol: no measurements. */ }
  }
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === "function") {
    // Proxy preserves constructor/prototype/static properties and original sends.
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        let queue = Promise.resolve();
        socket.addEventListener("message", event => {
          const data = event.data;
          queue = queue.then(async () => {
            if (typeof Blob !== "undefined" && data instanceof Blob) {
              if (data.size <= 16 * 1024 * 1024) receive(await data.text());
            } else receive(data);
          }).catch(() => {});
        });
        return socket;
      },
    });
  }
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function(...args) {
      const result = Reflect.apply(nativeFetch, this, args);
      try {
        const request = args[0];
        const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url, location.href);
        const method = args[1]?.method ?? request?.method ?? "GET";
        if (method.toUpperCase() === "GET" && /^\/api\/orchestration\/threads\/[^/]+(?:\/bounded)?$/.test(url.pathname)) {
          result.then(response => {
            if (!response.ok) return;
            // Clone only the thread snapshot. Never consume the app's response.
            const clone = response.clone();
            void (async () => {
              const reader = clone.body?.getReader(); if (!reader) return;
              const chunks = []; let size = 0;
              for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > 16 * 1024 * 1024) { void reader.cancel(); return; }
                chunks.push(value);
              }
              const bytes = new Uint8Array(size); let offset = 0;
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
              receive(new TextDecoder().decode(bytes));
            })().catch(() => {});
          }).catch(() => {});
        }
      } catch {}
      return result;
    };
  }
  Object.defineProperty(window, "__T3_MODS_TELEMETRY__", { value: Object.freeze({
    get(pathname = location.pathname) {
      const segments = String(pathname).split("/").filter(Boolean);
      if (segments.length < 1 || ["settings", "draft"].includes(segments[0])) return null;
      let threadId; try { threadId = decodeURIComponent(segments.at(-1)); } catch { return null; }
      const value = snapshots.get(threadId); return value ? { ...value } : null;
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Expected a listener.");
      listeners.add(listener); return () => listeners.delete(listener);
    },
  }) });
}

try {
  if (["t3code:", "t3code-dev:"].includes(location.protocol) && location.hostname === "app") {
    require("electron").contextBridge.executeInMainWorld({ func: installTelemetry });
  }
} catch (error) { console.error("[Mods for T3 Code] Context measurements unavailable:", error.message); }
