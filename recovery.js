// ============================================================
// Browser Lock — Account Recovery Logic
// Supports Windows Security Native Verification & Offline TOTP
// ============================================================

'use strict';

(function () {
  const NATIVE_HOST_NAME = 'com.browserlock.native_helper';

  // DOM Elements
  const methodsView    = document.getElementById('methods-view');
  const resetPinView   = document.getElementById('reset-pin-view');
  const viewTitle      = document.getElementById('view-title');
  const viewSubtitle   = document.getElementById('view-subtitle');

  const winVerifyBtn   = document.getElementById('windows-verify-btn');
  const totpInput      = document.getElementById('totp-input');
  const totpVerifyBtn  = document.getElementById('totp-verify-btn');
  const backToLockBtn  = document.getElementById('back-to-lock-btn');

  const newPinInput    = document.getElementById('new-pin');
  const confirmPinInput= document.getElementById('confirm-pin');
  const saveNewPinBtn  = document.getElementById('save-new-pin-btn');

  const errorMsg       = document.getElementById('error-msg');

  let isSubmitting = false;

  // ---- Digits only input filter ----

  function filterDigits(input) {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9]/g, '');
    });
  }

  filterDigits(totpInput);
  filterDigits(newPinInput);
  filterDigits(confirmPinInput);

  // ---- 1. Windows Native Security Verification ----

  winVerifyBtn.addEventListener('click', async () => {
    if (isSubmitting) return;
    clearError();
    setButtonLoading(winVerifyBtn, true);
    isSubmitting = true;

    try {
      // Connect to the local Windows native messaging host
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST_NAME,
        { action: 'verify_windows_credentials' },
        (response) => {
          setButtonLoading(winVerifyBtn, false);
          isSubmitting = false;

          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError.message;
            if (err.includes('not found') || err.includes('specified host')) {
              showError('Windows Native Helper is not installed yet. Run install.bat in native-host/ or use Authenticator App below.');
            } else {
              showError('Native verification error: ' + err);
            }
            return;
          }

          if (response && response.success) {
            transitionToResetPIN();
          } else if (response && response.cancelled) {
            showError('Windows verification was cancelled.');
          } else {
            showError((response && response.error) || 'Windows credential verification failed.');
          }
        }
      );
    } catch (err) {
      setButtonLoading(winVerifyBtn, false);
      isSubmitting = false;
      showError('Failed to launch Windows Security: ' + err.message);
    }
  });

  // ---- 2. Authenticator App (TOTP) Verification ----

  totpVerifyBtn.addEventListener('click', () => attemptTOTPVerify());

  totpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      attemptTOTPVerify();
    }
  });

  async function attemptTOTPVerify() {
    if (isSubmitting) return;
    const code = totpInput.value.trim();

    if (code.length !== 6) {
      showError('Please enter a 6-digit Authenticator code.');
      shakeElement(totpInput);
      return;
    }

    clearError();
    setButtonLoading(totpVerifyBtn, true);
    isSubmitting = true;

    try {
      const res = await sendMessage({ type: 'VERIFY_TOTP', token: code });

      if (res && res.success) {
        transitionToResetPIN();
      } else {
        showError(res.error || 'Invalid or expired code. Check your device time and try again.');
        totpInput.value = '';
        shakeElement(totpInput);
      }
    } catch (err) {
      showError('Verification error: ' + err.message);
    } finally {
      setButtonLoading(totpVerifyBtn, false);
      isSubmitting = false;
    }
  }

  // ---- 3. Transition to Create New PIN ----

  function transitionToResetPIN() {
    clearError();
    methodsView.classList.remove('active');
    resetPinView.classList.add('active');
    viewTitle.textContent = 'Create New PIN';
    viewSubtitle.textContent = 'Set a new PIN to unlock this Chrome profile';
    newPinInput.focus();
  }

  // ---- 4. Save New PIN ----

  saveNewPinBtn.addEventListener('click', () => attemptSaveNewPIN());

  confirmPinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      attemptSaveNewPIN();
    }
  });

  async function attemptSaveNewPIN() {
    if (isSubmitting) return;

    const newPin = newPinInput.value.trim();
    const confirmPin = confirmPinInput.value.trim();

    if (newPin.length < 4) {
      showError('New PIN must be at least 4 digits.');
      shakeElement(newPinInput);
      return;
    }

    if (newPin !== confirmPin) {
      showError('PIN confirmation does not match.');
      shakeElement(confirmPinInput);
      return;
    }

    clearError();
    setButtonLoading(saveNewPinBtn, true);
    isSubmitting = true;

    try {
      const res = await sendMessage({
        type: 'RESET_PIN_WITH_RECOVERY',
        newPin: newPin
      });

      if (res && res.success) {
        // Success! Background service worker updates credentials and unlocks browser.
        saveNewPinBtn.disabled = true;
        newPinInput.disabled = true;
        confirmPinInput.disabled = true;
      } else {
        showError(res.error || 'Failed to save new PIN.');
      }
    } catch (err) {
      showError('Error updating PIN: ' + err.message);
    } finally {
      setButtonLoading(saveNewPinBtn, false);
      isSubmitting = false;
    }
  }

  // ---- Back to Lock Screen ----

  backToLockBtn.addEventListener('click', async () => {
    await sendMessage({ type: 'OPEN_LOCK_WINDOW' });
  });

  // ---- Helpers ----

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.add('visible');
  }

  function clearError() {
    errorMsg.textContent = '';
    errorMsg.classList.remove('visible');
  }

  function shakeElement(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  function setButtonLoading(btn, loading) {
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
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

  // Prevent context menu & reload
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
    }
  });
})();
