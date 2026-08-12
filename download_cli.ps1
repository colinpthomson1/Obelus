##############################################################################
# Obelus CLI Install Script for Windows PowerShell
#
# This script downloads the Obelus CLI binary (the compatibility binary remains
# named 'goose.exe') from verified Obelus GitHub releases and installs it.
#
# Supported OS: Windows
# Supported Architectures: x86_64
#
# Usage:
#   Download this script from the exact Obelus release you intend to install,
#   review it, then run: .\download_cli.ps1
#
# Environment variables:
#   $env:GOOSE_BIN_DIR  - Directory to which goose will be installed (default: $env:USERPROFILE\.local\bin)
#   $env:GOOSE_VERSION  - Required first-party release version (e.g., "v1.0.25"). Can be in the format vX.Y.Z, vX.Y.Z-suffix, or X.Y.Z
#   $env:GOOSE_PROVIDER - Optional: provider for goose
#   $env:GOOSE_MODEL    - Optional: model for goose
#   $env:GOOSE_WINDOWS_VARIANT - Optional: Windows package variant to install ("standard" or "cuda")
#   $env:CONFIGURE      - Optional: if set to "false", disables running goose configure interactively
#   $env:OBELUS_RELEASE_SHA256 - Optional: expected SHA-256 for the selected archive. When omitted,
#                                the installer requires a matching `<archive>.sha256` release asset.
#   $env:OBELUS_GITHUB_REPO - Optional: alternate owner/repository. Non-first-party repositories also
#                             require $env:OBELUS_ALLOW_COMPATIBILITY_REPO="true".
##############################################################################

# Set error action preference to stop on errors
$ErrorActionPreference = "Stop"

# --- 1) Variables ---
$FIRST_PARTY_REPO = "colinpthomson1/Obelus"
$REPO = if ($env:OBELUS_GITHUB_REPO) {
    $env:OBELUS_GITHUB_REPO
} elseif ($env:GOOSE_GITHUB_REPO) {
    $env:GOOSE_GITHUB_REPO
} else {
    $FIRST_PARTY_REPO
}
$OUT_FILE = "goose.exe"

if ($REPO -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    Write-Error "Invalid GitHub repository '$REPO'. Expected owner/repository."
    exit 1
}

if ($REPO -ne $FIRST_PARTY_REPO) {
    if ($env:OBELUS_ALLOW_COMPATIBILITY_REPO -ne "true") {
        Write-Error "Refusing non-first-party release repository '$REPO'. Set OBELUS_ALLOW_COMPATIBILITY_REPO=true only for an explicit compatibility install."
        exit 1
    }
    Write-Warning "Compatibility mode enabled; installing from non-first-party repository '$REPO'."
}

# Set default bin directory if not specified
if (-not $env:GOOSE_BIN_DIR) {
    $env:GOOSE_BIN_DIR = Join-Path $env:USERPROFILE ".local\bin"
}

$CONFIGURE = if ($env:CONFIGURE -eq "false") { "false" } else { "true" }
$WINDOWS_VARIANT = if ($env:GOOSE_WINDOWS_VARIANT) { $env:GOOSE_WINDOWS_VARIANT.ToLowerInvariant() } else { "standard" }

# Determine release tag
if ($env:GOOSE_VERSION) {
    # Validate version format
    if ($env:GOOSE_VERSION -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$') {
        Write-Error "Invalid version '$env:GOOSE_VERSION'. Expected: semver format vX.Y.Z, vX.Y.Z-suffix, or X.Y.Z"
        exit 1
    }
    # Ensure version starts with 'v'
    $RELEASE_TAG = if ($env:GOOSE_VERSION.StartsWith("v")) { $env:GOOSE_VERSION } else { "v$env:GOOSE_VERSION" }
} else {
    Write-Error "GOOSE_VERSION is required; Obelus installers do not follow mutable stable or canary aliases."
    exit 1
}

# --- 2) Detect Architecture ---
$ARCH = $env:PROCESSOR_ARCHITECTURE
if ($ARCH -eq "AMD64") {
    $ARCH = "x86_64"
} elseif ($ARCH -eq "ARM64") {
    Write-Error "Windows ARM64 is not currently supported."
    exit 1
} else {
    Write-Error "Unsupported architecture '$ARCH'. Only x86_64 is supported on Windows."
    exit 1
}

