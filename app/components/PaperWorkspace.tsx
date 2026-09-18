"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BaseStyles, Button, IconButton, Label, Select, SegmentedControl } from "@primer/react";
import { ThemeProvider } from "@primer/react/next";
import { BookIcon, CodeIcon, CommentDiscussionIcon, FileDirectoryIcon, MoonIcon, SunIcon, XIcon } from "@primer/octicons-react";
import { DEFAULT_PANES, fitPaneLayout, validPaneLayout } from "../lib/pane-layout.mjs";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Cpu,
  FileCode2,
  FolderOpen,
  GitCompareArrows,
  LoaderCircle,
  MessageSquareText,
  BookOpen,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import { api, LOCAL_API, relativeTo } from "../lib/api";
import { mergeAgentMessages } from "../lib/agent-messages.mjs";
import { usePdfBaseline } from "../lib/pdf-baseline";
import type { PdfFocus, ProjectInfo, SourceSelection } from "../lib/api";
import { DiffViewer } from "./DiffViewer";
import { AutoApproval } from "./AutoApproval";
import { SkillControls, DEFAULT_SKILL_OPTIONS } from "./SkillControls";
import type { SkillOptions } from "./SkillControls";
import { PaperCheckMessage } from "./PaperCheckMessage";
import { WORKBENCH_SKILLS } from "../lib/workbench-skills.mjs";
import type { ApprovalReviewFile, ApprovalWriteTarget, PendingApproval } from "./DiffViewer";
import { FileTree } from "./FileTree";
import { PdfViewer } from "./PdfViewer";
import type { PdfSelection } from "./PdfViewer";
import { ResizeHandle } from "./ResizeHandle";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { SourceEditor } from "./SourceEditor";
import type { SourceFocusRequest } from "./SourceEditor";

type AgentProvider = "codex" | "claude" | "cursor";

type ProviderHealth = {
  installed?: boolean;
  authenticated?: boolean;
  label?: string;
  version?: string | null;
};

type Health = {
  ok: boolean;
  capabilities?: { paperSkills?: boolean; paperSkillsVersion?: number };
  providers?: Partial<Record<AgentProvider, ProviderHealth>>;
  codex?: ProviderHealth;
  claude?: ProviderHealth;
  cursor?: ProviderHealth;
  latex?: { installed?: boolean; label?: string };
};

type CompileResult = {
  success: boolean;
  buildId?: string;
  pdfUrl?: string;
  log?: string;
  errors?: Array<string | { file?: string | null; line?: number | null; message?: string; severity?: string }>;
  message?: string;
};

type FileReadResult = {
  content: string;
  hash: string;
};

type FileSaveResult = {
  ok: boolean;
  path: string;
  hash: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  revision?: number;
};

type StreamEvent = {
  type: string;
  id?: string;
  revision?: number;
  terminal?: boolean;
  recoveredFromThreadId?: string | null;
  provider?: AgentProvider;
  agentName?: string;
  approvalType?: "file" | "permission";
  threadId?: string;
  turnId?: string;
  text?: string;
  label?: string;
  message?: string;
  diff?: string;
  requestId?: string | number;
  itemId?: string;
  reason?: string | null;
  files?: ApprovalReviewFile[];
  writePaths?: string[];
  writeTargets?: ApprovalWriteTarget[];
  snapshotId?: string | null;
  status?: string;
  applied?: boolean;
  undoAvailable?: boolean;
  model?: string | null;
  requestedModel?: string | null;
  reasoningEffort?: string | null;
  modelConfirmed?: boolean;
  modelRerouted?: boolean;
  runtime?: string;
};

type ConfirmedAgentRuntime = {
  provider: AgentProvider;
  model: string;
  requestedModel: string | null;
  reasoningEffort: string | null;
  runtime: string;
  rerouted: boolean;
};

type ApplyStatus = {
  snapshotId: string;
  status: string;
  applied: boolean;
  undoAvailable: boolean;
  message?: string;
};

type AgentTurnStatus = {
  threadId: string;
  turnId: string;
  status: string;
  label?: string;
  startedAt: number;
  lastActivityAt: number;
  provider?: AgentProvider;
};

type AgentApprovalStatus = {
  requestId: string | number;
  approvalType?: "file" | "permission";
  itemId?: string;
  reason?: string | null;
  diff?: string;
  files?: ApprovalReviewFile[];
  writePaths?: string[];
  writeTargets?: ApprovalWriteTarget[];
  expiresAt?: number;
  provider?: AgentProvider;
  agentName?: string;
};

type AgentStatusResponse = {
  ok: boolean;
  active: boolean;
  turn: AgentTurnStatus | null;
  approval: AgentApprovalStatus | null;
  messages?: Array<{ id: string; text: string; revision: number }>;
};

type StopTurnResponse = {
  ok: boolean;
  stopped: boolean;
  threadId?: string | null;
  turnId?: string | null;
  status: "interrupting" | "idle";
  approvalDeclined?: boolean;
};

type TurnMonitor = {
  threadId: string | null;
  turnId: string | null;
  status: string;
  startedAt: number;
  lastActivityAt: number;
};

type ReviewReturnContext = {
  path: string | null;
  selection: SourceSelection | null;
  focusLine: number | null;
};

type ActiveApply = {
  requestId: string | number;
  snapshotId: string | null;
  approval: PendingApproval;
  project: ProjectInfo;
  mainFile: string | null;
  returnContext: ReviewReturnContext | null;
  deadline: number;
  settled: boolean;
  automatic: boolean;
};

type ReasoningOption = {
  reasoningEffort: string;
  description: string;
};

type AgentModelOption = {
  model: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: ReasoningOption[];
  isDefault: boolean;
};

type AgentSettings = {
  model: string | null;
  displayName: string | null;
  description: string;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: ReasoningOption[];
  models?: AgentModelOption[];
};

const LAST_PROJECT_KEY = "lattice:last-project";
const AGENT_PROVIDER_KEY = "lattice:agent-provider";
const AGENT_NAMES: Record<AgentProvider, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor Agent",
};
const AGENT_SUBSCRIPTIONS: Record<AgentProvider, string> = {
  codex: "ChatGPT/Codex",
  claude: "Claude",
  cursor: "Cursor",
};
const threadKey = (root: string, provider: AgentProvider) => provider === "codex"
  ? `lattice:thread:${root}`
  : `lattice:thread:${provider}:${root}`;
const effortKey = (root: string, provider: AgentProvider) => provider === "codex"
  ? `lattice:reasoning-effort:${root}`
  : `lattice:reasoning-effort:${provider}:${root}`;
const modelKey = (root: string, provider: AgentProvider) => provider === "codex"
  ? `lattice:codex-model:${root}`
  : `lattice:model:${provider}:${root}`;
const PANE_LAYOUT_KEY = "lattice:primer-pane-layout:v1";
const APPROVAL_REQUEST_TIMEOUT_MS = 15_000;
const APPLY_POLL_INTERVAL_MS = 750;
const APPLY_RECOVERY_TIMEOUT_MS = 30_000;
const APPLY_STATUS_REQUEST_TIMEOUT_MS = 5_000;
const AGENT_STATUS_POLL_INTERVAL_MS = 1_500;
const LONG_TURN_WARNING_MS = 45_000;

type PaneLayout = typeof DEFAULT_PANES;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function nameOf(path: string) {
  return path.split("/").filter(Boolean).at(-1) || path;
}

