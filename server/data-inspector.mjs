import { open, constants } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const DATA_READ_LIMIT = 1024 * 1024;
const SAMPLE_ROWS = 5;
const MAX_RECORDS = 20_000;
const clip = (value) => String(value).slice(0, 300);

function preview(value, depth = 0) {
  if (typeof value === "string") return clip(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, SAMPLE_ROWS).map((v) => preview(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 25).map(([k, v]) => [clip(k), preview(v, depth + 1)]));
}

// Small deterministic CSV/TSV reader. Handles quoted delimiters/newlines and
// doubled quotes; never treats input as formulas, code, or instructions.
export function parseDelimited(text, delimiter, complete) {
  const rows = [];
  let row = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === delimiter) { row.push(clip(field)); field = ""; closed = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(clip(field));
      if (row.length > 200) throw new Error("More than 200 columns; choose a smaller export.");
      rows.push(row); row = []; field = ""; closed = false;
      if (rows.length >= MAX_RECORDS) return { rows, truncated: i < text.length - 1 };
    } else {
      if (closed || c === '"') throw new Error("Malformed quoted CSV/TSV field.");
      field += c;
    }
    if (row.length > 200) throw new Error("More than 200 columns; choose a smaller export.");
  }
  if (quoted && complete) throw new Error("Unclosed quoted field in data file.");
  if (complete && (field || row.length || closed)) {
    row.push(clip(field));
    if (row.length > 200) throw new Error("More than 200 columns; choose a smaller export.");
    rows.push(row);
  }
  return { rows, truncated: !complete };
}

function inspectNpy(bytes, fileSize) {
  if (bytes.length < 10 || bytes.subarray(0, 6).toString("latin1") !== "\x93NUMPY") throw new Error("Invalid NPY header.");
  const version = bytes[6];
  if (![1, 2, 3].includes(version)) throw new Error("Unsupported NPY version.");
  const start = version === 1 ? 10 : 12;
  if (bytes.length < start) throw new Error("Truncated NPY header.");
  const length = version === 1 ? bytes.readUInt16LE(8) : bytes.readUInt32LE(8);
  if (length > 64_000 || start + length > bytes.length) throw new Error("NPY header exceeds the bounded preview.");
  const header = bytes.subarray(start, start + length).toString("utf8");
  const dtype = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header)?.[1];
  const shapeText = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!dtype || shapeText == null || !/^[\d,\s]*$/.test(shapeText)) throw new Error("Structured/object NPY arrays are not supported; pickle is never loaded.");
  const shape = shapeText.split(",").map(s => s.trim()).filter(Boolean).map(Number);
  if (!shape.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid NPY dimensions.");
  const match = /^([<>|=])([fiu])(1|2|4|8)$/.exec(dtype);
  if (!match) throw new Error("Only primitive numeric NPY arrays are supported; object arrays and pickle are never loaded.");
  const sample = [];
  if (match) {
    const [, order, kind, widthText] = match;
    const width = Number(widthText), big = order === ">";
    const total = shape.reduce((a, b) => a * b, 1);
    if (!Number.isSafeInteger(total) || start + length + total * width > fileSize) throw new Error("NPY payload is truncated or dimensions are too large.");
    for (let index = 0; index < Math.min(SAMPLE_ROWS, total); index++) {
      const offset = start + length + index * width;
      if (offset + width > bytes.length) break;
      let value;
      if (kind === "f" && width === 4) value = big ? bytes.readFloatBE(offset) : bytes.readFloatLE(offset);
      else if (kind === "f" && width === 8) value = big ? bytes.readDoubleBE(offset) : bytes.readDoubleLE(offset);
      else if (kind !== "f" && width <= 6) {
        value = kind === "i" ? (big ? bytes.readIntBE(offset, width) : bytes.readIntLE(offset, width))
          : (big ? bytes.readUIntBE(offset, width) : bytes.readUIntLE(offset, width));
      } else break;
      sample.push(Number.isFinite(value) ? value : String(value));
    }
  }
  return { dtype, shape, storageOrder: /['"]fortran_order['"]\s*:\s*True/.test(header) ? "Fortran" : "C", sample,
    limitations: ["Only metadata and up to five stored values were inspected; no array-wide statistics or pickle evaluation."] };
}

// Caller first resolves the requested path within the research root. Open the
// resolved file without following a replacement leaf symlink, with bounded IO.
export async function inspectLocalData(absolutePath, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (![".json", ".jsonl", ".csv", ".tsv", ".npy"].includes(extension)) {
    throw new Error("Local data inspection supports JSON, JSONL, CSV, TSV, and numeric NPY. Export other formats to one of these first.");
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Choose a regular data file.");
    const buffer = Buffer.alloc(Math.min(before.size, DATA_READ_LIMIT));
    let consumed = 0;
    while (consumed < buffer.length) {
      const { bytesRead } = await handle.read(buffer, consumed, buffer.length - consumed, consumed);
      if (!bytesRead) break;
      consumed += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || consumed !== buffer.length) {
      throw new Error("The data file changed while being inspected. Retry after the experiment finishes writing.");
    }
    const full = consumed === before.size;
    const result = { path: relativePath, bytes: before.size, bytesRead: consumed, modifiedAt: before.mtime.toISOString(),
      sha256: createHash("sha256").update(buffer).digest("hex"), hashScope: full ? "entire-file" : "prefix-only",
      coverage: full ? "full-file-read; bounded-preview" : "prefix-sample", format: extension.slice(1) };
    if (extension === ".npy") return { ...result, ...inspectNpy(buffer, before.size) };
    // Ignore only an incomplete last UTF-8 sequence on a sampled boundary.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: !full }).replace(/^\uFEFF/, "");
    if (extension === ".json") {
      if (!full) return { ...result, limitations: ["JSON exceeds the 1 MiB read limit. No records parsed; use a smaller summary or JSONL export."] };
      const data = JSON.parse(text);
      return { ...result, type: Array.isArray(data) ? "array" : data === null ? "null" : typeof data,
        recordCount: Array.isArray(data) ? data.length : null, sample: preview(data),
        limitations: ["Preview is limited to five array entries, 25 object keys, depth three, and 300 characters per string; no scientific validation."] };
    }
    if (extension === ".jsonl") {
      const lines = text.split(/\r?\n/);
      if (!full) lines.pop();
      const records = lines.filter(line => line.trim());
      const parsed = records.slice(0, MAX_RECORDS).map((line, i) => {
        try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL record ${i + 1} in the inspected prefix.`); }
      });
      const complete = full && parsed.length === records.length;
      return { ...result, coverage: complete ? result.coverage : "prefix-sample", recordCount: complete ? parsed.length : null,
        recordsInspected: parsed.length, sample: parsed.slice(0, SAMPLE_ROWS).map(v => preview(v)),
        limitations: ["Only the displayed samples describe values; unseen records may have different fields. No dataset-wide statistics."] };
    }
    const parsed = parseDelimited(text, extension === ".tsv" ? "\t" : ",", full);
    const [columns = [], ...records] = parsed.rows;
    return { ...result, coverage: parsed.truncated ? "prefix-sample" : result.coverage, columns,
      recordCount: parsed.truncated ? null : records.length, recordsInspected: records.length,
      sample: records.slice(0, SAMPLE_ROWS),
      limitations: ["First row is treated as a header. Cells are capped at 300 characters; preview shows five rows. No dataset-wide statistics.",
        ...(records.some(row => row.length !== columns.length) ? ["Some inspected rows have a different number of fields than the header."] : [])] };
  } finally { await handle.close(); }
}
