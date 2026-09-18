---
version: 1
slug: "app-components-paperworkspace-tsx"
primary_target: "app/components/PaperWorkspace.tsx"
related_targets: ["app/globals.css","app/primer-workbench.css","app/layout.tsx","app/components/SkillControls.tsx","app/components/WorkbenchDialog.tsx","app/components/PdfViewer.tsx","app/components/DiffViewer.tsx"]
---

# Primer paper workspace

Scope: integrate the approved isolated Primer preview into the real workbench. Mode: Operate. The author rejected the warm reading-desk identity and explicitly approved the Primer preview with layout 1, then said “it's fine. use it”. Its desktop.png, desktop-settings.png, and source-selection behavior are the visual and interaction references. Code-led; no raster comp. Local/subscription/review semantics remain authoritative.

## Direction contract

THESIS: Source, PDF, and agent stay visible together; selecting a passage never hides the agent behind source tabs.

OWN-WORLD: Real Primer components, author-approved Slate blue light and Graphite dark semantic surfaces, compact UI sans, blue focus/selection and primary actions. Keep success/error review colors independent, manuscript typography inside the white PDF, and monospace in source/diffs.

STORY: Select source or PDF, discuss in the visible agent, inspect proposed source changes, approve or undo, and compile. Keep live subscription catalogs, recovery, local save status, and disk-location controls.

FIRST VIEWPORT: Compact workspace bar, source left, PDF center, persistent agent right, two resizable dividers. Files on demand; source and agent collapse independently. Phones use full-width task views. Gear/info are separate Primer dialogs. Signature interaction: precise selection preserves mounted source and the visible agent. No page-load choreography; native control feedback only.

FORM: User-approved Primer layout 1 from sibling i-w-primer-preview, established by explicit user choice overriding seed 5a245df8. Integrate that choice without another direction round.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Verification boundary

Use isolated synthetic paper/API fixtures, no real agent turns or research-file edits. Preserve save/approval/Undo semantics and validate them with existing tests plus browser interaction checks. All live subscription catalogs remain dynamic. Capture desktop, mobile, and the user's available browser width. No backend restart is needed for this frontend-only change.

## Light-mode refinement — September 18, 2026

The author clarified that the whole interface felt white, not only the PDF well.
Use cool-gray semantic surfaces across the shell, source/editor, agent, toolbars
and dialogs, with a deeper gray PDF well. Reserve fixed white for manuscript
pages; retain Primer components, action colors, layout and dark palette.

## Approved palette pair — September 18, 2026

Supersedes the earlier color-only refinement: Slate blue light (`#f5f7fa`
panels, `#e8edf2` canvas, `#245baf` accent) and Graphite dark (`#21262e`
panels, `#15191f` canvas, `#80b4ff` accent). Use the existing light/dark
switch and persistence. Preserve layout, white PDF pages, and separate
success/warning/danger roles. No new palette picker or backend changes.
