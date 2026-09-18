"use client";

import { Check, ChevronRight, FileCode2, RefreshCw, RotateCcw, ShieldCheck, X } from "lucide-react";
import { parsePatch } from "diff";
import { Button } from "@primer/react";
import type { SourceReviewPreview } from "./SourceReview";

export type ApprovalReviewFile = SourceReviewPreview & {
  movePath?: string | null;
};

export type ApprovalWriteTarget = {
  path: string;
  kind: "file" | "directory" | "path";
};

export type PendingApproval = {
  id: string | number;
  provider?: "codex" | "claude" | "cursor";
  agentName?: string;
  diff: string;
  approvalType?: "file" | "permission";
  reason?: string | null;
  itemId?: string;
  files?: ApprovalReviewFile[];
  writePaths?: string[];
  writeTargets?: ApprovalWriteTarget[];
};

type Props = {
  approval: PendingApproval;
  activePath?: string | null;
  busy?: boolean;
  confirmationDelayed?: boolean;
  confirmationMessage?: string | null;
  onAccept: () => void;
  onReject: () => void;
  onCheckStatus?: () => void;
  onOpenFile?: (path: string) => void;
};

type AffectedFile = {
  path: string;
  kind: ApprovalReviewFile["kind"];
  movePath?: string | null;
  diff: string;
  hunks: number;
  added: number;
  removed: number;
};

function cleanPath(value?: string) {
  if (!value || value === "/dev/null") return "";
  return value.replace(/^a\//, "").replace(/^b\//, "").replace(/^\.\//, "");
}

function changeCounts(diff: string) {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  try {
    for (const file of parsePatch(diff)) {
      hunks += file.hunks.length;
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+")) added += 1;
          if (line.startsWith("-")) removed += 1;
        }
      }
    }
  } catch {
    // The file still appears in the review list when a patch cannot be parsed.
  }
  return { added, removed, hunks };
}

function affectedFiles(approval: PendingApproval): AffectedFile[] {
  if (approval.files?.length) {
    return approval.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      movePath: file.movePath,
      diff: file.reviewDiff,
      ...changeCounts(file.reviewDiff),
    }));
  }

  try {
    return parsePatch(approval.diff || "").map((file, index) => {
      const oldPath = cleanPath(file.oldFileName);
      const newPath = cleanPath(file.newFileName);
      const kind: AffectedFile["kind"] = !oldPath ? "add" : !newPath ? "delete" : "update";
      let added = 0;
      let removed = 0;
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+")) added += 1;
          if (line.startsWith("-")) removed += 1;
        }
      }
      return {
        path: newPath || oldPath || `Change ${index + 1}`,
        kind,
        diff: approval.diff,
        hunks: file.hunks.length,
        added,
        removed,
      };
    });
  } catch {
    return [];
  }
}

function kindLabel(kind: AffectedFile["kind"]) {
  if (kind === "add") return "New file";
  if (kind === "delete") return "Delete file";
  return "Edit file";
}

