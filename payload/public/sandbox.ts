import type { Activate, Json, ModApi } from "../../sdk.d.ts";

type HostMessage = {type: "init"; code: string} | {type: "stop" | "dispose"; requestId?: number} | {type: "result"; id: number; error?: string; value: unknown} | {type: "event"; name: string; value: unknown; requestId?: number} | {type: "invoke"; kind: "command" | "action"; id: string; requestId?: number};
type OutgoingMessage = Record<string, unknown>;
type Callback = () => unknown | Promise<unknown>;

// This trusted bootstrap lives in an opaque-origin iframe. Mod code only runs
// in its dedicated worker; the host can kill that worker even if it loops.
(() => {
  let initialized = false;
  window.addEventListener("message", (event) => {
    if (initialized || event.source !== parent || event.data?.type !== "t3mods.connect" || !event.ports[0]) return;
    initialized = true;
    const port = event.ports[0];
    let worker: Worker | undefined;
    let blobUrl: string | undefined;
    port.onmessage = ({ data }: MessageEvent<HostMessage>) => {
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

  function workerBootstrap(mod: {activate: Activate} | undefined) {
    const scope = globalThis as unknown as { postMessage(message: OutgoingMessage): void; onmessage: ((event: MessageEvent<HostMessage>) => Promise<void>) | null };
    let sequence = 0;
    const pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null}>();
    const events = new Map<string, Set<(value: unknown) => unknown>>();
    const commands = new Map<string, Callback>();
    const actions = new Map<string, Callback>();
    let cleanup: Awaited<ReturnType<Activate>>;
    function call<T = void>(method: string, args: unknown[]): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = ++sequence;
        const timer = method === "draft.insert" ? null : setTimeout(() => { pending.delete(id); reject(new Error("Host request timed out.")); }, 10000);
        pending.set(id, { resolve: value => resolve(value as T), reject, timer });
        scope.postMessage({ type: "call", id, method, args });
      });
    }
    const api: ModApi = Object.freeze({
      on(event: string, callback: (value: never) => unknown) {
        if (typeof callback !== "function") throw new Error("An event needs a callback.");
        const callbacks = events.get(event) ?? new Set();
        callbacks.add(callback as (value: unknown) => unknown); events.set(event, callbacks);
        call("events.subscribe", [event]).catch((error) => scope.postMessage({ type: "fault", error: error instanceof Error ? error.message : String(error) }));
        return () => { callbacks.delete(callback as (value: unknown) => unknown); };
      },
      commands: Object.freeze({
        async register(command: {id: string; title: string}, callback: Callback) {
          commands.set(command.id, callback);
          await call("commands.register", [command]);
        },
      }),
      panels: Object.freeze({
        set: (panel: Parameters<ModApi["panels"]["set"]>[0]) => call("panels.set", [panel]),
        clear: () => call("panels.clear", []),
        action(id: string, callback: Callback) { actions.set(id, callback); },
      }),
      notify: (message: string) => call("notify", [message]),
      theme: Object.freeze({ set: (colors: Record<string, string>) => call("theme.set", [colors]), clear: () => call("theme.clear", []) }),
      band: Object.freeze({ set: (parts: Parameters<ModApi["band"]["set"]>[0]) => call("band.set", [parts]), clear: () => call("band.clear", []) }),
      context: Object.freeze({ show: () => call("context.show", []), clear: () => call("context.clear", []) }),
      session: Object.freeze({ usage: () => call<import("../../sdk.d.ts").UsageSnapshot | null>("session.usage", []) }),
      route: Object.freeze({ get: () => call<string>("route.get", []) }),
      draft: Object.freeze({ read: () => call<string>("draft.read", []), insert: (text: string) => call<boolean>("draft.insert", [text]) }),
      storage: Object.freeze({ get: (key: string) => call<Json>("storage.get", [key]), set: (key: string, value: Json) => call("storage.set", [key, value]) }),
      log: (message: unknown) => call("log", [String(message)]),
    });
    const heartbeat = setInterval(() => scope.postMessage({ type: "heartbeat" }), 1000);
    scope.onmessage = async ({ data }) => {
      if (data.type === "result") {
        const waiter = pending.get(data.id);
        if (!waiter) return;
        pending.delete(data.id); if (waiter.timer !== null) clearTimeout(waiter.timer);
        if (data.error) waiter.reject(new Error(data.error)); else waiter.resolve(data.value);
        return;
      }
      try {
        if (data.type === "init") {
          if (typeof mod?.activate !== "function") throw new Error("Export an activate(api) function.");
          cleanup = await mod.activate(api);
          scope.postMessage({ type: "ready" });
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
        if ("requestId" in data && data.requestId) scope.postMessage({ type: "done", requestId: data.requestId });
      } catch (error) {
        scope.postMessage({ type: "fault", error: error instanceof Error ? error.message : String(error) });
      }
    };
  }
})();
