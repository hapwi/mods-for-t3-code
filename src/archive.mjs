import { open, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

export async function archiveHeader(filename) {
  const file = await open(filename, "r");
  try {
    const prefix = Buffer.alloc(16);
    if ((await file.read(prefix, 0, 16, 0)).bytesRead !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error("Not an Electron ASAR archive.");
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024 || jsonSize > headerSize - 8) throw new Error("Invalid ASAR header size.");
    const json = Buffer.alloc(jsonSize);
    if ((await file.read(json, 0, jsonSize, 16)).bytesRead !== jsonSize) throw new Error("Truncated ASAR header.");
    const header = JSON.parse(json.toString());
    if (!header.files || typeof header.files !== "object") throw new Error("Invalid ASAR directory.");
    return { header, headerString: json.toString(), dataStart: 8 + headerSize };
  } finally { await file.close(); }
}

export function entry(header, name) {
  const segments = name.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || [".", ".."].includes(segment))) throw new Error("Invalid archive path.");
  let value = header;
  for (const segment of segments) value = value?.files?.[segment];
  if (!value || value.link || value.unpacked || !Number.isSafeInteger(value.size) || !/^\d+$/.test(value.offset)) throw new Error(`Unsupported ASAR entry: ${name}`);
  return value;
}

export async function readEntry(filename, name, limit = 1024 * 1024) {
  const { header, dataStart } = await archiveHeader(filename);
  const value = entry(header, name);
  if (value.size > limit) throw new Error(`ASAR entry too large: ${name}`);
  const file = await open(filename, "r");
  try {
    const content = Buffer.alloc(value.size);
    const offset = Number(value.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || (await file.read(content, 0, value.size, dataStart + offset)).bytesRead !== value.size) throw new Error("Invalid ASAR entry offset.");
    return content;
  } finally { await file.close(); }
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = Math.ceil((4 + json.length) / 4) * 4;
  const buffer = Buffer.alloc(12 + payloadSize);
  buffer.writeUInt32LE(4, 0);
  buffer.writeUInt32LE(4 + payloadSize, 4);
  buffer.writeUInt32LE(payloadSize, 8);
  buffer.writeUInt32LE(json.length, 12);
  json.copy(buffer, 16);
  return buffer;
}

export async function replaceEntry(source, destination, name, content) {
  const { header, dataStart } = await archiveHeader(source);
  const value = entry(header, name);
  const payloadSize = (await stat(source)).size - dataStart;
  value.offset = String(payloadSize);
  value.size = content.length;
  const blockSize = value.integrity?.blockSize ?? 4 * 1024 * 1024;
  const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
  const blocks = [];
  for (let offset = 0; offset < content.length; offset += blockSize) blocks.push(hash(content.subarray(offset, offset + blockSize)));
  value.integrity = { algorithm: "SHA256", hash: hash(content), blockSize, blocks };
  const file = await open(destination, "wx", (await stat(source)).mode);
  try { await file.writeFile(encodeHeader(header)); } finally { await file.close(); }
  // Copy every original payload byte and unpacked flag unchanged; append only
  // the replacement entry. Native modules remain in app.asar.unpacked.
  await pipeline(createReadStream(source, { start: dataStart }), createWriteStream(destination, { flags: "a" }));
  const append = await open(destination, "a");
  try { await append.writeFile(content); await append.sync(); } finally { await append.close(); }
}

export async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
