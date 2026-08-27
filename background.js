'use strict';

importScripts('totp.js');

const STATES = Object.freeze({
  UNINITIALIZED: 'UNINITIALIZED',
  LOCKED: 'LOCKED',
  UNLOCKED: 'UNLOCKED'
});

const PBKDF2_ITERATIONS = 600000; 
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

let isCreatingLockWindow  = false;  
let isLockingInProgress   = false;  
let lockEnforcementActive = false;  
let recreatingLockWindow  = false;  
let startupHandled        = false;  

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
  
  const a = toBase64(hash);
  const b = pinData.hash;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const DEFAULT_SETTINGS = Object.freeze({
  lockOnStartup: true,
  inactivityTimeout: 0  
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
  } catch (_) {  }

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
  
  if (isCreatingLockWindow) return null;
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

async function lockBrowser() {
  
  isLockingInProgress = true;
  lockEnforcementActive = false;

  const allWindows = await chrome.windows.getAll();
  const store = await getStore();
  const currentLockId = store.lockWindowId;

  
  const windowsToLock = allWindows.filter(w => w.id !== currentLockId && w.type === 'normal');
  const protectedIds = windowsToLock.map(w => w.id);

  const coverTabIds = [];
  const windowPrevStates = {};

  
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

  
  await setStore({
    lockState: STATES.LOCKED,
    protectedWindowIds: protectedIds,
    coverTabIds: coverTabIds,
    windowPrevStates: windowPrevStates
  });

  
  for (const win of windowsToLock) {
    try {
      await chrome.windows.update(win.id, { state: 'fullscreen', focused: true });

      
      let waited = 0;
      while (waited < 250) {
        try {
          const check = await chrome.windows.get(win.id);
          if (check.state === 'fullscreen') break;
        } catch (_) { break; }
        await new Promise(r => setTimeout(r, 25));
        waited += 25;
      }

      
      await new Promise(r => setTimeout(r, 100));

      
      await chrome.windows.update(win.id, { state: 'minimized' });
    } catch (_) {
      try { await chrome.windows.update(win.id, { state: 'minimized' }); } catch (_) {}
    }
  }

  
  let lockExists = false;
  if (currentLockId != null) {
    try {
      await chrome.windows.get(currentLockId);
      await chrome.windows.update(currentLockId, { focused: true });
      lockExists = true;
    } catch (_) {  }
  }
  if (!lockExists) {
    await createLockWindow();
  }

  isLockingInProgress = false;
  lockEnforcementActive = true;
}

async function unlockBrowser() {
  const store = await getStore();

  
  await setStore({
    lockState: STATES.UNLOCKED,
    failedAttempts: 0,
    lockoutUntil: 0
  });

  lockEnforcementActive = false;

  
  const coverTabIds = store.coverTabIds || [];
  for (const tabId of coverTabIds) {
    try { await chrome.tabs.remove(tabId); }
    catch (_) {  }
  }

  
  try {
    const leftoverTabs = await chrome.tabs.query({ url: chrome.runtime.getURL('cover.html') });
    for (const t of leftoverTabs) {
      try { await chrome.tabs.remove(t.id); } catch (_) {}
    }
  } catch (_) {}

  
  const prevStates = store.windowPrevStates || {};
  let firstRestoredId = null;

  for (const id of store.protectedWindowIds) {
    const targetState = prevStates[id] || 'normal';
    try {
      await chrome.windows.update(id, { state: targetState });
      if (firstRestoredId === null) firstRestoredId = id;
    } catch (_) {  }
  }

  
  if (firstRestoredId !== null) {
    try { await chrome.windows.update(firstRestoredId, { focused: true }); }
    catch (_) {  }
  }

  
  const lockId = store.lockWindowId;
  await setStore({
    lockWindowId: null,
    protectedWindowIds: [],
    coverTabIds: [],
    windowPrevStates: {}
  });

  if (lockId != null) {
    try { await chrome.windows.remove(lockId); }
    catch (_) {  }
  }

  
  await setupInactivityAlarm();
}

async function enforceLock(focusedWindowId) {
  if (!lockEnforcementActive) return;
  if (isCreatingLockWindow || isLockingInProgress) return;  
  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;

  if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) return;
  if (focusedWindowId === store.lockWindowId) return;

  
  try { await chrome.windows.update(focusedWindowId, { state: 'minimized' }); }
  catch (_) {  }

  if (store.lockWindowId != null) {
    try { await chrome.windows.update(store.lockWindowId, { focused: true }); }
    catch (_) {
      if (!isCreatingLockWindow) await createLockWindow();
    }
  } else {
    if (!isCreatingLockWindow) await createLockWindow();
  }
}

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
  } catch (_) {  }
}

function getLockoutDelay(attempts) {
  for (const tier of LOCKOUT_TIERS) {
    if (attempts >= tier.minAttempts) return tier.delaySec;
  }
  return 0;
}

