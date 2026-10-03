import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPermission, validateBundle, validatePanel, validateBand, usageSnapshot } from "../payload/web/manifest.ts";
const manifest = { apiVersion: 1, id: "test-mod", version: "1.0.0", name: "Test", description: "Test mod", author: "Tester", permissions: ["ui.panels"] };
const bundle = { format: "t3mod/1", manifest, code: "globalThis.T3Mod={activate(){}};" };

test("permission boundaries reject unknown capabilities and unsupported API versions", () => {
  assert.equal(validateBundle(bundle).manifest.id, "test-mod");
  assert.throws(() => validateBundle({ ...bundle, manifest: { ...manifest, permissions: ["exec"] } }), /unsupported permission/);
  assert.throws(() => validateBundle({ ...bundle, manifest: { ...manifest, apiVersion: 2 } }), /supports mod API 1/);
  assert.throws(() => assertPermission(manifest, "draft.read"), /not granted/);
});

test("bundle and panel quotas prevent oversized input", () => {
  assert.throws(() => validateBundle({ ...bundle, code: "a".repeat(1024 * 1024) }), /smaller than 1 MB/);
  assert.throws(() => validatePanel({ title: "Test", actions: Array(9).fill({ id: "a", label: "A" }) }), /up to 8/);
});

test("composer bands allow bounded single-line text and approved tones only", () => {
  assert.deepEqual(validateBand([{ text: "☀ Clear", tone: "yellow" }]), [{ text: "☀ Clear", tone: "yellow" }]);
  assert.throws(() => validateBand([{ text: "two\nlines" }]), /single line/);
  assert.throws(() => validateBand([{ text: "A", tone: "url(external)" }]), /band tone/);
  assert.throws(() => validateBand(Array(17).fill({ text: "A" })), /1–16/);
  assert.throws(() => validateBand([{ text: "a".repeat(160) }, { text: "b".repeat(160) }]), /300/);
});

test("context snapshots never invent a missing window or accept invalid usage", () => {
  assert.equal(usageSnapshot({ threadId: "thread", usedTokens: -1 }), null);
  const measured = usageSnapshot({ threadId: "thread", usedTokens: 134400, measuredAt: 123, privateField: "secret", complete: true });
  assert.equal(measured.maxTokens, null);
  assert.equal(measured.complete, false);
  assert.equal("privateField" in measured, false);
});
