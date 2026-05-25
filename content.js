// content.js — injected into chess.com pages
// Reads board → builds FEN → calls Stockfish → renders overlay

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const PIECE_MAP = {
    wp: 'P', wr: 'R', wn: 'N', wb: 'B', wq: 'Q', wk: 'K',
    bp: 'p', br: 'r', bn: 'n', bb: 'b', bq: 'q', bk: 'k'
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let lastFen = '';
  let overlayEl = null;
  let arrowLayerEl = null;
  let currentArrowMove = null;
  let arrowRedrawFrame = 0;
  let analyzing = false;
  let enabled = true;
  let currentDepth = 16;
  let playingSideMode = 'auto';
  let turnMode = 'auto';
  let engineReady = false;
  let engineError = '';
  let engineRequestId = 0;
  let activeAnalysisId = 0;
  const engineRequests = new Map();

  // ── Boot ───────────────────────────────────────────────────────────────────
  window.addEventListener('message', handleEngineBridgeMessage);
  injectEngine();
  createOverlay();
  startWatcher();
  window.addEventListener('resize', scheduleArrowRedraw, { passive: true });
  document.addEventListener('scroll', scheduleArrowRedraw, { capture: true, passive: true });

  // Load saved settings
  chrome.storage.sync.get(['enabled', 'depth', 'playingSideMode', 'turnMode'], (s) => {
    if (s.enabled !== undefined) enabled = s.enabled;
    if (s.depth)   currentDepth = s.depth;
    if (isValidSideMode(s.playingSideMode)) playingSideMode = s.playingSideMode;
    if (isValidTurnMode(s.turnMode)) turnMode = s.turnMode;
    updateOverlayVisibility();
    if (!enabled) clearBestMoveArrow();
    if (enabled) onBoardChange();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SET_ENABLED') {
      enabled = msg.value;
      updateOverlayVisibility();
      if (!enabled) clearBestMoveArrow();
      if (enabled) {
        lastFen = '';
        onBoardChange();
      }
    }
    if (msg.type === 'SET_DEPTH')   { currentDepth = msg.value; lastFen = ''; }
    if (msg.type === 'SET_PLAYING_SIDE_MODE') {
      playingSideMode = isValidSideMode(msg.value) ? msg.value : 'auto';
      lastFen = '';
      sendStatus();
    }
    if (msg.type === 'SET_TURN_MODE') {
      turnMode = isValidTurnMode(msg.value) ? msg.value : 'auto';
      lastFen = '';
      sendStatus();
    }
    if (msg.type === 'GET_STATUS')  sendStatus();
  });

  // ── Engine Injection ───────────────────────────────────────────────────────
  function injectEngine() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('engine.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Board Watcher ──────────────────────────────────────────────────────────
  function startWatcher() {
    const observer = new MutationObserver(debounce(onBoardChange, 300));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    // Also poll as fallback
    setInterval(onBoardChange, 1500);
  }

  function onBoardChange() {
    if (!enabled) {
      clearBestMoveArrow();
      return;
    }
    const board = getBoard();
    if (!board) {
      clearBestMoveArrow();
      return;
    }
    const fen = buildFEN(board);
    sendStatus(board);
    if (!fen) {
      clearBestMoveArrow();
      return;
    }
    if (fen === lastFen) {
      scheduleArrowRedraw();
      return;
    }
    lastFen = fen;
    runAnalysis(fen);
  }

  // ── Board Reading ──────────────────────────────────────────────────────────
  function getBoard() {
    return (
      document.querySelector('wc-chess-board') ||
      document.querySelector('chess-board') ||
      document.querySelector('.board')
    );
  }

  function isFlipped(board) {
    return board.classList.contains('flipped');
  }

  function buildFEN(board) {
    const pieces = board.querySelectorAll('.piece');
    if (!pieces.length) return null;

    // 8x8 grid  grid[rank0=8][file0=a]
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));

    for (const p of pieces) {
      const cls = [...p.classList];
      const squareCls = cls.find(c => /^square-\d{2}$/.test(c));
      const pieceCls  = cls.find(c => PIECE_MAP[c]);
      if (!squareCls || !pieceCls) continue;

      const sq = squareCls.replace('square-', '');
      let fileIdx = parseInt(sq[0]) - 1; // 1-8 → 0-7
      let rankIdx = parseInt(sq[1]) - 1; // 1-8 → 0-7

      // chess.com square encoding: file=col (1=a,8=h), rank=row (1=rank1,8=rank8)
      // When flipped, the visual is mirrored but square codes stay absolute
      const rank = rankIdx;      // 0 = rank 1
      const file = fileIdx;      // 0 = a-file

      if (rank < 0 || rank > 7 || file < 0 || file > 7) continue;
      grid[rank][file] = PIECE_MAP[pieceCls];
    }

    // Detect whose turn it is, unless the popup overrides it.
    const turn = resolveTurn(board);

    // Build FEN ranks (rank 8 first)
    const ranks = [];
    for (let r = 7; r >= 0; r--) {
      let str = '';
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const piece = grid[r][f];
        if (piece) {
          if (empty) { str += empty; empty = 0; }
          str += piece;
        } else {
          empty++;
        }
      }
      if (empty) str += empty;
      ranks.push(str);
    }

    return ranks.join('/') + ` ${turn} KQkq - 0 1`;
  }

  function detectTurn(board) {
    const highlightedTurn = detectTurnFromHighlights(board);
    if (highlightedTurn) return highlightedTurn;

    const moveListTurn = detectTurnFromMoveList();
    if (moveListTurn) return moveListTurn;

    const clockTurn = detectTurnFromClock(board);
    if (clockTurn) return clockTurn;

    return 'w';

      // If it's black's notation row, white just moved → black's turn
  }

  // ── Analysis ───────────────────────────────────────────────────────────────
  // Side detection
  function detectPlayingSide(board) {
    return isFlipped(board) ? 'b' : 'w';
  }

  function resolvePlayingSide(board) {
    if (isValidSide(playingSideMode)) return playingSideMode;
    return detectPlayingSide(board);
  }

  function resolveTurn(board) {
    if (isValidSide(turnMode)) return turnMode;
    return detectTurn(board);
  }

  function detectTurnFromHighlights(board) {
    const highlightedSquares = getLastMoveHighlightSquares(board);
    if (highlightedSquares.size < 2) return null;

    const lastMovedColors = new Set();
    for (const piece of board.querySelectorAll('.piece')) {
      const square = getSquareCode(piece);
      if (!square || !highlightedSquares.has(square)) continue;

      const color = getPieceColor(piece);
      if (color) lastMovedColors.add(color);
    }

    if (lastMovedColors.size !== 1) return null;
    return oppositeSide([...lastMovedColors][0]);
  }

  function getLastMoveHighlightSquares(board) {
    const highlights = [...board.querySelectorAll('.highlight')];
    const preferred = highlights.filter(isLikelyLastMoveHighlight);
    const selected = preferred.length >= 2 ? preferred : highlights;
    return new Set(selected.map(getSquareCode).filter(Boolean));
  }

  function isLikelyLastMoveHighlight(el) {
    const inlineColor = (el.style && el.style.backgroundColor) || '';
    const color = inlineColor || window.getComputedStyle(el).backgroundColor || '';
    return !color || /rgba?\(\s*255\s*,\s*255\s*,\s*51/i.test(color);
  }

  function detectTurnFromMoveList() {
    const lastMove = document.querySelector('.move.selected, .node.selected');
    if (lastMove) {
      const ply = Number(lastMove.dataset.ply);
      if (Number.isFinite(ply) && ply > 0) return ply % 2 === 0 ? 'w' : 'b';

      if (lastMove.closest('.black') || lastMove.classList.contains('black')) return 'w';
      if (lastMove.closest('.white') || lastMove.classList.contains('white')) return 'b';
    }

    return null;
  }

  function detectTurnFromClock(board) {
    const playingSide = resolvePlayingSide(board);
    const bottomClock = findActiveClock([
      '.clock-bottom',
      '.player-component-clock-bottom',
      '[class*="clock-bottom"]'
    ]);
    if (bottomClock) return playingSide;

    const topClock = findActiveClock([
      '.clock-top',
      '.player-component-clock-top',
      '[class*="clock-top"]'
    ]);
    if (topClock) return oppositeSide(playingSide);

    return null;
  }

  function findActiveClock(selectors) {
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (isActiveClock(el)) return el;
      }
    }
    return null;
  }

  function isActiveClock(el) {
    if (!el) return false;
    if (el.classList.contains('clock-player-turn')) return true;
    if (el.classList.contains('clock-active')) return true;
    return Boolean(el.querySelector('.clock-player-turn, .clock-active'));
  }

  function getSquareCode(el) {
    const cls = [...el.classList].find(c => /^square-\d{2}$/.test(c));
    return cls ? cls.replace('square-', '') : null;
  }

  function getPieceColor(piece) {
    const cls = [...piece.classList].find(c => PIECE_MAP[c]);
    return cls ? cls[0] : null;
  }

  function oppositeSide(side) {
    return side === 'w' ? 'b' : 'w';
  }

  // Analysis
  async function runAnalysis(fen) {
    const analysisId = ++activeAnalysisId;
    if (analyzing) stopEngine();
    analyzing = true;
    showLoading();

    try {
      await waitForEngine(8000);
      const result = await analyzeWithEngine(fen, currentDepth);
      if (analysisId !== activeAnalysisId) return;
      showResult(result, fen);
    } catch (e) {
      if (analysisId !== activeAnalysisId) return;
      if (e && e.message) {
        showError(e.message);
        return;
      }
      showError('Engine error — reload page');
    } finally {
      if (analysisId === activeAnalysisId) analyzing = false;
    }
  }

  // ── Parse Engine Output ────────────────────────────────────────────────────
  function handleEngineBridgeMessage(event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chess-analyzer-engine') return;

    if (msg.type === 'ENGINE_READY') {
      engineReady = true;
      engineError = '';
      return;
    }

    if (msg.type === 'ENGINE_ERROR') {
      engineError = msg.error || 'engine failed to load';
      console.error('[Chess Analyzer] Engine error:', engineError);
      for (const pending of engineRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(engineError));
      }
      engineRequests.clear();
      return;
    }

    const pending = engineRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    engineRequests.delete(msg.requestId);

    if (msg.type === 'ANALYSIS_RESULT') {
      pending.resolve(msg.result);
    } else if (msg.type === 'ANALYSIS_ERROR') {
      pending.reject(new Error(msg.error || 'analysis failed'));
    }
  }

  function analyzeWithEngine(fen, depth) {
    const requestId = ++engineRequestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        engineRequests.delete(requestId);
        reject(new Error('analysis timeout'));
      }, 30000);

      engineRequests.set(requestId, { resolve, reject, timeout });
      window.postMessage({
        source: 'chess-analyzer-content',
        type: 'ANALYZE',
        requestId,
        fen,
        depth
      }, window.location.origin);
    });
  }

  function stopEngine() {
    window.postMessage({
      source: 'chess-analyzer-content',
      type: 'STOP'
    }, window.location.origin);
  }

  function waitForEngine(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (engineReady) return resolve();
        if (engineError) return reject(new Error(engineError));
        if (Date.now() - start > timeout) return reject(new Error('engine load timeout'));
        setTimeout(check, 200);
      };
      check();
    });
  }

  function isValidTurnMode(value) {
    return value === 'auto' || value === 'w' || value === 'b';
  }

  function isValidSideMode(value) {
    return value === 'auto' || isValidSide(value);
  }

  function isValidSide(value) {
    return value === 'w' || value === 'b';
  }

  function sendStatus(board = getBoard()) {
    const sideState = board ? {
      playingSideMode,
      detectedPlayingSide: detectPlayingSide(board),
      effectivePlayingSide: resolvePlayingSide(board),
      turnMode,
      detectedTurn: detectTurn(board),
      effectiveTurn: resolveTurn(board)
    } : {
      playingSideMode,
      detectedPlayingSide: null,
      effectivePlayingSide: null,
      turnMode,
      detectedTurn: null,
      effectiveTurn: null
    };

    safeRuntimeSend({
      type: 'STATUS',
      analyzing,
      engineReady,
      engineError,
      ...sideState
    });
  }

  function safeRuntimeSend(message) {
    try {
      chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function parseInfo(info) {
    const scoreMatch = info.match(/score (cp|mate) (-?\d+)/);
    const pvMatch    = info.match(/pv (.+)/);
    const depthMatch = info.match(/depth (\d+)/);

    let score = '?';
    if (scoreMatch) {
      if (scoreMatch[1] === 'cp') {
        const cp = parseInt(scoreMatch[2]);
        score = (cp / 100).toFixed(2);
        if (cp > 0) score = '+' + score;
      } else {
        const mate = parseInt(scoreMatch[2]);
        score = mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
      }
    }

    const moves = pvMatch ? pvMatch[1].trim().split(' ').slice(0, 5) : [];
    const depth = depthMatch ? depthMatch[1] : '?';
    return { score, moves, depth };
  }

  function uciToSan(move) {
    if (!move || move === '(none)') return '—';
    const match = String(move).match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
    if (!match) return String(move);

    const from = match[1].toLowerCase();
    const to = match[2].toLowerCase();
    const promo = match[3] ? '=' + match[3].toUpperCase() : '';
    return `${from}->${to}${promo}`;
  }

  /*
    return `${f1}${r1}→${f2}${r2}${promo}`;
  }

  */

  function scoreColor(score) {
    if (score.startsWith('M'))  return '#00ff88';
    if (score.startsWith('-M')) return '#ff4466';
    const n = parseFloat(score);
    if (isNaN(n)) return '#aaa';
    if (n > 1.5)  return '#00ff88';
    if (n > 0.3)  return '#88ffaa';
    if (n < -1.5) return '#ff4466';
    if (n < -0.3) return '#ff8899';
    return '#ffe066';
  }

  // ── Overlay UI ─────────────────────────────────────────────────────────────
  function createOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'chess-analyzer-overlay';
    overlayEl.innerHTML = `
      <div class="ca-header">
        <span class="ca-logo">♟ Analyzer</span>
        <button class="ca-close" title="Hide">✕</button>
      </div>
      <div class="ca-body">
        <div class="ca-status">Waiting for position…</div>
      </div>
    `;
    document.body.appendChild(overlayEl);

    overlayEl.querySelector('.ca-close').addEventListener('click', () => {
      overlayEl.classList.add('ca-hidden');
    });

    // Drag support
    makeDraggable(overlayEl);
    updateOverlayVisibility();
  }

  function updateOverlayVisibility() {
    if (!overlayEl) return;
    overlayEl.classList.toggle('ca-hidden', !enabled);
  }

  function showLoading() {
    if (!overlayEl) return;
    clearBestMoveArrow();
    overlayEl.querySelector('.ca-body').innerHTML = `
      <div class="ca-status ca-pulse">Analyzing<span class="ca-dots"></span></div>
    `;
  }

  function showResult(result, fen) {
    if (!overlayEl) return;
    const { bestMove, info } = result;
    const { score, moves, depth } = parseInfo(info);
    const sc = scoreColor(score);
    drawBestMoveArrow(bestMove || moves[0]);

    const movesHTML = moves.slice(0, 5).map((m, i) => `
      <span class="ca-move ${i === 0 ? 'ca-best' : ''}">${uciToSan(m)}</span>
    `).join('');

    overlayEl.querySelector('.ca-body').innerHTML = `
      <div class="ca-score-row">
        <div class="ca-eval" style="color:${sc}">${score}</div>
        <div class="ca-depth">depth ${depth}</div>
      </div>
      <div class="ca-label">Best move</div>
      <div class="ca-best-move">${uciToSan(bestMove)}</div>
      <div class="ca-label">Top line</div>
      <div class="ca-moves">${movesHTML || '—'}</div>
      <div class="ca-fen" title="${fen}">${fen.split(' ')[0].substring(0, 36)}…</div>
    `;
  }

  function showError(msg) {
    if (!overlayEl) return;
    clearBestMoveArrow();
    const body = overlayEl.querySelector('.ca-body');
    body.innerHTML = '<div class="ca-status ca-error"></div>';
    body.querySelector('.ca-error').textContent = msg;
    return;
    overlayEl.querySelector('.ca-body').innerHTML = `
      <div class="ca-status ca-error">⚠ ${msg}</div>
    `;
  }

  // Board arrow
  function drawBestMoveArrow(move) {
    const normalized = normalizeUciMove(move);
    if (!normalized) {
      clearBestMoveArrow();
      return;
    }

    currentArrowMove = normalized;
    renderBestMoveArrow(normalized);
  }

  function scheduleArrowRedraw() {
    if (!currentArrowMove || arrowRedrawFrame) return;
    arrowRedrawFrame = requestAnimationFrame(() => {
      arrowRedrawFrame = 0;
      if (currentArrowMove) renderBestMoveArrow(currentArrowMove);
    });
  }

  function renderBestMoveArrow(move) {
    const board = getBoard();
    if (!board) {
      clearBestMoveArrow();
      return;
    }

    const rect = board.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      clearBestMoveArrow();
      return;
    }

    const from = squareToBoardPoint(move.slice(0, 2), board, rect);
    const to = squareToBoardPoint(move.slice(2, 4), board, rect);
    if (!from || !to) {
      clearBestMoveArrow();
      return;
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (!length) {
      clearBestMoveArrow();
      return;
    }

    ensureArrowLayer();
    arrowLayerEl.style.left = `${rect.left}px`;
    arrowLayerEl.style.top = `${rect.top}px`;
    arrowLayerEl.style.width = `${rect.width}px`;
    arrowLayerEl.style.height = `${rect.height}px`;
    arrowLayerEl.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

    const boardSize = Math.min(rect.width, rect.height);
    const squareSize = boardSize / 8;
    const strokeWidth = clamp(boardSize * 0.018, 6, 14);
    const targetRadius = clamp(squareSize * 0.24, 12, 24);
    const tailRadius = clamp(squareSize * 0.1, 5, 10);
    const tailPad = clamp(squareSize * 0.2, 10, 22);
    const ux = dx / length;
    const uy = dy / length;
    const x1 = from.x + ux * tailPad;
    const y1 = from.y + uy * tailPad;

    arrowLayerEl.innerHTML = `
      <defs>
        <marker id="ca-arrow-head" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L7,3.5 L0,7 Z" fill="#7ee787"></path>
        </marker>
      </defs>
      <circle class="ca-arrow-target" cx="${to.x}" cy="${to.y}" r="${targetRadius}"></circle>
      <circle class="ca-arrow-tail" cx="${from.x}" cy="${from.y}" r="${tailRadius}"></circle>
      <line class="ca-arrow-line" x1="${x1}" y1="${y1}" x2="${to.x}" y2="${to.y}" stroke-width="${strokeWidth}" marker-end="url(#ca-arrow-head)"></line>
    `;
    arrowLayerEl.classList.remove('ca-hidden');
  }

  function ensureArrowLayer() {
    if (arrowLayerEl) return;
    arrowLayerEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowLayerEl.id = 'chess-analyzer-arrow-layer';
    arrowLayerEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(arrowLayerEl);
  }

  function clearBestMoveArrow() {
    currentArrowMove = null;
    if (arrowRedrawFrame) {
      cancelAnimationFrame(arrowRedrawFrame);
      arrowRedrawFrame = 0;
    }
    if (arrowLayerEl) {
      arrowLayerEl.innerHTML = '';
      arrowLayerEl.classList.add('ca-hidden');
    }
  }

  function normalizeUciMove(move) {
    const match = String(move || '').match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
    return match ? `${match[1]}${match[2]}${match[3] || ''}`.toLowerCase() : null;
  }

  function squareToBoardPoint(square, board, rect) {
    const match = String(square || '').match(/^([a-h])([1-8])$/i);
    if (!match) return null;

    const file = match[1].toLowerCase().charCodeAt(0) - 97;
    const rank = Number(match[2]) - 1;
    const flipped = isFlipped(board);
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;

    return {
      x: (col + 0.5) * (rect.width / 8),
      y: (row + 0.5) * (rect.height / 8)
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Draggable
  function makeDraggable(el) {
    let ox = 0, oy = 0, dragging = false;
    const header = el.querySelector('.ca-header');
    header.addEventListener('mousedown', (e) => {
      dragging = true;
      ox = e.clientX - el.offsetLeft;
      oy = e.clientY - el.offsetTop;
      el.style.transition = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - ox) + 'px';
      el.style.top  = (e.clientY - oy) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function waitFor(fn, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const val = fn();
        if (val) return resolve(val);
        if (Date.now() - start > timeout) return reject(new Error('timeout'));
        setTimeout(check, 200);
      };
      check();
    });
  }

})();
