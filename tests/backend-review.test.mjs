import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createTwoFilesPatch } from "diff";

import {
  activeTurns,
  agentSessions,
  agentTurnStatus,
  changeStatus,
  claudeModelSettingsFromCatalog,
  codexModelSettingsFromCatalog,
  createUndoSnapshot,
  decideApproval,
  finalizeUndoSnapshot,
  materializeReviewFiles,
  pendingApprovals,
  permissionsForResearchRequest,
  preparePermissionGrant,
  proposalChangesForReview,
  readTextFile,
  resolveClaudeModel,
  resolveCodexModel,
  saveTextFile,
  stopAgentTurn,
  undoChanges,
} from "../server/index.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("exposes every visible subscription model and rejects unavailable selections", () => {
  const models = [
    {
      id: "catalog-default",
      model: "catalog-default",
      displayName: "Catalog Default",
      description: "Reliable agentic workhorse.",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "high", description: "Deep" },
      ],
      isDefault: true,
      hidden: false,
    },
    {
      id: "catalog-specialist",
      model: "catalog-specialist",
      displayName: "Catalog Specialist",
      description: "Most capable.",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "ultra", description: "Maximum" }],
      isDefault: false,
      hidden: false,
    },
    {
      id: "retired-model",
      model: "retired-model",
      displayName: "Retired",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [],
      isDefault: false,
      hidden: true,
    },
  ];

  const settings = codexModelSettingsFromCatalog(models, "catalog-default", "high");
  assert.equal(settings.model, "catalog-default");
  assert.equal(settings.defaultReasoningEffort, "high");
  assert.deepEqual(settings.models.map((model) => model.model), ["catalog-default", "catalog-specialist"]);
  assert.equal(resolveCodexModel(models, "catalog-specialist"), "catalog-specialist");
  assert.throws(
    () => resolveCodexModel(models, "retired-model"),
    (error) => error.status === 400 && error.code === "model_unavailable",
  );
  assert.throws(
    () => resolveCodexModel(models, "not-on-this-subscription"),
    (error) => error.status === 400 && error.code === "model_unavailable",
  );
});

test("maps Claude Code's live picker models and effort levels without a built-in catalog", () => {
  const models = [
    {
      value: "provider-default",
      displayName: "Subscription default",
      description: "Chosen by the signed-in account.",
      supportedEffortLevels: ["low", "high", "max"],
    },
    {
      value: "provider-specialist",
      displayName: "Specialist",
      description: "A second account model.",
      supportedEffortLevels: ["medium", "high"],
    },
  ];

  const settings = claudeModelSettingsFromCatalog(models);
  assert.equal(settings.model, "provider-default");
  assert.deepEqual(settings.models.map((model) => model.model), ["provider-default", "provider-specialist"]);
  assert.deepEqual(
    settings.models[0].supportedReasoningEfforts.map((option) => option.reasoningEffort),
    ["low", "high", "max"],
  );
  assert.equal(resolveClaudeModel(models, "provider-specialist"), "provider-specialist");
  assert.throws(
    () => resolveClaudeModel(models, "not-advertised"),
    (error) => error.status === 400 && error.code === "model_unavailable",
  );
});

async function fixture(t) {
  const createdRoot = await mkdtemp(path.join(tmpdir(), "lattice-review-"));
  const researchRoot = await realpath(createdRoot);
  const paperRoot = path.join(researchRoot, "paper");
  await mkdir(paperRoot);
  t.after(() => rm(researchRoot, { recursive: true, force: true }));
  return {
    researchRoot,
    paperRoot,
    session: { researchRoot, paperRoot },
  };
}

function pendingFor(session, materialized) {
  return {
    session,
    params: { threadId: "thread", turnId: "turn", itemId: `item-${Date.now()}-${Math.random()}` },
    paths: materialized.reviewGuards.map(({ absolutePath, exists }) => ({ path: absolutePath, exists })),
    reviewGuards: materialized.reviewGuards,
    expectedAfter: materialized.expectedAfter,
  };
}

