import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectLocalData, DATA_READ_LIMIT, parseDelimited } from "../server/data-inspector.mjs";

async function fixture(t, name, data) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "data-inspector-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, name);
  await writeFile(file, data);
  return { root, file, inspect: () => inspectLocalData(file, name) };
}

test("CSV handles quoted delimiters, newlines, and quotes without modifying input", async t => {
  const data = 'name,value\r\n"a,b",1\r\n"two\nlines","a""b"\r\n';
  const f = await fixture(t, "metrics.csv", data);
  const result = await f.inspect();
  assert.deepEqual(result.columns, ["name", "value"]);
  assert.deepEqual(result.sample, [["a,b", "1"], ["two\nlines", 'a"b']]);
  assert.equal(result.recordCount, 2);
  assert.equal(result.hashScope, "entire-file");
  assert.equal(await readFile(f.file, "utf8"), data);
  assert.deepEqual(parseDelimited("x\ty\n1\t2", "\t", true).rows, [["x", "y"], ["1", "2"]]);
});

test("CSV rejects malformed fields and excess columns even at EOF", () => {
  for (const value of ['x\n"bad', 'x\na"b', 'x\n"a"extra']) assert.throws(() => parseDelimited(value, ",", true), /quoted/);
  for (const suffix of ["", "\n"]) assert.throws(() => parseDelimited(Array(201).fill("x").join(",") + suffix, ",", true), /200 columns/);
  assert.deepEqual(parseDelimited('x\n1\n"unfinished', ",", false), { rows: [["x"], ["1"]], truncated: true });
});

test("large CSV and record-capped CSV disclose incomplete coverage", async t => {
  const f = await fixture(t, "large.csv", "name,value\n" + ("a".repeat(200) + ",42\n").repeat(6000));
  const result = await f.inspect();
  assert.equal(result.bytesRead, DATA_READ_LIMIT);
  assert.equal(result.hashScope, "prefix-only");
  assert.equal(result.coverage, "prefix-sample");
  assert.equal(result.recordCount, null);
  assert.equal(result.sample.length, 5);
  const capped = await fixture(t, "many.csv", "x\n" + "1\n".repeat(20_001));
  const count = await capped.inspect();
  assert.equal(count.hashScope, "entire-file");
  assert.equal(count.coverage, "prefix-sample");
  assert.equal(count.recordCount, null);
});

test("JSON previews bound arrays and nesting; large JSON is metadata only", async t => {
  const f = await fixture(t, "small.json", JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ i, nested: { a: { b: 3 } } }))));
  const result = await f.inspect();
  assert.equal(result.recordCount, 10);
  assert.equal(result.sample.length, 5);
  assert.equal(result.sample[0].nested.a, "[nested value omitted]");
  const large = await fixture(t, "large.json", JSON.stringify({ text: "x".repeat(DATA_READ_LIMIT) }));
  const limited = await large.inspect();
  assert.equal(limited.sample, undefined);
  assert.match(limited.limitations[0], /No records parsed/);
});

test("JSONL parses complete records, rejects malformed ones, and discloses row caps", async t => {
  const f = await fixture(t, "data.jsonl", '{"a":1}\n\n{"a":2}\n');
  assert.equal((await f.inspect()).recordCount, 2);
  await writeFile(f.file, '{"a":1}\ninvalid\n');
  await assert.rejects(f.inspect(), /Invalid JSONL record 2/);
  await writeFile(f.file, '{"a":1}\n'.repeat(20_001));
  assert.equal((await f.inspect()).recordCount, null);
});

function npy(dtype = "<f8", count = 3) {
  const header = Buffer.from(`{'descr': '${dtype}', 'fortran_order': False, 'shape': (${count},), }\n`);
  const result = Buffer.alloc(10 + header.length + 24);
  result.write("\x93NUMPY", 0, "latin1"); result[6] = 1;
  result.writeUInt16LE(header.length, 8); header.copy(result, 10);
  [1, 2.5, -3].forEach((v, i) => result.writeDoubleLE(v, 10 + header.length + i * 8));
  return result;
}

test("numeric NPY samples metadata without evaluating pickle and rejects truncated arrays", async t => {
  const f = await fixture(t, "data.npy", npy());
  const result = await f.inspect();
  assert.deepEqual(result.shape, [3]);
  assert.deepEqual(result.sample, [1, 2.5, -3]);
  await writeFile(f.file, npy("|O"));
  await assert.rejects(f.inspect(), /pickle/);
  await writeFile(f.file, npy("<f8", 100));
  await assert.rejects(f.inspect(), /truncated/);
});

test("unsupported formats and symlink replacement are rejected", async t => {
  const f = await fixture(t, "real.json", "{}");
  await assert.rejects(inspectLocalData(f.file, "data.h5"), /supports/);
  const link = path.join(f.root, "linked.json");
  await symlink(f.file, link);
  await assert.rejects(inspectLocalData(link, "linked.json"));
});
