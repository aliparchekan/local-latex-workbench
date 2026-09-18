"use client";

import type { ReactNode } from "react";
import { Dialog } from "@primer/react";

// Primer portals dialogs outside scrolling panes and handles Escape, focus
// containment, and focus return without changing the conversation's layout.
export function WorkbenchDialog({ open, title, description, onClose, children, footer, className = "" }: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  if (!open) return null;
  return <Dialog title={title} subtitle={description} onClose={onClose}
    className={`primer-dialog ${className}`} width={className.includes("skill-settings") ? "xlarge" : "large"}
    renderFooter={footer ? () => <footer className="workbench-dialog-footer">{footer}</footer> : undefined}>
    {children}
  </Dialog>;
}
