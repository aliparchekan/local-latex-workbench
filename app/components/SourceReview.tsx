"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff";

export type SourceReviewPreview = {
  path: string;
  kind: "add" | "update" | "delete";
  movePath?: string | null;
  before: string;
  after: string | null;
  reviewDiff: string;
};

type Props = {
  preview: SourceReviewPreview;
};

type ReviewMode = "current" | "proposed";

type ChangeMarker = {
  kind: "addition" | "deletion";
  count: number;
};

type ChangeMap = {
  currentLines: Set<number>;
  proposedLines: Set<number>;
  currentMarkers: Map<number, ChangeMarker[]>;
  proposedMarkers: Map<number, ChangeMarker[]>;
  addedCount: number;
  removedCount: number;
};

const EMPTY_CHANGE_MAP: ChangeMap = {
  currentLines: new Set<number>(),
  proposedLines: new Set<number>(),
  currentMarkers: new Map<number, ChangeMarker[]>(),
  proposedMarkers: new Map<number, ChangeMarker[]>(),
  addedCount: 0,
  removedCount: 0,
};

function addMarker(
  markers: Map<number, ChangeMarker[]>,
  line: number,
  marker: ChangeMarker,
) {
  const anchor = Math.max(1, line);
  markers.set(anchor, [...(markers.get(anchor) ?? []), marker]);
}

function changeMapFor(diff: string): ChangeMap {
  let files: ReturnType<typeof parsePatch>;
  try {
    files = parsePatch(diff);
  } catch {
    return EMPTY_CHANGE_MAP;
  }

  const result: ChangeMap = {
    currentLines: new Set<number>(),
    proposedLines: new Set<number>(),
    currentMarkers: new Map<number, ChangeMarker[]>(),
    proposedMarkers: new Map<number, ChangeMarker[]>(),
    addedCount: 0,
    removedCount: 0,
  };

  for (const file of files) {
    for (const hunk of file.hunks) {
      let currentLine = hunk.oldStart;
      let proposedLine = hunk.newStart;
      let index = 0;

      while (index < hunk.lines.length) {
        const line = hunk.lines[index];
        if (line.startsWith(" ")) {
          currentLine += 1;
          proposedLine += 1;
          index += 1;
          continue;
        }
        if (line.startsWith("\\")) {
          index += 1;
          continue;
        }

        const currentAnchor = currentLine;
        const proposedAnchor = proposedLine;
        let added = 0;
        let removed = 0;

        while (index < hunk.lines.length && !hunk.lines[index].startsWith(" ")) {
          const changedLine = hunk.lines[index];
          if (changedLine.startsWith("-")) {
            result.currentLines.add(currentLine);
            currentLine += 1;
            removed += 1;
          } else if (changedLine.startsWith("+")) {
            result.proposedLines.add(proposedLine);
            proposedLine += 1;
            added += 1;
          }
          index += 1;
        }

        result.addedCount += added;
        result.removedCount += removed;
        if (added > 0 && removed === 0) {
          addMarker(result.currentMarkers, currentAnchor, { kind: "addition", count: added });
        }
        if (removed > 0 && added === 0) {
          addMarker(result.proposedMarkers, proposedAnchor, { kind: "deletion", count: removed });
        }
      }
    }
  }

  return result;
}

function reconstructAfter(preview: SourceReviewPreview) {
  if (preview.after !== null) return preview.after;
  if (!preview.reviewDiff.trim()) return null;
  try {
    const result = applyPatch(preview.before, preview.reviewDiff, { fuzzFactor: 0 });
    return result === false ? null : result;
  } catch {
    return null;
  }
}

function firstChangedLine(lines: Set<number>) {
  let first: number | null = null;
  for (const line of lines) {
    if (first === null || line < first) first = line;
  }
  return first;
}

function kindLabel(kind: SourceReviewPreview["kind"]) {
  if (kind === "add") return "Added file";
  if (kind === "delete") return "Deleted file";
  return "Updated file";
}

function markerText(marker: ChangeMarker) {
  const noun = marker.count === 1 ? "line" : "lines";
  return marker.kind === "addition"
    ? `${marker.count} proposed ${noun} inserted here`
    : `${marker.count} current ${noun} removed here`;
}

