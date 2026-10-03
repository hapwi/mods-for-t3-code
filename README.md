# Mods for T3 Code

Live mods inside T3 Code’s Electron interface: a Mods sidebar button, a Settings → Mods section, themes, commands, sidebar panels, and a band above the prompt. MIT licensed and independent of the T3 team.

Inspired by [Anthropic’s Claude Code mods](https://claude.com/blog/claude-code-mods) and its [mods API reference](https://code.claude.com/docs/en/plugins/mods/reference). This is a T3-specific SDK; Claude Code plugins do not install unchanged.

## Install

Install T3 Code first. Close it for the initial installation, then reopen through **Mods for T3 Code**. Installing, creating, updating, enabling, and disabling individual mods afterward takes effect immediately.

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hapwi/mods-for-t3-code/main/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/hapwi/mods-for-t3-code/main/install.ps1 | iex
```

The installer downloads a commit-pinned copy of this repository and uses the committed runtime bundle. If necessary it downloads its own Node 24 runtime and verifies the official SHA-256 checksum. No global npm install is needed.

For an unusual location, download the installer and pass an explicit path:

```sh
curl -fsSL https://raw.githubusercontent.com/hapwi/mods-for-t3-code/main/install.sh -o /tmp/t3-mods-install.sh
sh /tmp/t3-mods-install.sh --appimage /path/to/T3-Code.AppImage
# macOS:
sh /tmp/t3-mods-install.sh --mac-app '/Applications/T3 Code.app'
# Writable Linux Electron installations:
sh /tmp/t3-mods-install.sh --asar /opt/t3-code/resources/app.asar
```

If an AppImage path is a shell shim, choose the actual binary, often `T3-Code.AppImage.real`. Existing custom launchers are preserved.

Windows custom installation:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/hapwi/mods-for-t3-code/main/install.ps1 -OutFile "$env:TEMP\t3-mods-install.ps1"
& "$env:TEMP\t3-mods-install.ps1" -T3Directory 'C:\path\to\T3 Code'
```

## Use

Open the puzzle icon at the bottom of T3’s sidebar, or **Settings → Mods**.

- **Built-in:** install Token Weather, Focus Timer, Prompt Kit, Midnight Theme, or Paper Theme.
- **Installed:** enable, disable, inspect source and permissions, export, update, or remove a mod. New imports start disabled.
- **Create:** describe a mod and put the generated authoring prompt into the current T3 composer. Choose your already logged-in provider/model and send it normally. The agent writes a `.t3mod` bundle to the watched inbox; the manager presents it for review immediately. No separate AI account or API key is required.
- **Development mode:** automatically apply inbox changes to an enabled mod with the same author and no additional permissions. Expanded permissions always require review.
- **Activity:** inspect mod errors and quarantine reasons. **Pause all** stops every mod immediately.

Prompt modifications ask before inserting into the draft and never send it. Multiple theme mods use the last activated theme; disabling it restores the previous theme, and disabling all theme mods restores T3’s colors.

### Token Weather

A compact, colored line above the prompt shows the measured context percentage, tokens used/window size, a last-12-turn sparkline, and the change since the previous completed turn:

```text
☂ Showers  67%  134.4k / 200k  ▁▂▃▄▅▆  ▲ +98.3k last turn
```

Weather thresholds are Clear below 25%, Cloudy below 50%, Showers below 75%, Storm below 90%, and Compact soon at 90% or higher. Measurements refresh as T3 reports them; history advances on completed turns. Compaction can produce a negative change.

Counts come from T3’s normalized provider usage reports, not text-length estimates or account rate limits. Providers and older T3 versions may omit context measurements or window size; the mod explicitly shows an unavailable state. History is separate for each thread.

## Updates and recovery

The patch adds a small bootstrap to the Electron entry point. AppImage, macOS, and Windows installs use a managed copy of the same Electron app and retain the original installation. Writable Linux archive installs can be patched in place with a verified backup.

- The managed launcher checks for changes to the original app on each launch and rebuilds its modded copy. It keeps the current copy and one previous copy.
- macOS additionally checks official T3 GitHub releases, at most once every four hours, downloads a checksum-verified official archive, verifies the upstream app signature, and prepares a locally signed modded copy. Stable installs stay on stable releases. Set `MODS_FOR_T3_UPDATES=off` to use only updates to your original installation.
- T3’s updater is not intercepted or disabled. If compatibility checks fail, managed launchers open the original T3 app and retain your mod data.
- The managed command also reapplies in-place Linux patches before launch. If you use the original shortcut after an update removes the bootstrap, rerun the installer or start through Mods for T3 Code. It adopts the clean updated archive and creates a fresh backup. Uninstall never restores an older backup over an updated app.
- Mods declare SDK API version 1. Failed or stalled mods are stopped and quarantined. Future changes to T3’s DOM, provider protocol, signing, or updater may require a host update; automatic compatibility with arbitrary future versions cannot be guaranteed. Rerun the installation command to update this host.

The installer prints the command path. Typical paths:

| Platform | Command |
| --- | --- |
| Linux | `~/.local/share/mods-for-t3-code/tools/mods-for-t3-code` |
| macOS | `~/Library/Application Support/Mods for T3 Code/tools/mods-for-t3-code` |
| Windows | `%APPDATA%\Mods for T3 Code\tools\mods-for-t3-code.cmd` |

Use that command with `doctor`, `safe-mode on`, `safe-mode off`, or `uninstall`. For a direct archive install, pass `uninstall --asar /path/to/app.asar`. Close the managed app before uninstalling. Uninstall removes its managed copies or restores the archive and keeps private mod data; the tool and shortcut can be removed separately.

`T3_MODS_DISABLE=1` bypasses the host on launch. Safe mode loads the manager without running any mod code. For immediate recovery in a running app, use **Pause all**.

macOS’s managed copy is ad-hoc signed. macOS may require renewed app permissions or Keychain access, which can affect existing provider sign-ins. Windows’s modified managed executable loses its publisher signature. The original signed app remains available. The installer does not turn off Gatekeeper, Electron’s sandbox, ASAR validation, or security fuses.

## Build and share a mod

Clone this repository and run `npm ci`. Start from a directory under `examples/`. Each mod has `mod.json` and a JS/TS entry exporting `activate(api)`:

```js
export async function activate(api) {
  await api.panels.set({ title: 'Hello', body: 'A small addition to T3.' });
}
```

Declare `ui.panels` in the manifest’s `permissions`. Bundle and validate:

```sh
node bin/cli.mjs pack examples/focus-timer --out focus-timer.t3mod
node bin/cli.mjs validate focus-timer.t3mod
```

Share the `.t3mod` file. Recipients import it from the manager, inspect permissions/source, and enable it. Files in the inbox follow the same review flow. SDK types are in [sdk.d.ts](sdk.d.ts); authoring examples are in [examples](examples).

Mod code runs in isolated workers inside opaque sandboxed iframes. It has no direct access to Electron, Node, the app DOM, network, provider credentials, or T3’s database. Host capabilities are checked on every call. UI uses bounded text and approved theme tokens; private storage is limited to 64 KB per mod. This is a practical isolation layer, not a guarantee against browser vulnerabilities.

Mod settings and storage use their own IndexedDB database in T3’s renderer profile. Installer metadata, the inbox, and managed copies live under the command’s data directory; override it with `MODS_FOR_T3_DATA` before installing.

## Development and validation

```sh
npm ci
npm run build
npm run pack:examples
npm run demo
# In a second terminal:
node scripts/browser-check.mjs
```

`dist/` is committed so end-user installations need no build toolchain. Regenerate it when runtime or bundled mods change. Focused archive, manifest, telemetry, and update tests live under `test/`; set `MODS_FOR_T3_DATA` to a temporary directory when running installer tests.

Linux archive patching and AppImage extraction were exercised against T3 `0.0.46-nightly.20261003.2623`. Browser integration exercises the actual renderer/worker host in a small fixture with T3 selectors and CSP. macOS signing, Windows installation, and their native updater flows still require platform testing; platform support is implemented but should be treated as experimental until those checks are completed.

See [architecture](docs/architecture.md), [changelog](CHANGELOG.md), and [license](LICENSE).
