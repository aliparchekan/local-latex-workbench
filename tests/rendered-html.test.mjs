import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Local LaTeX Workbench application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Local LaTeX Workbench[^<]*AI paper workspace<\/title>/i);
  assert.match(html, /Local LaTeX Workbench/);
  assert.match(html, /Workspace views/);
  assert.match(html, /Choose research workspace/i);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview|react-loading-skeleton/i);
});

test("keeps the product local and subscription-backed", async () => {
  const [workspace, packageJson, layout] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /AGENT_SUBSCRIPTIONS/);
  assert.match(workspace, /no API key/i);
  assert.match(workspace, /DiffViewer/);
  assert.match(workspace, /PdfViewer/);
  assert.match(packageJson, /"dev:local": "node server\/index\.mjs"/);
  assert.match(packageJson, /vinext dev -p 3210/);
  assert.match(packageJson, /vinext start -p 3210/);
  assert.doesNotMatch(packageJson, /vinext (?:dev|start) -p 3000/);
  assert.doesNotMatch(packageJson, /"openai"\s*:/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project/);
});

test("keeps skill settings and information in independent accessible dialogs", async () => {
  const [skills, dialog, styles] = await Promise.all([
    readFile(new URL("../app/components/SkillControls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/WorkbenchDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(skills, /icon=\{GearIcon\}/);
  assert.match(skills, /aria-label="Skill settings"/);
  assert.equal((skills.match(/<WorkbenchDialog /g) ?? []).length, 2);
  assert.match(skills, /aria-haspopup="dialog"/);
  assert.match(skills, /lattice:skill-defaults:v2:/);
  assert.match(skills, /localStorage\.setItem\(storageKey, JSON\.stringify\(normalized\)\)/);
  assert.match(skills, /const close = \(\) => setDraft\(null\)/);
  assert.match(dialog, /import \{ Dialog \} from "@primer\/react"/);
  assert.match(dialog, /if \(!open\) return null/);
  assert.match(dialog, /onClose=\{onClose\}/);
  assert.match(dialog, /title=\{title\}/);
  assert.match(styles, /\.workbench-dialog-body \{[^}]*min-height: 0;[^}]*overflow-y: auto/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("offers isolated Codex, Claude Code, and Cursor subscription adapters", async () => {
  const [workspace, companion, providers] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/providers.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /<option value="codex">Codex<\/option>/);
  assert.match(workspace, /<option value="claude">Claude Code<\/option>/);
  assert.match(workspace, /<option value="cursor">Cursor Agent<\/option>/);
  assert.match(workspace, /provider: agentProvider/);
  assert.match(workspace, /Uses your.*subscription · no API key/);
  assert.match(companion, /streamExternalAgentTurn/);
  assert.match(companion, /applyExternalApproval/);
  assert.match(providers, /"--mode=ask"/);
  assert.match(providers, /"--sandbox=enabled"/);
  assert.match(providers, /"--safe-mode"/);
  assert.match(providers, /"Read,Glob,Grep"/);
  assert.doesNotMatch(providers, /"--force"|"--yolo"|dangerously-skip-permissions/);
  assert.match(providers, /delete env\.ANTHROPIC_API_KEY/);
  assert.match(providers, /delete env\.CURSOR_API_KEY/);
});

test("selects models from each provider's signed-in subscription catalog", async () => {
  const [workspace, companion] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /aria-label={`\$\{agentName\} model`}/);
  assert.match(workspace, /lattice:codex-model:/);
  assert.match(workspace, /lattice:model:\$\{provider\}:/);
  assert.match(workspace, /model: agentProvider === "cursor" \? null : selectedModel/);
  assert.match(workspace, /selectedModelSettings/);
  assert.match(workspace, /function modelOptionLabel\(model: AgentModelOption\)/);
  assert.match(workspace, /model\.description\.split\(\/\\s\+·\\s\+\//);
  assert.match(workspace, /\{modelOptionLabel\(model\)\}/);
  assert.match(companion, /codexClient\.request\("model\/list"/);
  assert.match(companion, /request: { subtype: "initialize" }/);
  assert.match(companion, /claudeModelSettingsFromCatalog/);
  assert.match(companion, /if \(requestedModel\) turnParams\.model = requestedModel/);
  assert.match(companion, /allowProviderModelFallback: false/);
  assert.match(companion, /verifyAcceptedCodexModel/);
  assert.match(companion, /method === "model\/rerouted"/);
  assert.match(workspace, /confirmedAgentRuntime/);
  assert.match(workspace, /confirmed/);
  assert.match(companion, /model_unavailable/);
});

test("makes local save destinations and persistence state explicit", async () => {
  const [workspace, companion] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);

  // The active on-disk destination is visible and actionable in the document toolbar.
  assert.match(workspace, />\s*Local path\s*</);
  assert.match(workspace, /"Copied" : "Copy path"/);
  assert.match(workspace, />\s*Show in Finder\s*</);
  assert.match(workspace, /navigator\.clipboard\.writeText\(path\)/);
  assert.match(workspace, /api\("\/api\/folder\/reveal"/);
  assert.match(companion, /req\.method === "POST" && url\.pathname === "\/api\/folder\/reveal"/);
  assert.match(companion, /await revealPaperLocation\(await readJson\(req\)\)/);

  // Reads establish a content hash and writes send it back so outside edits are not overwritten.
  assert.match(workspace, /fileHashRef\.current = result\.hash/);
  assert.match(workspace, /method: "PUT",[\s\S]{0,500}?expectedHash,/);
  assert.match(companion, /req\.method === "GET" && url\.pathname === "\/api\/file"/);
  assert.match(companion, /hash: file\.hash/);
  assert.match(companion, /const expected = expectedSaveHash\(body\)/);
  assert.match(companion, /"file_conflict"/);

  // Save state distinguishes an in-memory proposal from bytes confirmed on disk.
  assert.match(workspace, /label: "Proposal only", detail: "not written yet"/);
  assert.match(workspace, /label: "Saved to disk"/);
  assert.match(workspace, /addEventListener\("beforeunload", warnBeforeUnload\)/);
  assert.match(workspace, /if \(!dirty && !saving\) return/);

  const shortcutStart = workspace.indexOf("const saveShortcut");
  const shortcutEnd = workspace.indexOf("const locateSourceInPdf", shortcutStart);
  assert.ok(shortcutStart >= 0 && shortcutEnd > shortcutStart);
  const shortcut = workspace.slice(shortcutStart, shortcutEnd);
  assert.match(shortcut, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(shortcut, /event\.key\.toLowerCase\(\) !== "s"/);
  assert.match(shortcut, /event\.preventDefault\(\)/);
  assert.match(shortcut, /void saveNow\(\)/);

  // Risky transitions wait for a successful save before moving away from the current buffer.
  const guardedSections = [
    ["const openFileAfterSave", "const compile"],
    ["const compile", "const openProject"],
    ["const chooseWorkspace", "const choosePaperFolder"],
    ["const choosePaperFolder", "const copyLocalPath"],
    ["const locateSourceInPdf", "const handlePdfSelection"],
    ["const sendToAgent", "const decideApproval"],
    ["const undoLastChange", "const resizePane"],
  ];
  for (const [startMarker, endMarker] of guardedSections) {
    const start = workspace.indexOf(startMarker);
    const end = workspace.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `missing ${startMarker} persistence boundary`);
    assert.match(workspace.slice(start, end), /if \(!\(await saveNow\(\)\)\) (?:return(?: (?:false|null))?;|\{ sendingRef\.current = false; return; \})/);
  }
  assert.match(workspace, /void openFileAfterSave\(path\)/);
  assert.match(workspace, /const nextContent = await openFileAfterSave\(primaryPath, project\)/);
});

test("preserves the PDF reading position across recompiles of the same paper", async () => {
  const [workspace, pdfViewer] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PdfViewer.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(pdfViewer, /type ReadingPosition = \{/);
  assert.match(pdfViewer, /pageNumber: number/);
  assert.match(pdfViewer, /pageOffsetRatio: number/);
  assert.match(pdfViewer, /horizontalRatio: number/);
  assert.match(pdfViewer, /captureReadingPosition\(container/);
  assert.match(pdfViewer, /restoreReadingPosition\(container, position\)/);
  // Removed-page previews must not participate in the current PDF's scroll anchors.
  assert.match(pdfViewer, /data-pdf-page-number=\{removed \? undefined : pageNumber\}/);
  assert.match(pdfViewer, /ref=\{pagesRef\} className="pdf-pages" onScroll=\{rememberReadingPosition\}/);
  assert.match(pdfViewer, /useLayoutEffect\(\(\) => \{[\s\S]*?window\.requestAnimationFrame/);
  assert.match(pdfViewer, /revealedFocusRef\.current === focus/);
  assert.match(pdfViewer, /key=\{index \+ 1\}/);

  const previewStart = workspace.indexOf("<PdfViewer");
  const previewEnd = workspace.indexOf("/>", previewStart);
  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  const preview = workspace.slice(previewStart, previewEnd);
  assert.match(preview, /key=\{project && mainFile/);
  assert.match(preview, /project\.researchRoot/);
  assert.match(preview, /project\.paperRoot/);
  assert.match(preview, /mainFile/);
  assert.doesNotMatch(preview, /buildId.*\? .*key|key=.*buildId/);
});

test("keeps the agent conversation pinned to its newest message", async () => {
  const workspace = await readFile(
    new URL("../app/components/PaperWorkspace.tsx", import.meta.url),
    "utf8",
  );

  assert.match(workspace, /const chatScrollRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(workspace, /chat\.scrollTop = chat\.scrollHeight/);
  assert.match(workspace, /useLayoutEffect\(\(\) => \{\s*scrollChatToEnd\(\)/);
  assert.match(workspace, /\[agentBusy, buildId, compiling, latestDiff, messages, pendingApproval, scrollChatToEnd, turnMonitor\]/);
  assert.match(workspace, /new ResizeObserver\(scrollChatToEnd\)/);
  assert.match(workspace, /<div ref=\{chatScrollRef\} className="chat-scroll">/);
});

test("defaults PDF highlights to content matching and applies PDF.js text geometry", async () => {
  const [viewer, styles, comparison] = await Promise.all([
    readFile(new URL("../app/components/PdfViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/pdf-comparison.ts", import.meta.url), "utf8"),
  ]);
  assert.match(viewer, /useState<PdfComparisonMode>\("text"\)/);
  assert.match(viewer, /aria-label="PDF comparison mode"/);
  assert.match(viewer, /<option value="visual">Visual \/ figures \(includes layout shifts\)<\/option>/);
  assert.match(viewer, /Partial text comparison/);
  assert.match(viewer, /Those passages are left unhighlighted, not marked as unchanged/);
  assert.match(comparison, /unresolved: diff\.unresolved \?\? \[\]/);
  assert.match(comparison, /if \(mode === "text"\) return comparePdfText/);
  assert.match(comparison, /range\.setStart\(node, span\.start\)/);
  assert.match(styles, /font-size: calc\(var\(--text-scale-factor\) \* var\(--font-height, 0px\)\)/);
  assert.match(styles, /scaleX\(var\(--scale-x, 1\)\)/);
});

test("auto-approval is an explicit per-paper opt-in using the existing apply recovery", async () => {
  const [workspace, control] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AutoApproval.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(control, /useState\(false\)/);
  assert.match(control, /role="switch"/);
  assert.match(control, /aria-label="Auto-approve edits"/);
  assert.doesNotMatch(control, /localStorage|sessionStorage/);
  assert.match(workspace, /key=\{JSON.stringify\(\[project\?\.researchRoot, project\?\.paperRoot, mainFile, agentProvider\]\)\}/);
  assert.match(workspace, /onApprove=\{\(\) => decideApproval\("accept", true\)\}/);
  assert.match(workspace, /pendingApproval.approvalType !== "file"/);
  assert.match(workspace, /approvalDecisionInFlightRef.current = true/);
  assert.match(workspace, /approvalApplying \|\| applyConfirmationDelayed \|\| refreshingAfterApply/);
});

test("supports resizable panes and full-source approval review", async () => {
  const [workspace, resizeHandle, sourceReview, diffViewer, companion, styles] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ResizeHandle.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SourceReview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/DiffViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.equal([...workspace.matchAll(/<ResizeHandle\b/g)].length, 1);
  assert.match(workspace, /lattice:primer-pane-layout:v1/);
  assert.match(workspace, /label=\{`Resize \$\{pane\} pane`\}/);
  assert.match(workspace, /review=\{activeReviewFile\}/);
  assert.match(workspace, /const files = event\.files \?\? \[\]/);
  assert.match(resizeHandle, /role="separator"/);
  assert.match(resizeHandle, /onDoubleClick/);
  assert.match(sourceReview, />\s*Current\s*<\/button>/);
  assert.match(sourceReview, />\s*Proposed\s*<\/button>/);
  assert.match(sourceReview, /mode === "current" \? "removed" : "added"/);
  assert.match(diffViewer, /Affected files/);
  assert.match(diffViewer, /compare its Current and Proposed source/);
  assert.match(diffViewer, /Apply confirmation delayed/);
  assert.match(workspace, /event\.type === "applyCompleted"/);
  assert.match(workspace, /\/api\/changes\/status/);
  assert.match(workspace, /APPLY_RECOVERY_TIMEOUT_MS/);
  assert.match(companion, /files: publicReviewFiles\(reviewFiles\)/);
  assert.match(companion, /type: "applyCompleted"/);
  assert.match(companion, /url\.pathname === "\/api\/changes\/status"/);
  assert.match(companion, /expectedAfter/);
  assert.match(styles, /grid-template-columns: var\(--explorer-width/);
  assert.match(styles, /\.source-review-line-added/);
});

test("keeps source and agent in independent mounted Primer panes", async () => {
  const [workspace, styles] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/primer-workbench.css", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /id="source-tool-panel"/);
  assert.match(workspace, /id="codex-pane"/);
  assert.doesNotMatch(workspace, /drawerTab|Working drawer tools/);
  assert.match(workspace, /paneHandle\("source"\)/);
  assert.match(workspace, /paneHandle\("agent"\)/);
  assert.match(workspace, /setSourceVisible\(true\)/);
  assert.match(workspace, /setAgentVisible\(true\)/);
  assert.match(workspace, /<WorkbenchDialog open=\{explorerOpen\} title="Paper files"/);
  assert.match(workspace, /aria-label="Workspace views"/);
  assert.match(styles, /grid-template-columns: var\(--source-width\) 5px minmax\(0,1fr\) 5px var\(--agent-width\)/);
  assert.match(styles, /@media \(max-width: 760px\)/);
});

test("settles approved changes from backend receipts and offers delayed-status recovery", async () => {
  const [workspace, diffViewer, companion] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/DiffViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /APPROVAL_REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(workspace, /APPLY_POLL_INTERVAL_MS = 750/);
  assert.match(workspace, /APPLY_RECOVERY_TIMEOUT_MS = 30_000/);
  assert.match(workspace, /event\.type === "applyCompleted"/);
  assert.match(workspace, /"\/api\/changes\/status"/);
  assert.match(workspace, /window\.setTimeout\(\(\) => controller\.abort\(\), APPROVAL_REQUEST_TIMEOUT_MS\)/);
  assert.match(workspace, /activeReadOnly = refreshingAfterApply/);

  const settleStart = workspace.indexOf("const settleActiveApply");
  const settleEnd = workspace.indexOf("const markApplyConfirmationDelayed", settleStart);
  assert.ok(settleStart >= 0 && settleEnd > settleStart);
  const settlement = workspace.slice(settleStart, settleEnd);
  assert.match(settlement, /setApprovalApplying\(false\)/);
  assert.match(settlement, /setPendingApproval\(null\)/);
  assert.match(settlement, /void refreshProjectAfterApply\(activeApply\)/);
  assert.match(settlement, /void compile\(/);
  assert.doesNotMatch(settlement, /await compile\(/);

  assert.match(diffViewer, /"Check status"/);
  assert.match(companion, /type: "applyCompleted"/);
  assert.match(companion, /url\.pathname === "\/api\/changes\/status"/);
});

test("scopes the explorer to the paper and forwards selection intelligence", async () => {
  const [workspace, fileTree, companion] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FileTree.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /AI agent provider/);
  assert.match(workspace, /agentName} intelligence level/);
  assert.match(workspace, /reasoningEffort/);
  assert.match(workspace, /Selection is the primary target/);
  assert.match(fileTree, /aria-label="Paper files"/);
  assert.match(companion, /const tree = await visit\(paperRoot, 0\)/);
  assert.match(companion, /turnParams\.effort = requestedEffort/);
  assert.match(companion, /Selected source:.*columns/);
});

test("reviews research source changes and grants only explicit output folders", async () => {
  const [workspace, diffViewer, companion] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/DiffViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /approvalType\?: "file" \| "permission"/);
  assert.match(workspace, /writePaths\?: string\[\]/);
  assert.match(workspace, /writeTargets\?: ApprovalWriteTarget\[\]/);
  assert.match(workspace, /approval\.approvalType === "permission"/);
  assert.match(workspace, /smallest research-output folder/);
  assert.match(diffViewer, /Allow research-support work\?/);
  assert.match(diffViewer, /Requested write paths/);
  assert.match(diffViewer, /Network access stays off/);
  assert.match(diffViewer, /Folder access includes everything underneath/);
  assert.match(diffViewer, /create, replace, or delete files anywhere under/);
  assert.match(diffViewer, /created, replaced, or deleted by a command/);
  assert.match(diffViewer, /cannot be restored by Undo AI edit/);

  assert.match(companion, /request_permissions: true/);
  assert.match(companion, /message\.method === "item\/permissions\/requestApproval"/);
  assert.match(companion, /method === "serverRequest\/resolved"/);
  assert.match(workspace, /event\.type === "approvalResolved"/);
  assert.match(companion, /permissions: body\.decision === "accept" \? pending\.grantedPermissions : \{\}/);
  assert.match(companion, /scope: "turn"/);
  assert.match(companion, /sandboxPolicy: \{ type: "readOnly", networkAccess: false \}/);
  assert.match(companion, /sandbox: "read-only"/);
  assert.doesNotMatch(companion, /sandbox(?:Policy)?: [^\n]*workspaceWrite/);
  assert.match(companion, /safeApprovalPath\(session\.researchRoot/);
  assert.match(companion, /assertPermissionDirectorySafe/);
  assert.match(companion, /preparePermissionGrant/);
  assert.match(companion, /await fs\.mkdir\(resolved\.path/);
  assert.match(companion, /smallest containing output folder/);
  assert.match(companion, /const tree = await visit\(paperRoot, 0\)/);
});

test("treats source navigation as a one-shot caret move", async () => {
  const [workspace, sourceEditor] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SourceEditor.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /setSourceFocusRequest\(\{ id: sourceFocusIdRef\.current, line \}\)/);
  assert.match(workspace, /focusSourceLine\(startLine\)/);
  assert.match(sourceEditor, /handledFocusIdRef\.current === focusRequest\.id/);
  assert.match(sourceEditor, /handledFocusIdRef\.current = focusRequest\.id/);
  assert.match(sourceEditor, /textarea\.setSelectionRange\(start, start\)/);
  assert.doesNotMatch(sourceEditor, /textarea\.setSelectionRange\(start, endOfLine/);
});

test("recovers stalled turns, restores hidden reviews, and offers a safe stop", async () => {
  const [workspace, companion, styles] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /"\/api\/agent\/status"/);
  assert.match(workspace, /"\/api\/agent\/stop"/);
  assert.match(workspace, /Taking longer than usual/);
  assert.match(workspace, /recoverApproval/);
  assert.match(workspace, /"Stop"/);
  assert.match(companion, /const activeTurns = new Map\(\)/);
  assert.match(companion, /cancel \? "cancel" : "decline"/);
  assert.match(companion, /"turn\/interrupt"/);
  assert.match(companion, /url\.pathname === "\/api\/agent\/status"/);
  assert.match(companion, /url\.pathname === "\/api\/agent\/stop"/);
  assert.match(styles, /\.turn-monitor\.is-delayed/);
  assert.match(styles, /\.turn-stop-button/);
});
