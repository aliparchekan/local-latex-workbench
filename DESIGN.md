---
name: Local LaTeX Workbench
description: A local manuscript workspace using native Primer Product UI.
colors:
  primary: "#245baf"
  accent: "#245baf"
  canvas: "#f5f7fa"
  canvas-muted: "#e8edf2"
  text: "#243247"
  text-muted: "#526276"
  border: "#c4ceda"
typography:
  title:
    fontFamily: '"Mona Sans VF", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Backtick Fix", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"'
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: '"Mona Sans VF", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Backtick Fix", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontSize: "14px"
    fontWeight: 500
  code:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "22px"
rounded:
  control: "6px"
  review-row: "8px"
  dialog: "12px"
  label: "9999px"
spacing:
  compact: "4px"
  small: "8px"
  control: "12px"
  pane: "16px"
  reading: "20px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 12px"
  button-default:
    backgroundColor: "{colors.canvas-muted}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 12px"
  button-invisible:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "32px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    typography: "{typography.body}"
  navigation:
    rounded: "{rounded.control}"
    height: "32px"
  review-row:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    rounded: "{rounded.review-row}"
    padding: "8px"
---

# Design System: Local LaTeX Workbench

## Overview

**Creative North Star: "Primer Product UI"**

A manuscript workspace expressed in Primer's familiar product language. Neutral surfaces, native UI sans, compact controls, and explicit states keep the manuscript and the next action legible together. This is the user's approved replacement for the warm cream, forest-green, serif interface; no additional decorative identity is introduced.

This record describes the integrated workbench, not the isolated preview. Native Primer controls frame the existing local subscription, compilation, selection, and review workflows. Visual consistency must not blur the difference between a proposal, an unconfirmed write, a saved file, and a rendered PDF.

**Key Characteristics:**

- Primer components and semantic theme tokens are authoritative.
- Flat workspace surfaces; restrained depth for paper and dialogs.
- Concurrent desktop working context with explicit selection, review, and save states.

Source authority: `app/layout.tsx` loads Primer Primitives, then `app/globals.css`, `app/workbench-themes.css`, and `app/primer-workbench.css`; `PaperWorkspace.tsx` supplies ThemeProvider and BaseStyles. Installed versions are Primer React 38.40.0, Primitives 11.10.0, and Octicons React 19.37.0. The approved surface contract is `.impeccable/surfaces/app-components-paperworkspace-tsx.md`; isolated verification evidence is in `.impeccable/review/primer-integration/verification.md` and `.impeccable/review/palettes/verification.md`. Synthetic screenshots are not evidence of live inference or real research-file changes.

## Colors

The author approved Slate blue for light mode and Graphite for dark mode on September 18 after comparing palette previews. The frontmatter records Slate blue; runtime color remaps Primer semantic variables in `app/workbench-themes.css`. The component system, typography and layout remain unchanged.

### Primary

Slate blue (`#245baf`, with white text) or Graphite's soft blue (`#80b4ff`, with `#15191f` text) identifies primary controls, including Compile, Save settings, and the real reviewed Accept action. Each theme's blue also identifies focus and selected context, with lower-intensity selection backgrounds. Primary-button colors are independent of success colors: additions, success, warnings and errors retain their semantic Primer colors and text labels.

### Neutral

Canvas, muted canvas, text, muted text, and border map to `--bgColor-default`, `--bgColor-muted`, `--fgColor-default`, `--fgColor-muted`, and `--borderColor-default`. Softer separators use `--borderColor-muted`; the PDF well uses `--bgColor-inset`. Success, danger, and attention remain semantic states with accompanying text, including additions/deletions and delayed confirmation.

Light and dark modes switch these same roles through the existing ThemeProvider and saved light/dark preference. Slate blue uses `#f5f7fa` for working panes and dialogs, `#e8edf2` for grouping and the PDF well, `#243247` text, and `#526276` secondary text. Graphite uses `#21262e` working panes and dialogs, `#15191f` grouping and PDF well, `#e6edf3` text, and `#acb8c7` secondary text. Selection backgrounds are `#d9e6f8` / `#293f5e`. Interactive field borders are stronger than structural separators for contrast. The PDF remains black manuscript content on white paper. Sidecar specimens inherit live semantic variables.

**The Semantic Color Rule.** Use Primer role tokens for interface color; reserve fixed white paper and manuscript ink for the PDF artifact.

**The Truthful State Rule.** A proposal is not a saved file, and a saved source file is not proof of a rebuilt PDF or a completed agent run.

## Typography

The interface uses Primer's `--fontStack-system`; no custom font is downloaded. Its Mona Sans-first stack falls back to the platform UI face. Source, diffs, and paths use `--fontStack-monospace`. Manuscript typography belongs to the PDF, not the interface.

