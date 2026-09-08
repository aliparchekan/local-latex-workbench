import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { applyPatch, createTwoFilesPatch } from "diff";
import {
  AGENT_PROVIDERS,
  EXTERNAL_PROVIDER_IDS,
  normalizeProvider,
  parseProviderResult,
  providerEnvironment,
  providerInvocation,
  providerName,
  providerThreadId,
} from "./providers.mjs";

const HOST = "127.0.0.1";
const PORT = 4317;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 12 * 1024 * 1024;
const MAX_TREE_ENTRIES = 6_000;
const MAX_TREE_DEPTH = 14;
const CODEX_REQUEST_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 15 * 60_000;
const TURN_TIMEOUT_MS = 45 * 60_000;
const PROVIDER_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_REVIEW_FILES = 128;
const MAX_REVIEW_BYTES = 16 * 1024 * 1024;
const MAX_PERMISSION_SCAN_ENTRIES = 2_000;
const RESEARCH_APPROVAL_POLICY = {
  granular: {
    sandbox_approval: true,
    rules: false,
    mcp_elicitations: false,
    request_permissions: true,
    skill_approval: false,
  },
};

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".codex-paper-build",
  ".wrangler",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
]);

const BUILD_ARTIFACT_SUFFIXES = [
  ".aux",
  ".bcf",
  ".blg",
  ".fdb_latexmk",
  ".fls",
  ".lof",
  ".log",
  ".lot",
  ".nav",
  ".out",
  ".run.xml",
  ".snm",
  ".synctex",
  ".synctex.gz",
  ".toc",
  ".vrb",
  ".xdv",
];

const allowedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
// Preserve an optional UTF-8 BOM so decoded/re-encoded review and undo bytes
// remain identical to the source file.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class HttpError extends Error {
  constructor(status, message, code = "bad_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertString(value, label, { maxLength = 100_000, allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new HttpError(400, `${label} must be a ${allowEmpty ? "valid" : "non-empty"} string.`);
  }
  if (value.includes("\0")) throw new HttpError(400, `${label} contains an invalid character.`);
  if (value.length > maxLength) throw new HttpError(413, `${label} is too large.`);
  return value;
}

async function canonicalDirectory(value, label) {
  assertString(value, label, { maxLength: 16_384 });
  if (!path.isAbsolute(value)) throw new HttpError(400, `${label} must be an absolute path.`);
  let real;
  try {
    real = await fs.realpath(value);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new HttpError(400, `${label} is not a folder.`);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `${label} does not exist or cannot be read.`);
  }
  return path.normalize(real);
}

async function canonicalRoots(researchValue, paperValue) {
  const researchRoot = await canonicalDirectory(researchValue, "researchRoot");
  const paperRoot = await canonicalDirectory(paperValue ?? researchValue, "paperRoot");
  if (!isWithin(researchRoot, paperRoot)) {
    throw new HttpError(400, "paperRoot must be inside researchRoot.");
  }
  return { researchRoot, paperRoot };
}

/**
 * Resolve a client path without allowing lexical traversal or symlink escape.
 * Missing final files are allowed only when their real parent is still in root.
 */
async function safePath(root, userPath, { mustExist = true, fileOnly = false } = {}) {
  assertString(userPath, "path", { maxLength: 16_384 });
  const candidate = path.normalize(
    path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(root, userPath),
  );
  if (!isWithin(root, candidate)) throw new HttpError(403, "Path is outside the selected root.");

  try {
    const real = path.normalize(await fs.realpath(candidate));
    if (!isWithin(root, real)) throw new HttpError(403, "Path resolves outside the selected root.");
    if (fileOnly) {
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw new HttpError(400, "Path is not a file.");
    }
    return { path: real, exists: true };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.code !== "ENOENT" || mustExist) {
      throw new HttpError(404, "Path does not exist or cannot be accessed.");
    }
    const parent = path.normalize(await fs.realpath(path.dirname(candidate)).catch(() => ""));
    if (!parent || !isWithin(root, parent)) {
      throw new HttpError(403, "The destination parent is outside the selected root.");
    }
    return { path: candidate, exists: false };
  }
}

function lexicalPath(root, userPath) {
  assertString(userPath, "path", { maxLength: 16_384 });
  const candidate = path.normalize(
    path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(root, userPath),
  );
  if (!isWithin(root, candidate)) throw new HttpError(403, "Path is outside the selected root.");
  return candidate;
}

/**
 * Approval targets must not traverse symlinks. App-server applies the original
 * path after approval, so reviewing only its resolved target would otherwise
 * allow the original symlink to be swapped before the patch is applied.
 */
async function safeApprovalPath(root, userPath, { mustExist = false } = {}) {
  const lexical = lexicalPath(root, userPath);
  const resolved = await safePath(root, userPath, { mustExist });
  if (resolved.exists) {
    if (path.normalize(resolved.path) !== lexical) {
      throw new HttpError(403, "Agent write targets may not use symbolic links.");
    }
    const stat = await fs.lstat(lexical);
    if (stat.isSymbolicLink()) throw new HttpError(403, "Agent write targets may not be symbolic links.");
  } else {
    const parent = path.normalize(await fs.realpath(path.dirname(lexical)));
    if (parent !== path.dirname(lexical)) {
      throw new HttpError(403, "Agent write target parents may not use symbolic links.");
    }
  }
  return resolved;
}

async function resolveMainFile(researchRoot, paperRoot, mainFile) {
  assertString(mainFile, "mainFile", { maxLength: 16_384 });
  // Public file identifiers use the research-root-relative namespace.
  const resolved = await safePath(researchRoot, mainFile, { mustExist: true, fileOnly: true });
  if (!isWithin(paperRoot, resolved.path)) {
    throw new HttpError(403, "The main .tex file must be inside the selected paper folder.");
  }
  if (path.extname(resolved.path).toLowerCase() !== ".tex") {
    throw new HttpError(400, "mainFile must be a .tex file.");
  }
  return resolved.path;
}

async function resolvePaperTarget(researchRoot, paperRoot, userPath, options = {}) {
  let researchCandidate = null;
  try {
    researchCandidate = await safePath(researchRoot, userPath, options);
    if (isWithin(paperRoot, researchCandidate.path)) return researchCandidate;
  } catch (error) {
    if (path.isAbsolute(userPath)) throw error;
  }
  if (path.isAbsolute(userPath)) throw new HttpError(403, "Path is outside paperRoot.");
  const paperCandidate = await safePath(paperRoot, userPath, options);
  if (!isWithin(paperRoot, paperCandidate.path)) throw new HttpError(403, "Path is outside paperRoot.");
  return paperCandidate;
}

function looksLikeBuildArtifact(name) {
  const lower = name.toLowerCase();
  return BUILD_ARTIFACT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function relativePortable(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && !allowedOriginPattern.test(origin)) return false;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return true;
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function writeNdjson(res, value) {
  if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(value)}\n`);
}

function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 20_000,
    maxOutputBytes = 4 * 1024 * 1024,
  } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: error.message, error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (target, chunk) => {
      if (capturedBytes >= maxOutputBytes) {
        truncated = true;
        return target;
      }
      const remaining = maxOutputBytes - capturedBytes;
      const slice = chunk.subarray(0, remaining);
      capturedBytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
      return target + slice.toString("utf8");
    };
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_500).unref();
    }, timeoutMs);
    timer.unref();

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, error, timedOut, truncated });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, truncated });
    });
  });
}

function subscriptionEnvironment(source = process.env) {
  const env = { ...source };
  delete env.OPENAI_API_KEY;
  delete env.AZURE_OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

function versionParts(version) {
  return String(version ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

let codexRuntimePromise = null;
async function getCodexRuntime() {
  if (codexRuntimePromise) return codexRuntimePromise;
  codexRuntimePromise = (async () => {
    const override = process.env.LOCAL_LATEX_CODEX_BIN?.trim();
    const candidates = override
      ? [override]
      : [
        ...(process.platform === "darwin" ? [
          "/Applications/ChatGPT.app/Contents/Resources/codex",
          path.join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        ] : []),
        "codex",
      ];
    const uniqueCandidates = [...new Set(candidates)];
    const probes = await Promise.all(uniqueCandidates.map(async (command, priority) => {
      const result = await runProcess(command, ["--version"], {
        env: subscriptionEnvironment(),
        timeoutMs: 8_000,
        maxOutputBytes: 16_384,
      });
      const version = `${result.stdout}\n${result.stderr}`.match(/codex-cli\s+([^\s]+)/i)?.[1] ?? null;
      return { command, version, result, priority };
    }));
    const available = probes.filter((probe) => probe.result.code === 0);
    if (!available.length) {
      return probes[0] ?? {
        command: override || "codex",
        version: null,
        result: { code: null, stdout: "", stderr: "Codex CLI not found." },
        priority: 0,
      };
    }
    available.sort((left, right) => (
      compareVersions(right.version, left.version) || left.priority - right.priority
    ));
    return available[0];
  })();
  return codexRuntimePromise;
}

let healthCache = null;
async function getHealth() {
  if (healthCache && Date.now() - healthCache.at < 5_000) return healthCache.value;
  const codexRuntime = await getCodexRuntime();
  const [login, claudeVersionResult, claudeLogin, cursorVersionResult, cursorLogin, latexmk, synctex] = await Promise.all([
    runProcess(codexRuntime.command, ["login", "status"], {
      env: subscriptionEnvironment(),
      timeoutMs: 8_000,
      maxOutputBytes: 16_384,
    }),
    runProcess("claude", ["--version"], {
      env: providerEnvironment("claude"),
      timeoutMs: 8_000,
      maxOutputBytes: 16_384,
    }),
    runProcess("claude", ["auth", "status"], {
      env: providerEnvironment("claude"),
      timeoutMs: 8_000,
      maxOutputBytes: 16_384,
    }),
    runProcess("agent", ["--version"], {
      env: providerEnvironment("cursor"),
      timeoutMs: 8_000,
      maxOutputBytes: 16_384,
    }),
    runProcess("agent", ["status"], {
      env: providerEnvironment("cursor"),
      timeoutMs: 8_000,
      maxOutputBytes: 16_384,
    }),
    runProcess("latexmk", ["-v"], { timeoutMs: 8_000, maxOutputBytes: 16_384 }),
    runProcess("synctex", ["help"], { timeoutMs: 8_000, maxOutputBytes: 16_384 }),
  ]);

  const codexInstalled = codexRuntime.result.code === 0;
  const codexAuthenticated = login.code === 0 && /logged in using chatgpt/i.test(`${login.stdout}\n${login.stderr}`);
  const codexVersion = codexRuntime.version;
  const claudeInstalled = claudeVersionResult.code === 0;
  let claudeAuthenticated = false;
  try {
    const status = JSON.parse(claudeLogin.stdout.trim());
    claudeAuthenticated = claudeLogin.code === 0 && status.loggedIn === true && status.authMethod !== "api_key";
  } catch {
    claudeAuthenticated = claudeLogin.code === 0
      && /logged\s*in|authenticated/i.test(`${claudeLogin.stdout}\n${claudeLogin.stderr}`)
      && !/not\s+(?:logged\s*in|authenticated)/i.test(`${claudeLogin.stdout}\n${claudeLogin.stderr}`);
  }
  const claudeVersion = `${claudeVersionResult.stdout}\n${claudeVersionResult.stderr}`.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null;
  const cursorInstalled = cursorVersionResult.code === 0;
  const cursorStatusText = `${cursorLogin.stdout}\n${cursorLogin.stderr}`;
  const cursorAuthenticated = cursorLogin.code === 0
    && !/not\s+(?:logged\s*in|authenticated)|login required/i.test(cursorStatusText);
  const cursorVersion = `${cursorVersionResult.stdout}\n${cursorVersionResult.stderr}`.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null;
  const latexVersion = `${latexmk.stdout}\n${latexmk.stderr}`.match(/Version\s+([^\s]+)/i)?.[1] ?? null;
  const providers = {
    codex: {
      installed: codexInstalled,
      authenticated: codexAuthenticated,
      label: !codexInstalled
        ? "Codex CLI not found"
        : codexAuthenticated
          ? `Codex ${codexVersion ?? "CLI"} · ChatGPT subscription`
          : "Codex CLI found · ChatGPT sign-in required",
      version: codexVersion,
    },
    claude: {
      installed: claudeInstalled,
      authenticated: claudeAuthenticated,
      label: !claudeInstalled
        ? "Claude Code not found"
        : claudeAuthenticated
          ? `Claude Code ${claudeVersion ?? "CLI"} · Claude subscription`
          : "Claude Code found · run claude auth login",
      version: claudeVersion,
    },
    cursor: {
      installed: cursorInstalled,
      authenticated: cursorAuthenticated,
      label: !cursorInstalled
        ? "Cursor Agent CLI not found"
        : cursorAuthenticated
          ? `Cursor Agent ${cursorVersion ?? "CLI"} · Cursor subscription`
          : "Cursor Agent found · run agent login",
      version: cursorVersion,
    },
  };
  const value = {
    ok: Object.values(providers).some((provider) => provider.authenticated)
      && latexmk.code === 0
      && synctex.code === 0,
    platform: { os: process.platform, arch: process.arch },
    providers,
    codex: providers.codex,
    claude: providers.claude,
    cursor: providers.cursor,
    latex: {
      installed: latexmk.code === 0,
      label: latexmk.code === 0 ? `latexmk ${latexVersion ?? "available"}` : "latexmk not found",
      synctex: synctex.code === 0,
    },
  };
  healthCache = { at: Date.now(), value };
  return value;
}

async function pickFolder(body) {
  if (process.platform !== "darwin") {
    throw new HttpError(501, "The native folder picker is currently available on macOS only.", "unsupported_platform");
  }
  let initialPath = null;
  if (body.initialPath != null && body.initialPath !== "") {
    try {
      initialPath = await canonicalDirectory(body.initialPath, "initialPath");
    } catch {
      initialPath = null;
    }
  }
  const script = [
    "on run argv",
    "try",
    "if (count of argv) > 0 then",
    'set pickedFolder to choose folder with prompt "Choose a folder" default location (POSIX file (item 1 of argv))',
    "else",
    'set pickedFolder to choose folder with prompt "Choose a folder"',
    "end if",
    "return POSIX path of pickedFolder",
    "on error number -128",
    'return "__CANCELLED__"',
    "end try",
    "end run",
  ].join("\n");
  const args = ["-e", script];
  if (initialPath) args.push(initialPath);
  const result = await runProcess("osascript", args, { timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 });
  const output = result.stdout.trim();
  if (output === "__CANCELLED__" || /user canceled/i.test(result.stderr)) {
    return { canceled: true, cancelled: true };
  }
  if (result.code !== 0 || !output) {
    throw new HttpError(500, result.stderr.trim() || "The folder picker could not be opened.");
  }
  return {
    canceled: false,
    cancelled: false,
    path: await canonicalDirectory(output, "selected folder"),
  };
}

async function revealPaperLocation(body) {
  if (process.platform !== "darwin") {
    throw new HttpError(501, "Show in Finder is currently available on macOS only.", "unsupported_platform");
  }
  const { researchRoot, paperRoot } = await canonicalRoots(body.researchRoot, body.paperRoot);
  let target = paperRoot;
  let args = [paperRoot];
  if (body.path != null && body.path !== "") {
    const resolved = await resolvePaperTarget(researchRoot, paperRoot, body.path, {
      mustExist: true,
      fileOnly: true,
    });
    target = resolved.path;
    args = ["-R", target];
  }
  const result = await runProcess("/usr/bin/open", args, {
    timeoutMs: 15_000,
    maxOutputBytes: 16_384,
  });
  if (result.code !== 0) {
    throw new HttpError(500, result.stderr.trim() || "Finder could not show that location.");
  }
  return { ok: true, path: target };
}

async function inspectProject(researchRoot, paperRoot) {
  const warnings = [];
  const texFiles = [];
  let count = 0;

  async function visit(directory, depth) {
    if (depth > MAX_TREE_DEPTH || count >= MAX_TREE_ENTRIES) return [];
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      warnings.push(`Could not read ${relativePortable(researchRoot, directory) || "."}.`);
      return [];
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    const nodes = [];
    for (const entry of entries) {
      if (count >= MAX_TREE_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isFile() && looksLikeBuildArtifact(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = relativePortable(researchRoot, absolute);
      count += 1;
      if (entry.isDirectory()) {
        const children = await visit(absolute, depth + 1);
        nodes.push({ name: entry.name, path: relative, type: "directory", children });
      } else if (entry.isFile()) {
        let size = null;
        try {
          size = (await fs.stat(absolute)).size;
        } catch {
          // A transiently unavailable file can still appear in the tree.
        }
        nodes.push({ name: entry.name, path: relative, type: "file", size });
        if (path.extname(entry.name).toLowerCase() === ".tex") texFiles.push(absolute);
      }
    }
    return nodes;
  }

  // The explorer is scoped to the paper. Codex still receives researchRoot as
  // its cwd and can read the wider project for context.
  const tree = await visit(paperRoot, 0);
  if (count >= MAX_TREE_ENTRIES) warnings.push(`Tree truncated after ${MAX_TREE_ENTRIES} entries.`);

  const texCandidates = [];
  for (const absolute of texFiles) {
    let score = 0;
    let content = "";
    try {
      const stat = await fs.stat(absolute);
      if (stat.size <= 512 * 1024) content = await fs.readFile(absolute, "utf8");
    } catch {
      // Ranking falls back to the filename.
    }
    const base = path.basename(absolute).toLowerCase();
    if (base === "main.tex") score += 120;
    if (["paper.tex", "manuscript.tex", "article.tex"].includes(base)) score += 70;
    if (/\\documentclass(?:\[[^\]]*\])?\s*\{/.test(content)) score += 90;
    if (/\\begin\s*\{document\}/.test(content)) score += 35;
    if (/^\s*%\s*!tex\s+root\s*=/im.test(content)) score -= 30;
    if (isWithin(paperRoot, absolute)) score += 25;
    const paperPath = isWithin(paperRoot, absolute) ? relativePortable(paperRoot, absolute) : null;
    texCandidates.push({
      path: relativePortable(researchRoot, absolute),
      paperPath,
      name: path.basename(absolute),
      score,
    });
  }
  texCandidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  // All public file identifiers use the research-root-relative namespace.
  const suggestedMain = texCandidates.find((candidate) => candidate.paperPath)?.path ?? null;
  return { tree, texCandidates, suggestedMain, warnings };
}

function parseLatexErrors(log) {
  const results = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.file ?? ""}:${entry.line ?? ""}:${entry.message}`;
    if (!seen.has(key) && results.length < 120) {
      seen.add(key);
      results.push(entry);
    }
  };
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fileLine = line.match(/^(.+?\.(?:tex|sty|cls|bib)):(\d+):\s*(.+)$/i);
    if (fileLine) {
      push({ file: fileLine[1], line: Number(fileLine[2]), message: fileLine[3], severity: "error" });
      continue;
    }
    const latexError = line.match(/^!\s*(?:LaTeX Error:\s*)?(.+)$/i);
    if (latexError) {
      push({ file: null, line: null, message: latexError[1], severity: "error" });
      continue;
    }
    if (/undefined control sequence|fatal error|emergency stop/i.test(line)) {
      push({ file: null, line: null, message: line, severity: "error" });
    } else if (/^(?:LaTeX|Package .+?) Warning:/i.test(line)) {
      push({ file: null, line: null, message: line, severity: "warning" });
    }
  }
  return results;
}

