# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Researchers writing and revising LaTeX papers alongside the code, simulations, results, and figures that support them. The primary setting is a desktop or laptop research session.

## Product Purpose

Local LaTeX Workbench lets the author select source or rendered paper passages and work with a subscription-backed agent in the correct research folder. The author can inspect, understand, and approve edits with their scientific context intact.

## Operating Context

The research folder contains code and resources; the paper folder may be a subfolder. Authors move between source, compiled PDF, agent conversation, and reviewable file changes. Relevant local evidence should inform revisions without requiring a separate inspection skill first.

## Capabilities and Constraints

- Keep the application local-first and use the author's existing Codex, Claude Code, or Cursor subscription integration. Do not introduce API-key billing as part of the UI redesign.
- Preserve source and PDF selection, live subscription model selection, intelligence settings, compilation, and resizable working areas.
- Preserve approval, opt-in auto-approval, Undo, local saves, and disk-location controls. A visual redesign must not relax permissions or change when files are written.
- Skill settings configure existing skills, including audience, length, spelling, scope, resources, and report destination. They are not a custom-skill authoring interface.
- Skill settings and information belong in independent pop-ups rather than expanding the conversation.
- The author approved reconsidering the overall layout while preserving these essentials on 2026-09-18.

## Product Principles

1. Keep paper revisions connected to the author's intent and actual research evidence.
2. Make proposed changes and their persistence understandable and reversible where supported.
3. Protect the current research project during app development and interface testing.
4. Let the author control the agent, model, and editing permissions.
