// ============================================================
// Browser Lock — Lock Screen Logic
// ============================================================

'use strict';

(function () {
  // DOM refs
  const pinInput   = document.getElementById('pin-input');
  const unlockBtn  = document.getElementById('unlock-btn');
  const errorMsg   = document.getElementById('error-msg');
  const lockoutMsg = document.getElementById('lockout-msg');
  const spinner    = document.getElementById('spinner');

  let isSubmitting = false;
  let lockoutTimer = null;

  // ---- Initialise ----

  async function init() {
    pinInput.focus();

    // Check for existing lockout
    try {
      const state = await sendMessage({ type: 'GET_STATE' });
      if (state.lockoutRemaining > 0) {
        startLockoutCountdown(state.lockoutRemaining);
      }
    } catch (_) { /* ok */ }
  }

  // ---- PIN input filtering (digits only) ----

  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/[^0-9]/g, '');
  });

  pinInput.addEventListener('keydown', (e) => {
    // Allow: backspace, delete, tab, escape (no bypass), arrows, home, end
    const allowed = [
      'Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight',
      'Home', 'End'
    ];
    if (allowed.includes(e.key)) return;

    // Allow Ctrl+A, Ctrl+V, Ctrl+C
    if ((e.ctrlKey || e.metaKey) && ['a', 'v', 'c', 'x'].includes(e.key.toLowerCase())) return;

    // Allow digits
    if (/^[0-9]$/.test(e.key)) return;

    // Enter → submit
    if (e.key === 'Enter') {
      e.preventDefault();
      attemptUnlock();
      return;
    }

    // Block everything else
    e.preventDefault();
  });

  // ---- Unlock button ----

  unlockBtn.addEventListener('click', () => {
    attemptUnlock();
  });

  // ---- Forgot PIN button ----

  const forgotPinBtn = document.getElementById('forgot-pin-btn');
  if (forgotPinBtn) {
    forgotPinBtn.addEventListener('click', async () => {
      await sendMessage({ type: 'OPEN_RECOVERY_WINDOW' });
    });
  }

  // ---- Core unlock attempt ----

  async function attemptUnlock() {
    if (isSubmitting) return;

    const pin = pinInput.value.trim();
    if (pin.length < 4) {
      showError('PIN must be at least 4 digits.');
      shakeInput();
      return;
    }

    isSubmitting = true;
    setLoading(true);
    clearMessages();

    try {
      const result = await sendMessage({ type: 'VERIFY_PIN', pin });

      if (result.success) {
        // Unlock succeeds — the background will close this window
        unlockBtn.disabled = true;
        pinInput.disabled = true;
        return;
      }

      // Wrong PIN
      pinInput.value = '';
      pinInput.focus();
      shakeInput();

      if (result.locked) {
        showError('Too many failed attempts.');
        startLockoutCountdown(result.remainingSeconds);
      } else {
        showError('Incorrect PIN. Try again.');
      }
    } catch (err) {
      showError('An error occurred. Please try again.');
    } finally {
      isSubmitting = false;
      setLoading(false);
    }
  }

  // ---- Lockout countdown ----

  function startLockoutCountdown(seconds) {
    pinInput.disabled = true;
    unlockBtn.disabled = true;
    clearInterval(lockoutTimer);

    let remaining = seconds;
    updateLockoutDisplay(remaining);

    lockoutTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(lockoutTimer);
        lockoutTimer = null;
        lockoutMsg.textContent = '';
        lockoutMsg.classList.remove('visible');
        pinInput.disabled = false;
        unlockBtn.disabled = false;
        pinInput.focus();
      } else {
        updateLockoutDisplay(remaining);
      }
    }, 1000);
  }

  function updateLockoutDisplay(sec) {
    const mins = Math.floor(sec / 60);
    const secs = sec % 60;
    const timeStr = mins > 0
      ? `${mins}:${String(secs).padStart(2, '0')}`
      : `${secs}s`;
    lockoutMsg.textContent = `Please wait ${timeStr} before trying again.`;
    lockoutMsg.classList.add('visible');
  }

  // ---- UI helpers ----

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.add('visible');
  }

  function clearMessages() {
    errorMsg.textContent = '';
    errorMsg.classList.remove('visible');
  }

  function shakeInput() {
    pinInput.classList.remove('shake');
    // Force reflow to restart animation
    void pinInput.offsetWidth;
    pinInput.classList.add('shake');
  }

  function setLoading(loading) {
    if (loading) {
      unlockBtn.classList.add('loading');
      unlockBtn.disabled = true;
    } else {
      unlockBtn.classList.remove('loading');
      unlockBtn.disabled = false;
    }
  }

  // ---- Messaging ----

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

  // ---- Prevent context menu ----
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- Prevent navigation shortcuts ----
  document.addEventListener('keydown', (e) => {
    // Block F5, Ctrl+R (reload — not a bypass but prevents confusion)
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
    }
    // Block Ctrl+L (address bar — popup has none, but just in case)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
    }
    // Block Alt+Home (home page)
    if (e.altKey && e.key === 'Home') {
      e.preventDefault();
    }
  });

  // ---- Start ----
  init();
})();
