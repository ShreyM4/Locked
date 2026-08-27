// ============================================================
// Browser Lock — Service Worker (Manifest V3)
// Privacy-first browser profile lock screen.
// No external connections, no tracking, no analytics.
// ============================================================

'use strict';

importScripts('totp.js');

// --------------- Constants ---------------

const STATES = Object.freeze({
  UNINITIALIZED: 'UNINITIALIZED',
  LOCKED: 'LOCKED',
  UNLOCKED: 'UNLOCKED'
});

const PBKDF2_ITERATIONS = 600000; // OWASP 2023 recommendation for SHA-256
const SALT_BYTES = 16;
const HASH_BITS = 256;

const LOCKOUT_TIERS = [
  { minAttempts: 15, delaySec: 60 },
  { minAttempts: 10, delaySec: 30 },
  { minAttempts: 5,  delaySec: 10 }
];

const LOCK_WINDOW = { width: 400, height: 490 };
const SETUP_WINDOW = { width: 440, height: 570 };
const RECOVERY_WINDOW = { width: 400, height: 460 };

// --------------- In-memory flags (not security state) ---------------

let isCreatingLockWindow  = false;  // true while chrome.windows.create() is in-flight
let isLockingInProgress   = false;  // true while lockBrowser() is processing multiple windows
let lockEnforcementActive = false;  // true only when fully locked and ready to enforce
let recreatingLockWindow  = false;  // mutex: prevents onRemoved re-entrant recreation
let startupHandled        = false;  // ensures onStartup and IIFE don't both run lockBrowser

// ============================================================
//  Crypto helpers — Web Crypto API / PBKDF2-SHA256
// ============================================================

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function deriveHash(pin, saltBuf, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuf, iterations, hash: 'SHA-256' },
    keyMaterial,
    HASH_BITS
  );
}

async function createPinData(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveHash(pin, salt, PBKDF2_ITERATIONS);
  return {
    salt: toBase64(salt),
    hash: toBase64(hash),
    iterations: PBKDF2_ITERATIONS
  };
}

