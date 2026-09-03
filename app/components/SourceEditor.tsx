"use client";

import { useEffect, useMemo, useRef } from "react";
import { LocateFixed, LockKeyhole } from "lucide-react";
import type { SourceSelection } from "../lib/api";
import { SourceReview } from "./SourceReview";
import type { SourceReviewPreview } from "./SourceReview";

type Props = {
  path: string | null;
  content: string;
  readOnly: boolean;
  focusRequest: SourceFocusRequest | null;
  review?: SourceReviewPreview | null;
  onChange: (content: string) => void;
  onSelection: (selection: SourceSelection | null) => void;
  onLocatePdf: () => void;
};

export type SourceFocusRequest = {
  id: number;
  line: number;
};

function positionAt(content: string, offset: number) {
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function offsetAtLine(content: string, line: number) {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = content.indexOf("\n", offset);
    if (newline < 0) return content.length;
    offset = newline + 1;
  }
  return offset;
}

export function SourceEditor({
  path,
  content,
  readOnly,
  focusRequest,
  review,
  onChange,
  onSelection,
  onLocatePdf,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const handledFocusIdRef = useRef<number | null>(null);
  const suppressSelectionEventsRef = useRef(false);
  const lineCount = Math.max(1, content.split("\n").length);
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );

  useEffect(() => {
    if (
      !focusRequest
      || handledFocusIdRef.current === focusRequest.id
      || !textareaRef.current
    ) return;
    handledFocusIdRef.current = focusRequest.id;
    const textarea = textareaRef.current;
    const start = offsetAtLine(content, focusRequest.line);
    suppressSelectionEventsRef.current = true;
    textarea.focus();
    textarea.setSelectionRange(start, start);
    textarea.scrollTop = Math.max(0, (focusRequest.line - 5) * 21);
    if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop;
    queueMicrotask(() => {
      suppressSelectionEventsRef.current = false;
    });
  }, [focusRequest, content]);

  const emitSelection = () => {
    if (suppressSelectionEventsRef.current) return;
    const textarea = textareaRef.current;
    if (!textarea || !path) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) {
      onSelection(null);
      return;
    }
    const startPosition = positionAt(content, start);
    const endPosition = positionAt(content, end);
    onSelection({
      path,
      startLine: startPosition.line,
      endLine: endPosition.line,
      startColumn: startPosition.column,
      endColumn: endPosition.column,
      text: content.slice(start, end),
      origin: "source",
    });
  };

  if (review) return <SourceReview preview={review} />;

  if (!path) {
    return (
      <div className="source-empty">
        <span className="source-glyph">Tx</span>
        <strong>LaTeX, close at hand</strong>
        <span>Select a project to edit its source beside the rendered paper.</span>
      </div>
    );
  }

  return (
    <div className="source-editor">
      <pre ref={gutterRef} className="source-gutter" aria-hidden="true">{lineNumbers}</pre>
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(event) => onChange(event.target.value)}
        onSelect={emitSelection}
        onMouseUp={emitSelection}
        onKeyUp={emitSelection}
        onScroll={(event) => {
          if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
        readOnly={readOnly}
        spellCheck={false}
        aria-label={`LaTeX source for ${path}`}
      />
      <div className="editor-corner-actions">
        {readOnly ? (
          <span className="readonly-pill"><LockKeyhole size={12} /> Context only</span>
        ) : null}
        <button className="locate-button" onClick={onLocatePdf} title="Locate selection in PDF">
          <LocateFixed size={14} /> PDF
        </button>
      </div>
    </div>
  );
}
