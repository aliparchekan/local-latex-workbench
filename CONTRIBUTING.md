# Contributing

Thank you for helping improve Local LaTeX Workbench. Bug reports, documentation improvements, tests, design feedback, and focused code changes are welcome.

## Before contributing

- Search existing issues and pull requests before opening a duplicate.
- Open an issue before a large or behavior-changing implementation so the approach can be discussed.
- Report security problems privately through GitHub Security Advisories; do not publish sensitive paths, manuscripts, credentials, or unpublished research in an issue.
- Be respectful, specific, and constructive. Harassment, discrimination, and disclosure of another person's private information are not acceptable.

## Development setup

Requirements and local setup are documented in [README.md](README.md). Before submitting a pull request, run:

```bash
npm ci
npm run check
npm run lint
npm test
```

## Project principles

Changes should preserve these boundaries:

- Local manuscript files remain the source of truth.
- Manual and agent-authored source writes fail closed on stale files or unsafe paths.
- Reviewable text changes are shown before acceptance.
- Command write access is narrow, explicit, turn-scoped, and never silently enables network access.
- The application uses the user's local Codex sign-in, not an embedded API key.
- Private research data and generated build artifacts do not belong in this repository.

Add or update regression tests whenever behavior changes. Keep pull requests focused and explain user-visible behavior, risks, and verification performed.

## Pull requests and licensing

Create a branch in your fork and open a pull request against `main`. The protected `main` branch cannot be force-pushed or deleted, and every pull request runs CI.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion is licensed under the Apache License 2.0, as described in section 5 of the license. You must have the right to submit your contribution and any included assets.
