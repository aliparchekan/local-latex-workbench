# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting feature for this repository. Do not include private manuscripts, access tokens, personal data, or unpublished research in a public issue.

Include the affected version, operating system, steps to reproduce, expected behavior, and observed impact. There is no guaranteed response or remediation time for this experimental project.

## Local trust model

The companion service binds to `127.0.0.1:4317` and permits browser requests only from localhost origins. It can read selected research files, write approved files, invoke the local TeX toolchain, and launch the signed-in Codex CLI. Do not expose the companion port through a proxy, tunnel, container port mapping, or firewall rule.

Treat every research workspace as code: inspect untrusted scripts and repository instructions before opening it. Source patches require review, but approved command-output folders permit creation, replacement, and deletion below the displayed path for the current turn and do not have source-level diff review or app-provided undo.

The application is not a sandbox for arbitrary untrusted code and is not intended for multi-user or remotely hosted operation.
