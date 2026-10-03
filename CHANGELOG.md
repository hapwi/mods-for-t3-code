# Changelog

## [Unreleased]

### Added

- Install the Patcher changelog policy for ongoing changes and explicitly authorized releases.
- Add the MIT-licensed Mods for T3 Code host, sidebar and Settings entries, live mod management, commands, panels, permission review, and isolated worker runtimes.
- Create mods through the current T3 composer and provider account, with a watched inbox for immediate import review.
- Add Linux/macOS curl and Windows PowerShell installers, managed Electron copies, reversible archive patches, integrity checks, safe mode, and a typed SDK.
- Create separate application shortcuts, including a macOS app launcher that opens without a Terminal window.
- Add live theme tokens, built-in theme/timer/prompt examples, permission-aware author hot reload, and persistent inbox review decisions.
- Observe measured context usage and turn completion through a read-only preload supporting current and earlier T3 event formats.
- Add Token Weather above the prompt with live weather thresholds, measured token counts, a 12-turn sparkline, and per-thread completed-turn deltas.
- Document installation, mod authoring, architecture, recovery, updates, and native-platform validation limits.
- Include the license notices for dependencies bundled into the Windows resource helper.

### Fixed

- Preserve clean upstream updates on reinstall/uninstall, retain only current and previous managed copies, and keep macOS updates tied to the original installation.
- Remember direct Linux archive installs so the Mods launcher can reapply patches after updates and uninstall without requiring the archive path again.
- Use T3's native sidebar and Settings surfaces, replace blocking browser confirmation dialogs, and remove a shortcut conflicting with T3's model picker.
