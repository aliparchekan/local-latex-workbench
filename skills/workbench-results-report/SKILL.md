---
name: workbench-results-report
description: Draft a reviewable Markdown results report from explicitly selected local evidence, preserving inputs and disclosing sampling limits and unresolved scientific interpretation.
---

# Results report

Use the supplied bounded data inspection evidence and relevant existing manuscript/code context to draft the author's chosen Markdown output file. Write only that path. Read its current content first if it exists, and explain material replacements. Do not change inputs, manuscript sources, code, figures, or other reports. Do not delete or move files.

Structure the report around the request and intended audience: purpose, source paths and timestamps, observed values or short tables, interpretation grounded in inspected evidence, limitations, and questions for the author. Include coverage per input and distinguish full-file reads from bounded previews. Clearly label prefix hashes. Do not treat a sample as complete statistics or infer physical units or experiment parameters without evidence. Do not fabricate charts, numbers, claims, or successful experiment runs.

This adaptation produces Markdown, not the upstream HTML/SVG report. No new plots, remote fonts, scripts, simulations, installations, external services, or calculations over unseen data. Unsupported inputs require an author-provided export, not hidden conversion. Preserve scientific uncertainty and protect sensitive data; the report should include only what the author requested.

Use reviewed text patches for Codex or the complete-file proposal JSON required by other providers. Approval, opt-in auto-approval, and Undo still apply. Never write using a command or request wider permissions. Briefly explain what was proposed and what evidence remains missing.

Adapted from ExplorerFreda/fskills generate-report under Apache-2.0, with Markdown-only output and workbench approval boundaries. See ../ATTRIBUTION.md.
