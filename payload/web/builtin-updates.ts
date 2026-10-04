import type { ModBundle, ModRecord } from "../../sdk.d.ts";
import { validateBundle } from "./manifest.ts";

// Exact official Token Weather bundles shipped in 3e1437a and 63933d0.
// These copies still render the empty-context and first-turn placeholders.
// Match the whole bundle so AI edits and imported custom versions stay untouched.
const LEGACY_WEATHER = new Set([
  "ee89f18bd37f8cce096e42ebbb608a29389fa3f85ef973e133d300da697a89e8",
  "6adf3981c6104b2319bbdf564b87e32ed42770cc821c07e38588f239210f023a",
]);

export async function updateLegacyWeather(record: ModRecord, examples: readonly ModBundle[]): Promise<ModRecord> {
  if (record.manifest.id !== "token-weather") return record;
  const current = examples.find((bundle) => bundle.manifest.id === "token-weather");
  if (!current || current.code === record.code) return record;
  const { manifest: m } = record;
  const serialized = JSON.stringify({
    format: record.format,
    manifest: { apiVersion: m.apiVersion, id: m.id, version: m.version, name: m.name, description: m.description, author: m.author, permissions: [...m.permissions].sort() },
    code: record.code,
  });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  const fingerprint = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!LEGACY_WEATHER.has(fingerprint)) return record;
  const replacement = validateBundle(current);
  // A maintenance fix must never grant additional permissions or change authors.
  if (replacement.manifest.author !== m.author || replacement.manifest.permissions.some((permission) => !m.permissions.includes(permission))) return record;
  return { ...record, ...replacement };
}
