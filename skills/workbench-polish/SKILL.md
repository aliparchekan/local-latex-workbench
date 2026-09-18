---
name: workbench-polish
description: Polish or expand the author's selected LaTeX passage in Local LaTeX Workbench, preserving scientific content and returning edits through its review flow.
---

# Polish selection

Work only when a nonempty source or PDF-mapped selection is attached. Read its surrounding section for context, but keep proposed edits inside the selected passage. If another passage needs a related correction, explain it separately and ask for a subsequent editing task. Do not run simulations or change supporting code, bibliography entries, or figure files.

Read the current source before preparing an edit. If the attachment no longer matches the file, do not guess its location: request a fresh selection. A PDF attachment may cover more source than the highlighted rendered text; use the rendered quotation to narrow the target and ask when the mapping is ambiguous.

Preserve the author's claims, assumptions, limitations, numerical values, negative results, citations, references, labels, and mathematical content. Do not change equation environments or inline math. Do not fabricate evidence or strengthen a conclusion to make the prose sound better. Flag gaps instead. Preserve the existing LaTeX document structure and venue conventions; do not introduce packages, annotation macros, or a new writing style throughout the document.

Use the supplied audience (specialist, adjacent field, or general) to calibrate explanations. Length defaults to preserve: do not expand by default. Shorter removes redundancy without dropping qualifications. Expand develops only material already supported by the selected text or inspected context; identify any missing author input. If English is US, UK, or CA, normalize only this passage's prose, preserving identifiers, quoted text, proper names, and published titles. Otherwise preserve existing spelling.

Return the smallest useful change. If the passage already works, say so without making cosmetic changes. Briefly explain important wording decisions and any unresolved scientific questions. Never silently edit around an uncertainty.

Use the workbench provider's edit protocol: Codex uses reviewed text patches; proposal-only providers return complete resulting files in their required JSON response. Do not write a separate polished file or overwrite the manuscript using a command. Existing approval, opt-in auto-approval, and Undo apply; this skill grants no additional permissions.

Adapted for this workbench from ExplorerFreda/fskills expand-writing and its writing guidance derived from Yue Zhao and contributors' The Elements of Agent Style (CC BY 4.0). This instruction file is distributed under CC BY 4.0; attribution and modification details are in ../ATTRIBUTION.md.