test("versions manual file reads and returns the new version after an atomic save", async (t) => {
  const { researchRoot, paperRoot } = await fixture(t);
  const target = path.join(paperRoot, "main.tex");
  await writeFile(target, "before\n");

  const loaded = await readTextFile(researchRoot, "paper/main.tex");
  assert.equal(loaded.hash, hash(Buffer.from("before\n")));

  const saved = await saveTextFile({
    researchRoot,
    paperRoot,
    path: "paper/main.tex",
    content: "after\n",
    expectedHash: loaded.hash,
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.path, "paper/main.tex");
  assert.equal(saved.hash, hash(Buffer.from("after\n")));
  assert.equal(Number.isFinite(saved.mtimeMs), true);
  assert.equal(await readFile(target, "utf8"), "after\n");
  assert.equal((await readTextFile(researchRoot, "paper/main.tex")).hash, saved.hash);
  assert.deepEqual(
    (await readdir(paperRoot)).filter((name) => name.includes(".codex-save-")),
    [],
  );
});

test("rejects stale manual saves without overwriting disk or escaping paperRoot", async (t) => {
  const { researchRoot, paperRoot } = await fixture(t);
  const target = path.join(paperRoot, "main.tex");
  await writeFile(target, "loaded\n");
  const loaded = await readTextFile(researchRoot, "paper/main.tex");
  await writeFile(target, "outside edit\n");

  await assert.rejects(
    saveTextFile({
      researchRoot,
      paperRoot,
      path: "paper/main.tex",
      content: "stale editor\n",
      expectedHash: loaded.hash,
    }),
    (error) => error.status === 409
      && error.code === "file_conflict"
      && /changed on disk/i.test(error.message),
  );
  assert.equal(await readFile(target, "utf8"), "outside edit\n");
  assert.deepEqual(
    (await readdir(paperRoot)).filter((name) => name.includes(".codex-save-")),
    [],
  );

  await assert.rejects(
    saveTextFile({
      researchRoot,
      paperRoot,
      path: path.join(researchRoot, "outside.tex"),
      content: "outside\n",
      expectedHash: null,
    }),
    (error) => error.status === 403 && /outside paperRoot/i.test(error.message),
  );
});

test("uses a null expected hash to protect creation of a previously missing file", async (t) => {
  const { researchRoot, paperRoot } = await fixture(t);
  const target = path.join(paperRoot, "new.tex");

  const created = await saveTextFile({
    researchRoot,
    paperRoot,
    path: "paper/new.tex",
    content: "created\n",
    expectedHash: null,
  });
  assert.equal(created.hash, hash(Buffer.from("created\n")));

  await assert.rejects(
    saveTextFile({
      researchRoot,
      paperRoot,
      path: "paper/new.tex",
      content: "overwrite\n",
      expectedHash: null,
    }),
    (error) => error.status === 409 && error.code === "file_conflict",
  );
  assert.equal(await readFile(target, "utf8"), "created\n");
});

test("materializes exact UTF-8 bytes and preserves a BOM in approval hashes", async (t) => {
  const { paperRoot, session } = await fixture(t);
  const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\n")]);
  await writeFile(path.join(paperRoot, "main.tex"), source);
  const before = "\ufeffold\n";
  const after = "\ufeffnew\n";

  const review = await materializeReviewFiles(session, [{
    path: "paper/main.tex",
    kind: { type: "update" },
    diff: createTwoFilesPatch("paper/main.tex", "paper/main.tex", before, after),
  }]);

  assert.equal(review.files[0].before, before);
  assert.equal(review.files[0].after, after);
  assert.equal(review.reviewGuards[0].hash, hash(source));
  assert.equal(review.expectedAfter[0].hash, hash(Buffer.from(after)));

  const snapshot = await createUndoSnapshot(pendingFor(session, review));
  assert.deepEqual(snapshot.files[0].bytes, source);

  await writeFile(path.join(paperRoot, "main.tex"), Buffer.from(after));
  const settlement = await finalizeUndoSnapshot(snapshot, "completed");
  assert.equal(snapshot.applyStatus, "completed");
  assert.deepEqual(settlement, {
    snapshotId: snapshot.id,
    itemId: snapshot.itemId,
    status: "completed",
    applied: true,
    undoAvailable: true,
  });
  assert.deepEqual(await changeStatus({ ...session, snapshotId: snapshot.id }), {
    ok: true,
    ...settlement,
  });
  await undoChanges({ ...session, snapshotId: snapshot.id });
  assert.deepEqual(await readFile(path.join(paperRoot, "main.tex")), source);
  assert.equal((await changeStatus({ ...session, snapshotId: snapshot.id })).undoAvailable, false);
});

test("distinguishes a missing add target from an existing empty file", async (t) => {
  const { paperRoot, session } = await fixture(t);
  const target = path.join(paperRoot, "new.tex");
  const review = await materializeReviewFiles(session, [{
    path: "paper/new.tex",
    kind: { type: "add" },
    diff: createTwoFilesPatch("paper/new.tex", "paper/new.tex", "", ""),
  }]);

  assert.equal(review.reviewGuards[0].exists, false);
  assert.equal(review.reviewGuards[0].hash, null);
  assert.equal(review.expectedAfter[0].exists, true);
  await createUndoSnapshot(pendingFor(session, review));

  await writeFile(target, "");
  await assert.rejects(
    createUndoSnapshot(pendingFor(session, review)),
    (error) => error.status === 409 && /changed while the proposal was open/i.test(error.message),
  );
});

test("freshness-checks a move destination as well as its source", async (t) => {
  const { paperRoot, session } = await fixture(t);
  const sourcePath = path.join(paperRoot, "old.tex");
  const destinationPath = path.join(paperRoot, "new.tex");
  await writeFile(sourcePath, "old\n");
  const review = await materializeReviewFiles(session, [{
    path: "paper/old.tex",
    kind: { type: "update", move_path: "paper/new.tex" },
    diff: createTwoFilesPatch("paper/old.tex", "paper/new.tex", "old\n", "new\n"),
  }]);

  assert.equal(review.reviewGuards.length, 2);
  assert.deepEqual(
    review.expectedAfter.map(({ path: target, exists }) => [target, exists]),
    [["paper/old.tex", false], ["paper/new.tex", true]],
  );

  await writeFile(destinationPath, "raced\n");
  await assert.rejects(
    createUndoSnapshot(pendingFor(session, review)),
    (error) => error.status === 409 && /changed while the proposal was open/i.test(error.message),
  );
});

test("reviews, finalizes, and undoes updates and additions outside paperRoot but inside researchRoot", async (t) => {
  const { researchRoot, paperRoot, session } = await fixture(t);
  const analysisRoot = path.join(researchRoot, "analysis");
  const generatedRoot = path.join(researchRoot, "generated");
  const scriptPath = path.join(analysisRoot, "rerun.py");
  const metadataPath = path.join(generatedRoot, "figure.json");
  await mkdir(analysisRoot);
  await mkdir(generatedRoot);
  await writeFile(scriptPath, "print('old')\n");

  const review = await materializeReviewFiles(session, [
    {
      path: "analysis/rerun.py",
      kind: { type: "update" },
      diff: createTwoFilesPatch(
        "analysis/rerun.py",
        "analysis/rerun.py",
        "print('old')\n",
        "print('new')\n",
      ),
    },
    {
      path: "generated/figure.json",
      kind: { type: "add" },
      diff: createTwoFilesPatch(
        "generated/figure.json",
        "generated/figure.json",
        "",
        "{\"generated\":true}\n",
      ),
    },
  ]);

  assert.deepEqual(
    review.files.map(({ path: filePath }) => filePath),
    ["analysis/rerun.py", "generated/figure.json"],
  );
  const snapshot = await createUndoSnapshot(pendingFor(session, review));

  // Simulate the app-server applying exactly the bytes the user reviewed.
  await writeFile(scriptPath, "print('new')\n");
  await writeFile(metadataPath, "{\"generated\":true}\n");
  const settlement = await finalizeUndoSnapshot(snapshot, "completed");
  assert.equal(settlement.status, "completed");
  assert.equal(settlement.undoAvailable, true);

  const undone = await undoChanges({ researchRoot, paperRoot, snapshotId: snapshot.id });
  assert.deepEqual(undone.files, ["analysis/rerun.py", "generated/figure.json"]);
  assert.equal(await readFile(scriptPath, "utf8"), "print('old')\n");
  await assert.rejects(readFile(metadataPath), (error) => error.code === "ENOENT");
});

test("applies alternate-provider proposals only after approval and preserves Undo", async (t) => {
  const { researchRoot, paperRoot } = await fixture(t);
  const session = {
    researchRoot,
    paperRoot,
    provider: "claude",
    threadId: "claude:test-thread",
  };
  const sourcePath = path.join(paperRoot, "main.tex");
  const addedPath = path.join(researchRoot, "analysis.md");
  await writeFile(sourcePath, "before\n");

  const changes = await proposalChangesForReview(session, {
    summary: "Prepared two changes.",
    changes: [
      { path: "paper/main.tex", action: "write", content: "after\n" },
      { path: "analysis.md", action: "write", content: "notes\n" },
    ],
  });
  const materialized = await materializeReviewFiles(session, changes);
  const requestId = `external-${Date.now()}-${Math.random()}`;
  pendingApprovals.set(requestId, {
    requestId,
    source: "external",
    approvalType: "file",
    params: { threadId: session.threadId, turnId: "turn", itemId: "item" },
    session,
    paths: materialized.reviewGuards.map(({ absolutePath, exists }) => ({ path: absolutePath, exists })),
    changes,
    reviewFiles: materialized.files,
    reviewGuards: materialized.reviewGuards,
    expectedAfter: materialized.expectedAfter,
    diff: materialized.files.map((file) => file.reviewDiff).join("\n"),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    resolving: false,
    timeout: null,
  });
  t.after(() => pendingApprovals.delete(requestId));

  assert.equal(await readFile(sourcePath, "utf8"), "before\n");
  await assert.rejects(readFile(addedPath), (error) => error.code === "ENOENT");

  const accepted = await decideApproval({
    researchRoot,
    paperRoot,
    requestId,
    decision: "accept",
  });
  assert.equal(accepted.ok, true);
  assert.ok(accepted.snapshotId);
  assert.equal(await readFile(sourcePath, "utf8"), "after\n");
  assert.equal(await readFile(addedPath, "utf8"), "notes\n");

  await undoChanges({ researchRoot, paperRoot, snapshotId: accepted.snapshotId });
  assert.equal(await readFile(sourcePath, "utf8"), "before\n");
  await assert.rejects(readFile(addedPath), (error) => error.code === "ENOENT");
});

test("rejects alternate-provider paths outside the research root", async (t) => {
  const { researchRoot, paperRoot } = await fixture(t);
  const session = { researchRoot, paperRoot, provider: "cursor" };
  await assert.rejects(
    proposalChangesForReview(session, {
      summary: "Unsafe proposal.",
      changes: [{ path: "../escape.tex", action: "write", content: "escape\n" }],
    }),
    (error) => error.status === 403 && /outside the research workspace/i.test(error.message),
  );
  await assert.rejects(
    proposalChangesForReview(session, {
      summary: "Unsafe proposal.",
      changes: [{ path: path.join(researchRoot, "paper/main.tex"), action: "write", content: "escape\n" }],
    }),
    (error) => error.status === 403 && /absolute file path/i.test(error.message),
  );
});

test("rejects agent write sources, move destinations, and symlink escapes outside researchRoot", async (t) => {
  const { researchRoot, paperRoot, session } = await fixture(t);
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "lattice-outside-"));
  const outsidePath = path.join(outsideRoot, "outside.py");
  const mainPath = path.join(paperRoot, "main.tex");
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  await writeFile(outsidePath, "outside\n");
  await writeFile(mainPath, "old\n");

  await assert.rejects(
    materializeReviewFiles(session, [{
      path: outsidePath,
      kind: { type: "update" },
      diff: createTwoFilesPatch(outsidePath, outsidePath, "outside\n", "changed\n"),
    }]),
    (error) => error.status === 403 && /outside the selected root/i.test(error.message),
  );

  await assert.rejects(
    materializeReviewFiles(session, [{
      path: "paper/main.tex",
      kind: { type: "update", move_path: path.join(outsideRoot, "moved.tex") },
      diff: createTwoFilesPatch("paper/main.tex", "moved.tex", "old\n", "new\n"),
    }]),
    (error) => error.status === 403 && /outside the selected root/i.test(error.message),
  );

  await symlink(outsidePath, path.join(researchRoot, "escape.py"));
  await assert.rejects(
    materializeReviewFiles(session, [{
      path: "escape.py",
      kind: { type: "update" },
      diff: createTwoFilesPatch("escape.py", "escape.py", "outside\n", "changed\n"),
    }]),
    (error) => error.status === 403 && /outside the selected root/i.test(error.message),
  );
});

