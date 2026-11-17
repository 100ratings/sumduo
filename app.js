(() => {
  'use strict';

  // ---------- DOM ----------
  const displayEl = document.getElementById('display');
  const textEl = document.getElementById('displayText');
  const exprEl = document.getElementById('expr');
  const exprTextEl = document.getElementById('exprText');
  const keypad = document.getElementById('keypad');
  const clearKey = document.getElementById('clearKey');
  const deleteKey = document.querySelector('[data-key="bs"]');
  const negateKey = document.querySelector('[data-key="negate"]');
  const historyBtn = document.getElementById('historyBtn');
  const modeBtn = document.getElementById('modeBtn');
  const minuteHand = document.getElementById('minuteHand');
  const decimalKey = document.querySelector('[data-key="."]');
  const digitKeys = Array.from(document.querySelectorAll('.key.num')).filter((k) => /^\d$/.test(k.dataset.key));
  const signKeys = Array.from(document.querySelectorAll('.key.op')).filter((k) => k.dataset.key === '+' || k.dataset.key === '-');

  const MAX_DIGITS = 9;
  const BASE_FONT = 64;
  const MIN_SCALE = 0.75;
  const LONG_PRESS_MS = 700;
  const STORAGE_KEY = 'calc.target';
  const MODE_STORAGE_KEY = 'calc.mode';

  // ---------- Calculator state ----------
  // raw: the expression as entered, alternating numbers and operators, e.g. [55, '+', 6623, '+'].
  //      It's what the big line shows. It never contains the number currently being typed.
  // tokens: the evaluation stack derived from raw, reduced by precedence as iOS does.
  let raw = [];
  let tokens = [];
  let entry = null;        // string being typed ("12.5", "-0"), or null
  let shown = 0;           // result shown when nothing is pending
  let lastOp = null;       // for repeated "="
  let lastOperand = null;
  let lastExpr = '';       // grey line above a result
  let typedSinceResult = false; // C only after a digit has actually been entered

  // ---------- Secret force state ----------
  const secret = {
    target: null,   // number, or null
    mode: null,     // 'classic' (clock) or 'new' (calculator icon)
    armed: false,
    started: false,
    seq: '',        // characters to feed, e.g. "1234" or "12.5"
    idx: 0,
  };
  let completedExpressions = 0;
  let guidedOperator = null;
  let guidedDigits = '';

  const newTrick = {
    active: false,
    ready: false,
    spectator: null,
    base: null,
    placeholder: null,
  };
  let decimalPeekTimer = null;
  let decimalPeeking = false;
  const decimalPeekedPointers = new Set();

  // ---------- Helpers ----------
  const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const OP_SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };

  function apply(a, op, b) {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? NaN : a / b;
    }
    return b;
  }

  function round9(n) {
    if (!isFinite(n)) return n;
    return parseFloat(n.toPrecision(9));
  }

  function pending() { return raw.length > 0; }

  // The value the display is "on": the number being typed, the running value of a pending
  // expression, or the last result.
  function currentValue() {
    if (entry !== null) return parseFloat(entry) || 0;
    if (pending()) return tokens[tokens.length - 2];
    return shown;
  }

  // Reduce the token stack while the top operator's precedence >= minPrec.
  function reduce(minPrec) {
    while (tokens.length >= 3) {
      const op = tokens[tokens.length - 2];
      if (PREC[op] < minPrec) break;
      const b = tokens.pop(); tokens.pop(); const a = tokens.pop();
      tokens.push(round9(apply(a, op, b)));
    }
  }

  // Rebuild the evaluation stack from the raw expression.
  function rebuild() {
    tokens = [];
    for (const t of raw) {
      if (typeof t === 'string') { reduce(PREC[t]); tokens.push(t); }
      else tokens.push(t);
    }
  }

  function addThousandsSeparators(intPart) {
        return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  // Format a typed entry string exactly as typed (keeps trailing "." / zeros).
  function formatEntry(s) {
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); }
    const [i, f] = s.split('.');
    let out = addThousandsSeparators(i || '0');
    if (f !== undefined) out += ',' + f;
    return (neg ? '-' : '') + out;
  }

  // Format a computed number the way iOS does (9 significant digits, commas, e-notation when huge).
  function formatNumber(n) {
    if (Number.isNaN(n) || !isFinite(n)) return 'Error';
    if (Object.is(n, -0)) return '-0';
    const abs = Math.abs(n);
    if (abs !== 0 && (abs >= 1e9 || abs < 1e-8)) {
      let [m, e] = n.toExponential(8).split('e');
      m = m.replace(/\.?0+$/, '');
      return m.replace('.', ',') + 'e' + (e[0] === '+' ? e.slice(1) : e);
    }
    let s = String(round9(n));
    if (s.includes('e')) s = n.toFixed(9).replace(/\.?0+$/, '');
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); }
    const [i, f] = s.split('.');
    let out = addThousandsSeparators(i);
    if (f) out += ',' + f;
    return (neg ? '-' : '') + out;
  }

  // A number as a plain entry string (no commas), for turning results into editable entries.
  function toEntry(n) {
    const s = String(round9(n));
    return s.includes('e') || !isFinite(n) ? null : s;
  }

  function rawText() {
    return raw.map((t) => (typeof t === 'string' ? OP_SYMBOL[t] : formatNumber(t))).join('');
  }

  // The big white line: the expression as it's being built, or the number / result.
  function bigText() {
    if (newTrick.ready) return formatNumber(secret.target);
    if (newTrick.active) return entry !== null ? formatEntry(entry) : formatNumber(newTrick.placeholder);
    if (pending()) return rawText() + (entry !== null ? formatEntry(entry) : '');
    return entry !== null ? formatEntry(entry) : formatNumber(shown);
  }

  // iOS shrinks long text to fit, down to 75% of its size, and beyond that lets it run
  // off the left edge with a fade.
  function fitText(el, container) {
    el.style.fontSize = '';   // back to the CSS size, which scales with screen width
    const base = parseFloat(getComputedStyle(el).fontSize) || BASE_FONT;
    const avail = container.clientWidth;
    if (el.scrollWidth > avail) {
      el.style.fontSize = Math.max(base * MIN_SCALE, base * avail / el.scrollWidth).toFixed(2) + 'px';
    }
    container.classList.toggle('clipped', el.scrollWidth > avail + 0.5);
  }

  function fitDisplay() {
    fitText(textEl, displayEl);
    fitText(exprTextEl, exprEl);
  }

  function render() {
    textEl.textContent = bigText();
    exprTextEl.textContent = newTrick.ready
      ? formatNumber(newTrick.base) + '+' + formatNumber(newTrick.spectator)
      : (pending() ? '' : lastExpr);
    clearKey.textContent = (typedSinceResult || newTrick.active ||
      (secret.mode === 'new' && secret.target !== null)) ? 'C' : 'AC';
    fitDisplay();
    updateSecretCountHint();
  }

  function resetAll() {
    typedSinceResult = false;
    cancelNewTrick();
    raw = [];
    tokens = [];
    entry = null;
    shown = 0;
    lastOp = null;
    lastOperand = null;
    lastExpr = '';
    completedExpressions = 0;
    guidedOperator = null;
    guidedDigits = '';
    disarm();
    render();
  }

  // ---------- Input handlers ----------
  function inputDigit(d) {
    if (newTrick.ready) return;
    if (!secret.armed && secret.mode === 'classic' && entry === null && !pending()) {
      completedExpressions = 0;  // Typing a fresh number after = begins a new calculation.
    }
    if (!secret.armed) { guidedOperator = null; guidedDigits = ''; }
    if (newTrick.active) {
      if (entry === null) entry = d === '.' ? '0.' : d;
      else {
        if (d === '.' && entry.includes('.')) return;
        const digits = entry.replace(/[-.]/g, '').length;
        if (d !== '.' && digits >= MAX_DIGITS) return;
        if (entry === '0' && d !== '.') entry = d;
        else entry += d;
      }
      newTrick.spectator = parseFloat(entry) || 0;
      typedSinceResult = true;
      render();
      return;
    }
    if (entry === null) {
      if (!pending()) lastExpr = '';   // typing after a result starts fresh
      entry = d === '.' ? '0.' : d;
    } else {
      if (d === '.' && entry.includes('.')) return;
      const digits = entry.replace(/[-.]/g, '').length;
      if (d !== '.' && digits >= MAX_DIGITS) return;
      if (entry === '0' && d !== '.') entry = d;
      else if (entry === '-0' && d !== '.') entry = '-' + d;
      else entry += d;
    }
    typedSinceResult = true;
    render();
  }

  function inputOperator(op) {
    if (newTrick.active || newTrick.ready) {
      return;
    }
    if (op === '+' && secret.mode === 'new' && secret.target !== null && !secret.armed) {
      startNewTrick();
      return;
    }
    // Keep the guide visible if a different operator was tapped by mistake.
    // The correct sign can still replace that pending operator and arm the force.
    const last = raw[raw.length - 1];
    const replacePendingOp = entry === null && typeof last === 'string';
    const guidedTap = secret.mode === 'classic' && secret.target !== null &&
      guidedOperator === op && guidedDigits !== '' && entry === null &&
      (!pending() || replacePendingOp);
    const seq = guidedDigits;
    lastOp = null;
    lastExpr = '';
    if (replacePendingOp) {
      raw[raw.length - 1] = op;   // change the pending operator
    } else {
      raw.push(currentValue(), op);
    }
    entry = null;
    rebuild();
    if (guidedTap && arm(op, seq)) {
      guidedOperator = null;
      guidedDigits = '';
    }
    render();
  }

  function inputEquals() {
    if (newTrick.active && entry === null) return;
    if (newTrick.active && !newTrick.ready) {
      const result = secret.target;
      newTrick.spectator = currentValue();
      newTrick.base = round9(result - newTrick.spectator);
      const expression = formatNumber(newTrick.base) + '+' + formatNumber(newTrick.spectator);
      clearTarget();
      cancelNewTrick();
      entry = null;
      raw = [];
      tokens = [];
      shown = result;
      lastExpr = expression;
      lastOp = null;
      lastOperand = null;
      typedSinceResult = false;
      render();
      return;
    }
    if (newTrick.ready) {
      lastExpr = formatNumber(newTrick.base) + '+' + formatNumber(newTrick.spectator);
      const result = secret.target;
      shown = result;
      raw = [];
      tokens = [];
      entry = null;
      lastOp = null;
      lastOperand = null;
      clearTarget();
      cancelNewTrick();
      typedSinceResult = false;
      render();
      return;
    }
    if (secret.armed) { finishForce(); return; }
    const completedNow = pending();
    if (pending()) {
      const v = currentValue();
      lastOp = raw[raw.length - 1];
      lastOperand = v;
      raw.push(v);
      lastExpr = rawText();
      rebuild();
      reduce(1);
      shown = tokens[0];
    } else if (lastOp !== null) {
      const v = currentValue();
      lastExpr = formatNumber(v) + OP_SYMBOL[lastOp] + formatNumber(lastOperand);
      shown = round9(apply(v, lastOp, lastOperand));
    } else {
      shown = currentValue();
      lastExpr = '';
    }
    raw = [];
    tokens = [];
    entry = null;
    if (secret.mode === 'classic' && secret.target !== null && completedNow) {
      completedExpressions = Math.min(2, completedExpressions + 1);
    }
    refreshGuidedOperator();
    typedSinceResult = false;
    render();
  }

  function inputNegate() {
    completedExpressions = 0;
    guidedOperator = null;
    guidedDigits = '';
    if (entry !== null) {
      entry = entry[0] === '-' ? entry.slice(1) : '-' + entry;
    } else if (pending()) {
      entry = '-0';
    } else {
      shown = shown === 0 ? -0 : -shown;
      if (Object.is(shown, -0)) entry = '-0';
    }
    render();
  }

  function inputPercent() {
    completedExpressions = 0;
    guidedOperator = null;
    guidedDigits = '';
    const v = currentValue();
    const last = raw[raw.length - 1];
    let result;
    if (typeof last === 'string' && (last === '+' || last === '-')) {
      result = tokens[tokens.length - 2] * v / 100;
    } else {
      result = v / 100;
    }
    result = round9(result);
    if (pending()) entry = toEntry(result) ?? '0';   // becomes the operand being entered
    else { shown = result; entry = null; }
    render();
  }

  // C clears the number being typed; AC (or C with nothing typed) clears everything.
  function inputClear() {
    typedSinceResult = false;
    completedExpressions = 0;
    guidedOperator = null;
    guidedDigits = '';
    if (newTrick.active || newTrick.ready) {
      cancelNewTrick();
      raw = [];
      tokens = [];
      entry = null;
      shown = 0;
      lastOp = null;
      lastOperand = null;
      lastExpr = '';
      disarm();
      render();
      return;
    }
    if (entry !== null) {
      entry = null;
      if (!pending()) shown = 0;
      render();
      return;
    }
    resetAll();
  }

  // Deletes the last character of what's on screen: a digit of the number being typed,
  // a trailing operator of the expression, or a digit of a result (which becomes editable).
  function backspace() {
    completedExpressions = 0;
    guidedOperator = null;
    guidedDigits = '';
    if (entry === null) {
      if (pending()) {
        raw.pop();                          // the trailing operator
        entry = toEntry(raw.pop());
        rebuild();
        render();
        return;
      }
      // Editing a completed result must immediately clear its previous expression.
      lastExpr = '';
      lastOp = null;
      lastOperand = null;
      if (shown === 0) { render(); return; }
      entry = toEntry(shown);
      if (entry === null) { shown = 0; render(); return; }
    }
    entry = entry.slice(0, -1);
    if (entry === '' || entry === '-') { entry = null; if (!pending()) shown = 0; }
    render();
  }

  // ---------- Secret force ----------
  function loadTarget() {
    const fromUrl = new URLSearchParams(location.search).get('t') || (location.hash.match(/^#t=(.+)$/) || [])[1];
    if (fromUrl !== undefined && fromUrl !== null && fromUrl !== '') {
      setTarget(parseFloat(fromUrl));
      history.replaceState(null, '', location.pathname);
      return;
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null && stored !== '') {
      secret.target = parseFloat(stored);
      if (Number.isNaN(secret.target)) secret.target = null;
    }
    const storedMode = localStorage.getItem(MODE_STORAGE_KEY);
    secret.mode = storedMode === 'new' || storedMode === 'classic' ? storedMode : (secret.target !== null ? 'classic' : null);
    showTell();
  }

  // The tell, on the clock's minute hand:
  //   3 o'clock  nothing set
  //   9 o'clock  target set (and while digits are still being fed)
  //   6 o'clock  all delta digits entered, ready for =
  function showTell() {
    let x2 = 17, y2 = 12;                                   // 3 o'clock
    if (secret.armed && secret.idx >= secret.seq.length) { x2 = 12; y2 = 17; }   // 6 o'clock
    else if (secret.target !== null) { x2 = 7; y2 = 12; }  // 9 o'clock
    minuteHand.setAttribute('x2', String(x2));
    minuteHand.setAttribute('y2', String(y2));
    updateSecretCountHint();
  }

  function updateSecretCountHint() {
    digitKeys.concat(signKeys).forEach((key) => key.classList.remove('secret-count-hint'));
    if (secret.armed) {
      if (secret.started) return;
      const count = (secret.seq.match(/\d/g) || []).length;
      const key = digitKeys.find((candidate) => candidate.dataset.key === String(count));
      if (key) key.classList.add('secret-count-hint');
      return;
    }
    if (secret.mode !== 'classic' || secret.target === null || !guidedOperator) return;
    const key = signKeys.find((candidate) => candidate.dataset.key === guidedOperator);
    if (key) key.classList.add('secret-count-hint');
  }

  function setTarget(n, mode = secret.mode || 'classic') {
    if (Number.isNaN(n) || n === null) return clearTarget();
    secret.target = round9(n);
    secret.mode = mode === 'new' ? 'new' : 'classic';
    completedExpressions = 0;
    guidedOperator = null;
    guidedDigits = '';
    localStorage.setItem(STORAGE_KEY, String(secret.target));
    localStorage.setItem(MODE_STORAGE_KEY, secret.mode);
    showTell();
  }

  function clearTarget() {
    secret.target = null;
    secret.mode = null;
    completedExpressions = 0;
    guidedOperator = null;
    guidedDigits = '';
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(MODE_STORAGE_KEY);
    showTell();
  }

  function cancelNewTrick() {
    newTrick.active = false;
    newTrick.ready = false;
    newTrick.spectator = null;
    newTrick.base = null;
    newTrick.placeholder = null;
  }

  function startNewTrick() {
    typedSinceResult = false;
    cancelNewTrick();
    newTrick.active = true;
    newTrick.base = secret.target;
    newTrick.placeholder = currentValue();
    raw = [];
    tokens = [];
    entry = null;
    shown = 0;
    lastExpr = '';
    render();
  }


  function disarm() {
    secret.armed = false;
    secret.started = false;
    secret.seq = '';
    secret.idx = 0;
    showTell();
  }

  // Evaluate a token stack that ends with an operator, with q as the final operand.
  function evalWith(t, q) {
    const saved = tokens;
    tokens = t.concat([q]);
    reduce(1);
    const v = tokens[0];
    tokens = saved;
    return v;
  }

  // The operand q that makes the pending expression (ending in an operator) equal the target.
  // Every operator is linear in its last operand (a + b*q), except ÷ which is a + b/q.
  function solveOperand(t, target) {
    const op = t[t.length - 1];
    if (op === '/') {
      const f1 = evalWith(t, 1), f2 = evalWith(t, 2);
      const b = 2 * (f1 - f2), a = f1 - b;
      return b / (target - a);
    }
    const f0 = evalWith(t, 0), f1 = evalWith(t, 1);
    return (target - f0) / (f1 - f0);
  }

  // The token stack there would be after pressing op now (without changing state).
  function prospectiveTokens(op) {
    const savedRaw = raw, savedTokens = tokens;
    raw = raw.slice();
    const last = raw[raw.length - 1];
    if (entry === null && typeof last === 'string') raw[raw.length - 1] = op;
    else raw.push(currentValue(), op);
    rebuild();
    const out = tokens;
    raw = savedRaw; tokens = savedTokens;
    return out;
  }

  // The number the spectator would need to enter after op to land on the target.
  function neededFor(op) {
    return round9(solveOperand(prospectiveTokens(op), secret.target));
  }

  // The displayed operation must really reach the saved target.
  // Never turn a negative required operand into a positive one.
  function refreshGuidedOperator() {
    guidedOperator = null;
    guidedDigits = '';
    if (secret.mode !== 'classic' || secret.target === null ||
        secret.armed || completedExpressions < 2 ||
        !Number.isFinite(shown) || !Number.isFinite(secret.target)) return;
    const op = shown <= secret.target ? '+' : '-';
    const q = round9(Math.abs(secret.target - shown));
    const seq = String(q);
    const digits = (seq.match(/\d/g) || []).length;
    if (!Number.isFinite(q) || !/^\d+(?:\.\d+)?$/.test(seq) ||
        digits > MAX_DIGITS || round9(apply(shown, op, q)) !== secret.target) return;
    guidedOperator = op;
    guidedDigits = seq;
  }

  function arm(op, seq) {
    const q = Number(seq);
    if (tokens[tokens.length - 1] !== op ||
        !Number.isFinite(q) || round9(evalWith(tokens, q)) !== secret.target) return false;
    secret.seq = seq;
    secret.idx = 0;
    secret.started = false;
    secret.armed = true;
    showTell();
    return true;
  }

  function feedForcedChar() {
    if (secret.idx >= secret.seq.length) return;
    const ch = secret.seq[secret.idx++];
    secret.started = true;
    inputDigit(ch);
    showTell();
  }

  // Backspace while armed: remove the last fed digit so the next tap re-enters it.
  function forceBackspace() {
    if (secret.idx === 0 || entry === null) return;
    secret.idx--;
    entry = entry.slice(0, -1);
    if (entry === '') entry = null;
    render();
    showTell();
  }

  function forceEntryComplete() {
    return secret.armed && secret.idx >= secret.seq.length;
  }

  function finishForce() {
    typedSinceResult = false;
    const t = secret.target;
    lastExpr = bigText();   // reads like a genuine sum, e.g. "25×40"
    raw = [];
    tokens = [];
    entry = null;
    shown = t;
    lastOp = null;
    lastOperand = null;
    clearTarget();
    disarm();
    render();
  }

  // ---------- Dispatch ----------
  // Handles key presses from clicks / keyboard. While the force is armed and digits are still
  // owed, taps are consumed by the document-level tap detector below, not here.
  function press(key) {
    if (secret.armed) {
      if (!forceEntryComplete()) return;
      if (key === '=') return inputEquals();
      return;
    }
    switch (key) {
      case 'clear': return inputClear();
      case 'bs': return backspace();
      case 'negate': return inputNegate();
      case 'percent': return inputPercent();
      case '+': case '-': case '*': case '/': return inputOperator(key);
      case '=': return inputEquals();
      default:
        if (/^[0-9.]$/.test(key)) return inputDigit(key);
    }
  }

  // ---------- Whole-screen tap detection while armed ----------
  // One digit per tap gesture, however many fingers land and wherever they land.
  // Every tap, including taps on calculator keys, feeds the next forced character.
  const activePointers = new Set();
  const forcedDigitPointers = new Set();
  let forcedFeedbackKey = null;

  function clearForcedFeedback() {
    if (forcedFeedbackKey) forcedFeedbackKey.classList.remove('secret-feedback');
    forcedFeedbackKey = null;
  }

  function showForcedFeedback(ch) {
    clearForcedFeedback();
    const key = /^\d$/.test(ch) ? digitKeys.find((candidate) => candidate.dataset.key === ch) : (ch === '.' ? decimalKey : null);
    if (key) {
      key.classList.add('secret-feedback');
      forcedFeedbackKey = key;
    }
  }

  function onAnyPointerDown(e) {
    const wasIdle = activePointers.size === 0;
    activePointers.add(e.pointerId);
    if (!secret.armed || forceEntryComplete()) return;
    forcedDigitPointers.add(e.pointerId);
    if (wasIdle) {
      const forcedChar = secret.seq[secret.idx];
      feedForcedChar();
      showForcedFeedback(forcedChar);
    }
  }
  function onAnyPointerEnd(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size === 0) clearForcedFeedback();
    // Keep the marker through the keypad's pointerup handler so the same gesture
    // cannot also activate the physical key after feeding the final character.
    setTimeout(() => forcedDigitPointers.delete(e.pointerId), 0);
  }
  document.addEventListener('pointerdown', onAnyPointerDown, { capture: true });
  document.addEventListener('pointerup', onAnyPointerEnd, { capture: true });
  document.addEventListener('pointercancel', onAnyPointerEnd, { capture: true });
  // Safety net: if a pointerup ever goes missing, an all-fingers-up touchend resets the tracker.
  const resetTouchTracker = (e) => {
    if (e.touches.length !== 0) return;
    activePointers.clear();
    forcedDigitPointers.clear();
    clearForcedFeedback();
  };
  document.addEventListener('touchend', resetTouchTracker, { capture: true });
  document.addEventListener('touchcancel', resetTouchTracker, { capture: true });
  document.addEventListener('visibilitychange', () => {
    activePointers.clear();
    forcedDigitPointers.clear();
    clearForcedFeedback();
  });

  // ---------- Events ----------
  // Register ordinary digits and equals on contact, avoiding lost rapid touches
  // when pointerup is cancelled while the finger moves to another key.
  // Operators and keys with long-press gestures still activate on pointerup.
  const earlyKeyPointers = new Set();
  // Touch feedback calibrated from the recorded iOS calculator:
  // 150ms minimum highlight plus 100ms CSS fade, no input processing delay.
  const KEY_HIGHLIGHT_HOLD_MS = 150;
  const activeKeyTouches = new Map();
  const keyHighlightTimers = new Map();
  function releaseKeyHighlight(e) {
    const touch = activeKeyTouches.get(e.pointerId);
    if (!touch) return;
    activeKeyTouches.delete(e.pointerId);
    const k = touch.key;
    if ([...activeKeyTouches.values()].some((t) => t.key === k)) return;
    const delay = Math.max(0, KEY_HIGHLIGHT_HOLD_MS - (performance.now() - touch.started));
    const timer = setTimeout(() => {
      if (![...activeKeyTouches.values()].some((t) => t.key === k)) {
        k.classList.remove('pressed');
      }
      if (keyHighlightTimers.get(k) === timer) keyHighlightTimers.delete(k);
    }, delay);
    keyHighlightTimers.set(k, timer);
  }
  keypad.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.key');
    if (!k) return;
    if (forcedDigitPointers.has(e.pointerId) || forceEntryComplete()) return;
    const oldTimer = keyHighlightTimers.get(k);
    if (oldTimer !== undefined) {
      clearTimeout(oldTimer);
      keyHighlightTimers.delete(k);
    }
    activeKeyTouches.set(e.pointerId, { key: k, started: performance.now() });
    k.classList.add('pressed');
    if (!secret.armed && (/^\d$/.test(k.dataset.key) || k.dataset.key === '=')) {
      earlyKeyPointers.add(e.pointerId);
      rememberPointerActivation(k.dataset.key);
      press(k.dataset.key);
    }
  });
  keypad.addEventListener('pointerup', releaseKeyHighlight);
  keypad.addEventListener('pointercancel', releaseKeyHighlight);
  keypad.addEventListener('pointerleave', releaseKeyHighlight, true);
  keypad.addEventListener('pointerout', releaseKeyHighlight);

  let swallowClick = false;
  const lastPointerActivation = new Map();
  function rememberPointerActivation(key) {
    lastPointerActivation.set(key, performance.now());
  }
  let negateConfigActive = false;
  keypad.addEventListener('click', (e) => {
    const k = e.target.closest('.key');
    if (!k) return;
    if (swallowClick) { swallowClick = false; return; }
    // Mobile browsers synthesize a click after pointerup. Ignore only that
    // matching click; a later real tap on the same key must still work.
    if (e.detail !== 0 &&
        performance.now() - (lastPointerActivation.get(k.dataset.key) ?? -Infinity) < 700) return;
    press(k.dataset.key);
  });

  // Process a real touch immediately on pointerup. Mobile browsers synthesize a
  // delayed click afterward; suppress that click so one touch never enters twice.
  // The click listener above remains available for keyboard activation and older browsers.
  keypad.addEventListener('pointerup', (e) => {
    const k = e.target.closest && e.target.closest('.key');
    if (earlyKeyPointers.delete(e.pointerId)) return;
    // The decimal key already restored its peek on the target's pointerup.
    // Consume that same gesture before the keypad can insert a decimal point.
    if (decimalPeekedPointers.delete(e.pointerId)) {
      rememberPointerActivation('.');
      return;
    }
    if (k && forcedDigitPointers.has(e.pointerId)) {
      rememberPointerActivation(k.dataset.key);
      return;
    }
    if (k === negateKey && negateConfigActive) {
      negateConfigActive = false;
      rememberPointerActivation(k.dataset.key);
      return;
    }
    if (!k || opPeeking || (k === decimalKey && decimalPeeking) ||
        (k === deleteKey && deleteResetFired)) return;
    press(k.dataset.key);
    rememberPointerActivation(k.dataset.key);
  });
  document.addEventListener('pointerup', (e) => {
    setTimeout(() => {
      earlyKeyPointers.delete(e.pointerId);
      decimalPeekedPointers.delete(e.pointerId);
    }, 0);
  }, { capture: true });
  document.addEventListener('pointercancel', (e) => {
    earlyKeyPointers.delete(e.pointerId);
    decimalPeekedPointers.delete(e.pointerId);
  }, { capture: true });

  // Hold an operator key (target set, not armed): the display shows the number the
  // spectator would need to enter after that operator to reach the target. Releasing
  // restores the display and does not press the operator.
  let opPeekTimer = null;
  let opPeeking = false;
  keypad.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.key.op');
    if (!k || !PREC[k.dataset.key] || secret.target === null || secret.armed) return;
    const op = k.dataset.key;
    clearTimeout(opPeekTimer);
    opPeekTimer = setTimeout(() => {
      opPeeking = true;
      textEl.textContent = formatNumber(neededFor(op));
      fitText(textEl, displayEl);
    }, LONG_PRESS_MS);
  });
  const endOpPeek = () => {
    clearTimeout(opPeekTimer); opPeekTimer = null;
    if (opPeeking) {
      opPeeking = false;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 300);
      render();
    }
  };
  keypad.addEventListener('pointerup', endOpPeek);
  keypad.addEventListener('pointercancel', endOpPeek);
  keypad.addEventListener('pointerleave', endOpPeek, true);

  // Long-pressing the decimal key reveals the configured number; a short press
  // remains the normal decimal-point input.
  decimalKey.addEventListener('pointerdown', (e) => {
    clearTimeout(decimalPeekTimer);
    const pointerId = e.pointerId;
    decimalPeekTimer = setTimeout(() => {
      if (secret.target === null || secret.armed) return;
      decimalPeekedPointers.add(pointerId);
      decimalPeeking = true;
      textEl.textContent = formatNumber(secret.target);
      fitText(textEl, displayEl);
    }, LONG_PRESS_MS);
  });
  const endDecimalPeek = () => {
    clearTimeout(decimalPeekTimer);
    decimalPeekTimer = null;
    if (decimalPeeking) {
      decimalPeeking = false;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 300);
      render();
    }
  };
  decimalKey.addEventListener('pointerup', endDecimalPeek);
  decimalKey.addEventListener('pointercancel', endDecimalPeek);
  decimalKey.addEventListener('pointerleave', endDecimalPeek);

  // Holding the delete key performs the same complete reset as holding AC.
  // A short press remains the normal backspace action.
  let deleteResetTimer = null;
  let deleteResetFired = false;
  deleteKey.addEventListener('pointerdown', () => {
    deleteResetFired = false;
    if (secret.armed) return;
    deleteResetTimer = setTimeout(() => {
      if (secret.armed) return;
      deleteResetFired = true;
      clearTarget();
      resetAll();
    }, LONG_PRESS_MS);
  });
  const endDeleteReset = () => {
    clearTimeout(deleteResetTimer);
    deleteResetTimer = null;
    if (deleteResetFired) {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 300);
      deleteResetFired = false;
    }
  };
  deleteKey.addEventListener('pointerup', endDeleteReset);
  deleteKey.addEventListener('pointercancel', endDeleteReset);
  deleteKey.addEventListener('pointerleave', endDeleteReset);

  // Swipe on the display deletes the last character (iOS behaviour).
  let swipeStart = null;
  displayEl.addEventListener('pointerdown', (e) => { swipeStart = { x: e.clientX, y: e.clientY }; });
  displayEl.addEventListener('pointerup', (e) => {
    if (!swipeStart) return;
    const dx = e.clientX - swipeStart.x, dy = e.clientY - swipeStart.y;
    swipeStart = null;
    if (secret.armed) return;
    if (Math.abs(dx) > 30 && Math.abs(dy) < 50) backspace();
  });

  // Long-press helper for the two round buttons.
  function longPress(btn, onFire, onRelease) {
    let timer = null;
    let fired = false;
    btn.addEventListener('pointerdown', () => {
      btn.classList.add('pressed');
      fired = false;
      timer = setTimeout(() => { fired = true; onFire(); }, LONG_PRESS_MS);
    });
    const end = () => {
      btn.classList.remove('pressed');
      clearTimeout(timer); timer = null;
      if (fired && onRelease) onRelease();
      fired = false;
    };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('pointerleave', end);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function configureTargetFromScreen(mode) {
    if (secret.armed || newTrick.active || newTrick.ready) return false;
    const v = currentValue();
    if (v === 0 && entry === null && !pending()) return false;
    setTarget(v, mode);
    resetAll();
    return true;
  }

  function configureDateTimeTarget() {
    if (secret.armed || newTrick.active || newTrick.ready || pending()) return false;

    let minutesAhead = 0;
    if (entry !== null) {
      if (!/^[1-9]$/.test(entry)) return false;
      minutesAhead = Number(entry);
    }

    const targetDate = new Date();
    targetDate.setMinutes(targetDate.getMinutes() + minutesAhead);

    const day = String(targetDate.getDate());
    const month = String(targetDate.getMonth() + 1);
    const year = String(targetDate.getFullYear()).slice(-2);
    const hour = String(targetDate.getHours()).padStart(2, '0');
    const minute = String(targetDate.getMinutes()).padStart(2, '0');
    const withYear = `${day}${month}${year}${hour}${minute}`;
    const withoutYear = `${day}${month}${hour}${minute}`;
    const target = Number(withYear.length <= 9 ? withYear : withoutYear);

    setTarget(target, 'classic');
    resetAll();
    return true;
  }

  // Clock selects the classic force directly; the calculator icon sets a date/time
  // target for the same force. The new + trick remains selected with the +/- key.
  let topPointerHandled = false;
  const configureFromPointer = (mode) => {
    topPointerHandled = true;
    configureTargetFromScreen(mode);
    setTimeout(() => { topPointerHandled = false; }, 500);
  };
  const configureDateTimeFromPointer = () => {
    topPointerHandled = true;
    configureDateTimeTarget();
    setTimeout(() => { topPointerHandled = false; }, 500);
  };
  historyBtn.addEventListener('pointerdown', () => configureFromPointer('classic'));
  modeBtn.addEventListener('pointerdown', configureDateTimeFromPointer);
  historyBtn.addEventListener('click', () => { if (!topPointerHandled) configureTargetFromScreen('classic'); });
  modeBtn.addEventListener('click', () => { if (!topPointerHandled) configureDateTimeTarget(); });
  negateKey.addEventListener('pointerdown', () => {
    negateConfigActive = configureTargetFromScreen('new');
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  // Keyboard support (handy on desktop).
  document.addEventListener('keydown', (e) => {
    const map = { Enter: '=', '=': '=', Backspace: 'bs', Escape: 'clear', '%': 'percent', x: '*', X: '*' };
    const key = map[e.key] || e.key;
    if (/^[0-9.+\-*\/=]$/.test(key) || key === 'clear' || key === 'percent' || key === 'bs') press(key);
  });

  // Sideways: the CSS blanks the screen. Back in portrait, refit the text and make sure
  // nothing is left scrolled.
  window.addEventListener('resize', () => { window.scrollTo(0, 0); fitDisplay(); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !location.search.includes('nosw')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  loadTarget();
  render();

  // Debug hooks (not visible in UI).
  window.__calc = { press, state: () => ({ raw: raw.slice(), tokens: tokens.slice(), entry, shown, lastExpr, secret: { ...secret } }), setTarget, clearTarget, neededFor };
})();
