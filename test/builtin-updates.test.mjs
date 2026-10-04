import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { updateLegacyWeather } from "../payload/web/builtin-updates.ts";

const legacy = JSON.parse(await readFile(new URL("fixtures/legacy-token-weather.json", import.meta.url), "utf8"));
const current = JSON.parse(await readFile(new URL("../dist/examples.json", import.meta.url), "utf8")).find((bundle) => bundle.manifest.id === "token-weather");

test("upgrade the shipped legacy bundle without re-enabling or clearing fault state", async () => {
  const record = { ...legacy, enabled: false, quarantined: "Existing fault", inboxHash: "reviewed" };
  const updated = await updateLegacyWeather(record, [current]);
  assert.equal(updated.code, current.code);
  assert.deepEqual(updated.manifest, current.manifest);
  assert.equal(updated.enabled, false);
  assert.equal(updated.quarantined, "Existing fault");
  assert.equal(updated.inboxHash, "reviewed");
  assert.equal(await updateLegacyWeather(updated, [current]), updated, "idempotent");
});

test("preserve customized code, metadata, and permissions even under the built-in id", async () => {
  for (const change of [
    { code: legacy.code + "\n// My edit" },
    { manifest: { ...legacy.manifest, description: "My weather" } },
    { manifest: { ...legacy.manifest, version: "1.1.0" } },
    { manifest: { ...legacy.manifest, author: "Me" } },
    { manifest: { ...legacy.manifest, permissions: [...legacy.manifest.permissions, "draft.read"] } },
  ]) {
    const record = { ...legacy, enabled: true, quarantined: null, ...change };
    assert.equal(await updateLegacyWeather(record, [current]), record);
  }
});

test("do not update without a bundled replacement or silently grant permissions", async () => {
  const record = { ...legacy, enabled: true, quarantined: null };
  assert.equal(await updateLegacyWeather(record, []), record);
  const broader = { ...current, manifest: { ...current.manifest, permissions: [...current.manifest.permissions, "draft.read"] } };
  assert.equal(await updateLegacyWeather(record, [broader]), record);
});