if ($WINDOWS_VARIANT -ne "standard" -and $WINDOWS_VARIANT -ne "cuda") {
    Write-Error "Unsupported GOOSE_WINDOWS_VARIANT '$WINDOWS_VARIANT'. Expected 'standard' or 'cuda'."
    exit 1
}

# --- 3) Build download URL ---
$FILE = if ($WINDOWS_VARIANT -eq "cuda") { "goose-$ARCH-pc-windows-msvc-cuda.zip" } else { "goose-$ARCH-pc-windows-msvc.zip" }
$DOWNLOAD_URL = "https://github.com/$REPO/releases/download/$RELEASE_TAG/$FILE"
$TMP_DIR = Join-Path $env:TEMP "obelus_install_$(Get-Random)"
try {
    New-Item -ItemType Directory -Path $TMP_DIR -Force | Out-Null
    Write-Host "Created temporary directory: $TMP_DIR" -ForegroundColor Yellow
} catch {
    Write-Error "Could not create temporary installation directory: $TMP_DIR"
    exit 1
}
$ARCHIVE_PATH = Join-Path $TMP_DIR $FILE
$CHECKSUM_FILE = "$ARCHIVE_PATH.sha256"

Write-Host "Downloading $RELEASE_TAG release: $FILE..." -ForegroundColor Green

# --- 4) Download the file ---
try {
    Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $ARCHIVE_PATH -UseBasicParsing
    Write-Host "Download completed successfully." -ForegroundColor Green
} catch {
    Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
    Write-Error "Failed to download $DOWNLOAD_URL. No upstream or unverified fallback will be used. Error: $($_.Exception.Message)"
    exit 1
}

# --- 5) Verify the archive before extraction ---
$EXPECTED_SHA256 = $env:OBELUS_RELEASE_SHA256
if (-not $EXPECTED_SHA256) {
    $CHECKSUM_URL = "$DOWNLOAD_URL.sha256"
    Write-Host "Downloading release checksum: $CHECKSUM_FILE..." -ForegroundColor Green
    try {
        Invoke-WebRequest -Uri $CHECKSUM_URL -OutFile $CHECKSUM_FILE -UseBasicParsing
        $EXPECTED_SHA256 = ((Get-Content -Path $CHECKSUM_FILE -Raw).Trim() -split '\s+')[0]
    } catch {
        Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        Write-Error "Failed to download required checksum $CHECKSUM_URL. Set OBELUS_RELEASE_SHA256 to an independently verified digest to install explicitly."
        exit 1
    }
}

if ($EXPECTED_SHA256 -notmatch '^[A-Fa-f0-9]{64}$') {
    Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
    Write-Error "Release checksum must be exactly 64 hexadecimal characters."
    exit 1
}

$ACTUAL_SHA256 = (Get-FileHash -Path $ARCHIVE_PATH -Algorithm SHA256).Hash
if ($ACTUAL_SHA256 -ne $EXPECTED_SHA256) {
    Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
    Write-Error "SHA-256 verification failed for $FILE."
    exit 1
}
Remove-Item -Path $CHECKSUM_FILE -Force -ErrorAction SilentlyContinue
Write-Host "Verified SHA-256 for $FILE." -ForegroundColor Green

