// This is a curated catalog, not an arbitrary local/remote skill installer.
export const WORKBENCH_SKILLS = Object.freeze([
  { id: "polish-selection", name: "workbench-polish", label: "Polish selection", readOnly: false,
    scope: "selection", scopes: ["selection"],
    description: "Improve a selected passage without changing its scientific meaning. Choose audience, length, and spelling in Settings. Proposals use your approval setting and Undo. Math and claims are protected by instructions, not a proof of correctness." },
  { id: "check-paper", name: "workbench-paper-check", label: "Check paper", readOnly: true,
    scope: "paper", scopes: ["paper", "selection"],
    description: "Read-only consistency review: claims, numbers, notation, references, and conclusions. Returns evidence and source links, not edits. Whole-paper scope ignores a highlighted selection. No compilation, online citation checks, or simulation runs." },
  { id: "english-consistency", name: "workbench-english", label: "English consistency", readOnly: false,
    scope: "paper", scopes: ["paper", "selection"],
    description: "Propose US, UK, or Canadian spelling corrections in paper prose. Preserves math, identifiers, names, quotations, and published titles. No research-code formatting. Edits use your approval setting and Undo; choose the target spelling in Settings." },
  { id: "inspect-data", name: "workbench-inspect-data", label: "Inspect local data", readOnly: true,
    scope: "resources", scopes: ["resources"],
    description: "Read-only preview of selected research files. A bounded local inspector supplies sizes, fields, rows, and samples to your selected agent. Supports CSV, TSV, JSON, JSONL, and numeric NPY. Large files are explicitly sampled; no experiment reruns or internet downloads. NPZ, Parquet, HDF5, and NetCDF are not yet supported." },
  { id: "generate-report", name: "workbench-results-report", label: "Results report", readOnly: false,
    scope: "resources", scopes: ["resources"],
    description: "Draft a local Markdown results report from selected data, with source paths, coverage limits, tables, and missing-evidence caveats. Only the chosen .md output file may change, through review and Undo. No new plots, calculations over unseen data, or manuscript edits." },
]);

export function defaultSkillOptions(id = "") {
  const skill = WORKBENCH_SKILLS.find((entry) => entry.id === id);
  return { id, scope: skill?.scope ?? "selection", audience: "specialist", length: "preserve",
    english: id === "english-consistency" ? "US" : "preserve", resourcePaths: "",
    outputPath: "results-report.md" };
}

export function normalizeSkillDefaults(value) {
  const result = {};
  for (const skill of WORKBENCH_SKILLS) {
    const base = defaultSkillOptions(skill.id);
    const saved = value?.[skill.id];
    if (saved && typeof saved === "object") {
      if (skill.scopes.includes(saved.scope)) base.scope = saved.scope;
      if (["specialist", "adjacent", "general"].includes(saved.audience)) base.audience = saved.audience;
      if (["preserve", "shorter", "expand"].includes(saved.length)) base.length = saved.length;
      if ((skill.id === "english-consistency" ? ["US", "UK", "CA"] : ["preserve", "US", "UK", "CA"]).includes(saved.english)) base.english = saved.english;
      if (typeof saved.resourcePaths === "string" && saved.resourcePaths.length <= 8000) base.resourcePaths = saved.resourcePaths;
      if (typeof saved.outputPath === "string" && saved.outputPath.length <= 1000) base.outputPath = saved.outputPath;
    }
    result[skill.id] = base;
  }
  return result;
}

export const PAPER_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "summary", "findings", "limitations"],
  properties: {
    kind: { type: "string", enum: ["paper-check-v1"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "path", "line", "evidence", "suggestion", "needsAuthorInput"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["major", "minor", "question"] },
          path: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          evidence: { type: "string" },
          suggestion: { type: "string" },
          needsAuthorInput: { type: "boolean" },
        },
      },
    },
    limitations: { type: "array", items: { type: "string" }, maxItems: 30 },
  },
};

export function validatePaperCheck(value) {
  const text = (v) => typeof v === "string" && v.length <= 30_000;
  if (!value || value.kind !== "paper-check-v1" || !text(value.summary)
    || !Array.isArray(value.findings) || value.findings.length > 40
    || !Array.isArray(value.limitations) || value.limitations.length > 30
    || !value.limitations.every(text)) throw new Error("The paper check returned an invalid report.");
  if (value.changes != null && (!Array.isArray(value.changes) || value.changes.length)) {
    throw new Error("Check paper is read-only. The agent returned file changes; none were applied.");
  }
  const findings = value.findings.map((finding) => {
    if (!finding || !text(finding.title) || !text(finding.evidence) || !text(finding.suggestion)
      || !["major", "minor", "question"].includes(finding.severity)
      || typeof finding.needsAuthorInput !== "boolean"
      || !(finding.path === null || (text(finding.path) && finding.path.length > 0
        && !/^(?:\/|[A-Za-z]:)|[\\\x00-\x1f]/.test(finding.path)
        && !finding.path.split("/").some((part) => part === ".." || part === "." || !part)))
      || !(finding.line === null || (Number.isSafeInteger(finding.line) && finding.line > 0 && finding.line <= 10_000_000))
      || (finding.path === null && finding.line !== null)) {
      throw new Error("The paper check returned an invalid finding or source location.");
    }
    return { title: finding.title, severity: finding.severity, path: finding.path, line: finding.line,
      evidence: finding.evidence, suggestion: finding.suggestion, needsAuthorInput: finding.needsAuthorInput };
  });
  return { kind: "paper-check-v1", summary: value.summary, findings, limitations: value.limitations };
}

export function parsePaperCheck(text) {
  try {
    const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return validatePaperCheck(JSON.parse(raw));
  } catch {
    return null;
  }
}
