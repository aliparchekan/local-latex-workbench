"use client";

import { parsePaperCheck } from "../lib/workbench-skills.mjs";

export function PaperCheckMessage({ text, busy, onOpenSource }: {
  text: string;
  busy: boolean;
  onOpenSource: (path: string, line: number | null) => void;
}) {
  const report = parsePaperCheck(text);
  if (!report) {
    if (busy && /^\s*(?:```json\s*)?\{/.test(text)) return <p>Preparing findings…</p>;
    return <p>{text || (busy ? "Thinking…" : "")}</p>;
  }
  return (
    <section className="paper-check-report" aria-label="Paper check findings">
      <div className="paper-check-heading">Paper check <small>Read-only</small></div>
      <p>{report.summary}</p>
      {!report.findings.length ? <p>No supported issues reported in the inspected scope. This is not a correctness guarantee.</p> : null}
      {report.findings.map((finding: {
        title: string; severity: string; path: string | null; line: number | null;
        evidence: string; suggestion: string; needsAuthorInput: boolean;
      }, index: number) => (
        <article className="paper-finding" key={index}>
          <div className="paper-finding-title"><small data-severity={finding.severity}>{finding.severity}</small><strong>{finding.title}</strong></div>
          {finding.path ? <button type="button" className="finding-source" disabled={busy}
            onClick={() => onOpenSource(finding.path!, finding.line)}>
            {finding.path}{finding.line ? ` · L${finding.line}` : ""}
          </button> : <small>Source location unresolved</small>}
          <p><strong>Evidence: </strong>{finding.evidence}</p>
          <p><strong>Suggested action: </strong>{finding.suggestion}</p>
          {finding.needsAuthorInput ? <small className="finding-author-input">Author decision needed</small> : null}
        </article>
      ))}
      {report.limitations.length ? <details open><summary>Scope and limitations</summary>
        <ul>{report.limitations.map((limitation: string, index: number) => <li key={index}>{limitation}</li>)}</ul>
      </details> : null}
      <p className="finding-disclaimer">Suggestions only. To make a change, choose Normal chat or Polish selection and request it explicitly. Locations refer to the source at review time.</p>
    </section>
  );
}
