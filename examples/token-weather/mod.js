const WEATHER = [
  { below: 25, icon: "☀", label: "Clear", tone: "yellow" },
  { below: 50, icon: "☁", label: "Cloudy", tone: "cyan" },
  { below: 75, icon: "☂", label: "Showers", tone: "blue" },
  { below: 90, icon: "☇", label: "Storm", tone: "magenta" },
  { below: Infinity, icon: "↯", label: "Compact soon", tone: "red" },
];
const BARS = "▁▂▃▄▅▆▇█";
const MAX_TURNS = 12;
const MAX_THREADS = 40;

export function formatTokens(value) {
  if (value < 1000) return String(value);
  if (value < 999950) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1000000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

export function weather(percent) { return WEATHER.find((item) => percent < item.below); }

// Stored turn keys are short hashes, so 12 turns × 40 threads stays far below 64 KB.
function turnKey(turnId) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < turnId.length; index++) hash = Math.imul(hash ^ turnId.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
}

export function line(snapshot, turns) {
  if (!snapshot) return [{ text: "◌ Context usage unavailable for this view", tone: "muted" }];
  const parts = [];
  let tone = "muted";
  if (snapshot.maxTokens) {
    const percent = Math.floor(snapshot.usedTokens / snapshot.maxTokens * 100);
    const forecast = weather(percent); tone = forecast.tone;
    parts.push({ text: `${forecast.icon} ${forecast.label}`, tone }, { text: `  ${percent}%` }, { text: `  ${formatTokens(snapshot.usedTokens)} / ${formatTokens(snapshot.maxTokens)}`, tone: "muted" });
  } else {
    parts.push({ text: "◌ Window unknown", tone: "muted" }, { text: `  ${formatTokens(snapshot.usedTokens)} used · window size unavailable`, tone: "muted" });
  }
  if (turns.length) {
    const scale = snapshot.maxTokens ?? Math.max(...turns, 1);
    parts.push({ text: `  ${turns.map((used) => BARS[Math.min(7, Math.round(used / scale * 7))]).join("")}`, tone });
  }
  if (turns.length === 1) parts.push({ text: "  Δ unknown (first turn)", tone: "muted" });
  else if (turns.length > 1) {
    const delta = turns.at(-1) - turns.at(-2);
    // A drop usually means compaction; show it as measured instead of hiding it.
    parts.push(delta >= 0 ? { text: `  ▲ +${formatTokens(delta)} last turn` } : { text: `  ▼ −${formatTokens(-delta)} last turn`, tone: "cyan" });
  }
  return parts;
}

export async function activate(api) {
  const threads = new Map();
  const saved = await api.storage.get("history");
  if (saved?.version === 1 && Array.isArray(saved.threads)) {
    for (const item of saved.threads.slice(-MAX_THREADS)) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;
      const turns = item[1].filter((turn) => Array.isArray(turn) && typeof turn[0] === "string" && Number.isSafeInteger(turn[1]) && turn[1] >= 0).slice(-MAX_TURNS);
      threads.set(item[0], turns);
    }
  }
  let current = await api.session.usage();
  let shown = "";

  function record(snapshot) {
    if (!snapshot?.complete || !snapshot.turnId) return;
    const turns = threads.get(snapshot.threadId) ?? [];
    const key = turnKey(snapshot.turnId);
    const existing = turns.find((turn) => turn[0] === key);
    // Once per completed turn: a later final measurement replaces the earlier one.
    if (existing) { if (existing[1] === snapshot.usedTokens) return; existing[1] = snapshot.usedTokens; }
    else turns.push([key, snapshot.usedTokens]);
    threads.delete(snapshot.threadId); threads.set(snapshot.threadId, turns.slice(-MAX_TURNS));
    while (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value);
    void api.storage.set("history", { version: 1, threads: [...threads] });
  }
  async function draw() {
    const parts = line(current, current ? (threads.get(current.threadId) ?? []).map((turn) => turn[1]) : []);
    const text = JSON.stringify(parts);
    if (text === shown) return;
    shown = text; await api.band.set(parts);
  }
  async function update(snapshot) { current = snapshot; record(snapshot); await draw(); }

  api.on("session.usage", update);
  api.on("turn.complete", update);
  record(current);
  await draw();
}
