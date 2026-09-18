"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileSearch2, Highlighter, LoaderCircle, Minus, Plus } from "lucide-react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { PdfFocus } from "../lib/api";
import type { PdfBaseline } from "../lib/pdf-baseline";
import { comparePdfDocuments } from "../lib/pdf-comparison";
import type { PdfComparisonMode, PdfComparisonProgress, PdfComparisonResult, PdfPageChanges } from "../lib/pdf-comparison";

export type PdfSelection = {
  text: string;
  page: number;
  points: Array<{ x: number; y: number }>;
};

type Props = {
  url: string | null;
  buildId: string | null;
  focus: PdfFocus | null;
  compiling: boolean;
  baseline: PdfBaseline | null;
  buildFailed: boolean;
  onSelect: (selection: PdfSelection) => void;
};

type PageProps = {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  focus: PdfFocus | null;
  changes?: PdfPageChanges;
  removed?: boolean;
  onSelect: (selection: PdfSelection) => void;
};

type ReadingPosition = {
  pageNumber: number;
  pageOffsetRatio: number;
  viewportAnchorRatio: number;
  horizontalRatio: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pdfPages(container: HTMLDivElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-pdf-page-number]"));
}

function readingAnchorOffset(container: HTMLDivElement) {
  return Math.min(96, Math.max(24, container.clientHeight * 0.2));
}

function captureReadingPosition(container: HTMLDivElement): ReadingPosition | null {
  const pages = pdfPages(container);
  if (!pages.length || !container.clientHeight) return null;

  const containerRect = container.getBoundingClientRect();
  const anchorOffset = readingAnchorOffset(container);
  const anchorY = containerRect.top + anchorOffset;
  let page = pages.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.top <= anchorY && rect.bottom >= anchorY;
  });
  if (!page) {
    page = pages.reduce((closest, candidate) => {
      const closestRect = closest.getBoundingClientRect();
      const candidateRect = candidate.getBoundingClientRect();
      const closestDistance = Math.min(
        Math.abs(anchorY - closestRect.top),
        Math.abs(anchorY - closestRect.bottom),
      );
      const candidateDistance = Math.min(
        Math.abs(anchorY - candidateRect.top),
        Math.abs(anchorY - candidateRect.bottom),
      );
      return candidateDistance < closestDistance ? candidate : closest;
    });
  }

  const pageNumber = Number(page.dataset.pdfPageNumber);
  const pageRect = page.getBoundingClientRect();
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || !pageRect.height) return null;
  const horizontalExtent = Math.max(0, container.scrollWidth - container.clientWidth);
  return {
    pageNumber,
    pageOffsetRatio: clamp((anchorY - pageRect.top) / pageRect.height, 0, 1),
    viewportAnchorRatio: anchorOffset / container.clientHeight,
    horizontalRatio: horizontalExtent ? container.scrollLeft / horizontalExtent : 0,
  };
}

function pageForPosition(container: HTMLDivElement, position: ReadingPosition) {
  const pages = pdfPages(container);
  if (!pages.length) return null;
  return pages.find((page) => Number(page.dataset.pdfPageNumber) === position.pageNumber)
    ?? pages[Math.min(pages.length - 1, Math.max(0, position.pageNumber - 1))];
}

function restoreReadingPosition(container: HTMLDivElement, position: ReadingPosition) {
  const page = pageForPosition(container, position);
  if (!page || !container.clientHeight) return;
  const containerRect = container.getBoundingClientRect();
  const pageRect = page.getBoundingClientRect();
  const pageTop = pageRect.top - containerRect.top + container.scrollTop;
  const anchorOffset = position.viewportAnchorRatio * container.clientHeight;
  const verticalExtent = Math.max(0, container.scrollHeight - container.clientHeight);
  const horizontalExtent = Math.max(0, container.scrollWidth - container.clientWidth);
  container.scrollTop = clamp(
    pageTop + pageRect.height * position.pageOffsetRatio - anchorOffset,
    0,
    verticalExtent,
  );
  container.scrollLeft = clamp(position.horizontalRatio * horizontalExtent, 0, horizontalExtent);
}

