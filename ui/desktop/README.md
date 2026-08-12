# Obelus desktop

Obelus is a native Electron and React application backed by the Rust `goose` ACP server. The backend name is retained as an internal compatibility boundary; the packaged application, data storage, deep links, and user-facing identity are Obelus.

## Build and run

From the repository root:

```bash
source ./bin/activate-hermit
cargo build --release -p goose-cli --bin goose
just run-ui
```

For renderer-only checks:

```bash
cd ui/desktop
pnpm install
pnpm run typecheck
pnpm run test:run
pnpm run format:check
```

## Package macOS

```bash
source ./bin/activate-hermit
just package-ui
```

The Apple Silicon bundle is created at `ui/desktop/out/Obelus-darwin-arm64/Obelus.app`. Signing and notarization require the Apple credentials configured in `forge.config.ts`; local ad-hoc development builds do not.

## Platform requirements

### Linux

Install the packaging tools for your distribution before using Electron Forge makers.

```bash
# Debian or Ubuntu
sudo apt install dpkg fakeroot

# Arch or Manjaro
sudo pacman -S dpkg

# Fedora or RHEL
sudo dnf install dpkg-dev fakeroot
```

Build the backend and then run the desired Forge target:

```bash
cargo build --release -p goose-cli --bin goose
cd ui/desktop
pnpm run make --targets=@electron-forge/maker-zip
```

### Windows

Use the existing Electron Forge Windows build process. The bundled Rust backend remains `goose.exe` internally.

## External ACP backend

Start a compatible backend from the repository root:

```bash
GOOSE_SERVER__SECRET_KEY=test cargo run -p goose-cli --bin goose -- serve \
  --platform desktop --enable-scheduler --host 127.0.0.1 --port 3000
```

Then start the renderer:

```bash
cd ui/desktop
GOOSE_EXTERNAL_BACKEND=true \
GOOSE_EXTERNAL_BACKEND_URL=http://127.0.0.1:3000 \
GOOSE_SERVER__SECRET_KEY=test \
pnpm run start-gui
```

`GOOSE_*` configuration names are intentionally supported for backend compatibility. Obelus desktop supplies its own isolated storage root when it launches the bundled backend.

## Hosted research sign-in

The desktop main process supports an Auth0 Native application using Authorization Code with S256 PKCE. Release builds bundle Obelus's public staging gateway, issuer, Native client ID, and audience, so a packaged app launched from Finder or the Start menu does not depend on shell environment variables. None of these public identifiers is a credential.

For unpackaged local development or tests, runtime environment variables take precedence over the bundled values:

```bash
OBELUS_GATEWAY_URL=https://your-staging-gateway.example.com
OBELUS_AUTH0_ISSUER=https://your-tenant.us.auth0.com/
OBELUS_AUTH0_CLIENT_ID=your-public-native-client-id
OBELUS_AUTH0_AUDIENCE=urn:obelus:staging:gateway
```

Release variants can replace the bundled public values at build time with `OBELUS_BUILD_GATEWAY_URL`, `OBELUS_BUILD_AUTH0_ISSUER`, `OBELUS_BUILD_AUTH0_CLIENT_ID`, and `OBELUS_BUILD_AUTH0_AUDIENCE`. Packaged applications ignore runtime `OBELUS_GATEWAY_URL` and `OBELUS_AUTH0_*` values so the gateway and token-verification profile cannot be redirected after release. Never use these public configuration fields for client secrets or provider credentials.

Register the exact callback `obelus://auth/callback` and logout callback `obelus://auth/logout`. The Native application must use token-endpoint authentication method `none`, allow only the Authorization Code grant, and issue RS256 gateway access tokens for no more than 600 seconds. Do not configure a client secret or refresh-token grant.

The client sends a stable, random per-installation `obelus_device_id` authorization parameter. A tenant Post-Login Action must validate it and add the signed access-token claims `https://obelus.ai/claims/device_id` and `https://obelus.ai/claims/email`; the email claim must come from a verified identity. This identifier partitions quota and tenancy but is not hardware attestation. The desktop verifies signature, issuer, audience, authorized party, nonce, subject, expiry, email, and exact device claim before retaining the access token in main-process memory. The renderer never receives the token.

Auth0 Essentials cannot safely persist the per-installation claim through refresh-token rotation. Staging therefore requests no `offline_access`, stores no refresh token, and requires a fresh interactive sign-in after the ten-minute access token expires or the process exits.

## Upstream

Obelus is derived from [Goose](https://github.com/aaif-goose/goose). Retain upstream attribution when redistributing the application, and label links to [Goose documentation](https://goose-docs.ai/) as upstream documentation until Obelus-specific documentation exists.
