import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPlatform } from "../src/platform.ts";

test("detect current macOS Alpha bundle and user Applications bundle names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-detect-"));
  const applications = path.join(directory, "Applications"), home = path.join(directory, "home");
  try {
    // A similarly named launcher without an Electron archive must be skipped.
    await mkdir(path.join(applications, "T3 Code.app"), { recursive: true });
    const alpha = path.join(applications, "T3 Code (Alpha).app");
    await mkdir(path.join(alpha, "Contents", "Resources"), { recursive: true });
    await writeFile(path.join(alpha, "Contents", "Resources", "app.asar"), "fixture");
    assert.equal(await detectPlatform({ kind: "darwin", home, applications }), alpha);
    await rm(alpha, { recursive: true });
    const userApp = path.join(home, "Applications", "T3.app");
    await mkdir(path.join(userApp, "Contents", "Resources"), { recursive: true });
    await writeFile(path.join(userApp, "Contents", "Resources", "app.asar"), "fixture");
    assert.equal(await detectPlatform({ kind: "darwin", home, applications }), userApp);
    await rm(userApp, { recursive: true });
    await assert.rejects(detectPlatform({ kind: "darwin", home, applications }), error => error.message.includes(applications) && error.message.includes("--mac-app") && !error.message.includes("--windows-dir"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("detect Windows Alpha installation under local Programs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "t3-mods-detect-win-"));
  try {
    const app = path.join(directory, "Programs", "T3 Code (Alpha)");
    await mkdir(path.join(app, "resources"), { recursive: true });
    await writeFile(path.join(app, "resources", "app.asar"), "fixture");
    assert.equal(await detectPlatform({ kind: "win32", localAppData: directory, programFiles: path.join(directory, "Program Files") }), app);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
