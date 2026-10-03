import type { UsageSnapshot } from "../sdk.d.ts";

export interface TelemetryEvent { name: "session.usage" | "turn.complete"; value: UsageSnapshot }
export interface TelemetryApi {
  get(pathname?: string): UsageSnapshot | null;
  subscribe(listener: (event: TelemetryEvent) => void): () => void;
}
declare global {
  interface Window { __T3_MODS_TELEMETRY__?: TelemetryApi }
}
