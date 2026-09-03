# Local LaTeX Workbench

[![CI](https://github.com/aliparchekan/local-latex-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/aliparchekan/local-latex-workbench/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Local LaTeX Workbench is an independent, local-first workspace for revising LaTeX papers with source, rendered PDF, and a Codex conversation side by side. It connects to a locally installed Codex app-server and uses the user's existing ChatGPT/Codex sign-in; it does not configure an OpenAI API key or use the OpenAI SDK.

> [!IMPORTANT]
> This is an experimental, unofficial project. It is not affiliated with, endorsed by, or sponsored by OpenAI. It is not OpenAI Prism, and no Prism source code, artwork, logos, or copied interface assets are included.

## What it does

- Opens a research root containing code, data, figures, and a manuscript.
- Lets you choose a paper folder and a main `.tex` file within the research root.
- Shows only the paper folder in the file explorer while keeping the wider research workspace available as Codex context.
- Compiles with the local TeX installation and keeps SyncTeX metadata.
- Preserves the current PDF page, reading position, and zoom after recompilation.
- Keeps the Codex conversation pinned to its newest message while a response streams.
- Maps source selections to the rendered PDF and PDF text selections back to approximate source lines.
- Sends the exact selected LaTeX range as the primary target while allowing related edits when needed.
- Exposes the reasoning-effort levels advertised by the installed Codex model.
- Lets you resize the file, source, PDF, and Codex panes; the layout is saved in browser storage.
- Shows proposed text-file changes in full source before approval and supports conflict-aware undo for the last accepted patch.
- Recovers active turns and pending reviews after missed events or page reloads, with elapsed-time feedback and a Stop control.
- Shows the active file's absolute path and can reveal it in Finder.

## Platform and requirements

The current native folder picker and Finder integration require macOS. Other parts may work elsewhere, but are not yet supported as a complete workflow.

- Node.js 22.13 or newer
- A local Codex CLI installation signed in with ChatGPT
- A TeX distribution containing `latexmk` and `synctex`

## Run locally

```bash
git clone https://github.com/aliparchekan/local-latex-workbench.git
cd local-latex-workbench
npm install
npm run dev
```

Open `http://localhost:3210`. The trusted companion listens only on `127.0.0.1:4317` and handles folder selection, file access, LaTeX, SyncTeX, and the Codex subprocess.

If Codex is signed out, run `codex login` and choose ChatGPT authentication. This project intentionally has no API-key configuration.

## Workspace and approval model

The **research root** is Codex's working directory and may contain analysis code, data, generated figures, and the paper. The **paper folder** is the smaller subtree shown in the explorer and editable by hand. The main `.tex` file must be inside the paper folder.

Codex starts each turn in a read-only sandbox. Proposed UTF-8 text-file changes anywhere inside the research root are reconstructed as complete source, checked against the current files, and shown for approval. Accepting a proposal snapshots the affected files; a stale or mismatched proposal is refused. The last accepted patch can be undone while the affected files remain unchanged.

To rerun local code or generate supporting files, Codex may request turn-only command write access to a specific output folder inside the research root. Network access remains disabled. The approval card shows the requested folder before access is granted. Command writes in an approved folder can create, replace, or delete files and do **not** receive source-level diff review or the app's Undo AI edit recovery, so review these requests carefully and keep your research folder under version control or another backup system.

The companion rejects command access outside the research root, broad research-root grants, unsafe path patterns, and output folders containing symbolic or hard-linked files. These checks reduce risk; they are not a security boundary against other software already running as your operating-system user.

## Saving and persistence

The workbench edits the real local files; it does not keep a separate cloud manuscript. Ordinary editor changes autosave after a short pause. <kbd>Command</kbd>+<kbd>S</kbd> saves immediately. Opening another file, changing folders or the main file, compiling, mapping source to PDF, sending a Codex request, and undoing an accepted change all wait for the current buffer to save first.

Each source read records a SHA-256 content hash. A write includes that hash as its expected version, so an external change causes a conflict instead of a silent overwrite. A proposal marked **Proposal only · not written yet** exists only in the review UI until it is accepted.

Saved changes persist in the local files across app restarts. Pending approvals, chat messages, apply receipts, and the one-step undo snapshot are runtime state and may disappear when the companion restarts. Generated `.codex-paper-build` files are build output, not a backup.

## Selection accuracy

Source-to-PDF navigation is line-accurate when the LaTeX build emits SyncTeX data. PDF-to-source mapping is approximate because macros, equations, floats, ligatures, and generated text do not have a one-to-one character mapping. The rendered selection and mapped LaTeX remain visible so the source range can be adjusted before asking Codex.

## Useful commands

```bash
npm run build     # production frontend build
npm test          # build and application tests
npm run check     # TypeScript and companion syntax checks
npm run lint      # lint the source tree
npm start         # run the built frontend and local companion
```

## Privacy and security

- The manuscript and research files remain on the local disk unless Codex or another invoked tool transmits content under its own product behavior and terms.
- The companion accepts browser requests only from localhost origins and binds to the loopback interface. Do not proxy or expose port `4317` to another device or the public internet.
- Before opening an untrusted repository, inspect its instructions and scripts. An approved command-output folder permits changes anywhere underneath it for that turn.
- Report suspected vulnerabilities through a private GitHub security advisory rather than a public issue.

See [SECURITY.md](SECURITY.md) for the disclosure policy and [NOTICE](NOTICE) for naming, affiliation, and third-party notices.

## Contributing

Community contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), open an issue for substantial changes, and submit code through a pull request. Every pull request runs the same build, type, lint, and test checks used for releases.

## License

Licensed under the [Apache License 2.0](LICENSE). You may use, modify, and distribute the project under that license, including its notice and attribution requirements. Third-party dependencies remain subject to their own licenses.
