import path from "node:path";

export const AGENT_PROVIDERS = Object.freeze({
  codex: {
    id: "codex",
    name: "Codex",
    subscription: "ChatGPT/Codex",
  },
  claude: {
    id: "claude",
    name: "Claude Code",
    subscription: "Claude",
  },
  cursor: {
    id: "cursor",
    name: "Cursor Agent",
    subscription: "Cursor",
  },
});

export const EXTERNAL_PROVIDER_IDS = Object.freeze(["claude", "cursor"]);

export const PROPOSAL_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    changes: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          action: { type: "string", enum: ["write", "delete"] },
          content: { type: "string" },
        },
        required: ["path", "action", "content"],
      },
    },
  },
  required: ["summary", "changes"],
});

export function normalizeProvider(value) {
  const provider = value == null || value === "" ? "codex" : String(value).toLowerCase();
  if (!Object.hasOwn(AGENT_PROVIDERS, provider)) {
    const error = new Error("provider must be codex, claude, or cursor.");
    error.status = 400;
    error.code = "unsupported_provider";
    throw error;
  }
  return provider;
}

export function providerName(provider) {
  return AGENT_PROVIDERS[normalizeProvider(provider)].name;
}

export function providerThreadId(provider, rawThreadId) {
  if (!rawThreadId) return null;
  const prefix = `${normalizeProvider(provider)}:`;
  const value = String(rawThreadId);
  return value.startsWith(prefix) ? value : `${prefix}${value}`;
}

export function rawProviderThreadId(provider, threadId) {
  if (!threadId) return null;
  const prefix = `${normalizeProvider(provider)}:`;
  const value = String(threadId);
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function proposalInstructions({ researchRoot, paperRoot, userPrompt }) {
  const relativePaper = path.relative(researchRoot, paperRoot) || ".";
  return [
    "You are preparing a proposed edit for Local LaTeX Workbench.",
    `The research workspace is ${researchRoot}.`,
    `The paper folder is ${relativePaper}.`,
    "Work in read-only proposal mode. Do not edit, create, move, or delete files.",
    "Do not run shell commands, use network access, call MCP tools, or invoke external connectors.",
    "You may read and search files inside the research workspace to understand the paper and supporting code.",
    "Treat an attached source or PDF-mapped selection as the primary target, while allowing the smallest related edits needed for consistency.",
    "For every proposed edit, return the complete resulting UTF-8 text of that file, not a patch or abbreviated excerpt.",
    "Use research-root-relative paths only. Never return absolute paths or paths containing '..'.",
    "Use action 'write' for additions or replacements and action 'delete' only when deletion is essential.",
    "If no file change is needed, return an empty changes array and answer in summary.",
    "Return only the requested JSON object, with no Markdown fence or commentary outside it.",
    "",
    "User request:",
    userPrompt,
  ].join("\n");
}

export function providerInvocation(provider, options) {
  const normalized = normalizeProvider(provider);
  if (!EXTERNAL_PROVIDER_IDS.includes(normalized)) {
    throw new Error("Codex uses its native app-server adapter.");
  }
  const prompt = proposalInstructions(options);
  const rawThread = rawProviderThreadId(normalized, options.threadId);

  if (normalized === "claude") {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(PROPOSAL_SCHEMA),
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Glob,Grep",
      "--disallowedTools",
      "mcp__*",
      "--safe-mode",
      "--no-chrome",
    ];
    if (rawThread) args.push("--resume", rawThread);
    else if (options.sessionId) args.push("--session-id", options.sessionId);
    if (options.reasoningEffort) args.push("--effort", options.reasoningEffort);
    return { command: "claude", args, prompt, output: "claude-json" };
  }

  const args = [
    "-p",
    "--mode=ask",
    "--sandbox=enabled",
    "--trust",
    "--output-format=json",
    "--workspace",
    options.researchRoot,
  ];
  if (rawThread) args.push("--resume", rawThread);
  if (options.model) args.push("--model", options.model);
  return { command: "agent", args, prompt, output: "cursor-json" };
}

export function providerEnvironment(provider, source = process.env) {
  const env = { ...source };
  if (normalizeProvider(provider) === "claude") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    delete env.CLAUDE_CODE_USE_FOUNDRY;
  } else {
    delete env.CURSOR_API_KEY;
  }
  return env;
}

function parseJsonText(value, label) {
  if (typeof value !== "string") throw new Error(`${label} did not return text.`);
  let text = value.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`${label} did not return a valid edit proposal.`);
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error(`${label} returned an edit proposal that could not be parsed.`);
    }
  }
}

function validateProposal(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid edit proposal.`);
  }
  if (typeof value.summary !== "string" || !Array.isArray(value.changes)) {
    throw new Error(`${label} returned an incomplete edit proposal.`);
  }
  if (value.changes.length > 128) throw new Error(`${label} proposed too many files at once.`);
  const changes = value.changes.map((change) => {
    if (
      !change
      || typeof change !== "object"
      || typeof change.path !== "string"
      || !["write", "delete"].includes(change.action)
      || typeof change.content !== "string"
    ) {
      throw new Error(`${label} returned an invalid file entry.`);
    }
    return { path: change.path, action: change.action, content: change.content };
  });
  return { summary: value.summary, changes };
}

export function parseProviderResult(provider, stdout) {
  const normalized = normalizeProvider(provider);
  const label = providerName(normalized);
  const envelope = parseJsonText(stdout, label);
  const rawSessionId = envelope.session_id ?? envelope.sessionId ?? null;
  const payload = normalized === "claude"
    ? envelope.structured_output ?? parseJsonText(envelope.result, label)
    : parseJsonText(envelope.result, label);
  return {
    sessionId: rawSessionId == null ? null : String(rawSessionId),
    proposal: validateProposal(payload, label),
  };
}
