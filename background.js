// ============================================================
// Browser Lock — Service Worker (Manifest V3)
// Privacy-first browser profile lock screen.
// No external connections, no tracking, no analytics.
// ============================================================

'use strict';

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

const LOCK_WINDOW = { width: 420, height: 520 };
const SETUP_WINDOW = { width: 480, height: 600 };

// --------------- In-memory flags (not security state) ---------------

let isCreatingLockWindow = false;
let lockEnforcementActive = false;

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
    'lockState', 'pinData', 'settings',
    'failedAttempts', 'lockoutUntil',
    'lockWindowId', 'protectedWindowIds'
  ]);
  return {
    lockState:          raw.lockState          || STATES.UNINITIALIZED,
    pinData:            raw.pinData            || null,
    settings:           raw.settings           || { ...DEFAULT_SETTINGS },
    failedAttempts:     raw.failedAttempts     || 0,
    lockoutUntil:       raw.lockoutUntil       || 0,
    lockWindowId:       raw.lockWindowId       ?? null,
    protectedWindowIds: raw.protectedWindowIds || []
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
  isCreatingLockWindow = true;
  try {
    const win = await openPopupWindow(
      chrome.runtime.getURL('lock.html'),
      LOCK_WINDOW.width,
      LOCK_WINDOW.height
    );
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

// ============================================================
//  Lock / Unlock
// ============================================================

async function lockBrowser() {
  const allWindows = await chrome.windows.getAll();
  const store = await getStore();
  const currentLockId = store.lockWindowId;

  // Identify windows to protect (everything that isn't the lock window)
  const protectedIds = allWindows
    .filter(w => w.id !== currentLockId)
    .map(w => w.id);

  await setStore({
    lockState: STATES.LOCKED,
    protectedWindowIds: protectedIds
  });

  // Minimise every protected window
  for (const id of protectedIds) {
    try { await chrome.windows.update(id, { state: 'minimized' }); }
    catch (_) { /* window may already be gone */ }
  }

  // Create or focus the lock window
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

  // Restore protected windows
  let firstRestoredId = null;
  for (const id of store.protectedWindowIds) {
    try {
      await chrome.windows.update(id, { state: 'normal' });
      if (firstRestoredId === null) firstRestoredId = id;
    } catch (_) { /* gone */ }
  }

  // Focus the first restored window
  if (firstRestoredId !== null) {
    try { await chrome.windows.update(firstRestoredId, { focused: true }); }
    catch (_) { /* ok */ }
  }

  // Close lock window
  const lockId = store.lockWindowId;
  await setStore({ lockWindowId: null, protectedWindowIds: [] });
  if (lockId != null) {
    try { await chrome.windows.remove(lockId); }
    catch (_) { /* already gone */ }
  }

  // Set up inactivity timer if configured
  await setupInactivityAlarm();
}

// ============================================================
//  Enforcement — keep the lock airtight while LOCKED
// ============================================================

async function enforceLock(focusedWindowId) {
  if (!lockEnforcementActive) return;
  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;

  if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) return;
  if (focusedWindowId === store.lockWindowId) return;

  // A non-lock window got focus → minimise it, refocus lock
  try { await chrome.windows.update(focusedWindowId, { state: 'minimized' }); }
  catch (_) { /* ok */ }

  if (store.lockWindowId != null) {
    try { await chrome.windows.update(store.lockWindowId, { focused: true }); }
    catch (_) { await createLockWindow(); }
  } else {
    await createLockWindow();
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
chrome.runtime.onStartup.addListener(async () => {
  const store = await getStore();

  if (store.lockState === STATES.UNINITIALIZED || !store.pinData) {
    await createSetupWindow();
    return;
  }

  if (store.settings.lockOnStartup) {
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
  enforceLock(windowId);
});

// --- New window created ---
chrome.windows.onCreated.addListener(async (win) => {
  if (isCreatingLockWindow) return;
  if (!lockEnforcementActive) return;

  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;
  if (win.id === store.lockWindowId) return;

  // Close the intruding window
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
  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;
  if (windowId !== store.lockWindowId) return;

  // Lock window was closed — recreate after a tiny debounce
  await setStore({ lockWindowId: null });
  setTimeout(async () => {
    const current = await getStore();
    if (current.lockState === STATES.LOCKED && current.lockWindowId == null) {
      await createLockWindow();
    }
  }, 150);
});

// --- New tab created ---
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!lockEnforcementActive) return;
  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;
  if (tab.windowId === store.lockWindowId) return;

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
      await setStore({
        pinData,
        lockState: STATES.LOCKED,
        settings: { ...DEFAULT_SETTINGS }
      });

      // Close setup window → lock browser
      const setupWinId = sender.tab ? sender.tab.windowId : null;
      await setStore({ lockWindowId: null });

      const allWindows = await chrome.windows.getAll();
      const protectedIds = allWindows
        .filter(w => w.id !== setupWinId)
        .map(w => w.id);

      await setStore({ protectedWindowIds: protectedIds });

      for (const id of protectedIds) {
        try { await chrome.windows.update(id, { state: 'minimized' }); }
        catch (_) { /* ok */ }
      }

      if (setupWinId != null) {
        try { await chrome.windows.remove(setupWinId); }
        catch (_) { /* ok */ }
      }

      await createLockWindow();
      lockEnforcementActive = true;
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
//  (handles restart while browser is locked)
// ============================================================
(async () => {
  try {
    const store = await getStore();
    if (store.lockState === STATES.LOCKED) {
      lockEnforcementActive = true;

      // Ensure a lock window exists
      if (store.lockWindowId != null) {
        try { await chrome.windows.get(store.lockWindowId); }
        catch (_) { await createLockWindow(); }
      } else {
        await createLockWindow();
      }

      // Re-minimise any protected windows that may have been un-minimised
      for (const id of store.protectedWindowIds) {
        try { await chrome.windows.update(id, { state: 'minimized' }); }
        catch (_) { /* ok */ }
      }
    } else if (store.lockState === STATES.UNLOCKED) {
      await setupInactivityAlarm();
    }
  } catch (_) { /* first run — state doesn't exist yet */ }
})();