async function verifyPin(pin, pinData) {
  const saltBuf = new Uint8Array(fromBase64(pinData.salt));
  const hash = await deriveHash(pin, saltBuf, pinData.iterations);
  // Constant-time-ish comparison (both are base64 strings of fixed length)
  const a = toBase64(hash);
  const b = pinData.hash;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================================
//  Storage helpers
// ============================================================

const DEFAULT_SETTINGS = Object.freeze({
  lockOnStartup: true,
  inactivityTimeout: 0  // 0 = never
});

async function getStore() {
  const raw = await chrome.storage.local.get([
    'lockState', 'pinData', 'totpSecret', 'profileName', 'settings',
    'failedAttempts', 'lockoutUntil',
    'lockWindowId', 'protectedWindowIds',
    'coverTabIds', 'windowPrevStates'
  ]);
  return {
    lockState:          raw.lockState          || STATES.UNINITIALIZED,
    pinData:            raw.pinData            || null,
    totpSecret:         raw.totpSecret         || null,
    profileName:        raw.profileName        || 'Chrome Profile',
    settings:           raw.settings           || { ...DEFAULT_SETTINGS },
    failedAttempts:     raw.failedAttempts     || 0,
    lockoutUntil:       raw.lockoutUntil       || 0,
    lockWindowId:       raw.lockWindowId       ?? null,
    protectedWindowIds: raw.protectedWindowIds || [],
    coverTabIds:        raw.coverTabIds        || [],
    windowPrevStates:   raw.windowPrevStates   || {}
  };
}

async function setStore(updates) {
  await chrome.storage.local.set(updates);
}

// ============================================================
//  Window helpers
// ============================================================

/** Estimate a centred position using an existing window as a reference. */
function estimateCentre(refWindows, popupW, popupH) {
  let left = 200, top = 100;
  const ref = refWindows.find(w => w.state === 'maximized' || w.state === 'normal');
  if (ref) {
    if (ref.state === 'maximized') {
      left = Math.round((ref.width - popupW) / 2) + (ref.left || 0);
      top  = Math.round((ref.height - popupH) / 2) + (ref.top || 0);
    } else if (ref.width > 0 && ref.height > 0) {
      left = Math.round(ref.left + (ref.width - popupW) / 2);
      top  = Math.round(ref.top + (ref.height - popupH) / 2);
    }
  }
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

async function openPopupWindow(url, w, h) {
  let pos = { left: 200, top: 100 };
  try {
    const wins = await chrome.windows.getAll();
    pos = estimateCentre(wins, w, h);
  } catch (_) { /* use defaults */ }

  return chrome.windows.create({
    url,
    type: 'popup',
    width: w,
    height: h,
    left: pos.left,
    top: pos.top,
    focused: true
  });
}

async function createLockWindow() {
  // Guard: if another create is already in-flight, do nothing
  if (isCreatingLockWindow) return null;
  isCreatingLockWindow = true;
  try {
    const win = await openPopupWindow(
      chrome.runtime.getURL('lock.html'),
      LOCK_WINDOW.width,
      LOCK_WINDOW.height
    );
    // Persist BEFORE releasing the flag so tabs.onCreated sees the correct ID
    await setStore({ lockWindowId: win.id });
    return win;
  } finally {
    isCreatingLockWindow = false;
  }
}

async function createSetupWindow() {
  isCreatingLockWindow = true;
  try {
    const win = await openPopupWindow(
      chrome.runtime.getURL('setup.html'),
      SETUP_WINDOW.width,
      SETUP_WINDOW.height
    );
    await setStore({ lockWindowId: win.id });
    return win;
  } finally {
    isCreatingLockWindow = false;
  }
}

async function createRecoveryWindow() {
  isCreatingLockWindow = true;
  try {
    const win = await openPopupWindow(
      chrome.runtime.getURL('recovery.html'),
      RECOVERY_WINDOW.width,
      RECOVERY_WINDOW.height
    );
    await setStore({ lockWindowId: win.id });
    return win;
  } finally {
    isCreatingLockWindow = false;
  }
}

// ============================================================
//  Lock / Unlock
// ============================================================

async function lockBrowser() {
  // Prevent concurrent locking or event listener interference across multiple windows
  isLockingInProgress = true;
  lockEnforcementActive = false;

  const allWindows = await chrome.windows.getAll();
  const store = await getStore();
  const currentLockId = store.lockWindowId;

  // Identify normal browser windows to protect (exclude popup lock windows)
  const windowsToLock = allWindows.filter(w => w.id !== currentLockId && w.type === 'normal');
  const protectedIds = windowsToLock.map(w => w.id);

  const coverTabIds = [];
  const windowPrevStates = {};

  // Phase 1: Open the black cover tab on EVERY open window first and record states
  for (const win of windowsToLock) {
    windowPrevStates[win.id] = (win.state === 'fullscreen' || win.state === 'minimized') ? 'normal' : win.state;
    try {
      const coverTab = await chrome.tabs.create({
        windowId: win.id,
        url: chrome.runtime.getURL('cover.html'),
        active: true
      });
      coverTabIds.push(coverTab.id);
    } catch (_) {}
  }

  // Persist cover tabs and states immediately so tabs.onCreated never touches them
  await setStore({
    lockState: STATES.LOCKED,
    protectedWindowIds: protectedIds,
    coverTabIds: coverTabIds,
    windowPrevStates: windowPrevStates
  });

  // Phase 2: For each window, enter fullscreen (to hide tab strip/UI), verify, and minimize
  for (const win of windowsToLock) {
    try {
      await chrome.windows.update(win.id, { state: 'fullscreen', focused: true });

      // Wait until window reports fullscreen state
      let waited = 0;
      while (waited < 250) {
        try {
          const check = await chrome.windows.get(win.id);
          if (check.state === 'fullscreen') break;
        } catch (_) { break; }
        await new Promise(r => setTimeout(r, 25));
        waited += 25;
      }

      // Allow DWM compositor sufficient time to capture the black fullscreen surface
      await new Promise(r => setTimeout(r, 100));

      // Minimize the window (Windows DWM Peek thumbnail now reliably retains the black frame)
      await chrome.windows.update(win.id, { state: 'minimized' });
    } catch (_) {
      try { await chrome.windows.update(win.id, { state: 'minimized' }); } catch (_) {}
    }
  }

  // Phase 3: Create or focus the lock popup window
  let lockExists = false;
  if (currentLockId != null) {
    try {
      await chrome.windows.get(currentLockId);
      await chrome.windows.update(currentLockId, { focused: true });
      lockExists = true;
    } catch (_) { /* window gone */ }
  }
  if (!lockExists) {
    await createLockWindow();
  }

  isLockingInProgress = false;
  lockEnforcementActive = true;
}

async function unlockBrowser() {
  const store = await getStore();

  // Mark unlocked FIRST so enforcement listeners don't interfere
  await setStore({
    lockState: STATES.UNLOCKED,
    failedAttempts: 0,
    lockoutUntil: 0
  });

  lockEnforcementActive = false;

  // 1. Close all temporary black cover tabs
  const coverTabIds = store.coverTabIds || [];
  for (const tabId of coverTabIds) {
    try { await chrome.tabs.remove(tabId); }
    catch (_) { /* already gone */ }
  }

  // Also query in case any cover.html tab was left over
  try {
    const leftoverTabs = await chrome.tabs.query({ url: chrome.runtime.getURL('cover.html') });
    for (const t of leftoverTabs) {
      try { await chrome.tabs.remove(t.id); } catch (_) {}
    }
  } catch (_) {}

  // 2. Restore protected windows to their exact pre-lock state (e.g. 'maximized' or 'normal')
  const prevStates = store.windowPrevStates || {};
  let firstRestoredId = null;

  for (const id of store.protectedWindowIds) {
    const targetState = prevStates[id] || 'normal';
    try {
      await chrome.windows.update(id, { state: targetState });
      if (firstRestoredId === null) firstRestoredId = id;
    } catch (_) { /* gone */ }
  }

  // 3. Focus the first restored window
  if (firstRestoredId !== null) {
    try { await chrome.windows.update(firstRestoredId, { focused: true }); }
    catch (_) { /* ok */ }
  }

  // 4. Close lock window
  const lockId = store.lockWindowId;
  await setStore({
    lockWindowId: null,
    protectedWindowIds: [],
    coverTabIds: [],
    windowPrevStates: {}
  });

  if (lockId != null) {
    try { await chrome.windows.remove(lockId); }
    catch (_) { /* already gone */ }
  }

  // 5. Set up inactivity timer if configured
  await setupInactivityAlarm();
}

// ============================================================
//  Enforcement — keep the lock airtight while LOCKED
// ============================================================

async function enforceLock(focusedWindowId) {
  if (!lockEnforcementActive) return;
  if (isCreatingLockWindow || isLockingInProgress) return;  // don't interfere while locking/creating windows
  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;

  if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) return;
  if (focusedWindowId === store.lockWindowId) return;

  // A non-lock window got focus → minimise it, refocus lock
  try { await chrome.windows.update(focusedWindowId, { state: 'minimized' }); }
  catch (_) { /* ok */ }

  if (store.lockWindowId != null) {
    try { await chrome.windows.update(store.lockWindowId, { focused: true }); }
    catch (_) {
      if (!isCreatingLockWindow) await createLockWindow();
    }
  } else {
    if (!isCreatingLockWindow) await createLockWindow();
  }
}

// ============================================================
//  Inactivity (optional — requires 'idle' permission)
// ============================================================

async function setupInactivityAlarm() {
  await chrome.alarms.clear('inactivityLock');

  const store = await getStore();
  const mins = store.settings.inactivityTimeout;
  if (mins <= 0 || store.lockState !== STATES.UNLOCKED) return;

  try {
    const hasIdle = await chrome.permissions.contains({ permissions: ['idle'] });
    if (hasIdle) {
      chrome.idle.setDetectionInterval(mins * 60);
    }
  } catch (_) { /* idle not available */ }
}

// ============================================================
//  Brute-force protection
// ============================================================

function getLockoutDelay(attempts) {
  for (const tier of LOCKOUT_TIERS) {
    if (attempts >= tier.minAttempts) return tier.delaySec;
  }
  return 0;
}

// ============================================================
//  Event Listeners (registered synchronously at top level)
// ============================================================

// --- Browser profile startup ---
// NOTE: onStartup and the IIFE self-check below can both fire on browser start.
// startupHandled ensures only ONE of them runs the lock logic.
chrome.runtime.onStartup.addListener(async () => {
  if (startupHandled) return;
  startupHandled = true;

  const store = await getStore();

  if (store.lockState === STATES.UNINITIALIZED || !store.pinData) {
    await createSetupWindow();
    return;
  }

  if (store.settings.lockOnStartup) {
    // Reset lockWindowId so lockBrowser() creates a fresh window
    await setStore({ lockWindowId: null });
    await lockBrowser();
  } else {
    await setupInactivityAlarm();
  }
});

// --- Extension installed / updated ---
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await setStore({
      lockState: STATES.UNINITIALIZED,
      settings: { ...DEFAULT_SETTINGS },
      failedAttempts: 0,
      lockoutUntil: 0
    });
    await createSetupWindow();
  } else if (details.reason === 'update') {
    const store = await getStore();
    if (store.lockState === STATES.LOCKED) {
      await lockBrowser();
    }
  }
});