test("grants output folders and prepares a missing folder before command execution", async (t) => {
  const { researchRoot, paperRoot, session } = await fixture(t);
  const analysisRoot = path.join(researchRoot, "analysis");
  const generatedRoot = path.join(researchRoot, "generated");
  const paperFiguresRoot = path.join(paperRoot, "figures");
  const outputPath = path.join(analysisRoot, "output");
  await mkdir(analysisRoot);
  await mkdir(generatedRoot);
  await mkdir(paperFiguresRoot);

  const grant = await permissionsForResearchRequest(session, {
    cwd: researchRoot,
    permissions: {
      fileSystem: {
        entries: [
          { access: "write", path: { type: "path", path: outputPath } },
          { access: "write", path: { type: "path", path: generatedRoot } },
          { access: "write", path: { type: "path", path: paperFiguresRoot } },
        ],
      },
    },
  });

  assert.deepEqual(grant, {
    permissions: {
      fileSystem: {
        entries: [
          { access: "write", path: { type: "path", path: outputPath } },
          { access: "write", path: { type: "path", path: generatedRoot } },
          { access: "write", path: { type: "path", path: paperFiguresRoot } },
        ],
      },
    },
    writePaths: ["analysis/output", "generated", "paper/figures"],
    writeTargets: [
      { path: "analysis/output", kind: "directory" },
      { path: "generated", kind: "directory" },
      { path: "paper/figures", kind: "directory" },
    ],
    permissionTargets: [
      { path: outputPath, kind: "directory", create: true },
      { path: generatedRoot, kind: "directory", create: false },
      { path: paperFiguresRoot, kind: "directory", create: false },
    ],
  });

  await preparePermissionGrant({ session, permissionTargets: grant.permissionTargets });
  assert.equal((await stat(outputPath)).isDirectory(), true);
});

