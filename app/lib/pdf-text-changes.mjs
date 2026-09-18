import { diffArrays } from "diff";

/**
 * @typedef {{text: string, page: number, item: number, x: number, y: number,
 * width: number, height: number, pageWidth: number, pageHeight: number, hasEOL: boolean}} TextRun
 * @typedef {{page: number, item: number, start: number, end: number}} TextSpan
 * @typedef {{text: string, spans: TextSpan[]}} TextToken
 */

/** @param {TextRun[]} runs */
function textGlyphs(runs) {
  const byPage = new Map();
  for (const run of runs) {
    if (!byPage.has(run.page)) byPage.set(run.page, []);
    byPage.get(run.page).push(run);
  }
  const marginKey = run => {
    if (run.y >= run.pageHeight * .09 && run.y <= run.pageHeight * .9) return "";
    // A narrow paper margin is not a header. Keep text adjacent to body lines,
    // even if the same sentence repeats near page/column boundaries.
    const bodyNeighbour = byPage.get(run.page).some(other => {
      const distance = Math.abs(other.y - run.y);
      const height = Math.max(run.height, other.height);
      return other.text.trim() && distance > height * .4 && distance < height * 2
        && other.x < run.x + run.width && other.x + other.width > run.x;
    });
    return bodyNeighbour ? "" : `${Math.round(run.y / 3)}:${run.text.trim().replace(/\d+/g, "#")}`;
  };
  const repeatedMargins = new Map();
  for (const run of runs) {
    const key = marginKey(run);
    if (!key) continue;
    const pages = repeatedMargins.get(key) ?? new Set();
    pages.add(run.page);
    repeatedMargins.set(key, pages);
  }
  /** @type {{char: string, span: TextSpan | null}[]} */
  const glyphs = [];
  let previous = null;
  for (const run of runs) {
    // Page numbers / repeated running headers are not manuscript edits.
    const isPageNumber = /^\s*\d+\s*$/.test(run.text)
      && (run.y < run.pageHeight * .04 || run.y > run.pageHeight * .94);
    if (isPageNumber || (repeatedMargins.get(marginKey(run))?.size ?? 0) > 1) continue;
    if (previous && !previous.hasEOL) {
      const lineBreak = run.page !== previous.page || Math.abs(run.y - previous.y) > Math.max(run.height, previous.height) * .8;
      const wordGap = run.x - (previous.x + previous.width) > Math.max(run.height, previous.height) * .15;
      if (lineBreak || wordGap) glyphs.push({ char: lineBreak ? "\n" : " ", span: null });
    }
    let offset = 0;
    for (const char of run.text) {
      const span = { page: run.page, item: run.item, start: offset, end: offset + char.length };
      // NFKC joins ligatures, but keeps case, punctuation, numbers and operators.
      for (const normalized of char.normalize("NFKC").replace(/\u00ad/g, "").split("")) {
        glyphs.push({ char: normalized, span });
      }
      offset += char.length;
    }
    if (run.hasEOL) glyphs.push({ char: "\n", span: null });
    if (run.text || run.hasEOL) previous = run;
  }
  return glyphs;
}

const wrapPattern = /([\p{L}\p{M}]+)-[ \t]*\n[ \t\n]*([\p{L}\p{M}]+)/gu;

/** @param {string} text */
function wordForms(text) {
  const forms = new Set(Array.from(text.matchAll(/[\p{L}\p{M}]+/gu), match => match[0]));
  for (const match of text.matchAll(wrapPattern)) forms.add(match[1] + match[2]);
  return forms;
}

