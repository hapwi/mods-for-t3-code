# Architecture

The installer preserves the original ASAR data payload, unpacked native-module metadata, and unrelated entries. It appends the changed entry and recalculates its SHA-256 integrity metadata. Its record includes the original and patched archive hashes; restore requires the expected patched archive and exact backup hash. A clean upstream replacement can be adopted without restoring an obsolete backup.

The bootstrap runs before T3’s original entry point. It appends a read-only telemetry preload to the Electron session, attaches the renderer host after the main app loads, and watches a bounded `.t3mod` inbox. Injection is limited to the `t3code://app` and `t3code-dev://app` origins. OAuth pages, previews, and external pages are excluded. The original preload, context isolation, sandbox, and application RPC requests are retained.

The telemetry preload installs a listener on incoming WebSocket messages before T3 creates its connections. It leaves sends and frames unchanged and observes clones of existing thread-snapshot HTTP responses. It understands current V2 `node.updated`, `provider-thread.updated`, `provider-turn.updated`, and projection snapshots, plus older normalized context activity/session events. It filters provider subagent nodes and forwards only thread/turn identifiers, numeric token counts, window size, time, and completion state. It opens no additional connection and has no credential API. Unrecognized protocols or unsupported preload APIs yield no measurement.

The renderer attaches its own Shadow DOM to named UI locations: manager, Settings content, sidebar panels, and composer bands. Native T3 CSS tokens and adjacent controls establish its visual conventions. Mutation observers reattach owned elements after React rerenders. Mods cannot choose arbitrary DOM selectors or mutate native UI directly.

Each enabled mod gets an opaque `sandbox="allow-scripts"` iframe and a classic blob worker. A MessageChannel carries a limited RPC protocol. The iframe’s CSP blocks network access, external scripts, navigation, forms, and nested frames. The worker can request only declared capabilities. Stop removes the iframe, worker, commands, panels, bands, and theme contributions. Startup/action watchdogs, heartbeat monitoring, storage quotas, and request limits bound failures; quarantined mods remain disabled across launches.

The SDK and `.t3mod` format are versioned independently of T3. Import validates the manifest and bundle, displays source and permissions, and saves the mod disabled. Normal updates are reviewed; development mode trusts only same-author changes without expanded permissions. Inbox acceptance/dismissal fingerprints prevent repeated prompts. Mod databases and settings are separate from T3’s conversation state.

AI authoring uses the existing T3 composer and provider session. The host prepares an SDK-aware draft containing the requested behavior and inbox path; the user chooses the model and sends it. The AI writes a bundle and the watcher presents it. Mods neither obtain provider credentials nor send messages themselves.

Managed launchers keep official installations available, detect changed original archives, and rebuild copies before launch. macOS copies update ASAR integrity metadata and are ad-hoc signed; Windows copies update the executable’s ASAR integrity resource. No integrity fuse is disabled. These copies can require renewed OS permissions and do not retain the original publisher signature. Native platform testing remains necessary.

Automatic patch reapplication is distinct from automatic code repair. API-compatible mods keep working; failed mods are quarantined. The host does not silently ask an AI to rewrite executable mods, increase permissions, or obstruct upstream security updates.
