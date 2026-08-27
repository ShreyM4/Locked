'use strict';

(function () {
  
  const pinInput   = document.getElementById('pin-input');
  const unlockBtn  = document.getElementById('unlock-btn');
  const errorMsg   = document.getElementById('error-msg');
  const lockoutMsg = document.getElementById('lockout-msg');
  const spinner    = document.getElementById('spinner');

  let isSubmitting = false;
  let lockoutTimer = null;

  

  async function init() {
    pinInput.focus();

    
    try {
      const state = await sendMessage({ type: 'GET_STATE' });
      if (state.lockoutRemaining > 0) {
        startLockoutCountdown(state.lockoutRemaining);
      }
    } catch (_) {  }
  }

  

  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/[^0-9]/g, '');
  });

  pinInput.addEventListener('keydown', (e) => {
    
    const allowed = [
      'Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight',
      'Home', 'End'
    ];
    if (allowed.includes(e.key)) return;

    
    if ((e.ctrlKey || e.metaKey) && ['a', 'v', 'c', 'x'].includes(e.key.toLowerCase())) return;

    
    if (/^[0-9]$/.test(e.key)) return;

    
    if (e.key === 'Enter') {
      e.preventDefault();
      attemptUnlock();
      return;
    }

    
    e.preventDefault();
  });

  

  unlockBtn.addEventListener('click', () => {
    attemptUnlock();
  });

  

  const forgotPinBtn = document.getElementById('forgot-pin-btn');
  if (forgotPinBtn) {
    forgotPinBtn.addEventListener('click', async () => {
      await sendMessage({ type: 'OPEN_RECOVERY_WINDOW' });
    });
  }

  

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
        
        unlockBtn.disabled = true;
        pinInput.disabled = true;
        return;
      }

      
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
    
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
    }
    
    if (e.altKey && e.key === 'Home') {
      e.preventDefault();
    }
  });

  
  init();
})();
