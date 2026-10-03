/** Browser worker API, version 1. Import this file as a type only. */
export type Permission = "ui.panels" | "ui.commands" | "ui.notify" | "ui.theme" | "ui.band" | "session.usage" | "app.route" | "draft.read" | "draft.insert" | "storage";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ModManifest {
  apiVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  author: string;
  permissions: Permission[];
  entry?: string;
}
/** Packed mod. `code` is the isolated worker program. */
export interface ModBundle {
  format: "t3mod/1";
  manifest: ModManifest;
  code: string;
}
/** Bundle stored by the host, plus whether it is allowed to run. */
export interface ModRecord extends ModBundle {
  enabled: boolean;
  /** Fault text when the host stopped the mod, otherwise null. */
  quarantined: string | null;
  /** Set for an inbox or rendered-block delivery until the review is remembered. */
  inboxHash?: string;
}
/** Calls the worker may make. Arguments and results are JSON values. */
export type ModMethod =
  | "events.subscribe"
  | "commands.register"
  | "panels.set"
  | "panels.clear"
  | "notify"
  | "theme.set"
  | "theme.clear"
  | "band.set"
  | "band.clear"
  | "session.usage"
  | "route.get"
  | "draft.read"
  | "draft.insert"
  | "storage.get"
  | "storage.set"
  | "log";
export type BandTone = "default" | "muted" | "yellow" | "cyan" | "blue" | "magenta" | "red";
/** Plain single-line text. 1–16 parts, up to 160 characters each and 300 in total. No HTML. */
export interface BandPart { text: string; tone?: BandTone }
/** A measured context snapshot for the open thread. Nothing is estimated. */
export interface UsageSnapshot {
  threadId: string;
  turnId: string | null;
  usedTokens: number;
  /** null when T3 did not report the context window size. */
  maxTokens: number | null;
  /** Milliseconds since the Unix epoch. */
  measuredAt: number;
  /** True once the measured turn has completed. */
  complete: boolean;
}
export interface ModApi {
  on(event: "app.route", handler: (value: string) => void | Promise<void>): () => void;
  on(event: "draft.change", handler: (value: string) => void | Promise<void>): () => void;
  /** Requires session.usage. Fires for new measurements and on navigation; null when the open view has none. */
  on(event: "session.usage", handler: (value: UsageSnapshot | null) => void | Promise<void>): () => void;
  /** Requires session.usage. Can repeat for the same turnId when a later final measurement arrives. */
  on(event: "turn.complete", handler: (value: UsageSnapshot) => void | Promise<void>): () => void;
  commands: { register(command: { id: string; title: string }, callback: () => unknown | Promise<unknown>): Promise<void> };
  panels: {
    set(panel: { title: string; body?: string; actions?: { id: string; label: string }[] }): Promise<void>;
    clear(): Promise<void>;
    action(id: string, callback: () => unknown | Promise<unknown>): void;
  };
  notify(message: string): Promise<void>;
  theme: { set(colors: Record<string, string>): Promise<void>; clear(): Promise<void> };
  /** One line above the composer. Requires ui.band. */
  band: { set(parts: BandPart[]): Promise<void>; clear(): Promise<void> };
  /** Requires session.usage. */
  session: { usage(): Promise<UsageSnapshot | null> };
  route: { get(): Promise<string> };
  draft: { read(): Promise<string>; insert(text: string): Promise<boolean> };
  storage: { get(key: string): Promise<Json>; set(key: string, value: Json): Promise<void> };
  log(message: unknown): Promise<void>;
}
export type Activate = (api: ModApi) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
