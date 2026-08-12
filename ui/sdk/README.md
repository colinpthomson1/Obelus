# @aaif/goose-sdk

TypeScript client library for the Goose Agent Client Protocol (ACP).

This package provides:

- TypeScript types and Zod validators for Goose ACP extension methods
- A client for communicating with the Goose ACP server

## Installation

```bash
npm install @aaif/goose-sdk
```

The native `goose` binaries are distributed as optional dependencies
and will be automatically installed for your platform.

## Development

### Prerequisites

- Node.js 18+
- Rust toolchain
- (Optional) Cross-compilation toolchains for building all platforms

### Building

```bash
# Build everything (schema + TypeScript)
npm run build

# Build just the schema (requires Rust)
npm run build:schema

# Build just the TypeScript
npm run build:ts

# Build native binary for current platform
npm run build:native

# Build native binaries for all platforms
npm run build:native:all
```

### Local Development with npm link

To use this package locally in another project:

```bash
# In ui/sdk
npm run build
npm link

# In the consuming project
npm link @aaif/goose-sdk
```

### Schema Generation

The TypeScript types are generated from Rust schemas defined in `crates/goose`.
The build process:

1. Builds the `generate-acp-schema` Rust binary
2. Runs it to generate `acp-schema.json` and `acp-meta.json`
3. Uses `@hey-api/openapi-ts` to generate TypeScript types and Zod validators
4. Generates a typed client in `src/generated/client.gen.ts`

To regenerate schemas after changing Rust types:

```bash
npm run build:schema
```

## Native Binary Packages

Platform-specific npm packages for the `goose` binary are located in
`ui/goose-binary/`:

| Package                           | Platform            |
| --------------------------------- | ------------------- |
| `@aaif/goose-binary-darwin-arm64` | macOS Apple Silicon |
| `@aaif/goose-binary-darwin-x64`   | macOS Intel         |
| `@aaif/goose-binary-linux-arm64`  | Linux ARM64         |
| `@aaif/goose-binary-linux-x64`    | Linux x64           |
| `@aaif/goose-binary-win32-x64`    | Windows x64         |

These are built as separate local compatibility packages for
`@aaif/goose-sdk`.

### Building Native Binaries

```bash
# Build for current platform
npm run build:native

# Build for all platforms (requires cross-compilation toolchains)
npm run build:native:all

# Build for specific platform(s)
npx tsx scripts/build-native.ts darwin-arm64 linux-x64
```

## Publishing

Registry publishing is intentionally disabled in this repository. The
`@aaif/goose-sdk` name remains a compatibility interface; Obelus does not own
the upstream npm namespace. See the repository's
[release policy](../../RELEASE.md).

## Usage

```typescript
import { GooseClient } from "@aaif/goose-sdk";

const client = new GooseClient({
  // ... configuration
});

// Use the client
const result = await client.someMethod({ ... });
```

See the [main documentation](../../README.md) for more details.
