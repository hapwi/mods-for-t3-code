import { readFile, writeFile } from "node:fs/promises";
import { NtExecutable, NtExecutableResource } from "resedit";

export async function update(executable: string, digest: string): Promise<void> {
  const binary = NtExecutable.from(await readFile(executable), { ignoreCert: true });
  const resources = NtExecutableResource.from(binary);
  const matches = resources.entries.filter((value) => String(value.type).toUpperCase() === "INTEGRITY" && String(value.id).toUpperCase() === "ELECTRONASAR");
  const value = new TextEncoder().encode(JSON.stringify([{ file: "resources\\app.asar", alg: "sha256", value: digest }])).buffer;
  if (matches.length) for (const resource of matches) resource.bin = value;
  else resources.entries.push({ type: "INTEGRITY", id: "ELECTRONASAR", lang: 1033, codepage: 1200, bin: value });
  resources.outputResource(binary);
  await writeFile(executable, Buffer.from(binary.generate()));
}