test("rejects broad, paper-overlapping, external, network, and non-path permission requests", async (t) => {
  const { researchRoot, paperRoot, session } = await fixture(t);
  const analysisRoot = path.join(researchRoot, "analysis");
  const paperFigures = path.join(paperRoot, "figures");
  const manuscript = path.join(paperRoot, "main.tex");
  const hardLinkedAlias = path.join(analysisRoot, "alias.png");
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "lattice-permissions-outside-"));
  await mkdir(analysisRoot);
  await mkdir(paperFigures);
  await writeFile(manuscript, "manuscript\n");
  await link(manuscript, hardLinkedAlias);
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));

  const request = (entries, network) => ({
    cwd: researchRoot,
    permissions: {
      fileSystem: { entries },
      ...(network ? { network } : {}),
    },
  });
  const pathEntry = (target) => ({
    access: "write",
    path: { type: "path", path: target },
  });
  const rejectsPermission = (params) => assert.rejects(
    permissionsForResearchRequest(session, params),
    (error) => error.status === 403,
  );

  await rejectsPermission(request([pathEntry(path.join(paperFigures, "new.png"))]));
  await rejectsPermission(request([pathEntry(path.join(paperFigures, "notes.tex"))]));
  await rejectsPermission(request([pathEntry(researchRoot)]));
  await rejectsPermission(request([pathEntry(path.dirname(researchRoot))]));
  await rejectsPermission(request([pathEntry(outsideRoot)]));
  await rejectsPermission(request([pathEntry(analysisRoot)]));
  await rejectsPermission(request([pathEntry("analysis")]));
  await rejectsPermission(request([pathEntry(analysisRoot)], { enabled: true }));
  await rejectsPermission(request([{
    access: "write",
    path: { type: "glob_pattern", pattern: `${analysisRoot}/**` },
  }]));
  await rejectsPermission(request([{
    access: "write",
    path: { type: "special", value: { kind: "project_roots" } },
  }]));
});

