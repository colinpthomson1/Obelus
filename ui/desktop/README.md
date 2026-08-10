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

## Upstream

Obelus is derived from [Goose](https://github.com/aaif-goose/goose). Retain upstream attribution when redistributing the application, and label links to [Goose documentation](https://goose-docs.ai/) as upstream documentation until Obelus-specific documentation exists.
