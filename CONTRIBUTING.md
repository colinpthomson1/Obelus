# Contributing to Obelus

Obelus is an independent, open-source client derived from Goose. Bug reports,
design feedback, documentation improvements, tests, and code are all welcome.

## Before you start

Search the [Obelus issues](https://github.com/colinpthomson1/Obelus/issues) before
opening a new one. For a substantial behavior or architecture change, open an
issue first so the scope and verification plan can be agreed before
implementation. Security reports must follow [SECURITY.md](SECURITY.md), not a
public issue.

This repository is the public client boundary. Do not add managed gateway or
administrator source, deployment secrets, provider credentials, customer data,
or private evaluation assets.

## Development setup

The repository uses Hermit to provide compatible Rust, Node.js, pnpm, and
supporting tools:

\`\`\`bash
source ./bin/activate-hermit
cargo build
\`\`\`

Useful checks include:

\`\`\`bash
cargo fmt --all -- --check
cargo test -p goose
cargo clippy --all-targets -- -D warnings

cd ui/desktop
pnpm run typecheck
pnpm run test:run
pnpm run lint:check
\`\`\`

Run checks proportionate to the change and record the exact commands and
results in the pull request.

## Compatibility boundary

Public product copy and application identity must say Obelus. Compatibility
interfaces such as Rust crate names, the embedded \`goose\` executable,
\`GOOSE\_\*\` environment variables, ACP/MCP methods, \`.goosehints\`, and legacy
import formats may retain Goose names where a blind rename would break users.
Describe any retained name as compatibility behavior when it could otherwise
look like Obelus identity.

Obelus must not silently use Goose storage, sessions, keyrings, telemetry,
updaters, release channels, OAuth identity, or documentation as its own.

## Agent-loop parity

The legacy loop in \`crates/goose/src/agents/agent.rs\` is being replaced by the
state machine in \`crates/goose/src/agents/state_machine/\`. The state-machine
path is enabled with \`GOOSE_STATE_MACHINE=1\`.

Until that migration is complete, agent-loop behavior changes must be
implemented and verified in both paths.

## Pull requests

- Keep each pull request focused and link its issue when one exists.
- Explain user-visible behavior, trust-boundary effects, and compatibility
  decisions.
- Add or update tests for changed behavior.
- Preserve upstream copyright and Apache 2.0 attribution.
- Never commit credentials, local \`.env\` files, user content, or generated
  build directories.
- Address review feedback or explain concretely why a proposed change should
  not be made.

By contributing, you agree that your contribution is licensed under this
repository's Apache 2.0 license.
