import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NtExecutable, NtExecutableResource } from "resedit";
import { update } from "../src/windows-resources.mjs";

test("Windows patch writes Electron integrity resource and retains unrelated resources", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-pe-"));
  try {
    const executable = NtExecutable.createEmpty(false, false);
    const resources = NtExecutableResource.from(executable);
    const unrelated = new TextEncoder().encode("unrelated resource").buffer;
    resources.entries.push({ type: "CUSTOM", id: "KEEP", lang: 1033, codepage: 1200, bin: unrelated });
    resources.outputResource(executable);
    const file = path.join(directory, "fixture.exe");
    await writeFile(file, Buffer.from(executable.generate()));
    const digest = "a".repeat(64);
    await update(file, digest);
    const patched = NtExecutableResource.from(NtExecutable.from(await readFile(file)));
    assert.equal(new TextDecoder().decode(patched.entries.find(value => value.type === "CUSTOM").bin), "unrelated resource");
    const integrity = patched.entries.find(value => value.type === "INTEGRITY" && value.id === "ELECTRONASAR");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(integrity.bin)), [{ file: "resources\\app.asar", alg: "sha256", value: digest }]);
    await update(file, "b".repeat(64));
    const next = NtExecutableResource.from(NtExecutable.from(await readFile(file)));
    assert.equal(next.entries.filter(value => value.type === "INTEGRITY").length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