test("fails closed for an unapplicable patch and linked write targets", async (t) => {
  const { paperRoot, session } = await fixture(t);
  await writeFile(path.join(paperRoot, "main.tex"), "current\n");

  await assert.rejects(
    materializeReviewFiles(session, [{
      path: "paper/main.tex",
      kind: { type: "update" },
      diff: "@@ -1 +1 @@\n-not-current\n+changed\n",
    }]),
    (error) => error.status === 422 && /could not be applied exactly/i.test(error.message),
  );

  await symlink(path.join(paperRoot, "main.tex"), path.join(paperRoot, "alias.tex"));
  await assert.rejects(
    materializeReviewFiles(session, [{
      path: "paper/alias.tex",
      kind: { type: "update" },
      diff: createTwoFilesPatch("paper/alias.tex", "paper/alias.tex", "current\n", "changed\n"),
    }]),
    (error) => error.status === 403 && /symbolic links/i.test(error.message),
  );
});

test("marks post-apply bytes that differ from the approved output", async (t) => {
  const { paperRoot, session } = await fixture(t);
  const target = path.join(paperRoot, "main.tex");
  await writeFile(target, "before\n");
  const review = await materializeReviewFiles(session, [{
    path: "paper/main.tex",
    kind: { type: "update" },
    diff: createTwoFilesPatch("paper/main.tex", "paper/main.tex", "before\n", "approved\n"),
  }]);
  const snapshot = await createUndoSnapshot(pendingFor(session, review));

  await writeFile(target, "different\n");
  const settlement = await finalizeUndoSnapshot(snapshot, "completed");

  assert.equal(snapshot.applied, true);
  assert.equal(snapshot.applyStatus, "completedMismatch");
  assert.equal(snapshot.files[0].afterHash, hash(Buffer.from("different\n")));
  assert.match(snapshot.applyError, /did not match the approved proposal/i);
  assert.equal(settlement.status, "completedMismatch");
  assert.equal(settlement.undoAvailable, true);
  assert.match(settlement.message, /did not match the approved proposal/i);
});

