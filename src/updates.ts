// Release selection stays on one channel. Nightly does not take preview builds,
// and stable does not take prereleases. macOS launch does not download a
// replacement app; Squirrel is left enabled and is not verified here.
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): RegExpMatchArray | null => String(value).replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/);
  const first = parse(a), second = parse(b);
  if (!first || !second) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const left = Number(first[index]);
    const right = Number(second[index]);
    if (left !== right) return Math.sign(left - right);
  }
  const leftPre = first[4];
  const rightPre = second[4];
  if (!leftPre || !rightPre) return leftPre === rightPre ? 0 : leftPre ? -1 : 1;
  const left = leftPre.split(".");
  const right = rightPre.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    if (left[index] === undefined || right[index] === undefined) return left[index] === undefined ? -1 : 1;
    if (/^\d+$/.test(left[index]) && /^\d+$/.test(right[index])) return Math.sign(Number(left[index]) - Number(right[index]));
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function releaseChannel(version: string): string {
  const match = String(version).replace(/^v/, "").match(/^\d+\.\d+\.\d+(?:-([0-9A-Za-z]+))?/);
  if (!match?.[1]) return "stable";
  return match[1];
}

export interface ReleaseTag {
  draft?: boolean;
  tag_name?: string;
}

export function selectRelease<Release extends ReleaseTag>(releases: readonly (Release | null | undefined)[] | null | undefined, current: string): Release | undefined {
  const channel = releaseChannel(current);
  return (releases ?? []).filter((release): release is Release => {
    if (!release || release.draft || !release.tag_name) return false;
    if (releaseChannel(release.tag_name) !== channel) return false;
    return compareVersions(release.tag_name, current) > 0;
  }).sort((left, right) => compareVersions(right.tag_name ?? "", left.tag_name ?? ""))[0];
}

// The installed app remains the update source. A downloaded archive is not
// substituted for it.
export function upstreamInstallOptions(record: { original: string; originalFingerprint?: string; fingerprint?: string }): { original: string; originalFingerprint: string | undefined } {
  return { original: record.original, originalFingerprint: record.originalFingerprint ?? record.fingerprint };
}
