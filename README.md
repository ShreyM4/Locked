# Browser Lock — Privacy-First Chrome Extension

A Chrome Extension (Manifest V3) that acts as a **browser-profile lock screen** with PIN authentication and **Forgot PIN Recovery** (Windows Security & Offline Authenticator App).

**Zero external connections. Zero tracking. Zero analytics. Everything stays local.**

---

## Installation

1. Download or clone this folder (`Locked/`)
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `Locked` folder
6. The extension will install and immediately open the **Setup** screen

---

## How It Works

### First Run & Setup
1. Extension installs → setup window appears
2. **Step 1:** Create a PIN (4–16 digits)
3. **Step 2:** Confirm your PIN
4. **Step 3 (Recovery Authenticator):** Scan the offline QR code with Google Authenticator or any standard 2FA app.
5. Click **Complete Setup & Lock** → PIN is hashed with PBKDF2-SHA256 (600,000 iterations) + random salt.
6. Browser locks immediately so you can verify your PIN works.

### Subsequent Startups
1. Chrome profile starts → extension detects startup via `chrome.runtime.onStartup`
2. All existing windows are **minimized** (not closed — your session is preserved)
3. A dedicated popup window appears with the lock screen
4. Enter your PIN → windows are restored to their previous state

### Forgot PIN Recovery Flow
```text
Lock Screen ("Forgot PIN?")
    ↓
Recovery Selection:
  ├─ Option 1: Windows Security (Real Windows Credential Prompt via Native Host)
  └─ Option 2: Authenticator App (Offline 6-digit TOTP Verification)
    ↓
Successful Verification
    ↓
Create New Browser Lock PIN
    ↓
Unlock Browser & Restore Windows
```
*If verification fails or is cancelled, the browser remains locked.*

---

## Forgot PIN Recovery Mechanisms

### 1. Windows Native Security Verification

- **Real Windows Credential Dialog:** Uses `CredUIPromptForWindowsCredentials` via a lightweight C# Native Messaging host (`BrowserLockNativeHelper.exe`).
- **Authentic System UI:** Windows displays its authentic credential screen allowing Windows PIN or Password verification.
- **Privacy First:** Credentials are verified locally by Windows (`LogonUser`). The extension receives **only `{ "success": true }` or `{ "success": false }` — never the Windows password or PIN**.
- **Installation:** Run `native-host\install.bat` once to register the host in Windows Registry.

### 2. Google Authenticator / Offline TOTP (RFC 6238)

- **100% Offline:** TOTP calculation and verification use the browser's built-in Web Crypto API (`crypto.subtle` HMAC-SHA1).
- **Offline QR Code:** The QR code in setup and settings is rendered completely locally using pure SVG math — zero external image servers or CDNs.
- **Universal Compatibility:** Works with Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden, and any standard TOTP app.

---

## Permissions

### Permanent Permissions (3)

| Permission | Why Required | What Data It Exposes |
|---|---|---|
| `storage` | Persist PIN hash/salt, TOTP secret, lock state, settings, and failed-attempt counters across service worker restarts | The extension's own isolated storage only — **no access to browsing data, history, bookmarks, or any other user data** |
| `alarms` | Schedule brute-force lockout timers and inactivity re-lock timers | **Nothing** — only allows scheduling named timers within the extension |
| `nativeMessaging` | Communicate with the local `com.browserlock.native_helper` host to trigger the Windows Security prompt | **Only communication with the registered local binary** — receives only boolean success/failure |

### Optional Permission (1)

| Permission | Why Required | When Requested | What Data It Exposes |
|---|---|---|---|
| `idle` | Detect system-wide inactivity for the "auto-lock after N minutes" feature | Only when the user enables an inactivity timeout in Settings | System idle state (active/idle/locked) — **no browsing data** |

---

## PIN Security & Brute-Force Protection

| Property | Value |
|---|---|
| Algorithm | PBKDF2 |
| Hash function | SHA-256 |
| Iterations | 600,000 (OWASP recommendation) |
| Salt | 16 bytes, cryptographically random (`crypto.getRandomValues`) |
| Verification | Constant-time XOR comparison against stored hash |
| Lockout after 5 failed attempts | 10 seconds |
| Lockout after 10 failed attempts | 30 seconds |
| Lockout after 15+ failed attempts | 60 seconds |

---

## Native Host Registration

To enable the **Windows Security Verification** recovery option:

1. Open `native-host/` folder.
2. Double-click `install.bat`.
3. Paste your Extension ID when prompted (found at `chrome://extensions`).
4. That's it! Windows Registry key is created under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browserlock.native_helper`.

*(To uninstall, simply run `native-host\uninstall.bat`)*

---

## Project Structure

```
Locked/
├── manifest.json       Manifest V3 with minimal permissions
├── background.js       Service worker — state machine, crypto, recovery handlers
├── totp.js             Offline RFC 6238 TOTP & pure SVG QR Code generator
├── lock.html           Lock screen UI with "Forgot PIN?" trigger
├── lock.css            Lock screen styles (dark glassmorphism)
├── lock.js             Lock screen logic
├── recovery.html       Recovery screen (Windows Security & TOTP)
├── recovery.css        Recovery UI styles
├── recovery.js         Recovery client logic
├── setup.html          First-run onboarding (PIN creation + TOTP QR)
├── setup.css           Setup screen styles
├── setup.js            Setup logic
├── options.html        Settings page UI (PIN, Shortcut, Inactivity, TOTP QR)
├── options.css         Settings styles
├── options.js          Settings logic
├── native-host/
│   ├── BrowserLockNativeHelper.cs   C# Windows Credential Helper source
│   ├── BrowserLockNativeHelper.exe  Compiled native binary
│   ├── com.browserlock.native_helper.json Native messaging manifest
│   ├── install.bat                  1-click installer & registrar
│   └── uninstall.bat                Uninstaller
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md           This documentation
```

---

## Testing Guide

### 1. Lock & Normal PIN Flow
- Lock browser (Ctrl+Shift+Z or click icon).
- Enter correct PIN → unlocks normally and restores windows.

### 2. Forgot PIN → Windows Security
- On lock screen, click **"Forgot PIN?"**.
- Click **"Verify with Windows"**.
- The authentic Windows Security prompt appears asking for your Windows PIN or Password.
- Enter your Windows credentials → screen transitions to **"Create New PIN"**.
- Enter a new PIN and confirm → saves new PIN and unlocks browser.

### 3. Forgot PIN → Authenticator App (TOTP)
- On lock screen, click **"Forgot PIN?"**.
- Open Google Authenticator on your phone.
- Enter the 6-digit TOTP code into the field and click **"Verify Code"**.
- Successful verification transitions to **"Create New PIN"**.
- Enter new PIN → unlocks browser.
- Entering an incorrect code displays an error and leaves browser locked.
