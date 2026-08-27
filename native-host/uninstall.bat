@echo off
title Browser Lock - Native Host Uninstaller

echo ========================================================
echo   Browser Lock - Windows Native Host Uninstaller
echo ========================================================
echo.

reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browserlock.native_helper" /f >nul 2>&1

if errorlevel 1 (
    echo [INFO] Registry key was not present or already removed.
) else (
    echo [SUCCESS] Removed registry entry for com.browserlock.native_helper.
)

echo.
pause
