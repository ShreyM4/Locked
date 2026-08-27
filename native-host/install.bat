@echo off
setlocal enabledelayedexpansion
title Browser Lock - Native Host Installer

echo ========================================================
echo   Browser Lock - Windows Native Credential Helper Setup
echo ========================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "EXE_PATH=%SCRIPT_DIR%\BrowserLockNativeHelper.exe"
set "CS_PATH=%SCRIPT_DIR%\BrowserLockNativeHelper.cs"
set "JSON_PATH=%SCRIPT_DIR%\com.browserlock.native_helper.json"
set "CSC_PATH=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

REM Step 1: Compile if .exe doesn't exist
if not exist "%EXE_PATH%" (
    echo [1/3] Compiling BrowserLockNativeHelper.exe...
    if exist "%CSC_PATH%" (
        "%CSC_PATH%" /nologo /optimize+ /t:exe /out:"%EXE_PATH%" "%CS_PATH%"
        if errorlevel 1 (
            echo [ERROR] Compilation failed. Please ensure .NET Framework is installed.
            pause
            exit /b 1
        )
        echo       Compiled successfully.
    ) else (
        echo [ERROR] csc.exe not found at %CSC_PATH%
        pause
        exit /b 1
    )
) else (
    echo [1/3] BrowserLockNativeHelper.exe found.
)

REM Step 2: Get Chrome Extension ID
echo.
echo [2/3] Extension ID Configuration:
echo       1. Open chrome://extensions in Chrome
echo       2. Find 'Browser Lock' (enable Developer mode if needed)
echo       3. Copy the 32-character ID (e.g. hgkmba...)
echo.
set /p EXT_ID="Enter your Browser Lock Extension ID: "

if "%EXT_ID%"=="" (
    echo [WARNING] No Extension ID entered. Using wildcard placeholder.
    set "EXT_ID=*"
)

REM Escape backslashes for JSON
set "ESCAPED_EXE=%EXE_PATH:\=\\%"

REM Step 3: Generate manifest JSON
echo.
echo [3/3] Generating native messaging host manifest...
(
    echo {
    echo   "name": "com.browserlock.native_helper",
    echo   "description": "Browser Lock Windows Native Credential Verifier",
    echo   "path": "%ESCAPED_EXE%",
    echo   "type": "stdio",
    echo   "allowed_origins": [
    echo     "chrome-extension://%EXT_ID%/"
    echo   ]
    echo }
) > "%JSON_PATH%"

REM Step 4: Register in Windows Registry
echo       Registering in Windows Registry...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browserlock.native_helper" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul

if errorlevel 1 (
    echo [ERROR] Failed to write registry key.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo   [SUCCESS] Windows Native Helper Installed!
echo   Registry: HKCU\Software\Google\Chrome\NativeMessagingHosts
echo   Host Name: com.browserlock.native_helper
echo ========================================================
echo.
echo You can now use Windows Security verification in Browser Lock.
echo.
pause