function absoluteLocalPath(root: string, path: string) {
  if (path.startsWith("/")) return path;
  const base = root.replace(/\/+$/, "");
  const relativePath = path.replace(/^\.\//, "").replace(/^\/+/, "");
  return !relativePath || relativePath === "." ? base : `${base}/${relativePath}`;
}

function formatSaveTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function withinPaper(project: ProjectInfo, path: string) {
  const relativePath = relativeTo(project.researchRoot, path);
  const paperPath = relativeTo(project.researchRoot, project.paperRoot).replace(/\/$/, "");
  return !paperPath || paperPath === "." || relativePath === paperPath || relativePath.startsWith(`${paperPath}/`);
}

function paperMainCandidates(project: ProjectInfo) {
  return project.texCandidates.filter((candidate) =>
    candidate.paperPath === undefined ? withinPaper(project, candidate.path) : candidate.paperPath !== null,
  );
}

function matchPaperMain(project: ProjectInfo, requested?: string | null) {
  if (!requested) return null;
  const normalized = relativeTo(project.researchRoot, requested).replace(/^\.\//, "");
  const candidate = paperMainCandidates(project).find((entry) => {
    const researchPath = relativeTo(project.researchRoot, entry.path).replace(/^\.\//, "");
    const paperPath = entry.paperPath?.replace(/^\.\//, "");
    return researchPath === normalized || paperPath === normalized;
  });
  return candidate ? relativeTo(project.researchRoot, candidate.path).replace(/^\.\//, "") : null;
}

function choosePaperMain(project: ProjectInfo, preferred?: string | null) {
  return matchPaperMain(project, preferred)
    ?? matchPaperMain(project, project.suggestedMain)
    ?? paperMainCandidates(project)[0]?.path
    ?? null;
}

function effortLabel(value: string) {
  if (value === "xhigh") return "X-high";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function modelOptionLabel(model: AgentModelOption) {
  const displayName = model.displayName || model.model;
  const resolvedDefault = model.model.toLowerCase() === "default"
    ? model.description.split(/\s+·\s+/, 1)[0]?.trim()
    : "";
  const resolution = resolvedDefault
    && !displayName.toLowerCase().includes(resolvedDefault.toLowerCase())
    ? ` · ${resolvedDefault}`
    : "";
  const recommendation = model.isDefault && !/recommended/i.test(displayName)
    ? " · recommended"
    : "";
  return `${displayName}${resolution}${recommendation}`;
}

function sourceSlice(content: string, startLine: number, endLine: number) {
  return content.split("\n").slice(Math.max(0, startLine - 1), endLine).join("\n");
}

function absolutePdfUrl(url: string, buildId?: string) {
  const base = url.startsWith("http") ? url : `${LOCAL_API}${url.startsWith("/") ? "" : "/"}${url}`;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}build=${encodeURIComponent(buildId || Date.now().toString())}`;
}

function projectContainsFile(nodes: ProjectInfo["tree"], target: string): boolean {
  for (const node of nodes) {
    if (node.type === "file" && node.path === target) return true;
    if (node.children && projectContainsFile(node.children, target)) return true;
  }
  return false;
}

function remapReviewedPath(path: string | null, files: ApprovalReviewFile[]) {
  if (!path) return null;
  const change = files.find((file) => file.path === path);
  if (!change) return path;
  if (change.kind === "delete") return null;
  return change.movePath ?? path;
}

function applyStillRunning(status: string) {
  return ["pending", "finalizing", "inProgress", "applying"].includes(status);
}

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function PaperWorkspace() {
  const [health, setHealth] = useState<Health | null>(null);
  const [agentProvider, setAgentProvider] = useState<AgentProvider>("codex");
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [mainFile, setMainFile] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastSuccessfulSaveAt, setLastSuccessfulSaveAt] = useState<number | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [sourceFocusRequest, setSourceFocusRequest] = useState<SourceFocusRequest | null>(null);
  const [pdfFocus, setPdfFocus] = useState<PdfFocus | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [buildFailed, setBuildFailed] = useState(false);
  const [preparingPdfBaseline, setPreparingPdfBaseline] = useState(false);
  const compiledPdfUrlRef = useRef<string | null>(null);
  const compilingRef = useRef(false);
  const sendingRef = useRef(false);
  const { baseline: pdfBaseline, capture: capturePdfBaseline } = usePdfBaseline(
    JSON.stringify([project?.researchRoot, project?.paperRoot, mainFile, agentProvider]),
  );
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compileLog, setCompileLog] = useState("");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [sourceVisible, setSourceVisible] = useState(true);
  const [agentVisible, setAgentVisible] = useState(true);
  const [mobileSurface, setMobileSurface] = useState<"source" | "paper" | "agent">("paper");
  const [dark, setDark] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [skillOptions, setSkillOptions] = useState<SkillOptions>(DEFAULT_SKILL_OPTIONS);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentStatus, setAgentStatus] = useState("Ready");
  const [turnMonitor, setTurnMonitor] = useState<TurnMonitor | null>(null);
  const [turnClock, setTurnClock] = useState(() => Date.now());
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [confirmedAgentRuntime, setConfirmedAgentRuntime] = useState<ConfirmedAgentRuntime | null>(null);
  const [latestDiff, setLatestDiff] = useState("");
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalApplying, setApprovalApplying] = useState(false);
  const [applyConfirmationDelayed, setApplyConfirmationDelayed] = useState(false);
  const [applyConfirmationMessage, setApplyConfirmationMessage] = useState<string | null>(null);
  const [refreshingAfterApply, setRefreshingAfterApply] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [paneLayout, setPaneLayout] = useState<PaneLayout>(DEFAULT_PANES);
  const [paneLayoutLoaded, setPaneLayoutLoaded] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [outerResizable, setOuterResizable] = useState(true);
  const [activeResize, setActiveResize] = useState<"columns" | "rows" | null>(null);
  const agentName = AGENT_NAMES[agentProvider];
  const providerHealth = health?.providers?.[agentProvider] ?? health?.[agentProvider];
  const selectedModelSettings = agentSettings?.models?.find((model) => model.model === selectedModel) ?? null;
  const intelligenceSettings = selectedModelSettings ?? agentSettings;
  const confirmedModelSettings = agentSettings?.models?.find(
    (model) => model.model === confirmedAgentRuntime?.model,
  ) ?? null;
  const confirmedRuntimeLabel = confirmedAgentRuntime?.provider === agentProvider
    ? confirmedModelSettings?.displayName ?? confirmedAgentRuntime.model
    : null;
  const confirmedRuntimeState = confirmedAgentRuntime?.rerouted ? "Codex reroute" : "confirmed";
  const projectRef = useRef<ProjectInfo | null>(null);
  const activePathRef = useRef<string | null>(null);
  const contentRef = useRef("");
  const savedContentRef = useRef("");
  const fileHashRef = useRef<string | null>(null);
  const sourceFocusIdRef = useRef(0);
  const saveTimesRef = useRef(new Map<string, number>());
  const saveQueueRef = useRef<Promise<boolean> | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeAssistantRef = useRef<string | null>(null);
  const agentStatusInFlightRef = useRef(false);
  const turnMonitorRef = useRef<TurnMonitor | null>(null);
  const initializedRef = useRef(false);
  const activeApplyRef = useRef<ActiveApply | null>(null);
  const approvalDecisionInFlightRef = useRef(false);
  const applyPollTimerRef = useRef<number | null>(null);
  const applyStatusInFlightRef = useRef(false);
  const reviewReturnContextRef = useRef<ReviewReturnContext | null>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const workspaceGridRef = useRef<HTMLDivElement | null>(null);
  const paneDragStartRef = useRef({ source: 0, agent: 0 });
  const sourceToggleRef = useRef<HTMLButtonElement>(null);
  const agentToggleRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const revealWorkingTab = useCallback((tab: "source" | "agent") => {
    // Desktop panes are independent: revealing source never hides the agent.
    if (tab === "source") setSourceVisible(true);
    else setAgentVisible(true);
    setMobileSurface(tab);
  }, []);

  const hidePane = (pane: "source" | "agent") => {
    if (pane === "source") { setSourceVisible(false); sourceToggleRef.current?.focus({ preventScroll: true }); }
    else { setAgentVisible(false); agentToggleRef.current?.focus({ preventScroll: true }); }
  };

  const replaceProject = useCallback((value: ProjectInfo | null) => {
    projectRef.current = value;
    setProject(value);
    setConfirmedAgentRuntime(null);
    setSkillOptions(DEFAULT_SKILL_OPTIONS);
  }, []);

  const replaceActivePath = useCallback((value: string | null) => {
    activePathRef.current = value;
    setActivePath(value);
  }, []);

  const replaceContent = useCallback((value: string) => {
    contentRef.current = value;
    setContent(value);
  }, []);

  const replaceSavedContent = useCallback((value: string) => {
    savedContentRef.current = value;
    setSavedContent(value);
  }, []);

  const focusSourceLine = useCallback((line: number | null) => {
    if (line === null) {
      setSourceFocusRequest(null);
      return;
    }
    revealWorkingTab("source");
    sourceFocusIdRef.current += 1;
    setSourceFocusRequest({ id: sourceFocusIdRef.current, line });
  }, [revealWorkingTab]);

  const dirty = activePath !== null && content !== savedContent;
  const activeReadOnly = refreshingAfterApply
    || Boolean(project && activePath && !withinPaper(project, activePath));
  const activeReviewFile = pendingApproval?.files?.find(
    (file) => file.path === activePath || (file.movePath != null && file.movePath === activePath),
  ) ?? null;
  const fittedPanes = fitPaneLayout(paneLayout, workspaceWidth, sourceVisible, agentVisible);
  const turnElapsed = turnMonitor ? Math.max(0, turnClock - turnMonitor.startedAt) : 0;
  const turnActive = turnMonitor !== null;
  const turnTakingLong = turnElapsed >= LONG_TURN_WARNING_MS && !pendingApproval;
  const turnInterruptible = Boolean(turnMonitor?.turnId);
  const stopLockedForApply = approvalApplying || applyConfirmationDelayed || refreshingAfterApply;
  const activeSourceDiskPath = project && activePath
    ? absoluteLocalPath(project.researchRoot, activePath)
    : null;

  const setMonitoredTurn = useCallback((turn: TurnMonitor | null) => {
    turnMonitorRef.current = turn;
    setTurnMonitor(turn);
    if (turn) setTurnClock(Date.now());
  }, []);

  const beginMonitoredTurn = useCallback((threadId: string | null) => {
    const startedAt = Date.now();
    setMonitoredTurn({
      threadId,
      turnId: null,
      status: `Starting ${agentName}…`,
      startedAt,
      lastActivityAt: startedAt,
    });
    return startedAt;
  }, [agentName, setMonitoredTurn]);

  useEffect(() => {
    let restored: PaneLayout | null = null;
    try {
      const stored = localStorage.getItem(PANE_LAYOUT_KEY);
      if (stored) restored = validPaneLayout(JSON.parse(stored));
    } catch {
      // Keep defaults when browser storage is unavailable or malformed.
    }
    const timeout = window.setTimeout(() => {
      if (restored) setPaneLayout(restored);
      try { setDark(localStorage.getItem("lattice:theme") === "dark"); } catch { /* Optional preference. */ }
      setPaneLayoutLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!paneLayoutLoaded) return;
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem(PANE_LAYOUT_KEY, JSON.stringify(paneLayout));
      } catch {
        // Layout persistence is optional when browser storage is unavailable.
      }
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [paneLayout, paneLayoutLoaded]);

  useEffect(() => {
    const compactQuery = window.matchMedia("(max-width: 760px)");
    const update = () => setOuterResizable(!compactQuery.matches);
    update();
    compactQuery.addEventListener("change", update);
    return () => compactQuery.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const node = workspaceGridRef.current;
    if (!node) return;
    const measure = () => setWorkspaceWidth(Math.round(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!turnActive) return;
    const timer = window.setInterval(() => setTurnClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [turnActive]);

  const scrollChatToEnd = useCallback(() => {
    const chat = chatScrollRef.current;
    if (chat) chat.scrollTop = chat.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    scrollChatToEnd();
  }, [agentBusy, buildId, compiling, latestDiff, messages, pendingApproval, scrollChatToEnd, turnMonitor]);

  useEffect(() => {
    const chat = chatScrollRef.current;
    if (!chat || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scrollChatToEnd);
    observer.observe(chat);
    return () => observer.disconnect();
  }, [pendingApproval, scrollChatToEnd]);

  const openFile = useCallback(async (path: string, currentProject?: ProjectInfo) => {
    const targetProject = currentProject ?? project;
    if (!targetProject) return "";
    const normalizedPath = relativeTo(targetProject.researchRoot, path);
    const result = await api<FileReadResult>(
      `/api/file?researchRoot=${encodeURIComponent(targetProject.researchRoot)}&path=${encodeURIComponent(normalizedPath)}`,
    );
    replaceActivePath(normalizedPath);
    replaceContent(result.content);
    replaceSavedContent(result.content);
    fileHashRef.current = result.hash;
    setLastSuccessfulSaveAt(
      saveTimesRef.current.get(absoluteLocalPath(targetProject.researchRoot, normalizedPath)) ?? null,
    );
    setSelection(null);
    setSourceFocusRequest(null);
    return result.content;
  }, [project, replaceActivePath, replaceContent, replaceSavedContent]);

  const showReviewFile = useCallback((file: ApprovalReviewFile) => {
    replaceActivePath(file.path);
    replaceContent(file.before);
    replaceSavedContent(file.before);
    fileHashRef.current = null;
    setLastSuccessfulSaveAt(null);
    setSelection(null);
    setSourceFocusRequest(null);
  }, [replaceActivePath, replaceContent, replaceSavedContent]);

  const restoreReviewContext = useCallback(async (
    targetProject: ProjectInfo,
    context: ReviewReturnContext | null,
  ) => {
    setPendingApproval(null);
    setApplyConfirmationDelayed(false);
    setApplyConfirmationMessage(null);
    reviewReturnContextRef.current = null;
    if (context?.path) {
      await openFile(context.path, targetProject);
      setSelection(context.selection);
      focusSourceLine(context.focusLine);
    } else {
      replaceActivePath(null);
      replaceContent("");
      replaceSavedContent("");
      fileHashRef.current = null;
      setSelection(null);
      setSourceFocusRequest(null);
    }
  }, [focusSourceLine, openFile, replaceActivePath, replaceContent, replaceSavedContent]);

  const recoverApproval = useCallback((approval: AgentApprovalStatus) => {
    if (activeApplyRef.current) return;
    if (pendingApproval && String(pendingApproval.id) === String(approval.requestId)) return;
    const approvalType = approval.approvalType ?? "file";
    const recovered: PendingApproval = {
      id: approval.requestId,
      provider: approval.provider ?? agentProvider,
      agentName: approval.agentName ?? agentName,
      approvalType,
      itemId: approval.itemId,
      reason: approval.reason,
      diff: approval.diff ?? "",
      files: approval.files ?? [],
      writePaths: approval.writePaths ?? [],
      writeTargets: approval.writeTargets ?? [],
    };
    if (approvalType === "file") {
      reviewReturnContextRef.current = {
        path: activePath,
        selection,
        focusLine: sourceFocusRequest?.line ?? null,
      };
    }
    setPendingApproval(recovered);
    revealWorkingTab("agent");
    setApplyConfirmationDelayed(false);
    setApplyConfirmationMessage(null);
    if (approvalType === "file" && recovered.files?.[0]) showReviewFile(recovered.files[0]);
    setAgentStatus(approvalType === "permission"
      ? "Waiting for research access approval"
      : "Waiting for your review");
  }, [activePath, agentName, agentProvider, pendingApproval, selection, showReviewFile, sourceFocusRequest, revealWorkingTab]);

  const pollAgentStatus = useCallback(async (targetProject?: ProjectInfo | null) => {
    const statusProject = targetProject ?? project;
    if (!statusProject || agentStatusInFlightRef.current) return;
    agentStatusInFlightRef.current = true;
    try {
      const storedThread = localStorage.getItem(threadKey(statusProject.researchRoot, agentProvider));
      const result = await api<AgentStatusResponse>("/api/agent/status", {
        method: "POST",
        body: JSON.stringify({
          researchRoot: statusProject.researchRoot,
          paperRoot: statusProject.paperRoot,
          threadId: storedThread,
          provider: agentProvider,
        }),
      });
      if (result.turn?.threadId) {
        localStorage.setItem(threadKey(statusProject.researchRoot, agentProvider), result.turn.threadId);
      }
      if (result.messages?.length) {
        setMessages(current => mergeAgentMessages(current, result.messages ?? [], activeAssistantRef.current));
      }
      if (result.active && result.turn) {
        setMonitoredTurn({
          threadId: result.turn.threadId,
          turnId: result.turn.turnId,
          status: result.turn.label ?? result.turn.status,
          startedAt: result.turn.startedAt,
          lastActivityAt: result.turn.lastActivityAt,
        });
        setAgentBusy(true);
        if (!result.approval) setAgentStatus(result.turn.label ?? result.turn.status);
      } else {
        const localTurn = turnMonitorRef.current;
        const activeStream = streamAbortRef.current;
        const streamStillDelivering = Boolean(
          activeStream
          && localTurn
          && Date.now() - localTurn.lastActivityAt < 90_000,
        );
        if (!streamStillDelivering) {
          setMonitoredTurn(null);
          activeStream?.abort();
          if (streamAbortRef.current === activeStream) streamAbortRef.current = null;
          setAgentBusy(false);
          if (!pendingApproval && !activeApplyRef.current) setAgentStatus("Ready");
        }
      }
      if (result.approval) {
        recoverApproval(result.approval);
      } else if (pendingApproval && !approvalBusy && !activeApplyRef.current) {
        if (pendingApproval.approvalType === "permission") {
          setPendingApproval(null);
        } else {
          await restoreReviewContext(statusProject, reviewReturnContextRef.current);
        }
        if (!result.active) setAgentStatus("Ready");
      }
    } catch {
      // The active stream remains authoritative while a status check is unavailable.
    } finally {
      agentStatusInFlightRef.current = false;
    }
  }, [agentProvider, approvalBusy, pendingApproval, project, recoverApproval, restoreReviewContext, setMonitoredTurn]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (saveQueueRef.current) return saveQueueRef.current;
    const currentProject = projectRef.current;
    const currentPath = activePathRef.current;
    if (!currentProject || !currentPath || contentRef.current === savedContentRef.current) return true;
    if (!withinPaper(currentProject, currentPath)) {
      setError("This research-context file is read only and cannot be saved from the paper editor.");
      return false;
    }

    setSaving(true);
    const operation = (async () => {
      try {
        while (true) {
          const targetProject = projectRef.current;
          const targetPath = activePathRef.current;
          const targetContent = contentRef.current;
          const targetSavedContent = savedContentRef.current;
          const expectedHash = fileHashRef.current;
          if (!targetProject || !targetPath || targetContent === targetSavedContent) return true;
          if (!withinPaper(targetProject, targetPath)) {
            throw new Error("This research-context file is read only and cannot be saved from the paper editor.");
          }

          const targetResearchRoot = targetProject.researchRoot;
          const targetPaperRoot = targetProject.paperRoot;
          const result = await api<FileSaveResult>("/api/file", {
            method: "PUT",
            body: JSON.stringify({
              researchRoot: targetResearchRoot,
              paperRoot: targetPaperRoot,
              path: targetPath,
              content: targetContent,
              expectedHash,
            }),
          });

          const latestProject = projectRef.current;
          if (
            !latestProject
            || latestProject.researchRoot !== targetResearchRoot
            || latestProject.paperRoot !== targetPaperRoot
            || activePathRef.current !== targetPath
          ) {
            setError("The previous file finished saving after the editor moved elsewhere. The current buffer was left untouched.");
            return false;
          }
          replaceSavedContent(targetContent);
          fileHashRef.current = result.hash;
          const savedAt = Date.now();
          saveTimesRef.current.set(absoluteLocalPath(targetResearchRoot, targetPath), savedAt);
          setLastSuccessfulSaveAt(savedAt);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not save the source file");
        return false;
      }
    })();
    saveQueueRef.current = operation;
    try {
      return await operation;
    } finally {
      if (saveQueueRef.current === operation) saveQueueRef.current = null;
      setSaving(false);
    }
  }, [replaceSavedContent]);

  const openFileAfterSave = useCallback(async (path: string, currentProject?: ProjectInfo) => {
    if (!(await saveNow())) return null;
    return openFile(path, currentProject);
  }, [openFile, saveNow]);

  const compile = useCallback(async (override?: { project?: ProjectInfo; mainFile?: string }) => {
    if (compilingRef.current) return false;
    if (!(await saveNow())) return false;
    if (compilingRef.current) return false;
    const targetProject = override?.project ?? project;
    const targetMain = override?.mainFile ?? mainFile;
    if (!targetProject || !targetMain) return false;
    const normalizedMain = matchPaperMain(targetProject, targetMain);
    if (!normalizedMain) {
      setError("Choose a main .tex file from inside the selected paper folder.");
      return false;
    }
    compilingRef.current = true;
    compiledPdfUrlRef.current = null;
    setCompiling(true);
    setCompileErrors([]);
    setError(null);
    try {
      const result = await api<CompileResult>("/api/compile", {
        method: "POST",
        body: JSON.stringify({
          researchRoot: targetProject.researchRoot,
          paperRoot: targetProject.paperRoot,
          mainFile: normalizedMain,
        }),
      });
      setCompileLog(result.log ?? "");
      setBuildFailed(!result.success);
      setCompileErrors((result.errors ?? []).map((entry) => {
        if (typeof entry === "string") return entry;
        const location = [entry.file, entry.line].filter(Boolean).join(":");
        return `${location ? `${location}: ` : ""}${entry.message ?? "LaTeX issue"}`;
      }));
      if (result.pdfUrl) {
        const nextBuildId = result.buildId ?? Date.now().toString();
        setBuildId(nextBuildId);
        setPdfUrl(absolutePdfUrl(result.pdfUrl, nextBuildId));
        if (result.success) compiledPdfUrlRef.current = absolutePdfUrl(result.pdfUrl, nextBuildId);
      }
      if (!result.success && !result.pdfUrl) {
        setError(result.message || "LaTeX could not produce a PDF. Open the build log for details.");
      }
      return result.success;
    } catch (reason) {
      setBuildFailed(true);
      setError(reason instanceof Error ? reason.message : "Compilation failed");
      return false;
    } finally {
      compilingRef.current = false;
      setCompiling(false);
    }
  }, [mainFile, project, saveNow]);

  const openProject = useCallback(async (researchRoot: string, paperRoot: string, preferredMain?: string) => {
    if (!(await saveNow())) return null;
    setError(null);
    const next = await api<ProjectInfo>("/api/project/open", {
      method: "POST",
      body: JSON.stringify({ researchRoot, paperRoot }),
    });
    setLastSuccessfulSaveAt(null);
    replaceProject(next);
    const nextMain = choosePaperMain(next, preferredMain);
    setMainFile(nextMain);
    localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({
      researchRoot: next.researchRoot,
      paperRoot: next.paperRoot,
      mainFile: nextMain,
    }));
    if (nextMain) {
      await openFile(nextMain, next);
      await compile({ project: next, mainFile: nextMain });
    } else {
      replaceActivePath(null);
      replaceContent("");
      replaceSavedContent("");
      fileHashRef.current = null;
    }
    return next;
  }, [compile, openFile, replaceActivePath, replaceContent, replaceProject, replaceSavedContent, saveNow]);

  const refreshProjectAfterApply = useCallback(async (activeApply: ActiveApply) => {
    const { project: previousProject, approval, returnContext } = activeApply;
    const next = await api<ProjectInfo>("/api/project/open", {
      method: "POST",
      body: JSON.stringify({
        researchRoot: previousProject.researchRoot,
        paperRoot: previousProject.paperRoot,
      }),
    });
    const reviewFiles = approval.files ?? [];
    const preferredMain = remapReviewedPath(activeApply.mainFile, reviewFiles);
    const nextMain = choosePaperMain(next, preferredMain);
    replaceProject(next);
    setMainFile(nextMain);
    localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({
      researchRoot: next.researchRoot,
      paperRoot: next.paperRoot,
      mainFile: nextMain,
    }));

    const requestedPath = remapReviewedPath(returnContext?.path ?? null, reviewFiles);
    const nextPath = requestedPath && projectContainsFile(next.tree, requestedPath)
      ? requestedPath
      : nextMain && projectContainsFile(next.tree, nextMain)
        ? nextMain
        : null;
    if (nextPath) {
      await openFile(nextPath, next);
      const returnPathChanged = reviewFiles.some((file) => file.path === returnContext?.path);
      if (!returnPathChanged && nextPath === returnContext?.path) {
        setSelection(returnContext.selection);
        focusSourceLine(returnContext.focusLine);
      }
    } else {
      replaceActivePath(null);
      replaceContent("");
      replaceSavedContent("");
      fileHashRef.current = null;
      setSelection(null);
      setSourceFocusRequest(null);
    }
    return { project: next, mainFile: nextMain };
  }, [focusSourceLine, openFile, replaceActivePath, replaceContent, replaceProject, replaceSavedContent]);

  const clearApplyPolling = useCallback(() => {
    if (applyPollTimerRef.current !== null) {
      window.clearInterval(applyPollTimerRef.current);
      applyPollTimerRef.current = null;
    }
  }, []);

  const readApplyStatus = useCallback(async (activeApply: ActiveApply) => {
    if (!activeApply.snapshotId) return null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), APPLY_STATUS_REQUEST_TIMEOUT_MS);
    try {
      return await api<ApplyStatus>("/api/changes/status", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          researchRoot: activeApply.project.researchRoot,
          paperRoot: activeApply.project.paperRoot,
          snapshotId: activeApply.snapshotId,
        }),
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  const settleActiveApply = useCallback((settlement: ApplyStatus) => {
    const activeApply = activeApplyRef.current;
    if (!activeApply || activeApply.settled) return false;
    if (
      activeApply.snapshotId
      && settlement.snapshotId
      && activeApply.snapshotId !== settlement.snapshotId
    ) return false;

    activeApply.settled = true;
    if (!activeApply.snapshotId && settlement.snapshotId) activeApply.snapshotId = settlement.snapshotId;
    activeApplyRef.current = null;
    clearApplyPolling();
    applyStatusInFlightRef.current = false;
    // The apply receipt can beat the approval HTTP response. Its caller owns
    // approvalBusy until that response settles, so the next auto-approval waits.
    setApprovalApplying(false);
    setApplyConfirmationDelayed(false);
    setApplyConfirmationMessage(null);
    setPendingApproval(null);
    reviewReturnContextRef.current = null;
    if (settlement.undoAvailable) setCanUndo(true);
    if (settlement.message) setError(settlement.message);
    setAgentStatus(settlement.applied ? "Change applied" : "Change finished");
    if (activeApply.automatic && settlement.applied) {
      setMessages(current => [...current, {
        id: `auto-approval:${activeApply.requestId}`,
        role: "assistant",
        text: `Workbench: Auto-approved file changes saved to disk.${settlement.undoAvailable ? " Undo AI edit can restore the latest edit while those files remain unchanged." : ""}`,
      }]);
    }

    setRefreshingAfterApply(true);
    const changeApplied = settlement.applied;
    void refreshProjectAfterApply(activeApply)
      .then((refreshed) => {
        setRefreshingAfterApply(false);
        const refreshedPath = activePathRef.current;
        if (changeApplied && refreshedPath) {
          const savedAt = Date.now();
          saveTimesRef.current.set(
            absoluteLocalPath(refreshed.project.researchRoot, refreshedPath),
            savedAt,
          );
          setLastSuccessfulSaveAt(savedAt);
        }
        if (refreshed.mainFile) {
          void compile({ project: refreshed.project, mainFile: refreshed.mainFile });
        }
      })
      .catch((reason) => {
        setRefreshingAfterApply(false);
        replaceActivePath(null);
        replaceContent("");
        replaceSavedContent("");
        fileHashRef.current = null;
        setSelection(null);
        setSourceFocusRequest(null);
        setError(reason instanceof Error ? reason.message : "The paper changed, but its files could not be refreshed.");
      });

    return true;
  }, [clearApplyPolling, compile, refreshProjectAfterApply, replaceActivePath, replaceContent, replaceSavedContent]);

  const markApplyConfirmationDelayed = useCallback((message: string) => {
    const activeApply = activeApplyRef.current;
    if (!activeApply || activeApply.settled) return;
    setApprovalBusy(false);
    setApprovalApplying(false);
    setApplyConfirmationDelayed(true);
    setApplyConfirmationMessage(message);
    setAgentStatus("Apply confirmation delayed");
  }, []);

  const checkApplyStatus = useCallback(async (manual = false) => {
    const activeApply = activeApplyRef.current;
    if (!activeApply || activeApply.settled) return;
    const applyAgentName = activeApply.approval.agentName ?? "agent";
    if (!activeApply.snapshotId) {
      markApplyConfirmationDelayed(
        `No apply receipt was received. Keep this review open while ${applyAgentName} finishes, then reload the paper if confirmation does not arrive.`,
      );
      return;
    }
    if (applyStatusInFlightRef.current) return;
    applyStatusInFlightRef.current = true;
    if (manual) {
      setApprovalBusy(true);
      setAgentStatus("Checking apply status…");
    }
    try {
      const status = await readApplyStatus(activeApply);
      if (activeApplyRef.current !== activeApply || activeApply.settled || !status) return;
      if (!applyStillRunning(status.status)) {
        settleActiveApply(status);
        return;
      }
      if (Date.now() >= activeApply.deadline || manual) {
        clearApplyPolling();
        markApplyConfirmationDelayed(
          status.message ?? `${applyAgentName} is still applying this change. Check again before editing the reviewed source.`,
        );
      }
    } catch (reason) {
      if (activeApplyRef.current !== activeApply || activeApply.settled) return;
      if (Date.now() >= activeApply.deadline || manual) {
        clearApplyPolling();
        const timedOut = reason instanceof DOMException && reason.name === "AbortError";
        markApplyConfirmationDelayed(timedOut
          ? "The local status check timed out. Check again before editing the reviewed source."
          : "Apply status could not be confirmed. Check again before editing the reviewed source.");
      }
    } finally {
      applyStatusInFlightRef.current = false;
      if (manual) setApprovalBusy(false);
    }
  }, [clearApplyPolling, markApplyConfirmationDelayed, readApplyStatus, settleActiveApply]);

  const checkApplyStatusRef = useRef(checkApplyStatus);
  useEffect(() => {
    checkApplyStatusRef.current = checkApplyStatus;
  }, [checkApplyStatus]);

  const startApplyPolling = useCallback((activeApply: ActiveApply) => {
    clearApplyPolling();
    activeApply.deadline = Date.now() + APPLY_RECOVERY_TIMEOUT_MS;
    void checkApplyStatusRef.current(false);
    applyPollTimerRef.current = window.setInterval(() => {
      const current = activeApplyRef.current;
      if (!current || current !== activeApply || current.settled) {
        clearApplyPolling();
        return;
      }
      if (Date.now() >= current.deadline) {
        clearApplyPolling();
        markApplyConfirmationDelayed(
          "Applying is taking longer than expected. Check status before editing the reviewed source.",
        );
        return;
      }
      void checkApplyStatusRef.current(false);
    }, APPLY_POLL_INTERVAL_MS);
  }, [clearApplyPolling, markApplyConfirmationDelayed]);

  useEffect(() => () => {
    streamAbortRef.current?.abort();
    clearApplyPolling();
    if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current);
  }, [clearApplyPolling]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    let active = true;
    async function connect() {
      try {
        const storedProvider = localStorage.getItem(AGENT_PROVIDER_KEY);
        if (storedProvider === "claude" || storedProvider === "cursor") {
          setAgentProvider(storedProvider);
        }
        const nextHealth = await api<Health>("/api/health");
        if (!active) return;
        setHealth(nextHealth);
        const stored = localStorage.getItem(LAST_PROJECT_KEY);
        if (stored) {
          const value = JSON.parse(stored) as { researchRoot: string; paperRoot: string; mainFile?: string };
          try {
            await openProject(value.researchRoot, value.paperRoot, value.mainFile);
          } catch {
            localStorage.removeItem(LAST_PROJECT_KEY);
          }
        }
      } catch {
        if (active) setHealth({ ok: false });
      }
    }
    connect();
    return () => { active = false; };
  }, [compile, openFile, openProject]);

  useEffect(() => {
    if (!project) return;
    const initialCheck = window.setTimeout(() => {
      void pollAgentStatus(project);
    }, 0);
    if (!agentBusy && !turnActive) {
      return () => window.clearTimeout(initialCheck);
    }
    const timer = window.setInterval(() => {
      void pollAgentStatus(project);
    }, AGENT_STATUS_POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(initialCheck);
      window.clearInterval(timer);
    };
  }, [agentBusy, pollAgentStatus, project, turnActive]);

  useEffect(() => {
    if (!project) return;
    let active = true;
    api<AgentSettings>(`/api/agent/settings?provider=${agentProvider}&researchRoot=${encodeURIComponent(project.researchRoot)}`)
      .then((settings) => {
        if (!active) return;
        setAgentSettings(settings);
        const availableModels = settings.models ?? [];
        const storedModel = availableModels.length
          ? localStorage.getItem(modelKey(project.researchRoot, agentProvider)) ?? ""
          : "";
        const nextModel = availableModels.length
          ? availableModels.find((model) => model.model === storedModel)?.model
            ?? availableModels.find((model) => model.model === settings.model)?.model
            ?? availableModels[0]?.model
            ?? ""
          : "";
        setSelectedModel(nextModel);
        if (storedModel && storedModel !== nextModel) {
          localStorage.removeItem(modelKey(project.researchRoot, agentProvider));
        }
        const effortSettings = availableModels.find((model) => model.model === nextModel) ?? settings;
        const storedEffort = localStorage.getItem(effortKey(project.researchRoot, agentProvider)) ?? "";
        const supported = effortSettings.supportedReasoningEfforts.some(
          (option) => option.reasoningEffort === storedEffort,
        );
        setReasoningEffort(supported ? storedEffort : "");
        if (storedEffort && !supported) {
          localStorage.removeItem(effortKey(project.researchRoot, agentProvider));
        }
      })
      .catch(() => {
        if (active) {
          setAgentSettings(null);
          setSelectedModel("");
        }
      });
    return () => { active = false; };
  }, [agentProvider, project]);

  const chooseWorkspace = async () => {
    if (agentBusy || pendingApproval) return;
    if (!(await saveNow())) return;
    setError(null);
    try {
      const research = await api<{ path?: string; canceled?: boolean }>("/api/folder/pick", {
        method: "POST",
        body: JSON.stringify({ title: "Choose the research folder containing your paper and code" }),
      });
      if (!research.path || research.canceled) return;
      const paper = await api<{ path?: string; canceled?: boolean }>("/api/folder/pick", {
        method: "POST",
        body: JSON.stringify({
          title: "Choose the paper folder (you may choose the research folder itself)",
          initialPath: research.path,
        }),
      });
      await openProject(research.path, paper.path && !paper.canceled ? paper.path : research.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open that workspace");
    }
  };

  const choosePaperFolder = async () => {
    if (!project || agentBusy || pendingApproval) return;
    if (!(await saveNow())) return;
    try {
      const result = await api<{ path?: string; canceled?: boolean }>("/api/folder/pick", {
        method: "POST",
        body: JSON.stringify({ title: "Choose the paper folder", initialPath: project.paperRoot }),
      });
      if (result.path && !result.canceled) await openProject(project.researchRoot, result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change the paper folder");
    }
  };

  const copyLocalPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedPath((current) => current === path ? null : current);
        copyFeedbackTimerRef.current = null;
      }, 1_600);
    } catch {
      setError("Could not copy the local file path.");
    }
  }, []);

  const revealLocalDestination = useCallback(async () => {
    if (!project) return;
    const revealFile = activePath
      && !activeReviewFile
      && !activeReadOnly
      && withinPaper(project, activePath)
      && projectContainsFile(project.tree, activePath)
      ? activePath
      : null;
    try {
      await api("/api/folder/reveal", {
        method: "POST",
        body: JSON.stringify({
          researchRoot: project.researchRoot,
          paperRoot: project.paperRoot,
          ...(revealFile ? { path: revealFile } : {}),
        }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not show the local save destination.");
    }
  }, [activePath, activeReadOnly, activeReviewFile, project]);

  useEffect(() => {
    if (!dirty || activeReadOnly) return;
    const timer = window.setTimeout(() => { saveNow(); }, 700);
    return () => window.clearTimeout(timer);
  }, [activeReadOnly, dirty, saveNow]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !saving) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty, saving]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void saveNow();
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [saveNow]);

  const locateSourceInPdf = async () => {
    if (!project || !mainFile || !activePath) return;
    if (!(await saveNow())) return;
    const target = selection ?? {
      path: activePath,
      startLine: 1,
      endLine: 1,
      startColumn: 1,
      endColumn: 1,
      text: "",
      origin: "source" as const,
    };
    try {
      const result = await api<Record<string, unknown>>("/api/synctex/forward", {
        method: "POST",
        body: JSON.stringify({
          researchRoot: project.researchRoot,
          paperRoot: project.paperRoot,
          mainFile,
          path: target.path,
          line: target.startLine,
          column: target.startColumn,
        }),
      });
      const candidates = (result.matches as Array<Record<string, unknown>> | undefined) ?? [];
      const match = (result.match as Record<string, unknown> | undefined)
        ?? (result.result as Record<string, unknown> | undefined)
        ?? candidates[0]
        ?? result;
      const page = Number(match.page ?? match.Page);
      const height = Number(match.height ?? match.H ?? 14);
      const x = Number(match.h ?? match.x ?? 0);
      const y = Math.max(0, Number(match.v ?? match.y ?? 0) - height);
      if (!Number.isFinite(page) || page < 1) throw new Error("No PDF location was found for this source range.");
      if (!outerResizable) setMobileSurface("paper");
      setPdfFocus({
        page,
        x,
        y,
        width: Number(match.width ?? match.W ?? 90),
        height,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not map this source range to the PDF");
    }
  };

  const handlePdfSelection = async (pdfSelection: PdfSelection) => {
    if (!project || !mainFile) return;
    setError(null);
    try {
      const mappings = await Promise.all(
        pdfSelection.points.slice(0, 8).map((point) =>
          api<Record<string, unknown>>("/api/synctex/inverse", {
            method: "POST",
            body: JSON.stringify({
              researchRoot: project.researchRoot,
              paperRoot: project.paperRoot,
              mainFile,
              page: pdfSelection.page,
              x: point.x,
              y: point.y,
            }),
          }).catch(() => null),
        ),
      );
      const normalized = mappings
        .filter(Boolean)
        .map((mapping) => {
          const result = ((mapping?.match as Record<string, unknown> | undefined)
            ?? (mapping?.result as Record<string, unknown> | undefined)
            ?? mapping) as Record<string, unknown>;
          return {
            path: relativeTo(project.researchRoot, String(result.path ?? result.input ?? result.Input ?? "")),
            line: Number(result.line ?? result.Line),
            column: Math.max(1, Number(result.column ?? result.Column ?? 1)),
          };
        })
        .filter((mapping) => mapping.path && Number.isFinite(mapping.line) && mapping.line > 0);
      if (!normalized.length) throw new Error("This PDF selection could not be mapped back to LaTeX source.");
      const primaryPath = normalized[0].path;
      const sameFile = normalized.filter((mapping) => mapping.path === primaryPath);
      const startLine = Math.min(...sameFile.map((mapping) => mapping.line));
      const endLine = Math.max(...sameFile.map((mapping) => mapping.line));
      const nextContent = await openFileAfterSave(primaryPath, project);
      if (nextContent === null) return;
      const snippet = sourceSlice(nextContent, startLine, endLine);
      focusSourceLine(startLine);
      setSelection({
        path: primaryPath,
        startLine,
        endLine,
        startColumn: sameFile[0].column,
        endColumn: sameFile.at(-1)?.column ?? 1,
        text: snippet,
        renderedText: pdfSelection.text,
        origin: "pdf",
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not map the PDF selection");
    }
  };

  const sendToAgent = async (suggestion?: string) => {
    // Quick suggestions are ordinary chat requests, not an implicit skill run.
    const skill = suggestion ? null : WORKBENCH_SKILLS.find((entry) => entry.id === skillOptions.id);
    if (skill && (health?.capabilities?.paperSkillsVersion ?? 0) < 2) {
      setError("Restart the local companion to enable the new paper skills safely.");
      return;
    }
    const message = (suggestion ?? prompt).trim() || (skill ? `Run ${skill.label}.` : "");
    if (!message || !project || !mainFile || agentBusy || pendingApproval || compilingRef.current || sendingRef.current) return;
    if (skill && skillOptions.scope === "selection" && !selection?.text.trim()) {
      setError("Select LaTeX source or PDF-mapped text before running this skill.");
      return;
    }
    if (skill && skillOptions.scope === "resources" && !skillOptions.resourcePaths?.trim()) {
      setError("Add the data files to inspect in Skill settings first.");
      return;
    }
    sendingRef.current = true;
    if (!(await saveNow())) { sendingRef.current = false; return; }
    setAgentBusy(true);
    if (!skill?.readOnly && skill?.scope !== "resources") {
      setPreparingPdfBaseline(true);
      setAgentStatus("Saving PDF comparison baseline…");
      // An audit neither compiles nor replaces the last edit's PDF baseline.
      const baselineCompiled = await compile({ project, mainFile });
      await capturePdfBaseline(baselineCompiled ? compiledPdfUrlRef.current : null);
      setPreparingPdfBaseline(false);
    }
    setPrompt("");
    setError(null);
    setAgentBusy(true);
    setAgentStatus(`Starting ${agentName}…`);
    setLatestDiff("");
    const storedThread = localStorage.getItem(threadKey(project.researchRoot, agentProvider));
    const startedAt = beginMonitoredTurn(storedThread);
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    activeAssistantRef.current = assistantId;
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", text: skill
        ? `${skill.label} · ${skillOptions.scope === "paper" ? "whole paper" : skillOptions.scope === "resources" ? "local data files" : "selected passage"}\n${message}`
        : message },
      { id: assistantId, role: "assistant", text: "" },
    ]);

    const controller = new AbortController();
    streamAbortRef.current = controller;
    try {
      const response = await fetch(`${LOCAL_API}/api/agent/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          researchRoot: project.researchRoot,
          paperRoot: project.paperRoot,
          mainFile,
          activePath,
          threadId: storedThread,
          provider: agentProvider,
          model: agentProvider === "cursor" ? null : selectedModel,
          reasoningEffort,
          prompt: message,
          selection,
          skill: skill ? skillOptions : null,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.text();
        throw new Error(body || `${agentName} request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let approvalPresented: "file" | "permission" | null = null;
      let activePresentedApproval: { id: string; approvalType: "file" | "permission" } | null = null;
      let applyLifecycleHandled = false;
      let terminalError: string | null = null;
      const consume = (event: StreamEvent) => {
        if (event.threadId) localStorage.setItem(threadKey(project.researchRoot, agentProvider), event.threadId);
        if (
          (event.type === "thread" || event.type === "settings" || event.type === "turn")
          && event.provider === agentProvider
          && event.modelConfirmed
          && event.model
        ) {
          setConfirmedAgentRuntime({
            provider: event.provider,
            model: event.model,
            requestedModel: event.requestedModel ?? null,
            reasoningEffort: event.reasoningEffort ?? null,
            runtime: event.runtime ?? agentName,
            rerouted: Boolean(event.modelRerouted),
          });
        }
        if (event.type !== "completed" && !(event.type === "error" && event.terminal)) {
          const currentTurn = turnMonitorRef.current;
          const activityAt = Date.now();
          setMonitoredTurn({
            threadId: event.threadId ?? currentTurn?.threadId ?? storedThread,
            turnId: event.turnId ?? currentTurn?.turnId ?? null,
            status: event.label ?? currentTurn?.status ?? `${agentName} is working…`,
            startedAt: currentTurn?.startedAt ?? startedAt,
            lastActivityAt: activityAt,
          });
        }
        if (event.type === "message" && event.id && event.text) {
          setMessages(current => mergeAgentMessages(current, [{
            id: event.id!, text: event.text!, revision: event.revision ?? 1,
          }], assistantId));
        } else if (event.type === "notice" && event.message) {
          setMessages(current => {
            const placeholder = current.findIndex(item => item.id === assistantId);
            const notice: ChatMessage = { id: crypto.randomUUID(), role: "assistant", text: event.message! };
            const next = [...current];
            next.splice(placeholder < 0 ? next.length : placeholder, 0, notice);
            return next;
          });
        } else if (event.type === "delta" && event.text) {
          setMessages((current) => current.map((item) =>
            item.id === assistantId ? { ...item, text: item.text + event.text } : item,
          ));
        } else if (event.type === "status" && event.label) {
          setAgentStatus(event.label);
        } else if (event.type === "diff" && event.diff !== undefined) {
          setLatestDiff(event.diff);
        } else if (event.type === "approval" && event.requestId !== undefined) {
          const approvalType = event.approvalType ?? "file";
          const files = event.files ?? [];
          approvalPresented = approvalType;
          activePresentedApproval = { id: String(event.requestId), approvalType };
          setApplyConfirmationDelayed(false);
          setApplyConfirmationMessage(null);
          revealWorkingTab("agent");
          setPendingApproval({
            id: event.requestId,
            provider: event.provider ?? agentProvider,
            agentName: event.agentName ?? agentName,
            approvalType,
            itemId: event.itemId,
            reason: event.reason,
            diff: event.diff || latestDiff || "",
            files,
            writePaths: event.writePaths ?? [],
            writeTargets: event.writeTargets ?? [],
          });
          if (approvalType === "file" && files[0]) {
            reviewReturnContextRef.current = {
              path: activePath,
              selection,
              focusLine: sourceFocusRequest?.line ?? null,
            };
            replaceActivePath(files[0].path);
            replaceContent(files[0].before);
            replaceSavedContent(files[0].before);
            fileHashRef.current = null;
            setSelection(null);
            setSourceFocusRequest(null);
          }
          setAgentStatus(approvalType === "permission"
            ? "Waiting for research access approval"
            : "Waiting for your review");
        } else if (event.type === "approvalResolved" && event.requestId !== undefined) {
          const resolvedRequestId = String(event.requestId);
          if (activePresentedApproval?.id === resolvedRequestId) {
            const resolvedApproval = activePresentedApproval;
            activePresentedApproval = null;
            if (resolvedApproval.approvalType === "permission") {
              setPendingApproval((current) => (
                current && String(current.id) === resolvedRequestId ? null : current
              ));
              setAgentStatus(`Research access request closed; ${agentName} is continuing…`);
            } else {
              const returnContext = reviewReturnContextRef.current;
              void restoreReviewContext(project, returnContext).catch((reason) => {
                setError(reason instanceof Error ? reason.message : "Could not restore the source after review closed");
              });
              setAgentStatus(`Review request closed; ${agentName} is continuing…`);
            }
          }
        } else if (event.type === "applyCompleted") {
          const activeApply = activeApplyRef.current;
          const snapshotId = event.snapshotId ?? activeApply?.snapshotId ?? null;
          if (activeApply && snapshotId) {
            if (!activeApply.snapshotId) activeApply.snapshotId = snapshotId;
            applyLifecycleHandled = settleActiveApply({
              snapshotId,
              status: event.status ?? "completed",
              applied: event.applied ?? false,
              undoAvailable: event.undoAvailable ?? false,
              message: event.message,
            }) || applyLifecycleHandled;
          }
        } else if (event.type === "error") {
          setError(event.message || `${agentName} encountered an error`);
          if (event.terminal) {
            terminalError = event.message || `${agentName} could not start`;
            setMonitoredTurn(null);
            setAgentStatus("Ready");
            setPrompt(current => current || message);
          }
        } else if (event.type === "completed") {
          setMonitoredTurn(null);
          const activeApply = activeApplyRef.current;
          if (activeApply) {
            applyLifecycleHandled = true;
            markApplyConfirmationDelayed(
              activeApply.snapshotId
                ? `The ${agentName} turn completed. Verifying the approved file state before unlocking the source.`
                : `The ${agentName} turn completed without an apply receipt. Keep this review open until local status is confirmed.`,
            );
            if (activeApply.snapshotId) void checkApplyStatusRef.current(false);
          } else {
            setAgentStatus("Ready");
            if (event.undoAvailable) setCanUndo(true);
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try { consume(JSON.parse(line) as StreamEvent); } catch { /* ignore malformed progress */ }
        }
        if (done) break;
      }
      if (buffer.trim()) consume(JSON.parse(buffer) as StreamEvent);
      const recoveringTurn = turnMonitorRef.current !== null;
      setMessages((current) => current.map((item) =>
        item.id === assistantId && !item.text
          ? {
            ...item,
            text: terminalError ?? (approvalPresented === "permission"
              ? "I requested turn-only access to write research-support outputs."
              : approvalPresented === "file"
                ? "I prepared source changes for your review."
              : recoveringTurn
                ? "The live connection ended; I’m recovering this turn."
                : "Done."),
          }
          : item,
      ));
      if (activeApplyRef.current && !applyLifecycleHandled) {
        markApplyConfirmationDelayed(
          `The ${agentName} stream ended before apply confirmation arrived. Status checks can still confirm the local change.`,
        );
      } else if (!applyLifecycleHandled && activePath) {
        await openFileAfterSave(activePath, project);
      }
    } catch (reason) {
      if (activeApplyRef.current) {
        markApplyConfirmationDelayed(
          `The ${agentName} stream was interrupted before apply confirmation arrived. Check status before editing the reviewed source.`,
        );
      }
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        setError(reason instanceof Error ? reason.message : `${agentName} request failed`);
      }
    } finally {
      sendingRef.current = false;
      streamAbortRef.current = null;
      activeAssistantRef.current = null;
      setAgentBusy(turnMonitorRef.current !== null);
    }
  };

  const decideApproval = async (decision: "accept" | "decline" | "cancel", automatic = false): Promise<boolean> => {
    if (!pendingApproval || !project || approvalDecisionInFlightRef.current || activeApplyRef.current) return false;
    if (automatic && (decision !== "accept" || pendingApproval.approvalType !== "file")) return false;
    approvalDecisionInFlightRef.current = true;
    const approval = pendingApproval;
    const permissionApproval = approval.approvalType === "permission";
    const returnContext = reviewReturnContextRef.current;
    let activeApply: ActiveApply | null = null;
    if (decision === "accept" && !permissionApproval) {
      const reviewFileForLock = activeReviewFile ?? approval.files?.[0];
      if (reviewFileForLock) showReviewFile(reviewFileForLock);
      activeApply = {
        requestId: approval.id,
        snapshotId: null,
        approval,
        project,
        mainFile,
        returnContext,
        deadline: Date.now() + APPLY_RECOVERY_TIMEOUT_MS,
        settled: false,
        automatic,
      };
      activeApplyRef.current = activeApply;
      setApprovalApplying(true);
      setApplyConfirmationDelayed(false);
      setApplyConfirmationMessage(null);
      setAgentStatus(automatic ? "Auto-approving change…" : "Approving change…");
    } else if (permissionApproval) {
      setAgentStatus(decision === "accept"
        ? "Allowing research access for this turn…"
        : "Declining research access…");
    }
    setApprovalBusy(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), APPROVAL_REQUEST_TIMEOUT_MS);
    try {
      const result = await api<{
        ok: boolean;
        approvalType?: "file" | "permission";
        decision: string;
        snapshotId?: string | null;
      }>("/api/agent/approval", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          requestId: approval.id,
          decision,
          researchRoot: project.researchRoot,
          paperRoot: project.paperRoot,
        }),
      });
      if (permissionApproval) {
        const continuingStatus = decision === "accept"
          ? `Research access allowed; ${agentName} is continuing…`
          : `Research access declined; ${agentName} is continuing…`;
        setPendingApproval(null);
        setAgentStatus(continuingStatus);
        const monitored = turnMonitorRef.current;
        if (monitored) {
          setMonitoredTurn({
            ...monitored,
            status: continuingStatus,
            lastActivityAt: Date.now(),
          });
        }
      } else if (decision === "accept") {
        if (!activeApply || activeApplyRef.current !== activeApply || activeApply.settled) return true;
        activeApply.snapshotId = result.snapshotId ?? null;
        setAgentStatus(automatic ? "Applying auto-approved change…" : "Applying approved change…");
        if (activeApply.snapshotId) {
          startApplyPolling(activeApply);
        } else {
          markApplyConfirmationDelayed(
            `The local companion did not return an apply receipt. Keep this review open until the ${agentName} stream confirms the change.`,
          );
        }
      } else {
        setAgentStatus("Change declined");
        await restoreReviewContext(project, returnContext);
      }
      return true;
    } catch (reason) {
      const approvalTimedOut = decision === "accept"
        && reason instanceof DOMException
        && reason.name === "AbortError";
      if (permissionApproval) {
        setAgentStatus(approvalTimedOut
          ? "Checking research access status…"
          : "Waiting for research access approval");
        if (approvalTimedOut) void pollAgentStatus(project);
      } else if (decision === "accept") {
        if (approvalTimedOut && activeApplyRef.current === activeApply && activeApply && !activeApply.settled) {
          markApplyConfirmationDelayed(
            `Approval confirmation timed out. Keep this review open while ${agentName} finishes, then check the local change status.`,
          );
        } else if (activeApplyRef.current === activeApply && activeApply) {
          activeApply.settled = true;
          activeApplyRef.current = null;
          clearApplyPolling();
          setApprovalApplying(false);
          setApplyConfirmationDelayed(false);
          setApplyConfirmationMessage(null);
          setAgentStatus("Waiting for your review");
        }
      }
      if (!approvalTimedOut) {
        setError(reason instanceof Error ? reason.message : "Could not send your decision");
      }
      return false;
    } finally {
      window.clearTimeout(timeout);
      approvalDecisionInFlightRef.current = false;
      setApprovalBusy(false);
    }
  };

  const stopAgentTurn = async () => {
    if (
      !project
      || stoppingTurn
      || approvalBusy
      || approvalApplying
      || applyConfirmationDelayed
      || refreshingAfterApply
      || activeApplyRef.current
      || !turnMonitorRef.current?.turnId
    ) return;
    const monitored = turnMonitorRef.current;
    const stoppingPermissionApproval = pendingApproval?.approvalType === "permission";
    const storedThread = localStorage.getItem(threadKey(project.researchRoot, agentProvider));
    setStoppingTurn(true);
    setAgentStatus(`Stopping ${agentName}…`);
    try {
      const result = await api<StopTurnResponse>("/api/agent/stop", {
        method: "POST",
        body: JSON.stringify({
          researchRoot: project.researchRoot,
          paperRoot: project.paperRoot,
          threadId: monitored.threadId ?? storedThread,
          turnId: monitored.turnId,
          provider: agentProvider,
        }),
      });
      streamAbortRef.current?.abort();
      if (result.approvalDeclined && !activeApplyRef.current) {
        if (stoppingPermissionApproval) {
          setPendingApproval(null);
        } else {
          await restoreReviewContext(project, reviewReturnContextRef.current);
        }
      }
      if (result.status === "idle") {
        setMonitoredTurn(null);
        setAgentBusy(false);
        setAgentStatus("Ready");
      } else {
        setMonitoredTurn({
          ...monitored,
          status: `Stopping ${agentName}…`,
          lastActivityAt: Date.now(),
        });
      }
      void pollAgentStatus(project);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not stop the ${agentName} turn`);
      setAgentStatus(monitored.status || `${agentName} is working…`);
    } finally {
      setStoppingTurn(false);
    }
  };

  const undoLastChange = async () => {
    if (!project || !canUndo) return;
    if (!(await saveNow())) return;
    try {
      await api("/api/changes/undo", {
        method: "POST",
        body: JSON.stringify({ researchRoot: project.researchRoot, paperRoot: project.paperRoot }),
      });
      setCanUndo(false);
      await openProject(project.researchRoot, project.paperRoot, mainFile ?? undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not undo the last accepted change");
    }
  };

  const resizePane = (pane: "source" | "agent", pixels: number) => {
    const maximum = pane === "source" ? fittedPanes.sourceMax : fittedPanes.agentMax;
    const percent = clamp(pixels, fittedPanes.minimum, maximum) / (workspaceWidth || 1440) * 100;
    setPaneLayout(current => ({ ...current, [pane]: percent }));
  };
  const paneHandle = (pane: "source" | "agent") => <ResizeHandle
    className={`${pane}-resizer`} orientation="vertical" label={`Resize ${pane} pane`}
    controls={pane === "source" ? "source-tool-panel document-pane" : "document-pane codex-pane"}
    value={fittedPanes[pane]} min={fittedPanes.minimum} max={pane === "source" ? fittedPanes.sourceMax : fittedPanes.agentMax}
    valueText={`${Math.round(fittedPanes[pane])} pixels wide`} disabled={!outerResizable || !(pane === "source" ? sourceVisible : agentVisible)}
    onDragStart={() => { paneDragStartRef.current = fittedPanes; setActiveResize("columns"); }}
    onDrag={delta => resizePane(pane, paneDragStartRef.current[pane] + (pane === "source" ? delta : -delta))}
    onDragEnd={() => setActiveResize(null)}
    onNudge={delta => resizePane(pane, fittedPanes[pane] + (pane === "source" ? delta : -delta))}
    onBoundary={boundary => resizePane(pane, boundary === "min" ? fittedPanes.minimum : pane === "source" ? fittedPanes.sourceMax : fittedPanes.agentMax)}
    onReset={() => setPaneLayout(current => ({ ...current, [pane]: DEFAULT_PANES[pane] }))}
  />;
  const paneStyles = { "--source-width": `${fittedPanes.source}px`, "--agent-width": `${fittedPanes.agent}px` } as CSSProperties;

  const selectedLabel = selection
    ? `${nameOf(selection.path)} · L${selection.startLine}${selection.endLine !== selection.startLine ? `–${selection.endLine}` : ""}`
    : null;

  const mainOptions = project
    ? paperMainCandidates(project).map((candidate) => relativeTo(project.researchRoot, candidate.path))
    : [];

  const savePresentation = (() => {
    if (!activePath) return null;
    if (activeReviewFile && approvalApplying) {
      return { kind: "saving", label: "Saving approved change to disk…", detail: null };
    }
    if (activeReviewFile && applyConfirmationDelayed) {
      return { kind: "pending", label: "Write awaiting confirmation", detail: null };
    }
    if (activeReviewFile) {
      return { kind: "proposal", label: "Proposal only", detail: "not written yet" };
    }
    if (refreshingAfterApply) {
      return { kind: "saving", label: "Refreshing saved files…", detail: null };
    }
    if (activeReadOnly) return { kind: "readonly", label: "Read only", detail: null };
    if (saving) return { kind: "saving", label: "Saving to disk…", detail: null };
    if (dirty) return { kind: "unsaved", label: "Unsaved changes", detail: null };
    if (lastSuccessfulSaveAt) {
      return {
        kind: "saved",
        label: "Saved to disk",
        detail: formatSaveTime(lastSuccessfulSaveAt),
      };
    }
    return { kind: "on-disk", label: "On disk", detail: null };
  })();

  return (
    <ThemeProvider colorMode={dark ? "dark" : "light"}><BaseStyles>
    <main
      className={`lattice-app primer-workbench ${sourceVisible ? "" : "source-collapsed"} ${agentVisible ? "" : "agent-collapsed"} mobile-${mobileSurface} ${activeResize ? `resizing-${activeResize}` : ""}`}
      style={paneStyles}
    >
      <header className="topbar">
        <div className="brand">
          <BookIcon size={22} />
          <strong>Local LaTeX Workbench</strong>
        </div>

        <Button variant="invisible" className="workspace-picker" onClick={chooseWorkspace} disabled={agentBusy || Boolean(pendingApproval)}
          aria-label="Choose research workspace" title={project?.researchRoot ?? "Choose a research folder"} trailingVisual={ChevronDown}>
          {project ? nameOf(project.researchRoot) : "Choose a folder"}
        </Button>


        <div className="topbar-spacer" />
        <Button className="desk-files-button" leadingVisual={FileDirectoryIcon} onClick={() => setExplorerOpen(true)} aria-haspopup="dialog" aria-label="Paper files">Files</Button>
        <div className="desktop-pane-toggles">
          <Button ref={sourceToggleRef} variant="invisible" leadingVisual={CodeIcon} aria-pressed={sourceVisible} aria-controls="source-tool-panel" onClick={() => setSourceVisible(value => !value)}>Source</Button>
          <Button ref={agentToggleRef} variant="invisible" leadingVisual={CommentDiscussionIcon} aria-pressed={agentVisible} aria-controls="codex-pane" onClick={() => setAgentVisible(value => !value)}>Agent</Button>
        </div>
        <span className={`connection-pill ${providerHealth?.authenticated ? "connected" : ""}`} title={providerHealth?.label}>
          <span /> {health === null ? "Connecting" : providerHealth?.authenticated ? `${agentName} subscription` : `${agentName} offline`}
        </span>


        {canUndo ? <IconButton icon={RotateCcw} aria-label="Undo last AI edit" onClick={undoLastChange} /> : null}
        <IconButton variant="invisible" icon={dark ? SunIcon : MoonIcon} aria-label={dark ? "Use light theme" : "Use dark theme"} onClick={() => {
          setDark(!dark); try { localStorage.setItem("lattice:theme", dark ? "light" : "dark"); } catch { /* Optional preference. */ }
        }} />
        <Button className="compile-button" variant="primary" onClick={() => compile()} disabled={!mainFile || compiling || preparingPdfBaseline}>
          {compiling ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
          {compiling ? "Compiling" : "Compile"}
        </Button>
      </header>

      <nav className="mobile-workspace-nav" aria-label="Workspace views">
        <SegmentedControl aria-label="Workspace view" fullWidth onChange={index => setMobileSurface((["source", "paper", "agent"] as const)[index])}>
          <SegmentedControl.Button selected={mobileSurface === "source"}>Source</SegmentedControl.Button>
          <SegmentedControl.Button selected={mobileSurface === "paper"}>Paper</SegmentedControl.Button>
          <SegmentedControl.Button selected={mobileSurface === "agent"}>{pendingApproval ? "Agent · Review" : "Agent"}</SegmentedControl.Button>
        </SegmentedControl>
      </nav>

      {error ? (
        <div className="error-banner" role="alert">
          <CircleAlert size={15} /> <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={14} /></button>
        </div>
      ) : null}

      <div ref={workspaceGridRef} className="workspace-grid">
        <section id="document-pane" className="document-workspace" aria-label="Paper canvas">
          <div className="paper-toolbar">
            <div className="paper-heading"><BookOpen size={18} /><strong>{project ? nameOf(project.paperRoot) : "Your paper"}</strong></div>
        {project ? (
          <label className="main-file-picker">
            <span>Main</span>
            <Select
              value={mainFile ?? ""}
              disabled={agentBusy || Boolean(pendingApproval)}
              onChange={async (event) => {
                const value = event.target.value;
                if (!(await saveNow())) return;
                setMainFile(value);
                localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({
                  researchRoot: project.researchRoot,
                  paperRoot: project.paperRoot,
                  mainFile: value,
                }));
                await openFile(value, project);
                await compile({ mainFile: value });
              }}
            >
              {mainOptions.map((path) => <option key={path}>{path}</option>)}
            </Select>
          </label>
        ) : null}


            <Label variant="secondary" className="paper-format">PDF</Label>
          </div>
            <section id="preview-pane" className="preview-pane">
              <div className="pane-label">
                <span>Rendered paper</span>
                <small>select text to reveal its source</small>
              </div>
              <PdfViewer
                key={project && mainFile
                  ? `${project.researchRoot}\n${project.paperRoot}\n${mainFile}`
                  : "no-paper-preview"}
                url={pdfUrl}
                buildId={buildId}
                focus={pdfFocus}
                compiling={compiling}
                baseline={pdfBaseline}
                buildFailed={buildFailed}
                onSelect={handlePdfSelection}
              />
            </section>

          <footer className="build-status">
            <button onClick={() => setLogOpen((value) => !value)} disabled={!compileLog}>
              <span className={`build-dot ${compileErrors.length ? "warning" : pdfUrl ? "success" : "idle"}`} />
              {compiling ? "Building…" : compileErrors.length ? `${compileErrors.length} LaTeX ${compileErrors.length === 1 ? "issue" : "issues"}` : pdfUrl ? "Build is current" : "No build yet"}
              {compileLog ? <ChevronDown size={12} className={logOpen ? "rotated" : ""} /> : null}
            </button>
            <span>{selection ? `${selection.origin === "pdf" ? "PDF mapped to" : "Selected"} ${selectedLabel}` : `Select source or rendered text to focus ${agentName}`}</span>
          </footer>
          {logOpen ? <pre className="compile-log">{compileErrors.join("\n") || compileLog}</pre> : null}

        </section>

        {paneHandle("source")}
          <section id="source-tool-panel" className="source-tool-panel" aria-label="LaTeX source">
          <div className="workspace-pane-heading"><CodeIcon /><strong>Source</strong><Label variant="secondary">LaTeX</Label>
            <IconButton className="pane-close" icon={XIcon} variant="invisible" size="small" aria-label="Hide source" onClick={() => hidePane("source")} />
          </div>
          <div className="document-toolbar">
            <div className="document-tab" title={activeSourceDiskPath ?? undefined}>
              <FileCode2 size={14} />
              <span>{activePath ? nameOf(activePath) : "Source"}</span>
              {dirty ? <i title="Unsaved changes" /> : null}
            </div>
            {project ? (
              <div className="active-disk-path">
                <span className="path-prefix">Local path</span>
                <code title={activeSourceDiskPath ?? project.paperRoot}>
                  {activeSourceDiskPath ?? project.paperRoot}
                </code>
                {activeSourceDiskPath ? (
                  <button
                    type="button"
                    className="path-action"
                    onClick={() => { void copyLocalPath(activeSourceDiskPath); }}
                    aria-label="Copy full local source path"
                    title="Copy full local source path"
                  >
                    {copiedPath === activeSourceDiskPath ? <Check size={11} /> : <Copy size={11} />}
                    <span>{copiedPath === activeSourceDiskPath ? "Copied" : "Copy path"}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="path-action"
                  onClick={() => { void revealLocalDestination(); }}
                  aria-label={activePath && !activeReviewFile && !activeReadOnly
                    ? "Show source file in Finder"
                    : "Show paper folder in Finder"}
                  title={activePath && !activeReviewFile && !activeReadOnly
                    ? "Show source file in Finder"
                    : "Show paper folder in Finder"}
                >
                  <FolderOpen size={11} />
                  <span>Show in Finder</span>
                </button>
              </div>
            ) : null}
            {savePresentation ? (
              <button
                type="button"
                className={`save-state save-state-${savePresentation.kind}`}
                aria-live="polite"
                onClick={() => { void saveNow(); }}
                disabled={saving || activeReadOnly || Boolean(activeReviewFile)}
                title={lastSuccessfulSaveAt && savePresentation.kind === "saved"
                  ? `Last successful local save: ${new Date(lastSuccessfulSaveAt).toLocaleString()}`
                  : `${savePresentation.label}${activeReadOnly || activeReviewFile ? "" : " · Save now (Cmd/Ctrl+S)"}`}
              >
                {savePresentation.kind === "saving" ? <LoaderCircle className="spin" size={12} />
                  : savePresentation.kind === "unsaved" ? <Save size={12} />
                    : savePresentation.kind === "proposal" || savePresentation.kind === "pending" ? <GitCompareArrows size={12} />
                      : <Check size={12} />}
                <span>{savePresentation.label}</span>
                {savePresentation.detail ? <small>· {savePresentation.detail}</small> : null}
              </button>
            ) : null}
          </div>


            <section id="source-pane" className="source-pane">
              <div className="pane-label">
                <span>{activeReviewFile ? "Source review" : "LaTeX source"}</span>
                <small>{activeReviewFile ? "current / proposed" : activeReadOnly ? "research context · read only" : "paper file"}</small>
              </div>
              <SourceEditor
                path={activePath}
                content={content}
                readOnly={activeReadOnly}
                focusRequest={sourceFocusRequest}
                review={activeReviewFile}
                onChange={replaceContent}
                onSelection={setSelection}
                onLocatePdf={locateSourceInPdf}
              />
            </section>

            <footer className="source-context-actions">
              <span>{selectedLabel ? `Selected: ${selectedLabel}` : "Select a passage to give your agent context."}</span>
              <Button size="small" onClick={() => { revealWorkingTab("agent"); requestAnimationFrame(() => composerRef.current?.focus()); }}>{pendingApproval ? "Review changes" : "Ask agent"}</Button>
            </footer>
          </section>
        {paneHandle("agent")}
        <section id="codex-pane" className="agent-panel" aria-label="Agent conversation">
          <div className="workspace-pane-heading"><CommentDiscussionIcon /><strong>Agent</strong>
            {pendingApproval ? <Label variant="attention">Review</Label> : null}
            <IconButton className="pane-close" icon={XIcon} variant="invisible" size="small" aria-label="Hide agent" onClick={() => hidePane("agent")} />
          </div>
          <div className="agent-header">
            <div className="agent-avatar"><Sparkles size={17} /></div>
            <div>
              <strong>{agentName}</strong>
              {confirmedRuntimeLabel ? (
                <small
                  className={`agent-runtime${confirmedAgentRuntime?.rerouted ? " is-rerouted" : ""}`}
                  title={confirmedAgentRuntime?.rerouted
                    ? `${confirmedAgentRuntime.runtime} rerouted ${confirmedAgentRuntime.requestedModel} to ${confirmedAgentRuntime.model}`
                    : `${confirmedAgentRuntime?.runtime} confirmed ${confirmedAgentRuntime?.model}`}
                >
                  {confirmedRuntimeLabel} · {confirmedRuntimeState}
                </small>
              ) : null}
            </div>
            <span className={`agent-status ${agentBusy || turnActive ? "busy" : ""}`}>{agentStatus}</span>
          </div>

          <div className="agent-controls" aria-label="Agent configuration">
        <label className="reasoning-picker" title="Choose which local subscription-backed agent to use">
          <Bot size={13} />
          <span>Agent</span>
          <Select
            value={agentProvider}
            disabled={agentBusy || Boolean(pendingApproval)}
            onChange={(event) => {
              const next = event.target.value as AgentProvider;
              setAgentProvider(next);
              localStorage.setItem(AGENT_PROVIDER_KEY, next);
              setAgentSettings(null);
              setSelectedModel("");
              setReasoningEffort("");
              setConfirmedAgentRuntime(null);
              setMessages([]);
              setLatestDiff("");
              setAgentStatus("Ready");
              setError(null);
            }}
            aria-label="AI agent provider"
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
            <option value="cursor">Cursor Agent</option>
          </Select>
        </label>

        {project && agentProvider !== "cursor" ? (
          <label
            className="reasoning-picker"
            title={selectedModelSettings?.description || `Choose a model advertised by your signed-in ${agentName} subscription`}
          >
            <Cpu size={13} />
            <span>Model</span>
            <Select
              value={selectedModel}
              disabled={agentBusy || Boolean(pendingApproval) || !agentSettings?.models?.length}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedModel(value);
                if (value) localStorage.setItem(modelKey(project.researchRoot, agentProvider), value);
                else localStorage.removeItem(modelKey(project.researchRoot, agentProvider));
                const nextSettings = agentSettings?.models?.find((model) => model.model === value);
                if (
                  reasoningEffort
                  && !nextSettings?.supportedReasoningEfforts.some(
                    (option) => option.reasoningEffort === reasoningEffort,
                  )
                ) {
                  setReasoningEffort("");
                  localStorage.removeItem(effortKey(project.researchRoot, agentProvider));
                }
              }}
              aria-label={`${agentName} model`}
            >
              {agentSettings?.models?.length ? agentSettings.models.map((model) => (
                <option key={model.model} value={model.model}>
                  {modelOptionLabel(model)}
                </option>
              )) : (
                <option value="">Models unavailable</option>
              )}
            </Select>
          </label>
        ) : null}

        {project ? (
          <label
            className="reasoning-picker"
            title={intelligenceSettings?.displayName
              ? `Reasoning effort for ${intelligenceSettings.displayName}`
              : `${agentName} reasoning effort`}
          >
            <Sparkles size={13} />
            <span>Intelligence</span>
            <Select
              value={reasoningEffort}
              disabled={agentBusy || Boolean(pendingApproval)}
              onChange={(event) => {
                const value = event.target.value;
                setReasoningEffort(value);
                if (value) localStorage.setItem(effortKey(project.researchRoot, agentProvider), value);
                else localStorage.removeItem(effortKey(project.researchRoot, agentProvider));
              }}
              aria-label={`${agentName} intelligence level`}
            >
              <option value="">
                {intelligenceSettings?.defaultReasoningEffort
                  ? `Default · ${effortLabel(intelligenceSettings.defaultReasoningEffort)}`
                  : "Default"}
              </option>
              {intelligenceSettings?.supportedReasoningEfforts.map((option) => (
                <option key={option.reasoningEffort} value={option.reasoningEffort}>
                  {effortLabel(option.reasoningEffort)}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

          </div>

          {turnMonitor ? (
            <div className={`turn-monitor${turnTakingLong ? " is-delayed" : ""}`} role="status" aria-live="polite">
              <div className="turn-monitor-copy">
                <span className="turn-monitor-title">
                  <LoaderCircle className="spin" size={13} />
                  {turnTakingLong ? "Taking longer than usual" : turnMonitor.status || `${agentName} is working…`}
                </span>
                <span className="turn-monitor-time">{formatElapsed(turnElapsed)} elapsed</span>
              </div>
              <button
                type="button"
                className="turn-stop-button"
                onClick={() => { void stopAgentTurn(); }}
                disabled={stoppingTurn || approvalBusy || stopLockedForApply || !turnInterruptible}
                title={!turnInterruptible
                  ? `${agentName} is still starting`
                  : approvalBusy || stopLockedForApply
                    ? "Wait for the approved change to finish"
                    : `Stop this ${agentName} turn`}
              >
                {stoppingTurn ? <LoaderCircle className="spin" size={12} /> : <Square size={11} fill="currentColor" />}
                {stoppingTurn ? "Stopping…" : "Stop"}
              </button>
            </div>
          ) : null}

          <AutoApproval
            key={JSON.stringify([project?.researchRoot, project?.paperRoot, mainFile, agentProvider])}
            approval={pendingApproval}
            busy={approvalBusy || approvalApplying || applyConfirmationDelayed || refreshingAfterApply || stoppingTurn}
            disabled={!project}
            onApprove={() => decideApproval("accept", true)}
          />

          {pendingApproval ? (
            <DiffViewer
              approval={pendingApproval}
              activePath={activePath}
              busy={approvalBusy || approvalApplying}
              confirmationDelayed={applyConfirmationDelayed}
              confirmationMessage={applyConfirmationMessage}
              onAccept={() => decideApproval("accept")}
              onReject={() => decideApproval("decline")}
              onCheckStatus={() => { void checkApplyStatus(true); }}
              onOpenFile={(path) => {
                const file = pendingApproval.files?.find((candidate) => candidate.path === path);
                if (file) { showReviewFile(file); revealWorkingTab("source"); }
              }}
            />
          ) : (
            <>
              <div ref={chatScrollRef} className="chat-scroll">
                {!messages.length ? (
                  <div className="agent-welcome">
                    <span className="welcome-mark"><MessageSquareText size={20} /></span>
                    <h2>Revise in context.</h2>
                    <p>
                      {agentName} can read the paper, equations, figures, references, and the code around them.
                      {agentProvider === "codex"
                        ? " Source edits wait for your approval unless you enable Auto-approve edits. To rerun code or generate non-paper outputs, Codex may ask for turn-only access to the smallest research-output folder it needs; command network access stays off."
                        : ` ${agentName} runs in proposal-only mode: it cannot write or run commands. The workbench applies its proposals after manual approval, or automatically when Auto-approve edits is on.`}
                    </p>
                    <div className="suggestion-list">
                      {[
                        "Tighten this passage without changing its claims",
                        "Check whether this equation is explained clearly",
                        "Make the notation consistent across the paper",
                      ].map((suggestion) => (
                        <button key={suggestion} onClick={() => sendToAgent(suggestion)} disabled={!project || !selection}>
                          <Sparkles size={12} /> {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : messages.map((message) => (
                  <article className={`chat-message ${message.role}`} key={message.id}>
                    <span>{message.role === "assistant" ? <Bot size={13} /> : "You"}</span>
                    {message.role === "assistant" ? <PaperCheckMessage
                      text={message.text}
                      busy={agentBusy}
                      onOpenSource={(path, line) => {
                        void openFileAfterSave(path).then((opened) => {
                          if (opened !== null) { setSelection(null); focusSourceLine(line); }
                        }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open finding source"));
                      }}
                    /> : <p>{message.text}</p>}
                  </article>
                ))}
                {latestDiff && !pendingApproval && agentBusy ? (
                  <div className="diff-preparing"><GitCompareArrows size={14} /> Preparing a reviewable patch…</div>
                ) : null}
              </div>

              <div className="composer-wrap">
                <SkillControls key={JSON.stringify([project?.researchRoot, project?.paperRoot])}
                  settingsKey={JSON.stringify([project?.researchRoot, project?.paperRoot])}
                  value={skillOptions} onChange={setSkillOptions}
                  disabled={!project || agentBusy || compiling || (health?.capabilities?.paperSkillsVersion ?? 0) < 2}
                  hasSelection={Boolean(selection?.text.trim())} />
                {project && health?.ok && (health.capabilities?.paperSkillsVersion ?? 0) < 2 ? (
                  <p className="skill-description">Restart the local companion to enable paper skills.</p>
                ) : null}
                {selectedLabel ? (
                  <div className="selection-chip">
                    <span>{selection?.origin === "pdf" ? "PDF → LaTeX" : "Selected source"}</span>
                    <strong>{selectedLabel}</strong>
                    <button onClick={() => setSelection(null)} aria-label="Clear selection"><X size={12} /></button>
                  </div>
                ) : null}
                <div className="composer">
                  <textarea
                    ref={composerRef}
                    aria-label="Message to agent"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        sendToAgent();
                      }
                    }}
                    placeholder={!project ? "Open a paper to begin…" : skillOptions.id
                      ? "Optional instructions for this skill…" : `Ask ${agentName} to revise, check, or explain…`}
                    disabled={!project || agentBusy}
                    rows={3}
                  />
                  <button
                    className="send-button"
                    onClick={() => sendToAgent()}
                    disabled={(!prompt.trim() && !skillOptions.id) || !project || !mainFile || agentBusy || compiling
                      || Boolean(skillOptions.id && skillOptions.scope === "selection" && !selection?.text.trim())}
                    aria-label={skillOptions.id
                      ? `Run ${WORKBENCH_SKILLS.find((entry) => entry.id === skillOptions.id)?.label}` : `Send to ${agentName}`}
                  >
                    {agentBusy ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={16} />}
                  </button>
                </div>
                <p className="composer-note">
                  {selection
                    ? "Selection is the primary target · related paper edits are allowed when needed"
                    : `Uses your ${AGENT_SUBSCRIPTIONS[agentProvider]} subscription · no API key`}
                </p>
              </div>
            </>
          )}
        </section>

      </div>

      <WorkbenchDialog open={explorerOpen} title="Paper files" description="Files in your paper folder. The agent can also read the surrounding research context."
        className="paper-files-dialog" onClose={() => setExplorerOpen(false)}>
        <div id="paper-files-pane" className="paper-files-browser">
          {project ? (
            <button className="paper-root-card" onClick={choosePaperFolder} disabled={agentBusy || Boolean(pendingApproval)}>
              <span className="paper-root-icon"><FileCode2 size={15} /></span>
              <span>
                <small>Paper folder · local destination</small>
                <strong title={project.paperRoot}>{project.paperRoot}</strong>
              </span>
              <RefreshCw size={12} />
            </button>
          ) : null}
          <FileTree
            nodes={project?.tree ?? []}
            activePath={activePath}
            paperRoot={project ? relativeTo(project.researchRoot, project.paperRoot) : null}
            onOpen={(path) => {
              if ((approvalApplying || applyConfirmationDelayed) && pendingApproval) {
                const reviewFile = pendingApproval.files?.find((file) => file.path === path);
                if (reviewFile) { showReviewFile(reviewFile); revealWorkingTab("source"); setExplorerOpen(false); }
                return;
              }
              void openFileAfterSave(path).then((opened) => {
                if (opened !== null) { revealWorkingTab("source"); setExplorerOpen(false); }
              }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open file"));
            }}
          />

        </div>
      </WorkbenchDialog>

      {!project ? (
        <div className="onboarding-overlay">
          <section className="onboarding-card">
            <h1>Your paper, its source, and your chosen agent—in one view.</h1>
            <p>Choose the research folder that holds your code and data, then the paper folder inside it. The workbench keeps both in context while edits remain yours to approve.</p>
            <button className="button primary onboarding-button" onClick={chooseWorkspace}>
              <FolderOpen size={16} /> Choose research workspace
            </button>
            <div className="onboarding-points">
              <span><Check size={13} /> Codex, Claude Code, or Cursor sign-in</span>
              <span><Check size={13} /> Local LaTeX toolchain</span>
              <span><Check size={13} /> Diff, approve, undo</span>
            </div>
            {health && !health.ok ? <small className="companion-warning">Start the local companion and sign in to one supported agent to enable the full workspace.</small> : null}
          </section>
        </div>
      ) : null}
    </main>
    </BaseStyles></ThemeProvider>
  );
}