/** @param {ReturnType<typeof textGlyphs>} glyphs @param {Set<string>} otherWords */
function tokenize(glyphs, otherWords) {
  const raw = glyphs.map(glyph => glyph.char).join("");
  const omit = new Set();
  // Only remove a line-wrap hyphen when the other PDF supports that joined word.
  // Inline lexical hyphens (re-sign, noise-limited, etc.) remain meaningful.
  for (const match of raw.matchAll(wrapPattern)) {
    if (!otherWords.has(match[1] + match[2])) continue;
    for (let index = match.index + match[1].length; index < match.index + match[0].length - match[2].length; index++) omit.add(index);
  }
  const normalized = glyphs.filter((_, index) => !omit.has(index));
  const text = normalized.map(glyph => glyph.char).join("");
  /** @type {TextToken[]} */
  const tokens = [];
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}]+|[^\s]/gu)) {
    /** @type {TextSpan[]} */
    const spans = [];
    for (let index = match.index; index < match.index + match[0].length; index++) {
      const span = normalized[index].span;
      if (!span) continue;
      const previous = spans.at(-1);
      if (previous?.page === span.page && previous?.item === span.item && previous.end >= span.start) previous.end = Math.max(previous.end, span.end);
      else spans.push({ ...span });
    }
    if (spans.length) tokens.push({ text: match[0], spans });
  }
  return tokens;
}

/**
 * Unique phrases are reliable anchors even when individual words are repeated.
 * Keep an increasing chain so page/column positions never enter the alignment.
 * @param {string[]} before @param {string[]} after
 * @param {number} a @param {number} b @param {number} c @param {number} d @param {number} size
 */
function phraseAnchors(before, after, a, b, c, d, size) {
  const occurrences = (words, start, end) => {
    const positions = new Map();
    for (let i = start; i + size <= end; i++) {
      const key = JSON.stringify(words.slice(i, i + size));
      positions.set(key, positions.has(key) ? -1 : i);
    }
    return positions;
  };
  const oldPositions = occurrences(before, a, b);
  const newPositions = occurrences(after, c, d);
  const pairs = [];
  for (const [key, oldIndex] of oldPositions) {
    const newIndex = newPositions.get(key);
    if (oldIndex >= 0 && newIndex >= 0) pairs.push({ oldIndex, newIndex });
  }
  const tails = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pairs[tails[mid]].newIndex < pairs[i].newIndex) low = mid + 1;
      else high = mid;
    }
    if (low) previous[i] = tails[low - 1];
    tails[low] = i;
  }
  const chain = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) chain.push(pairs[i]);
  chain.reverse();
  const anchors = [];
  let oldEnd = a;
  let newEnd = c;
  for (const pair of chain) {
    if (pair.oldIndex < oldEnd || pair.newIndex < newEnd) continue;
    anchors.push({ ...pair, size });
    oldEnd = pair.oldIndex + size;
    newEnd = pair.newIndex + size;
  }
  return anchors;
}

/**
 * Partition first, then run bounded synchronous diffs only inside small gaps.
 * The old async Myers callback yielded for every edit distance: browser timer
 * clamping consumed the whole 2.5s deadline on perfectly ordinary rewrites.
 * Yield between batches instead; a throttled tab must not become an error.
 * @param {string[]} before @param {string[]} after
 * @param {{signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} options
 */
