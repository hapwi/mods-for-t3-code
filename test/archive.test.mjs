import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackageWithOptions, extractFile, getRawHeader, uncacheAll } from "@electron/asar";
import { readEntry, replaceEntry, sha256 } from "../src/archive.mjs";
import { patchArchive, restoreArchive } from "../src/install.mjs";

test("patch and restore preserve unrelated entries, native unpacked flags, and exact archive bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-archive-"));
  try {
    const input = path.join(directory, "input");
    await mkdir(path.join(input, "native"), { recursive: true });
    await writeFile(path.join(input, "package.json"), JSON.stringify({ name: "t3-code-desktop", version: "1.0.0", main: "boot.cjs" }));
    await writeFile(path.join(input, "boot.cjs"), 'require("./main.cjs");\n');
    await writeFile(path.join(input, "main.cjs"), "// Unmodified app\n");
    await writeFile(path.join(input, "native", "binding.node"), "native payload");
    const archive = path.join(directory, "app.asar");
    await createPackageWithOptions(input, archive, { unpack: "**/*.node" });
    const originalHash = await sha256(archive);
    const originalHeader = structuredClone(getRawHeader(archive).header);
    const originalMain = extractFile(archive, "main.cjs");
    const state = await patchArchive(archive);
    assert.equal(state.originalHash, originalHash);
    assert.match((await readEntry(archive, "boot.cjs")).toString(), /mods-for-t3-code:v1/);
    assert.match((await readEntry(archive, "boot.cjs")).toString(), /require\("\.\/main\.cjs"\)/);
    uncacheAll();
    assert.deepEqual(extractFile(archive, "main.cjs"), originalMain);
    const newHeader = getRawHeader(archive).header;
    assert.deepEqual(newHeader.files.native, originalHeader.files.native);
    assert.deepEqual(extractFile(archive, "native/binding.node"), Buffer.from("native payload"));
    assert.equal((await patchArchive(archive)).alreadyPatched, true);
    await restoreArchive(archive);
    assert.equal(await sha256(archive), originalHash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("refuse rollback over an updated app", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-restore-"));
  try {
    const input = path.join(directory, "input"); await mkdir(input);
    await writeFile(path.join(input, "package.json"), JSON.stringify({ name: "t3-code-desktop", main: "boot.cjs" }));
    await writeFile(path.join(input, "boot.cjs"), "module.exports={};");
    const archive = path.join(directory, "app.asar");
    await createPackageWithOptions(input, archive, {});
    await patchArchive(archive);
    await writeFile(archive, "updated app");
    await assert.rejects(restoreArchive(archive), /overwrite an update/);
    assert.equal(await readFile(archive, "utf8"), "updated app");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