# --- 6) Extract the archive ---
Write-Host "Extracting $FILE to temporary directory..." -ForegroundColor Green
try {
    Expand-Archive -Path $ARCHIVE_PATH -DestinationPath $TMP_DIR -Force
    Write-Host "Extraction completed successfully." -ForegroundColor Green
} catch {
    Write-Error "Failed to extract $FILE. Error: $($_.Exception.Message)"
    Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# Clean up the downloaded archive
Remove-Item -Path $ARCHIVE_PATH -Force

# --- 7) Determine extraction directory ---
$EXTRACT_DIR = $TMP_DIR
if (Test-Path (Join-Path $TMP_DIR "goose-package")) {
    Write-Host "Found goose-package subdirectory, using that as extraction directory" -ForegroundColor Yellow
    $EXTRACT_DIR = Join-Path $TMP_DIR "goose-package"
}

# --- 8) Create bin directory if it doesn't exist ---
if (-not (Test-Path $env:GOOSE_BIN_DIR)) {
    Write-Host "Creating directory: $env:GOOSE_BIN_DIR" -ForegroundColor Yellow
    try {
        New-Item -ItemType Directory -Path $env:GOOSE_BIN_DIR -Force | Out-Null
    } catch {
        Write-Error "Could not create directory: $env:GOOSE_BIN_DIR"
        Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        exit 1
    }
}

# --- 9) Install goose binary ---
$SOURCE_GOOSE = Join-Path $EXTRACT_DIR "goose.exe"
$DEST_GOOSE = Join-Path $env:GOOSE_BIN_DIR $OUT_FILE

if (Test-Path $SOURCE_GOOSE) {
    Write-Host "Moving goose to $DEST_GOOSE" -ForegroundColor Green
    $BACKUP_GOOSE = "$DEST_GOOSE.obelus-backup-$([guid]::NewGuid().ToString('N'))"
    $MOVED_EXISTING = $false
    try {
        if (Test-Path $DEST_GOOSE) {
            Move-Item -Path $DEST_GOOSE -Destination $BACKUP_GOOSE
            $MOVED_EXISTING = $true
        }
        Move-Item -Path $SOURCE_GOOSE -Destination $DEST_GOOSE
        if ($MOVED_EXISTING) {
            Remove-Item -Path $BACKUP_GOOSE -Force
        }
    } catch {
        if ($MOVED_EXISTING -and -not (Test-Path $DEST_GOOSE) -and (Test-Path $BACKUP_GOOSE)) {
            Move-Item -Path $BACKUP_GOOSE -Destination $DEST_GOOSE
        }
        Write-Error "Failed to move goose.exe to $DEST_GOOSE. Error: $($_.Exception.Message)"
        Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        exit 1
    }
} else {
    Write-Error "goose.exe not found in extracted files"
    Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# --- 10) Copy Windows runtime DLLs if they exist ---
$DLL_FILES = Get-ChildItem -Path $EXTRACT_DIR -Filter "*.dll" -ErrorAction SilentlyContinue
foreach ($dll in $DLL_FILES) {
    $DEST_DLL = Join-Path $env:GOOSE_BIN_DIR $dll.Name
    Write-Host "Moving Windows runtime DLL: $($dll.Name)" -ForegroundColor Green
    try {
        # Remove existing file if it exists to avoid conflicts
        if (Test-Path $DEST_DLL) {
            Remove-Item -Path $DEST_DLL -Force
        }
        Move-Item -Path $dll.FullName -Destination $DEST_DLL -Force
    } catch {
        Write-Warning "Failed to move $($dll.Name): $($_.Exception.Message)"
    }
}

# --- 11) Clean up temporary directory ---
try {
    Remove-Item -Path $TMP_DIR -Recurse -Force
    Write-Host "Cleaned up temporary directory." -ForegroundColor Yellow
} catch {
    Write-Warning "Could not clean up temporary directory: $TMP_DIR"
}

# --- 12) Configure goose (Optional) ---
if ($CONFIGURE -eq "true") {
    Write-Host ""
    Write-Host "Configuring goose" -ForegroundColor Green
    Write-Host ""
    try {
        & $DEST_GOOSE configure
    } catch {
        Write-Warning "Failed to run goose configure. You may need to run it manually later."
    }
} else {
    Write-Host "Skipping 'goose configure', you may need to run this manually later" -ForegroundColor Yellow
}

# --- 13) Check PATH and give instructions if needed ---
$CURRENT_PATH = $env:PATH
if ($CURRENT_PATH -notlike "*$env:GOOSE_BIN_DIR*") {
    Write-Host ""
    Write-Host "Warning: goose installed, but $env:GOOSE_BIN_DIR is not in your PATH." -ForegroundColor Yellow
    Write-Host "To add it to your PATH permanently, run the following command as Administrator:" -ForegroundColor Yellow
    Write-Host "    [Environment]::SetEnvironmentVariable('PATH', `$env:PATH + ';$env:GOOSE_BIN_DIR', 'Machine')" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Or add it to your user PATH (no admin required):" -ForegroundColor Yellow
    Write-Host "    [Environment]::SetEnvironmentVariable('PATH', `$env:PATH + ';$env:GOOSE_BIN_DIR', 'User')" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "For this session only, you can run:" -ForegroundColor Yellow
    Write-Host "    `$env:PATH += ';$env:GOOSE_BIN_DIR'" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "goose CLI installation completed successfully!" -ForegroundColor Green
Write-Host "goose is installed at: $DEST_GOOSE" -ForegroundColor Green