async function alignTokens(before, after, options) {
  const parts = [];
  const append = (kind, a, b, c, d) => {
    if (a === b && c === d) return;
    const last = parts.at(-1);
    if (last?.kind === kind && last.b === a && last.d === c) { last.b = b; last.d = d; }
    else parts.push({ kind, a, b, c, d });
  };
  const stack = [{ a: 0, b: before.length, c: 0, d: after.length, depth: 0, equal: false }];
  let lastYield = performance.now();
  while (stack.length) {
    options.signal?.throwIfAborted();
    if (performance.now() - lastYield > 16) {
      options.onProgress?.((parts.at(-1)?.b ?? 0) + (parts.at(-1)?.d ?? 0), before.length + after.length);
      await new Promise(resolve => setTimeout(resolve, 0));
      options.signal?.throwIfAborted();
      lastYield = performance.now();
    }
    let { a, b, c, d, depth, equal } = stack.pop();
    if (equal) { append("equal", a, b, c, d); continue; }
    const oldStart = a;
    const newStart = c;
    while (a < b && c < d && before[a] === after[c]) { a++; c++; }
    append("equal", oldStart, a, newStart, c);
    const oldEnd = b;
    const newEnd = d;
    while (a < b && c < d && before[b - 1] === after[d - 1]) { b--; d--; }
    if (b < oldEnd) stack.push({ a: b, b: oldEnd, c: d, d: newEnd, depth, equal: true });
    if (a === b) { append("added", a, b, c, d); continue; }
    if (c === d) { append("removed", a, b, c, d); continue; }

    let anchors = depth < 8 && b - a + d - c > 384 ? phraseAnchors(before, after, a, b, c, d, 5) : [];
    if (!anchors.length) {
      // A completely new passage needs no quadratic search at all.
      const oldWords = new Set(before.slice(a, b));
      if (!after.slice(c, d).some(word => oldWords.has(word))) {
        append("removed", a, b, c, c);
        append("added", b, b, c, d);
        continue;
      }
      // The unavoidable length difference is cheap (e.g. expanding one sentence
      // into a section); bound the additional edit search, not the insertion size.
      const local = diffArrays(before.slice(a, b), after.slice(c, d), {
        timeout: 40, maxEditLength: Math.abs((b - a) - (d - c)) + 1024,
      });
      if (local) {
        let i = a;
        let j = c;
        for (const part of local) {
          const oldNext = i + (part.added ? 0 : part.count);
          const newNext = j + (part.removed ? 0 : part.count);
          append(part.added ? "added" : part.removed ? "removed" : "equal", i, oldNext, j, newNext);
          i = oldNext; j = newNext;
        }
        continue;
      }
      // Shorter anchors can rescue repetitive passages with no unique phrase.
      if (depth < 8) anchors = phraseAnchors(before, after, a, b, c, d, 1);
    }
    if (!anchors.length) {
      // Never paint an uncertain column/document as though all its words changed.
      append("unresolved", a, b, c, d);
      continue;
    }
    const gaps = [];
    for (const anchor of anchors) {
      gaps.push({ a, b: anchor.oldIndex, c, d: anchor.newIndex, depth: depth + 1, equal: false });
      a = anchor.oldIndex + anchor.size;
      c = anchor.newIndex + anchor.size;
      gaps.push({ a: anchor.oldIndex, b: a, c: anchor.newIndex, d: c, depth, equal: true });
    }
    gaps.push({ a, b, c, d, depth: depth + 1, equal: false });
    for (let i = gaps.length - 1; i >= 0; i--) stack.push(gaps[i]);
  }
  options.signal?.throwIfAborted();
  options.onProgress?.(before.length + after.length, before.length + after.length);
  options.signal?.throwIfAborted();
  return parts;
}

/**
 * Match content globally so line, column and page reflow do not create edits.
 * Returns current-PDF spans for additions, and nearby current anchors for deletions.
 * @param {TextRun[]} beforeRuns @param {TextRun[]} afterRuns
 * @param {{signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} [options]
 */
export async function diffPdfTextRuns(beforeRuns, afterRuns, options = {}) {
  options.signal?.throwIfAborted();
  const oldGlyphs = textGlyphs(beforeRuns);
  const newGlyphs = textGlyphs(afterRuns);
  const before = tokenize(oldGlyphs, wordForms(newGlyphs.map(glyph => glyph.char).join("")));
  const after = tokenize(newGlyphs, wordForms(oldGlyphs.map(glyph => glyph.char).join("")));
  if (!before.length && !after.length) throw new Error("No selectable PDF text was found. Choose Visual / figures to compare scanned pages or graphics.");
  const parts = await alignTokens(before.map(token => token.text), after.map(token => token.text), options);
  /** @type {TextToken[]} */
  const added = [];
  /** @type {{text: string, anchor: TextSpan | null, replacement: boolean}[]} */
  const deleted = [];
  /** @type {{oldWords: number, newWords: number, page: number}[]} */
  const unresolved = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.kind === "added") {
      for (let i = part.c; i < part.d; i++) added.push(after[i]);
    } else if (part.kind === "removed") {
      deleted.push({
        text: before.slice(part.a, part.b).map(token => token.text).join(" ").replace(/\s+([.,;:!?])/g, "$1"),
        anchor: after[part.c]?.spans[0] ?? after.at(-1)?.spans.at(-1) ?? null,
        replacement: parts[index + 1]?.kind === "added",
      });
    } else if (part.kind === "unresolved") {
      unresolved.push({ oldWords: part.b - part.a, newWords: part.d - part.c, page: after[part.c]?.spans[0]?.page ?? after.at(-1)?.spans.at(-1)?.page ?? 1 });
    }
  }
  return { added, deleted, ...(unresolved.length ? { unresolved } : {}) };
}
