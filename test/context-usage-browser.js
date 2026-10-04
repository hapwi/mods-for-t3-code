// Focused real-worker check; run with scripts/browser-check.ts --context-usage.
(async () => {
  const capture = new URLSearchParams(location.search).has("capture");
  const output = document.createElement("pre"); output.id = "smoke-result"; document.body.append(output);
  const wait = async (test, label) => {
    const deadline = Date.now() + 10000;
    while (!test()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  const assert = (value, label) => { if (!value) throw new Error(label); };
  const manager = () => document.querySelector("#mods-for-t3-code-host")?.shadowRoot;
  const control = () => document.querySelector('[data-t3mods="context"]')?.shadowRoot;
  const weather = () => document.querySelector('[data-t3mods="bands"]')?.shadowRoot.querySelector('[data-mod="token-weather"]')?.textContent ?? "";
  const click = label => {
    const button = [...manager().querySelectorAll("button")].find(item => item.textContent === label);
    assert(button, `Button ${label}`); button.click();
  };
  try {
    await wait(() => window.__modsForT3Code, "host");
    const examples = await (await fetch("/examples.json")).json();
    assert(examples.length === 2 && examples.every(item => ["context-usage", "token-weather"].includes(item.manifest.id)), "Only requested built-ins");
    history.pushState({}, "", "/local/context-test");
    const form = document.querySelector("[data-chat-composer-form]");
    const native = document.createElement("button");
    native.setAttribute("aria-label", "Context window 90% used"); native.textContent = "Native context";
    native.style.setProperty("display", "inline-flex", "important"); form.append(native);
    const telemetry = window.__T3_MODS_TELEMETRY__.__test;
    const measure = extra => telemetry.emit({ threadId: "context-test", turnId: "turn-a", usedTokens: 229900, maxTokens: 256000, ...extra });
    window.__modsForT3Code.open("examples");
    assert(manager().querySelectorAll("[data-example]").length === 2, "Manager has two built-ins");
    [...manager().querySelectorAll('[data-example="context-usage"] button')].find(item => item.textContent === "Review").click();
    click("Install mod");
    await wait(() => manager().querySelector('[aria-label="Enable Context Usage"]:checked'), "context installed");
    assert(!control(), "No ring before measurement");
    click("Close"); measure();
    await wait(() => control()?.querySelector(".context-percent")?.textContent === "90%", "measured ring");
    const root = document.querySelector('[data-t3mods="context"]');
    assert(root.nextElementSibling === native && native.style.display === "none", "Ring replaces native meter footprint");
    control().querySelector(".context-trigger").click();
    await wait(() => control().querySelector(".context-popup:popover-open"), "open inspector");
    assert(control().textContent.includes("229.9K / 256K Tokens"), "Measured total");
    assert(control().querySelectorAll(".context-unavailable").length === 7, "Missing categories unavailable");
    const popup = control().querySelector(".context-popup");
    const box = popup.getBoundingClientRect();
    assert(box.width > 300 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, "Popup fits viewport");
    measure({ breakdown: { systemPrompt: 2400, toolDefinitions: 9800, rules: 31900, skills: 5000, mcpTools: 5900, summarizedConversation: 10300, conversation: 164600 } });
    await wait(() => control().querySelectorAll(".context-segment").length === 7, "category segments");
    assert(popup.matches(":popover-open") && control().textContent.includes("164.6K"), "Open panel updates live");
    if (capture) { output.dataset.status = "capture"; await wait(() => window.__contextUsageContinue, "visual capture"); output.dataset.status = "running"; }
    control().querySelector('[aria-label="Close context usage"]').click();
    await wait(() => !popup.matches(":popover-open"), "close inspector");
    control().querySelector(".context-trigger").click();
    history.pushState({}, "", "/local/empty-thread");
    await wait(() => !control(), "unmeasured thread hides ring");
    assert(native.style.getPropertyValue("display") === "inline-flex" && native.style.getPropertyPriority("display") === "important", "Navigation restores native display");
    history.pushState({}, "", "/local/context-test");
    await wait(() => control(), "measured thread restores ring");
    assert(!control().querySelector(".context-popup:popover-open"), "Thread switch closes inspector");
    measure({ maxTokens: null });
    await wait(() => control()?.querySelector('.context-widget[data-unknown="true"]'), "unknown window");
    control().querySelector(".context-trigger").click();
    assert(control().textContent.includes("Window size unavailable") && !control().querySelector(".context-bar").hasAttribute("aria-valuenow"), "No invented percentage");
    control().querySelector('[aria-label="Close context usage"]').click();
    window.__modsForT3Code.open("installed");
    await wait(() => !manager().querySelector('[aria-label="Enable Context Usage"]').disabled, "context toggle ready");
    manager().querySelector('[aria-label="Enable Context Usage"]').click();
    await wait(() => !control(), "disable cleanup");
    await wait(() => !manager().querySelector('[aria-label="Enable Context Usage"]').disabled, "disable settled");
    assert(native.style.getPropertyValue("display") === "inline-flex" && native.style.getPropertyPriority("display") === "important", "Disable restores native meter");
    window.__modsForT3Code.open("examples");
    [...manager().querySelectorAll('[data-example="token-weather"] button')].find(item => item.textContent === "Review").click(); click("Install mod");
    await wait(() => manager().querySelector('[aria-label="Enable Token weather"]:checked'), "weather installed");
    click("Close");
    measure({ usedTokens: 24300, maxTokens: 258400, complete: true });
    await wait(() => weather().includes("24.3k / 258.4k"), "weather totals");
    measure({ turnId: "turn-b", usedTokens: 24976, maxTokens: 258400, complete: true });
    await wait(() => weather().includes("+676 last turn"), "weather delta");
    assert(!/[▁▂▃▄▅▆▇█]/.test(weather()), "No sparkline bar");
    assert((await fetch("/favicon.ico")).headers.get("Content-Type") === "image/vnd.microsoft.icon", "Favicon served");
    await window.__modsForT3Code.dispose();
    assert(!document.querySelector('[data-t3mods="context"]') && !document.querySelector("iframe"), "Host cleanup");
    output.dataset.status = "passed";
    output.textContent = "Context Usage passed: two built-ins, real-worker installation, native slot/restoration, clickable live breakdown, missing categories/window, thread switching, cleanup, Token Weather without sparkline, and favicon serving.";
  } catch (error) {
    output.dataset.status = "failed"; output.textContent = (error.stack || String(error)) + "\nManager: " + manager()?.textContent.slice(-1500);
  }
})();
