<div align="center">
  <img src=".github/assets/obelus-lockup.svg" alt="Obelus" width="360" />

  <h3>Evidence at conversation speed.</h3>

  <p>A local, open-source desktop AI agent with an evidence-led point of view.</p>

  <p>
    <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-3B50E0.svg" alt="Apache 2.0 license" /></a>
    <a href="https://github.com/colinpthomson1/Obelus/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/colinpthomson1/Obelus/ci.yml?branch=main&label=build" alt="Build status" /></a>
  </p>
</div>

## About Obelus

Obelus is an independent desktop AI agent built from the open-source [Goose](https://github.com/aaif-goose/goose) foundation. It runs locally and supports research, writing, coding, automation, data analysis, and tool-enabled workflows through a native Electron app and Rust backend.

The product is being shaped around constructive skepticism: make evidence visible, communicate uncertainty clearly, and question claims without turning scrutiny into spectacle. The current application retains Goose's mature general-agent capabilities while the Obelus product direction develops. It does not yet claim to provide automatic live verification of spoken conversations.

## Run the desktop app locally

Prerequisites on macOS are Apple Command Line Tools and the repository-managed Hermit environment.

```bash
source ./bin/activate-hermit
cargo build --release -p goose-cli --bin goose
just run-ui
```

The desktop app intentionally keeps the proven `goose` backend binary and protocol-level interfaces internally. Public app identity, storage, deep links, visual design, and packaging belong to Obelus.

## Build a macOS app

```bash
source ./bin/activate-hermit
just package-ui
```

The packaged Apple Silicon application is written to `ui/desktop/out/Obelus-darwin-arm64/Obelus.app`.

## Development

```bash
# Rust workspace
cargo build
cargo test -p goose
cargo fmt --check

# Desktop renderer
cd ui/desktop
pnpm run typecheck
pnpm run test:run
pnpm run format:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the upstream-compatible development workflow and [ui/desktop/README.md](ui/desktop/README.md) for desktop details.

## Brand system

The production identity is defined in `Obelus Brand/`: Dialogue Axis logo masters, native icon sizes, Instrument Sans and IBM Plex Mono fonts, accessible light/dark color tokens, status icons, motion assets, layout references, and usage guidance. Runtime assets are copied into the application so builds never depend on an external brand-package path.

## Compatibility and attribution

Obelus preserves selected Goose names in internal crates, environment variables, ACP/MCP messages, project hints, and the embedded backend where changing them would break compatibility. User data, credentials, app identity, analytics, and update channels remain isolated from Goose.

This project is licensed under Apache 2.0 and retains the original Goose copyright and attribution. Upstream documentation is available at [goose-docs.ai](https://goose-docs.ai/).
