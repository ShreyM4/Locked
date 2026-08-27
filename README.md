# Browser Lock — Privacy-First Chrome Extension

A Chrome Extension (Manifest V3) that acts as a **browser-profile lock screen** with PIN authentication.

**Zero external connections. Zero tracking. Zero analytics. Everything stays local.**

---

## Installation

1. Download or clone this folder (`browser-lock/`)
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `browser-lock` folder
6. The extension will install and immediately open the **PIN setup** screen

---

## How It Works

### First Run
1. Extension installs → setup window appears
2. Create a PIN (4–16 digits) → confirm it
3. PIN is hashed with PBKDF2-SHA256 (600,000 iterations) + random salt
4. Only the salt and derived hash are stored — **never the plaintext PIN**
5. Browser locks immediately so you can verify your PIN works

### Subsequent Startups
1. Chrome profile starts → extension detects startup via `chrome.runtime.onStartup`
2. All existing windows are **minimized** (not closed — your session is preserved)
3. A dedicated popup window appears with the lock screen
4. Enter your PIN → windows are restored to their previous state

### While Locked
- New windows are automatically closed
- New tabs outside the lock window are removed
- If a protected window gains focus, it's re-minimized
- If the lock window is closed, it's immediately recreated
- Clicking the extension icon focuses the lock window

---

## Permissions

### Permanent Permissions (2)

| Permission | Why Required | What Data It Exposes |
|---|---|---|
| `storage` | Persist PIN hash/salt, lock state, settings, and failed-attempt counters across service worker restarts | The extension's own isolated storage only — **no access to browsing data, history, bookmarks, or any other user data** |
| `alarms` | Schedule brute-force lockout timers and inactivity re-lock timers. `setTimeout` is unreliable in MV3 service workers that can be terminated at any time | **Nothing** — only allows scheduling named timers within the extension |

### Optional Permission (1)

| Permission | Why Required | When Requested | What Data It Exposes |
|---|---|---|---|
| `idle` | Detect system-wide inactivity for the "auto-lock after N minutes" feature | Only when the user enables an inactivity timeout in Settings | System idle state (active/idle/locked) — **no browsing data** |

### Permissions NOT Requested

| Permission | Why NOT Needed |
|---|---|
| `tabs` | We only need tab IDs (not URLs/titles) to manage tabs. `chrome.tabs.query()` and `chrome.tabs.remove()` work without this permission. |
| `history` | Not needed. Sessions are preserved by minimizing windows, not by reading/saving URLs. |
| `notifications` | Not used. |
| `tabGroups` | Not needed. Chrome preserves tab groups in minimized windows automatically. |
| `activeTab` | Not used. |
| `scripting` | Not used. No content scripts. |
| `<all_urls>` / host permissions | Not needed. The extension never accesses web page content. |

> **Result: No permission warnings are shown to the user on install.** Both `storage` and `alarms` are "silent" permissions.

---

## PIN Security

| Property | Value |
|---|---|
| Algorithm | PBKDF2 |
| Hash function | SHA-256 |
| Iterations | 600,000 (OWASP 2023 recommendation) |
| Salt | 16 bytes, cryptographically random (`crypto.getRandomValues`) |
| Derived hash | 256 bits |
| Stored data | `{ salt, hash, iterations }` — all base64-encoded |
| Plaintext PIN stored? | **Never** |
| Verification | Derive hash from entered PIN + stored salt → constant-time compare against stored hash |

---

## Brute Force Protection

| Failed Attempts | Lockout Delay |
|---|---|
| 1–4 | None |
| 5–9 | 10 seconds |
| 10–14 | 30 seconds |
| 15+ | 60 seconds |

- The attempt counter is **persisted** in `chrome.storage.local`
- Restarting Chrome or the service worker does **not** reset the counter
- The counter resets to 0 on successful unlock

---

## Security Analysis

### What Data the Extension Can Access
- Its own `chrome.storage.local` data (PIN hash, salt, settings, state)
- Window IDs and basic window properties (position, size, state)
- Tab IDs (but NOT URLs, titles, or content — the `tabs` permission is not requested)

