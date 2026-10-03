export function authorPrompt(description, inbox) {
  return `Create a mod for Mods for T3 Code (API version 1).

What I want: ${description}

Use my existing T3 provider session. Produce a self-contained .t3mod JSON file.
Save it to ${inbox || "the current workspace"}/<id>.t3mod. Do not change T3 itself.
The host watches its inbox and will ask me to review the mod before it runs.

T3 integration and design contract:
This is a mod inside the existing T3 Code Electron app. T3 already owns the sidebar, Settings, thread list, conversation, composer, provider picker, and attachment drawer. Use the supported host surfaces below; do not rebuild T3, inject an overlay, invent DOM selectors, or assume a Claude Code terminal plugin API. Mods are workers, so document/window/React and T3's internal stores are unavailable. The host places and styles your output to match the current T3 theme.
For a compact live indicator above the prompt use ui.band, with short plain text and semantic tones. Do not add a title panel or a second composer for a one-line indicator. For interactive actions use ui.panels or ui.commands. For themes use paired ui.theme tokens, including sidebar tokens when needed, instead of CSS or hardcoded layout. Keep labels concise, avoid decorative headings and redundant controls, and let the host choose fonts, spacing, borders, and light/dark colors.
Install starts the mod immediately after permission review. It must work without restarting T3, update while the app stays open, and clean up its own timers when disabled. Treat navigation as a change of thread: do not display a previous thread's measurements on the next thread. Cache history by threadId, deduplicate completed turns by turnId, and preserve it with storage only if requested.
Context measurements come from T3's actual provider-turn reports and cached thread projections. They are context-window usage, not subscription limits, cumulative billing totals, or a text-length estimate. A provider may return no measurement yet, and maxTokens may be unknown. Handle both states with a short muted message; never guess a 200k window, percentage, turn delta, or chart sample. Do not infer a token count from the model's name. Subscribe to both session.usage and turn.complete, and read api.session.usage() on activation. A completed turn may receive a corrected measurement later. Live indicators should render real data as soon as it arrives.

Bundle format:
{"format":"t3mod/1","manifest":{"apiVersion":1,"id":"lowercase-mod-id","version":"1.0.0","name":"Readable name","description":"What it does","author":"AI assisted","permissions":[]},"code":"globalThis.T3Mod = { async activate(api) { /* implementation */ } };"}

The code string is complete JavaScript, runs in an isolated browser worker, and must set globalThis.T3Mod.activate. No imports, DOM, Node, filesystem, network, credentials, tool approval, or model calls are available. Declare only the permissions you need:
- ui.panels: api.panels.set({title,body,actions:[{id,label}]}), api.panels.clear(), api.panels.action(id, async () => {}). One text panel per mod.
- ui.commands: await api.commands.register({id,title}, async () => {}). Commands run locally when I click them.
- ui.notify: await api.notify("message").
- ui.theme: await api.theme.set({background:"#17212f",foreground:"#edf2f8",...}); api.theme.clear(). Supported tokens: background/foreground, card/card-foreground, popover/popover-foreground, primary/primary-foreground, secondary/secondary-foreground, muted/muted-foreground, accent/accent-foreground, sidebar/sidebar-foreground, sidebar-primary/sidebar-primary-foreground, sidebar-accent/sidebar-accent-foreground, border,input,ring,sidebar-border,sidebar-ring. Always provide both tokens in a pair, including background and foreground. Only #RRGGBB colors; text pairs need 4.5:1 contrast. No arbitrary CSS. Turning the mod off restores the normal theme.
- ui.band: await api.band.set([{text:"☀ Clear",tone:"yellow"},{text:"  20%"}]); api.band.clear(). One line of plain text above the composer, 1–16 parts, up to 160 characters each and 300 in total. Tones: default, muted, yellow, cyan, blue, magenta, red. No HTML, markdown, or newlines.
- session.usage: await api.session.usage() returns {threadId,turnId,usedTokens,maxTokens,measuredAt,complete} for the open thread, or null. api.on("session.usage", snapshot => {}) fires on new measurements and on navigation (snapshot may be null). api.on("turn.complete", snapshot => {}) fires when a turn completes and can repeat for the same turnId with a later measurement, so replace rather than append. maxTokens can be null: show that the window is unknown and never assume a size. These are measurements only; no prompt or response text.
- app.route: await api.route.get(); api.on("app.route", path => {}).
- draft.read: await api.draft.read(); api.on("draft.change", text => {}). Drafts may contain sensitive text.
- draft.insert: await api.draft.insert("text"). This ALWAYS asks for my confirmation, pastes at the end, and never sends a prompt.
- storage: await api.storage.get("key"); await api.storage.set("key", JSONValue). 64 KB per mod.
- api.log("message") is always available.
activate may return a cleanup function. All actions should finish within 5 seconds. Timers are fine. Long loops cause quarantine. Never request permissions outside this list.

Before saving, check the JavaScript syntax and JSON escaping without executing host API calls outside T3. Walk through activation, missing data, unknown window size, navigation, repeated completion events, disable, and re-enable. Do not claim a live T3 check you did not perform. Write valid JSON with properly escaped code. Do not use markdown inside the file. After writing it, tell me what it does and which permissions to review. If saving to the inbox is unavailable, save in the workspace and tell me to use Import in the Mods manager.`;
}
