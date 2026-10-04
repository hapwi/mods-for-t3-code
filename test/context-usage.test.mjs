import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBreakdown, usageSnapshot, validateManifest } from "../payload/web/manifest.ts";
import { formatContextTokens } from "../payload/web/context-usage.ts";
import { readFile } from "node:fs/promises";
import { line } from "../examples/token-weather/mod.ts";

test("context usage permissions and token formatting", async () => {
  const manifest = JSON.parse(await readFile(new URL("../examples/context-usage/mod.json", import.meta.url)));
  assert.deepEqual(validateManifest(manifest).permissions, ["ui.context", "session.usage"]);
  assert.equal(formatContextTokens(0), "0");
  assert.equal(formatContextTokens(229900), "229.9K");
  assert.equal(formatContextTokens(256000), "256K");
});

test("breakdowns preserve missing vs zero and reject misleading totals", () => {
  assert.equal(contextBreakdown(undefined, 100), undefined);
  assert.equal(contextBreakdown({ conversation: 101 }, 100), undefined);
  assert.equal(contextBreakdown({ rules: -1 }, 100), undefined);
  assert.equal(contextBreakdown({ skills: 1.5 }, 100), undefined);
  assert.deepEqual(contextBreakdown({ rules: 0, conversation: 80, privateText: "never exposed" }, 100), { rules: 0, conversation: 80 });
  const snapshot = usageSnapshot({ threadId: "thread", usedTokens: 100, breakdown: { rules: 0, skills: 25 } });
  assert.deepEqual(snapshot.breakdown, { rules: 0, skills: 25 });
  assert.equal(snapshot.breakdown.systemPrompt, undefined);
});

test("Token Weather retains measured usage and deltas without a sparkline", () => {
  const parts = line({ threadId: "thread", turnId: "turn", usedTokens: 24976, maxTokens: 258400, complete: true, measuredAt: 0 }, [24300, 24976]);
  const text = parts.map(part => part.text).join("");
  assert.equal(parts[0].tone, "yellow");
  assert.match(text, /Clear.*9%.*25k \/ 258.4k.*\+676 last turn/);
  assert.doesNotMatch(text, /[▁▂▃▄▅▆▇█]/);
});