export function SourceReview({ preview }: Props) {
  const proposedSource = useMemo(() => reconstructAfter(preview), [preview]);
  const effectiveDiff = useMemo(() => {
    if (preview.reviewDiff.trim()) {
      try {
        if (parsePatch(preview.reviewDiff).some((file) => file.hunks.length > 0)) {
          return preview.reviewDiff;
        }
      } catch {
        // Rebuild a normalized review diff below when both source versions exist.
      }
    }
    if (proposedSource === null) return preview.reviewDiff;
    return createTwoFilesPatch(
      preview.path,
      preview.path,
      preview.before,
      proposedSource,
      "current",
      "proposed",
    );
  }, [preview.before, preview.path, preview.reviewDiff, proposedSource]);
  const changes = useMemo(() => changeMapFor(effectiveDiff), [effectiveDiff]);
  const reviewKey = `${preview.path}\u0000${preview.kind}\u0000${preview.reviewDiff}`;
  const defaultMode: ReviewMode = proposedSource === null ? "current" : "proposed";
  const [modeSelection, setModeSelection] = useState<{ key: string; mode: ReviewMode }>(() => ({
    key: reviewKey,
    mode: defaultMode,
  }));
  const requestedMode = modeSelection.key === reviewKey ? modeSelection.mode : defaultMode;
  const mode: ReviewMode = requestedMode === "proposed" && proposedSource === null
    ? "current"
    : requestedMode;
  const firstChangeRef = useRef<HTMLDivElement>(null);

  const source = mode === "proposed" && proposedSource !== null
    ? proposedSource
    : preview.before;
  const changedLines = mode === "proposed" ? changes.proposedLines : changes.currentLines;
  const markers = mode === "proposed" ? changes.proposedMarkers : changes.currentMarkers;
  const firstLine = firstChangedLine(changedLines);
  const firstMarkerLine = firstLine === null
    ? Math.min(...markers.keys(), Number.POSITIVE_INFINITY)
    : null;

  useEffect(() => {
    firstChangeRef.current?.scrollIntoView({ block: "center" });
  }, [effectiveDiff, mode, preview.path]);

  const sourceLines = source === "" ? [] : source.split("\n");
  const rows = [];
  for (let index = 0; index <= sourceLines.length; index += 1) {
    const lineNumber = index + 1;
    for (const [markerIndex, marker] of (markers.get(lineNumber) ?? []).entries()) {
      const isFirstMarker = firstLine === null && lineNumber === firstMarkerLine && markerIndex === 0;
      rows.push(
        <div
          className={`source-review-marker source-review-marker-${marker.kind}`}
          key={`marker-${lineNumber}-${markerIndex}`}
          ref={isFirstMarker ? firstChangeRef : undefined}
          role="note"
        >
          <span aria-hidden="true">{marker.kind === "addition" ? "+" : "−"}</span>
          <span>{markerText(marker)}</span>
        </div>,
      );
    }
    if (index === sourceLines.length) continue;

    const changed = changedLines.has(lineNumber);
    rows.push(
      <div
        className={`source-review-line${changed ? ` source-review-line-${mode === "current" ? "removed" : "added"}` : ""}`}
        data-line={lineNumber}
        key={`line-${lineNumber}`}
        ref={lineNumber === firstLine ? firstChangeRef : undefined}
      >
        <span className="source-review-line-number" aria-hidden="true">{lineNumber}</span>
        <code>{sourceLines[index] || " "}</code>
      </div>,
    );
  }

  const summary = changes.addedCount || changes.removedCount
    ? `${changes.addedCount} added, ${changes.removedCount} removed`
    : "No changed lines detected";

  return (
    <section className="source-review" aria-label={`Review proposed source changes for ${preview.path}`}>
      <header className="source-review-header">
        <div className="source-review-file">
          <strong>{preview.path}</strong>
          <span className={`source-review-kind source-review-kind-${preview.kind}`}>
            {kindLabel(preview.kind)}
          </span>
        </div>
        <div className="source-review-toggle" role="group" aria-label="Source version">
          <button
            type="button"
            aria-pressed={mode === "current"}
            className={mode === "current" ? "is-active" : ""}
            onClick={() => setModeSelection({ key: reviewKey, mode: "current" })}
          >
            Current
          </button>
          <button
            type="button"
            aria-pressed={mode === "proposed"}
            className={mode === "proposed" ? "is-active" : ""}
            disabled={proposedSource === null}
            title={proposedSource === null ? "The proposed full source could not be reconstructed." : undefined}
            onClick={() => setModeSelection({ key: reviewKey, mode: "proposed" })}
          >
            Proposed
          </button>
        </div>
      </header>

      <div className="source-review-meta">
        <span>{mode === "current" ? "Current source" : "Source after approval"}</span>
        <span>{summary}</span>
      </div>

      {preview.movePath ? (
        <div className="source-review-move">
          This file will move to <strong>{preview.movePath}</strong> after approval.
        </div>
      ) : null}

      {proposedSource === null ? (
        <p className="source-review-warning" role="status">
          The complete proposed source could not be reconstructed. The current source is shown; use the patch details to review the change.
        </p>
      ) : null}

      <div
        className="source-review-code"
        role="region"
        aria-label={`${mode === "current" ? "Current" : "Proposed"} source`}
        tabIndex={0}
      >
        {rows.length ? rows : <div className="source-review-empty">Empty file</div>}
      </div>
    </section>
  );
}
