import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { comparePdfRasters } from "./pdf-changes.mjs";
import { diffPdfTextRuns } from "./pdf-text-changes.mjs";
import type { TextRun, TextSpan } from "./pdf-text-changes.mjs";

export type PdfComparisonMode = "text" | "visual";
export type PdfComparisonProgress = { phase: "reading" | "matching" | "highlighting" | "visual"; done: number; total: number };
export type PdfComparisonResult = { pages: PdfPageChanges[]; unresolved: { oldWords: number; newWords: number; page: number }[] };

export type PdfPageChanges = {
  page: number;
  kind: "changed" | "added" | "removed";
  width: number;
  height: number;
  overlay: string;
  deletedText?: string[];
};

type TextPage = { content: TextContent; viewport: PageViewport };
type Rect = { x: number; y: number; width: number; height: number };

async function extractText(pdf: PDFDocumentProxy, signal: AbortSignal, onPage: (page: number) => void) {
  const { Util } = await import("pdfjs-dist");
  const runs: TextRun[] = [];
  const pages = new Map<number, TextPage>();
  for (let number = 1; number <= pdf.numPages; number++) {
    signal.throwIfAborted();
    onPage(number);
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.set(number, { viewport, content });
    let itemIndex = 0;
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const [, , c, d, x, y] = Util.transform(viewport.transform, item.transform);
      const height = Math.hypot(c, d);
      runs.push({
        text: item.str, page: number, item: itemIndex++, x, y: y - height,
        width: item.width * viewport.scale, height, hasEOL: item.hasEOL,
        pageWidth: viewport.width, pageHeight: viewport.height,
      });
    }
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }
  return { runs, pages };
}