test("does not disclose snapshot status to a different paper root", async (t) => {
  const { researchRoot, paperRoot, session } = await fixture(t);
  await writeFile(path.join(paperRoot, "main.tex"), "before\n");
  const review = await materializeReviewFiles(session, [{
    path: "paper/main.tex",
    kind: { type: "update" },
    diff: createTwoFilesPatch("paper/main.tex", "paper/main.tex", "before\n", "after\n"),
  }]);
  const snapshot = await createUndoSnapshot(pendingFor(session, review));
  const otherPaperRoot = path.join(researchRoot, "other-paper");
  await mkdir(otherPaperRoot);

  await assert.rejects(
    changeStatus({ researchRoot, paperRoot: otherPaperRoot, snapshotId: snapshot.id }),
    (error) => error.status === 404 && /not found for this paper/i.test(error.message),
  );
});

test("recovers active turns and pending reviews only for their exact paper", async (t) => {
  const { researchRoot, paperRoot, session } = await fixture(t);
  const threadId = `thread-${Date.now()}-${Math.random()}`;
  const turnId = `turn-${Date.now()}-${Math.random()}`;
  const requestId = `request-${Date.now()}-${Math.random()}`;
  const startedAt = Date.now() - 5_000;
  activeTurns.set(threadId, {
    ...session,
    threadId,
    turnId,
    status: "inProgress",
    label: "Waiting for your review",
    startedAt,
    lastActivityAt: startedAt + 1_000,
  });
  pendingApprovals.set(requestId, {
    requestId,
    rpcId: 1,
    params: { threadId, turnId, itemId: "item", reason: "Review this edit" },
    session: { ...session, threadId },
    diff: "@@ -1 +1 @@\n-old\n+new\n",
    reviewFiles: [{
      path: "paper/main.tex",
      kind: "update",
      movePath: null,
      before: "old\n",
      after: "new\n",
      reviewDiff: "@@ -1 +1 @@\n-old\n+new\n",
    }],
    createdAt: startedAt + 1_000,
    expiresAt: Date.now() + 60_000,
  });
  t.after(() => {
    activeTurns.delete(threadId);
    pendingApprovals.delete(requestId);
  });

  const recovered = await agentTurnStatus({ researchRoot, paperRoot, threadId });
  assert.equal(recovered.active, true);
  assert.equal(recovered.turn.turnId, turnId);
  assert.equal(recovered.turn.label, "Waiting for your review");
  assert.equal(recovered.approval.requestId, requestId);
  assert.equal(recovered.approval.files[0].after, "new\n");

  const otherPaperRoot = path.join(researchRoot, "other-paper");
  await mkdir(otherPaperRoot);
  const hidden = await agentTurnStatus({ researchRoot, paperRoot: otherPaperRoot, threadId });
  assert.deepEqual(hidden, { ok: true, active: false, turn: null, approval: null });
  const wrongThread = await agentTurnStatus({
    researchRoot,
    paperRoot,
    threadId: `${threadId}-other`,
  });
  assert.deepEqual(wrongThread, { ok: true, active: false, turn: null, approval: null });
});

