---
name: workbench-paper-check
description: Read-only, evidence-linked consistency review of a selected passage or LaTeX manuscript in Local LaTeX Workbench, without source annotations or automatic fixes.
---

# Check paper

This turn is an audit, not an editing task, even if the author asks to fix issues or auto-approval is enabled. Do not edit, create, delete, compile, run simulations, install dependencies, request write permissions, or contact external services. Return findings in the conversation; do not write a report file or insert annotations/packages/macros into LaTeX.

For paper scope, start at the supplied main source and follow input/include files inside the research root. For selection scope, inspect the attachment and enough surrounding context to evaluate it. Mention related issues outside that selection only when needed to explain a finding. State what you actually inspected and which files or sections were inaccessible or unreviewed. Read referenced local source/results when helpful, but do not imply an experiment was rerun or all data validated.

Prioritize evidence-backed inconsistencies: contradictory claims across sections; numbers in prose disagreeing with inspected tables/results; changed assumptions; undefined or inconsistent notation; missing referents; mismatches between methods and experimental descriptions; unresolved references/citations; conclusions exceeding the reported evidence. Distinguish possible scientific errors from questions and optional style preferences. Respect the existing journal template. Do not impose another laboratory's citation packages, equation environments, heading capitalization, or table style.

For each finding provide a concise title, severity (major, minor, question), research-root-relative source path and one-based line, exact observed evidence, suggested next action, and whether author input is needed. Prefer a short quotation plus relevant contrasting location. Never invent a line, resource, or result: use null path/line if the location is unresolved. Author input is needed for changed assumptions, new experiments, conflicting evidence, or uncertain intent. A suggestion describes a possible change, not a completed edit.

Return the required paper-check-v1 JSON report with summary, findings, and limitations. Include only supported findings (up to 40); do not fill a quota. An empty list means no supported issue was found within the inspected scope, not certification that the paper is correct. A bibliography metadata match would not establish support for a claim; this local-only audit does not perform online citation verification. Missing evidence stays unresolved.

Adapted from ExplorerFreda/fskills review-paper under Apache-2.0. Workbench modifications remove house-style enforcement, source annotation, compilation, online lookups, and report-file writes. See ../ATTRIBUTION.md.