const builds = new Map();

async function ensureBuildDirectory(paperRoot) {
  const buildDirectory = path.join(paperRoot, ".codex-paper-build");
  try {
    const stat = await fs.lstat(buildDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HttpError(403, "The LaTeX build location is not a safe directory.");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(buildDirectory, { recursive: true });
  }
  const real = path.normalize(await fs.realpath(buildDirectory));
  if (!isWithin(paperRoot, real)) throw new HttpError(403, "The LaTeX build location is outside paperRoot.");
  return real;
}

async function compileProject(body) {
  const { researchRoot, paperRoot } = await canonicalRoots(body.researchRoot, body.paperRoot);
  const mainPath = await resolveMainFile(researchRoot, paperRoot, body.mainFile);
  let engine = String(body.engine ?? "auto").toLowerCase();
  if (engine === "auto") {
    let header = "";
    try {
      header = (await fs.readFile(mainPath, "utf8")).slice(0, 16_384);
    } catch {
      // A later latexmk error will provide the useful diagnostic.
    }
    const declared = header.match(/^\s*%\s*!tex\s+(?:program|engine)\s*=\s*(pdftex|pdflatex|xetex|xelatex|luatex|lualatex)\s*$/im)?.[1]?.toLowerCase();
    engine = declared?.startsWith("xe") ? "xelatex" : declared?.startsWith("lua") ? "lualatex" : "pdflatex";
  }
  const engineFlag = {
    pdflatex: "-pdf",
    xelatex: "-xelatex",
    lualatex: "-lualatex",
  }[engine];
  if (!engineFlag) throw new HttpError(400, "engine must be pdflatex, xelatex, or lualatex.");

  const buildDirectory = await ensureBuildDirectory(paperRoot);
  const args = [
    engineFlag,
    "-interaction=nonstopmode",
    "-file-line-error",
    "-halt-on-error",
    "-synctex=1",
    `-outdir=${buildDirectory}`,
    mainPath,
  ];
  const result = await runProcess("latexmk", args, {
    cwd: path.dirname(mainPath),
    timeoutMs: 3 * 60_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  let log = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  if (result.truncated) log += "\n[Build output truncated by the local companion.]";
  if (result.timedOut) log += "\n[Build timed out.]";

  const pdfPath = path.join(buildDirectory, `${path.basename(mainPath, path.extname(mainPath))}.pdf`);
  let pdfExists = false;
  try {
    pdfExists = (await fs.stat(pdfPath)).isFile();
  } catch {
    pdfExists = false;
  }
  const buildId = randomUUID();
  if (pdfExists) {
    builds.set(buildId, {
      buildId,
      researchRoot,
      paperRoot,
      mainPath,
      pdfPath,
      buildDirectory,
      createdAt: Date.now(),
    });
  }
  pruneBuilds();
  const success = result.code === 0 && pdfExists;
  const errorDetails = parseLatexErrors(log);
  return {
    success,
    buildId,
    pdfUrl: pdfExists ? `/api/pdf?buildId=${encodeURIComponent(buildId)}` : null,
    log,
    errors: errorDetails.map((entry) => {
      const location = entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ""}: ` : "";
      return `${location}${entry.message}`;
    }),
    errorDetails,
    engine,
  };
}

function pruneBuilds() {
  const cutoff = Date.now() - 12 * 60 * 60_000;
  for (const [id, build] of builds) {
    if (build.createdAt < cutoff) builds.delete(id);
  }
  while (builds.size > 100) builds.delete(builds.keys().next().value);
}

async function getBuild(body) {
  if (body.buildId) {
    const build = builds.get(String(body.buildId));
    if (!build) throw new HttpError(404, "Build not found. Compile the paper again.");
    if (body.researchRoot || body.paperRoot) {
      const roots = await canonicalRoots(body.researchRoot ?? build.researchRoot, body.paperRoot ?? build.paperRoot);
      if (roots.researchRoot !== build.researchRoot || roots.paperRoot !== build.paperRoot) {
        throw new HttpError(403, "Build does not belong to the selected project.");
      }
    }
    const checkedPdf = await safePath(build.paperRoot, build.pdfPath, { mustExist: true, fileOnly: true });
    return { ...build, pdfPath: checkedPdf.path };
  }
  const { researchRoot, paperRoot } = await canonicalRoots(body.researchRoot, body.paperRoot);
  const mainPath = await resolveMainFile(researchRoot, paperRoot, body.mainFile);
  const buildDirectory = path.join(paperRoot, ".codex-paper-build");
  const pdfPath = path.join(buildDirectory, `${path.basename(mainPath, path.extname(mainPath))}.pdf`);
  const checked = await safePath(paperRoot, pdfPath, { mustExist: true, fileOnly: true });
  return { researchRoot, paperRoot, mainPath, buildDirectory, pdfPath: checked.path };
}

function parseSynctexOutput(output) {
  const matches = [];
  let current = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^SyncTeX result (?:begin|end)$/i.test(line)) continue;
    const pair = line.match(/^([^:]+):(.*)$/);
    if (!pair) continue;
    const key = pair[1].trim();
    const value = pair[2].trim();
    // Inverse-search records contain both Output and Input. A repeated boundary
    // key starts the next result; the first Input after Output stays together.
    if (
      current
      && Object.keys(current).length
      && ((key === "Output" && Object.hasOwn(current, "Output"))
        || (key === "Input" && Object.hasOwn(current, "Input")))
    ) {
      matches.push(current);
      current = null;
    }
    current ??= {};
    const numeric = Number(value);
    current[key] = value !== "" && Number.isFinite(numeric) ? numeric : value;
  }
  if (current && Object.keys(current).length) matches.push(current);
  return matches;
}

async function synctexForward(body) {
  const build = await getBuild(body);
  const sourceValue = body.path ?? body.sourcePath ?? body.sourceFile;
  const source = await safePath(build.researchRoot, sourceValue, { mustExist: true, fileOnly: true });
  const line = Number(body.line);
  const column = body.column == null ? 0 : Number(body.column);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 0) {
    throw new HttpError(400, "line must be positive and column must be zero or greater.");
  }
  if (source.path.includes(":")) throw new HttpError(400, "SyncTeX cannot address a source path containing a colon.");
  const result = await runProcess(
    "synctex",
    ["view", "-i", `${line}:${column}:${source.path}`, "-o", build.pdfPath],
    { cwd: build.paperRoot, timeoutMs: 15_000, maxOutputBytes: 512 * 1024 },
  );
  const raw = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  const matches = parseSynctexOutput(raw);
  const preferred = matches.find((match) => Number.isFinite(match.Page)) ?? matches[0];
  if (result.code !== 0 || !preferred) {
    throw new HttpError(422, raw || "SyncTeX did not find a location for this source position.");
  }
  return { result: preferred, results: matches, match: preferred, matches, raw };
}

async function synctexInverse(body) {
  const build = await getBuild(body);
  const page = Number(body.page);
  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new HttpError(400, "page, x, and y must describe a valid PDF position.");
  }
  if (build.pdfPath.includes(":")) throw new HttpError(400, "SyncTeX cannot address a PDF path containing a colon.");
  const result = await runProcess(
    "synctex",
    ["edit", "-o", `${page}:${x}:${y}:${build.pdfPath}`],
    { cwd: build.paperRoot, timeoutMs: 15_000, maxOutputBytes: 512 * 1024 },
  );
  const raw = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  const matches = parseSynctexOutput(raw);
  const preferred = matches.find((match) => typeof match.Input === "string" && Number.isFinite(match.Line)) ?? matches[0];
  if (result.code !== 0 || !preferred) {
    throw new HttpError(422, raw || "SyncTeX did not find source for this PDF position.");
  }
  for (const match of matches) {
    if (typeof match.Input !== "string") continue;
    const absolute = path.isAbsolute(match.Input)
      ? path.normalize(match.Input)
      : path.resolve(build.paperRoot, match.Input);
    if (isWithin(build.researchRoot, absolute)) match.path = relativePortable(build.researchRoot, absolute);
  }
  return { result: preferred, results: matches, match: preferred, matches, raw };
}

async function readTextFile(root, userPath) {
  const resolved = await safePath(root, userPath, { mustExist: true, fileOnly: true });
  const stat = await fs.stat(resolved.path);
  if (stat.size > MAX_TEXT_BYTES) throw new HttpError(413, "File is too large to edit as text.");
  const buffer = await fs.readFile(resolved.path);
  if (buffer.includes(0)) throw new HttpError(415, "File appears to be binary.");
  let content;
  try {
    content = utf8Decoder.decode(buffer);
  } catch {
    throw new HttpError(415, "File is not valid UTF-8 text.");
  }
  return { resolved, content, stat, buffer, hash: sha256(buffer) };
}

function expectedSaveHash(body) {
  const hasHash = Object.hasOwn(body, "expectedHash");
  const hasVersion = Object.hasOwn(body, "expectedVersion");
  if (!hasHash && !hasVersion) return { provided: false, value: null };
  if (
    hasHash
    && hasVersion
    && body.expectedHash !== body.expectedVersion
  ) {
    throw new HttpError(400, "expectedHash and expectedVersion must match when both are provided.");
  }
  const raw = hasHash ? body.expectedHash : body.expectedVersion;
  if (raw === null) return { provided: true, value: null };
  const value = assertString(raw, hasHash ? "expectedHash" : "expectedVersion", { maxLength: 64 });
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new HttpError(400, `${hasHash ? "expectedHash" : "expectedVersion"} must be a SHA-256 hash or null.`);
  }
  return { provided: true, value: value.toLowerCase() };
}

async function saveTextFile(body) {
  const { researchRoot, paperRoot } = await canonicalRoots(body.researchRoot, body.paperRoot);
  assertString(body.content, "content", { maxLength: MAX_TEXT_BYTES, allowEmpty: true });
  const expected = expectedSaveHash(body);
  const destination = await resolvePaperTarget(researchRoot, paperRoot, body.path, { mustExist: false });
  if (destination.exists) {
    const stat = await fs.lstat(destination.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(400, "Only regular text files can be saved.");
  }
  let previous = "";
  let observedHash = null;
  if (destination.exists) {
    const current = await readTextFile(paperRoot, destination.path);
    previous = current.content;
    observedHash = current.hash;
  }
  if (expected.provided && expected.value !== observedHash) {
    throw new HttpError(409, "This file changed on disk after it was loaded. Reload it before saving.", "file_conflict");
  }

  const nextBuffer = Buffer.from(body.content, "utf8");
  const nextHash = sha256(nextBuffer);
  const tempPath = `${destination.path}.codex-save-${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, nextBuffer, { flag: "wx" });
  try {
    // Recheck after staging the new bytes so concurrent saves or outside edits
    // cannot silently replace a newer version observed during this request.
    const latest = await safePath(paperRoot, destination.path, { mustExist: false });
    let latestHash = null;
    if (latest.exists) {
      const latestStat = await fs.lstat(latest.path);
      if (!latestStat.isFile() || latestStat.isSymbolicLink() || latestStat.size > MAX_TEXT_BYTES) {
        throw new HttpError(409, "This file changed on disk while it was being saved. Reload it before saving.", "file_conflict");
      }
      latestHash = sha256(await fs.readFile(latest.path));
    }
    if (latest.path !== destination.path || latestHash !== observedHash) {
      throw new HttpError(409, "This file changed on disk while it was being saved. Reload it before saving.", "file_conflict");
    }
    await fs.rename(tempPath, destination.path);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
  const savedStat = await fs.stat(destination.path);
  return {
    ok: true,
    path: relativePortable(researchRoot, destination.path),
    hash: nextHash,
    mtimeMs: savedStat.mtimeMs,
    diff: createTwoFilesPatch(
      relativePortable(researchRoot, destination.path),
      relativePortable(researchRoot, destination.path),
      previous,
      body.content,
      "before",
      "after",
    ),
  };
}

// --- Codex app-server client -------------------------------------------------

const agentSessions = new Map();
const sessionRedirects = new Map();
const startingThreads = new Set();
const agentSinks = new Set();
const turnEvents = new EventEmitter();
turnEvents.setMaxListeners(200);
const fileItems = new Map();
const latestTurnDiffs = new Map();
const pendingApprovals = new Map();
const undoSnapshots = new Map();
const undoOrder = [];
const snapshotsByItem = new Map();
const turnFinalizations = new Map();
const activeTurns = new Map();
const completedTurns = new Map();
const terminalTurns = new Map();
const agentMessages = new Map();
const externalProcesses = new Map();
const externalApprovalWaiters = new Map();
const externalCancelledTurns = new Set();

const turnKey = (threadId, turnId) => `${threadId}:${turnId}`;
const itemKey = (threadId, turnId, itemId) => `${threadId}:${turnId}:${itemId}`;

function publicActiveTurn(turn) {
  if (!turn) return null;
  return {
    threadId: turn.threadId,
    turnId: turn.turnId,
    status: turn.status,
    label: turn.label,
    startedAt: turn.startedAt,
    lastActivityAt: turn.lastActivityAt,
    provider: turn.provider ?? "codex",
  };
}

function registerActiveTurn(session, turn) {
  const turnId = turn?.id;
  if (!session?.threadId || !turnId) return null;
  if (
    terminalTurns.has(turnKey(session.threadId, turnId))
    || completedTurns.has(turnKey(session.threadId, turnId))
  ) return null;
  const now = Date.now();
  const provider = session.provider ?? "codex";
  const active = {
    threadId: session.threadId,
    turnId,
    researchRoot: session.researchRoot,
    paperRoot: session.paperRoot,
    status: turn.status ?? "inProgress",
    label: `${providerName(provider)} is working…`,
    startedAt: now,
    lastActivityAt: now,
    generation: session.generation,
    provider,
  };
  activeTurns.set(session.threadId, active);
  return active;
}

function touchActiveTurn(threadId, turnId, { status, label } = {}) {
  if (!threadId) return null;
  const active = activeTurns.get(threadId);
  if (!active || (turnId && active.turnId !== turnId)) return null;
  active.lastActivityAt = Date.now();
  if (status) active.status = status;
  if (label) active.label = label;
  return active;
}

function forgetActiveTurn(threadId, turnId) {
  const active = activeTurns.get(threadId);
  if (!active || (turnId && active.turnId !== turnId)) return;
  activeTurns.delete(threadId);
  latestTurnDiffs.delete(turnKey(threadId, active.turnId));
  const itemPrefix = `${threadId}:${active.turnId}:`;
  for (const key of fileItems.keys()) {
    if (key.startsWith(itemPrefix)) fileItems.delete(key);
  }
}

function broadcastAgent(threadId, turnId, event) {
  for (const sink of agentSinks) {
    if (sink.threadId !== threadId) continue;
    if (sink.turnId && turnId && sink.turnId !== turnId) continue;
    writeNdjson(sink.res, event);
  }
}

function recordAgentMessage(threadId, turnId, item, delta = null) {
  const session = agentSessions.get(threadId);
  if (!session || !turnId || !item?.id) return;
  let transcript = agentMessages.get(threadId);
  if (!transcript || transcript.turnId !== turnId) {
    transcript = { researchRoot: session.researchRoot, paperRoot: session.paperRoot, turnId, messages: new Map() };
    agentMessages.set(threadId, transcript);
    const expiry = setTimeout(() => {
      if (agentMessages.get(threadId) === transcript) agentMessages.delete(threadId);
    }, TURN_TIMEOUT_MS + 15 * 60_000);
    expiry.unref();
  }
  const previous = transcript.messages.get(item.id);
  const text = delta !== null ? (previous?.text ?? "") + delta : item.text || previous?.text || "";
  if (!text || (previous?.text === text && (!item.phase || item.phase === previous.phase))) return;
  const message = {
    id: `${threadId}:${turnId}:${item.id}`,
    threadId,
    turnId,
    itemId: item.id,
    text,
    phase: item.phase ?? previous?.phase ?? null,
    revision: (previous?.revision ?? 0) + 1,
  };
  transcript.messages.set(item.id, message);
  broadcastAgent(threadId, turnId, { type: "message", provider: "codex", ...message });
}

function trackTurnFinalization(threadId, turnId, promise) {
  const key = turnKey(threadId, turnId);
  const pending = turnFinalizations.get(key) ?? new Set();
  pending.add(promise);
  turnFinalizations.set(key, pending);
  promise.finally(() => {
    pending.delete(promise);
    if (pending.size === 0) turnFinalizations.delete(key);
  });
}

function completeTurnAfterFinalization(threadId, turn) {
  const turnId = turn?.id;
  if (!threadId || !turnId) return;
  const complete = () => {
    const key = turnKey(threadId, turnId);
    completedTurns.set(key, turn);
    const expiry = setTimeout(() => completedTurns.delete(key), 60_000);
    expiry.unref();
    broadcastAgent(threadId, turnId, { type: "completed", turnId, threadId });
    turnEvents.emit(key, turn);
  };
  const pending = turnFinalizations.get(turnKey(threadId, turnId));
  if (pending?.size) Promise.allSettled([...pending]).then(complete);
  else complete();
}

function statusForItem(item) {
  switch (item?.type) {
    case "reasoning":
      return "Thinking…";
    case "commandExecution":
      return "Inspecting the research project…";
    case "fileChange":
      return "Preparing reviewed source changes…";
    case "mcpToolCall":
      return "Using a connected tool…";
    default:
      return null;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function publicSnapshotStatus(snapshot) {
  const undoAvailable = snapshot.applied
    && ["completed", "completedMismatch"].includes(snapshot.applyStatus)
    && !snapshot.undone;
  let message = snapshot.applyError;
  if (!message && ["pending", "finalizing"].includes(snapshot.applyStatus)) {
    message = "The approved change is still being applied.";
  } else if (!message && !undoAvailable && snapshot.applyStatus !== "completed") {
    message = `The approved change finished with status ${snapshot.applyStatus}.`;
  }
  return {
    snapshotId: snapshot.id,
    itemId: snapshot.itemId,
    status: snapshot.applyStatus,
    applied: snapshot.applied,
    undoAvailable,
    ...(message ? { message } : {}),
  };
}

async function finalizeUndoSnapshot(snapshot, applyStatus) {
  const agentName = providerName(snapshot.provider ?? "codex");
  if (applyStatus !== "completed") {
    snapshot.applied = false;
    snapshot.applyStatus = applyStatus;
  } else {
    snapshot.applyStatus = "finalizing";
    try {
      const mismatches = [];
      for (const saved of snapshot.files) {
        const current = await safeApprovalPath(snapshot.researchRoot, saved.path, { mustExist: false });
        saved.afterExists = current.exists;
        saved.afterHash = current.exists ? sha256(await fs.readFile(current.path)) : null;
        if (
          saved.afterExists !== saved.expectedAfterExists
          || saved.afterHash !== saved.expectedAfterHash
        ) {
          mismatches.push(relativePortable(snapshot.researchRoot, saved.path));
        }
      }
      snapshot.applied = true;
      if (mismatches.length) {
        snapshot.applyStatus = "completedMismatch";
        snapshot.applyError = `Applied bytes did not match the approved proposal for: ${mismatches.join(", ")}`;
        broadcastAgent(snapshot.threadId, snapshot.turnId, {
          type: "error",
          message: `${agentName} finished writing, but one or more files did not match the approved preview. Undo is available while those files remain unchanged.`,
        });
      } else {
        snapshot.applyStatus = "completed";
      }
    } catch (error) {
      snapshot.applied = false;
      snapshot.applyStatus = "snapshotError";
      snapshot.applyError = error.message;
    }
  }
  const settlement = publicSnapshotStatus(snapshot);
  broadcastAgent(snapshot.threadId, snapshot.turnId, { type: "applyCompleted", ...settlement });
  return settlement;
}

class CodexAppServerClient {
  constructor() {
    this.child = null;
    this.readyPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.generation = 0;
    this.stderrTail = "";
  }

  async ensureReady() {
    if (this.readyPromise) return this.readyPromise;
    const ready = this.#start();
    this.readyPromise = ready;
    ready.catch(() => {
      if (this.readyPromise === ready) this.readyPromise = null;
    });
    return ready;
  }

  async #start() {
    // Prefer the newest locally installed Codex runtime, including the one
    // bundled with the ChatGPT desktop app, while retaining an explicit
    // override for community installations.
    const runtime = await getCodexRuntime();
    const child = spawn(runtime.command, ["app-server", "--listen", "stdio://"], {
      env: subscriptionEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.generation += 1;
    const generation = this.generation;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#receiveLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-32_000);
    });
    child.on("error", (error) => this.#closed(error));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.#closed(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).`));
    });

    const initialized = await this.request(
      "initialize",
      {
        clientInfo: { name: "local-latex-workbench", title: "Local LaTeX Workbench", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      CODEX_REQUEST_TIMEOUT_MS,
      true,
    );
    if (generation !== this.generation) throw new Error("Codex app-server restarted during initialization.");
    this.notify("initialized");
    return initialized;
  }

  request(method, params, timeoutMs = CODEX_REQUEST_TIMEOUT_MS, skipReady = false) {
    return (async () => {
      if (!skipReady) await this.ensureReady();
      if (!this.child?.stdin?.writable) throw new Error("Codex app-server is unavailable.");
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex request ${method} timed out.`));
        }, timeoutMs);
        timer.unref();
        this.pending.set(id, { resolve, reject, timer, method });
        this.#send({ id, method, params });
      });
    })();
  }

  notify(method, params) {
    this.#send(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  respondError(id, message, code = -32601) {
    this.#send({ id, error: { code, message } });
  }

  #send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receiveLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const detail = message.error.message ?? JSON.stringify(message.error);
        pending.reject(new Error(detail));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      handleCodexServerRequest(message).catch((error) => {
        try {
          this.respondError(message.id, error.message, -32603);
        } catch {
          // The process may already have exited.
        }
        const threadId = message.params?.threadId;
        const turnId = message.params?.turnId;
        if (threadId) broadcastAgent(threadId, turnId, { type: "error", message: error.message });
      });
      return;
    }
    if (message.method) handleCodexNotification(message.method, message.params ?? {});
  }

  #closed(error) {
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    if (child?.stdin?.writable) child.stdin.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [requestId, approval] of pendingApprovals) {
      clearTimeout(approval.timeout);
      pendingApprovals.delete(requestId);
    }
    for (const active of [...activeTurns.values()]) {
      const failedTurn = {
        id: active.turnId,
        status: "failed",
        error: { message: error.message },
      };
      turnEvents.emit(turnKey(active.threadId, active.turnId), failedTurn);
      forgetActiveTurn(active.threadId, active.turnId);
    }
    for (const sink of [...agentSinks]) {
      writeNdjson(sink.res, { type: "error", message: error.message });
      if (sink.turnId && activeTurns.has(sink.threadId)) {
        turnEvents.emit(turnKey(sink.threadId, sink.turnId), {
          id: sink.turnId,
          status: "failed",
          error: { message: error.message },
        });
      }
      try {
        if (!sink.res.writableEnded && !sink.res.destroyed) sink.res.end();
      } catch {
        // The HTTP client may have disconnected while app-server was closing.
      }
      agentSinks.delete(sink);
    }
  }

  stop() {
    this.child?.kill("SIGTERM");
  }
}

const codexClient = new CodexAppServerClient();

let codexModelCache = null;

async function getCodexModelCatalog() {
  await codexClient.ensureReady();
  if (
    codexModelCache
    && codexModelCache.generation === codexClient.generation
    && Date.now() - codexModelCache.at < 60_000
  ) {
    return codexModelCache.models;
  }
  const models = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    const params = { limit: 100, includeHidden: true };
    if (cursor) params.cursor = cursor;
    const response = await codexClient.request("model/list", params);
    if (Array.isArray(response.data)) models.push(...response.data);
    const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
      ? response.nextCursor
      : null;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (models.length < 1_000);
  codexModelCache = { at: Date.now(), generation: codexClient.generation, models };
  return models;
}

function publicModelSettings(model) {
  if (!model) return null;
  return {
    model: model.model ?? model.id,
    displayName: model.displayName ?? model.model ?? model.id,
    description: model.description ?? "",
    defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((option) => ({
        reasoningEffort: option.reasoningEffort,
        description: option.description ?? "",
      }))
      : [],
    isDefault: Boolean(model.isDefault),
  };
}

function codexModelSettingsFromCatalog(models, configuredModel, configuredEffort = null) {
  const model = models.find((entry) => entry.model === configuredModel || entry.id === configuredModel)
    ?? models.find((entry) => entry.isDefault && !entry.hidden)
    ?? models.find((entry) => !entry.hidden)
    ?? models[0]
    ?? null;
  const settings = publicModelSettings(model) ?? {
    model: configuredModel,
    displayName: configuredModel,
    description: "",
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    isDefault: false,
  };
  if (configuredEffort) settings.defaultReasoningEffort = configuredEffort;
  return {
    ...settings,
    models: models
      .filter((entry) => !entry.hidden)
      .map(publicModelSettings)
      .filter(Boolean),
  };
}

function resolveCodexModel(models, requestedModel) {
  const model = models.find((entry) => (
    !entry.hidden
    && (entry.model === requestedModel || entry.id === requestedModel)
  ));
  if (!model) {
    throw new HttpError(
      400,
      "That Codex model is not available to the signed-in subscription. Refresh the model list and choose another model.",
      "model_unavailable",
    );
  }
  return model.model ?? model.id;
}

let claudeModelCache = null;

function requestClaudeModelCatalog(researchRoot) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-mode",
      "plan",
      "--setting-sources",
      "",
      "--safe-mode",
      "--no-chrome",
    ];
    let child;
    try {
      child = spawn("claude", args, {
        cwd: researchRoot,
        env: providerEnvironment("claude"),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let stderr = "";
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error("Claude Code model discovery timed out.")), 15_000);
    timer.unref();

    const finish = (error, models = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (!child.killed) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(models);
    };

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) {
        finish(new Error(stderr.trim() || `Claude Code model discovery exited (${code ?? "unknown"}).`));
      }
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (
        message.type !== "control_response"
        || message.response?.request_id !== requestId
      ) return;
      if (message.response.subtype !== "success") {
        finish(new Error(message.response.error || "Claude Code could not return its model catalog."));
        return;
      }
      const models = message.response.response?.models;
      if (!Array.isArray(models)) {
        finish(new Error("Claude Code returned an invalid model catalog."));
        return;
      }
      finish(null, models);
    });
    child.stdin.end(`${JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "initialize" },
    })}\n`);
  });
}

async function getClaudeModelCatalog(researchRoot) {
  if (
    claudeModelCache
    && claudeModelCache.researchRoot === researchRoot
    && Date.now() - claudeModelCache.at < 60_000
  ) return claudeModelCache.models;
  const models = await requestClaudeModelCatalog(researchRoot);
  claudeModelCache = { at: Date.now(), researchRoot, models };
  return models;
}

function claudeModelSettingsFromCatalog(models) {
  const publicModels = models
    .filter((entry) => typeof entry?.value === "string" && entry.value)
    .map((entry, index) => ({
      model: entry.value,
      displayName: entry.displayName ?? entry.value,
      description: entry.description ?? "",
      defaultReasoningEffort: null,
      supportedReasoningEfforts: Array.isArray(entry.supportedEffortLevels)
        ? entry.supportedEffortLevels.map((reasoningEffort) => ({
          reasoningEffort,
          description: `${reasoningEffort} Claude Code effort`,
        }))
        : [],
      isDefault: index === 0,
    }));
  const selected = publicModels[0] ?? null;
  return {
    model: selected?.model ?? null,
    displayName: selected?.displayName ?? "Claude Code subscription model",
    description: selected?.description ?? "Claude Code did not advertise any selectable models.",
    defaultReasoningEffort: selected?.defaultReasoningEffort ?? null,
    supportedReasoningEfforts: selected?.supportedReasoningEfforts ?? [],
    models: publicModels,
  };
}

function resolveClaudeModel(models, requestedModel) {
  const model = models.find((entry) => entry?.value === requestedModel);
  if (!model) {
    throw new HttpError(
      400,
      "That Claude Code model is not in the signed-in CLI's current model picker. Refresh the model list and choose another model.",
      "model_unavailable",
    );
  }
  return model.value;
}

function verifyAcceptedCodexModel(requestedModel, acceptedModel) {
  const normalizedAccepted = typeof acceptedModel === "string" && acceptedModel.trim()
    ? acceptedModel.trim()
    : null;
  if (requestedModel && normalizedAccepted !== requestedModel) {
    throw new HttpError(
      409,
      `Codex accepted ${normalizedAccepted ?? "no model"} instead of the selected ${requestedModel}. No turn was started. Refresh the model list and try again.`,
      "model_mismatch",
    );
  }
  return normalizedAccepted;
}

async function codexSettingsForProject(researchRoot) {
  const [models, configResponse] = await Promise.all([
    getCodexModelCatalog(),
    codexClient.request("config/read", { cwd: researchRoot, includeLayers: false }),
  ]);
  const configuredModel = configResponse.config?.model ?? null;
  return codexModelSettingsFromCatalog(
    models,
    configuredModel,
    configResponse.config?.model_reasoning_effort ?? null,
  );
}

async function agentSettingsForProject(provider, researchRoot) {
  if (provider === "codex") return codexSettingsForProject(researchRoot);
  if (provider === "claude") {
    return claudeModelSettingsFromCatalog(await getClaudeModelCatalog(researchRoot));
  }
  return {
    model: null,
    displayName: "Cursor subscription model",
    description: "Uses the model selected by Cursor for this subscription.",
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    models: [],
  };
}

async function validateCodexModel(modelName) {
  if (!modelName) return null;
  return resolveCodexModel(await getCodexModelCatalog(), modelName);
}

async function validateClaudeModel(modelName, researchRoot) {
  if (!modelName) return null;
  return resolveClaudeModel(await getClaudeModelCatalog(researchRoot), modelName);
}

async function validateClaudeReasoningEffort(modelName, researchRoot, effort) {
  if (!effort) return;
  const models = await getClaudeModelCatalog(researchRoot);
  const model = models.find((entry) => entry?.value === modelName) ?? models[0];
  const supported = Array.isArray(model?.supportedEffortLevels) ? model.supportedEffortLevels : [];
  if (supported.length && !supported.includes(effort)) {
    throw new HttpError(400, `The selected intelligence level is not available for ${model.displayName ?? modelName}.`);
  }
}

async function validateReasoningEffort(modelName, effort) {
  const models = await getCodexModelCatalog();
  const model = models.find((entry) => entry.model === modelName || entry.id === modelName);
  if (!model || !Array.isArray(model.supportedReasoningEfforts)) return;
  const supported = model.supportedReasoningEfforts.map((option) => option.reasoningEffort).filter(Boolean);
  if (supported.length && !supported.includes(effort)) {
    throw new HttpError(400, `The selected intelligence level is not available for ${model.displayName ?? modelName}.`);
  }
}

function handleCodexNotification(method, params) {
  const { threadId, turnId } = params;
  const notificationTurnId = turnId ?? params.turn?.id;
  if (method === "serverRequest/resolved") {
    const requestId = String(params.requestId);
    const pending = pendingApprovals.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingApprovals.delete(requestId);
      broadcastAgent(pending.params.threadId, pending.params.turnId, {
        type: "approvalResolved",
        requestId,
        approvalType: pending.approvalType ?? "file",
      });
    }
    return;
  }
  if (method !== "turn/completed") touchActiveTurn(threadId, notificationTurnId);
  if (method === "thread/settings/updated") {
    const settings = params.threadSettings ?? {};
    const session = agentSessions.get(threadId);
    if (session) {
      if (typeof settings.model === "string" && settings.model) session.model = settings.model;
      session.reasoningEffort = settings.effort ?? null;
    }
    broadcastAgent(threadId, turnId, {
      type: "settings",
      provider: "codex",
      model: settings.model ?? session?.model ?? null,
      reasoningEffort: settings.effort ?? session?.reasoningEffort ?? null,
      modelConfirmed: true,
      runtime: "Codex app-server",
    });
    return;
  }
  if (method === "model/rerouted") {
    broadcastAgent(threadId, turnId, {
      type: "settings",
      provider: "codex",
      model: params.toModel ?? null,
      requestedModel: params.fromModel ?? null,
      reasoningEffort: agentSessions.get(threadId)?.reasoningEffort ?? null,
      modelConfirmed: true,
      modelRerouted: true,
      runtime: "Codex app-server",
    });
    return;
  }
  if (method === "item/agentMessage/delta") {
    recordAgentMessage(threadId, turnId, { id: params.itemId }, params.delta ?? "");
    return;
  }
  if (method === "turn/diff/updated") {
    latestTurnDiffs.set(turnKey(threadId, turnId), params.diff ?? "");
    broadcastAgent(threadId, turnId, { type: "diff", diff: params.diff ?? "" });
    return;
  }
  if (method === "item/fileChange/patchUpdated") {
    fileItems.set(itemKey(threadId, turnId, params.itemId), params.changes ?? []);
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    const item = params.item;
    if (item?.type === "agentMessage") recordAgentMessage(threadId, turnId, item);
    if (item?.type === "fileChange") {
      fileItems.set(itemKey(threadId, turnId, item.id), item.changes ?? []);
      if (method === "item/completed") {
        const snapshotId = snapshotsByItem.get(itemKey(threadId, turnId, item.id));
        const snapshot = snapshotId ? undoSnapshots.get(snapshotId) : null;
        if (snapshot) {
          const finalization = finalizeUndoSnapshot(snapshot, item.status).catch((error) => {
            snapshot.applied = false;
            snapshot.applyStatus = "snapshotError";
            snapshot.applyError = error.message;
            const settlement = publicSnapshotStatus(snapshot);
            broadcastAgent(threadId, turnId, { type: "applyCompleted", ...settlement });
          });
          trackTurnFinalization(threadId, turnId, finalization);
        }
      }
    }
    const label = statusForItem(item);
    if (method === "item/started" && label) {
      touchActiveTurn(threadId, turnId, { label });
      broadcastAgent(threadId, turnId, { type: "status", label });
    }
    return;
  }
  if (method === "turn/started") {
    touchActiveTurn(threadId, notificationTurnId, { status: "inProgress", label: "Codex is working…" });
    broadcastAgent(threadId, notificationTurnId, { type: "status", label: "Codex is working…" });
    return;
  }
  if (method === "turn/completed") {
    for (const item of params.turn?.items ?? []) {
      if (item.type === "agentMessage") recordAgentMessage(threadId, params.turn.id, item);
    }
    if (threadId && params.turn?.id) {
      const terminalKey = turnKey(threadId, params.turn.id);
      terminalTurns.set(terminalKey, params.turn);
      const terminalExpiry = setTimeout(() => terminalTurns.delete(terminalKey), 60_000);
      terminalExpiry.unref();
    }
    touchActiveTurn(threadId, params.turn?.id, {
      status: params.turn?.status ?? "completed",
      label: params.turn?.status === "interrupted" ? "Stopped" : "Finishing…",
    });
    for (const approval of pendingApprovalsFor(threadId, params.turn?.id)) {
      clearTimeout(approval.timeout);
      pendingApprovals.delete(approval.requestId);
    }
    forgetActiveTurn(threadId, params.turn?.id);
    completeTurnAfterFinalization(threadId, params.turn);
    return;
  }
  if (method === "error" || method === "warning") {
    const message = params.message ?? params.error?.message ?? "Codex reported an error.";
    if (threadId) broadcastAgent(threadId, turnId, { type: "error", message });
  }
}

async function pathsForFileApproval(session, params) {
  const key = itemKey(params.threadId, params.turnId, params.itemId);
  for (let attempt = 0; attempt < 8 && !fileItems.has(key); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const changes = fileItems.get(key) ?? [];
  const targets = [];
  for (const change of changes) {
    if (!change?.path) continue;
    targets.push({ value: change.path, role: "path" });
    if (change.kind?.type === "update" && change.kind.move_path) {
      targets.push({ value: change.kind.move_path, role: "move_path" });
    }
  }
  const unique = new Map();
  for (const target of targets) {
    const resolved = await safeApprovalPath(session.researchRoot, target.value, { mustExist: false });
    unique.set(resolved.path, resolved);
  }
  return { changes, paths: [...unique.values()] };
}

async function materializeReviewFiles(session, changes) {
  const agentName = providerName(session.provider ?? "codex");
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new HttpError(403, "The requested file changes could not be materialized.");
  }
  if (changes.length > MAX_REVIEW_FILES) {
    throw new HttpError(413, `A single proposal may change at most ${MAX_REVIEW_FILES} files.`);
  }

  const files = [];
  const reviewGuards = new Map();
  const expectedAfter = new Map();
  const claimedTargets = new Map();
  let reviewBytes = 0;

  const accountBytes = (count) => {
    reviewBytes += count;
    if (reviewBytes > MAX_REVIEW_BYTES) {
      throw new HttpError(413, "The proposed source review is too large to materialize safely.");
    }
  };

  const claimTarget = (absolutePath, role) => {
    const previous = claimedTargets.get(absolutePath);
    if (previous) {
      throw new HttpError(409, `The proposal targets ${relativePortable(session.researchRoot, absolutePath)} more than once (${previous} and ${role}).`);
    }
    claimedTargets.set(absolutePath, role);
  };

  const guardTarget = (resolved, buffer = null) => {
    const displayPath = relativePortable(session.researchRoot, resolved.path);
    reviewGuards.set(resolved.path, {
      path: displayPath,
      absolutePath: resolved.path,
      exists: resolved.exists,
      hash: resolved.exists ? sha256(buffer) : null,
    });
  };

  const expectTarget = (resolved, exists, buffer = null) => {
    expectedAfter.set(resolved.path, {
      path: relativePortable(session.researchRoot, resolved.path),
      absolutePath: resolved.path,
      exists,
      hash: exists ? sha256(buffer) : null,
    });
  };

  for (const change of changes) {
    if (!change?.path) continue;
    const kind = change.kind?.type ?? "update";
    if (!["add", "update", "delete"].includes(kind)) {
      throw new HttpError(400, `${agentName} proposed an unsupported file-change kind.`);
    }
    const resolved = await safeApprovalPath(session.researchRoot, change.path, { mustExist: false });
    if (kind === "add" && resolved.exists) {
      throw new HttpError(409, `${relativePortable(session.researchRoot, resolved.path)} already exists but the proposal treats it as a new file.`);
    }
    if (kind !== "add" && !resolved.exists) {
      throw new HttpError(409, `${relativePortable(session.researchRoot, resolved.path)} no longer exists. Ask ${agentName} to prepare a fresh change.`);
    }

    claimTarget(resolved.path, "source");
    const sourceFile = resolved.exists
      ? await readTextFile(session.researchRoot, resolved.path)
      : null;
    if (sourceFile && sourceFile.stat.nlink > 1) {
      throw new HttpError(403, "Agent write targets may not be hard-linked files.");
    }
    const before = sourceFile?.content ?? "";
    const beforeBuffer = sourceFile?.buffer ?? Buffer.alloc(0);
    guardTarget(resolved, beforeBuffer);

    const originalDiff = change.diff ?? "";
    if (typeof originalDiff !== "string") {
      throw new HttpError(400, `${agentName} returned an invalid file patch.`);
    }
    accountBytes(beforeBuffer.length + Buffer.byteLength(originalDiff, "utf8"));

    let after;
    if (kind === "delete") {
      after = "";
    } else if (originalDiff) {
      let patched;
      try {
        patched = applyPatch(before, originalDiff, { fuzzFactor: 0 });
      } catch {
        patched = false;
      }
      if (typeof patched !== "string") {
        throw new HttpError(422, `The proposed patch for ${relativePortable(session.researchRoot, resolved.path)} could not be applied exactly to the reviewed source.`);
      }
      after = patched;
    } else {
      // Empty-file additions and pure moves legitimately have no text hunk.
      after = before;
    }

    const afterBuffer = Buffer.from(after, "utf8");
    if (afterBuffer.length > MAX_TEXT_BYTES) {
      throw new HttpError(413, `The proposed source for ${relativePortable(session.researchRoot, resolved.path)} is too large.`);
    }
    accountBytes(afterBuffer.length);

    const displayPath = relativePortable(session.researchRoot, resolved.path);
    let movePath = null;
    if (kind === "update" && change.kind?.move_path) {
      const moved = await safeApprovalPath(session.researchRoot, change.kind.move_path, { mustExist: false });
      if (moved.path !== resolved.path) {
        if (moved.exists) {
          throw new HttpError(409, `The move destination ${relativePortable(session.researchRoot, moved.path)} already exists.`);
        }
        claimTarget(moved.path, "move destination");
        guardTarget(moved);
        movePath = relativePortable(session.researchRoot, moved.path);
        expectTarget(resolved, false);
        expectTarget(moved, true, afterBuffer);
      }
    } else if (change.kind?.move_path) {
      throw new HttpError(400, "Only update changes may include a move destination.");
    }

    if (!movePath) {
      expectTarget(resolved, kind !== "delete", kind === "delete" ? null : afterBuffer);
    }
    files.push({
      path: displayPath,
      kind,
      movePath,
      before,
      after,
      beforeExists: resolved.exists,
      beforeHash: resolved.exists ? sha256(beforeBuffer) : null,
      originalDiff,
      reviewDiff: createTwoFilesPatch(
        displayPath,
        movePath ?? displayPath,
        before,
        after,
        "current",
        "proposed",
      ),
    });
  }
  if (files.length === 0) throw new HttpError(403, "The requested file changes could not be materialized.");
  return {
    files,
    reviewGuards: [...reviewGuards.values()],
    expectedAfter: [...expectedAfter.values()],
  };
}

function publicReviewFiles(files) {
  return files.map(({ path: filePath, kind, movePath, before, after, reviewDiff }) => ({
    path: filePath,
    kind,
    movePath,
    before,
    after,
    reviewDiff,
  }));
}

function publicPendingApproval(pending) {
  if (!pending) return null;
  const provider = pending.session.provider ?? "codex";
  return {
    requestId: pending.requestId,
    itemId: pending.params.itemId,
    approvalType: pending.approvalType ?? "file",
    provider,
    agentName: providerName(provider),
    reason: pending.params.reason ?? `${providerName(provider)} wants to update the research workspace.`,
    diff: pending.diff,
    files: publicReviewFiles(pending.reviewFiles ?? []),
    ...(pending.writePaths ? { writePaths: pending.writePaths } : {}),
    ...(pending.writeTargets ? { writeTargets: pending.writeTargets } : {}),
    expiresAt: pending.expiresAt,
  };
}

function pendingApprovalFor(threadId, turnId) {
  return pendingApprovalsFor(threadId, turnId)[0] ?? null;
}

function pendingApprovalsFor(threadId, turnId) {
  return [...pendingApprovals.values()].filter((pending) => {
    if (threadId && pending.params.threadId !== threadId) return false;
    if (turnId && pending.params.turnId !== turnId) return false;
    return true;
  });
}

async function assertTextTargets(paths) {
  for (const target of paths) {
    if (!target.exists) continue;
    const stat = await fs.stat(target.path);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) {
      throw new HttpError(415, "Codex proposed changing a non-text or oversized source file; the change was declined.");
    }
    const buffer = await fs.readFile(target.path);
    if (buffer.includes(0)) throw new HttpError(415, "Codex proposed changing a binary source file; the change was declined.");
    try {
      utf8Decoder.decode(buffer);
    } catch {
      throw new HttpError(415, "Codex proposed changing a non-UTF-8 source file; the change was declined.");
    }
  }
}

async function assertPermissionDirectorySafe(directory) {
  let scanned = 0;
  const visit = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_PERMISSION_SCAN_ENTRIES) {
        throw new HttpError(413, "The requested output folder is too broad; ask for a smaller output folder.");
      }
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new HttpError(403, "Research output folders may not contain symbolic links.");
      }
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!entry.isFile()) {
        throw new HttpError(403, "Research output folders may contain only ordinary files and folders.");
      }
      const stat = await fs.lstat(target);
      if (stat.nlink > 1) {
        throw new HttpError(403, "Research output folders may not contain hard-linked files.");
      }
    }
  };
  await visit(directory);
}

async function permissionsForResearchRequest(session, params) {
  const requested = params?.permissions ?? {};
  if (requested.network?.enabled) {
    throw new HttpError(403, "Network access remains disabled in the local paper workbench.");
  }

  const cwd = await canonicalDirectory(params.cwd, "permission cwd");
  if (!isWithin(session.researchRoot, cwd)) {
    throw new HttpError(403, "Codex requested command access outside the research workspace.");
  }

  const fileSystem = requested.fileSystem ?? {};
  const requestedPaths = [];
  if (fileSystem.entries != null) {
    if (!Array.isArray(fileSystem.entries)) throw new HttpError(400, "Requested filesystem entries are invalid.");
    for (const entry of fileSystem.entries) {
      if (entry?.access !== "write") continue;
      if (entry.path?.type !== "path") {
        throw new HttpError(403, "Codex requested a write pattern that cannot be confined to one research path.");
      }
      requestedPaths.push(entry.path.path);
    }
  }
  if (fileSystem.write != null) {
    if (!Array.isArray(fileSystem.write)) throw new HttpError(400, "Requested write paths are invalid.");
    requestedPaths.push(...fileSystem.write);
  }
  if (requestedPaths.length === 0) {
    throw new HttpError(403, "Codex did not request a verifiable research output path.");
  }
  if (requestedPaths.length > 32) {
    throw new HttpError(413, "Codex requested too many research output paths at once.");
  }

  const granted = new Map();
  for (const requestedPath of requestedPaths) {
    assertString(requestedPath, "requested write path", { maxLength: 16_384 });
    if (!path.isAbsolute(requestedPath)) {
      throw new HttpError(403, "Codex must request an absolute research output folder.");
    }
    const resolved = await safeApprovalPath(session.researchRoot, requestedPath, { mustExist: false });
    if (isWithin(resolved.path, session.paperRoot)) {
      throw new HttpError(
        403,
        "Direct command writes may not target the paper folder or an ancestor containing it.",
      );
    }
    let create = false;
    if (resolved.exists) {
      const stat = await fs.stat(resolved.path);
      if (!stat.isDirectory()) {
        throw new HttpError(
          403,
          "Codex must request the smallest containing output folder, not an individual file.",
        );
      }
      await assertPermissionDirectorySafe(resolved.path);
    } else {
      if (path.extname(resolved.path)) {
        throw new HttpError(
          403,
          "A new output file needs its containing folder to be approved instead.",
        );
      }
      create = true;
    }
    granted.set(resolved.path, { path: resolved.path, kind: "directory", create });
  }

  const targets = [...granted.values()];
  return {
    permissions: {
      fileSystem: {
        entries: targets.map(({ path: grantedPath }) => ({
          access: "write",
          path: { type: "path", path: grantedPath },
        })),
      },
    },
    writePaths: targets.map(({ path: grantedPath }) => relativePortable(session.researchRoot, grantedPath)),
    writeTargets: targets.map(({ path: grantedPath, kind }) => ({
      path: relativePortable(session.researchRoot, grantedPath),
      kind,
    })),
    permissionTargets: targets,
  };
}

async function preparePermissionGrant(pending) {
  const created = [];
  try {
    for (const target of pending.permissionTargets ?? []) {
      let resolved = await safeApprovalPath(pending.session.researchRoot, target.path, { mustExist: false });
      if (isWithin(resolved.path, pending.session.paperRoot)) {
        throw new HttpError(403, "The requested output folder now overlaps the paper folder boundary.");
      }
      if (!resolved.exists) {
        if (!target.create) {
          throw new HttpError(409, "An approved output folder disappeared; ask Codex to request it again.");
        }
        await fs.mkdir(resolved.path, { mode: 0o700 });
        created.push(resolved.path);
        resolved = await safeApprovalPath(pending.session.researchRoot, target.path, { mustExist: true });
      }
      const stat = await fs.stat(resolved.path);
      if (!stat.isDirectory()) {
        throw new HttpError(409, "An approved output folder is no longer a folder.");
      }
      await assertPermissionDirectorySafe(resolved.path);
    }
    return created;
  } catch (error) {
    for (const directory of created.reverse()) {
      await fs.rmdir(directory).catch(() => {});
    }
    throw error;
  }
}

function rejectedApprovalResult(pending, cancel = false) {
  if (pending.approvalType === "permission") {
    return { permissions: {}, scope: "turn" };
  }
  return { decision: cancel ? "cancel" : "decline" };
}

function resolveExternalApproval(pending, result) {
  const waiter = externalApprovalWaiters.get(pending.requestId);
  if (!waiter) return;
  externalApprovalWaiters.delete(pending.requestId);
  waiter.resolve(result);
}

function armApprovalTimeout(pending) {
  if (pending.timeout) clearTimeout(pending.timeout);
  const remaining = Math.max(0, pending.expiresAt - Date.now());
  pending.timeout = setTimeout(() => {
    if (pendingApprovals.get(pending.requestId) !== pending || pending.resolving) return;
    pendingApprovals.delete(pending.requestId);
    if (pending.source === "external") {
      resolveExternalApproval(pending, { decision: "decline", expired: true });
    } else {
      try {
        codexClient.respond(pending.rpcId, rejectedApprovalResult(pending));
      } catch {
        // The app-server may have exited at the same time as the approval expired.
      }
    }
    broadcastAgent(pending.params.threadId, pending.params.turnId, {
      type: "error",
      message: "The approval request expired.",
    });
  }, remaining);
  pending.timeout.unref();
}

async function handleCodexServerRequest(message) {
  const params = message.params ?? {};
  const session = agentSessions.get(params.threadId);
  touchActiveTurn(params.threadId, params.turnId);
  if (message.method === "item/permissions/requestApproval") {
    if (!session) {
      codexClient.respond(message.id, { permissions: {}, scope: "turn" });
      return;
    }
    let grant;
    try {
      grant = await permissionsForResearchRequest(session, params);
    } catch (error) {
      codexClient.respond(message.id, { permissions: {}, scope: "turn" });
      broadcastAgent(params.threadId, params.turnId, { type: "error", message: error.message });
      return;
    }

    const requestId = String(message.id);
    const pending = {
      requestId,
      rpcId: message.id,
      approvalType: "permission",
      params,
      session,
      grantedPermissions: grant.permissions,
      writePaths: grant.writePaths,
      writeTargets: grant.writeTargets,
      permissionTargets: grant.permissionTargets,
      reviewFiles: [],
      diff: "",
      createdAt: Date.now(),
      expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      resolving: false,
      timeout: null,
    };
    pendingApprovals.set(requestId, pending);
    armApprovalTimeout(pending);
    touchActiveTurn(params.threadId, params.turnId, { label: "Waiting for research access approval" });
    broadcastAgent(params.threadId, params.turnId, {
      type: "approval",
      requestId,
      itemId: params.itemId,
      approvalType: "permission",
      reason: params.reason ?? "Codex wants to run code that writes research-support files.",
      writePaths: grant.writePaths,
      writeTargets: grant.writeTargets,
      files: [],
      diff: "",
    });
    return;
  }
  if (message.method !== "item/fileChange/requestApproval") {
    // A read-only paper agent never needs an elevated shell command, broader
    // permission, client-side tool, or interactive elicitation. Respond with
    // the protocol-specific safe value so app-server never waits indefinitely.
    if (message.method === "item/commandExecution/requestApproval") {
      codexClient.respond(message.id, { decision: "decline" });
    } else if (message.method === "item/tool/requestUserInput") {
      codexClient.respond(message.id, { answers: {} });
    } else if (message.method === "mcpServer/elicitation/request") {
      codexClient.respond(message.id, { action: "decline" });
    } else if (message.method === "item/tool/call") {
      codexClient.respond(message.id, {
        success: false,
        contentItems: [{ type: "inputText", text: "Client-side tools are disabled in the paper workbench." }],
      });
    } else if (message.method === "currentTime/read") {
      codexClient.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
      return;
    } else {
      codexClient.respondError(message.id, "This client request is not supported.");
    }
    if (params.threadId) {
      broadcastAgent(params.threadId, params.turnId, {
        type: "status",
        label: "An out-of-scope permission request was declined.",
      });
    }
    return;
  }
  if (!session) {
    codexClient.respond(message.id, { decision: "decline" });
    return;
  }

  let approvalTargets;
  let reviewFiles;
  try {
    approvalTargets = await pathsForFileApproval(session, params);
    if (approvalTargets.paths.length === 0) throw new HttpError(403, "The requested file targets could not be verified.");
    await assertTextTargets(approvalTargets.paths);
    const materialized = await materializeReviewFiles(session, approvalTargets.changes);
    reviewFiles = materialized.files;
    approvalTargets.reviewGuards = materialized.reviewGuards;
    approvalTargets.expectedAfter = materialized.expectedAfter;
    if (params.grantRoot) {
      throw new HttpError(403, "Session-wide write grants are disabled; each source change requires its own approval.");
    }
  } catch (error) {
    codexClient.respond(message.id, { decision: "decline" });
    broadcastAgent(params.threadId, params.turnId, { type: "error", message: error.message });
    return;
  }

  const requestId = String(message.id);
  const diff = approvalTargets.changes.map((change) => change.diff).filter(Boolean).join("\n")
    || latestTurnDiffs.get(turnKey(params.threadId, params.turnId))
    || "";
  const pending = {
    requestId,
    rpcId: message.id,
    approvalType: "file",
    params,
    session,
    paths: approvalTargets.paths,
    changes: approvalTargets.changes,
    reviewFiles,
    reviewGuards: approvalTargets.reviewGuards,
    expectedAfter: approvalTargets.expectedAfter,
    diff,
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
    resolving: false,
    timeout: null,
  };
  pendingApprovals.set(requestId, pending);
  armApprovalTimeout(pending);
  touchActiveTurn(params.threadId, params.turnId, { label: "Waiting for your review" });
  broadcastAgent(params.threadId, params.turnId, {
    type: "approval",
    requestId,
    itemId: params.itemId,
    approvalType: "file",
    reason: params.reason ?? "Codex wants to update the research workspace.",
    diff,
    files: publicReviewFiles(reviewFiles),
  });
}

async function createUndoSnapshot(pending) {
  const agentName = providerName(pending.session.provider ?? "codex");
  if (!Array.isArray(pending.reviewGuards) || !Array.isArray(pending.expectedAfter)) {
    throw new HttpError(409, `The reviewed filesystem state is unavailable. Ask ${agentName} to prepare a fresh change.`);
  }
  const expectedByPath = new Map(pending.expectedAfter.map((entry) => [entry.absolutePath, entry]));
  const requestedPaths = new Set(pending.paths.map((entry) => entry.path));
  if (
    pending.reviewGuards.length !== requestedPaths.size
    || pending.expectedAfter.length !== requestedPaths.size
    || expectedByPath.size !== requestedPaths.size
  ) {
    throw new HttpError(409, "The proposed target set changed while it was being reviewed.");
  }

  const files = [];
  const revalidated = [];
  const seen = new Set();
  for (const guard of pending.reviewGuards) {
    if (
      !guard?.absolutePath
      || seen.has(guard.absolutePath)
      || !requestedPaths.has(guard.absolutePath)
    ) {
      throw new HttpError(409, "The proposed target set changed while it was being reviewed.");
    }
    seen.add(guard.absolutePath);
    const expected = expectedByPath.get(guard.absolutePath);
    if (!expected) throw new HttpError(409, "The approved output state is incomplete.");

    const current = await safeApprovalPath(
      pending.session.researchRoot,
      guard.absolutePath,
      { mustExist: false },
    );
    if (current.path !== guard.absolutePath || !isWithin(pending.session.researchRoot, current.path)) {
      throw new HttpError(403, "A reviewed file left the research workspace.");
    }
    if (current.exists !== guard.exists) {
      throw new HttpError(409, `${guard.path} changed while the proposal was open. Ask ${agentName} to prepare a fresh change.`);
    }
    revalidated.push(current);

    if (!current.exists) {
      files.push({
        path: current.path,
        existed: false,
        bytes: Buffer.alloc(0),
        content: "",
        mode: null,
        expectedAfterExists: expected.exists,
        expectedAfterHash: expected.hash,
      });
      continue;
    }
    const { resolved, content, stat, buffer } = await readTextFile(
      pending.session.researchRoot,
      current.path,
    );
    if (resolved.path !== guard.absolutePath || stat.nlink > 1) {
      throw new HttpError(403, "Agent write targets may not be symbolic or hard-linked files.");
    }
    if (sha256(buffer) !== guard.hash) {
      throw new HttpError(409, `${guard.path} changed while the proposal was open. Ask ${agentName} to prepare a fresh change.`);
    }
    files.push({
      path: current.path,
      existed: true,
      bytes: Buffer.from(buffer),
      content,
      mode: stat.mode & 0o777,
      expectedAfterExists: expected.exists,
      expectedAfterHash: expected.hash,
    });
  }
  pending.paths = revalidated;
  const snapshot = {
    id: randomUUID(),
    researchRoot: pending.session.researchRoot,
    paperRoot: pending.session.paperRoot,
    threadId: pending.params.threadId,
    turnId: pending.params.turnId,
    itemId: pending.params.itemId,
    provider: pending.session.provider ?? "codex",
    createdAt: Date.now(),
    files,
    applied: false,
    applyStatus: "pending",
    undone: false,
  };
  undoSnapshots.set(snapshot.id, snapshot);
  undoOrder.push(snapshot.id);
  snapshotsByItem.set(itemKey(snapshot.threadId, snapshot.turnId, snapshot.itemId), snapshot.id);
  while (undoOrder.length > 100) {
    const oldest = undoOrder.shift();
    if (oldest) undoSnapshots.delete(oldest);
  }
  return snapshot;
}

function discardUndoSnapshot(snapshot) {
  if (!snapshot) return;
  undoSnapshots.delete(snapshot.id);
  const orderIndex = undoOrder.indexOf(snapshot.id);
  if (orderIndex >= 0) undoOrder.splice(orderIndex, 1);
  const key = itemKey(snapshot.threadId, snapshot.turnId, snapshot.itemId);
  if (snapshotsByItem.get(key) === snapshot.id) snapshotsByItem.delete(key);
}

async function restoreSnapshotFiles(snapshot) {
  for (const saved of snapshot.files) {
    const checked = await safeApprovalPath(snapshot.researchRoot, saved.path, { mustExist: false });
    if (checked.path !== saved.path) throw new Error("A rollback target now uses a link.");
    if (saved.existed) {
      const tempPath = `${saved.path}.agent-rollback-${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, saved.bytes, { flag: "wx", mode: saved.mode ?? 0o600 });
      try {
        if (saved.mode != null) await fs.chmod(tempPath, saved.mode);
        await fs.rename(tempPath, saved.path);
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
    } else if (checked.exists) {
      await fs.unlink(saved.path);
    }
  }
}

async function applyExternalApproval(pending, snapshot) {
  const root = pending.session.researchRoot;
  const savedByPath = new Map(snapshot.files.map((saved) => [saved.path, saved]));
  const staged = [];
  try {
    for (const file of pending.reviewFiles) {
      const target = await safeApprovalPath(root, file.path, { mustExist: false });
      if (file.movePath) throw new HttpError(400, "Alternate providers cannot propose file moves.");
      const saved = savedByPath.get(target.path);
      if (!saved) throw new HttpError(409, "The approved proposal target set changed.");
      if (file.kind === "delete") {
        staged.push({ target: target.path, kind: "delete", tempPath: null });
        continue;
      }
      const tempPath = `${target.path}.agent-apply-${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, Buffer.from(file.after, "utf8"), {
        flag: "wx",
        mode: saved.mode ?? 0o600,
      });
      staged.push({ target: target.path, kind: file.kind, tempPath });
    }

    // Recheck every target after staging and before the first mutation.
    for (const saved of snapshot.files) {
      const current = await safeApprovalPath(root, saved.path, { mustExist: false });
      if (current.path !== saved.path || current.exists !== saved.existed) {
        throw new HttpError(409, "A reviewed file changed before the proposal could be applied.");
      }
      if (current.exists) {
        const stat = await fs.lstat(current.path);
        if (stat.isSymbolicLink() || stat.nlink > 1 || sha256(await fs.readFile(current.path)) !== sha256(saved.bytes)) {
          throw new HttpError(409, "A reviewed file changed before the proposal could be applied.");
        }
      }
    }

    for (const item of staged) {
      if (item.kind === "delete") await fs.unlink(item.target);
      else await fs.rename(item.tempPath, item.target);
      item.tempPath = null;
    }
    return await finalizeUndoSnapshot(snapshot, "completed");
  } catch (error) {
    for (const item of staged) {
      if (item.tempPath) await fs.unlink(item.tempPath).catch(() => {});
    }
    try {
      await restoreSnapshotFiles(snapshot);
    } catch (rollbackError) {
      snapshot.applied = false;
      snapshot.applyStatus = "rollbackError";
      snapshot.applyError = `Apply failed and rollback was incomplete: ${rollbackError.message}`;
      throw new HttpError(500, snapshot.applyError, "rollback_failed");
    }
    snapshot.applied = false;
    snapshot.applyStatus = "applyError";
    snapshot.applyError = error.message;
    throw error;
  }
}

async function decideApproval(body) {
  const requestId = assertString(body.requestId, "requestId", { maxLength: 256 });
  if (!["accept", "decline", "cancel"].includes(body.decision)) {
    throw new HttpError(400, "decision must be accept, decline, or cancel.");
  }
  const pending = pendingApprovals.get(requestId);
  if (!pending) throw new HttpError(404, "Approval request not found or already resolved.");
  if (pending.resolving) throw new HttpError(409, "This approval request is already being resolved.");
  pending.resolving = true;
  clearTimeout(pending.timeout);
  pending.timeout = null;

  let snapshot = null;
  let responseAttempted = false;
  try {
    const roots = await canonicalRoots(body.researchRoot, body.paperRoot);
    if (roots.researchRoot !== pending.session.researchRoot || roots.paperRoot !== pending.session.paperRoot) {
      throw new HttpError(403, "Approval does not belong to the selected project.");
    }
    if (Date.now() >= pending.expiresAt) {
      throw new HttpError(409, `The approval expired. Ask ${providerName(pending.session.provider ?? "codex")} to prepare a fresh request.`);
    }

    const permissionApproval = pending.approvalType === "permission";
    if (body.decision === "accept" && !permissionApproval) snapshot = await createUndoSnapshot(pending);

    const terminalKey = turnKey(pending.params.threadId, pending.params.turnId);
    const externalApproval = pending.source === "external";
    const requestIsCurrent = pendingApprovals.get(requestId) === pending
      && !terminalTurns.has(terminalKey)
      && (externalApproval || pending.session.generation === codexClient.generation);
    if (!requestIsCurrent) {
      if (pendingApprovals.get(requestId) === pending) {
        clearTimeout(pending.timeout);
        pendingApprovals.delete(requestId);
      }
      throw new HttpError(409, "This review is no longer attached to an active agent turn.");
    }

    if (externalApproval) {
      if (permissionApproval) throw new HttpError(400, "Alternate providers do not request direct write permissions.");
      if (body.decision === "accept") await applyExternalApproval(pending, snapshot);
      responseAttempted = true;
      pendingApprovals.delete(requestId);
      resolveExternalApproval(pending, { decision: body.decision, snapshotId: snapshot?.id ?? null });
      return {
        ok: true,
        approvalType: "file",
        decision: body.decision,
        snapshotId: snapshot?.id ?? null,
      };
    }

    if (permissionApproval && body.decision === "accept") {
      await preparePermissionGrant(pending);
    }

    responseAttempted = true;
    codexClient.respond(
      pending.rpcId,
      permissionApproval
        ? {
            permissions: body.decision === "accept" ? pending.grantedPermissions : {},
            scope: "turn",
          }
        : { decision: body.decision },
    );
    pendingApprovals.delete(requestId);
    return {
      ok: true,
      approvalType: permissionApproval ? "permission" : "file",
      decision: body.decision,
      snapshotId: snapshot?.id ?? null,
    };
  } catch (error) {
    discardUndoSnapshot(snapshot);
    if (pendingApprovals.get(requestId) === pending) {
      const canRetry = !responseAttempted
        && (pending.source === "external" || pending.session.generation === codexClient.generation)
        && !terminalTurns.has(turnKey(pending.params.threadId, pending.params.turnId));
      if (canRetry) {
        pending.resolving = false;
        armApprovalTimeout(pending);
      } else {
        clearTimeout(pending.timeout);
        pendingApprovals.delete(requestId);
      }
    }
    throw error;
  }
}

async function agentTurnStatus(body) {
  const roots = await canonicalRoots(body.researchRoot, body.paperRoot);
  let provider;
  try {
    provider = normalizeProvider(body.provider);
  } catch (error) {
    throw new HttpError(error.status ?? 400, error.message, error.code ?? "unsupported_provider");
  }
  let requestedThreadId = body.threadId == null || body.threadId === ""
    ? null
    : assertString(body.threadId, "threadId", { maxLength: 256 });
  const redirect = provider === "codex" ? sessionRedirects.get(requestedThreadId) : null;
  if (redirect?.researchRoot === roots.researchRoot && redirect?.paperRoot === roots.paperRoot) {
    requestedThreadId = redirect.threadId;
  }

  let active = requestedThreadId ? activeTurns.get(requestedThreadId) ?? null : null;
  if (!requestedThreadId) {
    active = [...activeTurns.values()]
      .filter((candidate) => (
        candidate.researchRoot === roots.researchRoot
        && candidate.paperRoot === roots.paperRoot
        && (candidate.provider ?? "codex") === provider
      ))
      .sort((left, right) => right.startedAt - left.startedAt)[0] ?? null;
  }
  if (
    active
    && (
      active.researchRoot !== roots.researchRoot
      || active.paperRoot !== roots.paperRoot
      || (active.provider ?? "codex") !== provider
    )
  ) {
    active = null;
  }

  const approval = requestedThreadId || active
    ? pendingApprovalFor(requestedThreadId ?? active.threadId, active?.turnId)
    : [...pendingApprovals.values()].find((candidate) => (
      candidate.session.researchRoot === roots.researchRoot
      && candidate.session.paperRoot === roots.paperRoot
      && (candidate.session.provider ?? "codex") === provider
    )) ?? null;
  const scopedApproval = approval
    && approval.session.researchRoot === roots.researchRoot
    && approval.session.paperRoot === roots.paperRoot
    && (approval.session.provider ?? "codex") === provider
    ? approval
    : null;
  const recoveredTurn = active ?? (scopedApproval ? {
    threadId: scopedApproval.params.threadId,
    turnId: scopedApproval.params.turnId,
    status: "inProgress",
    label: "Waiting for your review",
    startedAt: scopedApproval.createdAt,
    lastActivityAt: scopedApproval.createdAt,
    provider,
  } : null);
  const transcript = provider === "codex" ? agentMessages.get(requestedThreadId ?? recoveredTurn?.threadId) : null;
  const messages = transcript?.researchRoot === roots.researchRoot && transcript?.paperRoot === roots.paperRoot
    ? [...transcript.messages.values()]
    : [];

  return {
    ok: true,
    active: Boolean(recoveredTurn),
    turn: publicActiveTurn(recoveredTurn),
    approval: publicPendingApproval(scopedApproval),
    ...(messages.length ? { messages } : {}),
  };
}

async function stopAgentTurn(body) {
  const roots = await canonicalRoots(body.researchRoot, body.paperRoot);
  let provider;
  try {
    provider = normalizeProvider(body.provider);
  } catch (error) {
    throw new HttpError(error.status ?? 400, error.message, error.code ?? "unsupported_provider");
  }
  const suppliedThreadId = body.threadId == null || body.threadId === ""
    ? null
    : assertString(body.threadId, "threadId", { maxLength: 256 });
  let active = suppliedThreadId ? activeTurns.get(suppliedThreadId) ?? null : null;
  if (!suppliedThreadId) {
    active = [...activeTurns.values()]
      .filter((candidate) => (
        candidate.researchRoot === roots.researchRoot
        && candidate.paperRoot === roots.paperRoot
        && (candidate.provider ?? "codex") === provider
      ))
      .sort((left, right) => right.startedAt - left.startedAt)[0] ?? null;
  }
  let approvals = suppliedThreadId || active
    ? pendingApprovalsFor(suppliedThreadId ?? active.threadId, active?.turnId)
    : [...pendingApprovals.values()].filter((candidate) => (
      candidate.session.researchRoot === roots.researchRoot
      && candidate.session.paperRoot === roots.paperRoot
      && (candidate.session.provider ?? "codex") === provider
    ));
  const scopedActive = active
    && active.researchRoot === roots.researchRoot
    && active.paperRoot === roots.paperRoot
    && (active.provider ?? "codex") === provider
    ? active
    : null;
  approvals = approvals.filter((approval) => (
    approval.session.researchRoot === roots.researchRoot
    && approval.session.paperRoot === roots.paperRoot
    && (approval.session.provider ?? "codex") === provider
  ));
  const ownedSession = provider === "codex" && suppliedThreadId ? agentSessions.get(suppliedThreadId) : null;
  const sessionMatches = ownedSession
    && ownedSession.researchRoot === roots.researchRoot
    && ownedSession.paperRoot === roots.paperRoot;
  if (!scopedActive && approvals.length === 0) {
    if (sessionMatches) {
      return {
        ok: true,
        stopped: false,
        threadId: suppliedThreadId,
        turnId: body.turnId ?? null,
        status: "idle",
        approvalDeclined: false,
      };
    }
    throw new HttpError(404, `No active ${providerName(provider)} turn was found for this paper.`);
  }
  const requestedThreadId = suppliedThreadId
    ?? scopedActive?.threadId
    ?? approvals[0].params.threadId;

  const requestedTurnId = body.turnId == null || body.turnId === ""
    ? null
    : assertString(body.turnId, "turnId", { maxLength: 256 });
  const turnId = scopedActive?.turnId ?? approvals[0].params.turnId;
  if (requestedTurnId && requestedTurnId !== turnId) {
    throw new HttpError(409, `That ${providerName(provider)} turn is no longer active.`);
  }
  approvals = approvals.filter((approval) => approval.params.turnId === turnId);
  if (scopedActive?.status === "interrupting") {
    return {
      ok: true,
      stopped: true,
      threadId: requestedThreadId,
      turnId,
      status: "interrupting",
      approvalDeclined: false,
    };
  }
  if (approvals.some((approval) => approval.resolving)) {
    throw new HttpError(409, `A review decision is already being finalized. Wait for it to finish before stopping ${providerName(provider)}.`);
  }

  if (provider !== "codex") {
    externalCancelledTurns.add(turnKey(requestedThreadId, turnId));
    let approvalDeclined = false;
    for (const approval of approvals) {
      approval.resolving = true;
      clearTimeout(approval.timeout);
      pendingApprovals.delete(approval.requestId);
      resolveExternalApproval(approval, { decision: "cancel" });
      approvalDeclined = true;
    }
    const running = externalProcesses.get(turnKey(requestedThreadId, turnId));
    touchActiveTurn(requestedThreadId, turnId, {
      status: "interrupting",
      label: `Stopping ${providerName(provider)}…`,
    });
    broadcastAgent(requestedThreadId, turnId, {
      type: "status",
      provider,
      label: `Stopping ${providerName(provider)}…`,
    });
    if (running) {
      running.stopped = true;
      running.child.kill("SIGTERM");
      setTimeout(() => running.child.kill("SIGKILL"), 1_500).unref();
    }
    return {
      ok: true,
      stopped: true,
      threadId: requestedThreadId,
      turnId,
      status: "interrupting",
      approvalDeclined,
    };
  }

  let approvalDeclined = false;
  let interruptedByApproval = false;
  for (const approval of approvals) {
    approval.resolving = true;
    clearTimeout(approval.timeout);
    pendingApprovals.delete(approval.requestId);
    try {
      codexClient.respond(approval.rpcId, rejectedApprovalResult(approval, true));
      approvalDeclined = true;
      if (approval.approvalType !== "permission") interruptedByApproval = true;
    } catch {
      // If none of the approval responses can interrupt, use the explicit RPC below.
    }
  }

  touchActiveTurn(requestedThreadId, turnId, {
    status: "interrupting",
    label: "Stopping Codex…",
  });
  broadcastAgent(requestedThreadId, turnId, { type: "status", label: "Stopping Codex…" });
  if (!interruptedByApproval) {
    try {
      await codexClient.request("turn/interrupt", {
        threadId: requestedThreadId,
        turnId,
      });
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const current = activeTurns.get(requestedThreadId);
      const alreadyTerminal = !current
        || current.turnId !== turnId
        || terminalTurns.has(turnKey(requestedThreadId, turnId))
        || completedTurns.has(turnKey(requestedThreadId, turnId))
        || /not active|not found|already (?:completed|interrupted)|has (?:completed|been interrupted)/i.test(
          String(error?.message ?? error),
        );
      if (!alreadyTerminal) throw error;
      forgetActiveTurn(requestedThreadId, turnId);
      return {
        ok: true,
        stopped: false,
        threadId: requestedThreadId,
        turnId,
        status: "idle",
        approvalDeclined,
      };
    }
  }

  return {
    ok: true,
    stopped: true,
    threadId: requestedThreadId,
    turnId,
    status: "interrupting",
    approvalDeclined,
  };
}

async function changeStatus(body) {
  const snapshotId = assertString(body.snapshotId, "snapshotId", { maxLength: 256 });
  const roots = await canonicalRoots(body.researchRoot, body.paperRoot);
  const snapshot = undoSnapshots.get(snapshotId);
  if (
    !snapshot
    || snapshot.researchRoot !== roots.researchRoot
    || snapshot.paperRoot !== roots.paperRoot
  ) {
    throw new HttpError(404, "Change snapshot not found for this paper.");
  }
  return { ok: true, ...publicSnapshotStatus(snapshot) };
}

async function undoChanges(body) {
  const roots = await canonicalRoots(body.researchRoot, body.paperRoot);
  let snapshot = null;
  if (body.snapshotId) snapshot = undoSnapshots.get(String(body.snapshotId)) ?? null;
  if (!snapshot) {
    for (let index = undoOrder.length - 1; index >= 0; index -= 1) {
      const candidate = undoSnapshots.get(undoOrder[index]);
      if (candidate && !candidate.undone && candidate.researchRoot === roots.researchRoot && candidate.paperRoot === roots.paperRoot) {
        snapshot = candidate;
        break;
      }
    }
  }
  if (!snapshot || snapshot.researchRoot !== roots.researchRoot || snapshot.paperRoot !== roots.paperRoot) {
    throw new HttpError(404, "No undo snapshot is available for this paper.");
  }
  if (snapshot.undone) throw new HttpError(409, "This change has already been undone.");
  if (snapshot.undoing) throw new HttpError(409, "This change is already being undone.");
  snapshot.undoing = true;
  try {
  if (snapshot.applyStatus === "pending" || snapshot.applyStatus === "finalizing") {
    throw new HttpError(409, "The approved change is still being applied. Try undo again after the turn completes.");
  }

  if (!["completed", "completedMismatch"].includes(snapshot.applyStatus) || !snapshot.applied) {
    throw new HttpError(409, "The approved change was not applied cleanly, so there is nothing safe to undo.");
  }

  // Conflict check is performed for every file before any restoration begins.
  // This prevents undo from overwriting manual edits or a later agent change.
  for (const saved of snapshot.files) {
    const current = await safeApprovalPath(snapshot.researchRoot, saved.path, { mustExist: false });
    if (current.path !== saved.path) {
      throw new HttpError(409, `Cannot undo because ${relativePortable(snapshot.researchRoot, saved.path)} changed afterward.`);
    }
    if (current.exists !== saved.afterExists) {
      throw new HttpError(409, `Cannot undo because ${relativePortable(snapshot.researchRoot, saved.path)} changed afterward.`);
    }
    if (current.exists) {
      const currentHash = sha256(await fs.readFile(current.path));
      if (currentHash !== saved.afterHash) {
        throw new HttpError(409, `Cannot undo because ${relativePortable(snapshot.researchRoot, saved.path)} changed afterward.`);
      }
    }
  }

  let reverseDiff = "";
  const restored = [];
  for (const saved of snapshot.files) {
    const checked = await safeApprovalPath(snapshot.researchRoot, saved.path, { mustExist: false });
    if (checked.path !== saved.path || !isWithin(snapshot.researchRoot, checked.path)) {
      throw new HttpError(403, "Undo target is outside the research workspace or now uses a link.");
    }
    if (checked.exists !== saved.afterExists) {
      throw new HttpError(409, `Cannot undo because ${relativePortable(snapshot.researchRoot, saved.path)} changed afterward.`);
    }
    let current = "";
    if (checked.exists) {
      const currentBytes = await fs.readFile(checked.path);
      if (sha256(currentBytes) !== saved.afterHash) {
        throw new HttpError(409, `Cannot undo because ${relativePortable(snapshot.researchRoot, saved.path)} changed afterward.`);
      }
      try {
        current = utf8Decoder.decode(currentBytes);
      } catch {
        current = "[non-text content omitted from undo diff]\n";
      }
    }
    reverseDiff += createTwoFilesPatch(
      relativePortable(snapshot.researchRoot, saved.path),
      relativePortable(snapshot.researchRoot, saved.path),
      current,
      saved.existed ? saved.content : "",
      "current",
      "restored",
    );
    if (saved.existed) {
      const tempPath = `${saved.path}.codex-undo-${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, saved.bytes, { flag: "wx", mode: saved.mode ?? 0o600 });
      try {
        if (saved.mode != null) await fs.chmod(tempPath, saved.mode);
        await fs.rename(tempPath, saved.path);
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
    } else if (checked.exists) {
      await fs.unlink(saved.path);
    }
    restored.push(relativePortable(snapshot.researchRoot, saved.path));
  }
  snapshot.undone = true;
  return { ok: true, snapshotId: snapshot.id, files: restored, diff: reverseDiff };
  } finally {
    snapshot.undoing = false;
  }
}

function paperAgentInstructions(researchRoot, paperRoot) {
  return [
    "You are the editing agent for a local LaTeX research-paper workbench.",
    `The research root is ${researchRoot}. All work must remain inside it.`,
    `The primary manuscript folder is ${paperRoot}.`,
    "You may propose reviewed UTF-8 text changes anywhere inside the research root when the task needs supporting code, metadata, analysis, or manuscript edits.",
    "When a source or PDF-mapped selection is attached, treat it as the primary target, not a hard boundary.",
    "You may make minimal related edits elsewhere in the research workspace when needed for consistency, references, figures, analysis, or compilation.",
    "Use apply_patch for all text edits so the user receives a reviewable diff and undo support.",
    "For substantial tasks, send a short progress message before inspecting files and share concise findings as you work. Do not save all user-facing updates for the final response.",
    "To rerun code that must create or replace non-paper outputs, use request_permissions for the smallest dedicated output folder, never an individual output file. A requested new folder may be created after approval. The user may grant that folder for this turn only.",
    "A generated-figure folder may be inside the paper folder. Never request the paper folder itself or an ancestor containing it; manuscript and source changes must stay in the reviewed text-change flow.",
    "Never write outside the research root, request network access, request a session-wide grant, or bypass the approval flow.",
    "Do not use external connectors or send project content to third-party tools.",
  ].join("\n");
}

function reserveAgentThread(threadId) {
  if (!threadId) return () => {};
  if (startingThreads.has(threadId) || activeTurns.has(threadId)) {
    throw new HttpError(409, "This conversation is already working in another window. Wait for that turn to finish.", "thread_busy");
  }
  startingThreads.add(threadId);
  return () => startingThreads.delete(threadId);
}

async function openAgentSession(researchRoot, paperRoot, requestedThreadId, requestedModel, client = codexClient) {
  await client.ensureReady();
  const originalThreadId = requestedThreadId;
  const redirect = sessionRedirects.get(requestedThreadId);
  if (redirect) {
    if (redirect.researchRoot !== researchRoot || redirect.paperRoot !== paperRoot) {
      throw new HttpError(409, "This Codex thread belongs to a different project.");
    }
    requestedThreadId = redirect.threadId;
  }
  const params = {
    ...(requestedModel ? { model: requestedModel } : {}),
    cwd: researchRoot,
    runtimeWorkspaceRoots: [researchRoot],
    sandbox: "read-only",
    approvalPolicy: RESEARCH_APPROVAL_POLICY,
    approvalsReviewer: "user",
    developerInstructions: paperAgentInstructions(researchRoot, paperRoot),
  };
  let response;
  let recoveredFromThreadId = redirect ? originalThreadId : null;
  if (requestedThreadId) {
    const existing = agentSessions.get(requestedThreadId);
    if (existing && existing.generation === client.generation) {
      if (existing.researchRoot !== researchRoot || existing.paperRoot !== paperRoot) {
        throw new HttpError(409, "This Codex thread belongs to a different project.");
      }
      if (activeTurns.has(requestedThreadId)) {
        throw new HttpError(409, "This Codex thread already has an active turn in another browser window.");
      }
      if (requestedModel && existing.model !== requestedModel) {
        // A loaded thread already owns its writer. Change its settings in place.
        await client.request("thread/settings/update", { threadId: requestedThreadId, model: requestedModel });
        const { thread } = await client.request("thread/read", { threadId: requestedThreadId, includeTurns: false });
        existing.model = verifyAcceptedCodexModel(requestedModel, thread?.model);
        existing.reasoningEffort = thread?.reasoningEffort ?? existing.reasoningEffort;
      }
      existing.recoveredFromThreadId = recoveredFromThreadId;
      return existing;
    }
    try {
      response = await client.request("thread/resume", { ...params, threadId: requestedThreadId });
    } catch (error) {
      if (!error.message?.includes(`thread ${requestedThreadId} already has an active writer`)) throw error;
      const { thread } = await client.request("thread/read", { threadId: requestedThreadId, includeTurns: false });
      if (!thread?.cwd || !isWithin(researchRoot, thread.cwd)) {
        throw new HttpError(409, "The locked conversation belongs to a different research folder.");
      }
      const latest = await client.request("thread/turns/list", {
        threadId: requestedThreadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
      });
      if (thread.status?.type === "active" || latest.data?.[0]?.status === "inProgress") {
        throw new HttpError(409, "This conversation is still running in another Codex window. Finish or stop it there, then send your message again.", "thread_busy");
      }
      response = await client.request("thread/fork", {
        ...params,
        threadId: requestedThreadId,
        ephemeral: false,
        excludeTurns: true,
        deferGoalContinuation: true,
      });
      if (!response.thread?.id || response.thread.id === requestedThreadId) {
        throw new Error("Codex could not create a recovered conversation. Please retry.");
      }
      recoveredFromThreadId = requestedThreadId;
    }
  } else {
    response = await client.request("thread/start", {
      ...params,
      allowProviderModelFallback: false,
      ephemeral: false,
    });
  }
  const threadId = response.thread?.id;
  if (!threadId) throw new Error("Codex did not return a thread id.");
  const session = {
    threadId,
    researchRoot,
    paperRoot,
    model: verifyAcceptedCodexModel(requestedModel, response.model),
    reasoningEffort: response.reasoningEffort ?? null,
    generation: client.generation,
    recoveredFromThreadId,
  };
  agentSessions.set(threadId, session);
  if (recoveredFromThreadId) sessionRedirects.set(recoveredFromThreadId, { threadId, researchRoot, paperRoot });
  return session;
}

async function agentPrompt(body, researchRoot) {
  const prompt = body.prompt ?? body.message ?? body.instruction;
  assertString(prompt, "prompt", { maxLength: 300_000 });
  if (!body.selection) return prompt;
  const selection = body.selection;
  const selectionPath = selection.path ?? selection.file;
  const resolved = await safePath(researchRoot, selectionPath, { mustExist: true, fileOnly: true });
  let selectedText = typeof selection.text === "string" ? selection.text : null;
  const startLine = Math.max(1, Number(selection.startLine ?? selection.line ?? 1));
  const endLine = Math.max(startLine, Number(selection.endLine ?? startLine));
  const startColumn = Math.max(1, Number(selection.startColumn ?? 1));
  const endColumn = Math.max(1, Number(selection.endColumn ?? startColumn));
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine - startLine > 5_000) {
    throw new HttpError(400, "Selection line range is invalid or too large.");
  }
  if (!Number.isFinite(startColumn) || !Number.isFinite(endColumn)) {
    throw new HttpError(400, "Selection column range is invalid.");
  }
  if (selectedText == null) {
    const file = await readTextFile(researchRoot, resolved.path);
    selectedText = file.content.split(/\r?\n/).slice(startLine - 1, endLine).join("\n");
  }
  assertString(selectedText, "selection.text", { maxLength: 500_000, allowEmpty: true });
  const renderedText = typeof selection.renderedText === "string" ? selection.renderedText : "";
  assertString(renderedText, "selection.renderedText", { maxLength: 250_000, allowEmpty: true });
  const context = [
    prompt,
    "",
    "The attached selection is the primary edit target. Follow the request there first.",
    "It is not a hard boundary: make minimal related changes elsewhere in the research workspace only when the request requires them.",
    `Selected source: ${relativePortable(researchRoot, resolved.path)} (lines ${startLine}-${endLine}, columns ${startColumn}-${endColumn})`,
  ];
  if (renderedText) {
    context.push("--- highlighted PDF text ---", renderedText, "--- end highlighted PDF text ---");
  }
  context.push(
    "--- mapped LaTeX source ---",
    selectedText,
    "--- end mapped LaTeX source ---",
  );
  return context.join("\n");
}

function completeExternalTurn(session, turnId, status = "completed", undoAvailable = false) {
  const turn = { id: turnId, status };
  const key = turnKey(session.threadId, turnId);
  terminalTurns.set(key, turn);
  completedTurns.set(key, turn);
  const expiry = setTimeout(() => {
    terminalTurns.delete(key);
    completedTurns.delete(key);
  }, 60_000);
  expiry.unref();
  broadcastAgent(session.threadId, turnId, {
    type: "completed",
    provider: session.provider,
    threadId: session.threadId,
    turnId,
    status,
    undoAvailable,
  });
  forgetActiveTurn(session.threadId, turnId);
  turnEvents.emit(key, turn);
  externalCancelledTurns.delete(key);
}

function runExternalProvider(provider, invocation, session, turnId) {
  const key = turnKey(session.threadId, turnId);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: session.researchRoot,
        env: providerEnvironment(provider),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: error.message, error });
      return;
    }
    const running = { child, provider, session, turnId, stopped: false };
    externalProcesses.set(key, running);
    child.stdin.on("error", () => {});
    child.stdin.end(invocation.prompt);
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const capture = (target, chunk) => {
      if (capturedBytes >= PROVIDER_OUTPUT_BYTES) {
        truncated = true;
        return target;
      }
      const remaining = PROVIDER_OUTPUT_BYTES - capturedBytes;
      const slice = chunk.subarray(0, remaining);
      capturedBytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
      return target + slice.toString("utf8");
    };
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
      touchActiveTurn(session.threadId, turnId);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
      touchActiveTurn(session.threadId, turnId);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_500).unref();
    }, TURN_TIMEOUT_MS);
    timer.unref();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (externalProcesses.get(key) === running) externalProcesses.delete(key);
      resolve({ ...result, stdout, stderr, truncated, timedOut, stopped: running.stopped });
    };
    child.on("error", (error) => finish({ code: null, signal: null, error }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

async function proposalChangesForReview(session, proposal) {
  const changes = [];
  for (const proposed of proposal.changes) {
    const proposedPath = assertString(proposed.path, "proposed path", { maxLength: 16_384 });
    if (path.isAbsolute(proposedPath)) {
      throw new HttpError(403, `${providerName(session.provider)} returned an absolute file path.`);
    }
    const normalized = path.normalize(proposedPath);
    if (normalized === "." || normalized.startsWith(`..${path.sep}`) || normalized === "..") {
      throw new HttpError(403, `${providerName(session.provider)} returned a path outside the research workspace.`);
    }
    const target = await safeApprovalPath(session.researchRoot, normalized, { mustExist: false });
    if (proposed.action === "delete") {
      if (!target.exists) {
        throw new HttpError(409, `${relativePortable(session.researchRoot, target.path)} no longer exists.`);
      }
      changes.push({ path: target.path, kind: { type: "delete" }, diff: "" });
      continue;
    }
    if (Buffer.byteLength(proposed.content, "utf8") > MAX_TEXT_BYTES || proposed.content.includes("\0")) {
      throw new HttpError(413, `${relativePortable(session.researchRoot, target.path)} is not a supported UTF-8 text proposal.`);
    }
    const before = target.exists
      ? (await readTextFile(session.researchRoot, target.path)).content
      : "";
    if (target.exists && before === proposed.content) continue;
    const displayPath = relativePortable(session.researchRoot, target.path);
    changes.push({
      path: target.path,
      kind: { type: target.exists ? "update" : "add" },
      diff: proposed.content === "" && !target.exists
        ? ""
        : createTwoFilesPatch(displayPath, displayPath, before, proposed.content, "current", "proposed"),
    });
  }
  return changes;
}

async function streamExternalAgentTurn(res, body, provider, roots, prompt, requestedEffort, requestedModel) {
  const name = providerName(provider);
  const requestedThreadId = body.threadId == null || body.threadId === ""
    ? null
    : assertString(body.threadId, "threadId", { maxLength: 256 });
  if (requestedThreadId && !requestedThreadId.startsWith(`${provider}:`)) {
    throw new HttpError(409, `That conversation belongs to a different agent provider.`);
  }
  const provisionalRawId = randomUUID();
  const threadId = requestedThreadId ?? providerThreadId(provider, provisionalRawId);
  const turnId = randomUUID();
  const session = {
    threadId,
    researchRoot: roots.researchRoot,
    paperRoot: roots.paperRoot,
    provider,
    generation: null,
  };
  const active = registerActiveTurn(session, { id: turnId, status: "inProgress" });
  const sink = { res, threadId, turnId };
  agentSinks.add(sink);
  res.once("close", () => agentSinks.delete(sink));
  writeNdjson(res, { type: "thread", provider, threadId });
  writeNdjson(res, {
    type: "turn",
    provider,
    threadId,
    turnId,
    status: active?.status ?? "inProgress",
    startedAt: active?.startedAt,
    lastActivityAt: active?.lastActivityAt,
  });
  writeNdjson(res, { type: "status", provider, label: `${name} is reading the research workspace…` });

  try {
    const invocation = providerInvocation(provider, {
      researchRoot: roots.researchRoot,
      paperRoot: roots.paperRoot,
      userPrompt: prompt,
      threadId: requestedThreadId,
      sessionId: provider === "claude" && !requestedThreadId ? provisionalRawId : null,
      model: provider === "claude" ? requestedModel : null,
      reasoningEffort: provider === "claude" ? requestedEffort : null,
    });
    const result = await runExternalProvider(provider, invocation, session, turnId);
    if (result.stopped || externalCancelledTurns.has(turnKey(session.threadId, turnId))) {
      completeExternalTurn(session, turnId, "interrupted");
      return;
    }
    if (result.timedOut) throw new Error(`${name} timed out after 45 minutes.`);
    if (result.truncated) throw new Error(`${name} returned more than 24 MiB; ask for a smaller change.`);
    if (result.code !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-4_000);
      throw new Error(detail || `${name} exited before returning a proposal.`);
    }
    const parsed = parseProviderResult(provider, result.stdout);
    if (parsed.sessionId) {
      const nextThreadId = providerThreadId(provider, parsed.sessionId);
      if (nextThreadId !== session.threadId) {
        const previousThreadId = session.threadId;
        const current = activeTurns.get(session.threadId);
        activeTurns.delete(session.threadId);
        session.threadId = nextThreadId;
        sink.threadId = nextThreadId;
        if (current) {
          current.threadId = nextThreadId;
          activeTurns.set(nextThreadId, current);
        }
        const previousTurnKey = turnKey(previousThreadId, turnId);
        if (externalCancelledTurns.delete(previousTurnKey)) {
          externalCancelledTurns.add(turnKey(nextThreadId, turnId));
        }
        writeNdjson(res, { type: "thread", provider, threadId: nextThreadId });
      }
    }
    if (parsed.proposal.summary) {
      broadcastAgent(session.threadId, turnId, { type: "delta", provider, text: parsed.proposal.summary });
    }
    const changes = await proposalChangesForReview(session, parsed.proposal);
    if (externalCancelledTurns.has(turnKey(session.threadId, turnId))) {
      completeExternalTurn(session, turnId, "interrupted");
      return;
    }
    if (changes.length === 0) {
      completeExternalTurn(session, turnId, "completed");
      return;
    }
    touchActiveTurn(session.threadId, turnId, { label: "Preparing reviewed source changes…" });
    const materialized = await materializeReviewFiles(session, changes);
    const requestId = `${provider}-${randomUUID()}`;
    const itemId = randomUUID();
    const diff = materialized.files.map((file) => file.reviewDiff).join("\n");
    const pending = {
      requestId,
      rpcId: null,
      source: "external",
      approvalType: "file",
      params: {
        threadId: session.threadId,
        turnId,
        itemId,
        reason: `${name} prepared ${materialized.files.length === 1 ? "a source change" : `${materialized.files.length} source changes`} for review.`,
      },
      session,
      paths: materialized.reviewGuards.map((guard) => ({ path: guard.absolutePath, exists: guard.exists })),
      changes,
      reviewFiles: materialized.files,
      reviewGuards: materialized.reviewGuards,
      expectedAfter: materialized.expectedAfter,
      diff,
      createdAt: Date.now(),
      expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      resolving: false,
      timeout: null,
    };
    const decision = new Promise((resolve) => externalApprovalWaiters.set(requestId, { resolve }));
    pendingApprovals.set(requestId, pending);
    armApprovalTimeout(pending);
    touchActiveTurn(session.threadId, turnId, { label: "Waiting for your review" });
    broadcastAgent(session.threadId, turnId, {
      type: "approval",
      provider,
      agentName: name,
      requestId,
      itemId,
      approvalType: "file",
      reason: pending.params.reason,
      diff,
      files: publicReviewFiles(materialized.files),
    });
    const outcome = await decision;
    completeExternalTurn(
      session,
      turnId,
      outcome.expired || outcome.decision === "cancel" ? "interrupted" : "completed",
      Boolean(outcome.snapshotId),
    );
  } catch (error) {
    broadcastAgent(session.threadId, turnId, { type: "error", provider, message: error.message });
    completeExternalTurn(session, turnId, "failed");
  } finally {
    agentSinks.delete(sink);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

function waitForTurn(threadId, turnId, res) {
  const key = turnKey(threadId, turnId);
  const completed = completedTurns.get(key);
  if (completed) return Promise.resolve(completed);
  return new Promise((resolve, reject) => {
    const onCompleted = (turn) => finish(null, turn);
    const onClose = () => finish(null, null);
    const timer = setTimeout(() => finish(new Error("Codex turn timed out.")), TURN_TIMEOUT_MS);
    timer.unref();
    const finish = (error, value) => {
      clearTimeout(timer);
      turnEvents.off(key, onCompleted);
      res.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    };
    turnEvents.once(key, onCompleted);
    res.once("close", onClose);
  });
}

async function streamAgentTurn(res, body) {
  const { researchRoot, paperRoot } = await canonicalRoots(body.researchRoot, body.paperRoot);
  const prompt = await agentPrompt(body, researchRoot);
  let provider;
  try {
    provider = normalizeProvider(body.provider);
  } catch (error) {
    throw new HttpError(error.status ?? 400, error.message, error.code ?? "unsupported_provider");
  }
  const requestedEffort = body.reasoningEffort == null || body.reasoningEffort === ""
    ? null
    : assertString(body.reasoningEffort, "reasoningEffort", { maxLength: 64 });
  const modelValue = body.model == null || body.model === ""
    ? null
    : assertString(body.model, "model", { maxLength: 256 });
  let requestedModel = null;
  if (provider === "codex") requestedModel = await validateCodexModel(modelValue);
  else if (provider === "claude") {
    requestedModel = await validateClaudeModel(modelValue, researchRoot);
    await validateClaudeReasoningEffort(requestedModel, researchRoot, requestedEffort);
  } else if (modelValue) {
    throw new HttpError(400, "Cursor Agent does not expose a subscription model catalog to this workbench.");
  }
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Transfer-Encoding": "chunked",
    Connection: "keep-alive",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  writeNdjson(res, { type: "status", provider, label: `Connecting to your ${AGENT_PROVIDERS[provider].subscription} subscription…` });

  if (EXTERNAL_PROVIDER_IDS.includes(provider)) {
    await streamExternalAgentTurn(
      res,
      body,
      provider,
      { researchRoot, paperRoot },
      prompt,
      requestedEffort,
      requestedModel,
    );
    return;
  }

  let sink = null;
  let releaseThread = () => {};
  let releaseRecoveredThread = () => {};
  let turnStarted = false;
  try {
    releaseThread = reserveAgentThread(body.threadId);
    if (requestedEffort) await validateReasoningEffort(requestedModel, requestedEffort);
    const session = await openAgentSession(researchRoot, paperRoot, body.threadId, requestedModel);
    if (session.threadId !== body.threadId) releaseRecoveredThread = reserveAgentThread(session.threadId);
    writeNdjson(res, {
      type: "thread",
      provider: "codex",
      threadId: session.threadId,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      modelConfirmed: true,
      runtime: "Codex app-server",
      recoveredFromThreadId: session.recoveredFromThreadId,
    });
    if (session.recoveredFromThreadId) {
      writeNdjson(res, { type: "notice", message: "Your conversation was continued in a workbench session because another Codex window owns the original. Its saved history has been carried over." });
    }
    writeNdjson(res, { type: "status", label: body.threadId ? "Resuming the paper conversation…" : "Starting a paper conversation…" });
    sink = { res, threadId: session.threadId, turnId: null };
    agentSinks.add(sink);
    res.once("close", () => agentSinks.delete(sink));

    const turnParams = {
      threadId: session.threadId,
      cwd: researchRoot,
      runtimeWorkspaceRoots: [researchRoot],
      approvalPolicy: RESEARCH_APPROVAL_POLICY,
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: prompt, text_elements: [] }],
    };
    if (requestedModel) turnParams.model = requestedModel;
    if (requestedEffort) turnParams.effort = requestedEffort;
    const response = await codexClient.request("turn/start", turnParams);
    turnStarted = true;
    const turnId = response.turn?.id;
    if (!turnId) throw new Error("Codex did not return a turn id.");
    const active = registerActiveTurn(session, response.turn);
    sink.turnId = turnId;
    writeNdjson(res, {
      type: "turn",
      threadId: session.threadId,
      turnId,
      status: active?.status ?? "inProgress",
      provider: "codex",
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      modelConfirmed: true,
      runtime: "Codex app-server",
      startedAt: active?.startedAt,
      lastActivityAt: active?.lastActivityAt,
    });
    await waitForTurn(session.threadId, turnId, res);
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (error) {
    writeNdjson(res, { type: "error", message: error.message, terminal: !turnStarted, code: error.code });
    if (!res.writableEnded && !res.destroyed) res.end();
  } finally {
    if (sink) agentSinks.delete(sink);
    releaseThread();
    releaseRecoveredThread();
  }
}

// --- HTTP routes -------------------------------------------------------------

async function servePdf(req, res, url) {
  const buildId = url.searchParams.get("buildId");
  const build = buildId ? builds.get(buildId) : null;
  if (!build) throw new HttpError(404, "Build not found. Compile the paper again.");
  const checked = await safePath(build.paperRoot, build.pdfPath, { mustExist: true, fileOnly: true });
  const stat = await fs.stat(checked.path);
  const headers = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${path.basename(checked.path).replace(/["\\]/g, "_")}"`,
    "Accept-Ranges": "bytes",
    "Last-Modified": stat.mtime.toUTCString(),
  };
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end();
    return createReadStream(checked.path).pipe(res);
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    return res.end();
  }
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end != null) {
    start = Math.max(0, stat.size - end);
    end = stat.size - 1;
  } else {
    start ??= 0;
    end ??= stat.size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    return res.end();
  }
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, {
    ...headers,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Content-Length": end - start + 1,
  });
  if (req.method === "HEAD") return res.end();
  return createReadStream(checked.path, { start, end }).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!applyCors(req, res)) {
      sendJson(res, 403, { error: "Origin is not allowed.", code: "forbidden_origin" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, await getHealth());
      return;
    }
    if (req.method === "GET" && (url.pathname === "/api/codex/settings" || url.pathname === "/api/agent/settings")) {
      const researchRoot = await canonicalDirectory(url.searchParams.get("researchRoot"), "researchRoot");
      let provider;
      try {
        provider = url.pathname === "/api/codex/settings"
          ? "codex"
          : normalizeProvider(url.searchParams.get("provider"));
      } catch (error) {
        throw new HttpError(error.status ?? 400, error.message, error.code ?? "unsupported_provider");
      }
      sendJson(res, 200, await agentSettingsForProject(provider, researchRoot));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/folder/pick") {
      sendJson(res, 200, await pickFolder(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/folder/reveal") {
      sendJson(res, 200, await revealPaperLocation(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/project/open") {
      const body = await readJson(req);
      const researchValue = body.researchRoot ?? body.paperRoot;
      const paperValue = body.paperRoot ?? researchValue;
      const roots = await canonicalRoots(researchValue, paperValue);
      const inspection = await inspectProject(roots.researchRoot, roots.paperRoot);
      sendJson(res, 200, { ...roots, ...inspection });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/file") {
      const researchRoot = await canonicalDirectory(url.searchParams.get("researchRoot"), "researchRoot");
      const requestedPath = url.searchParams.get("path");
      const file = await readTextFile(researchRoot, requestedPath);
      sendJson(res, 200, {
        path: relativePortable(researchRoot, file.resolved.path),
        content: file.content,
        hash: file.hash,
        size: file.stat.size,
        mtimeMs: file.stat.mtimeMs,
      });
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/file") {
      sendJson(res, 200, await saveTextFile(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/compile") {
      sendJson(res, 200, await compileProject(await readJson(req)));
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/pdf") {
      await servePdf(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/synctex/forward") {
      sendJson(res, 200, await synctexForward(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/synctex/inverse") {
      sendJson(res, 200, await synctexInverse(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agent/turn") {
      await streamAgentTurn(res, await readJson(req));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agent/status") {
      sendJson(res, 200, await agentTurnStatus(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agent/stop") {
      sendJson(res, 200, await stopAgentTurn(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agent/approval") {
      sendJson(res, 200, await decideApproval(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/changes/status") {
      sendJson(res, 200, await changeStatus(await readJson(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/changes/undo") {
      sendJson(res, 200, await undoChanges(await readJson(req)));
      return;
    }
    sendJson(res, 404, { error: "Route not found.", code: "not_found" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "The local companion encountered an unexpected error.";
    if (!res.headersSent) sendJson(res, status, { error: message, code: error.code ?? "internal_error" });
    else if (!res.writableEnded) res.end();
    if (!(error instanceof HttpError)) console.error(error);
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

function shutdown() {
  codexClient.stop();
  for (const running of externalProcesses.values()) {
    running.stopped = true;
    running.child.kill("SIGTERM");
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMainModule) {
  server.listen(PORT, HOST, () => {
    console.log(`Local LaTeX companion listening on http://${HOST}:${PORT}`);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export {
  HttpError,
  activeTurns,
  agentMessages,
  agentSinks,
  handleCodexNotification,
  reserveAgentThread,
  openAgentSession,
  applyExternalApproval,
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
  publicPendingApproval,
  publicSnapshotStatus,
  readTextFile,
  resolveClaudeModel,
  resolveCodexModel,
  verifyAcceptedCodexModel,
  safeApprovalPath,
  saveTextFile,
  stopAgentTurn,
  undoChanges,
};
