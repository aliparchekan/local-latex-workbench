import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkbenchSkill, skillTurnInput, selectionMatchesSource } from "../server/workbench-skills.mjs";
import { validatePaperCheck, parsePaperCheck, PAPER_CHECK_SCHEMA, WORKBENCH_SKILLS, normalizeSkillDefaults } from "../app/lib/workbench-skills.mjs";
import { parseProviderResult, providerInvocation } from "../server/providers.mjs";
import { agentSessions, pendingApprovals, handleCodexServerRequest, prepareAgentRequest, proposalChangesForReview } from "../server/index.mjs";

const selection = { path: "paper/main.tex", text: "This result holds.", startLine: 2, endLine: 2, startColumn: 1, endColumn: 19, origin: "source" };
const report = {
  kind: "paper-check-v1", summary: "One question in the selected section.",
  findings: [{ title: "Assumption unspecified", severity: "question", path: "paper/main.tex", line: 2,
    evidence: "The passage says 'This result holds.' without stating the condition.",
    suggestion: "Ask the author which condition applies.", needsAuthorInput: true }],
  limitations: ["Only the selected section was inspected; no simulations were run."],
};

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workbench-skills-test-")));
  await mkdir(path.join(root, "paper"));
  await writeFile(path.join(root, "paper/main.tex"), "\\section{Results}\nThis result holds.\n");
  await writeFile(path.join(root, "paper/other.tex"), "Other passage.\n");
  await writeFile(path.join(root, "analysis.txt"), "Research support.\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { researchRoot: root, paperRoot: path.join(root, "paper") };
}

test("curated skills default safely and never load a client-supplied path", async () => {
  assert.equal(await resolveWorkbenchSkill(null), null);
  const polish = await resolveWorkbenchSkill({ id: "polish-selection", path: "/etc/passwd" }, selection);
  assert.equal(polish.scope, "selection");
  assert.equal(polish.length, "preserve");
  assert.equal(polish.readOnly, false);
  assert.match(polish.path, /skills\/workbench-polish\/SKILL.md$/);
  const check = await resolveWorkbenchSkill({ id: "check-paper" });
  assert.equal(check.readOnly, true);
  assert.equal(check.scope, "paper");
  for (const request of ["check-paper", { id: "../../private" }, { id: "polish-selection", scope: "paper" },
    { id: "check-paper", scope: "repository" }, { id: "polish-selection", audience: "invent" }]) {
    await assert.rejects(resolveWorkbenchSkill(request, selection), (error) => error.code === "invalid_skill");
  }
  await assert.rejects(resolveWorkbenchSkill({ id: "polish-selection" }, null), /Select LaTeX/);
  await assert.rejects(resolveWorkbenchSkill({ id: "check-paper", scope: "selection" }, { ...selection, text: "  " }), /Select LaTeX/);
});

test("native Codex input retains exact prompt and includes only the selected bundled skill", async () => {
  const skill = await resolveWorkbenchSkill({ id: "check-paper" });
  const normal = skillTurnInput("hello", null);
  assert.deepEqual(normal, [{ type: "text", text: "hello", text_elements: [] }]);
  assert.deepEqual(skillTurnInput("hello", skill), [...normal, { type: "skill", name: skill.name, path: skill.path }]);
});

test("selection freshness checks exact source positions and PDF-mapped line ranges", () => {
  const source = "Header\nThis result holds.\nTail";
  assert.equal(selectionMatchesSource(source, selection), true);
  assert.equal(selectionMatchesSource("Inserted\n" + source, selection), false);
  assert.equal(selectionMatchesSource(source, { ...selection, startColumn: 2 }), false);
  assert.equal(selectionMatchesSource(source, { ...selection, text: "Header\nThis", startLine: 1, endLine: 2, endColumn: 5 }), true);
  assert.equal(selectionMatchesSource(source, { ...selection, origin: "pdf", startColumn: 100, endColumn: 100 }), true);
  assert.equal(selectionMatchesSource(source, { ...selection, origin: "pdf", endLine: 3 }), false);
});

