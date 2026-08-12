#!/usr/bin/env bash
set -eu

##############################################################################
# Obelus CLI Install Script
#
# This script downloads the Obelus CLI binary (the compatibility binary remains
# named 'goose') from verified Obelus GitHub releases and installs it.
#
# Supported OS: macOS (darwin), Linux, Windows (MSYS2/Git Bash/WSL), Android (Termux)
# Supported Architectures: x86_64, arm64
#
# Usage:
#   Download this script from the exact Obelus release you intend to install,
#   review it, then run: bash download_cli.sh
#
# Environment variables:
#   GOOSE_BIN_DIR  - Directory to which goose will be installed (default: $HOME/.local/bin)
#   GOOSE_VERSION  - Required first-party release version (e.g., "v1.0.25"). Can be in the format vX.Y.Z, vX.Y.Z-suffix, or X.Y.Z
#   GOOSE_PROVIDER - Optional: provider for goose
#   GOOSE_MODEL    - Optional: model for goose
#   GOOSE_LINUX_VARIANT - Optional: Linux package variant to install (`standard`, `vulkan`, or `musl`)
#   GOOSE_WINDOWS_VARIANT - Optional: Windows package variant to install (`standard` or `cuda`)
#   CONFIGURE      - Optional: if set to "false", disables running goose configure interactively
#   OBELUS_RELEASE_SHA256 - Optional: expected SHA-256 for the selected archive. When omitted,
#                           the installer requires a matching `<archive>.sha256` release asset.
#   OBELUS_GITHUB_REPO - Optional: alternate owner/repository. Non-first-party repositories also
#                        require OBELUS_ALLOW_COMPATIBILITY_REPO=true.
#   ** other provider specific environment variables (eg. DATABRICKS_HOST)
##############################################################################

# --- 1) Check for dependencies ---
# Check for curl
if ! command -v curl >/dev/null 2>&1; then
  echo "Error: 'curl' is required to download goose. Please install curl and try again."
  exit 1
fi

# Check for tar or unzip (depending on OS)
if ! command -v tar >/dev/null 2>&1 && ! command -v unzip >/dev/null 2>&1; then
  echo "Error: Either 'tar' or 'unzip' is required to extract goose. Please install one and try again."
  exit 1
fi

# Check for required extraction tools based on detected OS
if [ "${OS:-}" = "windows" ]; then
  # Windows uses PowerShell's built-in Expand-Archive - check if PowerShell is available
  if ! command -v powershell.exe >/dev/null 2>&1 && ! command -v pwsh >/dev/null 2>&1; then
    echo "Warning: PowerShell is recommended to extract Windows packages but was not found."
    echo "Falling back to unzip if available."
  fi
else
  if ! command -v tar >/dev/null 2>&1; then
    echo "Error: 'tar' is required to extract packages for ${OS:-unknown}. Please install tar and try again."
    exit 1
  fi
fi


# --- 2) Variables ---
FIRST_PARTY_REPO="colinpthomson1/Obelus"
REPO="${OBELUS_GITHUB_REPO:-${GOOSE_GITHUB_REPO:-$FIRST_PARTY_REPO}}"
OUT_FILE="goose"

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Error: Invalid GitHub repository '$REPO'. Expected owner/repository."
  exit 1
fi

if [ "$REPO" != "$FIRST_PARTY_REPO" ]; then
  if [ "${OBELUS_ALLOW_COMPATIBILITY_REPO:-false}" != "true" ]; then
    echo "Error: Refusing non-first-party release repository '$REPO'."
    echo "Set OBELUS_ALLOW_COMPATIBILITY_REPO=true only for an explicit compatibility install."
    exit 1
  fi
  echo "Warning: compatibility mode enabled; installing from non-first-party repository '$REPO'."
fi

