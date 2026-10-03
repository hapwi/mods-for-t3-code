import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { readEntry, sha256 } from "../src/archive.mjs";

const dataRoot = await mkdtemp(path.join(tmpdir(), "t3-mods-data-"));
process.env.MODS_FOR_T3_DATA = dataRoot;
const { patchArchive, restoreArchive, exists, removeStaleOwnedCopy } = await import("../src/install.mjs");
const marker = "/* mods-for-t3-code:v1 */";
const appImageCopyName = /^app(?:-[a-f0-9]{16})?$/;
const managedCopyName = /^managed-(darwin|win32)-[a-f0-9]{16}(?:\.app)?$/;

async function makeArchive(directory, name, version) {
  const input = path.join(directory, `${name}-src`);
  await mkdir(input);
  await writeFile(path.join(input, "package.json"), JSON.stringify({ name: "t3-code-desktop", version, main: "boot.cjs" }));
  await writeFile(path.join(input, "boot.cjs"), `module.exports={version:${JSON.stringify(version)}};`);
  const archive = path.join(directory, name);
  await createPackageWithOptions(input, archive, {});
  return archive;
}

test("a replaced marker-free archive is adopted and can be patched again", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-adopt-"));
  try {
    const archive = await makeArchive(directory, "app.asar", "1.0.0");
    await patchArchive(archive);
    const replacement = await makeArchive(directory, "next.asar", "2.0.0");
    const nextBytes = await readFile(replacement);
    await writeFile(archive, nextBytes);
    const stateFile = `${archive}.mods-for-t3-code.json`;
    const backup = `${archive}.mods-for-t3-code.bak`;
    const preview = await patchArchive(archive, { checkOnly: true });
    assert.equal(preview.appVersion, "2.0.0");
    assert.equal(preview.alreadyPatched, undefined);
    assert.equal(await exists(stateFile), true);
    assert.deepEqual(await readFile(archive), nextBytes);
    const patched = await patchArchive(archive);
    assert.equal(patched.appVersion, "2.0.0");
    assert.equal(patched.originalHash, await sha256(backup));
    assert.match((await readEntry(archive, "boot.cjs")).toString(), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((await patchArchive(archive)).alreadyPatched, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a mismatched modded archive is left unchanged", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-modded-"));
  try {
    const archive = await makeArchive(directory, "app.asar", "1.0.0");
    const other = await makeArchive(directory, "other.asar", "1.1.0");
    await patchArchive(archive);
    await patchArchive(other);
    const modded = await readFile(other);
    await writeFile(archive, modded);
    const backup = await readFile(`${archive}.mods-for-t3-code.bak`);
    await assert.rejects(patchArchive(archive), /backup has been kept/);
    await assert.rejects(restoreArchive(archive), /overwrite an update/);
    assert.deepEqual(await readFile(archive), modded);
    assert.deepEqual(await readFile(`${archive}.mods-for-t3-code.bak`), backup);
    assert.equal(await exists(`${archive}.mods-for-t3-code.json`), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("uninstall keeps an updated upstream archive and drops the stale patch record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-keep-"));
  try {
    const archive = await makeArchive(directory, "app.asar", "1.0.0");
    await patchArchive(archive);
    const replacement = await makeArchive(directory, "next.asar", "2.0.0");
    const nextBytes = await readFile(replacement);
    await writeFile(archive, nextBytes);
    assert.equal(await restoreArchive(archive), path.resolve(archive));
    assert.deepEqual(await readFile(archive), nextBytes);
    assert.equal(await exists(`${archive}.mods-for-t3-code.json`), false);
    assert.equal(await exists(`${archive}.mods-for-t3-code.bak`), false);
    const patched = await patchArchive(archive);
    assert.equal(patched.appVersion, "2.0.0");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("managed copies keep the current and previous install and remove only an older owned copy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-mods-copies-"));
  const outside = await mkdtemp(path.join(tmpdir(), "t3-mods-outside-"));
  try {
    const current = path.join(root, `app-${"c".repeat(16)}`);
    const previous = path.join(root, `app-${"b".repeat(16)}`);
    const stale = path.join(root, `app-${"a".repeat(16)}`);
    const managedCurrent = path.join(root, `managed-darwin-${"c".repeat(16)}.app`);
    const managedPrevious = path.join(root, `managed-win32-${"b".repeat(16)}`);
    const managedStale = path.join(root, `managed-darwin-${"a".repeat(16)}.app`);
    const foreign = path.join(root, `managed-linux-${"d".repeat(16)}`);
    const escaped = path.join(outside, `app-${"e".repeat(16)}`);
    const secret = path.join(outside, "secret");
    for (const directory of [current, previous, stale, managedCurrent, managedPrevious, managedStale, foreign, escaped]) await mkdir(directory);
    await writeFile(secret, "keep");
    const link = path.join(root, `app-${"f".repeat(16)}`);
    await symlink(outside, link);
    assert.equal(await removeStaleOwnedCopy(stale, { root, retain: [current, previous], pattern: appImageCopyName }), true);
    assert.equal(await removeStaleOwnedCopy(managedStale, { root, retain: [managedCurrent, managedPrevious], pattern: managedCopyName }), true);
    assert.equal(await removeStaleOwnedCopy(previous, { root, retain: [current, previous], pattern: appImageCopyName }), false);
    assert.equal(await removeStaleOwnedCopy(foreign, { root, retain: [], pattern: managedCopyName }), false);
    assert.equal(await removeStaleOwnedCopy(escaped, { root, retain: [], pattern: appImageCopyName }), false);
    assert.equal(await removeStaleOwnedCopy(link, { root, retain: [current, previous], pattern: appImageCopyName }), false);
    assert.equal(await exists(stale), false);
    assert.equal(await exists(managedStale), false);
    for (const kept of [current, previous, managedCurrent, managedPrevious, foreign, escaped, link]) assert.equal(await exists(kept), true);
    assert.equal(await readFile(secret, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the windows launcher command sets a custom data directory", async () => {
  const script = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  assert.match(script, /\$safeData = \$dataDirectory\.TrimEnd\('\\'\)\.Replace\('%', '%%'\)/);
  assert.match(script, /set "MODS_FOR_T3_DATA=/);
  assert.match(script, /\$shortcut\.TargetPath = \$launcher/);
});