function PdfPage({ document, pageNumber, scale, focus, changes, removed, onSelect }: PageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PageViewport | null>(null);
  const pageProxyRef = useRef<PDFPageProxy | null>(null);
  const [size, setSize] = useState({ width: 612 * scale, height: 792 * scale });

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textTask: { cancel: () => void } | null = null;

    async function render() {
      const pdfjs = await import("pdfjs-dist");
      const page = await document.getPage(pageNumber);
      if (cancelled) return;
      pageProxyRef.current = page;
      const viewport = page.getViewport({ scale });
      viewportRef.current = viewport;
      setSize({ width: viewport.width, height: viewport.height });

      const canvas = canvasRef.current;
      const textContainer = textLayerRef.current;
      if (!canvas || !textContainer) return;

      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });

      textContainer.replaceChildren();
      textContainer.style.setProperty("--scale-factor", String(scale));
      textContainer.style.setProperty("--total-scale-factor", String(scale * (page.userUnit || 1)));
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true }),
        container: textContainer,
        viewport,
      });
      textTask = layer;
      await Promise.all([renderTask.promise, layer.render()]);
    }

    render().catch((error) => {
      if (!cancelled) console.error("PDF page render failed", error);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textTask?.cancel();
    };
  }, [document, pageNumber, scale]);

  const handleSelection = () => {
    const selection = window.getSelection();
    const layer = textLayerRef.current;
    const viewport = viewportRef.current;
    const page = pageProxyRef.current;
    if (!selection || selection.isCollapsed || !layer || !viewport || !page) return;
    if (!layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return;

    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text) return;
    const range = selection.getRangeAt(0).cloneRange();
    const pageRect = layer.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0.5 && rect.height > 0.5,
    );
    if (!rects.length || !pageRect.width || !pageRect.height) return;

    const sampled = rects.length <= 8
      ? rects
      : Array.from({ length: 8 }, (_, index) =>
          rects[Math.round((index * (rects.length - 1)) / 7)],
        );
    const [xMin, , , yMax] = viewport.viewBox;
    const userUnit = page.userUnit || 1;
    const points = sampled.map((rect) => {
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      const viewportX = ((clientX - pageRect.left) * viewport.width) / pageRect.width;
      const viewportY = ((clientY - pageRect.top) * viewport.height) / pageRect.height;
      const [pdfX, pdfY] = viewport.convertToPdfPoint(viewportX, viewportY);
      return {
        x: (pdfX - xMin) * userUnit,
        y: (yMax - pdfY) * userUnit,
      };
    });

    onSelect({ text, page: pageNumber, points });
  };

  const highlight = focus?.page === pageNumber ? focus : null;

  return (
    <section
      ref={pageRef}
      className={`pdf-page${removed ? " pdf-removed-page" : ""}`}
      data-pdf-page-number={removed ? undefined : pageNumber}
      data-pdf-changed-page={changes ? pageNumber : undefined}
      style={{ width: size.width, height: size.height }}
      aria-label={`${removed ? "Previous PDF, removed" : "PDF"} page ${pageNumber}`}
      onMouseUp={removed ? undefined : handleSelection}
    >
      <canvas ref={canvasRef} />
      <div ref={textLayerRef} className="textLayer" />
      {changes ? (
        <div
          className="pdf-change-overlay"
          aria-hidden="true"
          style={{ backgroundImage: `url(${changes.overlay})` }}
        />
      ) : null}
      {removed || changes?.kind === "added" ? <span className="pdf-page-change-label">
        {removed ? `Removed page ${pageNumber} · previous PDF` : "Added page"}
      </span> : null}
      {highlight ? (
        <div
          className="pdf-focus"
          style={{
            left: highlight.x * scale,
            top: highlight.y * scale,
            width: Math.max(18, (highlight.width ?? 72) * scale),
            height: Math.max(12, (highlight.height ?? 12) * scale),
          }}
        />
      ) : null}
      <span className="page-number">{pageNumber}</span>
    </section>
  );
}

