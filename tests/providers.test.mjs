import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProviderResult,
  providerEnvironment,
  providerInvocation,
  providerThreadId,
  rawProviderThreadId,
} from "../server/providers.mjs";

const options = {
  researchRoot: "/tmp/research",
  paperRoot: "/tmp/research/paper",
  userPrompt: "Tighten the selected paragraph.",
};

test("builds a subscription-only read/search Claude Code invocation", () => {
  const invocation = providerInvocation("claude", {
    ...options,
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    model: "subscription-model",
    reasoningEffort: "high",
  });
  assert.equal(invocation.command, "claude");
  assert.ok(invocation.args.includes("--safe-mode"));
  assert.ok(invocation.args.includes("--permission-mode"));
  assert.ok(invocation.args.includes("plan"));
  assert.ok(invocation.args.includes("Read,Glob,Grep"));
  assert.ok(invocation.args.includes("mcp__*"));
  assert.ok(!invocation.args.includes("Bash"));
  assert.ok(!invocation.args.includes("Edit"));
  assert.ok(!invocation.args.includes("Write"));
  assert.ok(!invocation.args.includes(options.userPrompt));
  assert.match(invocation.prompt, /Tighten the selected paragraph/);
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 2),
    ["--model", "subscription-model"],
  );
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf("--effort"), invocation.args.indexOf("--effort") + 2),
    ["--effort", "high"],
  );

  const env = providerEnvironment("claude", {
    PATH: "/bin",
    ANTHROPIC_API_KEY: "secret",
    ANTHROPIC_AUTH_TOKEN: "token",
    CLAUDE_CODE_USE_BEDROCK: "1",
  });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("builds a read-only Cursor Ask-mode subscription invocation", () => {
  const invocation = providerInvocation("cursor", {
    ...options,
    threadId: "cursor:chat-123",
  });
  assert.equal(invocation.command, "agent");
  assert.ok(invocation.args.includes("--mode=ask"));
  assert.ok(invocation.args.includes("--sandbox=enabled"));
  assert.ok(invocation.args.includes("--trust"));
  assert.ok(!invocation.args.includes("--force"));
  assert.ok(!invocation.args.includes("--yolo"));
  assert.ok(!invocation.args.includes(options.userPrompt));
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf("--resume"), invocation.args.indexOf("--resume") + 2),
    ["--resume", "chat-123"],
  );
  assert.deepEqual(providerEnvironment("cursor", { PATH: "/bin", CURSOR_API_KEY: "secret" }), { PATH: "/bin" });
});

test("parses Claude structured output and Cursor result JSON", () => {
  const proposal = {
    summary: "Prepared one change.",
    changes: [{ path: "paper/main.tex", action: "write", content: "new\n" }],
  };
  assert.deepEqual(parseProviderResult("claude", JSON.stringify({
    session_id: "claude-session",
    structured_output: proposal,
  })), {
    sessionId: "claude-session",
    proposal,
  });
  assert.deepEqual(parseProviderResult("cursor", JSON.stringify({
    session_id: "cursor-session",
    result: `\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``,
  })), {
    sessionId: "cursor-session",
    proposal,
  });
});

test("rejects malformed or incomplete provider proposals", () => {
  assert.throws(
    () => parseProviderResult("cursor", JSON.stringify({ result: "not JSON" })),
    /valid edit proposal/i,
  );
  assert.throws(
    () => parseProviderResult("claude", JSON.stringify({ structured_output: { summary: "missing changes" } })),
    /incomplete edit proposal/i,
  );
});

test("keeps provider conversation identifiers namespaced", () => {
  assert.equal(providerThreadId("claude", "abc"), "claude:abc");
  assert.equal(providerThreadId("claude", "claude:abc"), "claude:abc");
  assert.equal(rawProviderThreadId("cursor", "cursor:def"), "def");
});
