export const API_VERSION = 1;
export const MAX_BUNDLE_BYTES = 1024 * 1024;
export const PERMISSIONS = Object.freeze({
  "ui.panels": "Show text panels and buttons in the Mods tray",
  "ui.commands": "Register local commands in the Mods command palette",
  "ui.notify": "Show notifications labeled with the mod name",
  "ui.theme": "Apply a color theme across the T3 interface",
  "ui.band": "Show one line of styled text above the composer",
  "session.usage": "Read measured context usage for the open thread",
  "app.route": "Read the current app route and follow navigation",
  "draft.read": "Read the current composer draft",
  "draft.insert": "Offer text to paste into the composer, with your confirmation",
  storage: "Store up to 64 KB of private mod data",
});

export function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A mod needs a manifest object.");
  if (value.apiVersion !== API_VERSION) throw new Error(`This host supports mod API ${API_VERSION}.`);
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(value.id)) throw new Error("Mod ID must be 2–64 lowercase letters, digits, or hyphens.");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)) throw new Error("Use a SemVer version, for example 1.0.0.");
  for (const field of ["name", "description", "author"]) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > (field === "description" ? 600 : 100)) throw new Error(`Supply a short ${field}.`);
  }
  if (!Array.isArray(value.permissions) || value.permissions.some((p) => !Object.hasOwn(PERMISSIONS, p))) throw new Error("The manifest contains an unsupported permission.");
  if (new Set(value.permissions).size !== value.permissions.length) throw new Error("Permissions must be unique.");
  return { apiVersion: API_VERSION, id: value.id, version: value.version, name: value.name, description: value.description, author: value.author, permissions: [...value.permissions] };
}

export function validateBundle(value) {
  const manifest = validateManifest(value?.manifest);
  if (value.format !== "t3mod/1" || typeof value.code !== "string" || !value.code.trim()) throw new Error("Choose a .t3mod bundle made with the pack command.");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BUNDLE_BYTES) throw new Error("A mod bundle must be smaller than 1 MB.");
  return { format: "t3mod/1", manifest, code: value.code };
}

export function assertPermission(manifest, permission) {
  if (!manifest.permissions.includes(permission)) throw new Error(`Permission not granted: ${permission}`);
}

export function textValue(value, limit = 4000) {
  if (typeof value !== "string" || value.length > limit) throw new Error(`Expected text of at most ${limit} characters.`);
  return value;
}

export function validatePanel(value) {
  if (!value || typeof value !== "object") throw new Error("Expected a panel.");
  const title = textValue(value.title, 100);
  const body = textValue(value.body ?? "", 10000);
  if (!Array.isArray(value.actions ?? []) || (value.actions ?? []).length > 8) throw new Error("A panel can contain up to 8 actions.");
  const actions = (value.actions ?? []).map((action) => ({ id: textValue(action.id, 64), label: textValue(action.label, 80) }));
  return { title, body, actions };
}

export const BAND_TONES = Object.freeze(["default", "muted", "yellow", "cyan", "blue", "magenta", "red"]);

export function validateBand(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("A band needs 1–16 text parts.");
  let total = 0;
  const parts = value.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("Each band part needs text.");
    const text = textValue(part.text, 160);
    // Plain single-line text only: rendered with textContent, never as markup.
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) throw new Error("Band text must be a single line without control characters.");
    const tone = part.tone ?? "default";
    if (!BAND_TONES.includes(tone)) throw new Error(`Use a band tone: ${BAND_TONES.join(", ")}.`);
    total += text.length; return { text, tone };
  });
  if (total > 300) throw new Error("A band can show up to 300 characters.");
  return parts;
}

// Normalizes a trusted telemetry snapshot. Unknown values stay null; nothing is guessed.
export function usageSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const id = (item) => typeof item === "string" && item.length > 0 && item.length <= 300 ? item : null;
  const threadId = id(value.threadId);
  if (!threadId || !Number.isSafeInteger(value.usedTokens) || value.usedTokens < 0) return null;
  const turnId = id(value.turnId);
  return {
    threadId, turnId, usedTokens: value.usedTokens,
    maxTokens: Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0 ? value.maxTokens : null,
    measuredAt: Number.isFinite(value.measuredAt) ? value.measuredAt : Date.now(),
    complete: value.complete === true && turnId !== null,
  };
}
