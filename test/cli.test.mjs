import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions } from "@electron/asar";
import { readEntry } from "../src/archive.ts";
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

test("direct Linux CLI remembers install, reapplies after upstream update, and restores current version", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-cli-"));
  try {
    const resources = path.join(directory, "app", "resources"); await mkdir(resources, { recursive: true });
    const archive = path.join(resources, "app.asar");
    const input = path.join(directory, "input"); await mkdir(input);
    async function upstream(version) {
      await writeFile(path.join(input, "package.json"), JSON.stringify({ name: "t3-code-desktop", version, main: "boot.cjs" }));
      await writeFile(path.join(input, "boot.cjs"), `module.exports=${JSON.stringify(version)};`);
      await createPackageWithOptions(input, archive, {});
    }
    await upstream("1.0.0");
    const executable = path.join(directory, "app", "t3code");
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "$1" > "$MODS_FOR_T3_DATA/launch-arg"\n', { mode: 0o700 });
    const data = path.join(directory, "data");
    const env = { ...process.env, MODS_FOR_T3_DATA: data };
    await execute(process.execPath, [cli, "install", "--asar", archive], { env });
    assert.equal(JSON.parse(await readFile(path.join(data, "archive.json"))).archive, archive);
    await upstream("2.0.0");
    await execute(process.execPath, [cli, "launch", "--", "--fixture-arg"], { env });
    assert.match((await readEntry(archive, "boot.cjs")).toString(), /mods-for-t3-code:v1/);
    assert.equal(await readFile(path.join(data, "launch-arg"), "utf8"), "--fixture-arg");
    await execute(process.execPath, [cli, "uninstall"], { env });
    assert.equal((await readEntry(archive, "boot.cjs")).toString(), 'module.exports="2.0.0";');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
