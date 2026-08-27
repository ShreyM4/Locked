# Browser Lock — Privacy-First Chrome Extension

A Chrome Extension (Manifest V3) that acts as a **browser-profile lock screen** with PIN authentication and **Forgot PIN Recovery** via Offline Google Authenticator / 2FA.

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
4. **Step 3 (Recovery Authenticator):**
   - Scan the offline QR code with **Google Authenticator** (or any 2FA app).
   - Enter the current **6-digit code** from the app to verify you scanned it.
   - Click **Complete Setup & Lock** → Native **Save As** prompt opens to save your raw binary recovery key.
   - PIN is hashed with PBKDF2-SHA256 (600,000 iterations) + random salt.
5. Browser locks immediately so you can verify your PIN works.

### Subsequent Startups
1. Chrome profile starts → extension detects startup via `chrome.runtime.onStartup`
2. All existing windows are **covered with a black canvas, fullscreened, and minimized** (preserving your session and keeping Windows taskbar thumbnail previews 100% black)
3. A dedicated popup window appears with the lock screen
4. Enter your PIN → windows and previous tabs are restored cleanly

### Forgot PIN Recovery Flow
```text
Lock Screen ("Forgot PIN?")
    ↓
Recovery Window (Two Options):
  ├─ Option 1: App Code (6-digit TOTP from Google Authenticator)
  └─ Option 2: Saved Key File / Text (Upload saved binary key file or paste manual key)
    ↓
Successful Local Verification
    ↓
Create New Browser Lock PIN (New PIN + Confirm PIN)
    ↓
Browser Unlocks & Restores Previous Tabs
```
*If verification fails or is cancelled, the browser remains locked.*

---

## Permissions

### Permanent Permissions (4)

| Permission | Why Required | What Data It Exposes |
|---|---|---|
| `storage` | Persist PIN hash/salt, TOTP secret, lock state, settings, and failed-attempt counters across service worker restarts | The extension's own isolated storage only — **no access to browsing data, history, bookmarks, or any other user data** |
| `alarms` | Schedule brute-force lockout timers and inactivity re-lock timers | **Nothing** — only allows scheduling named timers within the extension |
| `identity` | Access `chrome.identity.getProfileUserInfo` to retrieve the signed-in Google account email for labeling the 2FA authenticator entry | **Nothing external** — local read of profile user info |
| `identity.email` | Allows `chrome.identity.getProfileUserInfo` to return the email string (e.g. `user@gmail.com`) for the QR code label | Google account email only for local offline QR label |

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
| TOTP Key | 20 bytes, cryptographically random (`crypto.getRandomValues`) |
| Verification | Constant-time XOR comparison against stored hash |
| Lockout after 5 failed attempts | 10 seconds |
| Lockout after 10 failed attempts | 30 seconds |
| Lockout after 15+ failed attempts | 60 seconds |

---

## Project Structure

```
Locked/
├── manifest.json       Manifest V3 with minimal permissions
├── background.js       Service worker — state machine, crypto, recovery handlers
├── totp.js             Offline RFC 6238 TOTP & pure SVG QR Code generator
├── cover.html          Black screen cover tab for Windows taskbar Peek privacy
├── lock.html           Lock screen UI with "Forgot PIN?" trigger
├── lock.css            Lock screen styles (dark glassmorphism)
├── lock.js             Lock screen logic
├── recovery.html       Recovery screen (Google Authenticator TOTP & Saved Key File)
├── recovery.css        Recovery UI styles (segmented tab controls)
├── recovery.js         Recovery client logic (FileReader binary parser)
├── setup.html          First-run onboarding (PIN creation + TOTP QR + Verification)
├── setup.css           Setup screen styles
├── setup.js            Setup logic (with binary key export)
├── options.html        Settings page UI (PIN, Shortcut, Inactivity, TOTP QR)
├── options.css         Settings styles
├── options.js          Settings logic
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

### 2. Forgot PIN → Authenticator App (TOTP)
- On lock screen, click **"Forgot PIN?"**.
- On the **"App Code"** tab, enter the 6-digit TOTP code from Google Authenticator.
- Transitions to **"Create New PIN"**.
- Enter new PIN and confirm → saves new PIN and unlocks browser.

### 3. Forgot PIN → Saved Key File / Manual Text
- On lock screen, click **"Forgot PIN?"**.
- Switch to the **"Saved Key / File"** tab.
- Click **"Click to upload saved key file"** and select the binary key file saved during setup (e.g. `browser-lock-xxx-key`), OR paste the manual Base32 key string into the field and click **"Verify Key"**.
- Key is verified locally → transitions to **"Create New PIN"** → sets new PIN and unlocks browser.