// --- Window focus changed ---
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (isLockingInProgress) return;
  enforceLock(windowId);
});

// --- New window created ---
chrome.windows.onCreated.addListener(async (win) => {
  // Always ignore windows WE are creating or during lock transition
  if (isCreatingLockWindow || isLockingInProgress) return;
  if (!lockEnforcementActive) return;

  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;
  if (win.id === store.lockWindowId) return;

  // Close the intruding window (it has no session data to lose)
  try { await chrome.windows.remove(win.id); }
  catch (_) { /* ok */ }

  // Refocus lock
  if (store.lockWindowId != null) {
    try { await chrome.windows.update(store.lockWindowId, { focused: true }); }
    catch (_) { /* ok */ }
  }
});

// --- Lock window removed ---
chrome.windows.onRemoved.addListener(async (windowId) => {
  if (isCreatingLockWindow || isLockingInProgress) return;

  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;
  if (windowId !== store.lockWindowId) return;

  // Just clear the stored window ID — do NOT recreate automatically
  await setStore({ lockWindowId: null });
});

// --- New tab created ---
chrome.tabs.onCreated.addListener(async (tab) => {
  // Never remove tabs that belong to a window we are currently creating or during locking
  if (isCreatingLockWindow || isLockingInProgress) return;
  if (!lockEnforcementActive) return;

  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;

  // Allow tabs in the lock window itself
  if (tab.windowId === store.lockWindowId) return;

  // Allow temporary cover tabs
  if (store.coverTabIds && store.coverTabIds.includes(tab.id)) return;

  // Remove tabs opened outside the lock window
  try { await chrome.tabs.remove(tab.id); }
  catch (_) { /* ok */ }
});

