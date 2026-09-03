export const LOCAL_API = "http://127.0.0.1:4317";

export type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
};

export type TexCandidate = {
  path: string;
  paperPath?: string | null;
  score?: number;
};

export type ProjectInfo = {
  researchRoot: string;
  paperRoot: string;
  tree: TreeNode[];
  texCandidates: TexCandidate[];
  suggestedMain: string | null;
};

export type SourceSelection = {
  path: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  text: string;
  renderedText?: string;
  origin: "source" | "pdf";
};

export type PdfFocus = {
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LOCAL_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(body.error || body.message || `Request failed (${response.status})`);
  }
  return body as T;
}

export function relativeTo(root: string, absoluteOrRelative: string) {
  if (!absoluteOrRelative.startsWith("/")) return absoluteOrRelative;
  const base = root.replace(/\/+$/, "");
  if (absoluteOrRelative === base) return ".";
  const normalized = `${base}/`;
  return absoluteOrRelative.startsWith(normalized)
    ? absoluteOrRelative.slice(normalized.length)
    : absoluteOrRelative;
}
