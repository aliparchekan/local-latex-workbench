import assert from "node:assert/strict";
import test from "node:test";
import { comparePdfRasters } from "../app/lib/pdf-changes.mjs";

function raster(width = 20, height = 20) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}
function ink(image, x, y, rgb = [0, 0, 0]) {
  image.data.set(rgb, (y * image.width + x) * 4);
}

test("unchanged rendered pages and insignificant colour noise have no highlights", () => {
  const before = raster();
  const after = raster();
  ink(after, 4, 4, [240, 240, 240]);
  assert.deepEqual(comparePdfRasters(before, after), []);
});

test("finds a punctuation-sized addition and a deletion at its former position", () => {
  const before = raster();
  const after = raster();
  ink(before, 1, 1);
  ink(after, 14, 14);
  assert.deepEqual(comparePdfRasters(before, after), [
    { x: 0, y: 0, width: 6, height: 6 },
    { x: 12, y: 12, width: 6, height: 6 },
  ]);
});

test("detects figure colour changes and merges contiguous tiles", () => {
  const before = raster();
  const after = raster();
  for (let y = 1; y < 12; y++) for (let x = 1; x < 12; x++) {
    ink(before, x, y, [0, 0, 255]);
    ink(after, x, y, [255, 0, 0]);
  }
  assert.deepEqual(comparePdfRasters(before, after), [{ x: 0, y: 0, width: 12, height: 12 }]);
});

test("handles new, removed and resized pages including blank ones", () => {
  assert.deepEqual(comparePdfRasters(null, raster()), [{ x: 0, y: 0, width: 20, height: 20 }]);
  assert.deepEqual(comparePdfRasters(raster(), null), [{ x: 0, y: 0, width: 20, height: 20 }]);
  assert.deepEqual(comparePdfRasters(raster(), raster(30, 15)), [{ x: 0, y: 0, width: 30, height: 20 }]);
  assert.deepEqual(comparePdfRasters(null, null), []);
});

test("an undo back to the same pixels clears all highlights without resetting baseline", () => {
  const before = raster();
  const changed = raster();
  ink(changed, 19, 19);
  assert.deepEqual(comparePdfRasters(before, changed), [{ x: 18, y: 18, width: 2, height: 2 }]);
  assert.deepEqual(comparePdfRasters(before, raster()), []);
});
