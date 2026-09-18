/**
 * Visual comparison deliberately includes figures, equations and layout shifts.
 * Coordinates are rendered-page pixels at scale 1 (not source/SyncTeX guesses).
 * @typedef {{width: number, height: number, data: Uint8ClampedArray}} Raster
 * @typedef {{x: number, y: number, width: number, height: number}} ChangeRect
 */

/** @param {Raster | null} before @param {Raster | null} after */
export function comparePdfRasters(before, after) {
  const width = Math.max(before?.width ?? 0, after?.width ?? 0);
  const height = Math.max(before?.height ?? 0, after?.height ?? 0);
  if (!before || !after || before.width !== after.width || before.height !== after.height) {
    return width && height ? [{ x: 0, y: 0, width, height }] : [];
  }
  // Small tiles merge neighbouring changed pixels into readable highlights.
  // Ignore only tiny colour noise, not single punctuation marks.
  const tile = 6;
  const columns = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const changed = new Uint8Array(columns * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (Math.max(
        Math.abs(before.data[offset] - after.data[offset]),
        Math.abs(before.data[offset + 1] - after.data[offset + 1]),
        Math.abs(before.data[offset + 2] - after.data[offset + 2]),
      ) > 24) changed[Math.floor(y / tile) * columns + Math.floor(x / tile)] = 1;
    }
  }
  /** @type {ChangeRect[]} */
  const rectangles = [];
  let previous = new Map();
  for (let row = 0; row < rows; row++) {
    const current = new Map();
    for (let column = 0; column < columns; column++) {
      if (!changed[row * columns + column]) continue;
      const start = column;
      while (column + 1 < columns && changed[row * columns + column + 1]) column++;
      const key = `${start}:${column}`;
      let rect = previous.get(key);
      if (rect) rect.height = Math.min(height - rect.y, rect.height + tile);
      else {
        rect = { x: start * tile, y: row * tile, width: Math.min(width, (column + 1) * tile) - start * tile, height: Math.min(tile, height - row * tile) };
        rectangles.push(rect);
      }
      current.set(key, rect);
    }
    previous = current;
  }
  return rectangles;
}