test("makes Stop idempotent and refuses to race an approval decision", async (t) => {
  const { researchRoot, paperRoot, session } = await fixture(t);
  const threadId = `thread-stop-${Date.now()}-${Math.random()}`;
  const turnId = `turn-stop-${Date.now()}-${Math.random()}`;
  const requestId = `request-stop-${Date.now()}-${Math.random()}`;
  agentSessions.set(threadId, { ...session, threadId });
  activeTurns.set(threadId, {
    ...session,
    threadId,
    turnId,
    status: "interrupting",
    label: "Stopping Codex…",
    startedAt: Date.now() - 1_000,
    lastActivityAt: Date.now(),
  });
  t.after(() => {
    agentSessions.delete(threadId);
    activeTurns.delete(threadId);
    pendingApprovals.delete(requestId);
  });

  const repeated = await stopAgentTurn({ researchRoot, paperRoot, threadId, turnId });
  assert.equal(repeated.stopped, true);
  assert.equal(repeated.status, "interrupting");

  activeTurns.get(threadId).status = "inProgress";
  pendingApprovals.set(requestId, {
    requestId,
    rpcId: 1,
    params: { threadId, turnId, itemId: "item" },
    session: { ...session, threadId },
    resolving: true,
    reviewFiles: [],
    diff: "",
  });
  await assert.rejects(
    stopAgentTurn({ researchRoot, paperRoot, threadId, turnId }),
    (error) => error.status === 409 && /decision is already being finalized/i.test(error.message),
  );

  pendingApprovals.delete(requestId);
  activeTurns.delete(threadId);
  const idle = await stopAgentTurn({ researchRoot, paperRoot, threadId, turnId });
  assert.equal(idle.stopped, false);
  assert.equal(idle.status, "idle");
});

test("rejects an approval response from a stale app-server generation", async (t) => {
  const { researchRoot, paperRoot, session } = await fixture(t);
  const requestId = `request-stale-${Date.now()}-${Math.random()}`;
  pendingApprovals.set(requestId, {
    requestId,
    rpcId: 99,
    params: { threadId: "stale-thread", turnId: "stale-turn", itemId: "item" },
    session: { ...session, generation: -1 },
    resolving: false,
    timeout: null,
    expiresAt: Date.now() + 60_000,
  });
  t.after(() => pendingApprovals.delete(requestId));

  await assert.rejects(
    decideApproval({ researchRoot, paperRoot, requestId, decision: "decline" }),
    (error) => error.status === 409 && /no longer attached to an active agent turn/i.test(error.message),
  );
  assert.equal(pendingApprovals.has(requestId), false);
});
