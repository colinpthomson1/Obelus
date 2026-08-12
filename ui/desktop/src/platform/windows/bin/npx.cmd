@ECHO OFF
SETLOCAL EnableExtensions DisableDelayedExpansion

IF DEFINED OBELUS_NPX_SHIM_ACTIVE (
    ECHO [Obelus] ERROR: Recursive npx shim invocation detected. 1>&2
    EXIT /B 127
)

SET "OBELUS_NPX_SHIM_ACTIVE=1"
SET "SHIM_PATH=%~f0"
SET "NPX_BINARY="
SET "NPX_SOURCE="

IF DEFINED OBELUS_NPX_BINARY GOTO :USE_OBELUS_BINARY
IF DEFINED GOOSE_NPX_BINARY GOTO :USE_GOOSE_BINARY
IF DEFINED OBELUS_NODE_DIR GOTO :USE_OBELUS_NODE_DIR
IF DEFINED GOOSE_NODE_DIR GOTO :USE_GOOSE_NODE_DIR
GOTO :SEARCH_PATH

:USE_OBELUS_BINARY
SET "NPX_BINARY=%OBELUS_NPX_BINARY%"
SET "NPX_SOURCE=OBELUS_NPX_BINARY"
GOTO :VALIDATE

:USE_GOOSE_BINARY
SET "NPX_BINARY=%GOOSE_NPX_BINARY%"
SET "NPX_SOURCE=GOOSE_NPX_BINARY"
ECHO [Obelus] GOOSE_NPX_BINARY is a compatibility alias; prefer OBELUS_NPX_BINARY. 1>&2
GOTO :VALIDATE

:USE_OBELUS_NODE_DIR
SET "NPX_BINARY=%OBELUS_NODE_DIR%\npx.cmd"
SET "NPX_SOURCE=OBELUS_NODE_DIR"
GOTO :VALIDATE

:USE_GOOSE_NODE_DIR
SET "NPX_BINARY=%GOOSE_NODE_DIR%\npx.cmd"
SET "NPX_SOURCE=GOOSE_NODE_DIR"
ECHO [Obelus] GOOSE_NODE_DIR is a compatibility alias; prefer OBELUS_NPX_BINARY. 1>&2
GOTO :VALIDATE

:SEARCH_PATH
FOR /F "delims=" %%I IN ('WHERE.EXE npx.cmd 2^>NUL') DO (
    IF /I NOT "%%~fI"=="%SHIM_PATH%" IF NOT DEFINED NPX_BINARY (
        SET "NPX_BINARY=%%~fI"
        SET "NPX_SOURCE=PATH"
    )
)
IF DEFINED NPX_BINARY GOTO :EXECUTE
ECHO [Obelus] ERROR: No safe npx executable was found on PATH. Install Node.js and set OBELUS_NPX_BINARY to the full path of npx.cmd. Obelus does not download runtimes at launch. 1>&2
EXIT /B 127

:VALIDATE
IF NOT EXIST "%NPX_BINARY%" (
    ECHO [Obelus] ERROR: %NPX_SOURCE% does not point to an installed npx executable. Obelus does not download runtimes at launch. 1>&2
    EXIT /B 127
)
IF EXIST "%NPX_BINARY%\*" (
    ECHO [Obelus] ERROR: %NPX_SOURCE% points to a directory, not an npx executable. 1>&2
    EXIT /B 127
)
FOR %%I IN ("%NPX_BINARY%") DO SET "NPX_BINARY=%%~fI"
IF /I "%NPX_BINARY%"=="%SHIM_PATH%" (
    ECHO [Obelus] ERROR: npx resolves to the Obelus shim itself. Configure a different installed binary. 1>&2
    EXIT /B 127
)

:EXECUTE
FOR %%I IN ("%NPX_BINARY%") DO SET "NPX_DIRECTORY=%%~dpI"
SET "PATH=%NPX_DIRECTORY%;%PATH%"
ECHO [Obelus] Executing installed npx runtime resolved via %NPX_SOURCE%. 1>&2
"%NPX_BINARY%" %*
EXIT /B %ERRORLEVEL%