// --- Extension action icon clicked → LOCK immediately ---
chrome.action.onClicked.addListener(async () => {
  const store = await getStore();

  if (store.lockState === STATES.LOCKED) {
    // Already locked — focus the lock window
    if (store.lockWindowId != null) {
      try { await chrome.windows.update(store.lockWindowId, { focused: true }); return; }
      catch (_) { /* fall through to create */ }
    }
    await createLockWindow();
  } else if (store.lockState === STATES.UNLOCKED) {
    // Unlocked — lock the browser now
    await lockBrowser();
  } else {
    // Uninitialized — open setup
    await createSetupWindow();
  }
});

// --- Alarms ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'inactivityLock') {
    const store = await getStore();
    if (store.lockState === STATES.UNLOCKED) await lockBrowser();
  }
  // 'lockoutTimer' alarms are advisory — the time-check in VERIFY_PIN handles expiry
});

// --- Keyboard shortcut command (default: Ctrl+Shift+Z) ---
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'lock-browser') {
    const store = await getStore();
    if (store.lockState === STATES.UNLOCKED) {
      await lockBrowser();
    } else if (store.lockState === STATES.LOCKED && store.lockWindowId != null) {
      try { await chrome.windows.update(store.lockWindowId, { focused: true }); }
      catch (_) { /* ok */ }
    }
  }
});

// --- Idle state (optional permission) ---
try {
  if (chrome.idle && chrome.idle.onStateChanged) {
    chrome.idle.onStateChanged.addListener(async (newState) => {
      if (newState !== 'idle' && newState !== 'locked') return;
      const store = await getStore();
      if (store.lockState !== STATES.UNLOCKED) return;
      if (store.settings.inactivityTimeout <= 0) return;
      await lockBrowser();
    });
  }
} catch (_) { /* idle permission not granted — safe to ignore */ }

// ============================================================
//  Message handling  (lock.js / setup.js / options.js ↔ background)
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    sendResponse({ success: false, error: String(err) });
  });
  return true; // async
});

