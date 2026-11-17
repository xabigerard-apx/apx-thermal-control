(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'apx_thermal_state_v1';
  const BLE_SERVICE_UUID = 0xffe0;
  const BLE_CHAR_UUID = 0xffe1;
  const XOR_KEY = [0x70, 0x61, 0x73, 0x73, 0x77, 0x6f, 0x72, 0x64];

  const HEATER_STATES = {
    OFFLINE:     { label: 'OFFLINE',     css: 'state-offline' },
    STANDBY:     { label: 'STANDBY',     css: 'state-standby' },
    SELF_CHECK:  { label: 'SELF-CHECK',  css: 'state-check' },
    PREHEAT:     { label: 'PREHEAT',     css: 'state-preheat' },
    IGNITION:    { label: 'IGNITION',    css: 'state-ignition' },
    RUNNING:     { label: 'RUNNING',     css: 'state-running' },
    COOLDOWN:    { label: 'COOLDOWN',    css: 'state-cooldown' },
    VENTILATION: { label: 'VENTILATION', css: 'state-vent' }
  };

  const BLE_CODE_TO_STATE = {
    0: 'STANDBY',
    1: 'SELF_CHECK',
    2: 'PREHEAT',
    3: 'IGNITION',
    4: 'RUNNING',
    5: 'COOLDOWN',
    6: 'VENTILATION'
  };

  const ERROR_MAP = {
    1: 'Low battery voltage (< 10.5V)',
    2: 'Over-voltage protection (> 16V)',
    3: 'Glow plug circuit failure',
    4: 'Fuel pump open/short circuit',
    5: 'Overheating / Flameout protection',
    6: 'Blower fan motor error',
    7: 'Communication / Panel wiring error',
    8: 'Lack of fuel / Air bubble in line',
    9: 'Temp sensor short/open circuit',
    10: 'Ignition failed after 2 attempts'
  };

  const defaultState = {
    ctrlMode: 'power',
    ctrlTarget: 5,
    schedMode: 'power',
    schedTarget: 8,
    schedDuration: 30,
    schedMasterEnabled: true,
    transport: 'ble',
    protocol: '0x55',
    pin: '1234',
    savedDeviceId: null,
    schedule: [
      { day: 'MON', enabled: true,  time: '05:30' },
      { day: 'TUE', enabled: true,  time: '05:30' },
      { day: 'WED', enabled: false, time: '07:00' },
      { day: 'THU', enabled: true,  time: '05:30' },
      { day: 'FRI', enabled: false, time: '07:00' },
      { day: 'SAT', enabled: false, time: '08:30' },
      { day: 'SUN', enabled: false, time: '08:30' }
    ]
  };

  function loadSavedState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...defaultState };
      return { ...defaultState, ...JSON.parse(raw) };
    } catch {
      return { ...defaultState };
    }
  }

  const saved = loadSavedState();

  const state = {
    ...saved,
    connected: false,
    systemState: 'OFFLINE',
    cabinTemp: null,
    coreTemp: null,
    voltage: null,
    shutoffRemainingSec: 0,
    shutoffInterval: null,
    simLoop: null,
    pollLoop: null,
    cycleTimers: [],
    bleDevice: null,
    bleChar: null,
    ackReceived: false,
    userDisconnected: false
  };

  function saveSettings() {
    const toSave = {
      ctrlMode: state.ctrlMode,
      ctrlTarget: state.ctrlTarget,
      schedMode: state.schedMode,
      schedTarget: state.schedTarget,
      schedDuration: state.schedDuration,
      schedMasterEnabled: state.schedMasterEnabled,
      transport: state.transport,
      protocol: state.protocol,
      pin: state.pin,
      savedDeviceId: state.savedDeviceId,
      schedule: state.schedule
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) {
      logHex(`Storage warning: ${e.message}`);
    }
  }

  function logHex(msg) {
    const box = $('hexLog');
    const ts = new Date().toLocaleTimeString('en-CA', { hour12: false });
    box.textContent += `[${ts}] ${msg}\n`;
    box.scrollTop = box.scrollHeight;
  }

  const toHex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');

  function setAckBadge(status) {
    const pill = $('ackIndicator');
    if (status === 'sending') {
      pill.textContent = 'SENDING...';
      pill.className = 'ack-pill sending';
    } else if (status === 'ok') {
      pill.textContent = 'ACK ✓';
      pill.className = 'ack-pill confirmed';
    } else if (status === 'fail') {
      pill.textContent = 'NO ACK';
      pill.className = 'ack-pill failed';
    } else {
      pill.textContent = 'READY';
      pill.className = 'ack-pill';
    }
  }

  function clearCycleTimers() {
    state.cycleTimers.forEach(t => clearTimeout(t));
    state.cycleTimers = [];
  }

  function setSystemState(newStateKey) {
    state.systemState = newStateKey;
    updateTelemetryUI();
  }

  function showError(code) {
    const banner = $('errorBanner');
    if (!code || code === 0) {
      banner.classList.add('hidden');
      return;
    }
    const codeStr = `E-${String(code).padStart(2, '0')}`;
    $('errorCode').textContent = codeStr;
    $('errorDesc').textContent = ERROR_MAP[code] || 'Unknown heater fault';
    banner.classList.remove('hidden');
  }

  // ==================== BLE PROTOCOL & RELIABLE TX ====================
  function buildPacket(cmd, d0 = 0, d1 = 0) {
    const variant = parseInt(state.protocol, 16) || 0x55;
    const pinStr = String(state.pin || '1234').padStart(4, '0');
    const pinHi = parseInt(pinStr.slice(0, 2), 10);
    const pinLo = parseInt(pinStr.slice(2, 4), 10);
    const checksum = (pinHi + pinLo + cmd + d0 + d1) & 0xff;
    return new Uint8Array([0xaa, variant, pinHi, pinLo, cmd, d0, d1, checksum]);
  }

  async function sendCommand(cmd, d0 = 0, d1 = 0, label = '') {
    const pkt = buildPacket(cmd, d0, d1);

    if (state.transport === 'sim') {
      setAckBadge('sending');
      logHex(`TX [${label}]: ${toHex(pkt)}`);
      await new Promise(r => setTimeout(r, 250));
      setAckBadge('ok');
      return true;
    }

    if (state.transport === 'atom') {
      alert('Atom Lite Wi-Fi bridge mode will be enabled once we flash the M5Stack module.');
      return false;
    }

    if (!state.bleChar) return false;
    state.ackReceived = false;
    setAckBadge('sending');

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await state.bleChar.writeValueWithoutResponse(pkt);
        logHex(`TX [${label} #${attempt}]: ${toHex(pkt)}`);
      } catch (err) {
        logHex(`BLE Write Error: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 550));
      if (state.ackReceived) {
        setAckBadge('ok');
        return true;
      }
    }

    setAckBadge('fail');
    logHex(`⚠ No ACK for ${label}`);
    return false;
  }

  function decodeXor48(bytes) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      out[i] = bytes[i] ^ XOR_KEY[i % XOR_KEY.length];
    }
    return out;
  }

  function parseBleNotification(dataView) {
    let bytes = new Uint8Array(dataView.buffer);
    state.ackReceived = true;
    logHex(`RX (${bytes.length}B): ${toHex(bytes)}`);

    if (bytes.length === 48 && bytes[0] !== 0xaa) {
      bytes = decodeXor48(bytes);
      logHex(`DEC (48B): ${toHex(bytes)}`);
    }

    if (bytes.length >= 17 && bytes[0] === 0xaa) {
      const stateCode = bytes[3];
      const errCode = bytes[4];
      const runMode = bytes[8];
      const targetVal = bytes[9];

      if (BLE_CODE_TO_STATE[stateCode]) {
        state.systemState = BLE_CODE_TO_STATE[stateCode];
      }
      showError(errCode);

      if (targetVal > 0 && targetVal <= 36) {
        if (runMode === 2 && state.ctrlMode !== 'thermo') {
          ctrlController.applyModeUI('thermo', true);
        } else if (runMode === 1 && state.ctrlMode !== 'power') {
          ctrlController.applyModeUI('power', true);
        }
      }

      const voltRaw = bytes[11] > 50 ? bytes[11] / 10 : bytes[12] / 10;
      if (voltRaw > 5 && voltRaw < 35) state.voltage = voltRaw;

      if (bytes[13] !== undefined && bytes[13] < 100) {
        state.cabinTemp = bytes[13];
      }
      const coreTemp = (bytes[15] << 8) | bytes[14];
      if (coreTemp >= 0 && coreTemp < 450) {
        state.coreTemp = coreTemp;
      }

      updateTelemetryUI();
    }
  }

  // ==================== NAVIGATION TABS ====================
  document.querySelectorAll('.nav-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-view').forEach(v => v.classList.add('hidden'));
      tabBtn.classList.add('active');
      $(tabBtn.dataset.tab).classList.remove('hidden');
    });
  });

  // ==================== SETPOINT CONTROLLER FACTORY ====================
  function setupSetpointController({ modePowerId, modeThermoId, minusId, plusId, sliderId, valId, unitId, getMode, setMode, getVal, setVal, onModeChange }) {
    const updateDisplay = (val) => {
      const slider = $(sliderId);
      const clamped = Math.max(Number(slider.min), Math.min(Number(slider.max), val));
      slider.value = clamped;
      setVal(clamped);
      $(valId).textContent = clamped;
      saveSettings();
    };

    const applyModeUI = (newMode, preserveValue = false) => {
      setMode(newMode);
      $(modePowerId).classList.toggle('active', newMode === 'power');
      $(modeThermoId).classList.toggle('active', newMode === 'thermo');
      const slider = $(sliderId);
      if (newMode === 'power') {
        slider.min = 1; slider.max = 10;
        $(unitId).textContent = 'LEVEL';
        updateDisplay(preserveValue ? getVal() : 5);
      } else {
        slider.min = 8; slider.max = 36;
        $(unitId).textContent = 'CELSIUS (°C)';
        updateDisplay(preserveValue ? getVal() : 21);
      }
    };

    $(modePowerId).addEventListener('click', () => {
      applyModeUI('power', false);
      if (onModeChange) onModeChange('power');
    });
    $(modeThermoId).addEventListener('click', () => {
      applyModeUI('thermo', false);
      if (onModeChange) onModeChange('thermo');
    });
    $(sliderId).addEventListener('input', (e) => updateDisplay(Number(e.target.value)));
    $(minusId).addEventListener('click', () => updateDisplay(getVal() - 1));
    $(plusId).addEventListener('click', () => updateDisplay(getVal() + 1));

    applyModeUI(getMode(), true);
    return { applyModeUI, updateDisplay };
  }

  const ctrlController = setupSetpointController({
    modePowerId: 'ctrlModePower',
    modeThermoId: 'ctrlModeThermo',
    minusId: 'ctrlMinus',
    plusId: 'ctrlPlus',
    sliderId: 'ctrlSlider',
    valId: 'ctrlTargetVal',
    unitId: 'ctrlTargetUnit',
    getMode: () => state.ctrlMode,
    setMode: (m) => { state.ctrlMode = m; },
    getVal: () => state.ctrlTarget,
    setVal: (v) => { state.ctrlTarget = v; },
    onModeChange: (m) => {
      sendCommand(0x02, m === 'power' ? 0x01 : 0x02, 0x00, `MODE=${m.toUpperCase()}`);
    }
  });

  setupSetpointController({
    modePowerId: 'schedModePower',
    modeThermoId: 'schedModeThermo',
    minusId: 'schedMinus',
    plusId: 'schedPlus',
    sliderId: 'schedSlider',
    valId: 'schedTargetVal',
    unitId: 'schedTargetUnit',
    getMode: () => state.schedMode,
    setMode: (m) => { state.schedMode = m; },
    getVal: () => state.schedTarget,
    setVal: (v) => { state.schedTarget = v; }
  });

  // ==================== TELEMETRY & CONNECTION ====================
  function updateTelemetryUI() {
    const stateEl = $('valState');
    const stInfo = HEATER_STATES[state.systemState] || HEATER_STATES.OFFLINE;

    stateEl.textContent = stInfo.label;
    stateEl.className = `cycle-val ${stInfo.css}`;

    if (!state.connected) {
      $('valOutput').textContent = '--';
      $('valCabinTemp').textContent = '-- °C';
      $('valCoreTemp').textContent = '-- °C';
      $('valVolt').textContent = '-- V';
      return;
    }

    const isActiveCycle = ['SELF_CHECK', 'PREHEAT', 'IGNITION', 'RUNNING'].includes(state.systemState);
    $('valOutput').textContent = isActiveCycle
      ? (state.ctrlMode === 'power' ? `LVL ${state.ctrlTarget}` : `${state.ctrlTarget} °C`)
      : `READY (${state.ctrlMode === 'power' ? 'LVL ' + state.ctrlTarget : state.ctrlTarget + '°C'})`;

    $('valCabinTemp').textContent = state.cabinTemp !== null ? `${Number(state.cabinTemp).toFixed(1)} °C` : '-- °C';
    $('valCoreTemp').textContent = state.coreTemp !== null ? `${Math.round(state.coreTemp)} °C` : '-- °C';
    $('valVolt').textContent = state.voltage !== null ? `${state.voltage.toFixed(1)} V` : '-- V';
    $('voltTile').classList.toggle('low-volt', state.voltage !== null && state.voltage < 11.8);
  }

  function setConnectedUI(isConn) {
    state.connected = isConn;
    const badge = $('connBadge');
    const mode = state.transport;

    if (isConn) {
      badge.textContent = mode === 'sim' ? 'SIMULATION' : 'CONNECTED';
      badge.className = `badge ${mode === 'sim' ? 'sim' : 'online'}`;
      $('btnConnect').textContent = 'DISCONNECT';
      $('signalText').textContent = mode === 'sim' ? 'Signal: Virtual' : `Signal: ${state.bleDevice?.name || 'Active BLE'}`;
    } else {
      clearCycleTimers();
      clearInterval(state.simLoop);
      clearInterval(state.pollLoop);
      badge.textContent = 'OFFLINE';
      badge.className = 'badge offline';
      $('btnConnect').textContent = 'CONNECT';
      $('signalText').textContent = 'Signal: --';
      setSystemState('OFFLINE');
      setAckBadge('ready');
    }

    ['btnPrime', 'btnPowerOn', 'btnPowerOff', 'ctrlModePower', 'ctrlModeThermo', 'ctrlMinus', 'ctrlPlus', 'ctrlSlider', 'btnApplyTarget', 'btnPoll']
      .forEach(id => $(id).disabled = !isConn);
  }

  function attachDeviceListeners(device) {
    if (device._apxListenersAttached) return;
    device._apxListenersAttached = true;

    device.addEventListener('gattserverdisconnected', () => {
      logHex('BLE disconnected.');
      setConnectedUI(false);
      if (!state.userDisconnected) {
        logHex('Auto-reconnecting in 3s...');
        setTimeout(() => reconnectRealBLE(), 3000);
      }
    });
  }

  async function connectRealBLE() {
    if (!navigator.bluetooth) {
      alert('Web Bluetooth is not supported in this browser. Use Chrome on Android or Bluefy on iOS.');
      return;
    }
    try {
      state.userDisconnected = false;
      logHex('Scanning for Vevor BLE (Service 0xFFE0)...');
      state.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE_SERVICE_UUID] }],
        optionalServices: [BLE_SERVICE_UUID]
      });

      state.savedDeviceId = state.bleDevice.id;
      saveSettings();
      attachDeviceListeners(state.bleDevice);

      await reconnectRealBLE();
    } catch (err) {
      logHex(`BLE Connect aborted: ${err.message}`);
    }
  }

  // Silent Auto-Connect to previously paired heater on app launch / resume
  async function autoConnectSavedBLE() {
    if (state.transport !== 'ble' || state.connected || state.userDisconnected) return;
    if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') return;

    try {
      const devices = await navigator.bluetooth.getDevices();
      if (!devices || devices.length === 0) return;

      const targetDevice = devices.find(d => d.id === state.savedDeviceId) || devices[0];
      if (!targetDevice) return;

      logHex(`Found remembered heater (${targetDevice.name || 'Vevor'}). Auto-connecting...`);
      state.bleDevice = targetDevice;
      state.savedDeviceId = targetDevice.id;
      saveSettings();
      attachDeviceListeners(targetDevice);

      await reconnectRealBLE();
    } catch (err) {
      logHex(`Auto-connect skipped: ${err.message}`);
    }
  }

  async function reconnectRealBLE() {
    if (!state.bleDevice || state.userDisconnected) return;
    try {
      const server = await state.bleDevice.gatt.connect();
      const service = await server.getPrimaryService(BLE_SERVICE_UUID);
      state.bleChar = await service.getCharacteristic(BLE_CHAR_UUID);

      await state.bleChar.startNotifications();
      state.bleChar.addEventListener('characteristicvaluechanged', (e) => parseBleNotification(e.target.value));

      setConnectedUI(true);
      setSystemState('STANDBY');
      logHex(`Connected to ${state.bleDevice.name || 'Vevor Heater'}`);

      await sendCommand(0x01, 0x00, 0x00, 'POLL');
      clearInterval(state.pollLoop);
      state.pollLoop = setInterval(() => {
        if (state.bleChar && state.connected) {
          state.bleChar.writeValueWithoutResponse(buildPacket(0x01, 0x00, 0x00)).catch(() => {});
        }
      }, 5000);
    } catch (err) {
      logHex(`Connect attempt failed: ${err.message}`);
    }
  }

  function startSimulation() {
    state.cabinTemp = 4;
    state.coreTemp = 12;
    state.voltage = 12.6;
    setConnectedUI(true);
    setSystemState('STANDBY');
    logHex(`Simulation active. Restored: ${state.ctrlMode.toUpperCase()} = ${state.ctrlTarget}`);

    state.simLoop = setInterval(() => {
      if (!state.connected) return;
      if (state.systemState === 'RUNNING') {
        state.coreTemp = Math.min(185, state.coreTemp + 4.5);
        state.cabinTemp = Math.min(24, state.cabinTemp + 0.2);
        state.voltage = 12.3;
      } else if (state.systemState === 'PREHEAT' || state.systemState === 'IGNITION') {
        state.coreTemp = Math.min(90, state.coreTemp + 3.0);
        state.voltage = 11.9;
      } else if (state.systemState === 'COOLDOWN') {
        state.coreTemp = Math.max(25, state.coreTemp - 6.0);
        state.voltage = 12.4;
      } else {
        state.coreTemp = Math.max(12, state.coreTemp - 2.0);
        state.cabinTemp = Math.max(4, state.cabinTemp - 0.1);
        state.voltage = 12.6;
      }
      updateTelemetryUI();
    }, 1000);
  }

  $('btnConnect').addEventListener('click', async () => {
    if (state.connected) {
      state.userDisconnected = true;
      if (state.bleDevice && state.bleDevice.gatt.connected) {
        state.bleDevice.gatt.disconnect();
      }
      setConnectedUI(false);
      logHex('Disconnected by user.');
      return;
    }

    if (state.transport === 'ble') {
      await connectRealBLE();
    } else if (state.transport === 'sim') {
      startSimulation();
    } else {
      alert('Atom Lite Wi-Fi mode will be activated once we flash the M5Stack module.');
    }
  });

  $('btnPowerOn').addEventListener('click', async () => {
    clearCycleTimers();
    saveSettings();

    await sendCommand(0x03, 0x01, 0x00, 'START');
    const modeByte = state.ctrlMode === 'power' ? 0x01 : 0x02;
    await sendCommand(0x02, modeByte, 0x00, `MODE=${state.ctrlMode.toUpperCase()}`);
    await sendCommand(0x04, state.ctrlTarget, 0x00, `SET=${state.ctrlTarget}`);

    if (state.transport === 'sim') {
      setSystemState('PREHEAT');
      state.cycleTimers.push(setTimeout(() => setSystemState('IGNITION'), 2500));
      state.cycleTimers.push(setTimeout(() => setSystemState('RUNNING'), 5000));
    }
  });

  $('btnPowerOff').addEventListener('click', async () => {
    clearCycleTimers();
    saveSettings();
    await sendCommand(0x03, 0x00, 0x00, 'STOP');

    if (state.transport === 'sim') {
      setSystemState('COOLDOWN');
      state.cycleTimers.push(setTimeout(() => setSystemState('STANDBY'), 4000));
    }
  });

  $('btnApplyTarget').addEventListener('click', async () => {
    saveSettings();
    await sendCommand(0x04, state.ctrlTarget, 0x00, `SET=${state.ctrlTarget}`);
    updateTelemetryUI();
  });

  $('btnPrime').addEventListener('click', async () => {
    if (confirm('Start manual fuel pump priming (15s)? Only use when fuel line is empty.')) {
      await sendCommand(0x05, 0x01, 0x00, 'PRIME');
    }
  });

  $('btnPoll').addEventListener('click', () => sendCommand(0x01, 0x00, 0x00, 'PING'));

  // ==================== AUTO-SHUTOFF TIMER ====================
  function setShutoffMinutes(mins) {
    clearInterval(state.shutoffInterval);
    document.querySelectorAll('.btn-preset').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.mins) === mins);
    });

    if (mins <= 0) {
      state.shutoffRemainingSec = 0;
      $('timerCountdown').textContent = 'OFF';
      $('timerCountdown').classList.remove('active');
      return;
    }

    state.shutoffRemainingSec = mins * 60;
    $('timerCountdown').classList.add('active');
    logHex(`Auto-shutoff timer set to ${mins} min`);

    const tick = async () => {
      if (state.shutoffRemainingSec <= 0) {
        clearInterval(state.shutoffInterval);
        $('timerCountdown').textContent = 'OFF';
        $('timerCountdown').classList.remove('active');
        document.querySelectorAll('.btn-preset').forEach(b => b.classList.toggle('active', Number(b.dataset.mins) === 0));
        if (state.systemState !== 'STANDBY' && state.systemState !== 'OFFLINE') {
          clearCycleTimers();
          await sendCommand(0x03, 0x00, 0x00, 'AUTO-STOP');
          if (state.transport === 'sim') {
            setSystemState('COOLDOWN');
            state.cycleTimers.push(setTimeout(() => setSystemState('STANDBY'), 4000));
          }
        }
        return;
      }
      const m = Math.floor(state.shutoffRemainingSec / 60);
      const s = String(state.shutoffRemainingSec % 60).padStart(2, '0');
      $('timerCountdown').textContent = `${m}m ${s}s`;
      state.shutoffRemainingSec--;
    };

    tick();
    state.shutoffInterval = setInterval(tick, 1000);
  }

  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => setShutoffMinutes(Number(btn.dataset.mins)));
  });

  // ==================== SCHEDULE & REAL SYNC CONFIRMATION ====================
  function applySavedDurationUI() {
    document.querySelectorAll('.btn-dur').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.dur) === state.schedDuration);
    });
  }

  document.querySelectorAll('.btn-dur').forEach(btn => {
    btn.addEventListener('click', () => {
      state.schedDuration = Number(btn.dataset.dur);
      applySavedDurationUI();
      saveSettings();
    });
  });

  function renderSchedule() {
    const list = $('scheduleList');
    list.innerHTML = '';
    state.schedule.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = `sched-row ${item.enabled ? '' : 'disabled-day'}`;
      row.innerHTML = `
        <span class="day-name">${item.day}</span>
        <label class="switch">
          <input type="checkbox" data-idx="${idx}" class="day-toggle" ${item.enabled ? 'checked' : ''} />
          <span class="slider-round"></span>
        </label>
        <input type="time" data-idx="${idx}" class="day-time" value="${item.time}" ${item.enabled ? '' : 'disabled'} />
      `;
      list.appendChild(row);
    });

    list.querySelectorAll('.day-toggle').forEach(el => {
      el.addEventListener('change', (e) => {
        state.schedule[Number(e.target.dataset.idx)].enabled = e.target.checked;
        saveSettings();
        renderSchedule();
      });
    });

    list.querySelectorAll('.day-time').forEach(el => {
      el.addEventListener('change', (e) => {
        state.schedule[Number(e.target.dataset.idx)].time = e.target.value;
        saveSettings();
      });
    });
  }

  $('masterScheduleToggle').checked = state.schedMasterEnabled;
  $('masterScheduleToggle').addEventListener('change', (e) => {
    state.schedMasterEnabled = e.target.checked;
    saveSettings();
  });

  $('transportSelect').value = state.transport;
  $('transportSelect').addEventListener('change', (e) => {
    state.transport = e.target.value;
    saveSettings();
  });

  $('protoSelect').value = state.protocol;
  $('protoSelect').addEventListener('change', (e) => {
    state.protocol = e.target.value;
    saveSettings();
  });

  $('pinInput').value = state.pin;
  $('pinInput').addEventListener('change', (e) => {
    state.pin = e.target.value;
    saveSettings();
  });

  $('btnSyncSchedule').addEventListener('click', async () => {
    saveSettings();
    const statusEl = $('schedSyncStatus');
    const activeDays = state.schedule
      .filter(d => d.enabled)
      .map(d => `${d.day}@${d.time}`)
      .join(', ');
    const targetDesc = state.schedMode === 'power' ? `LVL ${state.schedTarget}` : `${state.schedTarget}°C`;

    if (!state.connected) {
      statusEl.textContent = 'SAVED ON PHONE (Connect to sync with heater)';
      statusEl.className = 'sync-status warn';
      logHex(`Schedule saved locally: [${activeDays || 'NONE'}] | ${targetDesc} | Stop=${state.schedDuration}m`);
      return;
    }

    statusEl.textContent = 'SENDING TO HEATER...';
    statusEl.className = 'sync-status';

    const confirmed = await sendCommand(0x01, 0x00, 0x00, 'SYNC-SCHEDULE');
    if (confirmed) {
      statusEl.textContent = 'SENT & CONFIRMED BY HEATER ✓';
      statusEl.className = 'sync-status ok';
      logHex(`Schedule synced & ACKed: [${activeDays || 'NONE'}] | ${targetDesc} | Stop=${state.schedDuration}m`);
    } else {
      statusEl.textContent = 'SYNC FAILED — NO RESPONSE FROM HEATER';
      statusEl.className = 'sync-status warn';
    }
  });

  $('btnClearLog').addEventListener('click', () => {
    $('hexLog').textContent = '';
  });

  // Auto-update check & silent BLE reconnect on open / app resume
  if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });

    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update();
          autoConnectSavedBLE();
        }
      });
    }).catch(() => {});
  }

  // Init
  applySavedDurationUI();
  renderSchedule();
  updateTelemetryUI();
  autoConnectSavedBLE();
})();
