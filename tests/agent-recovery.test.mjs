import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeAgentMessages } from "../app/lib/agent-messages.mjs";
import {
  activeTurns, agentSessions, agentMessages, agentSinks, agentTurnStatus,
  handleCodexNotification, openAgentSession, reserveAgentThread,
} from "../server/index.mjs";

function mockClient(handler) {
  const calls = [];
  return {
    calls, generation: 712,
    ensureReady: async () => {},
    request: async (method, params) => { calls.push({ method, params }); return handler(method, params); },
  };
}

test("changing a loaded conversation's model updates it without acquiring another writer", async t => {
  const threadId = randomUUID();
  const roots = { researchRoot: "/research", paperRoot: "/research/paper" };
  const client = mockClient(method => {
    if (method === "thread/settings/update") return {};
    if (method === "thread/read") return { thread: { model: "chosen-model", reasoningEffort: "high" } };
    assert.fail(`Unexpected ${method}`);
  });
  agentSessions.set(threadId, { ...roots, threadId, model: "old-model", generation: client.generation });
  t.after(() => agentSessions.delete(threadId));
  const session = await openAgentSession(roots.researchRoot, roots.paperRoot, threadId, "chosen-model", client);
  assert.equal(session.model, "chosen-model");
  assert.deepEqual(client.calls.map(c => c.method), ["thread/settings/update", "thread/read"]);
  assert.equal(client.calls[0].params.model, "chosen-model");
});

test("a locked idle conversation continues from its saved history and retains the chosen model and review policy", async t => {
  const original = randomUUID();
  const recovered = randomUUID();
  const client = mockClient(method => {
    if (method === "thread/resume") throw new Error(`thread ${original} already has an active writer`);
    if (method === "thread/read") return { thread: { cwd: "/research/paper", status: { type: "notLoaded" } } };
    if (method === "thread/turns/list") return { data: [{ id: "last", status: "interrupted" }] };
    if (method === "thread/fork") return { thread: { id: recovered }, model: "chosen-model" };
    assert.fail(`Unexpected ${method}`);
  });
  t.after(() => agentSessions.delete(recovered));
  const session = await openAgentSession("/research", "/research/paper", original, "chosen-model", client);
  assert.equal(session.threadId, recovered);
  assert.equal(session.recoveredFromThreadId, original);
  const fork = client.calls.find(c => c.method === "thread/fork").params;
  assert.equal(fork.threadId, original);
  assert.equal(fork.model, "chosen-model");
  assert.equal(fork.sandbox, "read-only");
  assert.equal(fork.approvalsReviewer, "user");
  assert.equal(fork.deferGoalContinuation, true);
  assert.match(fork.developerInstructions, /approval/);
  const count = client.calls.length;
  const secondBrowser = await openAgentSession("/research", "/research/paper", original, "chosen-model", client);
  assert.equal(secondBrowser.threadId, recovered);
  assert.equal(client.calls.length, count, "a second browser must reuse the recovered session");
});

test("recovery does not fork a conversation that is still working elsewhere", async () => {
  const threadId = randomUUID();
  const client = mockClient(method => {
    if (method === "thread/resume") throw new Error(`thread ${threadId} already has an active writer`);
    if (method === "thread/read") return { thread: { cwd: "/research", status: { type: "notLoaded" } } };
    if (method === "thread/turns/list") return { data: [{ status: "inProgress" }] };
    assert.fail(`Unexpected ${method}`);
  });
  await assert.rejects(openAgentSession("/research", "/research/paper", threadId, "chosen-model", client),
    error => error.code === "thread_busy");
  assert.ok(!client.calls.some(c => c.method === "thread/fork"));
});

test("unrelated resume failures are not hidden by creating a new conversation", async () => {
  const client = mockClient(() => { throw new Error("sign-in required"); });
  await assert.rejects(openAgentSession("/research", "/research/paper", randomUUID(), "chosen-model", client), /sign-in required/);
  assert.equal(client.calls.length, 1);
});

test("two browser sends cannot both acquire a conversation while it is starting", () => {
  const threadId = randomUUID();
  const release = reserveAgentThread(threadId);
  try {
    assert.throws(() => reserveAgentThread(threadId), error => error.code === "thread_busy");
  } finally { release(); }
  reserveAgentThread(threadId)();
});

test("public messages stream immediately and remain recoverable after completion, scoped to their paper", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "workbench-messages-")));
  const paperRoot = path.join(root, "paper");
  const otherRoot = path.join(root, "other");
  await mkdir(paperRoot); await mkdir(otherRoot);
  const threadId = randomUUID(); const turnId = randomUUID();
  agentSessions.set(threadId, { threadId, researchRoot: root, paperRoot });
  const delivered = [];
  const sink = { threadId, turnId, res: { write: line => delivered.push(JSON.parse(line)) } };
  agentSinks.add(sink);
  t.after(async () => {
    agentSessions.delete(threadId); agentMessages.delete(threadId); agentSinks.delete(sink);
    activeTurns.delete(threadId); await rm(root, { recursive: true, force: true });
  });
  handleCodexNotification("item/agentMessage/delta", { threadId, turnId, itemId: "progress", delta: "Checking " });
  assert.equal(delivered.at(-1).text, "Checking ", "first words must be delivered before turn completion");
  handleCodexNotification("item/agentMessage/delta", { threadId, turnId, itemId: "progress", delta: "the equations." });
  handleCodexNotification("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "progress", text: "Checking the equations.", phase: "commentary" } });
  handleCodexNotification("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "result", text: "Finished.", phase: "final_answer" } });
  const beforeComplete = await agentTurnStatus({ researchRoot: root, paperRoot, threadId });
  assert.deepEqual(beforeComplete.messages.map(m => m.text), ["Checking the equations.", "Finished."]);
  handleCodexNotification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  const recovered = await agentTurnStatus({ researchRoot: root, paperRoot, threadId });
  assert.deepEqual(recovered.messages, beforeComplete.messages);
  const otherPaper = await agentTurnStatus({ researchRoot: root, paperRoot: otherRoot, threadId });
  assert.equal(otherPaper.messages, undefined);
});

test("recovered snapshots neither duplicate streamed messages nor overwrite newer words", () => {
  let messages = [{ id: "placeholder", role: "assistant", text: "" }];
  messages = mergeAgentMessages(messages, [{ id: "first", text: "Checking", revision: 1 }], "placeholder");
  messages = mergeAgentMessages(messages, [{ id: "first", text: "Checking the paper", revision: 3 }]);
  messages = mergeAgentMessages(messages, [{ id: "first", text: "Checking the", revision: 2 }]);
  messages = mergeAgentMessages(messages, [{ id: "first", text: "Checking the paper", revision: 3 }, { id: "last", text: "Finished", revision: 1 }]);
  assert.deepEqual(messages.map(m => m.text), ["Checking the paper", "Finished"]);
});