async function handleMessage(msg, sender) {
  switch (msg.type) {

    // ---- Setup: create initial PIN ----
    case 'CREATE_PIN': {
      const pinData = await createPinData(msg.pin);
      const updates = {
        pinData,
        lockState: STATES.LOCKED,
        settings: { ...DEFAULT_SETTINGS }
      };
      if (msg.totpSecret) {
        updates.totpSecret = msg.totpSecret;
      }
      if (msg.profileName) {
        updates.profileName = msg.profileName;
      }
      await setStore(updates);

      // Close setup window → lock browser
      const setupWinId = sender.tab ? sender.tab.windowId : null;
      if (setupWinId != null) {
        try { await chrome.windows.remove(setupWinId); }
        catch (_) { /* ok */ }
      }

      await lockBrowser();
      return { success: true };
    }

    // ---- Lock screen: verify PIN ----
    case 'VERIFY_PIN': {
      const store = await getStore();

      // Check lockout
      if (store.lockoutUntil > Date.now()) {
        const remaining = Math.ceil((store.lockoutUntil - Date.now()) / 1000);
        return { success: false, locked: true, remainingSeconds: remaining };
      }

      if (!store.pinData) {
        return { success: false, error: 'No PIN configured.' };
      }

      const valid = await verifyPin(msg.pin, store.pinData);
      if (valid) {
        await unlockBrowser();
        return { success: true };
      }

      // Wrong PIN
      const attempts = store.failedAttempts + 1;
      const delay = getLockoutDelay(attempts);
      const until = delay > 0 ? Date.now() + delay * 1000 : 0;
      await setStore({ failedAttempts: attempts, lockoutUntil: until });

      if (delay > 0) {
        chrome.alarms.create('lockoutTimer', { delayInMinutes: Math.max(delay / 60, 0.1) });
      }

      return {
        success: false,
        attempts,
        locked: delay > 0,
        remainingSeconds: delay
      };
    }

    // ---- Get current state (for UI pages) ----
    case 'GET_STATE': {
      const store = await getStore();
      let lockoutRemaining = 0;
      if (store.lockoutUntil > Date.now()) {
        lockoutRemaining = Math.ceil((store.lockoutUntil - Date.now()) / 1000);
      }
      return {
        lockState: store.lockState,
        hasPin: !!store.pinData,
        settings: store.settings,
        failedAttempts: store.failedAttempts,
        lockoutRemaining
      };
    }

    // ---- Options: update settings ----
    case 'UPDATE_SETTINGS': {
      const store = await getStore();
      const merged = { ...store.settings, ...msg.settings };
      await setStore({ settings: merged });

      if (merged.inactivityTimeout > 0) {
        const hasIdle = await chrome.permissions.contains({ permissions: ['idle'] });
        if (!hasIdle) return { success: true, needsIdlePermission: true };
      }

      await setupInactivityAlarm();
      return { success: true };
    }

    // ---- Options: change PIN ----
    case 'CHANGE_PIN': {
      const store = await getStore();
      if (!store.pinData) return { success: false, error: 'No PIN set.' };

      const ok = await verifyPin(msg.currentPin, store.pinData);
      if (!ok) return { success: false, error: 'Current PIN is incorrect.' };

      const newData = await createPinData(msg.newPin);
      await setStore({ pinData: newData });
      return { success: true };
    }

    // ---- Options: reset extension ----
    case 'RESET_EXTENSION': {
      const store = await getStore();
      if (!store.pinData) return { success: false, error: 'No PIN set.' };

      const ok = await verifyPin(msg.pin, store.pinData);
      if (!ok) return { success: false, error: 'Incorrect PIN.' };

      await chrome.storage.local.clear();
      await setStore({
        lockState: STATES.UNINITIALIZED,
        settings: { ...DEFAULT_SETTINGS },
        failedAttempts: 0,
        lockoutUntil: 0
      });
      lockEnforcementActive = false;
      return { success: true };
    }

    // ---- Switch to Recovery Window from Lock Screen ----
    case 'OPEN_RECOVERY_WINDOW': {
      const store = await getStore();
      if (store.lockWindowId != null) {
        try { await chrome.windows.remove(store.lockWindowId); }
        catch (_) { /* ok */ }
      }
      await setStore({ lockWindowId: null });
      await createRecoveryWindow();
      return { success: true };
    }

    // ---- Switch to Lock Window from Recovery Screen ----
    case 'OPEN_LOCK_WINDOW': {
      const store = await getStore();
      if (store.lockWindowId != null) {
        try { await chrome.windows.remove(store.lockWindowId); }
        catch (_) { /* ok */ }
      }
      await setStore({ lockWindowId: null });
      await createLockWindow();
      return { success: true };
    }

    // ---- Verify Offline TOTP Code ----
    case 'VERIFY_TOTP': {
      const store = await getStore();
      if (!store.totpSecret) {
        return { success: false, error: 'Authenticator App is not configured for this profile.' };
      }

      const valid = await self.TOTPEngine.verifyTOTP(msg.token, store.totpSecret);
      if (valid) {
        return { success: true };
      }
      return { success: false, error: 'Invalid or expired code. Please try again.' };
    }

    // ---- Verify Saved Recovery Key (File or Manual Text) ----
    case 'VERIFY_RECOVERY_KEY': {
      const store = await getStore();
      if (!store.totpSecret) {
        return { success: false, error: 'No recovery key is configured for this profile.' };
      }

      if (!msg.key || typeof msg.key !== 'string') {
        return { success: false, error: 'Invalid key format.' };
      }

      const inputKey = msg.key.trim().replace(/\s+/g, '').toUpperCase();
      const storedKey = store.totpSecret.trim().replace(/\s+/g, '').toUpperCase();

      if (inputKey === storedKey) {
        return { success: true };
      }
      return { success: false, error: 'The provided recovery key does not match this profile.' };
    }

    // ---- Reset PIN after successful Recovery Verification ----
    case 'RESET_PIN_WITH_RECOVERY': {
      if (!msg.newPin || msg.newPin.length < 4) {
        return { success: false, error: 'PIN must be at least 4 digits.' };
      }

      const newPinData = await createPinData(msg.newPin);
      await setStore({
        pinData: newPinData,
        failedAttempts: 0,
        lockoutUntil: 0
      });

      // Restore windows and complete recovery
      await unlockBrowser();
      return { success: true };
    }

    // ---- Options: Get/Set TOTP Secret with PIN confirmation ----
    case 'GET_TOTP_SECRET_WITH_PIN': {
      const store = await getStore();
      if (!store.pinData) return { success: false, error: 'No PIN set.' };

      const ok = await verifyPin(msg.pin, store.pinData);
      if (!ok) return { success: false, error: 'Current PIN is incorrect.' };

      let secret = store.totpSecret;
      if (!secret && self.TOTPEngine) {
        secret = self.TOTPEngine.generateSecret(20);
        await setStore({ totpSecret: secret });
      }

      return {
        success: true,
        totpSecret: secret,
        profileName: store.profileName || 'Chrome Profile'
      };
    }

    case 'SET_PROFILE_NAME': {
      if (msg.profileName) {
        await setStore({ profileName: msg.profileName.trim() });
      }
      return { success: true };
    }

    // ---- Options / action: lock now ----
    case 'LOCK_NOW': {
      await lockBrowser();
      return { success: true };
    }

    default:
      return { error: 'Unknown message type.' };
  }
}

