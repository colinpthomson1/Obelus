@ECHO OFF
SETLOCAL EnableExtensions DisableDelayedExpansion

IF DEFINED OBELUS_JBANG_SHIM_ACTIVE (
    ECHO [Obelus] ERROR: Recursive JBang shim invocation detected. 1>&2
    EXIT /B 127
)

SET "OBELUS_JBANG_SHIM_ACTIVE=1"
SET "SHIM_PATH=%~f0"
SET "JBANG_BINARY="
SET "JBANG_SOURCE="

IF DEFINED OBELUS_JBANG_REGISTRY (
    SET "JBANG_REPO=%OBELUS_JBANG_REGISTRY%"
) ELSE IF DEFINED GOOSE_JBANG_REGISTRY (
    SET "JBANG_REPO=%GOOSE_JBANG_REGISTRY%"
    ECHO [Obelus] GOOSE_JBANG_REGISTRY is a compatibility alias; prefer OBELUS_JBANG_REGISTRY. 1>&2
)

IF DEFINED OBELUS_JBANG_BINARY GOTO :USE_OBELUS_BINARY
IF DEFINED GOOSE_JBANG_BINARY GOTO :USE_GOOSE_BINARY
GOTO :SEARCH_PATH

:USE_OBELUS_BINARY
SET "JBANG_BINARY=%OBELUS_JBANG_BINARY%"
SET "JBANG_SOURCE=OBELUS_JBANG_BINARY"
GOTO :VALIDATE

:USE_GOOSE_BINARY
SET "JBANG_BINARY=%GOOSE_JBANG_BINARY%"
SET "JBANG_SOURCE=GOOSE_JBANG_BINARY"
ECHO [Obelus] GOOSE_JBANG_BINARY is a compatibility alias; prefer OBELUS_JBANG_BINARY. 1>&2
GOTO :VALIDATE

:SEARCH_PATH
FOR /F "delims=" %%I IN ('WHERE.EXE jbang.exe 2^>NUL') DO (
    IF /I NOT "%%~fI"=="%SHIM_PATH%" IF NOT DEFINED JBANG_BINARY (
        SET "JBANG_BINARY=%%~fI"
        SET "JBANG_SOURCE=PATH"
    )
)
FOR /F "delims=" %%I IN ('WHERE.EXE jbang.cmd 2^>NUL') DO (
    IF /I NOT "%%~fI"=="%SHIM_PATH%" IF NOT DEFINED JBANG_BINARY (
        SET "JBANG_BINARY=%%~fI"
        SET "JBANG_SOURCE=PATH"
    )
)
IF DEFINED JBANG_BINARY GOTO :EXECUTE
ECHO [Obelus] ERROR: No safe JBang executable was found on PATH. Install JBang and set OBELUS_JBANG_BINARY to its full path. Obelus does not download runtimes at launch. 1>&2
EXIT /B 127

:VALIDATE
IF NOT EXIST "%JBANG_BINARY%" (
    ECHO [Obelus] ERROR: %JBANG_SOURCE% does not point to an installed JBang executable. Obelus does not download runtimes at launch. 1>&2
    EXIT /B 127
)
IF EXIST "%JBANG_BINARY%\*" (
    ECHO [Obelus] ERROR: %JBANG_SOURCE% points to a directory, not a JBang executable. 1>&2
    EXIT /B 127
)
FOR %%I IN ("%JBANG_BINARY%") DO SET "JBANG_BINARY=%%~fI"
IF /I "%JBANG_BINARY%"=="%SHIM_PATH%" (
    ECHO [Obelus] ERROR: JBang resolves to the Obelus shim itself. Configure a different installed binary. 1>&2
    EXIT /B 127
)

:EXECUTE
FOR %%I IN ("%JBANG_BINARY%") DO SET "JBANG_DIRECTORY=%%~dpI"
SET "PATH=%JBANG_DIRECTORY%;%PATH%"
ECHO [Obelus] JBang trust remains user-managed; Obelus does not add wildcard trust entries. 1>&2
ECHO [Obelus] Executing installed JBang runtime resolved via %JBANG_SOURCE%. 1>&2
"%JBANG_BINARY%" %*
EXIT /B %ERRORLEVEL%