# Set default bin directory based on detected OS environment
if [[ "${WINDIR:-}" ]] || [[ "${windir:-}" ]] || [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    # Native Windows environments - use Windows user profile path
    DEFAULT_BIN_DIR="$USERPROFILE/goose"
else
    # Linux, macOS, and WSL all use the same bin directory
    DEFAULT_BIN_DIR="$HOME/.local/bin"
fi

GOOSE_BIN_DIR="${GOOSE_BIN_DIR:-$DEFAULT_BIN_DIR}"
CONFIGURE="${CONFIGURE:-true}"
GOOSE_LINUX_VARIANT="${GOOSE_LINUX_VARIANT:-}"
GOOSE_WINDOWS_VARIANT="${GOOSE_WINDOWS_VARIANT:-standard}"
if [ -n "${GOOSE_VERSION:-}" ]; then
  # Validate the version format
  if [[ ! "$GOOSE_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
    echo "[error]: invalid version '$GOOSE_VERSION'."
    echo "  expected: semver format vX.Y.Z, vX.Y.Z-suffix, or X.Y.Z"
    exit 1
  fi
  GOOSE_VERSION=$(echo "$GOOSE_VERSION" | sed 's/^v\{0,1\}/v/') # Ensure the version string is prefixed with 'v' if not already present
  RELEASE_TAG="$GOOSE_VERSION"
else
  echo "Error: GOOSE_VERSION is required; Obelus installers do not follow mutable stable or canary aliases."
  exit 1
fi

# --- 3) Detect OS/Architecture ---
# Allow explicit override for automation or when auto-detection is wrong:
#   INSTALL_OS=linux|windows|darwin
if [ -n "${INSTALL_OS:-}" ]; then
  case "${INSTALL_OS}" in
    linux|windows|darwin) OS="${INSTALL_OS}" ;;
    *) echo "[error]: unsupported INSTALL_OS='${INSTALL_OS}' (expected: linux|windows|darwin)"; exit 1 ;;
  esac
else
  # Better OS detection for Windows environments, with safer WSL handling.
  # If explicit Windows-like shells/variables are present (MSYS/Cygwin), treat as windows.
  if [[ "${WINDIR:-}" ]] || [[ "${windir:-}" ]] || [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    OS="windows"
  elif [[ -n "${TERMUX_VERSION:-}" ]]; then
    # Termux on Android: treat as Linux before the Windows mount heuristic,
    # since /d may exist on Android and would incorrectly match as Windows.
    OS="linux"
  elif [[ -f "/proc/version" ]] && grep -q "Microsoft\|WSL" /proc/version 2>/dev/null; then
    # WSL is a Linux environment regardless of the current working directory.
    # The PWD (e.g. /mnt/c/) does not change the kernel — always install Linux.
    OS="linux"
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="darwin"
  elif [[ "$PWD" =~ ^/[a-zA-Z]/ ]] && [[ -d "/c" || -d "/d" || -d "/e" ]]; then
    # Check for Windows-style mount points (like in Git Bash)
    OS="windows"
  else
    # Fallback to uname for other systems
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  fi
fi

ARCH=$(uname -m)

# Handle Windows environments (MSYS2, Git Bash, Cygwin, WSL)
case "$OS" in
  linux|darwin|windows) ;;
  mingw*|msys*|cygwin*)
    OS="windows"
    ;;
  *)
    echo "Error: Unsupported OS '$OS'. goose currently supports Linux, macOS, and Windows."
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64)
    ARCH="x86_64"
    ;;
  arm64|aarch64)
    # Some systems use 'arm64' and some 'aarch64' – standardize to 'aarch64'
    ARCH="aarch64"
    ;;
  *)
    echo "Error: Unsupported architecture '$ARCH'."
    exit 1
    ;;
esac

detect_linux_musl() {
  if [[ "$OSTYPE" == "linux-musl"* ]]; then
    return 0
  fi

  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    return 0
  fi

  return 1
}

# Termux on Android: the musl portable build is the best fit (no system-keyring, no local-inference).
if [ "$OS" = "linux" ] && [ -n "${TERMUX_VERSION:-}" ] && [ -z "$GOOSE_LINUX_VARIANT" ]; then
  echo "Termux detected (v$TERMUX_VERSION). Using musl portable build."
  GOOSE_LINUX_VARIANT="musl"
fi

