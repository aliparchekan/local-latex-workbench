# Local LaTeX Workbench

[![CI](https://github.com/aliparchekan/local-latex-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/aliparchekan/local-latex-workbench/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Local LaTeX Workbench is an independent, local-first workspace for revising LaTeX papers with source, rendered PDF, and a subscription-backed coding agent side by side. Choose a locally installed Codex, Claude Code, or Cursor Agent CLI and use that product's existing browser sign-in. The workbench does not configure provider API keys or use provider SDKs.

> [!IMPORTANT]
> This is an experimental, unofficial project. It is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, or Anysphere. It is not OpenAI Prism, and no third-party source code, artwork, logos, or copied interface assets are included.

## What it does

- Opens a research root containing code, data, figures, and a manuscript.
- Lets you choose a paper folder and a main `.tex` file within the research root.
- Shows only the paper folder in the file explorer while keeping the wider research workspace available as agent context.
- Compiles with the local TeX installation and keeps SyncTeX metadata.
- Preserves the current PDF page, reading position, and zoom after recompilation.
- Highlights PDF text edits since your last agent message without marking ordinary reflow; offers a separate visual comparison for figures and formatting.
- Keeps the agent conversation pinned to its newest message while a response streams.
- Maps source selections to the rendered PDF and PDF text selections back to approximate source lines.
- Sends the exact selected LaTeX range as the primary target while allowing related edits when needed.
- Lists the Codex and Claude Code models currently advertised by each local signed-in subscription and lets you choose one per research workspace.
- Updates the available intelligence levels from the selected model's live provider metadata.
- Keeps Source, PDF, and Agent visible together in independently resizable panes; the layout is saved in browser storage.
- Shows proposed text-file changes in full source before approval and supports conflict-aware undo for the last accepted patch.
- Offers opt-in **Auto-approve edits** for file proposals, without granting extra command or folder access.
- Recovers active turns and pending reviews after missed events or page reloads, with elapsed-time feedback and a Stop control.
- Shows the active file's absolute path and can reveal it in Finder.

## Platform and requirements

The current native folder picker and Finder integration require macOS. Other parts may work elsewhere, but are not yet supported as a complete workflow.

- Node.js 22.13 or newer
- At least one supported local agent CLI, signed in through its subscription:
  - [Codex CLI](https://developers.openai.com/codex/cli/) with ChatGPT (`codex login`)
  - [Claude Code](https://code.claude.com/docs/en/overview) with Claude (`claude auth login`)
  - [Cursor Agent CLI](https://cursor.com/docs/cli/overview) with Cursor (`agent login`)
- A TeX distribution containing `latexmk` and `synctex`

## Run locally

```bash
git clone https://github.com/aliparchekan/local-latex-workbench.git
cd local-latex-workbench
npm install
npm run dev
```

Open `http://localhost:3210`. The trusted companion listens only on `127.0.0.1:4317` and handles folder selection, file access, LaTeX, SyncTeX, and the selected agent subprocess.

Choose the signed-in agent from the **Agent** menu. If it is offline, run its login command above and refresh the workbench. The adapters remove `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `CURSOR_API_KEY` from their child-process environments so this workflow uses local subscription authentication rather than silently falling back to an API key.

For Codex and Claude Code, the **Model** menu is populated from the local provider CLI rather than a hardcoded list. Codex uses the newest locally available runtime, including a newer runtime bundled with the ChatGPT desktop app on macOS, and reads its app-server catalog. Claude Code reads the model-picker catalog returned by its subscription-backed initialization protocol. Choices are saved per provider and research workspace, and the **Intelligence** menu follows the levels advertised for the selected model. Set `LOCAL_LATEX_CODEX_BIN` to an explicit Codex executable if you need to override automatic runtime selection.

## Three-pane workspace and themes

On desktop, **Source** stays on the left, the rendered **PDF** in the center, and **Agent** on the right. Source selections do not hide the conversation. Collapse Source or Agent independently for more reading space; both stay mounted so the editor selection and unsent chat draft survive. Drag either divider to resize, use its arrow-key controls, or double-click it to restore the default width. **Fit** sizes the PDF to its available width; the zoom buttons switch to manual zoom.

**Files** opens the paper-folder explorer in a dialog. Choosing a file reveals Source after saving the current buffer. Select source text and choose **Ask agent** to carry that exact selection into chat. Pending proposals display a **Review** badge on Agent; **Review changes** brings its Accept/Reject controls into view. Provider, model, and intelligence choices live in Agent. On narrow screens, the top navigation switches between full-width Paper, Source, and Agent views.

The interface uses Primer controls with **Slate blue** light mode and **Graphite** dark mode. The sun/moon button switches themes and remembers the choice in this browser. Controls and dialogs follow the theme; manuscript PDF pages remain white, and warning/error/change-review colors keep their separate meanings.

## Agent choices

| Agent | Local interface | Editing behavior in the workbench |
| --- | --- | --- |
| Codex | `codex app-server` | Native streaming, reviewed text changes, and explicit turn-only output-folder requests for local commands |
| Claude Code | `claude -p` | Safe mode with read/search tools only; returns complete text proposals for workbench review |
| Cursor Agent | `agent -p --mode=ask` | Ask mode with sandboxing enabled; returns complete text proposals for workbench review |

Codex remains the default and follows its existing app-server path. Claude Code and Cursor are deliberately proposal-only: they cannot run research commands or create binary figures through this integration. This restriction keeps the workbench—not the provider CLI—in control of every file write, approval, stale-file check, and Undo snapshot.

## Bundled paper skills

Choose **Skill** above the chat composer. Skills use the selected subscription agent, model, and intelligence level; no extra API key or online skill installation is involved.

Click the **info icon** beside the selector (or beside a skill in Settings) to see what it does and its limits. The **gear icon** opens **Skill settings** for audience, length, spelling, review scope, data paths, and report output. Both open as dialogs without expanding the chat panel. **Save settings** remembers defaults separately for each research-root/paper-folder pair in this browser, across providers; it does not run a skill or alter model/approval settings. Cancel or Escape discards unsaved preferences, and opening help within Settings preserves the current draft. These settings are not shared between browsers and are not a paper backup. There is no custom-skill import or instructions editor.

- **Polish selection:** select LaTeX source or PDF-mapped text, then choose audience, length (keep, shorten, expand), and English spelling (keep, US, UK, CA). Additional instructions are optional. The skill preserves scientific claims, math, and LaTeX structure by instruction, and proposes changes through the normal approval/auto-approval and Undo flow. The companion limits its file proposals to the selected source file; review the diff because preservation of meaning still depends on the model. Stale or missing attachments are refused before inference.
- **Check paper:** choose whole paper or selected passage and optionally add a focus question. Returns read-only findings with evidence, suggested actions, author-decision flags, source-navigation buttons, and limitations. It does not compile, replace the PDF comparison baseline, write a report file, or apply changes—even with auto-approval on. Codex runs with read-only sandboxing and no approval escalation, and the companion rejects any write/permission requests; other providers retain read/search-only operation and cannot submit file proposals for this action. Your own unsaved editor changes still save before sending, as in normal chat.
- **English consistency:** choose US, UK, or Canadian spelling, for the whole paper or a selected passage. Proposes minimal spelling corrections in existing paper prose files (`.tex`, `.md`, `.markdown`, `.txt`, `.bib`), protecting mathematics, identifiers, names, quotations, and published titles by instruction. The server blocks file creation/deletion/moves and research-code edits; author review remains important.
- **Inspect local data:** choose up to five research-root-relative files in Settings. A dependency-free local inspector supplies bounded previews of CSV/TSV, JSON, JSONL, and primitive numeric NPY to the selected subscription agent. It reports file size, timestamp, full-file or prefix hash, available fields/dimensions, and samples. Reads are capped at 1 MiB/file and 20,000 parsed records; previews show five records/values. Large JSON is metadata-only. NPZ, Parquet, HDF5, NetCDF, structured/object NPY, and remote datasets are not supported; pickle is never evaluated. This action is read-only and performs no experiment runs or dataset-wide statistics. A full-file read with a bounded preview is not full scientific validation. Data previews enter the agent's context, just like source attachments; a local UI does not make subscription inference offline.
- **Results report:** use selected local data evidence to propose one Markdown output file (default `results-report.md`), with the chosen audience, provenance, observed values, limitations, and missing-evidence questions. Its parent folder must already exist. The server restricts writes to that exact `.md` path; inputs and manuscript files remain protected. This is a deliberately smaller adaptation of upstream HTML/SVG reports: no new charts, scripts, remote fonts, or simulations. Replacing an existing report uses ordinary review/auto-approval and Undo.
- **Normal chat:** restores ordinary agent behavior. Relevant local evidence inspection is part of its default guidance: before editing numerical or result-dependent claims, the agent should inspect the related result files and generating code, cite paths, and distinguish samples from complete evidence. You do not need to select Inspect local data first. This uses existing read/search capabilities; it is not a mandatory whole-folder scan or a guarantee of correctness. Ask explicitly for a finding to be addressed, or select its passage and use Polish selection. Whole-paper skills ignore an existing attachment; selection scope requires one.

Findings are model judgments, not verified scientific truth. Source locations refer to review-time files. No automatic online bibliography verification, simulation execution, or PDF-review annotation import is included. Cloud syncing and repository-wide precommit fixes are intentionally not exposed as paper skills. Chat/report persistence follows the existing session behavior below. Restart the local companion after updating; the UI checks skill capability version 2 before enabling these controls against an older server.

The curated instructions live in `skills/`; the server accepts only these known skill IDs, never a client-supplied skill path. Codex receives a native skill input alongside the bundled instructions; Claude/Cursor receive the same instructions under their proposal/report protocol. See [skill attribution and licenses](skills/ATTRIBUTION.md) before redistributing modified copies. These skills are not globally installed into any provider.

## Workspace and approval model

The **research root** is the selected agent's working directory and may contain analysis code, data, generated figures, and the paper. The **paper folder** is the smaller subtree shown in the explorer and editable by hand. The main `.tex` file must be inside the paper folder.

Every provider starts from a read-only or proposal-only mode. Proposed UTF-8 text-file changes anywhere inside the research root are reconstructed as complete source, checked against the current files, and shown for approval. Accepting a proposal snapshots the affected files; a stale, linked, outside-root, or mismatched proposal is refused. The last accepted patch can be undone while the affected files remain unchanged.

**Auto-approve edits**, in the agent panel, is off by default. Turning it on automatically accepts complete file proposals, including a currently pending proposal, for the selected paper/main file/provider in this browser tab. It uses the same validation, snapshots, apply receipts, and **Undo AI edit** as manual approval; Codex, Claude Code, and Cursor keep their existing restricted execution modes. File proposals can create, replace, move, or delete text files anywhere inside the research root, so enable this only when you trust the requested editing task. Automatically saved edits are noted in the conversation.

The toggle resets to off on refresh or when switching paper, main file, or provider; it is not shared between tabs. The workbench page must stay open for auto-approval to process requests. Turning it off stops subsequent automatic approvals but cannot cancel a write already approved. Each request is attempted automatically only once, including when progress is replayed after reconnect. If an automatic approval request fails or times out, auto-approval turns off and the existing review/status recovery stays available. Unconfirmed writes pause further approvals. Extra folder/command permissions are **never** auto-approved.

To rerun local code or generate supporting files, Codex may request turn-only command write access to a specific output folder inside the research root. Network access remains disabled. The approval card shows the requested folder before access is granted. Command writes in an approved folder can create, replace, or delete files and do **not** receive source-level diff review or the app's Undo AI edit recovery, so review these requests carefully and keep your research folder under version control or another backup system.

The companion rejects command access outside the research root, broad research-root grants, unsafe path patterns, and output folders containing symbolic or hard-linked files. These checks reduce risk; they are not a security boundary against other software already running as your operating-system user.

## Saving and persistence

The workbench edits the real local files; it does not keep a separate cloud manuscript. Ordinary editor changes autosave after a short pause. <kbd>Command</kbd>+<kbd>S</kbd> saves immediately. Opening another file, changing folders or the main file, compiling, mapping source to PDF, sending an agent request, and undoing an accepted change all wait for the current buffer to save first.

Each source read records a SHA-256 content hash. A write includes that hash as its expected version, so an external change causes a conflict instead of a silent overwrite. A proposal marked **Proposal only · not written yet** exists only in the review UI until it is accepted.

Saved changes persist in the local files across app restarts. Pending approvals, chat messages, apply receipts, and the one-step undo snapshot are runtime state and may disappear when the companion restarts. Generated `.codex-paper-build` files are build output, not a backup.

## PDF change highlights

Click **Highlight changes** above the rendered paper. Before each new editing message, the workbench saves the editor, compiles the paper, and captures a fixed before-PDF. Read-only **Check paper** runs skip compilation and leave that baseline unchanged. Subsequent compilations compare against that snapshot until you send another editing message. Approved edits, manual edits, and Undo are reflected when recompiled; unapproved proposals are not.

**Text edits** is the default: words are matched across the whole PDF, independently of line, column, or page positions. Yellow highlights mark added or changed wording. Removed/replaced text is listed below the comparison controls; deletion-only passages receive a small red marker near surviving text. Ligatures and supported line-wrap hyphenation are normalized, and page numbers/repeated margin headers are ignored. Changed word positions are measured using the same PDF text layer as the preview, not guessed from source-line positions.

Text matching anchors unchanged phrases first and compares the smaller gaps in bounded batches. Large edits and background-tab timer delays no longer share a single whole-document timeout. If a passage still cannot be aligned reliably, the comparison is explicitly labeled **Partial text comparison**, with the affected page and text sizes; that passage is left unhighlighted while other changes remain available. This is not a claim that the unresolved passage is unchanged. Check the source diff for completeness.

Use **Visual / figures (includes layout shifts)** explicitly to compare images, formatting, or scanned PDFs. That mode is page-by-page and also highlights layout shifts, potentially across the entire paper after reflow; pages beyond the current PDF's page count are displayed from the previous PDF. Text mode does not detect image-only or formatting-only changes. Neither mode detects source edits with no PDF effect. Complex PDF reading order, unusual equations, or ambiguous hyphenation can still need manual inspection; uncertain text is never silently replaced with a noisy pixel comparison. The PDF on disk is never annotated or overwritten by highlighting.

Snapshots stay in this browser's local IndexedDB, separately for each tab, paper/main file, and provider, and survive refresh in that tab. They are disposable comparison state, **not manuscript backups**; closing the tab or clearing browser storage can make them unavailable. PDFs over 64 MB and pages over four million pixels at scale 1 are not compared. If compilation or snapshot capture fails, the agent request still goes through, but highlights explicitly become unavailable rather than using an older message's snapshot. Messages sent before this feature was installed have no baseline.

## Selection accuracy

Source-to-PDF navigation is line-accurate when the LaTeX build emits SyncTeX data. PDF-to-source mapping is approximate because macros, equations, floats, ligatures, and generated text do not have a one-to-one character mapping. The rendered selection and mapped LaTeX remain visible so the source range can be adjusted before asking the selected agent.

## Useful commands

```bash
npm run build     # production frontend build
npm test          # build and application tests
npm run check     # TypeScript and companion syntax checks
npm run lint      # lint the source tree
npm start         # run the built frontend and local companion
```

## Privacy and security

- The manuscript and research files remain on local disk, but the selected agent CLI sends the prompt and any project content it chooses to read to its provider under that product's behavior and terms. “Local-first” describes storage and orchestration, not offline model execution.
- Claude Code runs with customizations disabled and only built-in read/search tools. Cursor runs in Ask mode without `--force`; Cursor may still load its documented workspace rules or MCP configuration, so inspect untrusted research folders before opening them.
- The companion accepts browser requests only from localhost origins and binds to the loopback interface. Do not proxy or expose port `4317` to another device or the public internet.
- Before opening an untrusted repository, inspect its instructions and scripts. An approved command-output folder permits changes anywhere underneath it for that turn.
- Report suspected vulnerabilities through a private GitHub security advisory rather than a public issue.

See [SECURITY.md](SECURITY.md) for the disclosure policy and [NOTICE](NOTICE) for naming, affiliation, and third-party notices.

## Contributing

Community contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), open an issue for substantial changes, and submit code through a pull request. Every pull request runs the same build, type, lint, and test checks used for releases.

## License

Licensed under the [Apache License 2.0](LICENSE). You may use, modify, and distribute the project under that license, including its notice and attribution requirements. Third-party dependencies remain subject to their own licenses.
