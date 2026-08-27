// ============================================================
// Browser Lock — Options Page Logic
// ============================================================

'use strict';

(function () {
  // DOM refs
  const lockOnStartup    = document.getElementById('lock-on-startup');
  const inactivitySelect = document.getElementById('inactivity-timeout');
  const idleNotice       = document.getElementById('idle-permission-notice');
  const grantIdleBtn     = document.getElementById('grant-idle-btn');
  const lockNowBtn       = document.getElementById('lock-now-btn');
  const shortcutDisplay  = document.getElementById('shortcut-display');
  const shortcutsLink    = document.getElementById('shortcuts-link');

  const currentPinInput  = document.getElementById('current-pin');
  const newPinInput      = document.getElementById('new-pin');
  const confirmNewPin    = document.getElementById('confirm-new-pin');
  const changePinBtn     = document.getElementById('change-pin-btn');
  const changePinMsg     = document.getElementById('change-pin-msg');

  const resetPinInput    = document.getElementById('reset-pin');
  const resetBtn         = document.getElementById('reset-btn');
  const resetMsg         = document.getElementById('reset-msg');

  // ---- Filter PIN inputs to digits only ----

  function filterDigits(input) {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9]/g, '');
    });
  }

  [currentPinInput, newPinInput, confirmNewPin, resetPinInput].forEach(filterDigits);

  // ---- Load current settings ----

  async function loadSettings() {
    try {
      const state = await sendMessage({ type: 'GET_STATE' });
      if (state.settings) {
        lockOnStartup.checked = state.settings.lockOnStartup !== false;
        inactivitySelect.value = String(state.settings.inactivityTimeout || 0);
      }

      // Check if idle permission is needed
      if (state.settings && state.settings.inactivityTimeout > 0) {
        await checkIdlePermission();
      }
    } catch (_) { /* ok */ }
  }

  async function checkIdlePermission() {
    try {
      const hasIdle = await chrome.permissions.contains({ permissions: ['idle'] });
      if (!hasIdle && parseInt(inactivitySelect.value) > 0) {
        idleNotice.style.display = 'flex';
      } else {
        idleNotice.style.display = 'none';
      }
    } catch (_) {
      idleNotice.style.display = 'none';
    }
  }

  // ---- Lock on startup toggle ----

  lockOnStartup.addEventListener('change', async () => {
    await sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: { lockOnStartup: lockOnStartup.checked }
    });
  });

  // ---- Inactivity timeout ----

  inactivitySelect.addEventListener('change', async () => {
    const timeout = parseInt(inactivitySelect.value);

    const result = await sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: { inactivityTimeout: timeout }
    });

    if (result.needsIdlePermission) {
      idleNotice.style.display = 'flex';
    } else {
      idleNotice.style.display = 'none';
    }
  });

  // ---- Grant idle permission ----

  grantIdleBtn.addEventListener('click', async () => {
    try {
      const granted = await chrome.permissions.request({ permissions: ['idle'] });
      if (granted) {
        idleNotice.style.display = 'none';
        // Re-apply the setting now that we have permission
        await sendMessage({
          type: 'UPDATE_SETTINGS',
          settings: { inactivityTimeout: parseInt(inactivitySelect.value) }
        });
      }
    } catch (err) {
      // Permission request failed — user denied
    }
  });

  // ---- Lock now ----

  lockNowBtn.addEventListener('click', async () => {
    lockNowBtn.disabled = true;
    await sendMessage({ type: 'LOCK_NOW' });
    // The background will lock the browser — this tab will be minimised
  });

  // ---- Change PIN ----

  changePinBtn.addEventListener('click', async () => {
    const current = currentPinInput.value.trim();
    const newPin  = newPinInput.value.trim();
    const confirm = confirmNewPin.value.trim();

    showFeedback(changePinMsg, '', '');

    if (!current) {
      showFeedback(changePinMsg, 'Enter your current PIN.', 'error');
      return;
    }
    if (newPin.length < 4) {
      showFeedback(changePinMsg, 'New PIN must be at least 4 digits.', 'error');
      return;
    }
    if (newPin !== confirm) {
      showFeedback(changePinMsg, 'New PINs do not match.', 'error');
      return;
    }

    changePinBtn.disabled = true;

    try {
      const result = await sendMessage({
        type: 'CHANGE_PIN',
        currentPin: current,
        newPin: newPin
      });

      if (result.success) {
        showFeedback(changePinMsg, 'PIN changed successfully.', 'success');
        currentPinInput.value = '';
        newPinInput.value = '';
        confirmNewPin.value = '';
      } else {
        showFeedback(changePinMsg, result.error || 'Failed to change PIN.', 'error');
      }
    } catch (err) {
      showFeedback(changePinMsg, 'An error occurred.', 'error');
    } finally {
      changePinBtn.disabled = false;
    }
  });

  // ---- Reset extension ----

  resetBtn.addEventListener('click', async () => {
    const pin = resetPinInput.value.trim();
    showFeedback(resetMsg, '', '');

    if (!pin) {
      showFeedback(resetMsg, 'Enter your PIN to confirm reset.', 'error');
      return;
    }

    if (!confirm('Are you sure? This will remove your PIN and all settings.')) {
      return;
    }

    resetBtn.disabled = true;

    try {
      const result = await sendMessage({ type: 'RESET_EXTENSION', pin });

      if (result.success) {
        showFeedback(resetMsg, 'Extension reset. Reloading…', 'success');
        setTimeout(() => {
          chrome.runtime.reload();
        }, 1500);
      } else {
        showFeedback(resetMsg, result.error || 'Reset failed.', 'error');
      }
    } catch (err) {
      showFeedback(resetMsg, 'An error occurred.', 'error');
    } finally {
      resetBtn.disabled = false;
    }
  });

  // ---- Helpers ----

  function showFeedback(el, text, type) {
    el.textContent = text;
    el.className = 'feedback-msg' + (type ? ' ' + type : '');
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ---- Load and display keyboard shortcut ----

  async function loadShortcut() {
    try {
      const commands = await chrome.commands.getAll();
      const lockCmd = commands.find(c => c.name === 'lock-browser');
      if (lockCmd && lockCmd.shortcut) {
        shortcutDisplay.textContent = lockCmd.shortcut;
      } else {
        shortcutDisplay.textContent = 'Not set';
      }
    } catch (_) {
      shortcutDisplay.textContent = 'Ctrl+Shift+Z';
    }
  }

  // Open shortcuts page (chrome:// URLs can't be linked directly)
  shortcutsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // ---- Init ----
  loadSettings();
  loadShortcut();
})();
