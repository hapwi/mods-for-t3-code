import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const files: Record<string, string> = { "/": "demo/index.html", "/settings/appearance": "demo/index.html", "/renderer.js": "dist/renderer.js", "/smoke.js": "test/browser-smoke.js", "/examples.json": "dist/examples.json", "/token-weather.t3mod": "demo/token-weather.t3mod", "/focus-timer.t3mod": "demo/focus-timer.t3mod", "/prompt-kit.t3mod": "demo/prompt-kit.t3mod" };
  if (!files[url.pathname]) { response.writeHead(404).end(); return; }
  try {
    response.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : /\.(?:t3mod|json)$/.test(url.pathname) ? "application/json" : "text/html");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'");
    response.end(await readFile(path.resolve(files[url.pathname])));
  } catch { response.writeHead(500).end("Run npm run build and npm run pack:examples first."); }
});
server.listen(4318, "127.0.0.1", () => console.log("Mod host fixture: http://127.0.0.1:4318"));
