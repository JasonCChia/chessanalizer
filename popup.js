// popup.js

const toggleEnabled = document.getElementById('toggleEnabled');
const depthSlider   = document.getElementById('depthSlider');
const depthVal      = document.getElementById('depthVal');
const statusDot     = document.getElementById('statusDot');
const statusText    = document.getElementById('statusText');
const playingSideButtons = [...document.querySelectorAll('[data-playing-side-mode]')];
const turnButtons   = [...document.querySelectorAll('[data-turn-mode]')];

// Load saved settings
chrome.storage.sync.get(['enabled', 'depth', 'playingSideMode', 'turnMode'], (s) => {
  const en = s.enabled !== undefined ? s.enabled : true;
  const dp = s.depth || 16;
  const ps = isValidSideMode(s.playingSideMode) ? s.playingSideMode : 'auto';
  const tm = isValidTurnMode(s.turnMode) ? s.turnMode : 'auto';
  toggleEnabled.checked = en;
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

// Depth slider
depthSlider.addEventListener('input', () => {
  const val = parseInt(depthSlider.value);
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
    if (msg.analyzing) {
      statusDot.className = 'status-dot analyzing';
      statusText.textContent = 'Analyzing position…';
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

function isValidTurnMode(value) {
  return value === 'auto' || value === 'w' || value === 'b';
}

function isValidSideMode(value) {
  return value === 'auto' || value === 'w' || value === 'b';
}

// Check on open
sendToContent({ type: 'GET_STATUS' });