// Measure only changed words using the same PDF.js text layer as the viewer.
// Browser ranges respect font widths/ligatures; no guessed fractions of a whole line.
async function measureSpans(page: TextPage, spans: TextSpan[], signal: AbortSignal) {
  const { TextLayer } = await import("pdfjs-dist");
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${page.viewport.width}px;height:${page.viewport.height}px;visibility:hidden;pointer-events:none;`;
  host.style.setProperty("--scale-factor", "1");
  host.style.setProperty("--total-scale-factor", "1");
  const container = document.createElement("div");
  container.className = "textLayer";
  container.style.setProperty("--total-scale-factor", String(page.viewport.scale * page.viewport.userUnit));
  host.appendChild(container);
  document.body.appendChild(host);
  const layer = new TextLayer({ container, viewport: page.viewport, textContentSource: page.content });
  const abort = () => layer.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await layer.render();
    signal.throwIfAborted();
    const origin = container.getBoundingClientRect();
    return spans.map(span => {
      const node = layer.textDivs[span.item]?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error("A changed PDF word could not be located. Choose Visual / figures to inspect it.");
      const range = document.createRange();
      range.setStart(node, span.start);
      range.setEnd(node, span.end);
      return Array.from(range.getClientRects()).map(rect => ({
        x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height,
      }));
    });
  } finally {
    signal.removeEventListener("abort", abort);
    layer.cancel();
    host.remove();
  }
}

function textOverlay(viewport: PageViewport, added: Rect[], deleted: Rect[]) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  if (canvas.width * canvas.height > 4_000_000) throw new Error("A page is too large for change highlights.");
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgba(255, 188, 0, 0.32)";
  for (const rect of added) context.fillRect(rect.x - .5, rect.y, rect.width + 1, rect.height);
  // A small red mark near surviving text, never a highlight over an old column.
  context.fillStyle = "rgba(183, 51, 43, 0.85)";
  for (const rect of deleted) context.fillRect(Math.max(0, rect.x - 6), rect.y, 3, Math.max(8, rect.height));
  const overlay = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 0;
  return overlay;
}

async function comparePdfText(before: PDFDocumentProxy, after: PDFDocumentProxy, signal: AbortSignal, onProgress: (progress: PdfComparisonProgress) => void): Promise<PdfComparisonResult> {
  const total = before.numPages + after.numPages;
  const oldText = await extractText(before, signal, number => onProgress({ phase: "reading", done: number, total }));
  const newText = await extractText(after, signal, number => onProgress({ phase: "reading", done: before.numPages + number, total }));
  signal.throwIfAborted();
  onProgress({ phase: "matching", done: 0, total: 0 });
  await new Promise(resolve => window.setTimeout(resolve, 0));
  const diff = await diffPdfTextRuns(oldText.runs, newText.runs, {
    signal, onProgress: (done, count) => onProgress({ phase: "matching", done, total: count }),
  });
  signal.throwIfAborted();
  const byPage = new Map<number, { added: TextSpan[]; removed: { span: TextSpan | null; text: string; replacement: boolean }[] }>();
  const entry = (page: number) => {
    if (!byPage.has(page)) byPage.set(page, { added: [], removed: [] });
    return byPage.get(page)!;
  };
  for (const token of diff.added) for (const span of token.spans) entry(span.page).added.push(span);
  for (const removed of diff.deleted) entry(removed.anchor?.page ?? 1).removed.push({ span: removed.anchor, text: removed.text, replacement: removed.replacement });
  const changes: PdfPageChanges[] = [];
  for (const [number, change] of byPage) {
    signal.throwIfAborted();
    onProgress({ phase: "highlighting", done: changes.length + 1, total: byPage.size });
    const page = newText.pages.get(number)!;
    const markers = change.removed.filter(removed => !removed.replacement);
    const spans = [...change.added, ...markers.flatMap(marker => marker.span ? [marker.span] : [])];
    const measured = await measureSpans(page, spans, signal);
    const additions = measured.slice(0, change.added.length).flat();
    const deletions = measured.slice(change.added.length).flat();
    if (markers.some(marker => !marker.span)) deletions.push({ x: 24, y: 24, width: 3, height: 12 });
    changes.push({
      page: number, kind: "changed", width: page.viewport.width, height: page.viewport.height,
      overlay: textOverlay(page.viewport, additions, deletions), deletedText: change.removed.map(removed => removed.text),
    });
  }
  return { pages: changes.sort((left, right) => left.page - right.page), unresolved: diff.unresolved ?? [] };
}

async function rasterPage(pdf: PDFDocumentProxy, pageNumber: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  if (canvas.width * canvas.height > 4_000_000) throw new Error("A page is too large for visual comparison.");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser could not compare the PDF pages.");
  const task = page.render({ canvas, canvasContext: context, viewport });
  const abort = () => task.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await task.promise;
    signal.throwIfAborted();
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    signal.removeEventListener("abort", abort);
    canvas.width = canvas.height = 0;
  }
}

export async function comparePdfDocuments(
  before: PDFDocumentProxy,
  after: PDFDocumentProxy,
  signal: AbortSignal,
  onProgress: (progress: PdfComparisonProgress) => void,
  mode: PdfComparisonMode = "text",
): Promise<PdfComparisonResult> {
  if (mode === "text") return comparePdfText(before, after, signal, onProgress);
  const changes: PdfPageChanges[] = [];
  const count = Math.max(before.numPages, after.numPages);
  for (let page = 1; page <= count; page++) {
    signal.throwIfAborted();
    onProgress({ phase: "visual", done: page, total: count });
    const oldRaster = page <= before.numPages ? await rasterPage(before, page, signal) : null;
    const newRaster = page <= after.numPages ? await rasterPage(after, page, signal) : null;
    const rectangles = comparePdfRasters(oldRaster, newRaster);
    if (rectangles.length) {
      const width = Math.max(oldRaster?.width ?? 0, newRaster?.width ?? 0);
      const height = Math.max(oldRaster?.height ?? 0, newRaster?.height ?? 0);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "rgba(255, 188, 0, 0.32)";
      for (const rect of rectangles) context.fillRect(rect.x, rect.y, rect.width, rect.height);
      changes.push({ page, kind: !oldRaster ? "added" : !newRaster ? "removed" : "changed", width, height, overlay: canvas.toDataURL("image/png") });
      canvas.width = canvas.height = 0;
    }
    // Let scrolling/cancel/zoom remain responsive between pages.
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }
  return { pages: changes, unresolved: [] };
}