test("whole-paper checks omit stale attachments and resolve the actual main source", async (t) => {
  const roots = await fixture(t);
  const result = await prepareAgentRequest({ skill: { id: "check-paper" }, mainFile: "paper/main.tex",
    selection: { path: "/not/a/file", text: "stale attachment" } }, roots.researchRoot, roots.paperRoot);
  assert.equal(result.skill.readOnly, true);
  assert.match(result.prompt, /paper\/main.tex/);
  assert.doesNotMatch(result.prompt, /stale attachment/);
  assert.match(result.prompt, /paper-check-v1/);
  await assert.rejects(prepareAgentRequest({ skill: { id: "check-paper" }, mainFile: "analysis.txt" }, roots.researchRoot, roots.paperRoot), /inside the selected paper folder/);
});

test("selection skills reject stale or out-of-paper source before starting inference", async (t) => {
  const roots = await fixture(t);
  const body = { skill: { id: "polish-selection", audience: "adjacent", length: "shorter", english: "CA" }, mainFile: "paper/main.tex", selection };
  const result = await prepareAgentRequest(body, roots.researchRoot, roots.paperRoot);
  assert.equal(result.skill.targetPath, path.join(roots.paperRoot, "main.tex"));
  assert.match(result.prompt, /Audience: adjacent. Length: shorter. English spelling: CA/);
  assert.match(result.prompt, /Selected source: paper\/main.tex/);
  await assert.rejects(prepareAgentRequest({ ...body, selection: { ...selection, text: "stale" } }, roots.researchRoot, roots.paperRoot), /selected source has changed/);
  await assert.rejects(prepareAgentRequest({ ...body, selection: { ...selection, path: "analysis.txt", text: "Research support." } }, roots.researchRoot, roots.paperRoot), /inside the paper folder/);
});

test("normal chat has no skill instructions and still attaches source context", async (t) => {
  const roots = await fixture(t);
  const result = await prepareAgentRequest({ prompt: "Explain this.", selection }, roots.researchRoot, roots.paperRoot);
  assert.equal(result.skill, null);
  assert.match(result.prompt, /Explain this/);
  assert.match(result.prompt, /Selected source: paper\/main.tex/);
  assert.doesNotMatch(result.prompt, /bundled skill|paper-check-v1/);
  assert.match(result.prompt, /Do not require the author to select the Inspect local data action first/);
  const unselected = await prepareAgentRequest({ prompt: "Check the results." }, roots.researchRoot, roots.paperRoot);
  assert.match(unselected.prompt, /inspect the relevant existing data and generating code/);
});

test("five curated settings normalize safely without importing arbitrary fields", () => {
  assert.equal(WORKBENCH_SKILLS.length, 5);
  const defaults = normalizeSkillDefaults({
    "polish-selection": { audience: "general", length: "shorter", scope: "resources", model: "bad" },
    "english-consistency": { english: "preserve" },
    "inspect-data": { resourcePaths: "results.csv" },
    custom: { instructions: "ignored" },
  });
  assert.equal(defaults["polish-selection"].audience, "general");
  assert.equal(defaults["polish-selection"].scope, "selection");
  assert.equal(defaults["polish-selection"].model, undefined);
  assert.equal(defaults["english-consistency"].english, "US");
  assert.equal(defaults["inspect-data"].resourcePaths, "results.csv");
  assert.equal(defaults.custom, undefined);
});

test("data selection validates paths and reads real bounded evidence before inference", async t => {
  const roots = await fixture(t);
  await writeFile(path.join(roots.researchRoot, "metrics.json"), '{"snr":12}');
  const body = { mainFile: "paper/main.tex", skill: { id: "inspect-data", resourcePaths: "metrics.json" } };
  const result = await prepareAgentRequest(body, roots.researchRoot, roots.paperRoot);
  assert.equal(result.skill.scope, "resources");
  assert.equal(result.skill.dataEvidence[0].sample.snr, 12);
  assert.match(result.prompt, /entire-file/);
  assert.doesNotMatch(result.prompt, /Return a final JSON report conforming/);
  for (const resourcePaths of ["", "../outside.json", "/etc/passwd", "https://example.com", "a.json\nb.json\nc.json\nd.json\ne.json\nf.json"]) {
    await assert.rejects(resolveWorkbenchSkill({ ...body.skill, resourcePaths }), /paths|data paths/);
  }
  await assert.rejects(prepareAgentRequest({ ...body, skill: { ...body.skill, resourcePaths: "paper/main.tex" } }, roots.researchRoot, roots.paperRoot), /supports/);
});