export function PdfViewer({ url, buildId, focus, compiling, baseline, buildFailed, onSelect }: Props) {
  const [loaded, setLoaded] = useState<{ url: string; document: PDFDocumentProxy } | null>(null);
  const [scale, setScale] = useState(1.12);
  const [fitWidth, setFitWidth] = useState(true);
  const [loadError, setLoadError] = useState<{ url: string; message: string } | null>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const readingPositionRef = useRef<ReadingPosition | null>(null);
  const revealedFocusRef = useRef<PdfFocus | null>(null);
  const document = loaded?.url === url ? loaded.document : null;
  const error = loadError?.url === url ? loadError.message : null;
  const [showChanges, setShowChanges] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<PdfComparisonMode>("text");
  const [comparisonRequest, setComparisonRequest] = useState(0);
  const [comparison, setComparison] = useState<(PdfComparisonResult & {
    key: string; before: PDFDocumentProxy;
  }) | null>(null);
  const [comparisonProgress, setComparisonProgress] = useState<(PdfComparisonProgress & { key: string }) | null>(null);
  const [comparisonError, setComparisonError] = useState<{ key: string; message: string } | null>(null);
  const comparisonKey = `${url}:${baseline?.id}:${comparisonRequest}:${comparisonMode}`;
  const currentComparison = showChanges && !compiling && comparison?.key === comparisonKey ? comparison : null;
  const progress = comparisonProgress?.key === comparisonKey ? comparisonProgress : null;
  const changeError = comparisonError?.key === comparisonKey ? comparisonError.message : null;

  useEffect(() => {
    if (!showChanges || !baseline?.pdf || !document || compiling) return;
    const controller = new AbortController();
    let task: { destroy: () => Promise<void>; promise: Promise<PDFDocumentProxy> } | null = null;
    async function compare() {
      const pdfjs = await import("pdfjs-dist");
      const bytes = new Uint8Array(await baseline!.pdf!.arrayBuffer());
      controller.signal.throwIfAborted();
      task = pdfjs.getDocument({ data: bytes });
      const before = await task.promise;
      const result = await comparePdfDocuments(before, document!, controller.signal, progress => {
        if (!controller.signal.aborted) setComparisonProgress({ key: comparisonKey, ...progress });
      }, comparisonMode);
      if (!controller.signal.aborted) setComparison({ key: comparisonKey, before, ...result });
    }
    compare().catch(reason => {
      if (!controller.signal.aborted) setComparisonError({
        key: comparisonKey, message: reason instanceof Error ? reason.message : "Could not compare the PDFs.",
      });
    });
    return () => {
      controller.abort();
      task?.destroy().catch(() => undefined);
    };
  }, [showChanges, baseline, document, compiling, comparisonKey, comparisonMode]);

  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void>; promise: Promise<PDFDocumentProxy> } | null = null;
    if (!url) return;
    const targetUrl = url;

    async function load() {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      task = pdfjs.getDocument({ url: targetUrl, withCredentials: false });
      const next = await task.promise;
      if (!cancelled) {
        setLoadError(null);
        setLoaded({ url: targetUrl, document: next });
      }
    }

    load().catch((reason) => {
      if (!cancelled) {
        setLoadError({
          url: targetUrl,
          message: reason instanceof Error ? reason.message : "Could not open PDF",
        });
      }
    });

    return () => {
      cancelled = true;
      task?.destroy().catch(() => undefined);
    };
  }, [url, buildId]);

  // Fit follows the paper canvas as the working drawer moves. Hidden mobile
  // views report zero width; ignore that so their reading position survives.
  useEffect(() => {
    const container = pagesRef.current;
    if (!document || !container || !fitWidth) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    document.getPage(1).then(page => {
      if (cancelled) return;
      const pageWidth = page.getViewport({ scale: 1 }).width;
      const fit = () => {
        if (!container.clientWidth) return;
        const style = getComputedStyle(container);
        const available = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (available <= 0) return;
        const position = captureReadingPosition(container);
        if (position) readingPositionRef.current = position;
        const next = clamp(available / pageWidth, 0.25, 3);
        setScale(current => Math.abs(current - next) > 0.002 ? next : current);
      };
      fit();
      observer = new ResizeObserver(fit);
      observer.observe(container);
    }).catch(() => undefined); // Loading errors remain owned by the preview.
    return () => { cancelled = true; observer?.disconnect(); };
  }, [document, fitWidth]);

  useEffect(() => {
    if (!focus) {
      revealedFocusRef.current = null;
      return;
    }
    if (!document || revealedFocusRef.current === focus) return;
    revealedFocusRef.current = focus;
    const page = pagesRef.current?.querySelector<HTMLElement>(
      `[data-pdf-page-number="${focus.page}"]`,
    );
    page?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [document, focus]);

  useLayoutEffect(() => {
    const container = pagesRef.current;
    const position = readingPositionRef.current;
    if (!document || !container || !position) return;

    let firstFrame = 0;
    let secondFrame = 0;
    let observer: ResizeObserver | null = null;
    let observerTimeout = 0;
    const restore = () => restoreReadingPosition(container, position);
    restore();
    firstFrame = window.requestAnimationFrame(() => {
      restore();
      secondFrame = window.requestAnimationFrame(restore);
    });

    const targetPage = pageForPosition(container, position);
    if (targetPage && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        restore();
        observer?.disconnect();
        observer = null;
      });
      observer.observe(targetPage);
      observerTimeout = window.setTimeout(() => {
        restore();
        observer?.disconnect();
        observer = null;
      }, 500);
    }

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      if (observerTimeout) window.clearTimeout(observerTimeout);
      observer?.disconnect();
    };
  }, [buildId, document, scale]);

  const rememberReadingPosition = () => {
    const container = pagesRef.current;
    if (container) readingPositionRef.current = captureReadingPosition(container);
  };

  const changeScale = (delta: number) => {
    rememberReadingPosition();
    setFitWidth(false);
    setScale((value) => clamp(value + delta, 0.25, 3));
  };

  if (!url) {
    return (
      <div className="pdf-empty">
        <div className="empty-orbit"><FileSearch2 size={28} /></div>
        <strong>Your compiled paper will appear here</strong>
        <span>Open a folder containing a LaTeX project, then choose its main file.</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pdf-empty pdf-error">
        <FileSearch2 size={28} />
        <strong>Preview unavailable</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="pdf-empty">
        <LoaderCircle className="spin" size={26} />
        <strong>{compiling ? "Compiling your paper…" : "Opening the latest build…"}</strong>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-tools">
        <span>{document.numPages} {document.numPages === 1 ? "page" : "pages"}</span>
        <button
          className="pdf-changes-button"
          aria-pressed={showChanges}
          disabled={compiling}
          title="Compare the latest compiled PDF with the snapshot taken before your last agent message"
          onClick={() => {
            rememberReadingPosition();
            setComparisonRequest(value => value + 1);
            setShowChanges(value => !value);
          }}
        >
          <Highlighter size={14} /> Highlight changes
        </button>
        <div className="zoom-control" aria-label="PDF zoom">
          <button className="fit-width-button" aria-label="Fit paper to width" aria-pressed={fitWidth}
            title="Fit paper to the available canvas" onClick={() => { rememberReadingPosition(); setFitWidth(true); }}>Fit</button>
          <button onClick={() => changeScale(-0.12)} aria-label="Zoom out">
            <Minus size={14} />
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button onClick={() => changeScale(0.12)} aria-label="Zoom in">
            <Plus size={14} />
          </button>
        </div>
      </div>
      {showChanges ? (
        <div className="pdf-changes-summary">
          <label className="pdf-comparison-mode">
            Compare
            <select aria-label="PDF comparison mode" value={comparisonMode} onChange={event => setComparisonMode(event.target.value as PdfComparisonMode)}>
              <option value="text">Text edits</option>
              <option value="visual">Visual / figures (includes layout shifts)</option>
            </select>
          </label>
          <div role="status" aria-live="polite">
          {!baseline ? "Send an agent message to start tracking PDF changes. Earlier messages have no saved before-PDF."
            : baseline.error ? baseline.error
            : compiling ? "Compiling — highlights will update when the new PDF is ready."
            : changeError ? `Comparison unavailable: ${changeError}`
            : !currentComparison ? (progress?.phase === "matching" ? "Matching unchanged passages…"
              : progress?.phase === "highlighting" ? `Locating changed words · ${progress.done} of ${progress.total}`
              : `Comparing PDFs${progress ? ` · page ${progress.done} of ${progress.total}` : "…"}`)
            : <>
              <strong>{currentComparison.unresolved.length ? "Partial text comparison" : currentComparison.pages.length ? `${currentComparison.pages.length} changed ${currentComparison.pages.length === 1 ? "page" : "pages"}` : comparisonMode === "text" ? "No text changes" : "No visible changes"}</strong>
              {" since your last message · "}{new Date(baseline.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {currentComparison.pages.length ? <button onClick={() => {
                const changed = pagesRef.current?.querySelector<HTMLElement>("[data-pdf-changed-page]");
                changed?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}>Show first change</button> : null}
              <span>{comparisonMode === "text"
                ? "Yellow marks changed wording, not text that merely moved. Red marks deletions near surviving text. Figures and formatting are only checked in Visual / figures."
                : "Visual comparison includes figures and formatting, but also highlights layout shifts. Use Text edits to ignore reflow."}</span>
            </>}
          </div>
          {currentComparison?.unresolved.length ? <div className="pdf-changes-warning">
            {currentComparison.unresolved.length} text {currentComparison.unresolved.length === 1 ? "passage could" : "passages could"} not be reliably aligned. Those passages are left unhighlighted, not marked as unchanged. Other highlights remain available. Review the source diff for completeness.
            <ul>{currentComparison.unresolved.map((region, index) => <li key={index}>
              Near page {region.page}: {region.oldWords} previous / {region.newWords} current text tokens need review.
            </li>)}</ul>
          </div> : null}
          {currentComparison?.pages.some(page => page.deletedText?.length) ? <details className="pdf-deleted-text">
            <summary>Removed or replaced text ({currentComparison.pages.reduce((count, page) => count + (page.deletedText?.length ?? 0), 0)})</summary>
            <ul>{currentComparison.pages.flatMap(page => (page.deletedText ?? []).map((text, index) => <li key={`${page.page}:${index}`}>{text}</li>))}</ul>
          </details> : null}
          {buildFailed ? <span className="pdf-changes-warning">The latest compile reported errors. This preview may be incomplete; compile successfully before relying on the comparison.</span> : null}
          {baseline?.storageWarning ? <span className="pdf-changes-warning">{baseline.storageWarning}</span> : null}
        </div>
      ) : null}
      <div ref={pagesRef} className="pdf-pages" onScroll={rememberReadingPosition}>
        {Array.from({ length: document.numPages }, (_, index) => (
          <PdfPage
            key={index + 1}
            document={document}
            pageNumber={index + 1}
            scale={scale}
            focus={focus}
            changes={currentComparison?.pages.find(page => page.page === index + 1)}
            onSelect={onSelect}
          />
        ))}
        {currentComparison?.pages.filter(page => page.kind === "removed").map(page => (
          <PdfPage
            key={`removed-${page.page}`}
            document={currentComparison.before}
            pageNumber={page.page}
            scale={scale}
            focus={null}
            changes={page}
            removed
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
