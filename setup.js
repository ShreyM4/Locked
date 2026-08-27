// ============================================================
// Browser Lock — Setup Screen Logic
// ============================================================

'use strict';

(function () {
  // DOM refs
  const stepCreate  = document.getElementById('step-create');
  const stepConfirm = document.getElementById('step-confirm');
  const newPinInput = document.getElementById('new-pin');
  const confirmInput = document.getElementById('confirm-pin');
  const nextBtn     = document.getElementById('next-btn');
  const confirmBtn  = document.getElementById('confirm-btn');
  const backBtn     = document.getElementById('back-btn');
  const errorMsg    = document.getElementById('error-msg');
  const strengthFill  = document.getElementById('strength-fill');
  const strengthLabel = document.getElementById('strength-label');

  let createdPin = '';

  // ---- PIN filtering (digits only) ----

  function filterDigits(input) {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9]/g, '');
    });

    input.addEventListener('keydown', (e) => {
      const allowed = ['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (allowed.includes(e.key)) return;
      if ((e.ctrlKey || e.metaKey) && ['a', 'v', 'c', 'x'].includes(e.key.toLowerCase())) return;
      if (/^[0-9]$/.test(e.key)) return;
      if (e.key === 'Enter') { e.preventDefault(); return; }
      e.preventDefault();
    });
  }

  filterDigits(newPinInput);
  filterDigits(confirmInput);

  // ---- PIN strength indicator ----

  newPinInput.addEventListener('input', () => {
    const len = newPinInput.value.length;
    updateStrength(len);
  });

  function updateStrength(len) {
    let pct = 0, color = '', label = '';

    if (len === 0) {
      strengthFill.style.width = '0%';
      strengthLabel.textContent = '';
      return;
    }

    if (len < 4) {
      pct = 15; color = '#f87171'; label = 'Too short';
    } else if (len <= 5) {
      pct = 40; color = '#fbbf24'; label = 'Fair';
    } else if (len <= 8) {
      pct = 70; color = '#38bdf8'; label = 'Good';
    } else {
      pct = 100; color = '#34d399'; label = 'Strong';
    }

    strengthFill.style.width = pct + '%';
    strengthFill.style.background = color;
    strengthLabel.style.color = color;
    strengthLabel.textContent = label;
  }

  // ---- Step 1 → Step 2 ----

  nextBtn.addEventListener('click', () => goToConfirm());

  newPinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToConfirm();
  });

  function goToConfirm() {
    const pin = newPinInput.value.trim();
    if (pin.length < 4) {
      showError('PIN must be at least 4 digits.');
      shakeInput(newPinInput);
      return;
    }

    createdPin = pin;
    clearError();
    stepCreate.classList.remove('active');
    stepConfirm.classList.add('active');
    confirmInput.value = '';
    confirmInput.focus();
  }

  // ---- Back button (Step 2 -> Step 1) ----

  backBtn.addEventListener('click', () => {
    stepConfirm.classList.remove('active');
    stepCreate.classList.add('active');
    clearError();
    newPinInput.focus();
  });

  // ---- Step 2: Confirm -> Step 3: TOTP Setup ----

  const stepTotp = document.getElementById('step-totp');
  const qrContainer = document.getElementById('qr-container');
  const secretKeyText = document.getElementById('secret-key-text');
  const finishSetupBtn = document.getElementById('finish-setup-btn');
  const backToStep2Btn = document.getElementById('back-to-step2-btn');

  let generatedTotpSecret = '';

  confirmBtn.addEventListener('click', () => goToTotpSetup());

  confirmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToTotpSetup();
  });

  function goToTotpSetup() {
    const pin = confirmInput.value.trim();

    if (pin !== createdPin) {
      showError('PINs do not match. Try again.');
      confirmInput.value = '';
      shakeInput(confirmInput);
      confirmInput.focus();
      return;
    }

    clearError();

    // Generate offline TOTP secret
    if (!generatedTotpSecret && window.TOTPEngine) {
      generatedTotpSecret = TOTPEngine.generateSecret(20);
      const otpUrl = TOTPEngine.getOtpAuthUrl(generatedTotpSecret, 'Chrome Profile', 'Browser Lock');
      qrContainer.innerHTML = TOTPEngine.generateQRCodeSVG(otpUrl, 148);
      secretKeyText.textContent = TOTPEngine.formatSecret(generatedTotpSecret);
    }

    stepConfirm.classList.remove('active');
    stepTotp.classList.add('active');
  }

  backToStep2Btn.addEventListener('click', () => {
    stepTotp.classList.remove('active');
    stepConfirm.classList.add('active');
    clearError();
    confirmInput.focus();
  });

  // ---- Step 3: Finish Setup & Lock ----

  finishSetupBtn.addEventListener('click', () => finishSetup());

  async function finishSetup() {
    clearError();
    finishSetupBtn.classList.add('loading');
    finishSetupBtn.disabled = true;
    backToStep2Btn.disabled = true;

    try {
      const result = await sendMessage({
        type: 'CREATE_PIN',
        pin: createdPin,
        totpSecret: generatedTotpSecret
      });

      if (result.success) {
        // Background will close this window and open lock window
        return;
      }

      showError(result.error || 'Failed to create PIN.');
    } catch (err) {
      showError('An error occurred. Please try again.');
    } finally {
      finishSetupBtn.classList.remove('loading');
      finishSetupBtn.disabled = false;
      backToStep2Btn.disabled = false;
    }
  }

  // ---- Helpers ----

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.add('visible');
  }

  function clearError() {
    errorMsg.textContent = '';
    errorMsg.classList.remove('visible');
  }

  function shakeInput(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
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

  // ---- Prevent context menu and navigation ----
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
    }
  });
})();