test("English skill updates only existing paper prose and protects research code", async t => {
  const roots = await fixture(t);
  const skill = await resolveWorkbenchSkill({ id: "english-consistency", english: "UK" });
  const session = { ...roots, provider: "claude", workbenchSkill: skill };
  const changes = await proposalChangesForReview(session, { changes: [{ path: "paper/main.tex", action: "write", content: "Colour" }] });
  assert.equal(changes.length, 1);
  for (const file of ["analysis.txt", "paper/script.py", "paper/new.tex"]) {
    await assert.rejects(proposalChangesForReview(session, { changes: [{ path: file, action: "write", content: "Colour" }] }), /prose files|cannot delete, create/);
  }
  await assert.rejects(proposalChangesForReview(session, { changes: [{ path: "paper/main.tex", action: "delete", content: "" }] }), /cannot delete/);
});

test("reports permit only the selected Markdown output through ordinary review", async t => {
  const roots = await fixture(t);
  await writeFile(path.join(roots.researchRoot, "data.json"), "[1,2,3]");
  const body = { mainFile: "paper/main.tex", skill: { id: "generate-report", resourcePaths: "data.json", outputPath: "report.md" } };
  const { skill } = await prepareAgentRequest(body, roots.researchRoot, roots.paperRoot);
  const session = { ...roots, provider: "cursor", workbenchSkill: skill };
  const changes = await proposalChangesForReview(session, { changes: [{ path: "report.md", action: "write", content: "# Observed values\n1, 2, 3" }] });
  assert.equal(changes[0].kind.type, "add");
  for (const file of ["paper/main.tex", "other.md", "data.json"]) {
    await assert.rejects(proposalChangesForReview(session, { changes: [{ path: file, action: "write", content: "bad" }] }), /chosen Markdown/);
  }
  await assert.rejects(proposalChangesForReview(session, { changes: [{ path: "report.md", action: "delete", content: "" }] }), /cannot delete/);
  await assert.rejects(resolveWorkbenchSkill({ ...body.skill, outputPath: "../report.md" }), /output path/);
  assert.equal(await readFile(path.join(roots.researchRoot, "data.json"), "utf8"), "[1,2,3]");
});

test("data inspection is read-only for all providers, without paper-check schema", async t => {
  const roots = await fixture(t);
  const skill = await resolveWorkbenchSkill({ id: "inspect-data", resourcePaths: "data.json" });
  const threadId = "test-data-read-only";
  agentSessions.set(threadId, { ...roots, workbenchSkill: skill });
  t.after(() => agentSessions.delete(threadId));
  const responses = [];
  await handleCodexServerRequest({ id: 1, method: "item/fileChange/requestApproval", params: { threadId } }, { respond: (_id, result) => responses.push(result) });
  assert.deepEqual(responses, [{ decision: "decline" }]);
  for (const provider of ["claude", "cursor"]) {
    const options = { readOnly: true, reportKind: "text" };
    const invocation = providerInvocation(provider, { researchRoot: roots.researchRoot, paperRoot: roots.paperRoot, userPrompt: "Inspect", ...options });
    assert.match(invocation.prompt, /read-only data inspection/);
    const envelope = proposal => JSON.stringify(provider === "claude" ? { structured_output: proposal } : { result: JSON.stringify(proposal) });
    assert.equal(parseProviderResult(provider, envelope({ summary: "Sample only", changes: [] }), options).proposal.summary, "Sample only");
    assert.throws(() => parseProviderResult(provider, envelope({ summary: "bad", changes: [{ path: "report.md", action: "write", content: "bad" }] }), options), /read-only/);
  }
});

test("read-only Codex checks refuse patches and extra permissions without creating approval cards", async (t) => {
  const roots = await fixture(t);
  const threadId = "test-check-read-only";
  const initialApprovals = pendingApprovals.size;
  agentSessions.set(threadId, { ...roots, workbenchSkill: await resolveWorkbenchSkill({ id: "check-paper" }) });
  t.after(() => agentSessions.delete(threadId));
  const responses = [];
  const client = { respond: (id, result) => responses.push({ id, result }) };
  for (const method of ["item/fileChange/requestApproval", "item/commandExecution/requestApproval", "item/permissions/requestApproval"]) {
    await handleCodexServerRequest({ id: method, method, params: { threadId, turnId: "check-turn" } }, client);
  }
  assert.deepEqual(responses.map((response) => response.result), [
    { decision: "decline" }, { decision: "decline" }, { permissions: {}, scope: "turn" },
  ]);
  assert.equal(pendingApprovals.size, initialApprovals);
  assert.equal(await readFile(path.join(roots.paperRoot, "main.tex"), "utf8"), "\\section{Results}\nThis result holds.\n");
});

