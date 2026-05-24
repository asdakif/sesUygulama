'use strict';

(function initVoiceSettings(globalScope) {
  function formatPttKeyLabel(code) {
    const labels = {
      Space: 'Boşluk',
      Escape: 'Esc',
      Tab: 'Tab',
      CapsLock: 'Caps Lock',
      ShiftLeft: 'Sol Shift',
      ShiftRight: 'Sağ Shift',
      ControlLeft: 'Sol Ctrl',
      ControlRight: 'Sağ Ctrl',
      AltLeft: 'Sol Alt',
      AltRight: 'Sağ Alt',
      MetaLeft: 'Sol Win',
      MetaRight: 'Sağ Win',
      Backspace: 'Backspace',
      Enter: 'Enter',
      Insert: 'Insert',
      Delete: 'Delete',
      Home: 'Home',
      End: 'End',
      PageUp: 'Page Up',
      PageDown: 'Page Down',
      ArrowUp: 'Yukarı Ok',
      ArrowDown: 'Aşağı Ok',
      ArrowLeft: 'Sol Ok',
      ArrowRight: 'Sağ Ok',
      Backquote: '`',
      Minus: '-',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Semicolon: ';',
      Quote: '\'',
      Comma: ',',
      Period: '.',
      Slash: '/',
    };
    if (labels[code]) return labels[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
    return code || 'Boşluk';
  }

  function createPttController({
    electronAPI = null,
    isElectronApp = false,
    localStorageKeyPrefix = '',
    localStorageRef = globalScope.localStorage,
    pttKeyBtn,
    pttKeyDesc,
    pttKeyNote,
    hasVoiceRoom,
    isEditableTarget,
    onStateChange,
  }) {
    const storageKey = (suffix) => `${localStorageKeyPrefix}${suffix}`;
    let pttActive = false;
    let capturingPttKey = false;
    let voiceMode = localStorageRef.getItem(storageKey('voiceMode')) || 'vad';
    let pttKeyCode = localStorageRef.getItem(storageKey('pttKeyCode')) || 'Space';

    function syncElectronPttBinding() {
      electronAPI?.setPttKey?.(pttKeyCode);
    }

    function emitState() {
      onStateChange?.({ voiceMode, pttActive, pttKeyCode });
    }

    function updateUi() {
      const keyLabel = formatPttKeyLabel(pttKeyCode);
      if (pttKeyBtn) {
        pttKeyBtn.textContent = capturingPttKey ? 'Bir tuşa bas...' : keyLabel;
        pttKeyBtn.classList.toggle('capturing', capturingPttKey);
      }
      if (pttKeyDesc) {
        pttKeyDesc.textContent = capturingPttKey
          ? 'İstediğin tuşa bas. Vazgeçmek için Esc.'
          : `${keyLabel} basılıyken mikrofon açılır.`;
      }
      if (pttKeyNote) {
        pttKeyNote.textContent = isElectronApp
          ? '* Masaüstü uygulamada pencere odaktayken çalışır.'
          : '* Web sürümünde sekme odaktayken çalışır.';
      }
    }

    function setPttKey(code) {
      if (!code) return;
      capturingPttKey = false;
      pttKeyCode = code;
      localStorageRef.setItem(storageKey('pttKeyCode'), code);
      updateUi();
      syncElectronPttBinding();
      emitState();
    }

    function stopCapture() {
      capturingPttKey = false;
      updateUi();
    }

    function setPttActive(active) {
      if (pttActive === active) return;
      pttActive = active;
      emitState();
    }

    function setVoiceMode(mode) {
      voiceMode = mode;
      localStorageRef.setItem(storageKey('voiceMode'), mode);
      emitState();
    }

    function handlePttInput({ type, code, repeat = false, target = null }) {
      if (!hasVoiceRoom?.() || voiceMode !== 'ptt') return false;
      const activeTarget = target || document.activeElement;
      if (activeTarget && isEditableTarget?.(activeTarget)) return false;
      if (code !== pttKeyCode) return false;

      if (type === 'keydown') {
        if (repeat || pttActive) return true;
        setPttActive(true);
        return true;
      }
      if (type === 'keyup') {
        setPttActive(false);
        return true;
      }
      return false;
    }

    function attach() {
      globalScope.addEventListener('keydown', (event) => {
        if (capturingPttKey) {
          event.preventDefault();
          if (event.repeat) return;
          if (event.code === 'Escape') {
            stopCapture();
            return;
          }
          setPttKey(event.code);
          return;
        }

        if (electronAPI?.onPttKeyEvent) return;
        const handled = handlePttInput({
          type: 'keydown',
          code: event.code,
          repeat: event.repeat,
          target: event.target,
        });
        if (handled) event.preventDefault();
      }, true);

      globalScope.addEventListener('keyup', (event) => {
        if (capturingPttKey || electronAPI?.onPttKeyEvent) return;
        const handled = handlePttInput({
          type: 'keyup',
          code: event.code,
          target: event.target,
        });
        if (handled) event.preventDefault();
      }, true);

      electronAPI?.onPttKeyEvent?.((payload) => {
        handlePttInput({
          type: payload.type === 'keyDown' ? 'keydown' : 'keyup',
          code: payload.code,
          repeat: payload.isAutoRepeat,
        });
      });

      globalScope.addEventListener('blur', () => {
        setPttActive(false);
        if (capturingPttKey) stopCapture();
      });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) setPttActive(false);
      });

      pttKeyBtn?.addEventListener('click', () => {
        capturingPttKey = true;
        updateUi();
      });

      syncElectronPttBinding();
      updateUi();
      emitState();
    }

    return {
      attach,
      getVoiceMode: () => voiceMode,
      getPttActive: () => pttActive,
      getPttKeyCode: () => pttKeyCode,
      setVoiceMode,
      stopCapture,
      syncUi: updateUi,
    };
  }

  function createAudioDeviceController({
    localStorageKeyPrefix = '',
    localStorageRef = globalScope.localStorage,
    inputSelect,
    outputSelect,
    noteEl,
    screenVideo,
    getPeerAudioElements,
    getBaseVoiceConstraints,
    getCurrentVoiceRoom,
    getPeerConnections,
    getLocalStream,
    setLocalStream,
    setupLocalAudioAnalyser,
    applyMicState,
    updateMuteBtn,
    onMicrophoneError,
  }) {
    const storageKey = (suffix) => `${localStorageKeyPrefix}${suffix}`;
    const outputDeviceSupported =
      typeof HTMLMediaElement !== 'undefined' &&
      typeof HTMLMediaElement.prototype.setSinkId === 'function';
    const outputPickerSupported =
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.selectAudioOutput === 'function';

    let preferredInputDeviceId = localStorageRef.getItem(storageKey('voiceInputDeviceId')) || 'default';
    let preferredOutputDeviceId = localStorageRef.getItem(storageKey('voiceOutputDeviceId')) || 'default';
    let accessProbePromise = null;

    async function ensureReadableDeviceLabels() {
      if (!navigator.mediaDevices?.getUserMedia) return false;
      if (accessProbePromise) return accessProbePromise;

      accessProbePromise = (async () => {
        let tempStream = null;
        try {
          tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          return true;
        } catch (error) {
          console.warn('[Ses] Cihaz izinleri alınamadı:', error.message);
          return false;
        } finally {
          tempStream?.getTracks().forEach((track) => track.stop());
          accessProbePromise = null;
        }
      })();

      return accessProbePromise;
    }

    function buildVoiceAudioConstraints() {
      const constraints = { ...getBaseVoiceConstraints() };
      if (preferredInputDeviceId && preferredInputDeviceId !== 'default') {
        constraints.deviceId = { exact: preferredInputDeviceId };
      }
      return constraints;
    }

    async function applyOutputDeviceToElement(el) {
      if (!el || !outputDeviceSupported) return;
      const sinkId = preferredOutputDeviceId === 'default' ? '' : preferredOutputDeviceId;
      try {
        await el.setSinkId(sinkId);
      } catch (error) {
        console.warn('[Ses] Çıkış cihazı uygulanamadı:', error.message);
      }
    }

    async function applyPreferredOutputDevice() {
      await applyOutputDeviceToElement(screenVideo);
      const mediaEls = getPeerAudioElements?.() || [];
      await Promise.all(mediaEls.map((el) => applyOutputDeviceToElement(el)));
    }

    function buildDeviceOptionLabel(device, fallback) {
      if (device.label) return device.label;
      if (device.deviceId === 'default') return `${fallback} (Sistem Varsayılanı)`;
      return fallback;
    }

    function populateSelect(selectEl, devices, preferredId, fallbackLabel) {
      if (!selectEl) return preferredId;
      selectEl.innerHTML = '';

      if (!devices.length) {
        const option = document.createElement('option');
        option.value = 'default';
        option.textContent = fallbackLabel;
        selectEl.append(option);
        selectEl.disabled = true;
        selectEl.value = 'default';
        return 'default';
      }

      selectEl.disabled = false;
      for (const device of devices) {
        const option = document.createElement('option');
        option.value = device.deviceId || 'default';
        option.textContent = buildDeviceOptionLabel(
          device,
          selectEl === inputSelect ? 'Mikrofon' : 'Hoparlör / Kulaklık',
        );
        selectEl.append(option);
      }

      const hasPreferred = devices.some((device) => device.deviceId === preferredId);
      const nextValue = hasPreferred ? preferredId : (devices[0].deviceId || 'default');
      selectEl.value = nextValue;
      return nextValue;
    }

    async function refreshSelectors({ ensurePermissions = false } = {}) {
      if (!navigator.mediaDevices?.enumerateDevices) return;

      try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        const hasHiddenLabels = devices.some((device) =>
          (device.kind === 'audioinput' || device.kind === 'audiooutput') && !device.label
        );

        if (ensurePermissions && hasHiddenLabels) {
          const granted = await ensureReadableDeviceLabels();
          if (granted) devices = await navigator.mediaDevices.enumerateDevices();
        }

        const inputDevices = devices.filter((device) => device.kind === 'audioinput');
        const outputDevices = devices.filter((device) => device.kind === 'audiooutput');

        preferredInputDeviceId = populateSelect(
          inputSelect,
          inputDevices,
          preferredInputDeviceId,
          'Mikrofon bulunamadı',
        );
        preferredOutputDeviceId = populateSelect(
          outputSelect,
          outputDevices,
          preferredOutputDeviceId,
          'Hoparlör bulunamadı',
        );

        localStorageRef.setItem(storageKey('voiceInputDeviceId'), preferredInputDeviceId);
        localStorageRef.setItem(storageKey('voiceOutputDeviceId'), preferredOutputDeviceId);

        if (outputSelect) outputSelect.disabled = !outputDeviceSupported || outputSelect.disabled;
        if (noteEl) {
          if (!outputDeviceSupported) {
            noteEl.textContent = '* Hoparlör seçimi bu tarayıcıda desteklenmiyor; mikrofon değişikliği hemen uygulanır.';
          } else if (!inputDevices.length && !outputDevices.length) {
            noteEl.textContent = '* Ses cihazı bulunamadı. İzin verdikten sonra tekrar dene.';
          } else if (outputPickerSupported) {
            noteEl.textContent = '* Sesli kanaldaysan mikrofon değişikliği hemen uygulanır. Hoparlör seçince tarayıcı izin isteyebilir.';
          } else {
            noteEl.textContent = '* Sesli kanaldaysan mikrofon değişikliği hemen uygulanır.';
          }
        }
      } catch (error) {
        console.warn('[Ses] Cihaz listesi alınamadı:', error.message);
        if (noteEl) noteEl.textContent = '* Ses cihazları listelenemedi. İzin verdikten sonra tekrar dene.';
      }
    }

    async function refreshActiveMicrophone() {
      if (!getCurrentVoiceRoom?.()) return;

      try {
        const nextStream = await navigator.mediaDevices.getUserMedia({
          audio: buildVoiceAudioConstraints(),
          video: false,
        });
        const nextTrack = nextStream.getAudioTracks()[0];
        if (!nextTrack) return;

        const oldStream = getLocalStream?.();
        setLocalStream?.(nextStream);
        setupLocalAudioAnalyser?.(nextStream);

        const replacements = [];
        for (const [, pc] of getPeerConnections?.() || []) {
          const sender = pc.getSenders().find((item) => item.track?.kind === 'audio');
          if (sender) replacements.push(sender.replaceTrack(nextTrack));
          else pc.addTrack(nextTrack, nextStream);
        }
        await Promise.allSettled(replacements);

        oldStream?.getTracks().forEach((track) => track.stop());
        applyMicState?.();
        updateMuteBtn?.();
        return true;
      } catch (error) {
        console.warn('[Ses] Mikrofon değiştirilemedi:', error.message);
        onMicrophoneError?.(error);
        return false;
      }
    }

    function attach() {
      inputSelect?.addEventListener('change', async () => {
        const previousInputDeviceId = preferredInputDeviceId;
        preferredInputDeviceId = inputSelect.value || 'default';
        localStorageRef.setItem(storageKey('voiceInputDeviceId'), preferredInputDeviceId);
        const switched = await refreshActiveMicrophone();
        if (getCurrentVoiceRoom?.() && switched === false) {
          preferredInputDeviceId = previousInputDeviceId;
          localStorageRef.setItem(storageKey('voiceInputDeviceId'), preferredInputDeviceId);
        }
        await refreshSelectors({ ensurePermissions: true });
      });

      outputSelect?.addEventListener('change', async () => {
        const previousOutputDeviceId = preferredOutputDeviceId;
        let nextOutputDeviceId = outputSelect.value || 'default';

        try {
          if (nextOutputDeviceId !== 'default' && outputPickerSupported) {
            const grantedDevice = await navigator.mediaDevices.selectAudioOutput({
              deviceId: nextOutputDeviceId,
            });
            if (grantedDevice?.deviceId) nextOutputDeviceId = grantedDevice.deviceId;
          }

          preferredOutputDeviceId = nextOutputDeviceId;
          localStorageRef.setItem(storageKey('voiceOutputDeviceId'), preferredOutputDeviceId);
          await applyPreferredOutputDevice();
          await refreshSelectors({ ensurePermissions: true });
        } catch (error) {
          console.warn('[Ses] Çıkış cihazı değiştirilemedi:', error.message);
          preferredOutputDeviceId = previousOutputDeviceId;
          localStorageRef.setItem(storageKey('voiceOutputDeviceId'), preferredOutputDeviceId);
          if (outputSelect) outputSelect.value = preferredOutputDeviceId;
          if (noteEl) {
            noteEl.textContent = '* Hoparlör seçimi uygulanamadı. Tarayıcı izni veya cihaz erişimi gerekli olabilir.';
          }
        }
      });

      navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
        await refreshSelectors();
        await applyPreferredOutputDevice();
      });

      refreshSelectors({ ensurePermissions: true });
    }

    return {
      attach,
      buildVoiceAudioConstraints,
      refreshSelectors,
      refreshActiveMicrophone,
      applyPreferredOutputDevice,
      isOutputDeviceSupported: () => outputDeviceSupported,
    };
  }

  globalScope.SesAppVoiceSettings = {
    formatPttKeyLabel,
    createPttController,
    createAudioDeviceController,
  };
})(window);
