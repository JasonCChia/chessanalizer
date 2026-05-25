// popup.js

const DEFAULT_VISUAL_TOGGLE_HOTKEY = 'Alt+S';

const toggleEnabled = document.getElementById('toggleEnabled');
const toggleSuggestions = document.getElementById('toggleSuggestions');
const toggleArrows = document.getElementById('toggleArrows');
const visualHotkeyInput = document.getElementById('visualHotkeyInput');
const resetHotkey = document.getElementById('resetHotkey');
const depthSlider = document.getElementById('depthSlider');
const depthVal = document.getElementById('depthVal');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const playingSideButtons = [...document.querySelectorAll('[data-playing-side-mode]')];
const turnButtons = [...document.querySelectorAll('[data-turn-mode]')];

let visualToggleHotkey = DEFAULT_VISUAL_TOGGLE_HOTKEY;
let hotkeyMessageTimer = 0;

// Load saved settings
chrome.storage.sync.get([
  'enabled',
  'suggestionsEnabled',
  'arrowsEnabled',
  'visualToggleHotkey',
  'depth',
  'playingSideMode',
  'turnMode'
], (s) => {
  const en = s.enabled !== undefined ? s.enabled : true;
  const suggestions = s.suggestionsEnabled !== undefined ? s.suggestionsEnabled : true;
  const arrows = s.arrowsEnabled !== undefined ? s.arrowsEnabled : true;
  const dp = s.depth || 16;
  const ps = isValidSideMode(s.playingSideMode) ? s.playingSideMode : 'auto';
  const tm = isValidTurnMode(s.turnMode) ? s.turnMode : 'auto';
  const hotkey = isValidHotkey(s.visualToggleHotkey) ? s.visualToggleHotkey : DEFAULT_VISUAL_TOGGLE_HOTKEY;

  toggleEnabled.checked = en;
  toggleSuggestions.checked = suggestions;
  toggleArrows.checked = arrows;
  setVisualHotkeyUI(hotkey);
  depthSlider.value = dp;
  depthVal.textContent = dp;
  setPlayingSideUI(ps);
  setTurnModeUI(tm);
});

// Toggle analysis
toggleEnabled.addEventListener('change', () => {
  const val = toggleEnabled.checked;
  chrome.storage.sync.set({ enabled: val });
  sendToContent({ type: 'SET_ENABLED', value: val });
});

toggleSuggestions.addEventListener('change', () => {
  const val = toggleSuggestions.checked;
  chrome.storage.sync.set({ suggestionsEnabled: val });
  sendToContent({ type: 'SET_SUGGESTIONS_ENABLED', value: val });
});

toggleArrows.addEventListener('change', () => {
  const val = toggleArrows.checked;
  chrome.storage.sync.set({ arrowsEnabled: val });
  sendToContent({ type: 'SET_ARROWS_ENABLED', value: val });
});

visualHotkeyInput.addEventListener('focus', startHotkeyCapture);
visualHotkeyInput.addEventListener('click', startHotkeyCapture);
visualHotkeyInput.addEventListener('blur', stopHotkeyCapture);
visualHotkeyInput.addEventListener('keydown', (event) => {
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    visualHotkeyInput.blur();
    return;
  }

  const hotkey = eventToHotkey(event);
  if (!hotkey) return;

  if (isReservedHotkey(hotkey)) {
    showTemporaryHotkeyMessage('Insert reserved');
    return;
  }

  saveVisualHotkey(hotkey);
  visualHotkeyInput.blur();
});

resetHotkey.addEventListener('click', () => {
  saveVisualHotkey(DEFAULT_VISUAL_TOGGLE_HOTKEY);
});

// Depth slider
depthSlider.addEventListener('input', () => {
  const val = parseInt(depthSlider.value, 10);
  depthVal.textContent = val;
  chrome.storage.sync.set({ depth: val });
  sendToContent({ type: 'SET_DEPTH', value: val });
});

playingSideButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.playingSideMode;
    if (!isValidSideMode(mode)) return;
    setPlayingSideUI(mode);
    chrome.storage.sync.set({ playingSideMode: mode });
    sendToContent({ type: 'SET_PLAYING_SIDE_MODE', value: mode });
  });
});

turnButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.turnMode;
    if (!isValidTurnMode(mode)) return;
    setTurnModeUI(mode);
    chrome.storage.sync.set({ turnMode: mode });
    sendToContent({ type: 'SET_TURN_MODE', value: mode });
  });
});

