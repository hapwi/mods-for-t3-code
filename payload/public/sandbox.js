// This trusted bootstrap lives in an opaque-origin iframe. Mod code only runs
// in its dedicated worker; the host can kill that worker even if it loops.
(() => {
  let initialized = false;
  window.addEventListener("message", (event) => {
    if (initialized || event.source !== parent || event.data?.type !== "t3mods.connect" || !event.ports[0]) return;
    initialized = true;
    const port = event.ports[0];
    let worker;
    let blobUrl;
    port.onmessage = ({ data }) => {
      if (data.type === "init") {
        const source = workerBootstrap.toString();
        blobUrl = URL.createObjectURL(new Blob([`"use strict";\n${data.code}\n;(${source})(globalThis.T3Mod);`], { type: "text/javascript" }));
        worker = new Worker(blobUrl);
        worker.onmessage = ({ data: message }) => port.postMessage(message);
        worker.onerror = (error) => port.postMessage({ type: "fault", error: error.message || "Mod worker failed." });
        worker.postMessage(data);
      } else if (data.type === "stop") {
        worker?.terminate();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        port.close();
      } else worker?.postMessage(data);
    };
    port.start();
    port.postMessage({ type: "connected" });
  });

  function workerBootstrap(mod) {
    let sequence = 0;
    const pending = new Map();
    const events = new Map();
    const commands = new Map();
    const actions = new Map();
    let cleanup;
    function call(method, args) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = method === "draft.insert" ? null : setTimeout(() => { pending.delete(id); reject(new Error("Host request timed out.")); }, 10000);
        pending.set(id, { resolve, reject, timer });
        postMessage({ type: "call", id, method, args });
      });
    }
    const api = Object.freeze({
      on(event, callback) {
        if (typeof callback !== "function") throw new Error("An event needs a callback.");
        const callbacks = events.get(event) ?? new Set();
        callbacks.add(callback); events.set(event, callbacks);
        call("events.subscribe", [event]).catch((error) => postMessage({ type: "fault", error: error.message }));
        return () => callbacks.delete(callback);
      },
      commands: Object.freeze({
        async register(command, callback) {
          commands.set(command.id, callback);
          await call("commands.register", [command]);
        },
      }),
      panels: Object.freeze({
        set: (panel) => call("panels.set", [panel]),
        clear: () => call("panels.clear", []),
        action(id, callback) { actions.set(id, callback); },
      }),
      notify: (message) => call("notify", [message]),
      theme: Object.freeze({ set: (colors) => call("theme.set", [colors]), clear: () => call("theme.clear", []) }),
      band: Object.freeze({ set: (parts) => call("band.set", [parts]), clear: () => call("band.clear", []) }),
      session: Object.freeze({ usage: () => call("session.usage", []) }),
      route: Object.freeze({ get: () => call("route.get", []) }),
      draft: Object.freeze({ read: () => call("draft.read", []), insert: (text) => call("draft.insert", [text]) }),
      storage: Object.freeze({ get: (key) => call("storage.get", [key]), set: (key, value) => call("storage.set", [key, value]) }),
      log: (message) => call("log", [String(message)]),
    });
    const heartbeat = setInterval(() => postMessage({ type: "heartbeat" }), 1000);
    self.onmessage = async ({ data }) => {
      if (data.type === "result") {
        const waiter = pending.get(data.id);
        if (!waiter) return;
        pending.delete(data.id); clearTimeout(waiter.timer);
        if (data.error) waiter.reject(new Error(data.error)); else waiter.resolve(data.value);
        return;
      }
      try {
        if (data.type === "init") {
          if (typeof mod?.activate !== "function") throw new Error("Export an activate(api) function.");
          cleanup = await mod.activate(api);
          postMessage({ type: "ready" });
        } else if (data.type === "event") {
          for (const callback of events.get(data.name) ?? []) await callback(data.value);
        } else if (data.type === "invoke") {
          const callback = (data.kind === "command" ? commands : actions).get(data.id);
          if (typeof callback !== "function") throw new Error("Unknown mod action.");
          await callback();
        } else if (data.type === "dispose") {
          clearInterval(heartbeat);
          if (typeof cleanup === "function") await cleanup();
        }
        if (data.requestId) postMessage({ type: "done", requestId: data.requestId });
      } catch (error) {
        postMessage({ type: "fault", error: error instanceof Error ? error.message : String(error) });
      }
    };
  }
})();
