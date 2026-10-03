import type { BandPart, BandTone, Json, ModApi, UsageSnapshot } from "../../sdk.d.ts";

const WEATHER: readonly { below: number; icon: string; label: string; tone: BandTone }[] = [
  { below: 25, icon: "☀", label: "Clear", tone: "yellow" },
  { below: 50, icon: "☁", label: "Cloudy", tone: "cyan" },
  { below: 75, icon: "☂", label: "Showers", tone: "blue" },
  { below: 90, icon: "☇", label: "Storm", tone: "magenta" },
  { below: Infinity, icon: "↯", label: "Compact soon", tone: "red" },
];
const BARS = "▁▂▃▄▅▆▇█";
const MAX_TURNS = 12;
const MAX_THREADS = 40;
type StoredTurn = [key: string, used: number];

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999950) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1000000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

export function weather(percent: number): { below: number; icon: string; label: string; tone: BandTone } {
  const forecast = WEATHER.find((item) => percent < item.below);
  if (forecast) return forecast;
  const fallback = WEATHER[WEATHER.length - 1];
  if (!fallback) throw new Error("Weather scale is empty.");
  return fallback;
}

// Stored turn keys are short hashes, so 12 turns × 40 threads stays far below 64 KB.
function turnKey(turnId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < turnId.length; index++) hash = Math.imul(hash ^ turnId.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
}

export function line(snapshot: UsageSnapshot | null, turns: readonly number[]): BandPart[] {
  if (!snapshot) return [{ text: "◌ Context usage unavailable for this view", tone: "muted" }];
  const parts: BandPart[] = [];
  let tone: BandTone = "muted";
  if (snapshot.maxTokens) {
    const percent = Math.floor(snapshot.usedTokens / snapshot.maxTokens * 100);
    const forecast = weather(percent); tone = forecast.tone;
    parts.push({ text: `${forecast.icon} ${forecast.label}`, tone }, { text: `  ${percent}%` }, { text: `  ${formatTokens(snapshot.usedTokens)} / ${formatTokens(snapshot.maxTokens)}`, tone: "muted" });
  } else {
    parts.push({ text: "◌ Window unknown", tone: "muted" }, { text: `  ${formatTokens(snapshot.usedTokens)} used · window size unavailable`, tone: "muted" });
  }
  if (turns.length) {
    const scale = snapshot.maxTokens ?? Math.max(...turns, 1);
    parts.push({ text: `  ${turns.map((used) => BARS[Math.min(7, Math.round(used / scale * 7))] ?? "").join("")}`, tone });
  }
  if (turns.length === 1) parts.push({ text: "  Δ unknown (first turn)", tone: "muted" });
  else if (turns.length > 1) {
    const latest = turns.at(-1);
    const prior = turns.at(-2);
    if (latest !== undefined && prior !== undefined) {
      const delta = latest - prior;
      // A drop usually means compaction; show it as measured instead of hiding it.
      parts.push(delta >= 0 ? { text: `  ▲ +${formatTokens(delta)} last turn` } : { text: `  ▼ −${formatTokens(-delta)} last turn`, tone: "cyan" });
    }
  }
  return parts;
}

function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTurn(value: Json): StoredTurn | null {
  if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "number") return null;
  if (!Number.isSafeInteger(value[1]) || value[1] < 0) return null;
  return [value[0], value[1]];
}

function historyPayload(threads: ReadonlyMap<string, StoredTurn[]>): Json {
  const encoded: Json[] = [];
  for (const [threadId, turns] of threads) encoded.push([threadId, turns.map((turn) => [turn[0], turn[1]])]);
  return { version: 1, threads: encoded };
}

export async function activate(api: ModApi): Promise<void> {
  const threads = new Map<string, StoredTurn[]>();
  const saved = await api.storage.get("history");
  if (isRecord(saved) && saved.version === 1 && Array.isArray(saved.threads)) {
    for (const item of saved.threads.slice(-MAX_THREADS)) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;
      const turns: StoredTurn[] = [];
      for (const turn of item[1]) {
        const stored = readTurn(turn);
        if (stored) turns.push(stored);
      }
      threads.set(item[0], turns.slice(-MAX_TURNS));
    }
  }
  let current = await api.session.usage();
  let shown = "";

  function record(snapshot: UsageSnapshot | null): void {
    if (!snapshot?.complete || !snapshot.turnId) return;
    const turns = threads.get(snapshot.threadId) ?? [];
    const key = turnKey(snapshot.turnId);
    const existing = turns.find((turn) => turn[0] === key);
    // Once per completed turn: a later final measurement replaces the earlier one.
    if (existing) { if (existing[1] === snapshot.usedTokens) return; existing[1] = snapshot.usedTokens; }
    else turns.push([key, snapshot.usedTokens]);
    threads.delete(snapshot.threadId); threads.set(snapshot.threadId, turns.slice(-MAX_TURNS));
    while (threads.size > MAX_THREADS) {
      const oldest = threads.keys().next().value;
      if (oldest === undefined) break;
      threads.delete(oldest);
    }
    void api.storage.set("history", historyPayload(threads));
  }
  async function draw(): Promise<void> {
    const parts = line(current, current ? (threads.get(current.threadId) ?? []).map((turn) => turn[1]) : []);
    const text = JSON.stringify(parts);
    if (text === shown) return;
    shown = text; await api.band.set(parts);
  }
  async function update(snapshot: UsageSnapshot | null): Promise<void> { current = snapshot; record(snapshot); await draw(); }

  api.on("session.usage", update);
  api.on("turn.complete", (snapshot) => update(snapshot));
  record(current);
  await draw();
}