### What It CANNOT Access
- Web page content
- Browsing history
- Bookmarks
- Cookies
- Passwords
- Autofill data
- Any network data
- Any other extension's data

### Where the PIN is Stored
- `chrome.storage.local` within the extension's isolated storage
- Stored as a PBKDF2-derived hash + salt — never in plaintext
- Accessible only to this extension (Chrome enforces storage isolation)

### Does Any Data Leave the Computer?
**No.** The extension makes zero network requests. It contains no external scripts, no CDN dependencies, no analytics, no telemetry, and no remote APIs. It works completely offline.

### What Happens If the Extension Is Compromised?
An attacker with access to the extension's storage could:
- Read the PBKDF2 hash and salt
- Attempt an offline brute-force attack against the hash (600K iterations makes this expensive)
- They could NOT recover the PIN from the hash alone

An attacker with the ability to modify the extension's code could:
- Bypass the lock entirely
- This is equivalent to OS-level access (see below)

### What Happens If Someone Has OS-Level Access?
A user with access to the underlying operating system account can:
- Disable or remove the extension via `chrome://extensions`
- Delete the extension files from disk
- Modify Chrome's profile directory
- Access Chrome's data files directly
- Use Chrome flags or command-line switches

**This extension is NOT equivalent to an OS-level login screen.** It provides a deterrent against casual access to a Chrome profile, not protection against a determined attacker with administrative access to the computer.

---

## Recovery / Reset

### If You Forget Your PIN

Since there is intentionally no account, no cloud service, and no recovery server, **forgetting your PIN means you must reset the extension.**

**Recovery procedure:**

1. Navigate to `chrome://extensions`
2. Find "Browser Lock"
3. Click **Remove** to uninstall the extension
4. Reinstall the extension (Load unpacked)
5. Set up a new PIN

Alternative (without removing):
1. Navigate to `chrome://extensions`
2. Find "Browser Lock"
3. Click the **Details** button
4. Scroll down and click **Clear data** (or toggle the extension off/on)
5. The extension will return to the setup state

> **There is no hardcoded master PIN, no backdoor, and no hidden bypass.**

---

## Known Chrome Limitations

### 1. Brief New Tab Flash on Startup
Chrome opens its own UI (New Tab page) before the extension's `onStartup` event fires. There will be a **sub-second flash** of the normal Chrome window before the extension minimizes it and shows the lock screen. This is an architectural limitation of Chrome extensions — they cannot execute before Chrome itself starts.

### 2. Minimized Window Flash
When someone attempts to restore a minimized window from the Windows taskbar while locked, the window may briefly appear before the extension's `onFocusChanged` handler re-minimizes it. This is typically a fraction of a second.

### 3. Service Worker Termination
MV3 service workers are ephemeral — Chrome can terminate them after a period of inactivity. All critical state is persisted to `chrome.storage.local` and event listeners are re-registered on restart, but there may be brief gaps in monitoring. The self-check IIFE at the bottom of `background.js` handles re-establishing the lock state.

### 4. Not OS-Level Security
See the Security Analysis section above. This extension provides profile-level convenience locking, not enterprise-grade security.

### 5. Chrome Task Manager
A user can open Chrome's Task Manager (Shift+Esc) while the lock screen is active. This cannot be prevented by an extension.

### 6. Multiple Monitors
The lock window appears on one monitor. On multi-monitor setups, the minimized windows might be briefly visible on other monitors when attempting to restore them from the taskbar.

---

## Settings

Access settings by clicking the extension icon while unlocked, or via `chrome://extensions` → Browser Lock → Details → Extension options.

| Setting | Default | Description |
|---|---|---|
| Lock on startup | ✅ On | Lock the browser when Chrome starts |
| Inactivity timeout | Never | Auto-lock after 5/15/30/60 minutes of inactivity (requires optional `idle` permission) |
| Change PIN | — | Change your PIN (requires current PIN verification) |
| Lock now | — | Immediately lock the browser |
| Reset extension | — | Remove all data and set up a new PIN (requires current PIN) |

