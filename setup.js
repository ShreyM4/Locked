'use strict';

(function () {
  
  const stepCreate        = document.getElementById('step-create');
  const stepConfirm       = document.getElementById('step-confirm');
  const stepTotp          = document.getElementById('step-totp');
  
  const newPinInput       = document.getElementById('new-pin');
  const confirmInput      = document.getElementById('confirm-pin');
  const setupAccountEmail = document.getElementById('setup-account-email');
  const setupTotpCode     = document.getElementById('setup-totp-code');

  const nextBtn           = document.getElementById('next-btn');
  const confirmBtn        = document.getElementById('confirm-btn');
  const backBtn           = document.getElementById('back-btn');
  const finishSetupBtn    = document.getElementById('finish-setup-btn');
  const backToStep2Btn    = document.getElementById('back-to-step2-btn');

  const qrContainer       = document.getElementById('qr-container');
  const secretKeyText     = document.getElementById('secret-key-text');
  const errorMsg          = document.getElementById('error-msg');
  const strengthFill      = document.getElementById('strength-fill');
  const strengthLabel     = document.getElementById('strength-label');

  let createdPin = '';
  let generatedTotpSecret = '';
  let detectedProfileEmail = 'Chrome Profile';

  

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
  filterDigits(setupTotpCode);

  

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

  

  confirmBtn.addEventListener('click', () => goToTotpSetup());

  confirmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToTotpSetup();
  });

  
  async function getProfileAccountEmail() {
    try {
      if (chrome.identity && chrome.identity.getProfileUserInfo) {
        const info = await new Promise((resolve) => {
          chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (res) => {
            if (chrome.runtime.lastError) {
              console.warn('chrome.identity error:', chrome.runtime.lastError.message);
              resolve({ email: '', id: '', error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { email: '', id: '' });
            }
          });
        });

        console.log('Profile info:', info);
        console.log('Email:', JSON.stringify(info ? info.email : ''));
        console.log('ID:', JSON.stringify(info ? info.id : ''));

        if (info && info.email && info.email.trim()) {
          return info.email.trim();
        }
      } else {
        console.warn('chrome.identity.getProfileUserInfo is not available.');
      }
    } catch (err) {
      console.error('Failed to fetch profile email:', err);
    }
    return '';
  }

  function renderQRCode(label) {
    if (!generatedTotpSecret || !window.TOTPEngine) return;
    const account = label || detectedProfileEmail || 'Chrome Profile';
    const otpUrl = TOTPEngine.getOtpAuthUrl(generatedTotpSecret, account, 'SimpleLock');
    qrContainer.innerHTML = TOTPEngine.generateQRCodeSVG(otpUrl, 114);
    secretKeyText.textContent = TOTPEngine.formatSecret(generatedTotpSecret);
  }

  async function goToTotpSetup() {
    const pin = confirmInput.value.trim();

    if (pin !== createdPin) {
      showError('PINs do not match. Try again.');
      confirmInput.value = '';
      shakeInput(confirmInput);
      confirmInput.focus();
      return;
    }

    clearError();

    // Fetch primary Google Account email from Chrome Identity API
    const email = await getProfileAccountEmail();
    detectedProfileEmail = email || 'Chrome Profile';

    if (setupAccountEmail) {
      setupAccountEmail.textContent = email ? email : 'Chrome Profile (Not signed in)';
    }

    
    if (!generatedTotpSecret && window.TOTPEngine) {
      generatedTotpSecret = TOTPEngine.generateSecret(20);
    }
    renderQRCode(detectedProfileEmail);

    stepConfirm.classList.remove('active');
    stepTotp.classList.add('active');
    setupTotpCode.value = '';
    setTimeout(() => setupTotpCode.focus(), 100);
  }

  backToStep2Btn.addEventListener('click', () => {
    stepTotp.classList.remove('active');
    stepConfirm.classList.add('active');
    clearError();
    confirmInput.focus();
  });

  

  finishSetupBtn.addEventListener('click', () => finishSetup());

  setupTotpCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finishSetup();
  });

  async function saveKeyBinaryFile(secretBase32, profileLabel) {
    if (!window.TOTPEngine) return;
    const rawBytes = TOTPEngine.base32Decode(secretBase32);
    const safeName = (profileLabel || 'chrome-profile').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const filename = `browser-lock-${safeName}-key`;

    try {
      if (typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: 'Binary Key File',
            accept: { 'application/octet-stream': [] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(rawBytes);
        await writable.close();
        return;
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    }

    
    try {
      const blob = new Blob([rawBytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (_) {}
  }

  async function finishSetup() {
    clearError();
    const code = setupTotpCode.value.trim();

    if (code.length !== 6) {
      showError('Please enter the 6-digit code from Google Authenticator to confirm setup.');
      shakeInput(setupTotpCode);
      setupTotpCode.focus();
      return;
    }

    
    if (window.TOTPEngine) {
      const isValid = await TOTPEngine.verifyTOTP(code, generatedTotpSecret);
      if (!isValid) {
        showError('Invalid code. Ensure you scanned the QR code in Google Authenticator and enter the current 6 digits.');
        shakeInput(setupTotpCode);
        setupTotpCode.value = '';
        setupTotpCode.focus();
        return;
      }
    }

    finishSetupBtn.classList.add('loading');
    finishSetupBtn.disabled = true;
    backToStep2Btn.disabled = true;

    try {
      
      await saveKeyBinaryFile(generatedTotpSecret, detectedProfileEmail);

      const result = await sendMessage({
        type: 'CREATE_PIN',
        pin: createdPin,
        totpSecret: generatedTotpSecret,
        profileName: detectedProfileEmail
      });

      if (result.success) {
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

  
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
    }
  });
})();
