"use client";

import { useMemo, useState } from "react";
import {
  Braces,
  ChevronRight,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import type { TreeNode } from "../lib/api";

type Props = {
  nodes: TreeNode[];
  activePath: string | null;
  paperRoot: string | null;
  onOpen: (path: string) => void;
};

const readableExtensions = new Set([
  "tex",
  "bib",
  "sty",
  "cls",
  "md",
  "txt",
  "py",
  "r",
  "m",
  "js",
  "ts",
  "tsx",
  "json",
  "yaml",
  "yml",
  "csv",
]);

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "pdf", "svg"].includes(ext)) {
    return <FileImage size={14} aria-hidden="true" />;
  }
  if (["py", "r", "m", "js", "ts", "tsx"].includes(ext)) {
    return <Braces size={14} aria-hidden="true" />;
  }
  if (["tex", "sty", "cls", "bib"].includes(ext)) {
    return <FileCode2 size={14} aria-hidden="true" />;
  }
  return <FileText size={14} aria-hidden="true" />;
}

function Branch({
  node,
  depth,
  activePath,
  paperRoot,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  paperRoot: string | null;
  onOpen: (path: string) => void;
}) {
  const isPaperRoot = paperRoot === node.path;
  const startsOpen = depth < 2 || Boolean(paperRoot && paperRoot.startsWith(`${node.path}/`));
  const [open, setOpen] = useState(startsOpen);

  if (node.type === "directory") {
    return (
      <li>
        <button
          className={`tree-row tree-folder ${isPaperRoot ? "paper-folder" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <ChevronRight
            size={12}
            className={`tree-chevron ${open ? "is-open" : ""}`}
            aria-hidden="true"
          />
          {open ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span className="tree-label">{node.name}</span>
          {isPaperRoot && <span className="tree-badge">paper</span>}
        </button>
        {open && node.children?.length ? (
          <ul>
            {node.children.map((child) => (
              <Branch
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                paperRoot={paperRoot}
                onOpen={onOpen}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
  const disabled = !readableExtensions.has(ext);
  return (
    <li>
      <button
        className={`tree-row tree-file ${activePath === node.path ? "is-active" : ""}`}
        style={{ paddingLeft: 24 + depth * 14 }}
        onClick={() => !disabled && onOpen(node.path)}
        disabled={disabled}
        title={disabled ? "Preview not available" : node.path}
      >
        <FileIcon name={node.name} />
        <span className="tree-label">{node.name}</span>
      </button>
    </li>
  );
}

export function FileTree({ nodes, activePath, paperRoot, onOpen }: Props) {
  const visible = useMemo(() => nodes, [nodes]);

  if (!visible.length) {
    return <p className="tree-empty">No paper files found in this folder.</p>;
  }

  return (
    <nav className="tree" aria-label="Paper files">
      <ul>
        {visible.map((node) => (
          <Branch
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            paperRoot={paperRoot}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </nav>
  );
}
