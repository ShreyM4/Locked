'use strict';

(function () {
  
  const methodsView      = document.getElementById('methods-view');
  const resetPinView     = document.getElementById('reset-pin-view');
  const viewTitle        = document.getElementById('view-title');
  const viewSubtitle     = document.getElementById('view-subtitle');

  
  const tabTotpBtn       = document.getElementById('tab-totp-btn');
  const tabFileBtn       = document.getElementById('tab-file-btn');
  const totpMethodArea   = document.getElementById('totp-method-area');
  const fileMethodArea   = document.getElementById('file-method-area');

  
  const totpInput        = document.getElementById('totp-input');
  const totpVerifyBtn    = document.getElementById('totp-verify-btn');
  
  
  const keyFileInput     = document.getElementById('key-file-input');
  const uploadFileBtn    = document.getElementById('upload-file-btn');
  const uploadBoxText    = document.getElementById('upload-box-text');
  const manualKeyInput   = document.getElementById('manual-key-input');
  const keyVerifyBtn     = document.getElementById('key-verify-btn');

  
  const backToLockBtn    = document.getElementById('back-to-lock-btn');
  const newPinInput      = document.getElementById('new-pin');
  const confirmPinInput  = document.getElementById('confirm-pin');
  const saveNewPinBtn    = document.getElementById('save-new-pin-btn');
  const errorMsg         = document.getElementById('error-msg');

  let isSubmitting = false;

  

  tabTotpBtn.addEventListener('click', () => {
    tabTotpBtn.classList.add('active');
    tabFileBtn.classList.remove('active');
    totpMethodArea.classList.add('active');
    fileMethodArea.classList.remove('active');
    clearError();
    totpInput.focus();
  });

  tabFileBtn.addEventListener('click', () => {
    tabFileBtn.classList.add('active');
    tabTotpBtn.classList.remove('active');
    fileMethodArea.classList.add('active');
    totpMethodArea.classList.remove('active');
    clearError();
    manualKeyInput.focus();
  });

  

  function filterDigits(input) {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9]/g, '');
    });
  }

  filterDigits(totpInput);
  filterDigits(newPinInput);
  filterDigits(confirmPinInput);

  // Auto-submit when 6 digits are typed in TOTP input
  totpInput.addEventListener('input', () => {
    if (totpInput.value.length === 6) {
      attemptTOTPVerify();
    }
  });

  

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

  // ---- 2. Saved Key File Verification ----

  uploadFileBtn.addEventListener('click', () => {
    keyFileInput.click();
  });

  keyFileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    uploadBoxText.textContent = `Reading: ${file.name}...`;
    clearError();

    try {
      
      const buffer = await readFileAsArrayBuffer(file);
      const bytes = new Uint8Array(buffer);

      let keyBase32 = '';

      // If exactly 20 bytes, it's the raw binary key
      if (bytes.length === 20 && window.TOTPEngine) {
        keyBase32 = TOTPEngine.base32Encode(bytes);
      } else {
        
        const text = new TextDecoder('utf-8').decode(bytes).trim();
        keyBase32 = text.replace(/[^A-Z2-7]/gi, '').toUpperCase();
      }

      if (!keyBase32) {
        uploadBoxText.textContent = 'Click to upload saved key file';
        showError('Could not parse a valid recovery key from this file.');
        shakeElement(uploadFileBtn);
        return;
      }

      uploadBoxText.textContent = `Loaded: ${file.name}`;
      await verifyRecoveryKey(keyBase32, uploadFileBtn);
    } catch (err) {
      uploadBoxText.textContent = 'Click to upload saved key file';
      showError('Failed to read key file: ' + err.message);
    } finally {
      keyFileInput.value = '';
    }
  });

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  // ---- 3. Manual Key Text Verification ----

  keyVerifyBtn.addEventListener('click', () => attemptManualKeyVerify());

  manualKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      attemptManualKeyVerify();
    }
  });

  async function attemptManualKeyVerify() {
    const raw = manualKeyInput.value.trim();
    const cleanKey = raw.replace(/[^A-Z2-7]/gi, '').toUpperCase();

    if (!cleanKey) {
      showError('Please paste your manual Base32 recovery key.');
      shakeElement(manualKeyInput);
      manualKeyInput.focus();
      return;
    }

    await verifyRecoveryKey(cleanKey, keyVerifyBtn);
  }

  async function verifyRecoveryKey(keyString, targetElement) {
    if (isSubmitting) return;

    clearError();
    setButtonLoading(keyVerifyBtn, true);
    isSubmitting = true;

    try {
      const res = await sendMessage({
        type: 'VERIFY_RECOVERY_KEY',
        key: keyString
      });

      if (res && res.success) {
        transitionToResetPIN();
      } else {
        showError(res.error || 'Invalid recovery key. Please check your file/text and try again.');
        if (targetElement) shakeElement(targetElement);
      }
    } catch (err) {
      showError('Verification error: ' + err.message);
    } finally {
      setButtonLoading(keyVerifyBtn, false);
      isSubmitting = false;
    }
  }

  

  function transitionToResetPIN() {
    clearError();
    methodsView.classList.remove('active');
    resetPinView.classList.add('active');
    viewTitle.textContent = 'Create New PIN';
    viewSubtitle.textContent = 'Set a new PIN to unlock this Chrome profile';
    newPinInput.focus();
  }

  

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

  

  backToLockBtn.addEventListener('click', async () => {
    await sendMessage({ type: 'OPEN_LOCK_WINDOW' });
  });

  

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

  
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
    }
  });
})();
