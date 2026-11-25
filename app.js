/* Kopano Employee: the employee app for Kopano Payroll. Talks to the company's Supabase project through the
   kp_emp_* functions (see docs/employee-app-api.md). Runs in the Android WebView (window.KopanoNative) and in a
   normal browser: 1.52 publishes it as a web app for iPhones (web/, built by web/build.sh). */
(function () {
  'use strict';

  var NATIVE = window.KopanoNative || null;
  var VERSION = NATIVE && NATIVE.version ? NATIVE.version() : (window.KP_WEB_VERSION ? window.KP_WEB_VERSION + ' (web)' : 'web');
  // 1.52: the web app on an iPhone / iPad (iPadOS says it is a Mac, but has touch)
  var IOS = !NATIVE && (/iPhone|iPad|iPod/.test(navigator.userAgent || '') || (/Macintosh/.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1));
  var STANDALONE = !!(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
  var CAN_VIBRATE = !!(NATIVE || (navigator.vibrate && !IOS)); // Safari on an iPhone cannot vibrate
  var MAX_UPLOAD = 5 * 1024 * 1024;
  var app = document.getElementById('app');

  // ---------- storage ----------
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('kpe.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { if (v == null) localStorage.removeItem('kpe.' + k); else localStorage.setItem('kpe.' + k, JSON.stringify(v)); } catch (e) { /* full or blocked */ }
    },
  };

  var state = {
    conn: store.get('conn', null), // {u,k,w,n}
    session: store.get('session', null), // {token, expiresAt, name, login}
    home: store.get('home', null),
    homeAt: store.get('homeAt', null),
    lang: store.get('lang', null),
    offline: false,
    loading: false,
    flash: null, // {kind, text} shown once at the top of the next screen
    lastLogin: store.get('lastLogin', ''),
  };

  // ---------- 1.53: display settings (text size, light / dark) ----------
  var TEXT_SIZES = [['auto', 'tsAuto'], ['14', 'tsSmall'], ['16', 'tsNormal'], ['18', 'tsLarge'], ['20', 'tsXLarge'], ['23', 'tsHuge']];
  var THEMES = [['system', 'themeSystem'], ['light', 'themeLight'], ['dark', 'themeDark']];
  function textSizePref() { var v = String(store.get('textSize', 'auto')); return TEXT_SIZES.some(function (x) { return x[0] === v; }) ? v : 'auto'; }
  function themePref() { var v = store.get('theme', 'system'); return v === 'light' || v === 'dark' ? v : 'system'; }
  function applyDisplay() {
    var root = document.documentElement, ts = textSizePref(), th = themePref();
    root.classList.toggle('ts-auto', ts === 'auto');
    root.style.fontSize = ts === 'auto' ? '' : ts + 'px';
    if (th === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', th);
    var dark = th === 'dark' || (th === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#14171a' : '#1f6f6b');
  }
  applyDisplay();
  if (window.matchMedia) { var mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', applyDisplay); }

  // ---------- text ----------
  function lang() {
    if (state.lang === 'en' || state.lang === 'af') return state.lang;
    var e = state.home && state.home.employee;
    if (e && /^af/i.test(e.language || '')) return 'af';
    if (e && e.language) return 'en';
    return /^af/i.test(navigator.language || '') ? 'af' : 'en';
  }
  function t(key, vars) {
    var s = (KP_TEXT[lang()] && KP_TEXT[lang()][key]) || KP_TEXT.en[key] || key;
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? '' : vars[k]; });
    return s;
  }
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function D() { return KP_DATES[lang()]; }

  // dates are 'YYYY-MM-DD' in South African time (UTC+2, no daylight saving)
  function todayISO() { return new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10); }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function parseISO(iso) { var d = new Date(String(iso || '').slice(0, 10) + 'T00:00:00Z'); return isNaN(d) ? null : d; }
  function fmtDate(iso, opts) {
    var d = parseISO(iso);
    if (!d) return iso ? h(iso) : '';
    opts = opts || {};
    if (opts.relative) {
      var td = todayISO();
      if (iso.slice(0, 10) === td) return t('today');
      if (iso.slice(0, 10) === addDays(td, 1)) return t('tomorrow');
    }
    var s = d.getUTCDate() + ' ' + D().mon[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    return opts.weekday === false ? s : D().wd[d.getUTCDay()] + ' ' + s;
  }
  function fmtStamp(ts) {
    var d = new Date(ts);
    if (isNaN(d)) return '';
    var sa = new Date(d.getTime() + 2 * 3600000), iso = sa.toISOString();
    return fmtDate(iso.slice(0, 10), { relative: true, weekday: false }) + ' ' + iso.slice(11, 16);
  }
  function money(v) {
    var n = Number(v);
    if (!isFinite(n)) return '';
    var neg = n < 0, s = Math.abs(n).toFixed(2).split('.');
    s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    return (neg ? '-' : '') + 'R\u00a0' + s[0] + D().dec + s[1];
  }
  function num(v) {
    var n = Math.round(Number(v) * 100) / 100;
    if (!isFinite(n)) return '';
    return String(n).replace('.', D().dec);
  }
  function leaveName(type, name) {
    if (lang() === 'af') {
      var k = String(name || type || '').toLowerCase();
      if (KP_LEAVE_AF[k]) return KP_LEAVE_AF[k];
      if (KP_LEAVE_AF[String(type || '').toLowerCase()]) return KP_LEAVE_AF[String(type).toLowerCase()];
    }
    return name || type || '';
  }
  function leaveTypeName(type) {
    var home = state.home || {}, all = (home.leaveTypes || []).concat(home.leave || []);
    for (var i = 0; i < all.length; i++) if (all[i].type === type) return leaveName(type, all[i].name);
    return leaveName(type, type);
  }

  // ---------- toast ----------
  var toastTimer;
  function toast(text) {
    var el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3500);
  }

  // ---------- popup (1.25): a question with buttons over the screen ----------
  // sheet({ title, text, html, buttons: [{ label, cls, fn }] }); tapping outside or Back closes it
  var sheetEl = null;
  function sheet(o) {
    closeSheet();
    var el = document.createElement('div');
    el.className = 'sheet-bg';
    el.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><h3>' + h(o.title) + '</h3>' + (o.text ? '<p>' + h(o.text) + '</p>' : '') + (o.html || '') +
      '<div class="btns">' + o.buttons.map(function (b, i) {
        return '<button type="button" class="btn block ' + (b.cls || '') + '" data-sheet="' + i + '">' + h(b.label) + '</button>';
      }).join('') + '</div></div>';
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-sheet]');
      if (b) { var fn = o.buttons[+b.getAttribute('data-sheet')].fn; closeSheet(); if (fn) fn(); return; }
      if (ev.target === el) { closeSheet(); if (o.onDismiss) o.onDismiss(); }
    });
    document.body.appendChild(el);
    sheetEl = { el: el, o: o };
  }
  function closeSheet() {
    if (!sheetEl) return false;
    sheetEl.el.remove();
    sheetEl = null;
    return true;
  }

  // ---------- connection code ----------
  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  // 1.54.1: the short link ?j=<ref>.<iat>.<exp>.<signature>.<ws> holds a standard Supabase anon key in pieces
  // (the key's header and payload are the same for every project apart from ref, iat and exp). Letters, digits and dots
  // only, so WhatsApp shows the whole link as one link.
  var B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function b62Bytes(s, len) {
    var out = [], i, j, v, carry;
    for (i = 0; i < len; i++) out.push(0);
    for (i = 0; i < s.length; i++) {
      carry = B62.indexOf(s.charAt(i)); if (carry < 0) throw new Error('bad');
      for (j = len - 1; j >= 0; j--) { v = out[j] * 62 + carry; out[j] = v & 255; carry = v >> 8; }
      if (carry) throw new Error('too long');
    }
    return out;
  }
  function b64urlBytes(a) { var bin = ''; for (var i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function parseShortCode(s) {
    var j = String(s || '').match(/(?:[?&#]j=|KPJ\.)([a-z0-9]{20})\.([0-9a-z]{1,9})\.([0-9a-z]{1,9})\.([0-9A-Za-z]{43})\.([0-9a-f]{4,40})(?![0-9A-Za-z])/);
    if (!j) return null;
    try {
      var payload = '{"iss":"supabase","ref":"' + j[1] + '","role":"anon","iat":' + parseInt(j[2], 36) + ',"exp":' + parseInt(j[3], 36) + '}';
      var k = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.' + b64urlBytes(b62Bytes(j[4], 32));
      return { u: 'https://' + j[1] + '.supabase.co', k: k, w: 'kp-' + j[5], n: '' };
    } catch (e) { return null; }
  }
  function parseConnectionCode(text) {
    var s = String(text || '').trim();
    var sc = parseShortCode(s); if (sc) return sc;
    var m = s.match(/KPE1\.[A-Za-z0-9_-]+/); // also inside a link or a longer message
    if (!m) return null;
    try {
      var o = JSON.parse(b64urlDecode(m[0].slice(5).replace(/\s/g, '')));
      var okUrl = typeof o.u === 'string' && (/^https:\/\/[^\s/]+/.test(o.u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(o.u));
      if (!okUrl || !o.k || !o.w) return null;
      return { u: o.u.replace(/\/+$/, ''), k: String(o.k), w: String(o.w), n: String(o.n || '') };
    } catch (e) {
      return null;
    }
  }

  // ---------- server ----------
  function ApiError(code, message) { this.code = code; this.message = message; }
  function classify(msg) {
    msg = String(msg || '');
    var m = msg.match(/^(kp_\w+)(?::\s*(.*))?$/);
    var code = m ? m[1].slice(3) : 'server';
    return new ApiError(code, (m && m[2]) || msg);
  }
  function rpc(fn, args, timeoutMs) {
    var c = state.conn;
    if (!c) return Promise.reject(new ApiError('noconn', ''));
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 30000) : null;
    return fetch(c.u + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: c.k, Authorization: 'Bearer ' + c.k, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args || {}),
      signal: ctl ? ctl.signal : undefined,
    }).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
        if (!res.ok) {
          var msg = body && typeof body === 'object' ? (body.message || body.error || body.hint) : body;
          throw classify(msg || 'HTTP ' + res.status);
        }
        state.offline = false;
        return body;
      });
    }, function () {
      clearTimeout(timer);
      throw new ApiError('offline', '');
    });
  }
  function rpcT(fn, args, timeoutMs) {
    if (!state.session) return Promise.reject(new ApiError('expired', ''));
    var a = { p_token: state.session.token };
    for (var k in args || {}) a[k] = args[k];
    return rpc(fn, a, timeoutMs).catch(function (e) {
      if (e.code === 'expired') {
        endSession();
        state.flash = { kind: 'warn', text: t('signedOutExpired') };
        go('');
      }
      throw e;
    });
  }
  function errorText(e) {
    if (!e) return '';
    if (e.code === 'offline') return t('offlineShort');
    if (e.code === 'locked') return t('locked');
    if (e.code === 'expired') return t('signedOutExpired');
    return t('serverError', { msg: e.message || e.code });
  }

  function endSession() {
    state.session = null;
    state.home = null;
    state.homeAt = null;
    store.set('session', null);
    store.set('home', null);
    store.set('homeAt', null);
    if (NATIVE && NATIVE.setReminders) NATIVE.setReminders('[]');
  }

  // ---------- loading the employee's details ----------
  var loadingPromise = null;
  function loadHome(quiet) {
    if (!state.session) return Promise.resolve();
    if (loadingPromise) return loadingPromise;
    state.loading = true;
    if (!quiet) updateTopBar();
    loadingPromise = rpcT('kp_emp_home', {}).then(function (home) {
      state.home = home || {};
      state.homeAt = new Date().toISOString();
      store.set('home', state.home);
      store.set('homeAt', state.homeAt);
      keepBrand();
      state.offline = false;
      scheduleNotifications();
      checkNews();
    }, function (e) {
      if (e.code === 'offline') state.offline = true;
      else if (e.code !== 'expired') toast(errorText(e));
    }).then(function () {
      state.loading = false;
      loadingPromise = null;
      if (!currentView || !currentView.form) render();
      else updateTopBar();
    });
    return loadingPromise;
  }

  // ---------- 1.46: notification sounds and vibration ----------
  var SOUNDS = [['default', 'soundDefault'], ['chime', 'soundChime'], ['ping', 'soundPing'], ['bell', 'soundBell'], ['none', 'soundNone']];
  function soundPref() { var v = store.get('sound', 'default'); return SOUNDS.some(function (x) { return x[0] === v; }) ? v : 'default'; }
  function vibratePref() { return store.get('vibrate', true) !== false; }
  function pushAlertPrefs() { if (NATIVE && NATIVE.setAlertPrefs) try { NATIVE.setAlertPrefs(soundPref(), vibratePref()); } catch (e) { /* older app */ } }
  // in a browser (and as a fall-back) the tones are made with Web Audio; on the phone the app plays them (KopanoNative.alert)
  var TONES = { default: [[880, 0, 0.12], [1320, 0.13, 0.2]], chime: [[1046.5, 0, 0.35], [1318.5, 0.18, 0.35], [1568, 0.36, 0.6]], ping: [[1760, 0, 0.25]], bell: [[660, 0, 0.9], [1320, 0, 0.6]] };
  var audioCtx = null;
  function webTone(sound) {
    var AC = window.AudioContext || window.webkitAudioContext, notes = TONES[sound];
    if (!AC || !notes) return;
    try {
      audioCtx = audioCtx || new AC();
      var now = audioCtx.currentTime;
      notes.forEach(function (n) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, now + n[1]); g.gain.exponentialRampToValueAtTime(0.25, now + n[1] + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, now + n[1] + n[2]);
        o.connect(g); g.connect(audioCtx.destination); o.start(now + n[1]); o.stop(now + n[1] + n[2] + 0.05);
      });
    } catch (e) { /* no sound */ }
  }
  var lastAlert = { sound: '', vibrate: null }; // for tests
  function alertNow(test) {
    var sound = soundPref(), vib = vibratePref();
    lastAlert = { sound: sound, vibrate: vib, test: !!test, at: Date.now() };
    if (sound === 'none' && !vib) { if (test) toast(t('soundNone')); return; }
    if (NATIVE && NATIVE.alert) { try { NATIVE.alert(sound, vib); return; } catch (e) { /* older app: below */ } }
    if (sound !== 'none') webTone(sound);
    if (vib && navigator.vibrate) try { navigator.vibrate([0, 180, 90, 180]); } catch (e) { /* not allowed */ }
  }
  // what is new from HR since the last refresh: answers, decisions, documents asked for, appointments, reminders, payslips, approvals
  function newsKeys(home) {
    var k = [];
    (home.requests || []).forEach(function (q) {
      if (q.status !== 'pending' && q.status !== 'cancelled') k.push('s:' + q.id + ':' + q.status);
      if (q.mgr && q.mgr.status && q.mgr.status !== 'waiting' && q.mgr.status !== 'skipped') k.push('g:' + q.id + ':' + q.mgr.status);
      (q.messages || []).forEach(function (m) { if (m.from === 'hr') k.push('m:' + q.id + ':' + m.id); });
    });
    (home.documentsRequested || []).forEach(function (d) { k.push('d:' + d.id); });
    (home.appointments || []).forEach(function (a) { k.push('a:' + a.id + ':' + a.date + (a.time || '')); });
    (home.reminders || []).forEach(function (r) { k.push('r:' + r.id); });
    (home.payslips || []).forEach(function (p) { k.push('p:' + p.id); });
    (home.approvals || []).forEach(function (a) { if (a.status === 'pending' && a.mgr && a.mgr.status === 'waiting') k.push('w:' + a.id); });
    return k;
  }
  function checkNews() {
    var who = 'seen.' + ((state.session && state.session.login) || '') + '@' + ((state.conn && state.conn.w) || '');
    var keys = newsKeys(state.home || {}), before = store.get(who, null);
    store.set(who, keys.slice(-800));
    if (!before) return 0; // the first refresh after signing in only remembers
    var seen = {}; before.forEach(function (x) { seen[x] = 1; });
    var n = keys.filter(function (x) { return !seen[x]; }).length;
    if (n) { alertNow(); toast(n === 1 ? t('newUpdate1') : t('newUpdates', { n: n })); }
    return n;
  }

  // ---------- phone notifications for appointments and reminders ----------
  function saTime(date, time) {
    var hm = /^\d\d:\d\d/.test(time || '') ? time.slice(0, 5) : '08:00';
    var ms = Date.parse(date + 'T' + hm + ':00Z');
    return isNaN(ms) ? null : ms - 2 * 3600000;
  }
  function scheduleNotifications() {
    if (!NATIVE || !NATIVE.setReminders) return;
    if (store.get('notify', true) === false) { NATIVE.setReminders('[]'); return; }
    var home = state.home || {}, out = [];
    (home.appointments || []).forEach(function (a) {
      var at = saTime(a.date, a.time);
      if (at == null) return;
      var title = a.title || t('appointment');
      // the evening before at 18:00, and an hour before
      out.push({ id: 'a' + a.id + 'd', at: saTime(addDays(a.date, -1), '18:00'), title: title,
        text: t('tomorrow') + ' ' + (a.time || '') + (a.place ? ' · ' + a.place : ''), open: 'calendar' });
      if (a.time) out.push({ id: 'a' + a.id + 'h', at: at - 3600000, title: title,
        text: t('notifyAppt', { time: a.time, title: title }) + (a.place ? ' · ' + a.place : ''), open: 'calendar' });
    });
    (home.reminders || []).forEach(function (r) {
      var at = saTime(r.date, r.time);
      if (at == null) return;
      out.push({ id: 'r' + r.id, at: at, title: t('notifyRem', { title: r.title || '' }), text: r.note || fmtDate(r.date), open: 'calendar' });
    });
    (home.requests || []).forEach(function (q) {
      var ap = q.status === 'scheduled' && q.response && q.response.appointment;
      if (!ap || !ap.date) return;
      var dup = (home.appointments || []).some(function (a) { return a.date === ap.date && a.time === ap.time; });
      if (dup) return;
      var at = saTime(ap.date, ap.time);
      if (at != null && ap.time) out.push({ id: 'q' + q.id, at: at - 3600000, title: t('kind_meeting'),
        text: t('notifyAppt', { time: ap.time, title: (q.payload && q.payload.topic) || '' }), open: 'calendar' });
    });
    var now = Date.now();
    out = out.filter(function (x) { return x.at && x.at > now; }).sort(function (a, b) { return a.at - b.at; }).slice(0, 40);
    try { NATIVE.setReminders(JSON.stringify(out)); } catch (e) { /* older app */ }
  }

  // ---------- routing ----------
  var currentView = null;
  function route() { return decodeURIComponent((location.hash || '').replace(/^#\/?/, '')); }
  function go(r) {
    var target = '#' + r;
    if (location.hash === target || (!location.hash && !r)) render();
    else location.hash = target;
  }
  window.addEventListener('hashchange', function () { render(); });
  window.kpOpen = function (r) { go(r || ''); };
  window.kpResume = function () {
    if (state.session && (!state.homeAt || Date.now() - Date.parse(state.homeAt) > 120000)) loadHome(true);
  };
  window.kpBack = function () {
    var cam = document.querySelector('.camera');
    if (cam) { closeCamera(); return true; }
    if (sheetEl) { var od = sheetEl.o.onDismiss; closeSheet(); if (od) od(); return true; }
    var r = route();
    if (!state.session || !r) return false;
    if (r.indexOf('/') > 0 || ['calendar', 'meeting', 'requests'].indexOf(r) >= 0 || /^req\//.test(r) || (r === 'team' && !isMgrOnly())) history.back();
    else go('');
    return true;
  };

  // ---------- icons ----------
  var ICONS = {
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    leave: 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11zM7 11h5v5H7z',
    pay: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    docs: 'M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5z',
    me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    chev: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    meet: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    camera: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9z',
    file: 'M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z',
    qr: 'M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zM13 3v8h8V3h-8zm6 6h-4V5h4v4zm0 10h2v2h-2zm-6-6h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm0-4h2v2h-2zm2 2h2v2h-2z',
    share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11A2.99 2.99 0 0 0 21 5a3 3 0 1 0-5.91.7L8.04 9.81A3 3 0 1 0 6 15c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65A2.92 2.92 0 1 0 18 16.08z',
    cal: 'M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1V1h-2zm3 18H5V8h14v11z',
    send: 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z',
    bell: 'M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  };
  function icon(name, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' + ICONS[name] + '"/></svg>';
  }

  // ---------- rendering ----------
  function langToggle() {
    return '<div class="lang-toggle" role="group" aria-label="' + h(t('language')) + '">' +
      '<button type="button" data-act="lang" data-v="en" class="' + (lang() === 'en' ? 'on' : '') + '">English</button>' +
      '<button type="button" data-act="lang" data-v="af" class="' + (lang() === 'af' ? 'on' : '') + '">Afrikaans</button></div>';
  }
  // a message for the next screen; it stays while that screen is re-drawn (e.g. after a refresh), for 10 seconds
  function flashHtml() {
    var f = state.flash;
    if (!f) return '';
    if (f.route == null) f.route = route();
    if (f.until == null) f.until = Date.now() + 10000;
    if (f.route !== route() || Date.now() > f.until) { state.flash = null; return ''; }
    return '<div class="banner ' + h(f.kind) + '">' + h(f.text) + '</div>';
  }
  function statusBadge(st) { return '<span class="badge st-' + h(st) + '">' + h(t('st_' + st)) + '</span>'; }
  // 1.30: a request that waits shows whether it is with the manager or with HR
  function reqBadge(q) {
    if (q.status === 'pending' && q.mgr && q.mgr.status === 'waiting') return '<span class="badge st-pending">' + h(t('st_mgr')) + '</span>';
    if (q.status === 'pending' && q.mgr && q.mgr.status === 'approved') return '<span class="badge st-pending">' + h(t('st_hr')) + '</span>';
    return statusBadge(q.status);
  }
  function fieldErr(msg) { return msg ? '<div class="err">' + h(msg) + '</div>' : ''; }

  var TABS = [['', 'home', 'tabHome'], ['leave', 'leave', 'tabLeave'], ['payslips', 'pay', 'tabPayslips'], ['docs', 'docs', 'tabDocuments'], ['me', 'me', 'tabProfile']];
  // 1.30: a manager gets a Team tab; a manager-only login (no employee record) only has Team and Me
  function isMgrOnly() { return !!(state.home && state.home.managerOnly); }
  function isMgr() { return !!(state.home && (state.home.manager || state.home.managerOnly)); }
  function tabsNow() {
    if (isMgrOnly()) return [['', 'meet', 'tabTeam'], ['me', 'me', 'tabProfile']];
    if (isMgr()) return [TABS[0], ['team', 'meet', 'tabTeam']].concat(TABS.slice(1));
    return TABS;
  }
  function tabOf(r) {
    var first = r.split('/')[0];
    if (first === 'appr') return isMgrOnly() ? '' : 'team';
    if (first === 'team' && isMgrOnly()) return '';
    if (first === 'calendar' || first === 'meeting' || first === 'requests' || first === 'req') return '';
    return first;
  }

  function shell(view) {
    var r = route(), home = state.home || {}, emp = home.employee || {};
    var docsDue = (home.documentsRequested || []).length;
    var waiting = waitingApprovals().length;
    var tabs = '<nav class="tabs">' + tabsNow().map(function (tb) {
      var dot = tb[0] === 'docs' && docsDue ? '<span class="dot">' + docsDue + '</span>' : tb[2] === 'tabTeam' && waiting ? '<span class="dot">' + waiting + '</span>' : '';
      return '<button type="button" data-act="tab" data-v="' + tb[0] + '" class="' + (tabOf(r) === tb[0] ? 'on' : '') + '">' +
        icon(tb[1]) + '<span>' + h(t(tb[2])) + '</span>' + dot + '</button>';
    }).join('') + '</nav>';
    var sub = view.back
      ? '<button type="button" class="icon-btn" data-act="back" aria-label="' + h(t('back')) + '">' + icon('back') + '</button>'
      : '';
    var b = brand();
    var top = '<header class="top">' + sub + coLogoHtml(b) + '<div class="title"><b class="co-name">' + h(b.name || t('appName')) + '</b><span class="view" id="subtitle">' + h(subtitle(view)) + '</span></div>' +
      '<button type="button" class="icon-btn' + (state.loading ? ' spin' : '') + '" id="refreshBtn" data-act="refresh" aria-label="' + h(t('refresh')) + '">' + icon('refresh') + '</button></header>';
    var banner = '';
    if (state.offline) banner = '<div class="banner warn">' + h(t('offline', { when: state.homeAt ? fmtStamp(state.homeAt) : '—' })) + '</div>';
    else if (state.home && !home.employee && !state.loading) banner = '<div class="banner info">' + h(t('notPublished')) + '</div>';
    return top + '<main>' + flashHtml() + banner + view.html + '</main>' + tabs;
  }
  function subtitle(view) {
    if (state.loading) return t('loading');
    return (view && view.title) || '';
  }
  function updateTopBar() {
    var b = document.getElementById('refreshBtn'), s = document.getElementById('subtitle');
    if (b) b.classList.toggle('spin', !!state.loading);
    if (s) s.textContent = subtitle(currentView);
  }

  function render() {
    document.documentElement.lang = lang();
    var r = route(), view;
    closeCamera();
    closeSheet();
    if (!state.conn) view = viewConnect();
    else if (!state.session) view = viewSignIn();
    else {
      var parts = r.split('/');
      switch (parts[0]) {
        case 'leave': view = parts[1] === 'new' ? viewLeaveNew() : parts[1] === 'hist' ? viewLeaveHist(parts.slice(2).join('/')) : viewLeave(); break;
        case 'payslips': view = viewPayslips(); break;
        case 'docs': view = parts[1] === 'upload' ? viewUpload(parts[2]) : viewDocs(); break;
        case 'me': view = parts[1] === 'edit' ? viewProfileEdit() : parts[1] === 'bank' ? viewBankEdit() : parts[1] === 'photo' ? viewPhotoEdit() : parts[1] === 'tax' ? viewTaxEdit() : parts[1] === 'password' ? viewPassword() : viewProfile(); break;
        case 'meeting': view = viewMeeting(); break;
        case 'calendar': view = viewCalendar(); break;
        case 'requests': view = viewRequests(); break;
        case 'req': view = viewRequest(parts[1]); break;
        case 'team': view = viewTeam(); break;
        case 'appr': view = viewApproval(parts[1]); break;
        default: view = isMgrOnly() ? viewTeam() : viewHome();
      }
    }
    currentView = view;
    app.innerHTML = view.bare ? view.html : shell(view);
    if (view.after) view.after();
    window.scrollTo(0, 0);
  }

  // ---------- connect ----------
  var connectMode = 'start';
  function viewConnect() {
    var html = '<div class="welcome"><div class="lang">' + langToggle() + '</div>' +
      '<div class="logo app"><img src="kopano-icon.svg" alt="Kopano"></div><h1>' + h(t('welcomeTitle')) + '</h1><p class="mute">' + h(t('welcomeText')) + '</p>' + flashHtml();
    if (connectMode === 'paste') {
      html += '<form id="connectForm" novalidate><div class="field" style="margin-top:18px"><label for="code">' + h(t('connectionCode')) + '</label>' +
        '<textarea id="code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="KPE1.…"></textarea>' +
        '<div class="hint">' + h(t('connectionCodeHint')) + '</div><div id="codeErr"></div></div>' +
        '<div class="btns"><button class="btn primary block" type="submit">' + h(t('next')) + '</button>' +
        '<button class="btn block" type="button" data-act="connect-scan">' + icon('qr') + h(t('scanQr')) + '</button></div></form>';
    } else {
      html += '<p style="margin-top:18px">' + h(t('connectSteps')) + '</p><ol class="steps"><li>' + h(t('connectStep1')) + '</li><li>' +
        h(t('connectStep2')) + '</li><li>' + h(t('connectStep3')) + '</li></ol>' +
        '<div class="btns" style="margin-top:auto"><button class="btn primary block" type="button" data-act="connect-scan">' + icon('qr') + h(t('scanQr')) + '</button>' +
        '<button class="btn block" type="button" data-act="connect-paste">' + h(t('pasteCode')) + '</button></div>';
    }
    html += homeScreenTip() + '<p class="tiny mute" style="text-align:center;margin-top:18px">' + h(t('appVersion', { v: VERSION })) + '</p></div>';
    return {
      bare: true, form: connectMode === 'paste', html: html,
      after: function () {
        var f = document.getElementById('connectForm');
        if (!f) return;
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          if (!useConnectionCode(f.code.value)) {
            document.getElementById('codeErr').innerHTML = fieldErr(t('badCode'));
            f.code.classList.add('invalid');
          }
        });
      },
    };
  }
  // 1.52: in Safari (not yet on the home screen) say how to add it, so it opens like an app
  function homeScreenTip() {
    if (!IOS || STANDALONE) return '';
    return '<div class="card" style="margin-top:16px;text-align:left"><b>' + h(t('a2hsTitle')) + '</b><ol class="steps small" style="margin:6px 0 0">' +
      '<li>' + h(t('a2hs1')) + '</li><li>' + h(t('a2hs2')) + '</li><li>' + h(t('a2hs3')) + '</li></ol></div>';
  }
  // 1.52: a link to the web app carries the connection code: https://…/?c=KPE1.… (or #KPE1.… when pasted by hand).
  // The ?c= stays in the address on purpose: an iPhone keeps it when the page is added to the home screen, and the
  // home-screen app has its own storage, so it connects again from it on its first start.
  function codeFromLink() {
    var q = String(location.search || ''), hs = String(location.hash || '');
    try { q = decodeURIComponent(q); } catch (e) { /* keep it */ } // 1.54.1: _ may come as %5F (WhatsApp)
    var m = q.match(/[?&]j=[0-9A-Za-z.]+|KPE1\.[A-Za-z0-9_-]+/), inHash = false;
    if (!m) { m = hs.match(/KPE1\.[A-Za-z0-9_-]+/); inHash = !!m; }
    if (!m) return;
    if (inHash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }
    var c = parseConnectionCode(m[0]);
    if (!c) return;
    if (state.conn && state.conn.u === c.u && state.conn.w === c.w) return; // already connected to it
    // the home-screen app opens with the same link every time: someone who chose another company keeps it
    if (state.conn && STANDALONE && !inHash) return;
    var changed = !!state.conn;
    state.conn = c;
    store.set('conn', c);
    if (changed) { endSession(); state.lastLogin = ''; store.set('lastLogin', ''); }
    signMode = 'first';
  }
  function useConnectionCode(text) {
    var c = parseConnectionCode(text);
    if (!c) return false;
    var changed = !state.conn || state.conn.u !== c.u || state.conn.w !== c.w;
    state.conn = c;
    store.set('conn', c);
    if (changed) { endSession(); state.lastLogin = ''; store.set('lastLogin', ''); }
    signMode = 'first';
    connectMode = 'start';
    go('');
    return true;
  }

  // ---------- sign in ----------
  var signMode = store.get('activated', false) ? 'login' : 'first';
  function viewSignIn() {
    var first = signMode === 'first';
    var html = '<div class="welcome"><div class="lang">' + langToggle() + '</div>' + coLogoHtml(brand()) +
      '<h1>' + h(t('signInTo', { company: state.conn.n || brand().name || 'Kopano' })) + '</h1>' + flashHtml() +
      '<div class="seg" style="margin-top:14px"><button type="button" data-act="signmode" data-v="first" class="' + (first ? 'on' : '') + '">' + h(t('firstTime')) + '</button>' +
      '<button type="button" data-act="signmode" data-v="login" class="' + (first ? '' : 'on') + '">' + h(t('signIn')) + '</button></div>' +
      '<form id="signForm" novalidate>' +
      '<div class="field"><label for="login">' + h(t('login')) + '</label><input id="login" name="login" type="text" autocomplete="username" autocapitalize="off" value="' + h(state.lastLogin) + '">' + '<div data-err="login"></div></div>';
    if (first) {
      html += '<div class="field"><label for="acode">' + h(t('activationCode')) + '</label><input id="acode" name="acode" class="code" type="text" maxlength="12" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false">' +
        '<div class="hint">' + h(t('activationHint')) + '</div><div data-err="acode"></div></div>' +
        '<div class="field"><label for="pw">' + h(t('newPassword')) + '</label><input id="pw" name="pw" type="password" autocomplete="new-password"><div class="hint">' + h(t('newPasswordHint')) + '</div><div data-err="pw"></div></div>' +
        '<div class="field"><label for="pw2">' + h(t('confirmPassword')) + '</label><input id="pw2" name="pw2" type="password" autocomplete="new-password"><div data-err="pw2"></div></div>';
    } else {
      html += '<div class="field"><label for="pw">' + h(t('password')) + '</label><input id="pw" name="pw" type="password" autocomplete="current-password"><div data-err="pw"></div></div>';
    }
    html += '<div id="formErr"></div><div class="btns"><button class="btn primary block" type="submit">' + h(first ? t('activate') : t('signIn')) + '</button></div></form>' +
      (first ? '' : '<p class="small mute" style="margin-top:14px">' + h(t('forgotPassword')) + '</p>') + homeScreenTip() +
      '<p style="margin-top:auto;padding-top:24px;text-align:center"><button type="button" class="btn" data-act="other-company">' + h(t('otherCompany')) + '</button></p></div>';
    return {
      bare: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('signForm');
        f.addEventListener('submit', function (ev) { ev.preventDefault(); submitSignIn(f, first); });
      },
    };
  }
  function showErrors(form, errs) {
    form.querySelectorAll('[data-err]').forEach(function (el) {
      var k = el.getAttribute('data-err');
      el.innerHTML = fieldErr(errs[k]);
      var inp = form.querySelector('[name="' + k + '"]');
      if (inp) inp.classList.toggle('invalid', !!errs[k]);
    });
    var fe = form.querySelector('#formErr');
    if (fe) fe.innerHTML = errs._ ? '<div class="banner bad">' + h(errs._) + '</div>' : '';
    var firstBad = form.querySelector('.invalid');
    if (firstBad) firstBad.focus();
  }
  function busy(form, on) {
    var b = form.querySelector('button[type=submit]');
    if (!b) return;
    if (on) { b.dataset.label = b.textContent; b.textContent = t('sending'); b.disabled = true; }
    else { b.textContent = b.dataset.label || b.textContent; b.disabled = false; }
  }
  function deviceName() {
    try { if (NATIVE && NATIVE.deviceName) return NATIVE.deviceName(); } catch (e) { /* ignore */ }
    return 'Browser';
  }
  function submitSignIn(f, first) {
    var errs = {}, login = f.login.value.trim(), pw = f.pw.value;
    if (!login) errs.login = t('required');
    if (first) {
      var code = f.acode.value.replace(/[\s-]/g, '').toUpperCase();
      if (!code) errs.acode = t('required');
      if (pw.length < 8) errs.pw = t('passwordShort');
      else if (pw !== f.pw2.value) errs.pw2 = t('passwordMismatch');
    } else if (!pw) errs.pw = t('required');
    showErrors(f, errs);
    if (Object.keys(errs).length) return;
    busy(f, true);
    var call = first
      ? rpc('kp_emp_activate', { p_ws: state.conn.w, p_login: login, p_code: code, p_password: pw, p_device: deviceName() })
      : rpc('kp_emp_login', { p_ws: state.conn.w, p_login: login, p_password: pw, p_device: deviceName() });
    call.then(function (res) {
      if (!res || res.ok === false || !res.token) {
        busy(f, false);
        showErrors(f, { _: first ? t('wrongActivation') : t('wrongLogin') });
        return;
      }
      state.session = { token: res.token, expiresAt: res.expiresAt, name: res.name || '', login: login };
      store.set('session', state.session);
      state.lastLogin = login;
      store.set('lastLogin', login);
      store.set('activated', true);
      signMode = 'login';
      state.home = null;
      go('');
      loadHome();
      if (NATIVE && NATIVE.askNotifications) NATIVE.askNotifications();
    }, function (e) {
      busy(f, false);
      if (e.code === 'denied') showErrors(f, { _: first ? t('wrongActivation') : t('wrongLogin') });
      else if (e.code === 'bad' && /password/i.test(e.message)) showErrors(f, { pw: t('passwordShort') });
      else showErrors(f, { _: errorText(e) });
    });
  }

  // ---------- home ----------
  function upcomingItems(includePast) {
    var home = state.home || {}, items = [], td = todayISO();
    (home.appointments || []).forEach(function (a) { items.push({ kind: 'appt', date: a.date, time: a.time, title: a.title || t('appointment'), a: a }); });
    (home.reminders || []).forEach(function (r) { items.push({ kind: 'rem', date: r.date, time: r.time, title: r.title || t('reminder'), a: r }); });
    // a booked meeting shows even before HR publishes it as an appointment
    (home.requests || []).forEach(function (q) {
      var ap = q.status === 'scheduled' && q.response && q.response.appointment;
      if (!ap || !ap.date) return;
      var dup = (home.appointments || []).some(function (a) { return a.date === ap.date && (a.time || '') === (ap.time || ''); });
      if (!dup) items.push({ kind: 'appt', date: ap.date, time: ap.time, title: (q.payload && q.payload.topic) || t('kind_meeting'), a: ap });
    });
    items.sort(function (x, y) { return (x.date + (x.time || '')).localeCompare(y.date + (y.time || '')); });
    if (includePast) return items;
    return items.filter(function (x) { return x.date >= td; });
  }
  function itemRow(x) {
    var d = parseISO(x.date) || new Date();
    var bits = [], up = x.date >= todayISO();
    var ev = { title: x.title, date: x.date, time: x.time || '', place: x.a.place || '', with: x.a.with || '', note: x.a.note || '' };
    bits.push(fmtDate(x.date, { relative: true }) + (x.time ? ' · ' + h(x.time) : ''));
    if (x.a.with) bits.push(h(t('withWho', { who: x.a.with })));
    if (x.a.place) bits.push(h(t('at', { place: x.a.place })));
    var tag = up ? 'button' : 'div';
    return '<' + tag + (up ? ' type="button" data-act="cal-item" data-v="' + h(JSON.stringify(ev)) + '"' : '') + ' class="row"><div class="date-chip' + (x.kind === 'rem' ? ' rem' : '') + '"><b>' + d.getUTCDate() + '</b><span>' + h(D().mon[d.getUTCMonth()]) + '</span></div>' +
      '<div class="grow"><div><b>' + h(x.title) + '</b></div><div class="small mute">' + bits.join(' · ') + '</div>' +
      (x.a.note ? '<div class="small">' + h(x.a.note) + '</div>' : '') + '</div>' + (up ? icon('cal', 'chev') : '') + '</' + tag + '>';
  }
  // 1.25: an appointment or reminder in the phone's own calendar (Google Calendar, Samsung Calendar …)
  function askCalendar(ev) {
    var when = fmtDate(ev.date) + (ev.time ? ' ' + ev.time : '');
    sheet({
      title: t('calAskTitle'),
      html: '<div class="card" style="margin:10px 0 0"><b>' + h(ev.title) + '</b><div class="small mute">' + h(when) + (ev.place ? ' · ' + h(t('at', { place: ev.place })) : '') + '</div></div>',
      buttons: [{ label: t('calSave'), cls: 'primary', fn: function () { saveToCalendar(ev); } }, { label: t('cancel') }],
    });
  }
  function calEvent(ev) {
    var timed = /^\d\d:\d\d/.test(ev.time || '');
    var begin = timed ? saTime(ev.date, ev.time) : Date.parse(ev.date + 'T00:00:00Z');
    var text = [ev.with ? t('withWho', { who: ev.with }) : '', ev.note || ''].filter(Boolean).join('\n');
    return { title: ev.title, begin: begin, end: begin + (timed ? 3600000 : 86400000), allDay: !timed, place: ev.place || '', text: text };
  }
  function saveToCalendar(ev) {
    var c = calEvent(ev);
    if (NATIVE && NATIVE.addToCalendar) {
      if (!NATIVE.addToCalendar(JSON.stringify(c))) toast(t('calNone'));
      return;
    }
    // in a browser: an .ics file
    var z = function (ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); };
    var esc = function (v) { return String(v || '').replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n'); };
    var day = function (ms) { return new Date(ms).toISOString().slice(0, 10).replace(/-/g, ''); };
    var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kopano Payroll//Employee//EN', 'BEGIN:VEVENT', 'UID:' + c.begin + '-' + Math.random().toString(36).slice(2) + '@kopano',
      'DTSTAMP:' + z(Date.now()), c.allDay ? 'DTSTART;VALUE=DATE:' + day(c.begin) : 'DTSTART:' + z(c.begin), c.allDay ? 'DTEND;VALUE=DATE:' + day(c.end) : 'DTEND:' + z(c.end),
      'SUMMARY:' + esc(c.title), c.place ? 'LOCATION:' + esc(c.place) : '', c.text ? 'DESCRIPTION:' + esc(c.text) : '', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
    var a = document.createElement('a');
    if (IOS) {
      // Safari opens a calendar file with "Add to Calendar"; a data: link also works from the home-screen app
      a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
      document.body.appendChild(a); a.click(); a.remove();
      return;
    }
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = 'appointment.ics';
    document.body.appendChild(a); a.click(); a.remove();
    toast(t('calFile'));
  }
  function requestSummary(q) {
    var p = q.payload || {};
    switch (q.kind) {
      case 'leave':
        return leaveTypeName(p.type) + ' · ' + fmtDate(p.from, { weekday: false }) + (p.to && p.to !== p.from ? ' – ' + fmtDate(p.to, { weekday: false }) : '') + (p.halfDay ? ' (' + t('halfDayShort') + ')' : '');
      case 'profile': return Object.keys(p.changes || {}).map(function (k) { return t(fieldLabelKey(k)); }).join(', ');
      case 'meeting': return p.topic || '';
      case 'document': return p.name || '';
    }
    return '';
  }
  // 1.25: messages from HR the employee has not opened yet (the last one seen is kept per request on the phone)
  function unreadCount(q) {
    var seen = (store.get('seenMsg', {}) || {})[q.id] || 0;
    return (q.messages || []).filter(function (m) { return m.from === 'hr' && m.id > seen; }).length;
  }
  function markSeen(q) {
    var last = 0;
    (q.messages || []).forEach(function (m) { if (m.from === 'hr' && m.id > last) last = m.id; });
    var map = store.get('seenMsg', {}) || {};
    if (last && map[q.id] !== last) { map[q.id] = last; store.set('seenMsg', map); }
  }
  function requestRow(q) {
    var un = unreadCount(q);
    return '<button type="button" class="row" data-act="open-req" data-v="' + h(q.id) + '"><div class="grow"><div><b>' + h(t('kind_' + q.kind)) + '</b></div>' +
      '<div class="small mute">' + h(requestSummary(q)) + '</div>' + (un ? '<div class="small" style="color:var(--info);font-weight:600">' + h(t('newMessage')) + ' (' + un + ')</div>' : '') +
      '</div><div class="end">' + reqBadge(q) + '</div>' + icon('chev', 'chev') + '</button>';
  }
  function viewHome() {
    var home = state.home || {}, emp = home.employee || {}, sess = state.session || {};
    var name = (emp.name || sess.name || '').split(' ')[0];
    var html = '<div class="hello">' + (emp.photo ? '<button type="button" class="avbtn" data-act="go" data-v="me">' + avatarHtml(emp, 48) + '</button>' : '') + '<div><h1>' + h(t('hello', { name: name })) + '</h1>' +
      (state.homeAt ? '<p class="tiny mute">' + h(t('updated', { when: fmtStamp(state.homeAt) })) + '</p>' : '') + '</div></div>';
    if (!state.home && state.loading) return { title: t('appName'), html: html + '<div class="loading">' + h(t('loading')) + '</div>' };

    var nAp = waitingApprovals().length;
    if (isMgr() && nAp) html += '<button type="button" class="banner warn" style="display:block;width:100%;text-align:left;border:0;font:inherit" data-act="go" data-v="team"><b>' + h(t('toApproveBanner', { n: nAp })) + '</b></button>';
    var docs = home.documentsRequested || [];
    if (docs.length) {
      html += '<h2>' + h(t('docsWanted')) + '</h2><div class="list">' + docs.map(docRequestRow).join('') + '</div>';
    }
    html += '<div class="actions" style="margin-top:16px">' +
      '<button type="button" class="action" data-act="go" data-v="leave/new">' + icon('leave') + '<b>' + h(t('quickLeave')) + '</b></button>' +
      '<button type="button" class="action" data-act="go" data-v="meeting">' + icon('meet') + '<b>' + h(t('quickMeeting')) + '</b></button>' +
      '<button type="button" class="action" data-act="go" data-v="docs/upload">' + icon('docs') + '<b>' + h(t('quickUpload')) + '</b></button>' +
      '<button type="button" class="action" data-act="latest-payslip">' + icon('pay') + '<b>' + h(t('quickPayslip')) + '</b></button></div>';

    var leave = home.leave || [];
    if (leave.length) {
      html += '<h2>' + h(t('leaveBalances')) + '</h2><div class="tiles">' + leave.slice(0, 4).map(function (l) {
        return leaveTile(l);
      }).join('') + '</div>';
    }

    var up = upcomingItems(false);
    html += '<h2 style="display:flex;justify-content:space-between;align-items:baseline">' + h(t('comingUp')) +
      ' <a href="#calendar" class="small" style="font-weight:600">' + h(t('seeAll')) + '</a></h2><div class="list">' +
      (up.length ? up.slice(0, 4).map(itemRow).join('') : '<div class="empty">' + h(t('nothingComingUp')) + '</div>') + '</div>';

    var reqs = (home.requests || []).slice().sort(function (a, b) { return (unreadCount(b) ? 1 : 0) - (unreadCount(a) ? 1 : 0); });
    html += '<h2 style="display:flex;justify-content:space-between;align-items:baseline">' + h(t('myRequests')) +
      (reqs.length > 5 ? ' <a href="#requests" class="small" style="font-weight:600">' + h(t('seeAll')) + '</a>' : '') + '</h2><div class="list">' +
      (reqs.length ? reqs.slice(0, 5).map(requestRow).join('') : '<div class="empty">' + h(t('noRequests')) + '</div>') + '</div>';
    return { title: t('appName'), html: html };
  }
  function viewCalendar() {
    var all = upcomingItems(true), td = todayISO(), cut = addDays(td, -60);
    var up = all.filter(function (x) { return x.date >= td; }), past = all.filter(function (x) { return x.date < td && x.date >= cut; }).reverse();
    var html = '<h2>' + h(t('upcoming')) + '</h2><div class="list">' + (up.length ? up.map(itemRow).join('') : '<div class="empty">' + h(t('nothingComingUp')) + '</div>') + '</div>';
    if (past.length) html += '<h2>' + h(t('past')) + '</h2><div class="list">' + past.map(itemRow).join('') + '</div>';
    html += '<div class="btns"><button type="button" class="btn block" data-act="go" data-v="meeting">' + icon('meet') + h(t('quickMeeting')) + '</button></div>';
    return { title: t('calendar'), back: true, html: html };
  }
  function viewRequests() {
    var reqs = (state.home && state.home.requests) || [];
    return { title: t('myRequests'), back: true, html: '<div class="list">' + (reqs.length ? reqs.map(requestRow).join('') : '<div class="empty">' + h(t('noRequests')) + '</div>') + '</div>' };
  }

  // ---------- leave ----------
  // 1.51: a balance tile opens that leave type's last 10 approved requests (upcoming and taken)
  function leaveTile(l) {
    var unit = l.unit === 'hours' ? t('unitHours') : t('unitDays');
    var open = '<button type="button" class="tile" data-act="go" data-v="leave/hist/' + h(encodeURIComponent(l.type)) + '">';
    var more = '<div class="more">' + h(t('seeLeaveHist')) + icon('chev', 'chev') + '</div></button>';
    if (l.balance == null) {
      return open + '<div class="v num">' + h(num(l.taken || 0)) + '</div><div class="l">' + h(leaveName(l.type, l.name)) + ' · ' + h(t('takenUnit', { unit: unit })) + '</div>' + more;
    }
    return open + '<div class="v num">' + h(num(l.balance)) + '</div><div class="l">' + h(leaveName(l.type, l.name)) + ' · ' + h(unit) + '</div>' + more;
  }
  // the desktop (1.51+) publishes l.history: the last 10 approved, captured by HR or asked for in the app.
  // From an older desktop: the approved requests sent from this app.
  function leaveHist(type) {
    var home = state.home || {}, l = (home.leave || []).filter(function (x) { return x.type === type; })[0], list;
    if (l && Array.isArray(l.history)) list = l.history.slice();
    else {
      list = (home.requests || []).filter(function (q) { return q.kind === 'leave' && q.status === 'approved' && q.payload && q.payload.type === type; }).map(function (q) {
        var p = q.payload; return { from: p.from, to: p.to || p.from, days: p.days != null ? p.days : null, half: !!p.halfDay, reason: p.reason || '' };
      });
    }
    list = list.filter(function (x) { return x && x.from; });
    list.sort(function (a, b) { return String(b.from).localeCompare(String(a.from)); });
    return list.slice(0, 10);
  }
  function leaveHistRow(x, td) {
    var d = parseISO(x.from) || new Date(), to = x.to || x.from, now = x.from <= td && to >= td;
    var when = fmtDate(x.from, { weekday: false }) + (to !== x.from ? ' – ' + fmtDate(to, { weekday: false }) : '');
    var n = x.half ? t('halfDayShort') : x.days == null || x.days === '' ? '' : Number(x.days) === 1 ? t('day') : t('days', { n: num(x.days) });
    return '<div class="row"><div class="date-chip"><b>' + d.getUTCDate() + '</b><span>' + h(D().mon[d.getUTCMonth()]) + '</span></div>' +
      '<div class="grow"><div><b>' + h(when) + '</b></div>' + (n ? '<div class="small mute">' + h(n) + '</div>' : '') +
      (x.reason ? '<div class="small">' + h(x.reason) + '</div>' : '') + '</div>' +
      (now ? '<div class="end"><span class="badge st-approved">' + h(t('onLeaveNow')) + '</span></div>' : '') + '</div>';
  }
  function viewLeaveHist(type) {
    var home = state.home || {}, td = todayISO(), list = leaveHist(type);
    var up = list.filter(function (x) { return (x.to || x.from) >= td; }).reverse(), past = list.filter(function (x) { return (x.to || x.from) < td; });
    var l = (home.leave || []).filter(function (x) { return x.type === type; })[0];
    var html = '';
    if (l) html += '<div class="tiles one">' + leaveTile(l).replace(/^<button[^>]*>/, '<div class="tile">').replace(/<div class="more">[\s\S]*<\/button>$/, '</div>') + '</div>';
    html += '<p class="small mute">' + h(t('leaveHistNote')) + '</p>';
    if (!list.length) html += '<div class="list"><div class="empty">' + h(t('noLeaveHist')) + '</div></div>';
    else {
      html += '<h2>' + h(t('upcoming')) + '</h2><div class="list">' + (up.length ? up.map(function (x) { return leaveHistRow(x, td); }).join('') : '<div class="empty">' + h(t('noUpcomingLeave')) + '</div>') + '</div>';
      if (past.length) html += '<h2>' + h(t('leaveTaken')) + '</h2><div class="list">' + past.map(function (x) { return leaveHistRow(x, td); }).join('') + '</div>';
    }
    html += '<div class="btns"><button type="button" class="btn block" data-act="apply-type" data-v="' + h(type) + '">' + icon('leave') + h(t('applyLeave')) + '</button></div>';
    return { title: leaveTypeName(type), back: true, html: html };
  }
  function viewLeave() {
    var home = state.home || {}, leave = home.leave || [];
    var html = '';
    if (leave.length) {
      html += '<div class="tiles">' + leave.map(function (l) {
        return leaveTile(l);
      }).join('') + '</div>';
    }
    html += '<button type="button" class="btn primary block" data-act="go" data-v="leave/new">' + icon('leave') + h(t('applyLeave')) + '</button>';
    var reqs = (home.requests || []).filter(function (q) { return q.kind === 'leave'; });
    html += '<h2>' + h(t('leaveHistory')) + '</h2><div class="list">' + (reqs.length ? reqs.map(requestRow).join('') : '<div class="empty">' + h(t('noRequests')) + '</div>') + '</div>';
    return { title: t('leaveTitle'), html: html };
  }
  var leaveDraft = null;
  function viewLeaveNew() {
    var home = state.home || {}, types = home.leaveTypes || [];
    if (!types.length) {
      return { title: t('applyLeave'), back: true, html: '<div class="banner info">' + h(t('notPublished')) + '</div>' };
    }
    var d = leaveDraft || (leaveDraft = { type: types[0].type, from: '', to: '', halfDay: false, reason: '' });
    var html = '<form id="leaveForm" novalidate>' +
      '<div class="field"><label for="ltype">' + h(t('leaveType')) + '</label><select id="ltype" name="type">' + types.map(function (x) {
        return '<option value="' + h(x.type) + '"' + (x.type === d.type ? ' selected' : '') + '>' + h(leaveName(x.type, x.name)) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="two"><div class="field"><label for="lfrom">' + h(t('fromDate')) + '</label><input id="lfrom" name="from" type="date" value="' + h(d.from) + '"><div data-err="from"></div></div>' +
      '<div class="field"><label for="lto">' + h(t('toDate')) + '</label><input id="lto" name="to" type="date" value="' + h(d.to) + '"><div data-err="to"></div></div></div>' +
      '<label class="check field" id="halfRow"><input type="checkbox" name="halfDay"' + (d.halfDay ? ' checked' : '') + '> ' + h(t('halfDay')) + '</label>' +
      '<div id="leaveSummary"></div>' +
      '<div class="field"><label for="lreason" id="reasonLabel">' + h(t('reason')) + '</label><textarea id="lreason" name="reason" maxlength="1000">' + h(d.reason) + '</textarea><div data-err="reason"></div></div>' +
      '<div id="proofRow"><span class="label">' + h(t('proofTitle')) + '</span><p class="hint" style="margin:0 0 10px">' + h(t('proofHint')) + '</p>' + pickerHtml() + '</div>' +
      '<div id="formErr"></div><div class="btns"><button type="submit" class="btn primary block">' + h(t('sendRequest')) + '</button></div></form>';
    upload = null;
    return {
      title: t('applyLeave'), back: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('leaveForm');
        wirePicker(f);
        function sync() {
          d.type = f.type.value; d.from = f.from.value; d.reason = f.reason.value;
          if (d.from && (!f.to.value || f.to.value < d.from) && document.activeElement !== f.to) f.to.value = d.from;
          d.to = f.to.value;
          var single = d.from && d.from === d.to;
          document.getElementById('halfRow').classList.toggle('hidden', !single);
          if (!single) f.halfDay.checked = false;
          d.halfDay = f.halfDay.checked;
          document.getElementById('leaveSummary').innerHTML = leaveSummary(d);
          document.getElementById('reasonLabel').textContent = /sick/i.test(d.type) ? t('reasonSick') : t('reason');
          document.getElementById('proofRow').classList.toggle('hidden', isAnnual(d.type));
        }
        f.addEventListener('input', sync);
        f.addEventListener('change', sync);
        sync();
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          sync();
          var errs = {};
          if (!d.from) errs.from = t('required');
          if (!d.to) errs.to = t('required');
          else if (d.from && d.to < d.from) errs.to = t('endBeforeStart');
          if (/sick/i.test(d.type) && !d.reason.trim()) errs.reason = t('required');
          showErrors(f, errs);
          if (Object.keys(errs).length) return;
          // 1.25: any leave except annual leave: ask for proof (a doctor's note …) before it is sent
          if (!isAnnual(d.type) && !upload) {
            sheet({
              title: t('proofAskTitle'), text: t('proofAskText', { type: leaveTypeName(d.type) }),
              buttons: [{ label: t('takePhoto'), cls: 'primary', fn: function () { openCamera('photo'); } },
                { label: t('chooseFile'), fn: function () { document.getElementById('ufile').click(); } },
                { label: t('sendWithout'), fn: send }],
            });
            return;
          }
          send();
        });
        function send() {
          var payload = { type: d.type, from: d.from, to: d.to, halfDay: !!d.halfDay, reason: d.reason.trim() };
          if (!isAnnual(d.type) && upload) payload.attachment = attachmentOf(upload, /sick/i.test(d.type) ? 'Medical certificate' : 'Leave proof');
          busy(f, true);
          rpcT('kp_emp_request', { p_kind: 'leave', p_payload: payload }, payload.attachment ? 180000 : 30000).then(function (res) {
            leaveDraft = null;
            upload = null;
            state.flash = { kind: 'ok', text: t(res && res.manager ? 'sentToManager' : 'leaveSent') };
            go('leave');
            loadHome(true);
          }, function (e) { busy(f, false); showErrors(f, { _: errorText(e) }); });
        }
      },
    };
  }
  function isAnnual(type) {
    if (/annual|jaarliks/i.test(type || '')) return true;
    var lt = (((state.home || {}).leaveTypes) || []).filter(function (x) { return x.type === type; })[0];
    return !!(lt && /annual|jaarliks/i.test(lt.name || ''));
  }
  function leaveSummary(d) {
    if (!d.from || !d.to) return '';
    if (d.to < d.from) return '';
    var n = d.halfDay ? 0.5 : kpWorkingDays(d.from, d.to);
    var parts = [];
    if (!n) return '<div class="summary">' + h(t('noWorkingDays')) + '</div>';
    parts.push('<b>' + h(d.halfDay ? t('halfDayCount') : n === 1 ? t('workingDay') : t('workingDays', { n: n })) + '</b>');
    var bal = ((state.home && state.home.leave) || []).filter(function (l) { return l.type === d.type; })[0];
    if (bal && (bal.unit || 'days') === 'days' && bal.balance != null && bal.balance !== '' && isFinite(Number(bal.balance))) {
      var after = Number(bal.balance) - n;
      parts.push(h(t('balanceAfter', { now: num(bal.balance), after: num(after) })));
      if (after < 0) parts.push('<span style="color:var(--warn)">' + h(t('overBalance')) + '</span>');
    }
    if (/sick/i.test(d.type) && n > 2) parts.push(h(t('sickNote')));
    return '<div class="summary">' + parts.join('<br>') + '</div>';
  }

  // ---------- payslips ----------
  function viewPayslips() {
    var list = (state.home && state.home.payslips) || [];
    var html = '<div class="list">' + (list.length ? list.map(function (p) {
      return '<div class="row"><div class="grow"><div><b>' + h(p.period || p.payDate) + '</b></div>' +
        '<div class="small mute">' + (p.payDate ? h(t('paid', { date: fmtDate(p.payDate, { weekday: false }) })) : '') +
        (p.gross != null ? ' · ' + h(t('gross')) + ' ' + h(money(p.gross)) : '') + '</div>' +
        (p.net != null ? '<div class="num"><b>' + h(t('net')) + ' ' + h(money(p.net)) + '</b></div>' : '') + '</div>' +
        '<div class="end" style="display:flex;gap:4px">' +
        '<button type="button" class="icon-btn" style="color:var(--accent)" data-act="payslip" data-mode="share" data-v="' + h(p.id) + '" aria-label="' + h(t('share')) + '">' + icon('share') + '</button>' +
        '<button type="button" class="btn" data-act="payslip" data-mode="open" data-v="' + h(p.id) + '">' + h(t('open')) + '</button></div></div>';
    }).join('') : '<div class="empty">' + h(t('noPayslips')) + '</div>') + '</div>';
    return { title: t('payslipsTitle'), html: html };
  }
  var payslipBusy = false;
  function getPayslip(id, mode) {
    if (payslipBusy) return;
    var p = ((state.home && state.home.payslips) || []).filter(function (x) { return x.id === id; })[0] || {};
    payslipBusy = true;
    toast(t('downloading'));
    rpcT('kp_emp_payslip', { p_id: id }, 60000).then(function (res) {
      payslipBusy = false;
      document.getElementById('toast').classList.remove('show');
      // the server calls a payslip without its own name "payslip.pdf": name it after the period instead
      var name = res.name && res.name !== 'payslip.pdf' ? res.name : 'Payslip ' + String(p.period || p.payDate || id).replace(/[^\w -]+/g, '').trim() + '.pdf';
      if (!/\.pdf$/i.test(name)) name += '.pdf';
      deliverFile(name, res.mime || 'application/pdf', res.data, mode);
    }, function (e) { payslipBusy = false; if (e.code !== 'expired') toast(errorText(e)); });
  }
  function deliverFile(name, mime, base64, mode) {
    if (NATIVE && NATIVE.saveFile) {
      var where = NATIVE.saveFile(name, mime, base64);
      if (!where) { toast(t('serverError', { msg: 'save' })); return; }
      var ok = mode === 'share' ? NATIVE.shareFile(name, mime, name) : NATIVE.openFile(name, mime);
      if (!ok && mode !== 'share') toast(t('noViewer'));
      else if (where === 'downloads' && mode !== 'share') toast(t('savedDownloads'));
      return;
    }
    // browser: the download took a while, so Safari no longer counts it as a tap: ask with a sheet, whose button is one
    var bin = atob(base64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var blob = new Blob([bytes], { type: mime });
    var file = null;
    try { file = new File([blob], name, { type: mime }); } catch (e) { /* old browser */ }
    var canShare = !!(file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
    var buttons = [{ label: t('openFile'), cls: mode === 'share' && canShare ? '' : 'primary', fn: function () { openBlob(blob, name); } }];
    if (canShare) buttons.push({ label: t('shareSave'), cls: mode === 'share' ? 'primary' : '', fn: function () { navigator.share({ files: [file], title: name }).catch(function () { /* closed */ }); } });
    buttons.push({ label: t('cancel') });
    if (mode === 'share' && canShare) buttons.unshift(buttons.splice(1, 1)[0]);
    sheet({ title: name, text: t('fileReady'), buttons: buttons });
  }
  function openBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var w = null;
    if (IOS) { try { w = window.open(url, '_blank'); } catch (e) { w = null; } } // Safari shows a PDF with its own Share / Done
    if (!w) { var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  }

  // ---------- documents ----------
  function docRequestRow(d) {
    var td = todayISO(), late = d.due && d.due < td;
    var sent = ((state.home && state.home.requests) || []).some(function (q) {
      return q.kind === 'document' && q.status === 'pending' && q.payload && q.payload.requestedId === d.id;
    });
    if (sent) {
      return '<button type="button" class="row" data-act="go" data-v="docs/upload/' + h(encodeURIComponent(d.id)) + '"><div class="grow"><div><b>' + h(d.name) + '</b></div>' +
        '<div class="small mute">' + h(t('sentWaiting')) + '</div></div>' + statusBadge('pending') + '</button>';
    }
    return '<button type="button" class="row" data-act="go" data-v="docs/upload/' + h(encodeURIComponent(d.id)) + '"><div class="grow"><div><b>' + h(d.name) + '</b></div>' +
      (d.note ? '<div class="small mute">' + h(d.note) + '</div>' : '') +
      (d.due ? '<div class="small" style="color:var(--' + (late ? 'bad' : 'warn') + ')">' + h(late ? t('overdue', { date: fmtDate(d.due, { weekday: false }) }) : t('due', { date: fmtDate(d.due, { weekday: false }) })) + '</div>' : '') +
      '</div>' + icon('docs', 'chev') + '</button>';
  }
  function viewDocs() {
    var home = state.home || {}, docs = home.documentsRequested || [];
    var html = '';
    if (docs.length) html += '<h2 style="margin-top:4px">' + h(t('requestedDocs')) + '</h2><div class="list">' + docs.map(docRequestRow).join('') + '</div>';
    html += '<button type="button" class="btn primary block" data-act="go" data-v="docs/upload">' + icon('docs') + h(t('uploadDoc')) + '</button>';
    var ups = (home.requests || []).filter(function (q) { return q.kind === 'document'; });
    html += '<h2>' + h(t('myUploads')) + '</h2><div class="list">' + (ups.length ? ups.map(requestRow).join('') : '<div class="empty">' + h(t('noRequests')) + '</div>') + '</div>';
    return { title: t('documentsTitle'), html: html };
  }
  var CATS = [['ID', 'catID'], ['Bank', 'catBank'], ['Medical', 'catMedical'], ['Qualification', 'catQualification'], ['Tax', 'catTax'],
    ['Contract', 'catContract'], ['Address', 'catAddress'], ['Other', 'catOther']];
  var upload = null; // {name, mime, data (base64), size, preview}
  function guessCategory(name) {
    var n = String(name || '').toLowerCase();
    if (/\bid\b|identity|passport|paspoort/.test(n)) return 'ID';
    if (/bank/.test(n)) return 'Bank';
    if (/medic|doctor|dokter|sick|siek/.test(n)) return 'Medical';
    if (/tax|belasting|irp5/.test(n)) return 'Tax';
    if (/qualif|certif|matric|diploma|degree/.test(n)) return 'Qualification';
    if (/address|adres/.test(n)) return 'Address';
    return 'Other';
  }
  function viewUpload(reqId) {
    reqId = reqId ? decodeURIComponent(reqId) : '';
    var wanted = ((state.home && state.home.documentsRequested) || []).filter(function (d) { return d.id === reqId; })[0];
    var cat = wanted ? guessCategory(wanted.name) : 'Other';
    var html = '<form id="upForm" novalidate>';
    if (wanted) html += '<div class="card"><b>' + h(wanted.name) + '</b>' + (wanted.note ? '<p class="small mute">' + h(wanted.note) + '</p>' : '') +
      (wanted.due ? '<p class="small">' + h(t('due', { date: fmtDate(wanted.due, { weekday: false }) })) + '</p>' : '') + '</div>';
    else html += '<div class="field"><label for="ucat">' + h(t('category')) + '</label><select id="ucat" name="category">' + CATS.map(function (c) {
      return '<option value="' + c[0] + '"' + (c[0] === cat ? ' selected' : '') + '>' + h(t(c[1])) + '</option>';
    }).join('') + '</select></div>';
    html += pickerHtml() +
      '<div class="field" style="margin-top:14px"><label for="unote">' + h(t('noteOptional')) + '</label><textarea id="unote" name="note" maxlength="1000"></textarea></div>' +
      '<div id="formErr"></div><div class="btns"><button type="submit" class="btn primary block">' + h(t('sendDocument')) + '</button></div></form>';
    upload = null;
    return {
      title: wanted ? t('uploadFor', { name: wanted.name }) : t('uploadDoc'), back: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('upForm');
        wirePicker(f);
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          if (!upload) { showErrors(f, { _: t('chooseFirst') }); return; }
          busy(f, true);
          var payload = { name: upload.name, mime: upload.mime, category: wanted ? (wanted.name || cat) : f.category.value, note: f.note.value.trim(), data: upload.data };
          if (wanted) payload.requestedId = wanted.id;
          rpcT('kp_emp_request', { p_kind: 'document', p_payload: payload }, 180000).then(function () {
            upload = null;
            state.flash = { kind: 'ok', text: t('documentSent') };
            go('docs');
            loadHome(true);
          }, function (e) { busy(f, false); showErrors(f, { _: errorText(e) }); });
        });
      },
    };
  }
  // a photo or a file: the preview, "Take a photo" and "Choose a file" (one per screen; the file is in `upload`)
  function pickerHtml() {
    return '<div id="preview"></div><div class="two" id="pickBtns">' +
      '<button type="button" class="btn" data-act="photo">' + icon('camera') + h(t('takePhoto')) + '</button>' +
      '<label class="btn" style="margin:0">' + icon('file') + h(t('chooseFile')) + '<input type="file" id="ufile" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" class="hidden"></label></div>';
  }
  function wirePicker(f) {
    document.getElementById('ufile').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (file) readFile(file).then(setUpload, function (e) { showErrors(f, { _: e.message }); });
    });
  }
  function attachmentOf(u, category) { return u ? { name: u.name, mime: u.mime, data: u.data, category: category } : null; }
  function setUpload(u) {
    if (document.getElementById('photoForm')) {
      squarePhoto(u).then(function (sq) {
        upload = sq;
        var pv = document.getElementById('photoPrev');
        if (pv) pv.innerHTML = '<img class="avatar" alt="" src="' + sq.preview + '" width="160" height="160">';
        var fe0 = document.getElementById('formErr');
        if (fe0) fe0.innerHTML = '';
      }, function () { toast(t('fileType')); });
      return;
    }
    upload = u;
    var el = document.getElementById('preview');
    if (!el) return;
    var kb = u.size > 1048576 ? (u.size / 1048576).toFixed(1).replace('.', D().dec) + ' MB' : Math.max(1, Math.round(u.size / 1024)) + ' KB';
    el.innerHTML = '<div class="preview">' + (u.preview ? '<img alt="" src="' + u.preview + '">' : '<div class="fileicon">PDF</div>') +
      '<div class="grow" style="min-width:0"><div style="overflow:hidden;text-overflow:ellipsis"><b>' + h(u.name) + '</b></div><div class="small mute">' + kb + '</div></div></div>';
    var fe = document.getElementById('formErr');
    if (fe) fe.innerHTML = '';
  }
  function b64FromBuffer(buf) {
    var bytes = new Uint8Array(buf), out = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(out);
  }
  function readFile(file) {
    var type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
    if (type === 'application/pdf') {
      if (file.size > MAX_UPLOAD) return Promise.reject(new Error(t('fileTooBig')));
      return file.arrayBuffer().then(function (buf) { return { name: file.name, mime: 'application/pdf', size: file.size, data: b64FromBuffer(buf) }; });
    }
    if (!/^image\//.test(type)) return Promise.reject(new Error(t('fileType')));
    return loadImage(file).then(function (img) { return compressImage(img, file.name); }, function () {
      // a picture the WebView cannot show (e.g. HEIC on older phones): send it as it is if small enough
      if (file.size > MAX_UPLOAD) throw new Error(t('fileTooBig'));
      return file.arrayBuffer().then(function (buf) { return { name: file.name, mime: type, size: file.size, data: b64FromBuffer(buf) }; });
    });
  }
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }
  /** Photos are made smaller (at most 2000 pixels on the long side, JPEG) so they upload quickly and stay under 5 MB. */
  function compressImage(src, name) {
    var w = src.naturalWidth || src.videoWidth || src.width, hgt = src.naturalHeight || src.videoHeight || src.height;
    var scale = Math.min(1, 2000 / Math.max(w, hgt));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(hgt * scale));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    var q = 0.85, url = c.toDataURL('image/jpeg', q);
    while (url.length * 0.75 > MAX_UPLOAD * 0.9 && q > 0.35) { q -= 0.15; url = c.toDataURL('image/jpeg', q); }
    var data = url.slice(url.indexOf(',') + 1), size = Math.floor(data.length * 0.75);
    if (size > MAX_UPLOAD) return Promise.reject(new Error(t('fileTooBig')));
    // a small preview
    var pc = document.createElement('canvas'), ps = 128 / Math.max(c.width, c.height);
    pc.width = Math.round(c.width * ps); pc.height = Math.round(c.height * ps);
    pc.getContext('2d').drawImage(c, 0, 0, pc.width, pc.height);
    var base = String(name || 'photo').replace(/\.[^.]*$/, '') || 'photo';
    return Promise.resolve({ name: base + '.jpg', mime: 'image/jpeg', size: size, data: data, preview: pc.toDataURL('image/jpeg', 0.7) });
  }

  // ---------- camera: QR codes and photos of documents ----------
  var cam = null; // {stream, el, timer}
  function openCamera(mode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { cameraFailed(mode); return; }
    var el = document.createElement('div');
    el.className = 'camera' + (mode === 'selfie' ? ' selfie' : '');
    el.innerHTML = '<video playsinline muted autoplay></video>' + (mode === 'qr' ? '<div class="frame"></div><div class="msg">' + h(t('scanTitle')) + '</div>' : '') +
      '<div class="bar"><button type="button" class="btn" data-act="cam-close">' + h(t('cancel')) + '</button>' +
      (mode === 'photo' || mode === 'selfie' ? '<button type="button" class="shutter" data-act="cam-shoot" aria-label="' + h(t('takePhoto')) + '"></button><span style="width:90px"></span>' : '') + '</div>';
    document.body.appendChild(el);
    cam = { el: el, mode: mode, stream: null, timer: null };
    var video = el.querySelector('video');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: mode === 'selfie' ? 'user' : 'environment' }, width: { ideal: mode === 'photo' ? 2560 : 1280 }, height: { ideal: mode === 'photo' ? 1920 : 720 } }, audio: false })
      .then(function (stream) {
        if (!cam || cam.el !== el) { stream.getTracks().forEach(function (tr) { tr.stop(); }); return; }
        cam.stream = stream;
        video.srcObject = stream;
        return video.play().catch(function () { /* autoplay may need a tap */ }).then(function () { if (mode === 'qr') scanLoop(video); });
      })
      .catch(function () { closeCamera(); cameraFailed(mode); });
  }
  function cameraFailed(mode) {
    toast(t('noCamera'));
    if (mode === 'qr') { connectMode = 'paste'; render(); }
  }
  function closeCamera() {
    if (!cam) return;
    clearTimeout(cam.timer);
    if (cam.stream) cam.stream.getTracks().forEach(function (tr) { tr.stop(); });
    cam.el.remove();
    cam = null;
  }
  function scanLoop(video) {
    var c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    function tick() {
      if (!cam || cam.mode !== 'qr') return;
      if (video.videoWidth && window.jsQR) {
        var s = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
        c.width = Math.round(video.videoWidth * s); c.height = Math.round(video.videoHeight * s);
        ctx.drawImage(video, 0, 0, c.width, c.height);
        var img = ctx.getImageData(0, 0, c.width, c.height);
        var found = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if (found && found.data) {
          if (parseConnectionCode(found.data)) {
            if (navigator.vibrate) navigator.vibrate(60);
            closeCamera();
            useConnectionCode(found.data);
            return;
          }
          toast(t('badCode'));
        }
      }
      cam.timer = setTimeout(tick, 250);
    }
    tick();
  }
  function shootPhoto() {
    if (!cam || !cam.stream) return;
    var video = cam.el.querySelector('video');
    if (!video.videoWidth) return;
    var stamp = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    var p = compressImage(video, 'photo-' + stamp);
    closeCamera();
    p.then(setUpload, function (e) { toast(e.message); });
  }

  // ---------- profile ----------
  var FIELD_LABELS = { cell: 'cell', email: 'email', workPhone: 'workPhone', address: 'address', postal: 'postal', emergency: 'emergency', bank: 'bankTitle', photo: 'photo', taxNo: 'taxNo' };
  // the details the "Request a change" form has (bank, photo and tax number have their own screens)
  var FORM_FIELDS = ['cell', 'email', 'workPhone', 'address', 'postal', 'emergency'];
  function fieldLabelKey(k) { return FIELD_LABELS[k] || k; }
  function kv(rows) {
    rows = rows.filter(function (r) { return r[1] != null && String(r[1]).trim() !== ''; });
    if (!rows.length) return '<p class="mute small">—</p>';
    return '<dl class="kv">' + rows.map(function (r) { return '<dt>' + h(t(r[0])) + '</dt><dd>' + (r[2] ? r[1] : h(r[1])) + '</dd>'; }).join('') + '</dl>';
  }
  // 1.53: the company the employee works for: its trading name (or the company), and its logo from Kopano Payroll
  function brand() {
    var emp = (state.home && state.home.employee) || {}, kept = store.get('brand', null) || {};
    var same = kept.u && state.conn && kept.u === state.conn.u;
    var name = emp.tradingAs || emp.entity || emp.company || (same && kept.name) || (state.conn && state.conn.n) || '';
    var logo = String(emp.logo || (same && !state.home ? kept.logo : '') || '');
    return { name: name, logo: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(logo) ? logo : '' };
  }
  function keepBrand() {
    var emp = (state.home && state.home.employee) || {};
    if (state.conn && (emp.entity || emp.company)) store.set('brand', { u: state.conn.u, name: emp.tradingAs || emp.entity || emp.company, logo: String(emp.logo || '') });
  }
  function coLogoHtml(b, label) {
    if (b.logo) return '<span class="co-logo"><img alt="' + h(label || b.name) + '" src="' + b.logo + '"></span>';
    return '<span class="co-logo none" aria-hidden="true">' + h(initials(String(b.name || '').replace(/\b(pty|ltd|cc|inc|t\/a|\(pty\))\b\.?/gi, ''))) + '</span>';
  }
  function byKopano() {
    return '<p class="tiny mute by-kopano"><img src="kopano-icon.svg" alt="">' + h(t('byKopano')) + '</p>';
  }
  function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
  }
  function avatarHtml(emp, size) {
    var s = size || 72, src = String(emp.photo || '');
    if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return '<img class="avatar" alt="" src="' + src + '" width="' + s + '" height="' + s + '">';
    return '<span class="avatar none" style="width:' + s + 'px;height:' + s + 'px;font-size:' + Math.round(s * 0.38) + 'px">' + h(initials(emp.name)) + '</span>';
  }
  function pendingChange(key) {
    return ((state.home && state.home.requests) || []).some(function (q) { return q.kind === 'profile' && q.status === 'pending' && q.payload && q.payload.changes && key in q.payload.changes; });
  }
  function viewProfile() {
    if (isMgrOnly()) return viewMgrProfile();
    var home = state.home || {}, emp = home.employee || {}, p = emp.profile || {}, em = p.emergency || {}, bank = p.bank || {}, ed = emp.editable || [];
    var pending = (home.requests || []).some(function (q) { return q.kind === 'profile' && q.status === 'pending'; });
    var canPhoto = ed.indexOf('photo') >= 0, photoWait = pendingChange('photo');
    var name = emp.name || (state.session && state.session.name) || '';
    var entity = emp.entity || emp.company || '';
    var html = '<div class="card"><div class="me-head">' +
      (canPhoto ? '<button type="button" class="avbtn" data-act="go" data-v="me/photo" aria-label="' + h(t(emp.photo ? 'changePhoto' : 'addPhoto')) + '">' + avatarHtml(emp) + '<span class="avedit">' + icon('camera') + '</span></button>' : avatarHtml(emp)) +
      '<div class="grow"><h1 style="font-size:1.25rem;margin:0">' + h(name) + '</h1>' + (emp.position ? '<div class="mute">' + h(emp.position) + '</div>' : '') +
      (canPhoto ? '<button type="button" class="linkbtn" data-act="go" data-v="me/photo">' + h(t(photoWait ? 'photoPending' : emp.photo ? 'changePhoto' : 'addPhoto')) + '</button>' : '') + '</div></div>' +
      kv([['position', emp.position], ['department', emp.department], ['employeeNo', emp.number], ['entity', entity],
        ['tradingAs', emp.tradingAs && emp.tradingAs !== entity ? emp.tradingAs : ''], ['subDivision', emp.subDivision || ''], ['group', (emp.groups || []).join(', ')],
        ['startDate', emp.startDate ? fmtDate(emp.startDate, { weekday: false }) : '', true]]) + '</div>';
    var home_ = addressText(p.address);
    html += '<h2>' + h(t('contact')) + '</h2><div class="card">' + kv([['cell', p.cell], ['email', p.email], ['workPhone', p.workPhone], ['address', home_],
      ['postal', p.postal == null || addressText(p.postal) === '' ? (home_ ? t('sameAsHome') : '') : addressText(p.postal)]]) + '</div>';
    html += '<h2>' + h(t('emergency')) + '</h2><div class="card">' + kv([['emName', em.name], ['emRelationship', em.relationship], ['emCell', em.cell], ['emAltPhone', em.altPhone],
      ['emEmail', em.email], ['emAddress', addressText(em.address)]]) + '</div>';
    var canTax = ed.indexOf('taxNo') >= 0;
    if ('taxNo' in emp || canTax) html += '<h2>' + h(t('taxTitle')) + '</h2><div class="card">' + kv([['taxNo', emp.taxNo || t('taxNone')]]) +
      (canTax ? '<button type="button" class="btn block" style="margin-top:12px" data-act="go" data-v="me/tax">' + h(t('taxChange')) + '</button>' : '') + '</div>';
    var canBank = ed.indexOf('bank') >= 0;
    if (bank.bank || bank.account || canBank) html += '<h2>' + h(t('bankTitle')) + '</h2><div class="card">' + kv([['bank', bank.bank], ['account', bank.account], ['accountType', bank.type]]) +
      (canBank ? '<button type="button" class="btn block" style="margin-top:12px" data-act="go" data-v="me/bank">' + h(t('bankChange')) + '</button>' : '') + '</div>';
    if (pending) html += '<div class="banner warn">' + h(t('pendingChange')) + '</div>';
    if (ed.some(function (k) { return FORM_FIELDS.indexOf(k) >= 0; })) html += '<button type="button" class="btn primary block" data-act="go" data-v="me/edit">' + h(t('requestChange')) + '</button>';
    html += '<p class="small mute" style="margin-top:10px">' + h(t('notEditable')) + '</p>';

    html += companyCard();
    html += settingsHtml();
    return { title: t('profileTitle'), html: html };
  }
  // 1.46: a new profile photo (a square JPEG, sent as the request's attachment; HR approves it)
  var PHOTO_PX = 480;
  function squarePhoto(u) {
    return loadImage(new Blob([Uint8Array.from(atob(u.data), function (c) { return c.charCodeAt(0); })], { type: u.mime || 'image/jpeg' })).then(function (img) {
      var w = img.naturalWidth, hh = img.naturalHeight, s = Math.min(w, hh);
      var c = document.createElement('canvas'); c.width = c.height = PHOTO_PX;
      var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
      // a portrait photo is cut a little above the middle, where the face usually is
      g.drawImage(img, (w - s) / 2, Math.max(0, (hh - s) / 2 - (hh > w ? s * 0.12 : 0)), s, s, 0, 0, PHOTO_PX, PHOTO_PX);
      var url = c.toDataURL('image/jpeg', 0.85), data = url.slice(url.indexOf(',') + 1);
      return { name: 'photo.jpg', mime: 'image/jpeg', size: Math.floor(data.length * 0.75), data: data, preview: url };
    });
  }
  function viewPhotoEdit() {
    var emp = (state.home || {}).employee || {};
    if (((emp.editable) || []).indexOf('photo') < 0) return { title: t('photoTitle'), back: true, html: '<p class="mute">' + h(t('notEditable')) + '</p>' };
    upload = null;
    var html = (pendingChange('photo') ? '<div class="banner warn">' + h(t('photoPending')) + '</div>' : '') +
      '<p class="small mute">' + h(t('photoHint')) + '</p><form id="photoForm" novalidate>' +
      '<div class="photo-pick"><div id="photoPrev">' + avatarHtml(emp, 160) + '</div></div>' +
      '<div class="two"><button type="button" class="btn" data-act="selfie">' + icon('camera') + h(t('takeSelfie')) + '</button>' +
      '<label class="btn" style="margin:0">' + icon('file') + h(t('choosePhoto')) + '<input type="file" id="ufile" accept="image/*" class="hidden"></label></div>' +
      '<div id="formErr"></div><div class="btns"><button type="submit" class="btn primary block">' + h(t('sendRequest')) + '</button></div></form>';
    return {
      title: t('photoTitle'), back: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('photoForm');
        wirePicker(f);
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          if (!upload) { showErrors(f, { _: t('photoNeeded') }); return; }
          busy(f, true);
          rpcT('kp_emp_request', { p_kind: 'profile', p_payload: { changes: { photo: true }, note: '', attachment: attachmentOf(upload, 'Photo') } }, 180000).then(function () {
            upload = null;
            state.flash = { kind: 'ok', text: t('photoSent') };
            go('me');
            loadHome(true);
          }, function (e) { busy(f, false); showErrors(f, { _: errorText(e) }); });
        });
      },
    };
  }
  // 1.46: the SARS income tax number (10 digits, starting with 0, 1, 2, 3 or 9: the same check as Kopano Payroll)
  function validTaxNo(v) { return /^[0-39]\d{9}$/.test(String(v || '').replace(/\s/g, '')); }
  function viewTaxEdit() {
    var emp = (state.home || {}).employee || {};
    if (((emp.editable) || []).indexOf('taxNo') < 0) return { title: t('taxChange'), back: true, html: '<p class="mute">' + h(t('notEditable')) + '</p>' };
    var html = (pendingChange('taxNo') ? '<div class="banner warn">' + h(t('pendingChange')) + '</div>' : '') +
      '<p class="small mute">' + h(t('taxHint')) + '</p><form id="taxForm" novalidate>' +
      (emp.taxNo ? '<p class="small">' + h(t('taxNo')) + ': <b>' + h(emp.taxNo) + '</b></p>' : '') +
      input('tax', 'taxNo', '', 'text', ' inputmode="numeric" maxlength="13" autocomplete="off"') +
      '<div class="field"><label for="f_note">' + h(t('noteOptional')) + '</label><textarea id="f_note" name="note" maxlength="1000"></textarea></div>' +
      '<div id="formErr"></div><div class="btns"><button type="submit" class="btn primary block">' + h(t('sendRequest')) + '</button></div></form>';
    return {
      title: t('taxChange'), back: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('taxForm');
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var v = f.tax.value.replace(/[\s-]/g, ''), errs = {};
          if (!v) errs.tax = t('required');
          else if (!validTaxNo(v)) errs.tax = t('badTaxNo');
          else if (v === String(emp.taxNo || '')) errs.tax = t('sameTaxNo');
          showErrors(f, errs);
          if (Object.keys(errs).length) return;
          busy(f, true);
          rpcT('kp_emp_request', { p_kind: 'profile', p_payload: { changes: { taxNo: v }, note: f.note.value.trim() } }).then(function () {
            state.flash = { kind: 'ok', text: t('taxSent') };
            go('me');
            loadHome(true);
          }, function (e) { busy(f, false); showErrors(f, { _: errorText(e) }); });
        });
      },
    };
  }
  function viewMgrProfile() {
    var emp = (state.home || {}).employee || {};
    var html = '<div class="card"><h1 style="font-size:1.25rem">' + h(emp.name || (state.session && state.session.name) || '') + '</h1>' +
      kv([['position', t('managerRole')], ['company', emp.company]]) + '<p class="small mute" style="margin-top:8px">' + h(t('managerOnlyInfo')) + '</p><p class="small mute" style="margin-top:6px">' + h(t('managerLinkHint')) + '</p></div>';
    return { title: t('profileTitle'), html: html + companyCard() + settingsHtml() };
  }
  function companyCard() {
    var emp = (state.home && state.home.employee) || {}, b = brand(), entity = emp.entity || emp.company || '';
    return '<h2>' + h(t('yourCompany')) + '</h2><div class="card co-card">' + coLogoHtml(b) + '<div class="grow"><b>' + h(b.name) + '</b>' +
      (entity && entity !== b.name ? '<div class="small mute">' + h(entity) + '</div>' : '') + '</div></div>';
  }
  function settingsHtml() {
    var html = '';
    var notifyOn = store.get('notify', true) !== false;
    html += '<h2>' + h(t('settings')) + '</h2><div class="list">' +
      '<div class="row"><div class="grow"><b>' + h(t('language')) + '</b></div>' + langToggle() + '</div>' +
      '<div class="row"><div class="grow"><label for="tsSel"><b>' + h(t('textSize')) + '</b></label><div class="small mute">' + h(t('textSizeHint')) + '</div>' +
      '<div class="ts-row"><select id="tsSel" data-act="text-size">' + TEXT_SIZES.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === textSizePref() ? ' selected' : '') + '>' + h(t(x[1])) + '</option>'; }).join('') + '</select>' +
      '<span class="ts-sample" aria-hidden="true">Aa</span></div></div></div>' +
      '<div class="row"><div class="grow"><b>' + h(t('appearance')) + '</b><div class="seg small" role="group" aria-label="' + h(t('appearance')) + '">' +
      THEMES.map(function (x) { return '<button type="button" data-act="theme" data-v="' + x[0] + '" class="' + (themePref() === x[0] ? 'on' : '') + '" aria-pressed="' + (themePref() === x[0]) + '">' + h(t(x[1])) + '</button>'; }).join('') + '</div></div></div>' +
      (NATIVE ? '<label class="row"><div class="grow"><b>' + h(t('notifications')) + '</b><div class="small mute">' + h(t('notificationsHint')) + '</div></div><input type="checkbox" data-act="notify" style="width:22px;height:22px;accent-color:var(--accent)"' + (notifyOn ? ' checked' : '') + '></label>' : '') +
      '<div class="row"><div class="grow"><label for="sndSel"><b>' + h(t('sound')) + '</b></label><div class="small mute">' + h(t('soundHint')) + '</div>' +
      '<select id="sndSel" data-act="sound" style="margin-top:8px">' + SOUNDS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === soundPref() ? ' selected' : '') + '>' + h(t(x[1])) + '</option>'; }).join('') + '</select></div>' +
      '<button type="button" class="btn" data-act="test-sound" style="align-self:flex-end">' + h(t('testSound')) + '</button></div>' +
      (CAN_VIBRATE ? '<label class="row"><div class="grow"><b>' + h(t('vibrate')) + '</b><div class="small mute">' + h(t('vibrateHint')) + '</div></div><input type="checkbox" data-act="vibrate" style="width:22px;height:22px;accent-color:var(--accent)"' + (vibratePref() ? ' checked' : '') + '></label>' : '') +
      (NATIVE ? '' : '<div class="row"><div class="grow small mute">' + h(t('webNoNotify')) + '</div></div>') +
      '<button type="button" class="row" data-act="go" data-v="me/password"><div class="grow"><b>' + h(t('changePassword')) + '</b></div>' + icon('chev', 'chev') + '</button>' +
      '<button type="button" class="row" data-act="sign-out"><div class="grow"><b style="color:var(--bad)">' + h(t('signOut')) + '</b><div class="small mute">' + h(state.conn.n || brand().name || '') + (state.session ? ' · ' + h(state.session.login || '') : '') + '</div></div></button></div>' +
      byKopano() + '<p class="tiny mute" style="text-align:center;margin-top:2px">' + h(t('appVersion', { v: VERSION })) + '</p>';
    return html;
  }
  function input(name, labelKey, value, type, extra) {
    return '<div class="field"><label for="f_' + name + '">' + h(t(labelKey)) + '</label><input id="f_' + name + '" name="' + name + '" type="' + (type || 'text') + '" value="' + h(value || '') + '"' + (extra || '') + '><div data-err="' + name + '"></div></div>';
  }
  var ADDR = [['line1', 'addrLine1'], ['line2', 'addrLine2'], ['suburb', 'addrSuburb'], ['city', 'addrCity'], ['code', 'addrCode']];
  function addrObj(v) {
    var o = { line1: '', line2: '', suburb: '', city: '', code: '' };
    if (v && typeof v === 'object') ADDR.forEach(function (x) { o[x[0]] = String(v[x[0]] || '').trim(); });
    else if (typeof v === 'string') o.line1 = v.trim();
    return o;
  }
  function addressText(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    return ADDR.map(function (x) { return String(v[x[0]] || '').trim(); }).filter(Boolean).join(', ');
  }
  function sameAddr(a, b) { a = addrObj(a); b = addrObj(b); return ADDR.every(function (x) { return a[x[0]] === b[x[0]]; }); }
  function addrInputs(prefix, v) {
    var o = addrObj(v);
    return ADDR.map(function (x) {
      return input(prefix + '_' + x[0], x[1], o[x[0]], 'text', x[0] === 'code' ? ' inputmode="numeric" maxlength="10"' : ' maxlength="120"');
    }).join('');
  }
  function readAddr(f, prefix) {
    var o = {};
    ADDR.forEach(function (x) { o[x[0]] = f[prefix + '_' + x[0]].value.trim(); });
    return o;
  }
  function viewProfileEdit() {
    var home = state.home || {}, emp = home.employee || {}, p = emp.profile || {}, ed = emp.editable || [];
    var em = p.emergency || {}, bank = p.bank || {};
    var postalSame = p.postal == null || addressText(p.postal) === '';
    var html = '<p class="small mute">' + h(t('changeHint')) + '</p><form id="profForm" novalidate>';
    var contact = ['cell', 'email', 'workPhone'].filter(function (k) { return ed.indexOf(k) >= 0; });
    if (contact.length) {
      html += '<h2>' + h(t('contact')) + '</h2>';
      contact.forEach(function (k) {
        html += input(k, k, p[k], k === 'email' ? 'email' : 'tel', k === 'email' ? ' autocapitalize="off"' : ' inputmode="tel"');
      });
    }
    if (ed.indexOf('address') >= 0) html += '<h2>' + h(t('address')) + '</h2>' + addrInputs('ad', p.address);
    if (ed.indexOf('postal') >= 0) {
      html += '<h2>' + h(t('postal')) + '</h2><label class="check field"><input type="checkbox" name="postalSame"' + (postalSame ? ' checked' : '') + '> ' + h(t('sameAsHome')) + '</label>' +
        '<div id="postalFields"' + (postalSame ? ' class="hidden"' : '') + '>' + addrInputs('po', postalSame ? null : p.postal) + '</div>';
    }
    var EM = [['name', 'emName', 'text', ''], ['relationship', 'emRelationship', 'text', ''], ['cell', 'emCell', 'tel', ' inputmode="tel"'],
      ['altPhone', 'emAltPhone', 'tel', ' inputmode="tel"'], ['email', 'emEmail', 'email', ' autocapitalize="off"']];
    if (ed.indexOf('emergency') >= 0) {
      html += '<h2>' + h(t('emergency')) + '</h2>' + EM.map(function (x) { return input('em_' + x[0], x[1], em[x[0]], x[2], x[3]); }).join('') +
        '<div class="field"><label for="f_em_address">' + h(t('emAddress')) + '</label><textarea id="f_em_address" name="em_address" maxlength="300" style="min-height:72px">' + h(addressText(em.address)) + '</textarea></div>';
    }
    html += '<div class="field"><label for="f_note">' + h(t('noteOptional')) + '</label><textarea id="f_note" name="note" maxlength="1000"></textarea></div>' +
      '<div id="formErr"></div><div class="btns"><button type="submit" class="btn primary block">' + h(t('sendRequest')) + '</button></div></form>';
    return {
      title: t('changeTitle'), back: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('profForm');
        if (f.postalSame) f.postalSame.addEventListener('change', function () {
          document.getElementById('postalFields').classList.toggle('hidden', f.postalSame.checked);
        });
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var changes = {}, errs = {};
          contact.forEach(function (k) {
            var v = f[k].value.trim();
            if (v !== String(p[k] || '').trim()) changes[k] = v;
          });
          if (changes.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.email)) errs.email = t('badEmail');
          var newHome = p.address;
          if (ed.indexOf('address') >= 0) {
            var na = readAddr(f, 'ad');
            if (!sameAddr(na, p.address)) {
              if (!na.line1) errs.ad_line1 = t('required');
              changes.address = na;
              newHome = na;
            }
          }
          if (ed.indexOf('postal') >= 0) {
            if (f.postalSame.checked) {
              // the same as home: send the (new) home address as the postal address when it was different
              if (!postalSame) changes.postal = addrObj(newHome);
            } else {
              var np = readAddr(f, 'po');
              if (postalSame || !sameAddr(np, p.postal)) {
                if (!np.line1) errs.po_line1 = t('required');
                changes.postal = np;
              }
            }
          }
          if (ed.indexOf('emergency') >= 0) {
            var ne = {};
            EM.forEach(function (x) { var v = f['em_' + x[0]].value.trim(); if (v !== String(em[x[0]] || '').trim()) ne[x[0]] = v; });
            var ea = f.em_address.value.trim();
            if (ea !== addressText(em.address).trim()) ne.address = ea;
            if (ne.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ne.email)) errs.em_email = t('badEmail');
            if (Object.keys(ne).length) changes.emergency = ne;
          }
          if (!Object.keys(errs).length && !Object.keys(changes).length) errs._ = t('noChanges');
          showErrors(f, errs);
          if (Object.keys(errs).length) return;
          busy(f, true);
          rpcT('kp_emp_request', { p_kind: 'profile', p_payload: { changes: changes, note: f.note.value.trim() } }).then(function () {
            state.flash = { kind: 'ok', text: t('changeSent') };
            go('me');
            loadHome(true);
          }, function (e) { busy(f, false); showErrors(f, { _: errorText(e) }); });
        });
      },
    };
  }
  // 1.27: the banks Kopano Payroll knows, with their universal branch codes (the same list as the desktop app)
  var BANKS = [['Absa', '632005'], ['African Bank', '430000'], ['Bank Zero', '888000'], ['Capitec', '470010'], ['Discovery Bank', '679000'], ['FNB', '250655'],
    ['Investec', '580105'], ['Nedbank', '198765'], ['Postbank', '460005'], ['Standard Bank', '051001'], ['TymeBank', '678910']];
  function bankCode(name) { for (var i = 0; i < BANKS.length; i++) if (BANKS[i][0] === name) return BANKS[i][1]; return ''; }
  // 1.25: a change of bank account always goes with the bank's confirmation letter
  function viewBankEdit() {
    var home = state.home || {}, emp = home.employee || {}, bank = (emp.profile || {}).bank || {};
    if ((emp.editable || []).indexOf('bank') < 0) return { title: t('bankChange'), back: true, html: '<p class="mute">' + h(t('notEditable')) + '</p>' };
    var html = '<p class="small mute">' + h(t('bankHint')) + '</p>' +
      (bank.account ? '<p class="small">' + h(bank.bank || '') + ' ' + h(bank.account) + '</p>' : '') + '<form id="bankForm" novalidate>' +
      '<div class="field"><label for="f_bk_bank">' + h(t('bank')) + '</label><select id="f_bk_bank" name="bk_bank"><option value="">' + h(t('bankChoose')) + '</option>' +
      BANKS.map(function (b) { return '<option value="' + h(b[0]) + '">' + h(b[0]) + '</option>'; }).join('') + '</select><div class="small mute">' + h(t('bankNotListed')) + '</div><div data-err="bk_bank"></div></div>' +
      input('bk_branch', 'branch', '', 'text', ' inputmode="numeric" maxlength="6"') + input('bk_account', 'account', '', 'text', ' inputmode="numeric" autocomplete="off"') +
      '<div class="field"><label for="f_bk_type">' + h(t('accountType')) + '</label><select id="f_bk_type" name="bk_type"><option value=""></option>' +
      [['Cheque', 'acCheque'], ['Savings', 'acSavings'], ['Transmission', 'acTransmission']].map(function (x) { return '<option value="' + x[0] + '">' + h(t(x[1])) + '</option>'; }).join('') +
      '</select></div>' + input('bk_holder', 'holder', emp.name || '') +
      '<span class="label">' + h(t('bankLetter')) + '</span>' + pickerHtml() + '<div data-err="letter"></div>' +
      '<div class="field" style="margin-top:14px"><label for="f_note">' + h(t('noteOptional')) + '</label><textarea id="f_note" name="note" maxlength="1000"></textarea></div>' +
      '<div id="formErr"></div><div class="btns"><button type="submit" class="btn primary block">' + h(t('sendRequest')) + '</button></div></form>';
    upload = null;
    return {
      title: t('bankChange'), back: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('bankForm');
        wirePicker(f);
        f.bk_bank.addEventListener('change', function () { f.bk_branch.value = bankCode(f.bk_bank.value); });
        sheet({ title: t('bankLetterTitle'), text: t('bankLetterText'), onDismiss: function () { history.back(); },
          buttons: [{ label: t('bankLetterOk'), cls: 'primary' }, { label: t('cancel'), fn: function () { history.back(); } }] });
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var errs = {};
          var nb = { bank: f.bk_bank.value.trim(), branch: f.bk_branch.value.trim(), account: f.bk_account.value.replace(/[\s-]/g, ''), type: f.bk_type.value, holder: f.bk_holder.value.trim() };
          if (!nb.bank || !bankCode(nb.bank)) errs.bk_bank = t('bankChooseErr');
          if (nb.branch && !/^\d{6}$/.test(nb.branch)) errs.bk_branch = t('badBranch');
          if (!nb.account) errs.bk_account = t('required');
          else if (!/^\d{5,16}$/.test(nb.account)) errs.bk_account = t('badAccount');
          if (!upload) errs.letter = t('bankLetterNeeded');
          showErrors(f, errs);
          if (Object.keys(errs).length) return;
          busy(f, true);
          rpcT('kp_emp_request', { p_kind: 'profile', p_payload: { changes: { bank: nb }, note: f.note.value.trim(), attachment: attachmentOf(upload, 'Bank') } }, 180000).then(function () {
            upload = null;
            state.flash = { kind: 'ok', text: t('bankSent') };
            go('me');
            loadHome(true);
          }, function (e) { busy(f, false); showErrors(f, { _: errorText(e) }); });
        });
      },
    };
  }
  function viewPassword() {
    var html = '<form id="pwForm" novalidate>' +
      '<input type="text" name="username" autocomplete="username" value="' + h((state.session && state.session.login) || '') + '" class="hidden">' +
      input('old', 'oldPassword', '', 'password', ' autocomplete="current-password"') +
      input('pw', 'newPassword', '', 'password', ' autocomplete="new-password"') +
      input('pw2', 'confirmPassword', '', 'password', ' autocomplete="new-password"') +
      '<div id="formErr"></div><div class="btns"><button type="submit" class="btn primary block">' + h(t('changePassword')) + '</button></div></form>';
    return {
      title: t('changePassword'), back: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('pwForm');
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var errs = {};
          if (!f.old.value) errs.old = t('required');
          if (f.pw.value.length < 8) errs.pw = t('passwordShort');
          else if (f.pw.value !== f.pw2.value) errs.pw2 = t('passwordMismatch');
          showErrors(f, errs);
          if (Object.keys(errs).length) return;
          busy(f, true);
          rpcT('kp_emp_password', { p_old: f.old.value, p_new: f.pw.value }).then(function () {
            state.flash = { kind: 'ok', text: t('passwordChanged') };
            go('me');
          }, function (e) {
            busy(f, false);
            if (e.code === 'denied') showErrors(f, { old: t('wrongLogin') });
            else showErrors(f, { _: errorText(e) });
          });
        });
      },
    };
  }

  // ---------- meeting with HR ----------
  var TOPICS = ['topicLeave', 'topicPay', 'topicPersonal', 'topicGrievance', 'topicTraining', 'topicOther'];
  var meetingDraft = null;
  function viewMeeting() {
    var d = meetingDraft || (meetingDraft = { topic: 'topicPay', other: '', note: '', slots: [{ date: '', time: '' }] });
    function slotHtml(s, i) {
      return '<div class="two" data-slot="' + i + '" style="align-items:end"><div class="field"><label>' + h(t('option', { n: i + 1 })) + '</label><input type="date" name="sd' + i + '" value="' + h(s.date) + '" min="' + todayISO() + '"></div>' +
        '<div class="field"><input type="time" name="st' + i + '" value="' + h(s.time) + '" step="900" aria-label="' + h(t('option', { n: i + 1 })) + '"></div></div><div data-err="sd' + i + '" style="margin:-8px 0 10px"></div>';
    }
    var html = '<form id="meetForm" novalidate>' +
      '<div class="field"><label for="mtopic">' + h(t('topic')) + '</label><select id="mtopic" name="topic">' + TOPICS.map(function (k) {
        return '<option value="' + k + '"' + (k === d.topic ? ' selected' : '') + '>' + h(t(k)) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field' + (d.topic === 'topicOther' ? '' : ' hidden') + '" id="otherRow"><label for="mother">' + h(t('topicOtherText')) + '</label><input id="mother" name="other" type="text" maxlength="200" value="' + h(d.other) + '"><div data-err="other"></div></div>' +
      '<div class="field"><label for="mnote">' + h(t('meetingNote')) + '</label><textarea id="mnote" name="note" maxlength="2000">' + h(d.note) + '</textarea></div>' +
      '<span class="label">' + h(t('preferred')) + '</span><p class="hint" style="margin:0 0 10px">' + h(t('preferredHint')) + '</p>' +
      '<div id="slots">' + d.slots.map(slotHtml).join('') + '</div>' +
      (d.slots.length < 3 ? '<button type="button" class="btn block" data-act="add-slot" style="margin-bottom:8px">' + h(t('addOption')) + '</button>' : '') +
      '<div id="formErr"></div><div class="btns"><button type="submit" class="btn primary block">' + h(t('sendRequest')) + '</button></div></form>';
    return {
      title: t('meetingTitle'), back: true, form: true, html: html,
      after: function () {
        var f = document.getElementById('meetForm');
        function sync() {
          d.topic = f.topic.value; d.other = f.other.value; d.note = f.note.value;
          d.slots = d.slots.map(function (s, i) { return { date: f['sd' + i].value, time: f['st' + i].value }; });
          document.getElementById('otherRow').classList.toggle('hidden', d.topic !== 'topicOther');
        }
        f.addEventListener('input', sync);
        f.addEventListener('change', sync);
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          sync();
          var errs = {}, now = Date.now();
          if (d.topic === 'topicOther' && !d.other.trim()) errs.other = t('required');
          var slots = d.slots.filter(function (s) { return s.date; });
          d.slots.forEach(function (s, i) {
            if (s.date && (saTime(s.date, s.time || '23:59') || 0) < now) errs['sd' + i] = t('pastTime');
          });
          showErrors(f, errs);
          if (Object.keys(errs).length) return;
          // the topic goes to HR in the employee's language, with the English in brackets for HR when it differs
          var topic = d.topic === 'topicOther' ? d.other.trim() : t(d.topic);
          if (d.topic !== 'topicOther' && lang() !== 'en') topic += ' (' + KP_TEXT.en[d.topic] + ')';
          busy(f, true);
          rpcT('kp_emp_request', { p_kind: 'meeting', p_payload: { topic: topic, note: d.note.trim(), preferred: slots } }).then(function () {
            meetingDraft = null;
            state.flash = { kind: 'ok', text: t('meetingSent') };
            go('');
            loadHome(true);
          }, function (e) { busy(f, false); showErrors(f, { _: errorText(e) }); });
        });
      },
    };
  }

  // ---------- one request ----------
  function viewRequest(id) {
    id = decodeURIComponent(id || '');
    var q = (((state.home && state.home.requests) || []).filter(function (x) { return x.id === id; }))[0];
    if (!q) return { title: t('requestTitle'), back: true, html: '<div class="empty">—</div>' };
    var p = q.payload || {}, r = q.response || {}, rows = [];
    if (q.kind === 'leave') {
      rows.push(['leaveType', leaveTypeName(p.type)], ['fromDate', fmtDate(p.from), true], ['toDate', fmtDate(p.to), true]);
      if (p.halfDay) rows.push(['halfDay', t('yes')]);
      var n = p.halfDay ? 0.5 : kpWorkingDays(p.from, p.to);
      rows.push(['numDays', n === 1 ? t('workingDay') : n === 0.5 ? t('halfDayCount') : t('workingDays', { n: n })]);
      if (p.reason) rows.push(['reason', p.reason]);
      if (p.attachment) rows.push(['attachment', p.attachment.name]);
    } else if (q.kind === 'profile') {
      Object.keys(p.changes || {}).forEach(function (k) {
        var v = p.changes[k];
        if (v && typeof v === 'object') {
          if (k === 'bank') v = [v.bank, v.branch, v.account ? '••••' + String(v.account).slice(-4) : '', v.type, v.holder].filter(Boolean).join(', ');
          else if (k === 'address' || k === 'postal') v = addressText(v);
          else v = ['name', 'relationship', 'cell', 'altPhone', 'email', 'address'].filter(function (x) { return v[x] != null && v[x] !== ''; })
            .map(function (x) { return v[x] && typeof v[x] === 'object' ? addressText(v[x]) : v[x]; }).join(', ');
        }
        if (k === 'photo') v = p.attachment && /^image\//.test(p.attachment.mime || '') ? p.attachment.name : t('yes');
        rows.push([fieldLabelKey(k), v]);
      });
      if (p.note) rows.push(['noteOptional', p.note]);
      if (p.attachment && !(p.changes && p.changes.photo)) rows.push(['attachment', p.attachment.name]);
    } else if (q.kind === 'meeting') {
      rows.push(['topic', p.topic]);
      if (p.note) rows.push(['meetingNote', p.note]);
      (p.preferred || []).forEach(function (s, i) { rows.push([t('option', { n: i + 1 }), fmtDate(s.date) + (s.time ? ' ' + h(s.time) : ''), true]); });
    } else if (q.kind === 'document') {
      rows.push(['documentsTitle', p.name]);
      if (p.category) rows.push(['category', p.category]);
      if (p.note) rows.push(['noteOptional', p.note]);
    }
    var html = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px"><h3>' + h(t('kind_' + q.kind)) + '</h3>' + reqBadge(q) + '</div>' +
      kv(rows) + '<p class="tiny mute" style="margin-top:12px">' + h(t('sent', { when: fmtStamp(q.createdAt) })) + '</p></div>';
    html += stepsHtml(q);
    var ap = r.appointment;
    if (ap && ap.date) {
      html += '<div class="banner info"><b>' + h(t('booked', { when: '' })) + '</b>' + fmtDate(ap.date) + (ap.time ? ' ' + h(ap.time) : '') +
        (ap.with ? '<br>' + h(t('withWho', { who: ap.with })) : '') + (ap.place ? '<br>' + h(t('at', { place: ap.place })) : '') + (ap.note ? '<br>' + h(ap.note) : '') + '</div>';
    }
    if (r.note) html += '<h2>' + h(t('hrAnswer')) + '</h2><div class="card">' + h(r.note).replace(/\n/g, '<br>') + '</div>';
    // 1.25: a conversation with HR about the request
    var msgs = q.messages || [];
    html += '<h2>' + h(t('messages')) + '</h2><div class="chat">' + (msgs.length ? msgs.map(function (m) {
      var mine = m.from === 'emp';
      return '<div class="msg ' + (mine ? 'me' : 'hr') + '"><div class="who">' + h(mine ? t('you') : (m.author || t('hr'))) + ' · ' + h(fmtStamp(m.at)) + '</div>' + h(m.text).replace(/\n/g, '<br>') + '</div>';
    }).join('') : '<p class="small mute">' + h(t('noMessages')) + '</p>') + '</div>';
    if (q.status !== 'cancelled') {
      html += '<form id="chatForm" class="chat-form" novalidate><textarea name="text" maxlength="2000" placeholder="' + h(t('writeMessage')) + '" aria-label="' + h(t('writeMessage')) + '">' + h(chatDrafts[q.id] || '') + '</textarea>' +
        '<button type="submit" class="btn primary" aria-label="' + h(t('send')) + '">' + icon('send') + '</button></form><div id="formErr"></div>';
    }
    if (q.status === 'pending') html += '<div class="btns"><button type="button" class="btn danger block" data-act="cancel-req" data-v="' + h(q.id) + '">' + h(t('cancelRequest')) + '</button></div>';
    return {
      title: t('kind_' + q.kind), back: true, html: html,
      after: function () {
        markSeen(q);
        var f = document.getElementById('chatForm');
        if (!f) return;
        if (chatScroll === q.id) { chatScroll = null; setTimeout(function () { f.scrollIntoView({ block: 'end' }); }, 0); }
        f.text.addEventListener('input', function () { chatDrafts[q.id] = f.text.value; });
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var text = f.text.value.trim();
          if (!text) return;
          busy(f, true);
          rpcT('kp_emp_message', { p_id: q.id, p_text: text }).then(function (res) {
            delete chatDrafts[q.id];
            q.messages = (res && res.messages) || msgs.concat([{ id: (res && res.id) || 0, from: 'emp', author: '', text: text, at: new Date().toISOString() }]);
            store.set('home', state.home);
            chatScroll = q.id;
            render();
          }, function (e) { busy(f, false); showErrors(f, { _: errorText(e) }); });
        });
      },
    };
  }
  var chatDrafts = {}, chatScroll = null;

  // ---------- 1.30: managers approve their team's requests ----------
  function waitingApprovals() {
    return (((state.home || {}).approvals) || []).filter(function (a) { return a.status === 'pending' && a.mgr && a.mgr.status === 'waiting'; });
  }
  function apprDays(p) { return p.halfDay ? 0.5 : kpWorkingDays(p.from, p.to); }
  function apprSummary(a) {
    var p = a.payload || {};
    if (a.kind === 'leave') {
      var n = apprDays(p);
      return leaveName(p.type, a.typeName || p.type) + ' · ' + fmtDate(p.from, { weekday: false }) + (p.to && p.to !== p.from ? ' – ' + fmtDate(p.to, { weekday: false }) : '') +
        ' · ' + (n === 0.5 ? t('halfDayCount') : n === 1 ? t('workingDay') : t('workingDays', { n: n }));
    }
    if (a.kind === 'meeting') return t('kind_meeting') + ': ' + (p.topic || '');
    return t('kind_' + a.kind);
  }
  function apprBadge(a) {
    var m = (a.mgr || {}).status || 'waiting';
    if (m === 'waiting' && a.status !== 'pending') return statusBadge(a.status);
    var cls = m === 'approved' ? 'st-approved' : m === 'declined' ? 'st-declined' : m === 'waiting' ? 'st-pending' : 'st-cancelled';
    return '<span class="badge ' + cls + '">' + h(t('ms_' + m)) + '</span>';
  }
  function apprRow(a) {
    var e = a.employee || {};
    return '<button type="button" class="row" data-act="go" data-v="appr/' + h(encodeURIComponent(a.id)) + '"><div class="grow"><div><b>' + h(e.name || '') + '</b></div>' +
      '<div class="small mute">' + h(apprSummary(a)) + '</div><div class="tiny mute">' + h(t('sent', { when: fmtStamp(a.createdAt) })) + '</div></div><div class="end">' + apprBadge(a) + '</div>' + icon('chev', 'chev') + '</button>';
  }
  function offRow(l) {
    return '<div class="row"><div class="grow"><div><b>' + h(l.name) + '</b></div><div class="small mute">' + h(leaveName(l.type, l.type)) + ' · ' + fmtDate(l.from, { weekday: false }) +
      (l.to !== l.from ? ' – ' + fmtDate(l.to, { weekday: false }) : '') + '</div></div><div class="end">' + statusBadge(l.status) + '</div></div>';
  }
  function viewTeam() {
    var home = state.home || {}, mg = home.manager || { team: [], leave: [] }, all = home.approvals || [];
    var wait = waitingApprovals(), done = all.filter(function (a) { return wait.indexOf(a) < 0; }).slice(0, 20);
    if (!state.home && state.loading) return { title: t('teamTitle'), html: '<div class="loading">' + h(t('loading')) + '</div>' };
    var html = '';
    if (isMgrOnly()) {
      var name = ((home.employee || {}).name || (state.session || {}).name || '').split(' ')[0];
      html += '<h1>' + h(t('hello', { name: name })) + '</h1>' + (state.homeAt ? '<p class="tiny mute">' + h(t('updated', { when: fmtStamp(state.homeAt) })) + '</p>' : '');
    }
    html += '<h2>' + h(t('toApprove')) + (wait.length ? ' (' + wait.length + ')' : '') + '</h2><div class="list">' +
      (wait.length ? wait.map(apprRow).join('') : '<div class="empty">' + h(t('nothingToApprove')) + '</div>') + '</div>';
    var td = todayISO(), soon = (mg.leave || []).filter(function (l) { return l.to >= td && l.from <= addDays(td, 45); });
    html += '<h2>' + h(t('teamOff')) + '</h2><div class="list">' + (soon.length ? soon.map(offRow).join('') : '<div class="empty">' + h(t('nobodyOff')) + '</div>') + '</div>';
    if (done.length) html += '<h2>' + h(t('decided')) + '</h2><div class="list">' + done.map(apprRow).join('') + '</div>';
    var team = mg.team || [];
    html += '<details class="card" style="margin-top:16px"><summary><b>' + h(t('teamMembers', { n: team.length })) + '</b></summary>' +
      (team.length ? '<div class="list" style="margin-top:8px">' + team.map(function (m) {
        return '<div class="row"><div class="grow"><b>' + h(m.name) + '</b><div class="small mute">' + h([m.position, m.department].filter(Boolean).join(' · ')) + '</div></div></div>';
      }).join('') + '</div>' : '<p class="small mute">' + h(t('noTeam')) + '</p>') + '</details>';
    return { title: t('teamTitle'), html: html };
  }
  function viewApproval(id) {
    id = decodeURIComponent(id || '');
    var home = state.home || {}, a = ((home.approvals || []).filter(function (x) { return x.id === id; }))[0];
    if (!a) return { title: t('approvalTitle'), back: true, html: '<div class="empty">—</div>' };
    var p = a.payload || {}, e = a.employee || {}, m = a.mgr || {}, rows = [['employee', e.name], ['position', e.position]];
    var waiting = a.status === 'pending' && m.status === 'waiting';
    if (a.kind === 'leave') {
      var n = apprDays(p), b = a.balance;
      rows.push(['leaveType', leaveName(p.type, a.typeName || p.type)], ['fromDate', fmtDate(p.from), true], ['toDate', fmtDate(p.to), true],
        ['numDays', n === 1 ? t('workingDay') : n === 0.5 ? t('halfDayCount') : t('workingDays', { n: n })]);
      if (p.reason) rows.push(['reason', p.reason]);
      if (b && b.balance != null) { rows.push(['balanceNow', num(b.balance)]); if (waiting) rows.push(['balanceAfter', num(b.balance - n)]); }
      if (p.attachment) rows.push(['proofAttached', t('yes')]);
    } else if (a.kind === 'meeting') {
      rows.push(['topic', p.topic]);
      if (p.note) rows.push(['meetingNote', p.note]);
      (p.preferred || []).forEach(function (s, i) { rows.push([t('option', { n: i + 1 }), fmtDate(s.date) + (s.time ? ' ' + h(s.time) : ''), true]); });
    }
    var html = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px"><h3>' + h(t('kind_' + a.kind)) + '</h3>' + apprBadge(a) + '</div>' +
      kv(rows) + '<p class="tiny mute" style="margin-top:12px">' + h(t('sent', { when: fmtStamp(a.createdAt) })) + '</p></div>';
    if (a.kind === 'leave' && p.from && p.to) {
      var others = (((home.manager || {}).leave) || []).filter(function (l) { return l.name !== e.name && l.from <= p.to && l.to >= p.from; });
      html += '<h2>' + h(t('alsoOff')) + '</h2>' + (others.length ? '<div class="list">' + others.map(offRow).join('') + '</div>' : '<p class="small mute">' + h(t('nobodyElseOff')) + '</p>');
    }
    if (m.note && !waiting) html += '<h2>' + h(t('mgrNote').replace(/ \(.*\)$/, '')) + '</h2><div class="card">' + h(m.note).replace(/\n/g, '<br>') + '</div>';
    if (waiting) {
      html += '<form id="apprForm" novalidate style="margin-top:16px"><div class="field"><label for="anote">' + h(t('mgrNote')) + '</label><textarea id="anote" name="note" maxlength="1000"></textarea>' +
        '<div class="hint">' + h(t('mgrNoteHint')) + '</div><div data-err="note"></div></div><div id="formErr"></div>' +
        '<div class="btns"><button type="submit" class="btn primary block" data-v="approved">' + h(t('approve')) + '</button>' +
        '<button type="button" class="btn danger block" id="declineBtn">' + h(t('decline')) + '</button></div></form>';
    }
    return {
      title: t('approvalTitle'), back: true, form: waiting, html: html,
      after: function () {
        var f = document.getElementById('apprForm');
        if (!f) return;
        function decide(dec) {
          var note = f.note.value.trim();
          if (dec === 'declined' && !note) { showErrors(f, { note: t('declineWhy') }); return; }
          showErrors(f, {});
          f.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
          rpcT('kp_emp_team_decide', { p_id: a.id, p_decision: dec, p_note: note }).then(function () {
            a.mgr = { id: m.id, name: m.name, status: dec, note: note, at: new Date().toISOString() };
            if (dec === 'declined') a.status = 'declined';
            store.set('home', state.home);
            state.flash = { kind: 'ok', text: t(dec === 'approved' ? 'approvedSent' : 'declinedSent') };
            go(isMgrOnly() ? '' : 'team');
            loadHome(true);
          }, function (err) {
            f.querySelectorAll('button').forEach(function (x) { x.disabled = false; });
            showErrors(f, { _: errorText(err) });
            loadHome(true);
          });
        }
        f.addEventListener('submit', function (ev) { ev.preventDefault(); decide('approved'); });
        document.getElementById('declineBtn').addEventListener('click', function () { decide('declined'); });
      },
    };
  }
  // the employee's own request: the manager's step and HR's
  function stepsHtml(q) {
    var m = q.mgr;
    if (!m || m.status === 'skipped') return '';
    var hrSt = q.status === 'pending' ? (m.status === 'approved' ? 'waiting' : '') : m.status === 'declined' ? '' : q.status === 'declined' ? 'declined' : q.status === 'cancelled' ? '' : 'approved';
    var row = function (label, st) {
      var cls = st === 'approved' ? 'st-approved' : st === 'declined' ? 'st-declined' : st === 'waiting' ? 'st-pending' : 'st-cancelled';
      return '<div class="row"><div class="grow"><b>' + h(label) + '</b></div><div class="end">' + (st ? '<span class="badge ' + cls + '">' + h(t('step_' + st)) + '</span>' : '<span class="small mute">—</span>') + '</div></div>';
    };
    var html = '<h2>' + h(t('stepsTitle')) + '</h2><div class="list">' + row(t('stepManager', { name: m.name || '' }), m.status) + row(t('stepHr'), hrSt) + '</div>';
    if (m.note) html += '<h2>' + h(t('mgrAnswer')) + '</h2><div class="card">' + h(m.note).replace(/\n/g, '<br>') + '</div>';
    return html;
  }

  // ---------- actions ----------
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), v = el.getAttribute('data-v');
    switch (act) {
      case 'lang':
        state.lang = v; store.set('lang', v); scheduleNotifications();
        render();
        break;
      case 'tab': go(v); break;
      case 'theme': store.set('theme', v); applyDisplay(); render(); break;
      case 'go': ev.preventDefault(); go(v); break;
      case 'apply-type': {
        var lts = (state.home && state.home.leaveTypes) || [];
        if (lts.some(function (x) { return x.type === v; })) leaveDraft = { type: v, from: '', to: '', halfDay: false, reason: '' };
        go('leave/new'); break;
      }
      case 'back': history.length > 1 ? history.back() : go(''); break;
      case 'refresh': loadHome(); break;
      case 'connect-scan': openCamera('qr'); break;
      case 'connect-paste': connectMode = 'paste'; render(); break;
      case 'cam-close': closeCamera(); break;
      case 'cam-shoot': shootPhoto(); break;
      case 'photo': openCamera('photo'); break;
      case 'selfie': openCamera('selfie'); break;
      case 'test-sound': alertNow(true); break;
      case 'signmode': signMode = v; render(); break;
      case 'other-company':
        state.conn = null; store.set('conn', null); endSession(); connectMode = 'start'; go(''); break;
      case 'open-req': go('req/' + encodeURIComponent(v)); break;
      case 'cal-item': try { askCalendar(JSON.parse(v)); } catch (e) { /* bad data */ } break;
      case 'payslip': getPayslip(v, el.getAttribute('data-mode')); break;
      case 'latest-payslip': {
        var ps = (state.home && state.home.payslips) || [];
        if (ps.length) getPayslip(ps[0].id, 'open'); else go('payslips');
        break;
      }
      case 'add-slot':
        if (meetingDraft && meetingDraft.slots.length < 3) {
          var f = document.getElementById('meetForm');
          meetingDraft.slots = meetingDraft.slots.map(function (s, i) { return { date: f['sd' + i].value, time: f['st' + i].value }; });
          meetingDraft.note = f.note.value; meetingDraft.topic = f.topic.value; meetingDraft.other = f.other.value;
          meetingDraft.slots.push({ date: '', time: '' });
          render();
        }
        break;
      case 'cancel-req':
        if (!confirm(t('cancelConfirm'))) break;
        el.disabled = true;
        rpcT('kp_emp_cancel', { p_id: v }).then(function () {
          toast(t('cancelled'));
          return loadHome(true);
        }, function (e) { el.disabled = false; toast(errorText(e)); });
        break;
      case 'sign-out':
        if (!confirm(t('signOutConfirm'))) break;
        rpcT('kp_emp_logout', {}).catch(function () { /* signed out on the phone anyway */ });
        endSession();
        go('');
        break;
    }
  });
  document.addEventListener('change', function (ev) {
    if (ev.target.matches('[data-act="text-size"]')) { store.set('textSize', ev.target.value); applyDisplay(); }
    if (ev.target.matches('[data-act="sound"]')) { store.set('sound', ev.target.value); pushAlertPrefs(); alertNow(true); }
    if (ev.target.matches('[data-act="vibrate"]')) { store.set('vibrate', ev.target.checked); pushAlertPrefs(); if (ev.target.checked) alertNow(true); }
    if (ev.target.matches('[data-act="notify"]')) {
      store.set('notify', ev.target.checked);
      if (ev.target.checked && NATIVE && NATIVE.askNotifications) NATIVE.askNotifications();
      scheduleNotifications();
    }
  });

  // start
  pushAlertPrefs();
  codeFromLink();
  // 1.52: the web app has no Android shell to say it came back to the front: refresh like the phone app does
  if (!NATIVE) document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') window.kpResume(); });
  render();
  if (state.session) loadHome(!!state.home);
  window.kpApp = { state: state, parseConnectionCode: parseConnectionCode, money: money, render: render, calEvent: calEvent, lastAlert: function () { return lastAlert; }, validTaxNo: validTaxNo, ios: IOS, brand: brand, applyDisplay: applyDisplay }; // for tests
})();