// Ping content script for status
function checkStatus() {
  sendToContent({ type: 'GET_STATUS' });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS') {
    if (typeof msg.enabled === 'boolean') {
      toggleEnabled.checked = msg.enabled;
    }
    if (typeof msg.suggestionsEnabled === 'boolean') {
      toggleSuggestions.checked = msg.suggestionsEnabled;
    }
    if (typeof msg.arrowsEnabled === 'boolean') {
      toggleArrows.checked = msg.arrowsEnabled;
    }
    if (isValidHotkey(msg.visualToggleHotkey) && !visualHotkeyInput.classList.contains('capturing')) {
      setVisualHotkeyUI(msg.visualToggleHotkey);
    }

    if (msg.analyzing) {
      statusDot.className = 'status-dot analyzing';
      statusText.textContent = 'Analyzing position...';
    } else if (msg.engineError) {
      statusDot.className = 'status-dot';
      statusText.textContent = msg.engineError;
    } else if (!msg.engineReady) {
      statusDot.className = 'status-dot analyzing';
      statusText.textContent = withSideStatus('Engine loading', msg);
    } else {
      statusDot.className = 'status-dot active';
      statusText.textContent = withSideStatus('Engine ready', msg);
    }
  }
});

async function sendToContent(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('chess.com')) {
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Connected to chess.com';
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Open chess.com to begin';
  }
}

function startHotkeyCapture() {
  clearTimeout(hotkeyMessageTimer);
  visualHotkeyInput.classList.add('capturing');
  visualHotkeyInput.value = 'Press shortcut';
}

function stopHotkeyCapture() {
  clearTimeout(hotkeyMessageTimer);
  visualHotkeyInput.classList.remove('capturing');
  visualHotkeyInput.value = visualToggleHotkey;
}

function saveVisualHotkey(hotkey) {
  if (!isValidHotkey(hotkey)) return;
  setVisualHotkeyUI(hotkey);
  chrome.storage.sync.set({ visualToggleHotkey: hotkey });
  sendToContent({ type: 'SET_VISUAL_TOGGLE_HOTKEY', value: hotkey });
}

function setVisualHotkeyUI(hotkey) {
  visualToggleHotkey = hotkey;
  visualHotkeyInput.value = hotkey;
}

function showTemporaryHotkeyMessage(message) {
  clearTimeout(hotkeyMessageTimer);
  visualHotkeyInput.value = message;
  hotkeyMessageTimer = setTimeout(() => {
    if (visualHotkeyInput.classList.contains('capturing')) {
      visualHotkeyInput.value = 'Press shortcut';
    } else {
      visualHotkeyInput.value = visualToggleHotkey;
    }
  }, 900);
}

function setTurnModeUI(mode) {
  turnButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.turnMode === mode);
  });
}

function setPlayingSideUI(mode) {
  playingSideButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.playingSideMode === mode);
  });
}

function withSideStatus(base, msg) {
  const move = labelSide(msg.effectiveTurn || msg.detectedTurn);
  const playing = labelSide(msg.effectivePlayingSide || msg.detectedPlayingSide);
  if (!move && !playing) return base;
  if (!playing) return `${base} - ${move} to move`;
  if (!move) return `${base} - playing ${playing}`;
  return `${base} - ${move} to move / ${playing} side`;
}

function labelSide(side) {
  if (side === 'w') return 'White';
  if (side === 'b') return 'Black';
  return '';
}

function eventToHotkey(event) {
  const key = normalizeKey(event.key);
  if (!key || isModifierKey(key)) return '';

  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
}

function normalizeKey(key) {
  if (!key) return '';
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key === 'Del') return 'Delete';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function isModifierKey(key) {
  return key === 'Control' || key === 'Ctrl' || key === 'Alt' || key === 'Shift' || key === 'Meta';
}

function isValidHotkey(value) {
  return typeof value === 'string' && value.trim().length > 0 && !isReservedHotkey(value);
}

function isReservedHotkey(value) {
  return value === 'Insert';
}

function isValidTurnMode(value) {
  return value === 'auto' || value === 'w' || value === 'b';
}

function isValidSideMode(value) {
  return value === 'auto' || value === 'w' || value === 'b';
}

// Check on open
sendToContent({ type: 'GET_STATUS' });
