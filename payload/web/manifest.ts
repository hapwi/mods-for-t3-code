import type { BandPart, BandTone, ContextBreakdown, ModBundle, ModManifest, Permission, UsageSnapshot } from "../../sdk.d.ts";

export const API_VERSION = 1;
export const MAX_BUNDLE_BYTES = 1024 * 1024;
export const PERMISSIONS: { readonly [P in Permission]: string } = Object.freeze({
  "ui.panels": "Show text panels and buttons in the Mods tray",
  "ui.commands": "Register local commands in the Mods command palette",
  "ui.notify": "Show notifications labeled with the mod name",
  "ui.theme": "Apply a color theme across the T3 interface",
  "ui.band": "Show one line of styled text above the composer",
  "ui.context": "Show a context usage ring and token breakdown above the composer",
  "session.usage": "Read measured context usage for the open thread",
  "app.route": "Read the current app route and follow navigation",
  "draft.read": "Read the current composer draft",
  "draft.insert": "Offer text to paste into the composer, with your confirmation",
  storage: "Store up to 64 KB of private mod data",
});

function read(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function safeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.hasOwn(PERMISSIONS, value);
}

export function validateManifest(value: unknown): ModManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A mod needs a manifest object.");
  if (read(value, "apiVersion") !== API_VERSION) throw new Error(`This host supports mod API ${API_VERSION}.`);
  const id = read(value, "id");
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error("Mod ID must be 2–64 lowercase letters, digits, or hyphens.");
  const version = read(value, "version");
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Use a SemVer version, for example 1.0.0.");
  const text: { [field: string]: string } = {};
  for (const field of ["name", "description", "author"]) {
    const item = read(value, field);
    if (typeof item !== "string" || !item.trim() || item.length > (field === "description" ? 600 : 100)) throw new Error(`Supply a short ${field}.`);
    text[field] = item;
  }
  const permissions = read(value, "permissions");
  if (!Array.isArray(permissions) || !permissions.every(isPermission)) throw new Error("The manifest contains an unsupported permission.");
  if (new Set(permissions).size !== permissions.length) throw new Error("Permissions must be unique.");
  const name = text.name;
  const description = text.description;
  const author = text.author;
  if (name === undefined || description === undefined || author === undefined) throw new Error("Supply a short name.");
  return { apiVersion: API_VERSION, id, version, name, description, author, permissions: [...permissions] };
}

export function validateBundle(value: unknown): ModBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Import a complete .t3mod JSON bundle returned by Create or exported from Mods.");
  const manifest = validateManifest(read(value, "manifest"));
  const code = read(value, "code");
  if (read(value, "format") !== "t3mod/1" || typeof code !== "string" || !code.trim()) throw new Error("This file needs format t3mod/1 and its complete JavaScript code. Ask your AI to return the full bundle, not a CLI plugin or source file.");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BUNDLE_BYTES) throw new Error("A mod bundle must be smaller than 1 MB.");
  return { format: "t3mod/1", manifest, code };
}

export function assertPermission(manifest: ModManifest, permission: Permission): void {
  if (!manifest.permissions.includes(permission)) throw new Error(`Permission not granted: ${permission}`);
}

export function textValue(value: unknown, limit = 4000): string {
  if (typeof value !== "string" || value.length > limit) throw new Error(`Expected text of at most ${limit} characters.`);
  return value;
}

export interface PanelView { title: string; body: string; actions: { id: string; label: string }[] }

export function validatePanel(value: unknown): PanelView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a panel.");
  const title = textValue(read(value, "title"), 100);
  const bodyField = read(value, "body");
  const body = textValue(bodyField == null ? "" : bodyField, 10000);
  const rawActions = read(value, "actions") ?? [];
  if (!Array.isArray(rawActions) || rawActions.length > 8) throw new Error("A panel can contain up to 8 actions.");
  const actions = rawActions.map((action: unknown) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("Expected text of at most 64 characters.");
    return { id: textValue(read(action, "id"), 64), label: textValue(read(action, "label"), 80) };
  });
  return { title, body, actions };
}

export const BAND_TONES: readonly BandTone[] = ["default", "muted", "yellow", "cyan", "blue", "magenta", "red"];

function isBandTone(value: unknown): value is BandTone {
  return typeof value === "string" && BAND_TONES.some((tone) => tone === value);
}

export function validateBand(value: unknown): BandPart[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("A band needs 1–16 text parts.");
  let total = 0;
  const parts = value.map((part: unknown) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("Each band part needs text.");
    const text = textValue(read(part, "text"), 160);
    // Plain single-line text only: rendered with textContent, never as markup.
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) throw new Error("Band text must be a single line without control characters.");
    const tone = read(part, "tone") ?? "default";
    if (!isBandTone(tone)) throw new Error(`Use a band tone: ${BAND_TONES.join(", ")}.`);
    total += text.length;
    return { text, tone };
  });
  if (total > 300) throw new Error("A band can show up to 300 characters.");
  return parts;
}

// Normalizes a trusted telemetry snapshot. Unknown values stay null; nothing is guessed.
export function usageSnapshot(value: unknown): UsageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const id = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 300 ? item : null;
  const threadId = id(read(value, "threadId"));
  const usedTokens = read(value, "usedTokens");
  if (!threadId || !safeInt(usedTokens) || usedTokens < 0) return null;
  const turnId = id(read(value, "turnId"));
  const maxTokens = read(value, "maxTokens");
  const measuredAt = read(value, "measuredAt");
  const breakdown = contextBreakdown(read(value, "breakdown"), usedTokens);
  return {
    threadId,
    turnId,
    usedTokens,
    maxTokens: safeInt(maxTokens) && maxTokens > 0 ? maxTokens : null,
    measuredAt: typeof measuredAt === "number" && Number.isFinite(measuredAt) ? measuredAt : Date.now(),
    complete: read(value, "complete") === true && turnId !== null,
    ...(breakdown ? { breakdown } : {}),
  };
}

export function contextBreakdown(value: unknown, usedTokens: number): ContextBreakdown | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: ContextBreakdown = {};
  let total = 0;
  for (const key of ["systemPrompt", "toolDefinitions", "rules", "skills", "mcpTools", "summarizedConversation", "conversation"] as const) {
    const count = read(value, key);
    if (count === undefined) continue;
    if (!safeInt(count) || count < 0) return undefined;
    result[key] = count; total += count;
  }
  return Object.keys(result).length && total <= usedTokens ? result : undefined;
}
