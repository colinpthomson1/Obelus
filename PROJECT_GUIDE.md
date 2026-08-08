# Goose Fork Project Guide

## Purpose

This repository is a hands-on environment for learning how to understand, modify, test, secure, and eventually ship software built from an active open-source base.

The canonical project is [aaif-goose/goose](https://github.com/aaif-goose/goose). Goose began at Block and is now an Agentic AI Foundation project at the Linux Foundation. Jack Dorsey co-founded Block, but the project is maintained by the Goose open-source community rather than by Dorsey personally.

Colin's fork is [colinpthomson1/goose](https://github.com/colinpthomson1/goose).

## Current Repository State

The local repository is configured as follows:

| Name | URL | Purpose |
| --- | --- | --- |
| `origin` | `https://github.com/colinpthomson1/goose.git` | Colin's writable public fork |
| `upstream` | `https://github.com/aaif-goose/goose.git` | Read-only source of canonical changes |
| `main` | Tracks `origin/main` | Clean mirror branch; do not develop here |

Repository-local Git settings use fast-forward-only pulls, prune deleted remote branches on fetch, and push the current branch by default.

Run `./scripts/fork-doctor.sh` at any time to confirm these assumptions.

## What Was Actually Cloned

Goose is not a conventional Node.js web application:

- The agent, provider integrations, tool execution, persistence, CLI, and ACP server are Rust crates under `crates/`.
- The current desktop client is an Electron/React/TypeScript app under `ui/desktop/`.
- The reusable TypeScript ACP client is under `ui/sdk/`.
- The desktop client starts or connects to `goose serve`, which exposes ACP over HTTP and WebSocket.
- Goose is a privileged developer agent. Its default Developer extension can read, write, and run commands with the permissions of the Goose process.

Node.js is therefore the right tool for UI development and UI tests, but it is not sufficient to build or run the complete application. The full desktop loop also requires the Rust backend.

## Toolchain

Upstream uses Hermit to pin the development tools. At the time this guide was created, the repository pins:

- Node.js 24.10.0
- pnpm 10.30.3
- Rust 1.96.1
- just 1.40.0

Always enter the environment before running project commands:

```bash
source bin/activate-hermit
```

Do not depend on globally installed versions. The repository's `bin/` shims and `rust-toolchain.toml` are the source of truth after an upstream sync.

## Fresh Clone on Another Computer

The GitHub fork already exists. A new machine only needs these steps:

```bash
git clone https://github.com/colinpthomson1/goose.git
cd goose
git remote add upstream https://github.com/aaif-goose/goose.git
git config pull.ff only
git config fetch.prune true
git config push.default current
source bin/activate-hermit
./scripts/fork-doctor.sh
```

Hermit downloads the pinned toolchain on first use. Review changes to `bin/`, `bin/hermit.hcl`, and `rust-toolchain.toml` before activating an unfamiliar upstream revision because toolchain bootstrapping executes downloaded software.

## First Local Install

Install the locked JavaScript workspace dependencies:

```bash
source bin/activate-hermit
(cd ui && pnpm install --frozen-lockfile)
```

The lockfile must not change during a normal install. If pnpm proposes lockfile changes, stop and determine whether the current upstream branch intentionally changed package metadata.

Rust dependencies are resolved from `Cargo.lock` during the first Cargo build or check:

```bash
source bin/activate-hermit
cargo check -p goose-cli
```

## Safe Daily Workflow

### 1. Synchronize the clean base

Only sync from a clean `main` branch:

```bash
git switch main
./scripts/fork-sync.sh
```

The script fetches both remotes, fast-forwards from `upstream/main`, and pushes the same commit to `origin/main`. It refuses to run with local changes or from another branch.

### 2. Create a focused branch

```bash
git switch -c codex/short-description
```

Use one branch for one coherent change. Keep learning experiments small enough to review and revert.

### 3. Isolate Goose state

Manual agent sessions must not share the installed Goose profile:

```bash
export GOOSE_PATH_ROOT="$(pwd)/.local/goose/dev"
mkdir -p "$GOOSE_PATH_ROOT"
```

`.local/` is ignored by Git. Do not put provider keys in this repository; configure secrets through the system keychain or process environment and never echo them.

### 4. Make and validate the change

Use the smallest relevant verification first.

For TypeScript UI work:

```bash
(
  cd ui/desktop
  pnpm run typecheck
  pnpm run test:run
  pnpm run lint:check
)
```

For Rust work:

```bash
cargo fmt --all -- --check
cargo check -p goose-cli
cargo test -p <affected-crate>
cargo clippy --all-targets -- -D warnings
```

For the complete local desktop application:

```bash
just run-ui
```

`just run-ui` performs a release Rust build before launching Electron, so it is much slower than UI unit tests. It may also reach provider services after onboarding; use an isolated `GOOSE_PATH_ROOT` and a test account or tightly scoped credentials.

### 5. Review and publish the branch

```bash
git status --short
git diff --check
git diff --stat upstream/main...HEAD
git log --oneline upstream/main..HEAD
git push -u origin HEAD
```

Open a pull request into Colin's `main` for personal product work. Open a pull request into `aaif-goose/goose:main` only when following upstream's issue workflow in `CONTRIBUTING.md`: substantial external changes need an agreed issue in **Ready** status.

## Dependency and Supply-Chain Rules

- Use the committed `Cargo.lock` and `ui/pnpm-lock.yaml`.
- Use `cargo add` for human-authored Rust dependency changes, per upstream guidance.
- Use pnpm from the activated Hermit environment for the UI workspace.
- Review install scripts, native modules, new Git dependencies, and lockfile diffs before running them.
- Pin GitHub Actions to immutable commit SHAs. Upstream already follows this pattern in its sensitive workflows; preserve it.
- Do not enable or edit publishing, release, signing, package, or deployment workflows until their tokens and target repositories have been deliberately scoped for this fork.
- Run targeted tests before broad tests. Never silence a failing security, lint, or type check merely to make CI green.

## Secrets and Data Rules

- Never commit `.env`; the root `.gitignore` excludes it.
- Never place provider API keys in `NEXT_PUBLIC_*`, Electron renderer variables, browser storage, source code, test snapshots, or build logs.
- Keep the ACP server secret server-side. A shared `GOOSE_SERVER__SECRET_KEY` is suitable for local development but is not multi-user authentication.
- Treat prompts, tool outputs, session databases, and uploaded files as user data.
- Use separate credentials for development, preview, and production.
- Rotate a credential immediately if it appears in Git history or logs; deleting the visible line is not sufficient.

## Open-Source and License Rules

Goose is licensed under Apache License 2.0. Preserve `LICENSE`, existing copyright and attribution notices, and any required notices when redistributing a modified product. Clearly distinguish Colin's product name and support channel from the upstream project before a public launch. Get legal review before making final trademark, branding, or redistribution decisions.

## Vercel Direction

The Electron app and Rust agent server cannot be deployed to Vercel as one ordinary web application. The intended future design is:

1. A browser client, likely a new `ui/web` package, deployed on Vercel.
2. A Node.js backend-for-frontend on Vercel for user authentication, authorization, rate limits, and short-lived session brokering.
3. Goose workers running in isolated compute with durable state and no shared host filesystem. This can be a container platform, or a carefully evaluated Vercel Sandbox design for bounded jobs.
4. A streaming transport between the browser and worker. Standard Vercel Functions cannot act as WebSocket servers, so use ACP Streamable HTTP where it fits or a supported realtime service/worker endpoint.

Do not expose a Goose ACP server directly to the public internet or send its server secret to a browser. See `VERCEL_ARCHITECTURE.md` for the deployment gates and threat model.

## Verified Baseline

On August 7, 2026, this Apple Silicon checkout passed:

- `pnpm install --frozen-lockfile` with no lockfile changes;
- `pnpm run typecheck` in `ui/desktop`;
- `pnpm run test:run` in `ui/desktop` (65 files and 604 tests);
- `pnpm run lint:check` in `ui/desktop`, including locale validation; and
- `cargo check -p goose-cli` with the Hermit-pinned Rust toolchain.

The pnpm install reported expected cross-platform optional-package warnings and a non-fatal missing `setup-bun.mjs` in the upstream `@modelcontextprotocol/ext-apps` package. The Goose SDK postinstall still built successfully. Treat new or materially different install warnings as something to investigate rather than automatically ignoring them.

## Suggested Learning Roadmap

1. Keep this foundation change isolated and review its diff.
2. Run the UI unit tests and a Rust check locally.
3. Launch the desktop app with isolated state and understand the Electron-to-ACP-to-Rust request path.
4. Make one small UI-only change with a focused unit test.
5. Make one small Rust change with a focused crate test.
6. Practice syncing `upstream/main` and rebasing or merging a feature branch.
7. Design the multi-user authorization and sandbox boundary before creating `ui/web`.
8. Add a minimal web client and deploy previews to Vercel only after the security gates in `VERCEL_ARCHITECTURE.md` are met.

## Primary References

- [Goose repository](https://github.com/aaif-goose/goose)
- [Goose documentation](https://goose-docs.ai/)
- [Upstream contribution guide](https://github.com/aaif-goose/goose/blob/main/CONTRIBUTING.md)
- [Upstream security guidance](https://github.com/aaif-goose/goose/blob/main/SECURITY.md)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Vercel platform limits, including WebSockets](https://vercel.com/docs/limits)
- [Vercel Sandbox persistence and duration](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)
- [Codex project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
