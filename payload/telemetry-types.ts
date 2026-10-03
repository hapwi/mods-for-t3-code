import type { UsageSnapshot } from "../sdk.d.ts";

export interface TelemetryEvent { name: "session.usage" | "turn.complete"; value: UsageSnapshot }
export interface TelemetryApi {
  get(pathname?: string): UsageSnapshot | null;
  subscribe(listener: (event: TelemetryEvent) => void): () => void;
}
// Trusted host handoff only: mod workers cannot access native conversation data.
export interface ModArtifact { threadId: string; messageId: string; bundle: unknown; error?: string }
export interface ModArtifactApi {
  get(): ModArtifact[];
  subscribe(listener: (artifact: ModArtifact) => void): () => void;
}
declare global {
  interface Window { __T3_MODS_TELEMETRY__?: TelemetryApi; __T3_MODS_ARTIFACTS__?: ModArtifactApi }
}
