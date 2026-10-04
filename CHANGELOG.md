# Changelog

## [Unreleased]

### Added

- Add macOS `prepare-update` recovery, available directly through curl with `--prepare-update`, to restore the verified vendor-signed app while T3 is closed, preserving private mod data and refusing to overwrite upstream replacements; native updater compatibility remains unverified.
- Bundle an installable Context Usage mod with a native composer ring, clickable token inspector, segmented category bar, and explicit unavailable counts when T3 reports only totals; restore the original meter when disabled.
- Add an original image-generated puzzle favicon for the project and its demo.

- Add Edit for installed and built-in mods, drafting changes with the current source into the existing T3 chat and returning edited versions through mod review.
- Install the Patcher changelog policy for ongoing changes and explicitly authorized releases.
- Add the MIT-licensed Mods for T3 Code host, sidebar and Settings entries, live mod management, commands, panels, permission review, and isolated worker runtimes.
- Create mods through the current T3 composer and provider account, with a watched inbox for immediate import review.
- Add Linux/macOS curl and Windows PowerShell installers, reversible installed-app patches, integrity checks, safe mode, and a typed SDK.
- Add live theme tokens, built-in theme/timer/prompt examples, permission-aware author hot reload, and persistent inbox review decisions.
- Observe measured context usage and turn completion through a read-only preload supporting current and earlier T3 event formats.
- Add Token Weather above the prompt with live weather thresholds, measured token counts, a 12-turn sparkline, and per-thread completed-turn deltas.
- Document installation, mod authoring, architecture, recovery, updates, and native-platform validation limits.
- Record the published Linux curl installer and isolated Electron telemetry checks, and clarify native platform discovery guidance.
- Include the license notices for dependencies bundled into the Windows resource helper.

### Changed

- Retain only the compiled runtime and maintenance files on new curl/PowerShell installations; remove the temporary source download after installation.
- Limit the Built-in catalog to Context Usage and Token Weather; remove Token Weather’s text sparkline bar while keeping measured usage and completed-turn deltas.

- Convert production code, example mods, the SDK and development scripts to strict TypeScript; ship the compiled CLI at `dist/cli.mjs` so end-user installation needs no compiler or npm dependencies.

### Fixed

- Hide Token Weather before context measurements arrive and omit the first-turn delta placeholder; show a delta only after two completed measured turns.
- Give composer bands an opaque theme background that masks scrolling conversation text while keeping the Stash tab visible.
- Deliver custom mods from completed native AI replies and cached projections without requiring visible chat blocks or local files; accept separate manifest/code blocks, persist pending reviews, deduplicate deliveries, and show validation errors with an AI repair action.
- Show installed built-ins and accurate Starting, Active, Stopped, Off, Paused, and Safe mode states; add live toggles, retry actions, and file-or-paste import while preserving drafts and reviews across manager navigation.
- Apply theme mods to T3's native chrome, selected-theme sources, and sidebar overrides; restore previous inline colors and priorities when disabled.
- Fix Token Weather and Settings in Electron by following hash routes; dock the forecast beside native composer attachments without the large gap. Verify forecasts, thread switching, warm-cache usage and live cleanup in an isolated Electron 44.4.2 window.
- Review AI-created mods returned as complete `t3mod` JSON blocks in the thread so remote workspaces can reach the local installation flow; ignore incomplete and previously reviewed bundles.
- Start mods immediately after confirmed installation, simplify Import labels and row actions, and keep composer bands compact and outside T3’s input surface. Teach the authoring prompt T3’s supported surfaces, theme conventions, and live lifecycle.
- Read measured context from T3’s warm thread-cache hydration and successful RPC snapshots; keep tool items from evicting root ownership in long threads.

- Match the Mods footer icon to native utility buttons and replace the oversized manager with compact T3-style dialogs, settings rows, switches, typography, and theme tokens. Verify icon sizing/placement and inline Settings in a focused browser fixture.

- Confirm macOS signing and the visible Mods sidebar entry in the existing installed Nightly app. Refresh the host on repeated installation without creating another app.
- Detect an open macOS app, ask through the terminal before closing it normally, show patch-stage progress, and reopen the same app after installation. Reuse the previously selected app on reinstall.

- Verify installed-path AppImage patching, repeat installation, checksum inspection, and exact-byte restoration against a temporary copy of the current T3 build; exercise Windows staging and rollback in focused fixtures.

- Patch the existing T3 app at its normal path on macOS, Windows, and Linux AppImage installations, with complete backups and no separate app shortcut. Existing managed-copy installs migrate by rerunning the installer.
- Remove vendor-only macOS entitlements from local signing so AMFI can start the patched app, retaining required Electron runtime entitlements.

- Detect native T3 Code (Alpha), Nightly, and alternate app names in system and user Applications/Programs folders; report platform-specific search locations when detection fails.
- Preserve clean upstream updates on reinstall/uninstall, retain only current and previous managed copies, and keep macOS updates tied to the original installation.
- Remember direct Linux archive installs so the Mods launcher can reapply patches after updates and uninstall without requiring the archive path again.
- Use T3's native sidebar and Settings surfaces, replace blocking browser confirmation dialogs, and remove a shortcut conflicting with T3's model picker.
