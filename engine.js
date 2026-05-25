// engine.js — Stockfish bridge (loaded as a classic script in content context)
// We load the plain JS Stockfish build because chess.com pages are not
// cross-origin isolated, so the WASM build cannot use SharedArrayBuffer here.

(function () {
  if (window.__chessEngineReady) return;
  window.__chessEngineReady = true;

  // ---------------------------------------------------------------------------
  // Load Stockfish via CDN script tag.
  // ---------------------------------------------------------------------------
  const STOCKFISH_JS_URL   = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.min.js';

  let engine = null;
  let resolveReady = null;
  const engineReady = new Promise(r => (resolveReady = r));

  function debug(...args) {
    console.debug('[Chess Analyzer]', ...args);
  }

  function initEngine(src) {
    return new Promise((resolve, reject) => {
      try {
        const workerCode = `importScripts(${JSON.stringify(src)});`;
        const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
        const worker = new Worker(workerUrl);
        worker.addEventListener('error', (event) => {
          reject(new Error(event.message || 'Stockfish worker failed'));
        }, { once: true });
        worker.addEventListener('message', () => {
          URL.revokeObjectURL(workerUrl);
          resolve(worker);
        }, { once: true });
        worker.postMessage('uci');
      } catch (e) {
        reject(e);
      }
    });
  }

  async function bootEngine() {
    debug('Trying Stockfish JS');
    engine = await initEngine(STOCKFISH_JS_URL);
    attachEngineListener(engine, handleEngineMsg);
    engine.postMessage('isready');
  }

  function attachEngineListener(instance, listener) {
    if (!instance) throw new Error('Stockfish did not initialize');
    if (typeof instance.addMessageListener === 'function') {
      instance.addMessageListener(listener);
      return;
    }
    if ('onmessage' in instance || typeof instance.postMessage === 'function') {
      instance.onmessage = (event) => listener(event && event.data !== undefined ? event.data : event);
      return;
    }
    throw new Error('Stockfish loaded but has no message listener API');
  }

  function handleEngineMsg(msg) {
    msg = msg && msg.data !== undefined ? msg.data : msg;
    if (msg === 'readyok') resolveReady();
    window.dispatchEvent(new CustomEvent('__sf_msg', { detail: msg }));
  }

  function postBridge(payload) {
    window.postMessage({
      source: 'chess-analyzer-engine',
      ...payload
    }, window.location.origin);
  }

  // ---------------------------------------------------------------------------
  // Public API on window so content.js can call it
  // ---------------------------------------------------------------------------
  window.__chessEngine = {
    ready: engineReady,

    analyze(fen, depth = 16) {
      return new Promise(async (resolve) => {
        await engineReady;
        const lines = [];
        let settled = false;

        function onMsg(e) {
          const msg = e.detail;
          if (msg.startsWith('info') && msg.includes('score') && msg.includes('pv')) {
            lines.push(msg);
          }
          if (msg.startsWith('bestmove')) {
            if (settled) return;
            settled = true;
            window.removeEventListener('__sf_msg', onMsg);
            const best = msg.split(' ')[1];
            const last = lines[lines.length - 1] || '';
            resolve({ bestMove: best, info: last, raw: lines });
          }
        }

        window.addEventListener('__sf_msg', onMsg);
        engine.postMessage('position fen ' + fen);
        engine.postMessage('go depth ' + depth);
      });
    },

    stop() {
      if (engine) engine.postMessage('stop');
    }
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chess-analyzer-content') return;

    if (msg.type === 'STOP') {
      window.__chessEngine.stop();
      return;
    }

    if (msg.type !== 'ANALYZE') return;

    try {
      const result = await window.__chessEngine.analyze(msg.fen, msg.depth);
      postBridge({
        type: 'ANALYSIS_RESULT',
        requestId: msg.requestId,
        result
      });
    } catch (e) {
      postBridge({
        type: 'ANALYSIS_ERROR',
        requestId: msg.requestId,
        error: e && e.message ? e.message : 'analysis failed'
      });
    }
  });

  engineReady.then(() => postBridge({ type: 'ENGINE_READY' }));
  bootEngine().catch((e) => {
    postBridge({
      type: 'ENGINE_ERROR',
      error: e && e.message ? e.message : 'engine failed to load'
    });
  });
})();
