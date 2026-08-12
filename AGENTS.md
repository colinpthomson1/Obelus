# AGENTS Instructions

goose is an AI agent framework in Rust with CLI and Electron desktop interfaces.

## Contribution Workflow

The issue is the source of truth for work intended for an upstream pull request. Track issue status on the [Goose Issues board](https://github.com/orgs/aaif-goose/projects/1).

- Before implementing an issue for a pull request, confirm that it is on the board with Status **Ready**.
- Do not implement issues in **Inbox**, **Needs info**, or **Accepted / design**. Help resolve the issue discussion instead.
- Read the agreed design, constraints, non-goals, and verification plan before changing code.
- Keep the implementation within the issue's agreed scope.
- If implementation reveals a material design change, return to the issue before continuing.
- Every external pull request must link the Ready issue it implements and explain how the verification plan was performed.
- Structure new issues on the matching template in `.github/ISSUE_TEMPLATE/` and set the issue type (e.g. Bug, Feature). `gh issue create` does not apply templates automatically.

Maintainer-directed work, urgent security fixes, release automation, and local or exploratory changes do not require a Ready issue.

## Agent Loop Migration

We are replacing the legacy agent loop in `crates/goose/src/agents/agent.rs` with the state machine in `crates/goose/src/agents/state_machine/`. The state-machine path is enabled with `GOOSE_STATE_MACHINE=1`.

Until the migration is complete, changes to agent-loop behavior must be implemented and tested in both paths. When reviewing code, check whether a change to either path also applies to the other and flag missing parity.

## Setup
```bash
source bin/activate-hermit
cargo build
```

## Commands

### Build
```bash
cargo build                   # debug
cargo build --release         # release  
just release-binary           # release binary
```

### Test
```bash
cargo test                   # all tests
cargo test -p goose          # specific crate
cargo test --package goose --test mcp_integration_test
just record-mcp-tests        # record MCP
```

### Lint/Format
```bash
cargo fmt
cargo clippy --all-targets -- -D warnings
```

### UI
```bash
just run-ui                  # start desktop
cd ui/desktop && pnpm run typecheck
cd ui/desktop && pnpm test   # test UI
```

## Structure
```
crates/
├── goose              # core logic
├── goose-acp-macros   # ACP proc macros
├── goose-cli          # CLI entry
├── goose-mcp          # MCP extensions
├── goose-test         # test utilities
└── goose-test-support # test helpers

ui/desktop/            # Electron app
```

## Development Loop
```bash
# 1. source bin/activate-hermit
# 2. Make changes
# 3. cargo fmt
```

### Run these only if the user has asked you to build/test your changes:
```
# 1. cargo build
# 2. cargo test -p <crate>
# 3. cargo clippy --all-targets -- -D warnings
```

## Rules

- Test: Prefer tests/ folder, e.g. crates/goose/tests/
- Test: When adding features, update goose-self-test.yaml, rebuild, then run `goose run --recipe goose-self-test.yaml` to validate
- Error: Use anyhow::Result
- Provider: Implement Provider trait see providers/base.rs
- MCP: Extensions in crates/goose-mcp/
- UI Desktop: Use ACP SDK types or local `src/types/*` types. Do not import generated OpenAPI types/client code from `ui/desktop/src/api`

## Code Quality

- Comments: Write self-documenting code - prefer clear names over comments
- Comments: Never add comments that restate what code does
- Comments: Only comment for complex algorithms, non-obvious business logic, or "why" not "what"
- Simplicity: Don't make things optional that don't need to be - the compiler will enforce
- Simplicity: Booleans should default to false, not be optional
- Errors: Don't add error context that doesn't add useful information (e.g., `.context("Failed to X")` when error already says it failed)
- Simplicity: Avoid overly defensive code - trust Rust's type system
- Logging: Clean up existing logs, don't add more unless for errors or security events

## Never

- Never: Recreate `ui/desktop/src/api` or add `@hey-api/openapi-ts` to `ui/desktop`
- Cargo.toml: For human-authored dependency changes, use `cargo add` instead of manually editing dependency entries unless there is a specific reason not to.
- Cargo.toml: Automated dependency bump PRs are exempt; when manual edits are necessary, keep `Cargo.lock` consistent.
- Never: Skip cargo fmt
- Never: Merge without running clippy
- Never: Comment self-evident operations (`// Initialize`, `// Return result`), getters/setters, constructors, or standard Rust idioms
- Never: Overwrite a live binary in place (e.g. `cp`/`fs.copyFileSync` onto an existing executable) - unlink or atomic-rename the destination first, otherwise macOS SIGKILLs running processes with "Code Signature Invalid"

## Entry Points
- CLI: crates/goose-cli/src/main.rs
- UI: ui/desktop/src/main.ts
- Agent: crates/goose/src/agents/agent.rs

## Design Context

### Product and scope

Obelus is a desktop AI product derived from Goose. The immediate work is a comprehensive, truthful rebrand of the existing application: visual system, interaction tone, user-facing copy, onboarding, native app identity, packaging, privacy boundaries, update behavior, and public repository identity. Do not claim live spoken-conversation verification behavior until that workflow is actually implemented. The brand package describes that product direction, but the present Goose-derived capabilities remain a general local AI agent.

Publicly visible identity should be Obelus. Keep compatibility-sensitive internals such as Rust crate names, ACP method names, `@aaif/goose-sdk`, `.goosehints`, and established `GOOSE_*` interfaces where a blind rename would break the ecosystem; add Obelus-facing aliases or isolation boundaries instead. Obelus must not share Goose's app bundle identity, registered URL scheme, updater, analytics project, default user-data directory, sessions, or keyring namespace.

### Users and use cases

The product direction prioritizes journalists, interviewers, podcast hosts, live producers, researchers, analysts, consultants, investors, and diligence teams. Their common need is to examine consequential claims quickly without making the conversation hostile. In the current app, preserve the functioning general-agent workflows for research, writing, coding, automation, and tool use while expressing the same evidence-led posture.

### Brand character and voice

- Name: Obelus, pronounced “OB-uh-lus.”
- Essence: constructive skepticism.
- Category direction: live verification for spoken conversations.
- Master tagline: “Evidence at conversation speed.”
- Expressive line: “See what stands up.”
- Purpose line: “Keep the conversation honest.”
- Voice: plainspoken intelligence, calibrated certainty, constructive curiosity, conversation-speed clarity, and warm composure.
- Lead with findings and evidence trails, not verdicts. Question claims, not people. Avoid gotcha, alarmist, courtroom, or black-box truth-score language.
- Prefer “claim,” “check,” “finding,” “evidence,” “evidence trail,” “research thread,” and “early finding.” Avoid “lie/liar,” “obviously false,” “debunked,” “truth score,” and unjustified certainty.

### Visual direction

The UI should feel editorial, precise, calm, and evidence-led: open Paper/Cloud surfaces, strong Ink structure, disciplined Evidence Blue actions, and sparse Live Aqua or Voice Coral accents. It must not look like a generic chatbot reskin, a security dashboard, or a collection of nested cards.

Use the supplied Dialogue Axis artwork exactly. Never use a typed division glyph as the logo, modify its geometry, rotate it, add effects, or recolor it with verdict/status colors. Prefer the horizontal lockup for headers and about surfaces, the symbol for compact navigation and status/loading, and the stacked/tagline lockup for onboarding. Use the supplied primary 1024px app icon as the native icon master.

### Color and accessibility

- Ink `#111528`; Paper `#F7F8FC`; Cloud `#FCFCF8`.
- Evidence Blue `#3B50E0`; Live Aqua `#2BC7B9`; Voice Coral `#FF7568`.
- Light UI: Ink text, Paper background, Cloud surfaces, `#D9DEEA` borders.
- Dark UI: Ink background, `#181D34` elevated surfaces, Cloud text, `#B5BBCD` secondary text, `#38415F` borders, `#8794F2` actions, `#8BE2D9` live/focus.
- Semantic states must always pair color with an icon and label: supported `#08705B/#E0F5EF`, disputed `#B12D47/#FCE8ED`, needs context `#8A4B00/#FFF0CF`, unverified `#2F3FB5/#EAECFE`.
- Maintain WCAG AA: 4.5:1 for body text and 3:1 for large text and UI boundaries. Focus must be clearly visible. Reduced-motion behavior is required.
- Overall distribution should stay near 60% neutral/open space, 30% Ink/structure, and 10% blue/aqua/coral accents.

### Typography

Bundle and use Instrument Sans Variable for all product and display typography. Use IBM Plex Mono only for timestamps, source IDs, versions, transcript timing, and compact research metadata. Use sentence case and tabular numerals where appropriate. Product headings are generally 20–24px/1.2 at weight 600; body and transcript text 16–18px/1.55 around weight 400–430; buttons and labels 14–16px around weight 580; metadata 12–13px/1.45 at mono weight 500. Avoid more than three weights on one screen.

### Layout and components

Use a 4px base spacing system: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128. Use radii of 6, 12, 20, and full pill. The desktop product reference uses a compact 64–80px Ink rail or 224–256px expanded navigation, with adjacent primary work and evidence/detail regions. On narrow viewports below roughly 900px, collapse to one prioritized flow instead of squeezing multiple panels. Keep evidence detail at least 360px when shown beside the main workspace.

Use one clear primary action per region. Treat claim highlights as text annotations rather than warning cards. Keep live/recording state explicit with a label and consent/privacy context. Avoid excessive pills, floating rounded containers, ornamental gradients, nested cards, and gratuitous animation.

### Motion

Motion is precise, calm, sparse, and interruptible. Standard durations are 120ms, 200ms, 280ms, and 480ms, with the supplied easing tokens. Use supplied Obelus loaders: Proof Pulse for compact default progress, Transcript Scan only for active speech, Source Exchange for deeper research, Obelus Resolve for signature handoff/onboarding/empty states, and Progress Divide only for measurable progress. In reduced-motion mode show the static mark/poster rather than a slowed loop. Prefer inline SVG/CSS; preview GIF/MP4/WebM files are not production UI assets.

### Source assets

The canonical production assets live in `Obelus Brand/`. Use its SVG logos, 16–1024px icon ladders, WOFF2 fonts, design tokens, status icons, motion SVGs, desktop/mobile product references, and logo rules directly. Do not redraw or approximate assets that already exist. The native macOS `.icns` file should be generated from `Obelus_App_Icon_Primary_1024px.png`.

### Trust and release constraints

Disable upstream Goose auto-update and telemetry behavior until Obelus owns those destinations and has explicit consent copy. Establish separate Obelus storage and keyring namespaces so the fork cannot silently read or mutate Goose user data. Keep recording/microphone permission copy specific and honest. The brand package carries a material naming/trademark collision warning, so public launch, domains, social handles, and app-store submission require professional clearance; this does not block local product development.