chrome.runtime.onStartup.addListener(async () => {
  if (startupHandled) return;
  startupHandled = true;

  const store = await getStore();

  if (store.lockState === STATES.UNINITIALIZED || !store.pinData) {
    await createSetupWindow();
    return;
  }

  if (store.settings.lockOnStartup) {
    
    await setStore({ lockWindowId: null });
    await lockBrowser();
  } else {
    await setupInactivityAlarm();
  }
});

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

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (isLockingInProgress) return;
  enforceLock(windowId);
});

chrome.windows.onCreated.addListener(async (win) => {
  
  if (isCreatingLockWindow || isLockingInProgress) return;
  if (!lockEnforcementActive) return;

  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;
  if (win.id === store.lockWindowId) return;

  
  try { await chrome.windows.remove(win.id); }
  catch (_) {  }

  
  if (store.lockWindowId != null) {
    try { await chrome.windows.update(store.lockWindowId, { focused: true }); }
    catch (_) {  }
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  if (isCreatingLockWindow || isLockingInProgress) return;

  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;
  if (windowId !== store.lockWindowId) return;

  
  await setStore({ lockWindowId: null });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  
  if (isCreatingLockWindow || isLockingInProgress) return;
  if (!lockEnforcementActive) return;

  const store = await getStore();
  if (store.lockState !== STATES.LOCKED) return;

  
  if (tab.windowId === store.lockWindowId) return;

  
  if (store.coverTabIds && store.coverTabIds.includes(tab.id)) return;

  
  try { await chrome.tabs.remove(tab.id); }
  catch (_) {  }
});

chrome.action.onClicked.addListener(async () => {
  const store = await getStore();

  if (store.lockState === STATES.LOCKED) {
    
    if (store.lockWindowId != null) {
      try { await chrome.windows.update(store.lockWindowId, { focused: true }); return; }
      catch (_) {  }
    }
    await createLockWindow();
  } else if (store.lockState === STATES.UNLOCKED) {
    
    await lockBrowser();
  } else {
    
    await createSetupWindow();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'inactivityLock') {
    const store = await getStore();
    if (store.lockState === STATES.UNLOCKED) await lockBrowser();
  }
  
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'lock-browser') {
    const store = await getStore();
    if (store.lockState === STATES.UNLOCKED) {
      await lockBrowser();
    } else if (store.lockState === STATES.LOCKED && store.lockWindowId != null) {
      try { await chrome.windows.update(store.lockWindowId, { focused: true }); }
      catch (_) {  }
    }
  }
});

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
} catch (_) {  }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    sendResponse({ success: false, error: String(err) });
  });
  return true; 
});

async function handleMessage(msg, sender) {
  switch (msg.type) {

    
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

      
      const setupWinId = sender.tab ? sender.tab.windowId : null;
      if (setupWinId != null) {
        try { await chrome.windows.remove(setupWinId); }
        catch (_) {  }
      }

      await lockBrowser();
      return { success: true };
    }

    
    case 'VERIFY_PIN': {
      const store = await getStore();

      
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

    
    case 'CHANGE_PIN': {
      const store = await getStore();
      if (!store.pinData) return { success: false, error: 'No PIN set.' };

      const ok = await verifyPin(msg.currentPin, store.pinData);
      if (!ok) return { success: false, error: 'Current PIN is incorrect.' };

      const newData = await createPinData(msg.newPin);
      await setStore({ pinData: newData });
      return { success: true };
    }

    
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

    
    case 'OPEN_RECOVERY_WINDOW': {
      const store = await getStore();
      if (store.lockWindowId != null) {
        try { await chrome.windows.remove(store.lockWindowId); }
        catch (_) {  }
      }
      await setStore({ lockWindowId: null });
      await createRecoveryWindow();
      return { success: true };
    }

    
    case 'OPEN_LOCK_WINDOW': {
      const store = await getStore();
      if (store.lockWindowId != null) {
        try { await chrome.windows.remove(store.lockWindowId); }
        catch (_) {  }
      }
      await setStore({ lockWindowId: null });
      await createLockWindow();
      return { success: true };
    }

    
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

      
      await unlockBrowser();
      return { success: true };
    }

    
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

    
    case 'LOCK_NOW': {
      await lockBrowser();
      return { success: true };
    }

    default:
      return { error: 'Unknown message type.' };
  }
}

(async () => {
  try {
    
    await new Promise(resolve => setTimeout(resolve, 0));

    const store = await getStore();

    if (store.lockState === STATES.LOCKED) {
      lockEnforcementActive = true;

      
      if (!startupHandled) {
        startupHandled = true;

        
        let lockWindowAlive = false;
        if (store.lockWindowId != null) {
          try {
            await chrome.windows.get(store.lockWindowId);
            lockWindowAlive = true;
          } catch (_) {  }
        }

        if (!lockWindowAlive) {
          await setStore({ lockWindowId: null });
          await createLockWindow();
        }
      }

      
      for (const id of store.protectedWindowIds) {
        try { await chrome.windows.update(id, { state: 'minimized' }); }
        catch (_) {  }
      }

    } else if (store.lockState === STATES.UNLOCKED) {
      await setupInactivityAlarm();
    }
  } catch (_) {  }
})();
