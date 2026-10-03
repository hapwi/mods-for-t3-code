// Release selection stays on one channel. Nightly does not take preview builds,
// and stable does not take prereleases. macOS launch does not download a
// replacement app; Squirrel is left enabled and is not verified here.
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

export function releaseChannel(version) {
  const match = String(version).replace(/^v/, "").match(/^\d+\.\d+\.\d+(?:-([0-9A-Za-z]+))?/);
  if (!match?.[1]) return "stable";
  return match[1];
}

export function selectRelease(releases, current) {
  const channel = releaseChannel(current);
  return (releases || []).filter((release) => {
    if (!release || release.draft || !release.tag_name) return false;
    if (releaseChannel(release.tag_name) !== channel) return false;
    return compareVersions(release.tag_name, current) > 0;
  }).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
}

// The installed app remains the update source. A downloaded archive is not
// substituted for it.
export function upstreamInstallOptions(record) {
  return { original: record.original, originalFingerprint: record.originalFingerprint ?? record.fingerprint };
}
