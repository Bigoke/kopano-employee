/* Kopano 1.56: instant updates. A small client for Supabase Realtime (Phoenix protocol, JSON vsn 1.0.0) that joins one
   public broadcast channel and calls onPing when the database says "something changed" (kp_live_send in
   supabase/kopano-employee-app.sql). The signal carries no data: the app then fetches the news with its usual call.
   One source, three copies kept identical by the tests: src/live-client.js (inlined into Kopano-Payroll.html by
   patch156.py), desktop/live-client.js (the Windows app, where the window itself is kept offline) and
   android/www/live.js (the Android app and the iPhone web app). Plain ES5 so older Android WebViews run it.

   var live = KpLive({ url: 'https://abc.supabase.co', key: '<anon key>', topic: 'kpe_…', onPing: fn, onState: fn });
   live.state()  -> 'connecting' | 'live' | 'down' | 'stopped'
   live.stop()
   onState(state, why) is called on every change; after a break it reconnects by itself (1 s, 2 s, 5 s … up to 60 s). */
(function (root) {
  var RETRY = [1000, 2000, 5000, 10000, 20000, 30000, 60000];
  var HEARTBEAT = 25000;

  function wsUrl(url, key) {
    var u = String(url || '').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
    u = u.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    return u + '/realtime/v1/websocket?apikey=' + encodeURIComponent(key) + '&vsn=1.0.0';
  }

  function KpLive(o) {
    var WS = o.WebSocket || root.WebSocket;
    var topic = 'realtime:' + o.topic;
    var ws = null, st = 'connecting', stopped = false, tries = 0, ref = 0, joinRef = null;
    var hbTimer = null, retryTimer = null, hbWait = null, lastPing = 0;
    var timers = o.timers || { // called as plain functions: browsers refuse setTimeout called on another object
      set: function (f, ms) { return setTimeout(f, ms); }, clear: function (t) { clearTimeout(t); },
      every: function (f, ms) { return setInterval(f, ms); }, stopEvery: function (t) { clearInterval(t); } };

    function setState(s, why) {
      if (s === st) return;
      st = s;
      try { if (o.onState) o.onState(s, why || ''); } catch (e) { /* the app's own problem */ }
    }
    function send(m) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } catch (e) { /* closed meanwhile */ } }
    function cleanup() {
      if (hbTimer) { timers.stopEvery(hbTimer); hbTimer = null; }
      hbWait = null;
      if (ws) { var w = ws; ws = null; try { w.onopen = w.onmessage = w.onclose = w.onerror = null; w.close(); } catch (e) { /* already closed */ } }
    }
    function retry(why, slow) {
      cleanup();
      if (stopped) return;
      setState('down', why);
      var wait = RETRY[Math.min(tries, RETRY.length - 1)];
      if (slow) wait = Math.max(wait, 60000); // refused (e.g. too many connections on the plan): do not hammer it
      tries++;
      if (retryTimer) timers.clear(retryTimer);
      retryTimer = timers.set(function () { retryTimer = null; connect(); }, wait);
    }
    function connect() {
      if (stopped) return;
      if (!WS) { setState('down', 'no WebSocket'); return; }
      setState(st === 'live' ? 'down' : st === 'down' ? 'down' : 'connecting');
      try { ws = new WS(wsUrl(o.url, o.key)); } catch (e) { retry(String(e && e.message || e)); return; }
      ws.onopen = function () {
        joinRef = String(++ref);
        var payload = { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false } };
        if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(o.key)) payload.access_token = o.key; // the classic anon key is a JWT; newer publishable keys are not
        send({ topic: topic, event: 'phx_join', payload: payload, ref: joinRef, join_ref: joinRef });
        hbTimer = timers.every(function () {
          if (hbWait) { retry('no answer from Supabase'); return; } // the last heartbeat got no reply: the line is dead
          hbWait = String(++ref);
          send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: hbWait });
        }, o.heartbeat || HEARTBEAT);
      };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
        if (!m) return;
        if (m.event === 'phx_reply' && m.ref === hbWait) { hbWait = null; return; }
        if (m.topic !== topic) return;
        if (m.event === 'phx_reply' && m.ref === joinRef) {
          var ok = m.payload && m.payload.status === 'ok';
          if (ok) { tries = 0; setState('live'); } else retry('Supabase refused the channel: ' + JSON.stringify((m.payload || {}).response || {}), true);
          return;
        }
        if (m.event === 'phx_error' || m.event === 'phx_close') { retry(m.event); return; }
        if (m.event === 'broadcast' || m.event === 'changed') {
          lastPing = Date.now();
          try { if (o.onPing) o.onPing((m.payload && m.payload.payload) || {}); } catch (e) { /* the app's own problem */ }
        }
      };
      ws.onclose = function (ev) { retry('closed' + (ev && ev.code ? ' (' + ev.code + ')' : '')); };
      ws.onerror = function () { /* onclose follows */ };
    }
    connect();
    return {
      state: function () { return st; },
      topic: function () { return o.topic; },
      lastPing: function () { return lastPing; },
      reconnect: function () { if (stopped) return; tries = 0; if (retryTimer) { timers.clear(retryTimer); retryTimer = null; } cleanup(); connect(); },
      stop: function () { stopped = true; if (retryTimer) { timers.clear(retryTimer); retryTimer = null; } cleanup(); setState('stopped'); }
    };
  }
  KpLive.wsUrl = wsUrl;
  if (typeof module !== 'undefined' && module.exports) module.exports = KpLive;
  else root.KpLive = KpLive;
})(typeof window !== 'undefined' ? window : globalThis);