The app title uses the title role. Pane headings are compact semibold text (13px); the welcome heading is 18px, and onboarding is 28px, reducing to 24px on phones. Conversation copy uses the body size with relaxed leading (1.65). Compact metadata is 10–12px and is not the body-text standard. Source uses the code role, increasing to 13px on phones. Mobile composer and dialog inputs reach 16px.

**The Source Alignment Rule.** Keep source, gutter, and review text on the same 22px line grid; verify source-location behavior when changing it.

## Layout

The reusable grammar is full-height, bordered panes with independent scrolling, stable toolbars, and shrinkable content regions. The workspace occupies `100dvh`; content regions own their overflow. Long paths and workspace names truncate in compact chrome while their full values remain available through existing titles or path actions.

For the approved surface, desktop layout 1 keeps source, PDF, and agent concurrent above 760px. Initial source/agent proportions are 31%/27%, with two 5px separators and the remainder for paper. `app/lib/pane-layout.mjs` fits saved proportions to the available width while retaining a usable paper column. Drag and keyboard resizing, reset, and independent source/agent collapse are real; there is no pane drag-reordering affordance. Collapsing a pane preserves its saved width.

At 1250px and below, secondary header content and padding condense. At 760px and below, Source/Paper/Agent become full-width task views in a Primer segmented control. Header height changes from 60px to 54px; pane headers change from 48px to 44px. At heights of 740px or less, the agent area can scroll to keep its working controls reachable. Files are on demand; selecting source or PDF preserves working context.

Settings use a sidebar and single-column fields on desktop, replacing the sidebar with a selector on phones. Dialog actions remain in Primer's separate footer region, outside the scrolling body. Native Primer dialog viewport constraints also apply.

## Elevation & Depth

Workspace panes use tonal grouping and thin borders, not floating card stacks. The PDF has a small page shadow (`0 1px 6px #00000018`). Dialogs retain Primer's `--shadow-floating-small` and `--overlay-backdrop-bgColor`; native default buttons retain their subtle resting shadow.

**The Flat Workspace Rule.** Keep working panes flat; use elevation to distinguish paper and modal overlays.

## Shapes

Controls and the composer use the control radius; file-review rows retain their slightly larger radius. Dialogs use Primer's larger dialog radius, and native metadata labels remain pill-shaped. Structural panes and the source editor have square edges. Rejecting the old visual world does not prohibit native Primer corner treatments.

## Components

- **Buttons:** real Primer primary, default, invisible, and danger variants carry their native states. Medium controls are 32px tall; small controls are 28px. The real Accept action uses the theme's primary blue; Reject is danger. Custom Send/first-open controls share primary hover, active and disabled tokens. Icon-only controls retain accessible names. Octicons lead the new shell, with existing SVG line icons retained in working controls.
- **Fields:** real Primer Select controls expose current provider/model/intelligence options, not screenshot fixture names. Native inputs/textareas remain in the composer and skill fields with semantic borders and focus states. The composer is not user-resizable; source remains monospaced with an inset focus ring.
- **Navigation and context:** mobile navigation uses SegmentedControl; desktop source/agent toggles collapse independently. The LaTeX Label is metadata, not a button. Selection attachments use the muted accent surface and retain removal controls.
- **Review:** the agent lists affected files; selecting one opens Current/Proposed source in the source pane. Preserve pending, applying, delayed-confirmation, and read-only states. Approval, opt-in auto-approval, and supported Undo remain real existing workflows. Research-folder command permissions explicitly warn that those writes are not source-reviewed and cannot be restored by Undo AI edit.
- **Dialogs:** Files, Skill settings, and skill information use Primer Dialog for containment, Escape, and focus return. Settings use the xlarge width and other dialogs the large width. Draft settings have Cancel and Save settings; saving persists paper-specific preferences in this browser, not manuscript edits or additional permissions.
- **Motion:** pane-column changes retain the existing 200ms ease transition, disabled during dragging. Primer buttons use 80ms state transitions; imported dialogs retain native opening motion. No custom entrance choreography is added. Reduced-motion preference disables animations and transitions globally.

## Do's and Don'ts

### Do:

- Do use installed Primer components and semantic tokens as the source of truth in both themes.
- Do preserve desktop pane concurrency, selection context, keyboard focus, and separate gear/info dialogs.
- Do preserve live subscription catalogs, local save status, approval boundaries, and the stated limits of Undo.

### Don't:

- Don't reintroduce cream/forest/serif chrome or invent a decorative brand identity.
- Don't replace real model catalogs with fixture options or present test activity as a live agent run.
- Don't imply pane drag-reordering, automatic PDF recompilation, or reversibility that the workflow does not provide.

Not canonized or repaired: legacy alias names such as `--green` and `--font-serif` survive internally but now resolve to semantic interaction blue and UI sans; they are not new design roles. Older overridden stylesheet values are not the current system.
