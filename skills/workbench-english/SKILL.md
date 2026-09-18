---
name: workbench-english
description: Normalize US, UK, or Canadian spelling in selected LaTeX prose or paper files using reviewable changes, without modifying research code or scientific content.
---

# English consistency

Read the current selected passage, or the main paper and its included prose files for paper scope. Propose minimal spelling corrections for the supplied English variant. Restrict changes to existing .tex, .md, .markdown, .txt, and .bib files in the paper folder. For selection scope, edit only the selected passage. Do not scan or reformat research code.

Protect mathematical expressions, LaTeX commands and labels, citation keys, identifiers, URLs, quotations, proper names, published titles, and bibliography metadata. In .bib files, only author-written notes or annotations may be corrected; do not normalize a publication's title. Preserve scientific claims, numbers, assumptions, and structure. Canadian spelling is not a blind US-to-UK replacement: flag ambiguous usage for the author instead of guessing.

Group proposed corrections by pattern and show representative examples. If no change is warranted, return a short explanation. Do not create, delete, move, compile, run simulations, install tools, or request additional command permissions. Use reviewed patches for Codex and the required complete-file proposal JSON for other providers. Approval or opt-in auto-approval and Undo remain in force; this skill grants no new authority.

Adapted from ExplorerFreda/fskills ensure-english-consistency under Apache-2.0, narrowed to paper prose and the workbench review flow. See ../ATTRIBUTION.md.