if [ "$OS" = "linux" ] && [ -z "$GOOSE_LINUX_VARIANT" ]; then
  if detect_linux_musl; then
    GOOSE_LINUX_VARIANT="musl"
  else
    GOOSE_LINUX_VARIANT="standard"
  fi
elif [ -z "$GOOSE_LINUX_VARIANT" ]; then
  GOOSE_LINUX_VARIANT="standard"
fi

# Debug output (safely handle undefined variables)
echo "WINDIR: ${WINDIR:-<not set>}"
echo "OSTYPE: $OSTYPE"
echo "uname -s: $(uname -s)"
echo "uname -m: $(uname -m)"
echo "PWD: $PWD"

# Output the detected OS
echo "Detected OS: $OS with ARCH $ARCH"

# Build the filename and URL for the stable release
if [ "$OS" = "darwin" ]; then
  FILE="goose-$ARCH-apple-darwin.tar.bz2"
  EXTRACT_CMD="tar"
elif [ "$OS" = "windows" ]; then
  case "$GOOSE_WINDOWS_VARIANT" in
    standard|cuda) ;;
    *)
      echo "Error: Unsupported GOOSE_WINDOWS_VARIANT '$GOOSE_WINDOWS_VARIANT'. Expected 'standard' or 'cuda'."
      exit 1
      ;;
  esac
  # Windows only supports x86_64 currently
  if [ "$ARCH" != "x86_64" ]; then
    echo "Error: Windows currently only supports x86_64 architecture."
    exit 1
  fi
  FILE="goose-$ARCH-pc-windows-msvc.zip"
  if [ "$GOOSE_WINDOWS_VARIANT" = "cuda" ]; then
    FILE="goose-$ARCH-pc-windows-msvc-cuda.zip"
  fi
  EXTRACT_CMD="unzip"
  OUT_FILE="goose.exe"
else
  case "$GOOSE_LINUX_VARIANT" in
    standard|vulkan|musl) ;;
    *)
      echo "Error: Unsupported GOOSE_LINUX_VARIANT '$GOOSE_LINUX_VARIANT'. Expected 'standard', 'vulkan', or 'musl'."
      exit 1
      ;;
  esac
  FILE="goose-$ARCH-unknown-linux-gnu.tar.bz2"
  if [ "$GOOSE_LINUX_VARIANT" = "vulkan" ]; then
    FILE="goose-$ARCH-unknown-linux-gnu-vulkan.tar.bz2"
  elif [ "$GOOSE_LINUX_VARIANT" = "musl" ]; then
    FILE="goose-$ARCH-unknown-linux-musl.tar.bz2"
  fi
  EXTRACT_CMD="tar"
fi

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$FILE"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/obelus_install.XXXXXX") || {
  echo "Error: Could not create temporary installation directory"
  exit 1
}
PACKAGE_DIR="$TMP_DIR/package"
ARCHIVE_PATH="$TMP_DIR/$FILE"
CHECKSUM_FILE="$TMP_DIR/${FILE}.sha256"
mkdir -p "$PACKAGE_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

# --- 4) Download & extract 'goose' binary ---
echo "Downloading $RELEASE_TAG release: $FILE..."
if ! curl --proto '=https' --tlsv1.2 --silent --show-error --location --fail \
  "$DOWNLOAD_URL" --output "$ARCHIVE_PATH"; then
  echo "Error: Failed to download $DOWNLOAD_URL"
  echo "No upstream or unverified fallback will be used."
  exit 1
fi

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "Error: sha256sum, shasum, or openssl is required to verify the release." >&2
    return 1
  fi
}

EXPECTED_SHA256="${OBELUS_RELEASE_SHA256:-}"
if [ -z "$EXPECTED_SHA256" ]; then
  CHECKSUM_URL="${DOWNLOAD_URL}.sha256"
  echo "Downloading release checksum: ${FILE}.sha256..."
  if ! curl --proto '=https' --tlsv1.2 --silent --show-error --location --fail \
    "$CHECKSUM_URL" --output "$CHECKSUM_FILE"; then
    echo "Error: Failed to download required checksum $CHECKSUM_URL"
    echo "Set OBELUS_RELEASE_SHA256 to an independently verified digest to install explicitly."
    exit 1
  fi
  EXPECTED_SHA256=$(awk 'NR == 1 { print $1 }' "$CHECKSUM_FILE")
