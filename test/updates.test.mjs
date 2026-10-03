import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, selectRelease, upstreamInstallOptions } from "../src/updates.mjs";
import { nativeInstallChanged } from "../src/platform.mjs";

test("updates never downgrade versions or silently move stable users to nightly", () => {
  assert.equal(compareVersions("0.0.46-nightly.20261003.2624", "0.0.46-nightly.20261003.2623"), 1);
  assert.equal(compareVersions("0.0.46", "0.0.46-nightly.20261003.2623"), 1);
  assert.equal(compareVersions("0.0.45", "0.0.46"), -1);
  const releases = [{ tag_name: "v0.0.47-nightly.1", prerelease: true }, { tag_name: "v0.0.46", prerelease: false }, { tag_name: "v0.0.48", draft: true }];
  assert.equal(selectRelease(releases, "0.0.45").tag_name, "v0.0.46");
  assert.equal(selectRelease(releases, "0.0.46-nightly.1").tag_name, "v0.0.47-nightly.1");
  assert.equal(selectRelease(releases, "0.0.47"), undefined);
});

test("nightly, preview, and stable stay on their own channels", () => {
  const releases = [
    { tag_name: "v0.0.46-preview.20261002.2598", prerelease: true },
    { tag_name: "v0.0.46-nightly.20261003.2623", prerelease: true },
    { tag_name: "v0.0.46", prerelease: false },
  ];
  assert.equal(selectRelease(releases, "0.0.46-nightly.20261002.1").tag_name, "v0.0.46-nightly.20261003.2623");
  assert.equal(selectRelease(releases, "0.0.46-preview.20261001.1").tag_name, "v0.0.46-preview.20261002.2598");
  assert.equal(selectRelease(releases, "0.0.45").tag_name, "v0.0.46");
  assert.equal(selectRelease(releases, "0.0.46"), undefined);
  assert.equal(selectRelease(releases, "0.0.46-nightly.20261003.2623"), undefined);
});

test("official mac updates keep the installed app as the native update source", () => {
  const options = upstreamInstallOptions({ original: "/Applications/T3 Code.app", fingerprint: "upstream-asar", originalFingerprint: "installed-asar" });
  assert.deepEqual(options, { original: "/Applications/T3 Code.app", originalFingerprint: "installed-asar" });
  assert.equal(nativeInstallChanged({ fingerprint: "upstream-asar", originalFingerprint: options.originalFingerprint }, "installed-asar"), false);
  assert.equal(nativeInstallChanged({ fingerprint: "upstream-asar", originalFingerprint: "installed-asar" }, "native-asar"), true);
  assert.equal(nativeInstallChanged({ fingerprint: "installed-asar" }, "installed-asar"), false);
  assert.equal(upstreamInstallOptions({ original: "/Applications/T3 Code.app", fingerprint: "installed-asar" }).originalFingerprint, "installed-asar");
});