test("proposal adapters block audit writes before filesystem access, regardless of auto-approval", async () => {
  for (const provider of ["claude", "cursor"]) {
    await assert.rejects(proposalChangesForReview({ provider, workbenchSkill: { readOnly: true } }, {
      changes: [{ path: "/never-read-this-file", action: "write", content: "bad" }],
    }), /read-only/);
  }
});

test("polish skills cannot obtain command write access", async (t) => {
  const threadId = "test-polish-permissions";
  agentSessions.set(threadId, { workbenchSkill: { id: "polish-selection", readOnly: false } });
  t.after(() => agentSessions.delete(threadId));
  const responses = [];
  await handleCodexServerRequest({ id: 1, method: "item/permissions/requestApproval", params: { threadId } },
    { respond: (_id, result) => responses.push(result) });
  assert.deepEqual(responses, [{ permissions: {}, scope: "turn" }]);
});

test("polishing can propose its source file but cannot modify related files", async (t) => {
  const roots = await fixture(t);
  const session = { ...roots, provider: "claude", workbenchSkill: {
    id: "polish-selection", targetPath: path.join(roots.paperRoot, "main.tex"), readOnly: false,
  } };
  const changes = await proposalChangesForReview(session, {
    changes: [{ path: "paper/main.tex", action: "write", content: "\\section{Results}\nThe result holds.\n" }],
  });
  assert.equal(changes.length, 1);
  await assert.rejects(proposalChangesForReview(session, {
    changes: [{ path: "paper/main.tex", action: "delete", content: "" }],
  }), /cannot delete/);
  await assert.rejects(proposalChangesForReview(session, {
    changes: [{ path: "paper/other.tex", action: "write", content: "Unrelated edit" }],
  }), /selected source file/);
  assert.match(await readFile(path.join(roots.paperRoot, "main.tex"), "utf8"), /This result/);
});

test("Claude and Cursor receive a report-only contract without broader tools", () => {
  for (const provider of ["claude", "cursor"]) {
    const invocation = providerInvocation(provider, { researchRoot: "/tmp/paper", paperRoot: "/tmp/paper", userPrompt: "Audit", readOnly: true });
    assert.match(invocation.prompt, /read-only paper check/);
    if (provider === "claude") {
      assert.deepEqual(JSON.parse(invocation.args[invocation.args.indexOf("--json-schema") + 1]), PAPER_CHECK_SCHEMA);
      assert.ok(invocation.args.includes("Read,Glob,Grep"));
    } else assert.ok(invocation.args.includes("--mode=ask"));
    const envelope = provider === "claude" ? { structured_output: report } : { result: JSON.stringify(report) };
    const parsed = parseProviderResult(provider, JSON.stringify(envelope), { readOnly: true });
    assert.deepEqual(parsed.proposal.changes, []);
    assert.deepEqual(parsePaperCheck(parsed.proposal.summary), report);
    const bad = { ...report, changes: [{ path: "main.tex", action: "delete", content: "" }] };
    assert.throws(() => parseProviderResult(provider, JSON.stringify(provider === "claude"
      ? { structured_output: bad } : { result: JSON.stringify(bad) }), { readOnly: true }), /none were applied/);
  }
});

test("findings validate types and reject unsafe navigation targets", () => {
  assert.deepEqual(validatePaperCheck(report), report);
  assert.deepEqual(parsePaperCheck(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``), report);
  for (const badPath of ["/etc/passwd", "../outside.tex", "paper/../../outside.tex", "C:/private", "paper\\main.tex", "paper/\0main.tex", "https://example.com"]) {
    assert.equal(parsePaperCheck(JSON.stringify({ ...report, findings: [{ ...report.findings[0], path: badPath }] })), null);
  }
  for (const patch of [{ line: 0 }, { line: "2" }, { path: null, line: 2 }, { severity: "certain" }, { needsAuthorInput: "yes" }]) {
    assert.throws(() => validatePaperCheck({ ...report, findings: [{ ...report.findings[0], ...patch }] }), /invalid/);
  }
  assert.equal(parsePaperCheck('{"kind":"paper-check-v1"'), null);
  assert.equal(parsePaperCheck("ordinary progress message"), null);
  assert.deepEqual(validatePaperCheck({ ...report, findings: [] }).findings, []);
});
