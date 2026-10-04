#!/bin/sh
set -eu
installer_action=install
if [ "${1-}" = "--prepare-update" ]; then
  installer_action=prepare-update
  shift
fi

# Install only this tool into its own cache. Never replace node, npm, T3's
# launcher, provider configs, or shell startup files.
repository="hapwi/mods-for-t3-code"
case "$(uname -s)" in
  Linux) node_platform=linux; data_dir="${MODS_FOR_T3_DATA:-${XDG_DATA_HOME:-${HOME}/.local/share}/mods-for-t3-code}" ;;
  Darwin) node_platform=darwin; data_dir="${MODS_FOR_T3_DATA:-${HOME}/Library/Application Support/Mods for T3 Code}" ;;
  *) printf '%s\n' 'Use install.ps1 on Windows.' >&2; exit 1 ;;
esac
tools_dir="${data_dir}/tools"
mkdir -p "$tools_dir"
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) printf '%s\n' 'This installer supports x86_64 and arm64.' >&2; exit 1 ;;
esac
command -v curl >/dev/null || { printf '%s\n' 'curl is required.' >&2; exit 1; }
command -v tar >/dev/null || { printf '%s\n' 'tar is required.' >&2; exit 1; }
node_bin="$(command -v node || true)"
if [ -z "$node_bin" ] || ! "$node_bin" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22 || major===22 && minor>=18 ? 0:1)' 2>/dev/null; then
  printf '%s\n' 'Downloading a private Node 24 runtime for the patch tool…'
  node_work="$(mktemp -d "$tools_dir/node-download.XXXXXX")"
  trap 'rm -rf "$node_work"' EXIT HUP INT TERM
  curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$node_work/checksums"
  node_archive="$(awk -v suffix="${node_platform}-${node_arch}.tar.xz" '$2 ~ suffix"$" { print $2; exit }' "$node_work/checksums")"
  [ -n "$node_archive" ] || { printf '%s\n' 'Node download unavailable.' >&2; exit 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/${node_archive}" -o "$node_work/$node_archive"
  if command -v sha256sum >/dev/null; then
    (cd "$node_work"; awk -v file="$node_archive" '$2 == file' checksums | sha256sum -c -)
  else
    (cd "$node_work"; awk -v file="$node_archive" '$2 == file' checksums | shasum -a 256 -c -)
  fi
  tar -xJf "$node_work/$node_archive" -C "$node_work"
  node_extracted="${node_archive%.tar.xz}"
  if [ ! -d "$tools_dir/$node_extracted" ]; then mv "$node_work/$node_extracted" "$tools_dir/$node_extracted"; fi
  node_bin="$tools_dir/$node_extracted/bin/node"
  rm -rf "$node_work"
  trap - EXIT HUP INT TERM
fi

download="$(mktemp -d "$tools_dir/install.XXXXXX")"
trap 'rm -rf "$download"' EXIT HUP INT TERM
printf '%s\n' 'Downloading Mods for T3 Code…'
curl -fsSL "https://api.github.com/repos/${repository}/commits/main" -o "$download/commit.json"
revision="$("$node_bin" -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-f0-9]{40}$/.test(r.sha))process.exit(1);console.log(r.sha)' "$download/commit.json")"
curl -fsSL "https://codeload.github.com/${repository}/tar.gz/${revision}" -o "$download/source.tar.gz"
tar -xzf "$download/source.tar.gz" -C "$download"
source="$download/mods-for-t3-code-$revision"
tool="$tools_dir/package-$revision"
if [ ! -d "$tool" ]; then
  runtime_package="$download/runtime-package"
  mkdir "$runtime_package"
  cp -R "$source/dist" "$runtime_package/dist"
  cp "$source/package.json" "$source/LICENSE" "$runtime_package/"
  mv "$runtime_package" "$tool"
fi
"$node_bin" "$tool/dist/cli.mjs" "$installer_action" "$@"
launcher="$tools_dir/mods-for-t3-code"
"$node_bin" -e 'const fs=require("fs");const q=s=>"\x27"+s.replaceAll("\x27","\x27\\\x27\x27")+"\x27";fs.writeFileSync(process.argv[1],"#!/bin/sh\nexport MODS_FOR_T3_DATA="+q(process.argv[4])+"\nexec "+q(process.argv[2])+" "+q(process.argv[3])+" \"$@\"\n",{mode:0o755})' "$launcher" "$node_bin" "$tool/dist/cli.mjs" "$data_dir"
if [ "$installer_action" = prepare-update ]; then
  printf '\nMaintenance command: %s\n' "$launcher"
  printf '%s\n' 'Open T3 using its normal icon and update through T3. Private mod data is preserved.'
  exit 0
fi
# Retire only the shortcut created by earlier versions of this installer.
# The existing T3 icon continues to open the patched installed app.
"$node_bin" --input-type=module - "$node_platform" "$launcher" <<'CLEANUP'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [kind, launcher] = process.argv.slice(2);
try {
  if (kind === 'darwin') {
    const app = path.join(os.homedir(), 'Applications', 'Mods for T3 Code.app');
    const script = fs.readFileSync(path.join(app, 'Contents/MacOS/launch'), 'utf8');
    const plist = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
    if (plist.includes('<string>dev.hapwi.mods-for-t3-code.launcher</string>') && script.includes(launcher)) fs.rmSync(app, { recursive: true });
  } else {
    const shortcut = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'applications/mods-for-t3-code.desktop');
    const content = fs.readFileSync(shortcut, 'utf8');
    if (content.includes('Name=Mods for T3 Code\n') && content.includes(launcher)) fs.rmSync(shortcut);
  }
} catch (error) { if (error.code !== 'ENOENT') console.warn(`Old Mods shortcut was kept: ${error.message}`); }
CLEANUP
# Keep the user's ordinary T3 icon and launch path. This is a maintenance
# command, not another application or desktop shortcut.
printf '\nMaintenance command: %s\n' "$launcher"
printf '%s\n' 'Use your existing T3 Code app and its normal icon.'
printf '%s\n' 'Find the Mods icon in the sidebar or Settings → Mods. Mod changes apply live.'