function samePath(left?: string | null, right?: string | null) {
  if (!left || !right) return false;
  return left.replace(/^\.\//, "") === right.replace(/^\.\//, "");
}

export function DiffViewer({
  approval,
  activePath,
  busy,
  confirmationDelayed,
  confirmationMessage,
  onAccept,
  onReject,
  onCheckStatus,
  onOpenFile,
}: Props) {
  const agentName = approval.agentName ?? "Codex";
  if (approval.approvalType === "permission") {
    const writeTargets = approval.writeTargets?.length
      ? approval.writeTargets
      : (approval.writePaths ?? []).map((path) => ({ path, kind: "path" as const }));
    const includesDirectory = writeTargets.some((target) => target.kind === "directory");

    return (
      <div className="diff-review">
        <header className="diff-heading">
          <div className="diff-icon"><ShieldCheck size={17} /></div>
          <div>
            <h3>Allow research-support work?</h3>
          </div>
        </header>

        <p className="diff-reason">
          {approval.reason
            ?? `${agentName} needs temporary write access to run local research work or generate supporting files.`}
        </p>

        <div className="diff-files">
          <div className="diff-files-heading">
            <strong>Requested write paths</strong>
            <span>{writeTargets.length}</span>
          </div>
          <p className="diff-source-note">
            {agentName} is asking to write research-support files at these locations for this turn only.
            Network access stays off.
          </p>
          {writeTargets.length ? (
            <div className="diff-file-list" role="list" aria-label="Requested research-support write paths">
              {writeTargets.map((target, index) => (
                <div className="diff-file-row" role="listitem" key={`${target.path}-${index}`}>
                  <span className="diff-file-icon">
                    <FileCode2 size={15} />
                  </span>
                  <span className="diff-file-copy">
                    <strong title={target.path}>{target.path}</strong>
                    <small>{target.kind === "directory"
                      ? "Folder access"
                      : target.kind === "file"
                        ? "Output file"
                        : "Output path"}</small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="diff-file-empty">
              <FileCode2 size={17} />
              <span>{agentName} requested research-support write access, but did not provide a specific path.</span>
            </div>
          )}

          {includesDirectory ? (
            <div className="diff-confirmation-delayed" role="note">
              <strong>Folder access includes everything underneath</strong>
              <span>
                The command can create, replace, or delete files anywhere under each requested folder.
              </span>
            </div>
          ) : null}

          <div className="diff-confirmation-delayed" role="note">
            <strong>Folder writes are not source-reviewed</strong>
            <span>
              Files created, replaced, or deleted by a command have no proposed source diff and cannot be restored by Undo AI edit.
            </span>
          </div>
        </div>

        <footer className="diff-actions">
          <span className="diff-undo-note">Permission ends with this turn · network remains disabled</span>
          <div className="diff-action-buttons">
            <Button variant="danger" onClick={onReject} disabled={busy}>
              <X size={15} /> Reject
            </Button>
            <Button variant="primary" onClick={onAccept} disabled={busy}>
              <Check size={15} /> {busy ? "Allowing…" : "Allow for this turn"}
            </Button>
          </div>
        </footer>
      </div>
    );
  }

  const files = affectedFiles(approval);

  return (
    <div className="diff-review">
      <header className="diff-heading">
        <div className="diff-icon"><ShieldCheck size={17} /></div>
        <div>
          <h3>Review changes</h3>
        </div>
      </header>

      {approval.reason ? <p className="diff-reason">{approval.reason}</p> : null}
      {confirmationDelayed ? (
        <div className="diff-confirmation-delayed" role="status">
          <strong>Apply confirmation delayed</strong>
          <span>{confirmationMessage ?? "The source remains locked until the local change status is confirmed."}</span>
        </div>
      ) : null}

      <div className="diff-files">
        <div className="diff-files-heading">
          <strong>Affected files</strong>
          <span>{files.length}</span>
        </div>
        <p className="diff-source-note">
          Open a file to compare its Current and Proposed source in the source pane.
        </p>
        {files.length ? (
          <div className="diff-file-list">
            {files.map((file, index) => {
              const active = samePath(activePath, file.path) || samePath(activePath, file.movePath);
              const detail = file.movePath
                ? `Move to ${file.movePath}`
                : `${kindLabel(file.kind)} · ${file.hunks} ${file.hunks === 1 ? "change" : "changes"}`;
              return (
                <button
                  type="button"
                  className={`diff-file-row${active ? " is-active" : ""}`}
                  key={`${file.path}-${index}`}
                  onClick={() => onOpenFile?.(file.path)}
                  disabled={!onOpenFile}
                  aria-current={active ? "true" : undefined}
                  aria-label={`Review ${file.path} in source`}
                >
                  <span className={`diff-file-icon diff-file-icon-${file.kind}`}>
                    <FileCode2 size={15} />
                  </span>
                  <span className="diff-file-copy">
                    <strong title={file.path}>{file.path}</strong>
                    <small>{detail}</small>
                  </span>
                  <span className="diff-file-counts" aria-label={`${file.added} lines added and ${file.removed} lines removed`}>
                    {file.added ? <span className="diff-count-added">+{file.added}</span> : null}
                    {file.removed ? <span className="diff-count-removed">−{file.removed}</span> : null}
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="diff-file-empty">
            <FileCode2 size={17} />
            <span>{agentName} requested a source update. Review the source before approving.</span>
          </div>
        )}
      </div>

      <footer className="diff-actions">
        {confirmationDelayed ? (
          <>
            <span className="diff-undo-note">The reviewed source stays read only while you verify the result.</span>
            <div className="diff-action-buttons single">
              <Button variant="primary" onClick={onCheckStatus} disabled={busy || !onCheckStatus}>
                <RefreshCw className={busy ? "spin" : ""} size={15} /> {busy ? "Checking…" : "Check status"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="diff-undo-note"><RotateCcw size={13} /> You can undo after accepting</span>
            <div className="diff-action-buttons">
              <Button variant="danger" onClick={onReject} disabled={busy}>
                <X size={15} /> Reject
              </Button>
              <Button variant="primary" onClick={onAccept} disabled={busy}>
                <Check size={15} /> {busy ? "Applying…" : "Accept"}
              </Button>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}