// ============================================================
//  Self-check on service-worker wake-up
//  (handles SW restart while browser is locked)
//
//  IMPORTANT: On a real browser startup, chrome.runtime.onStartup also fires.
//  The startupHandled flag ensures only ONE path runs lock logic.
//  This IIFE only acts when the SW restarts mid-session (not on cold start).
// ============================================================
(async () => {
  try {
    // Give onStartup a tick to claim startupHandled first if this is a cold start
    await new Promise(resolve => setTimeout(resolve, 0));

    const store = await getStore();

    if (store.lockState === STATES.LOCKED) {
      lockEnforcementActive = true;

      // If onStartup already handled the lock window creation, skip
      if (!startupHandled) {
        startupHandled = true;

        // Check if a lock window already exists and is alive
        let lockWindowAlive = false;
        if (store.lockWindowId != null) {
          try {
            await chrome.windows.get(store.lockWindowId);
            lockWindowAlive = true;
          } catch (_) { /* window is gone */ }
        }

        if (!lockWindowAlive) {
          await setStore({ lockWindowId: null });
          await createLockWindow();
        }
      }

      // Re-minimise any protected windows that may have been un-minimised
      for (const id of store.protectedWindowIds) {
        try { await chrome.windows.update(id, { state: 'minimized' }); }
        catch (_) { /* ok */ }
      }

    } else if (store.lockState === STATES.UNLOCKED) {
      await setupInactivityAlarm();
    }
  } catch (_) { /* first run — storage empty, nothing to do */ }
})();
