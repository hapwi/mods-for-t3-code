import { build } from "esbuild";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const examples = [];
for (const directory of ["focus-timer", "prompt-kit", "token-weather", "midnight-theme", "paper-theme"]) {
  const manifest = JSON.parse(await readFile(`examples/${directory}/mod.json`, "utf8"));
  const bundled = await build({ entryPoints: [`examples/${directory}/${manifest.entry}`], bundle: true, format: "iife", globalName: "T3Mod", platform: "browser", target: "es2022", write: false });
  delete manifest.entry;
  examples.push({ format: "t3mod/1", manifest, code: bundled.outputFiles[0].text + "\nglobalThis.T3Mod = T3Mod;\n" });
}
const sandbox = await readFile("payload/public/sandbox.js", "utf8");
const sandboxDocument = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><title>Isolated mod runtime</title></head><body><script>${sandbox.replaceAll("</script", "<\\/script")}</script></body></html>`;
// Bootstrap options win; the embedded list keeps the browser fixture's Built-in tab complete.
const entry = `import { mount } from './payload/web/host.js'; if (!window.__modsForT3Installing && !window.__modsForT3Code) { window.__modsForT3Installing = true; mount({ examples: ${JSON.stringify(examples)}, ...window.__MODS_FOR_T3_OPTIONS__, sandboxDocument: ${JSON.stringify(sandboxDocument)} }).catch(error => console.error('[Mods for T3 Code]', error)).finally(() => { delete window.__modsForT3Installing; }); }`;
await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "renderer-entry.js" }, bundle: true, format: "iife", platform: "browser", target: "chrome130", outfile: "dist/renderer.js", minify: false });
await copyFile("payload/bootstrap.cjs", "dist/bootstrap.cjs");
await copyFile("payload/telemetry-preload.cjs", "dist/telemetry-preload.cjs");
await copyFile("src/paths.cjs", "dist/paths.cjs");
await writeFile("dist/examples.json", JSON.stringify(examples));
await build({ entryPoints: ["src/windows-resources.mjs"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: "dist/windows-resources.mjs" });
await writeFile("dist/THIRD_PARTY_LICENSES.txt", `Windows resource helper bundled dependencies:\n\nresedit\n${await readFile("node_modules/resedit/LICENSE", "utf8")}\npe-library\n${await readFile("node_modules/pe-library/LICENSE", "utf8")}`);
await writeFile("demo/sandbox-document.json", JSON.stringify(sandboxDocument));
console.log("Built the Electron runtime.");
