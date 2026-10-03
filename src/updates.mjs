import { readFile, writeFile, mkdir, readdir, chmod, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { dataRoot, exists, command } from "./install.mjs";
import { sha256 } from "./archive.mjs";

export function compareVersions(a, b) {
  const parse = (value) => String(value).replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/);
  const first = parse(a), second = parse(b);
  if (!first || !second) return 0;
  for (let index = 1; index <= 3; index++) if (+first[index] !== +second[index]) return Math.sign(+first[index] - +second[index]);
  if (!first[4] || !second[4]) return first[4] === second[4] ? 0 : first[4] ? -1 : 1;
  const left = first[4].split("."), right = second[4].split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    if (left[index] === undefined || right[index] === undefined) return left[index] === undefined ? -1 : 1;
    if (/^\d+$/.test(left[index]) && /^\d+$/.test(right[index])) return Math.sign(+left[index] - +right[index]);
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function selectRelease(releases, current) {
  const nightly = current.includes("nightly");
  return releases.filter((release) => !release.draft && (nightly || !release.prerelease) && compareVersions(release.tag_name, current) > 0).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
}

// The managed copy is ad-hoc signed, so it cannot take Squirrel's publisher update.
// Download a pristine official app for that copy, and keep tracking the user's install.
export function upstreamInstallOptions(record) {
  return { original: record.original, originalFingerprint: record.originalFingerprint ?? record.fingerprint };
}

export async function macUpdate(record) {
  if (process.env.MODS_FOR_T3_UPDATES === "off") return record;
  const cacheFile = path.join(dataRoot, "update-check.json");
  const cache = await exists(cacheFile) ? JSON.parse(await readFile(cacheFile, "utf8")) : {};
  if (Date.now() - (cache.checkedAt || 0) < 4 * 60 * 60 * 1000) return record;
  const response = await fetch("https://api.github.com/repos/pingdotgg/t3code/releases?per_page=30", { headers: { Accept: "application/vnd.github+json", "User-Agent": "Mods-for-T3-Code" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Upstream update check returned ${response.status}.`);
  const release = selectRelease(await response.json(), record.appVersion);
  if (!release) { await writeFile(cacheFile, JSON.stringify({ checkedAt: Date.now() })); return record; }
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const asset = release.assets.find((item) => new RegExp(`^T3-Code-.+-${architecture}\\.zip$`).test(item.name));
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) throw new Error(`T3 ${release.tag_name} has no verifiable macOS archive. Update the original T3 app; the launcher will refresh its copy.`);
  console.log(`Downloading official T3 ${release.tag_name} for macOS…`);
  const pristine = path.join(dataRoot, "upstream", asset.digest.slice(7, 23));
  await mkdir(pristine, { recursive: true });
  const zip = path.join(pristine, "upstream.zip");
  if (!await exists(zip) || await sha256(zip) !== asset.digest.slice(7)) {
    const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) });
    if (!download.ok || !download.body) throw new Error("Official update download failed.");
    await pipeline(Readable.fromWeb(download.body), createWriteStream(zip));
    if (await sha256(zip) !== asset.digest.slice(7)) throw new Error("Official update checksum mismatch. Update not applied.");
  }
  const extracted = path.join(pristine, "app");
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await command("/usr/bin/ditto", ["-x", "-k", zip, extracted]);
  const apps = (await readdir(extracted)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error("Official archive does not contain one macOS app. Update not applied.");
  const { installPlatform } = await import("./platform.mjs");
  const options = upstreamInstallOptions(record);
  const source = path.join(extracted, apps[0]);
  const updated = await installPlatform(source, "darwin", options);
  if (path.resolve(updated.original) !== path.resolve(options.original)) throw new Error("Official update must keep the existing T3 installation.");
  if (!path.resolve(updated.original).startsWith(`${path.resolve(extracted)}${path.sep}`)) await rm(extracted, { recursive: true, force: true });
  await writeFile(cacheFile, JSON.stringify({ checkedAt: Date.now() }));
  return updated;
}
