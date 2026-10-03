import type { ModApi } from "../../sdk.d.ts";

export async function activate(api: ModApi): Promise<() => void> {
  let remaining = 25 * 60;
  let running = false;
  async function draw(): Promise<void> {
    const minutes = Math.floor(remaining / 60);
    const seconds = String(remaining % 60).padStart(2, "0");
    await api.panels.set({ title: `${minutes}:${seconds}`, body: running ? "One task at a time. Your focus session is running." : "Ready for a little focused work?", actions: [{ id: "toggle", label: running ? "Pause" : "Start" }, { id: "reset", label: "Reset" }] });
  }
  api.panels.action("toggle", async () => { running = !running; await draw(); });
  api.panels.action("reset", async () => { remaining = 25 * 60; running = false; await draw(); });
  await api.commands.register({ id: "start", title: "Start a 25 minute focus session" }, async () => { remaining = 25 * 60; running = true; await draw(); });
  const interval = setInterval(() => { void (async () => {
    if (!running) return;
    remaining--;
    if (remaining <= 0) { running = false; await api.notify("Focus session finished. Take a short break."); }
    await draw();
  })(); }, 1000);
  await draw();
  return () => clearInterval(interval);
}