---

## Project Structure

```
browser-lock/
├── manifest.json       Manifest V3 — minimal permissions
├── background.js       Service worker — state machine, crypto, window management
├── lock.html           Lock screen UI
├── lock.css            Lock screen styles (dark glassmorphism)
├── lock.js             Lock screen logic (PIN input, verification)
├── setup.html          First-run PIN setup UI
├── setup.css           Setup screen styles
├── setup.js            Setup logic (create + confirm PIN)
├── options.html        Settings page UI
├── options.css         Settings styles
├── options.js          Settings logic
├── icons/
│   ├── icon16.png      Extension icon (16×16)
│   ├── icon32.png      Extension icon (32×32)
│   ├── icon48.png      Extension icon (48×48)
│   └── icon128.png     Extension icon (128×128)
└── README.md           This file
```

---

## Manual Test Checklist

### Installation
- [ ] Load unpacked in `chrome://extensions` → no errors
- [ ] Setup window appears automatically
- [ ] PIN creation requires 4+ digits
- [ ] PIN confirmation must match
- [ ] After setup, lock screen appears

### Startup
- [ ] Close Chrome completely
- [ ] Reopen Chrome → lock screen appears
- [ ] All previous windows are minimized
- [ ] Enter correct PIN → windows restored

### Authentication
- [ ] Correct PIN → unlocks successfully
- [ ] Incorrect PIN → "Incorrect PIN" error with shake animation
- [ ] Empty PIN → validation error
- [ ] 5 wrong PINs → 10-second lockout with countdown
- [ ] 10 wrong PINs → 30-second lockout
- [ ] 15 wrong PINs → 60-second lockout
- [ ] Correct PIN after lockout → unlocks, counter resets
- [ ] Restart Chrome while locked → still locked, counter preserved

### Window Handling
- [ ] Close lock window → new lock window appears
- [ ] Try to create new Chrome window while locked → blocked
- [ ] Try to restore minimized window from taskbar → re-minimized
- [ ] Open new tab while locked → tab removed
- [ ] Click extension icon while locked → lock window focused
- [ ] Multiple existing windows before lock → all minimized
- [ ] Unlock → all windows restored

### Extension Lifecycle
- [ ] Reload extension from `chrome://extensions` → state preserved
- [ ] Service worker stops and restarts → lock maintained
- [ ] Chrome restart with multiple windows → all protected

### Settings
- [ ] Toggle "Lock on startup" off → Chrome starts without locking
- [ ] Set inactivity timeout → idle permission requested if needed
- [ ] Change PIN → requires current PIN, new PIN works
- [ ] Lock Now → immediately locks
- [ ] Reset Extension → requires PIN, returns to setup

### Security Verification
- [ ] Open DevTools → Application → Local Storage → verify no plaintext PIN
- [ ] Open DevTools → Network tab → verify zero network requests
- [ ] View extension source → no external scripts or CDN references
- [ ] Check `chrome://extensions` → verify only "storage" and "alarms" permissions
- [ ] No `<all_urls>` or host permissions listed

---

## Technical Notes

### State Machine
```
UNINITIALIZED → (setup) → LOCKED → (correct PIN) → UNLOCKED → (lock) → LOCKED
                              ↑        ↑                                    |
                              |        └── Chrome restart / SW restart ─────┘
                              └── Chrome restart with lockOnStartup=true
```

### Why PBKDF2 and Not bcrypt/scrypt/Argon2?
PBKDF2-SHA256 is natively available in the Web Crypto API (`crypto.subtle.deriveBits`), which is accessible in Chrome extension service workers without any external library. bcrypt, scrypt, and Argon2 would require bundling a JavaScript implementation, adding code complexity and potentially introducing supply-chain risk for a security-critical operation.

### Why Minimize Instead of Close?
Closing windows destroys session state (form data, scroll positions, authentication tokens). Minimizing preserves everything while hiding content from view.

---

## License

This extension is provided as-is for personal use. No warranty expressed or implied.