fi

if [[ ! "$EXPECTED_SHA256" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  echo "Error: Release checksum must be exactly 64 hexadecimal characters."
  exit 1
fi

ACTUAL_SHA256=$(compute_sha256 "$ARCHIVE_PATH") || {
  exit 1
}
if [ "$(printf '%s' "$ACTUAL_SHA256" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$EXPECTED_SHA256" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "Error: SHA-256 verification failed for $FILE."
  exit 1
fi
rm -f "$CHECKSUM_FILE"
echo "Verified SHA-256 for $FILE."

echo "Extracting $FILE to temporary directory..."
set +e  # Disable immediate exit on error

if [ "$EXTRACT_CMD" = "tar" ]; then
  tar -xjf "$ARCHIVE_PATH" -C "$PACKAGE_DIR" 2> "$TMP_DIR/tar_error.log"
  extract_exit_code=$?

  # Check for tar errors
  if [ $extract_exit_code -ne 0 ]; then
    if grep -iEq "missing.*bzip2|bzip2.*missing|bzip2.*No such file|No such file.*bzip2" "$TMP_DIR/tar_error.log"; then
      echo "Error: Failed to extract $FILE. 'bzip2' is required but not installed. See details below:"
    else
      echo "Error: Failed to extract $FILE. See details below:"
    fi
    cat "$TMP_DIR/tar_error.log"
    exit 1
  fi
  rm "$TMP_DIR/tar_error.log"
else
  # Use unzip for Windows
  unzip -q "$ARCHIVE_PATH" -d "$PACKAGE_DIR" 2> "$TMP_DIR/unzip_error.log"
  extract_exit_code=$?

  # Check for unzip errors
  if [ $extract_exit_code -ne 0 ]; then
    echo "Error: Failed to extract $FILE. See details below:"
    cat "$TMP_DIR/unzip_error.log"
    exit 1
  fi
  rm "$TMP_DIR/unzip_error.log"
fi

set -e  # Re-enable immediate exit on error

rm "$ARCHIVE_PATH"

# Determine the extraction directory (handle subdirectory in Windows packages)
# Windows releases may contain files in a 'goose-package' subdirectory
EXTRACT_DIR="$PACKAGE_DIR"
if [ "$OS" = "windows" ] && [ -d "$PACKAGE_DIR/goose-package" ]; then
  echo "Found goose-package subdirectory, using that as extraction directory"
  EXTRACT_DIR="$PACKAGE_DIR/goose-package"
fi

# Make binary executable
if [ "$OS" = "windows" ]; then
  chmod +x "$EXTRACT_DIR/goose.exe"
else
  chmod +x "$EXTRACT_DIR/goose"
fi

# --- 5) Install to $GOOSE_BIN_DIR ---
if [ ! -d "$GOOSE_BIN_DIR" ]; then
  echo "Creating directory: $GOOSE_BIN_DIR"
  mkdir -p "$GOOSE_BIN_DIR"
fi

echo "Moving goose to $GOOSE_BIN_DIR/$OUT_FILE"
if [ "$OS" = "windows" ]; then
  SOURCE_BINARY="$EXTRACT_DIR/goose.exe"
else
  SOURCE_BINARY="$EXTRACT_DIR/goose"
fi

DEST_BINARY="$GOOSE_BIN_DIR/$OUT_FILE"
if [ -f "$DEST_BINARY" ]; then
  BACKUP_BINARY="$DEST_BINARY.obelus-backup.$$"
  if ! mv "$DEST_BINARY" "$BACKUP_BINARY"; then
    echo "Error: could not move the existing binary out of the way. Stop any running process and retry."
    exit 1
  fi
  if ! mv "$SOURCE_BINARY" "$DEST_BINARY"; then
    echo "Error: failed to install new binary, restoring previous version"
    mv "$BACKUP_BINARY" "$DEST_BINARY"
    exit 1
  fi
  rm -f "$BACKUP_BINARY"
else
  mv "$SOURCE_BINARY" "$DEST_BINARY"
fi

# Copy Windows runtime DLLs if they exist
if [ "$OS" = "windows" ]; then
  for dll in "$EXTRACT_DIR"/*.dll; do
    if [ -f "$dll" ]; then
      echo "Moving Windows runtime DLL: $(basename "$dll")"
      mv "$dll" "$GOOSE_BIN_DIR/"
    fi
  done
fi

# skip configuration for non-interactive installs e.g. automation, docker
if [ "$CONFIGURE" = true ]; then
  # --- 6) Configure goose (Optional) ---
  echo ""
  echo "Configuring goose"
  echo ""
  if [ -t 0 ]; then
    "$GOOSE_BIN_DIR/$OUT_FILE" configure
  elif [ -r /dev/tty ]; then
    "$GOOSE_BIN_DIR/$OUT_FILE" configure < /dev/tty
  else
    echo "Non-interactive shell detected (e.g. 'curl ... | bash')."
    echo "Skipping 'goose configure' — please run it manually after installation:"
    echo "    $GOOSE_BIN_DIR/$OUT_FILE configure"
  fi
else
  echo "Skipping 'goose configure', you may need to run this manually later"
fi



# --- 7) Check PATH and give instructions if needed ---
if [[ ":$PATH:" != *":$GOOSE_BIN_DIR:"* ]]; then
  echo ""
  echo "Warning: goose installed, but $GOOSE_BIN_DIR is not in your PATH."

  if [ "$OS" = "windows" ]; then
    echo "To add goose to your PATH in PowerShell:"
    echo ""
    echo "# Add to your PowerShell profile"
    echo '$profilePath = $PROFILE'
    echo 'if (!(Test-Path $profilePath)) { New-Item -Path $profilePath -ItemType File -Force }'
    echo 'Add-Content -Path $profilePath -Value ''$env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"'''
    echo "# Reload profile or restart PowerShell"
    echo '. $PROFILE'
    echo ""
    echo "Alternatively, you can run:"
    echo "    goose configure"
    echo "or rerun this install script after updating your PATH."
  else
    SHELL_NAME=$(basename "$SHELL")

    echo ""
    echo "The \$GOOSE_BIN_DIR is not in your PATH."

    if [ "$CONFIGURE" = true ]; then
      echo "What would you like to do?"
      echo "1) Add it for me"
      echo "2) I'll add it myself, show instructions"

      # Check whether stdin is a terminal. If it is not (for example, if
      # this script has been piped into bash), we need to explicitly read user's
      # choice from /dev/tty.
      if [ -t 0 ]; then # terminal
        read -p "Enter choice [1/2]: " choice
      elif [ -r /dev/tty ]; then # not a terminal, but /dev/tty is available
        read -p "Enter choice [1/2]: " choice < /dev/tty
      else # non-interactive environment without /dev/tty
        echo "Non-interactive environment detected without /dev/tty; defaulting to option 2 (show instructions)."
        choice=2
      fi

      case "$choice" in
      1)
        RC_FILE="$HOME/.${SHELL_NAME}rc"
        echo "Adding \$GOOSE_BIN_DIR to $RC_FILE..."
        echo "export PATH=\"$GOOSE_BIN_DIR:\$PATH\"" >> "$RC_FILE"
        echo "Done! Reload your shell or run 'source $RC_FILE' to apply changes."
        ;;
      2)
        echo ""
        echo "Add it to your PATH by editing ~/.${SHELL_NAME}rc or similar:"
        echo "    export PATH=\"$GOOSE_BIN_DIR:\$PATH\""
        echo "Then reload your shell (e.g. 'source ~/.${SHELL_NAME}rc') to apply changes."
        ;;
      *)
        echo "Invalid choice. Please add \$GOOSE_BIN_DIR to your PATH manually."
        ;;
      esac
    else
      echo ""
      echo "Configure disabled. Please add \$GOOSE_BIN_DIR to your PATH manually."
    fi

  fi

  echo ""
fi
