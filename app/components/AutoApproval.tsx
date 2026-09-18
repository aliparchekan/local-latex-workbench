"use client";

import { useEffect, useRef, useState } from "react";
import { claimAutoApproval } from "../lib/auto-approval.mjs";
import type { PendingApproval } from "./DiffViewer";

type Props = {
  approval: PendingApproval | null;
  busy: boolean;
  disabled: boolean;
  onApprove: () => Promise<boolean>;
};

// The parent keys this control by paper/main/provider. No persisted preference:
// reloads and context switches require a fresh, explicit opt-in.
export function AutoApproval({ approval, busy, disabled, onApprove }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempted = useRef(new Set<string>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!claimAutoApproval(approval, enabled && !disabled, busy, attempted.current)) return;
    void onApprove().then((accepted) => {
      if (!accepted && mounted.current) {
        setEnabled(false);
        setFailed(true);
      }
    }).catch(() => {
      if (mounted.current) {
        setEnabled(false);
        setFailed(true);
      }
    });
  }, [approval, enabled, disabled, busy, onApprove]);

  return (
    <div className={`auto-approval ${enabled ? "is-enabled" : ""}`}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Auto-approve edits"
        aria-describedby="auto-approval-description"
        disabled={disabled}
        onClick={() => { setEnabled(value => !value); setFailed(false); }}
      >
        <span>Auto-approve edits</span>
        <span className="auto-approval-value">{enabled ? "On" : "Off"}<span className="auto-approval-switch" aria-hidden="true" /></span>
      </button>
      <p id="auto-approval-description">
        {enabled ? "Pending and future file edits save without asking. Undo AI edit remains available."
          : "Turn on to apply pending and future file edits, including deletions, in this research folder."}
        {" "}Extra access still asks. Resets on refresh or switching papers/providers.
      </p>
      {failed ? <p role="status">Auto-approval paused after an error. Check the pending change before retrying manually.</p> : null}
    </div>
  );
}
