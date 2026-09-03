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
  assert.match(html, /local paper studio/i);
  assert.match(html, /Choose research workspace/i);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview|react-loading-skeleton/i);
});

test("keeps the product local and subscription-backed", async () => {
  const [workspace, packageJson, layout] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /Codex subscription/);
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
    ["const sendToCodex", "const decideApproval"],
    ["const undoLastChange", "const explorerMaximum"],
  ];
  for (const [startMarker, endMarker] of guardedSections) {
    const start = workspace.indexOf(startMarker);
    const end = workspace.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `missing ${startMarker} persistence boundary`);
    assert.match(workspace.slice(start, end), /if \(!\(await saveNow\(\)\)\) return(?: (?:false|null))?;/);
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
  assert.match(pdfViewer, /data-pdf-page-number=\{pageNumber\}/);
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

test("keeps the Codex conversation pinned to its newest message", async () => {
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

test("supports resizable panes and full-source approval review", async () => {
  const [workspace, resizeHandle, sourceReview, diffViewer, companion, styles] = await Promise.all([
    readFile(new URL("../app/components/PaperWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ResizeHandle.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SourceReview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/DiffViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.equal([...workspace.matchAll(/<ResizeHandle\b/g)].length, 3);
  assert.match(workspace, /lattice:pane-layout:v1/);
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

  assert.match(workspace, /Codex intelligence level/);
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
