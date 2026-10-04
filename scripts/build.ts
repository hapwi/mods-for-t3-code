import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const examples: import("../sdk.d.ts").ModBundle[] = [];
for (const directory of ["context-usage", "token-weather"]) {
  const manifest = JSON.parse(await readFile(`examples/${directory}/mod.json`, "utf8")) as import("../sdk.d.ts").ModManifest;
  if (!manifest.entry) throw new Error(`Missing mod entry: ${directory}`);
  const bundled = await build({ entryPoints: [`examples/${directory}/${manifest.entry}`], bundle: true, format: "iife", globalName: "T3Mod", platform: "browser", target: "es2022", write: false });
  delete manifest.entry;
  examples.push({ format: "t3mod/1", manifest, code: bundled.outputFiles[0].text + "\nglobalThis.T3Mod = T3Mod;\n" });
}
const sandboxBuild = await build({ entryPoints: ["payload/public/sandbox.ts"], bundle: true, format: "iife", platform: "browser", target: "chrome130", write: false });
const sandbox = sandboxBuild.outputFiles[0].text;
const sandboxDocument = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><title>Isolated mod runtime</title></head><body><script>${sandbox.replaceAll("</script", "<\\/script")}</script></body></html>`;
// Bootstrap options win; the embedded list keeps the browser fixture's Built-in tab complete.
const entry = `import { mount } from './payload/web/host.ts'; if (!window.__modsForT3Installing && !window.__modsForT3Code) { window.__modsForT3Installing = true; mount({ examples: ${JSON.stringify(examples)}, ...window.__MODS_FOR_T3_OPTIONS__, sandboxDocument: ${JSON.stringify(sandboxDocument)} }).catch(error => console.error('[Mods for T3 Code]', error)).finally(() => { delete window.__modsForT3Installing; }); }`;
await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "renderer-entry.js" }, bundle: true, format: "iife", platform: "browser", target: "chrome130", outfile: "dist/renderer.js", minify: false });
for (const [entry, output] of [["payload/bootstrap.ts", "dist/bootstrap.cjs"], ["payload/telemetry-preload.ts", "dist/telemetry-preload.cjs"], ["src/paths.ts", "dist/paths.cjs"]]) {
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "./paths.cjs"], outfile: output });
}
await build({ entryPoints: ["bin/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", external: ["esbuild"], outfile: "dist/cli.mjs" });
await writeFile("dist/examples.json", JSON.stringify(examples));
await build({ entryPoints: ["src/windows-resources.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: "dist/windows-resources.mjs" });
await writeFile("dist/THIRD_PARTY_LICENSES.txt", `Windows resource helper bundled dependencies:\n\nresedit\n${await readFile("node_modules/resedit/LICENSE", "utf8")}\npe-library\n${await readFile("node_modules/pe-library/LICENSE", "utf8")}`);
await writeFile("demo/sandbox-document.json", JSON.stringify(sandboxDocument));
console.log("Built the Electron runtime.");
