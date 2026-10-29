/* Outreach Route Planner — UI + network. All data stays in localStorage on this device. */
(function () {
  'use strict';
  var VERSION = '1.4.0';
  var L = window.RouteLib;
  var KEY = 'orp.state.v1', GEOKEY = 'orp.geocache.v1';
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var GTA_VIEWBOX = '-80.30,44.10,-78.90,43.20'; // west,north,east,south — biases results to the GTA/Halton/Peel

  var defaults = {
    stops: [],
    saved: [],
    savedIdx: 0, originMode: 'saved', originText: '', gps: null,
    endMode: 'last', endText: '',
    settings: { maxWp: 9, osrm: 'https://router.project-osrm.org', email: '' },
    last: null,
    routes: [],
    history: []
  };
  var S = load(KEY, defaults);
  if (!Array.isArray(S.routes)) S.routes = [];
  if (!Array.isArray(S.history)) S.history = [];
  S.settings = Object.assign({}, defaults.settings, S.settings || {});
  var geoCache = load(GEOKEY, {});
  var savedPick = null;
  // One-time setup link: #home=<address>&name=<label>. The # part never leaves the phone (not sent to the server).
  (function setupFromHash() {
    if (!location.hash || location.hash.length < 2) return;
    var h = new URLSearchParams(location.hash.slice(1)), addr = (h.get('home') || '').trim();
    if (addr) {
      var name = (h.get('name') || 'Home').trim();
      var ex = S.saved.filter(function (o) { return o.name.toLowerCase() === name.toLowerCase(); })[0];
      if (ex) { ex.text = addr; delete ex.lat; delete ex.lng; } else S.saved.unshift({ name: name, text: addr });
      S.savedIdx = 0; S.originMode = 'saved';
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
    }
    history.replaceState(null, '', location.pathname + location.search);
  })();

  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v ? Object.assign(JSON.parse(JSON.stringify(d)), v) : JSON.parse(JSON.stringify(d)); } catch (e) { return JSON.parse(JSON.stringify(d)); } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function saveGeo() { try { localStorage.setItem(GEOKEY, JSON.stringify(geoCache)); } catch (e) {} }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function status(msg, cls) { var el = $('status'); el.textContent = msg || ''; el.className = 'status ' + (cls || ''); }
  function fmtKm(m) { return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km'; }
  function fmtDur(sec) { return L.fmtDur(sec); }
  // Mark the displayed route as no longer matching the inputs, instead of silently showing a stale route.
  function invalidateRoute() {
    if (S.last && !S.last.stale) { S.last.stale = true; save(); renderResult(); }
  }

  // ---------- Geocoding (Nominatim, max 1 request/second, cached on device) ----------
  var lastReq = 0;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function haversine(a, b) {
    var R = 6371000, t = Math.PI / 180, dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  async function nominatim(q) {
    var key = q.toLowerCase().trim();
    if (geoCache[key]) return geoCache[key];
    var wait = 1100 - (Date.now() - lastReq); if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    var url = NOMINATIM + '?format=jsonv2&limit=5&countrycodes=ca&viewbox=' + GTA_VIEWBOX + '&q=' + encodeURIComponent(q) +
      (S.settings.email ? '&email=' + encodeURIComponent(S.settings.email) : '');
    var res;
    try { res = await fetch(url, { headers: { 'Accept': 'application/json' } }); }
    catch (e) { throw new Error('Could not reach the address lookup service. Check your connection.'); }
    if (res.status === 429) throw new Error('Address lookup is busy (rate limited). Wait a minute and try again.');
    if (!res.ok) throw new Error('Address lookup failed (HTTP ' + res.status + ').');
    var data = await res.json();
    var out = data.map(function (r) { return { lat: +r.lat, lng: +r.lon, label: r.display_name }; });
    geoCache[key] = out; saveGeo();
    return out;
  }
  // Resolve text to {lat,lng,label,alts,ambiguous,error}
  async function geocode(text) {
    var c = L.parseCoord(text);
    if (c) return { lat: c.lat, lng: c.lng, label: L.fmtLL(c), alts: [], ambiguous: false };
    var tries = [text], cleaned = L.cleanAddress(text);
    if (cleaned && cleaned !== text) tries.push(cleaned);
    if (!/\b(on|ontario)\b/i.test(cleaned)) tries.push(cleaned + ', Ontario');
    for (var i = 0; i < tries.length; i++) {
      var r = await nominatim(tries[i]);
      if (r.length) {
        var distinct = r.filter(function (x, idx) { return idx === 0 || haversine(r[0], x) > 400; });
        return { lat: r[0].lat, lng: r[0].lng, label: r[0].label, alts: r, ambiguous: distinct.length > 1 };
      }
    }
    return { error: 'Address not found' };
  }

  // ---------- Address suggestions as you type (Photon) ----------
  var acCache = {};
  function attachAutocomplete(el, onPick, opts) {
    opts = opts || {};
    var wrap = el.parentNode, list = document.createElement('ul'), timer = null, ctrl = null, items = [], active = -1, seq = 0;
    list.className = 'ac-list hidden'; list.setAttribute('role', 'listbox'); wrap.appendChild(list);
    el.setAttribute('aria-autocomplete', 'list');
    function query() { // for textareas, use the line at the caret
      if (el.tagName !== 'TEXTAREA') return el.value.trim();
      var v = el.value, pos = el.selectionStart == null ? v.length : el.selectionStart;
      var a = v.lastIndexOf('\n', pos - 1) + 1, b = v.indexOf('\n', pos); if (b < 0) b = v.length;
      return v.slice(a, b).trim();
    }
    function hide() { list.classList.add('hidden'); list.innerHTML = ''; items = []; active = -1; }
    function render(res, note) {
      list.innerHTML = ''; items = res; active = -1;
      res.forEach(function (r, i) {
        var li = document.createElement('li'); li.setAttribute('role', 'option');
        li.innerHTML = '<div>' + esc(r.label) + '</div>' + (r.sub ? '<div class="s">' + esc(r.sub) + '</div>' : '');
        li.addEventListener('pointerdown', function (e) { e.preventDefault(); }); // keep focus so blur doesn't close first
        li.addEventListener('click', function () { choose(i); });
        list.appendChild(li);
      });
      if (note) { var n = document.createElement('li'); n.className = 'note'; n.textContent = note; list.appendChild(n); }
      list.classList.toggle('hidden', !res.length && !note);
    }
    function choose(i) {
      var r = items[i]; if (!r) return; hide();
      onPick(r, el);
    }
    function run() {
      var q = query();
      if (q.length < 3 || L.parseCoord(q)) { hide(); return; }
      var key = q.toLowerCase();
      if (acCache[key]) { render(acCache[key], acCache[key].length ? '' : 'No suggestions. You can still type the full address.'); return; }
      if (ctrl) ctrl.abort();
      ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var my = ++seq;
      fetch(L.photonUrl(q, 5), ctrl ? { signal: ctrl.signal } : {})
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          var res = L.parsePhoton(j); acCache[key] = res;
          if (my === seq && document.activeElement === el) render(res, res.length ? '' : 'No suggestions. You can still type the full address.');
        })
        .catch(function (e) { if (e.name !== 'AbortError' && my === seq) render([], 'Suggestions unavailable right now. Type the full address.'); });
    }
    el.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300); });
    el.addEventListener('focus', function () { setTimeout(function () { try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {} }, 300); });
    el.addEventListener('blur', function () { setTimeout(hide, 150); });
    el.addEventListener('keydown', function (e) {
      if (list.classList.contains('hidden')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!items.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        Array.prototype.forEach.call(list.children, function (li, i) { li.classList.toggle('act', i === active); });
      } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    });
  }
  // Replace the caret's line in a textarea with nothing (used after a stop suggestion is added)
  function removeCaretLine(el) {
    var v = el.value, pos = el.selectionStart == null ? v.length : el.selectionStart;
    var a = v.lastIndexOf('\n', pos - 1) + 1, b = v.indexOf('\n', pos); if (b < 0) b = v.length; else b += 1;
    el.value = (v.slice(0, a) + v.slice(b)).replace(/\n+$/, '');
  }
  function picked(r) { return { lat: r.lat, lng: r.lng, label: r.label + (r.sub ? ' · ' + r.sub : ''), name: r.name || '', confirmed: true, ambiguous: false }; }

  // ---------- Stops ----------
  function addStops(lines) {
    lines.forEach(function (t) { S.stops.push({ id: uid(), text: t }); });
    save(); renderStops(); invalidateRoute();
  }
  var editingStopId = null, editingPick = null;
  function openEditStop(s) {
    editingStopId = s.id; editingPick = null;
    $('editInput').value = s.text;
    attachAutocompleteOnce();
    $('editDlg').showModal();
    setTimeout(function () { $('editInput').focus(); $('editInput').select(); }, 50);
  }
  var editAcAttached = false;
  function attachAutocompleteOnce() {
    if (editAcAttached) return; editAcAttached = true;
    attachAutocomplete($('editInput'), function (r, el) {
      el.value = r.label; editingPick = Object.assign({ text: r.label }, picked(r));
    });
  }
  function saveEditStop() {
    var t = $('editInput').value.trim(); if (!t) return;
    var idx = S.stops.findIndex(function (x) { return x.id === editingStopId; });
    if (idx >= 0) {
      if (editingPick && editingPick.text === t) S.stops[idx] = Object.assign({ id: editingStopId, text: editingPick.name || t }, editingPick);
      else S.stops[idx] = { id: editingStopId, text: t };
      save(); renderStops(); invalidateRoute(); status('Stop updated.', 'ok');
    }
    $('editDlg').close();
  }
  function moveStop(i, dir) {
    var j = i + dir; if (j < 0 || j >= S.stops.length) return;
    var tmp = S.stops[i]; S.stops[i] = S.stops[j]; S.stops[j] = tmp;
    save(); renderStops(); invalidateRoute();
  }
  function renderStops() {
    var ul = $('stopList'); ul.innerHTML = '';
    S.stops.forEach(function (s, i) {
      var li = document.createElement('li');
      var title = s.name || s.text;
      var addrLine = s.name && s.label ? esc(s.label) : (s.label && s.label !== s.text ? esc(s.label) : '');
      var sub = s.error ? '<span style="color:var(--bad)">⚠ ' + esc(s.error) + ' — edit or remove</span>' :
        (addrLine || '<span>not looked up yet</span>');
      li.innerHTML = '<div class="txt"><div>' + esc(title) + '</div><div class="sub">' + sub + '</div>' +
        (s.ambiguous && !s.confirmed ? '<button class="warn" data-act="pick">⚠ Several matches — tap to choose</button>' :
         (s.alts && s.alts.length > 1 ? '<button class="warn" data-act="pick" style="color:var(--m)">Change match</button>' : '')) +
        '</div>' +
        '<button data-act="up" class="mini" aria-label="Move up" ' + (i === 0 ? 'disabled' : '') + '>↑</button>' +
        '<button data-act="down" class="mini" aria-label="Move down" ' + (i === S.stops.length - 1 ? 'disabled' : '') + '>↓</button>' +
        '<button data-act="edit" aria-label="Edit">✎</button><button data-act="del" aria-label="Remove">✕</button>';
      li.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          if (act === 'del') { S.stops.splice(i, 1); save(); renderStops(); invalidateRoute(); }
          if (act === 'edit') openEditStop(s);
          if (act === 'up') moveStop(i, -1);
          if (act === 'down') moveStop(i, 1);
          if (act === 'pick') pickMatch(s);
        });
      });
      ul.appendChild(li);
    });
    $('stopCount').textContent = S.stops.length;
    $('btnClearStops').classList.toggle('hidden', S.stops.length === 0);
  }
  function pickMatch(s) {
    return new Promise(function (resolve) {
      var dlg = $('pickDlg'), box = $('pickOpts');
      $('pickQuery').textContent = s.text; box.innerHTML = '';
      (s.alts || []).forEach(function (a) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = a.label;
        b.addEventListener('click', function () {
          s.lat = a.lat; s.lng = a.lng; s.label = a.label; s.confirmed = true; save(); renderStops(); dlg.close(); resolve(true);
        });
        box.appendChild(b);
      });
      dlg.addEventListener('close', function h() { dlg.removeEventListener('close', h); resolve(false); });
      dlg.showModal();
    });
  }

  // ---------- Segmented controls ----------
  function seg(id, value, onChange) {
    var el = $(id);
    function set(v) { el.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === v); }); }
    set(value);
    el.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { var v = b.getAttribute('data-v'); set(v); onChange(v); save(); invalidateRoute(); });
    });
  }
  function showOriginPane() {
    $('originSaved').classList.toggle('hidden', S.originMode !== 'saved');
    $('originGps').classList.toggle('hidden', S.originMode !== 'gps');
    $('originTyped').classList.toggle('hidden', S.originMode !== 'typed');
  }
  function renderSaved() {
    var sel = $('savedSelect'); sel.innerHTML = '';
    if (!S.saved.length) { var op0 = document.createElement('option'); op0.value = ''; op0.textContent = 'No saved starts yet. Add one in ⚙︎ Settings'; sel.appendChild(op0); }
    S.saved.forEach(function (o, i) { var op = document.createElement('option'); op.value = i; op.textContent = o.name + ' — ' + o.text; sel.appendChild(op); });
    if (S.savedIdx >= S.saved.length) S.savedIdx = 0;
    sel.value = S.savedIdx;
    var ul = $('savedList'); ul.innerHTML = '';
    S.saved.forEach(function (o, i) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="txt"><b>' + esc(o.name) + '</b><div class="sub">' + esc(o.text) + '</div></div><button type="button" aria-label="Delete">✕</button>';
      li.querySelector('button').addEventListener('click', function () { S.saved.splice(i, 1); save(); renderSaved(); });
      ul.appendChild(li);
    });
  }

  // ---------- Routing (OSRM table) ----------
  async function osrmTable(points) {
    var base = (S.settings.osrm || defaults.settings.osrm).replace(/\/+$/, '');
    var coords = points.map(function (p) { return p.lng.toFixed(6) + ',' + p.lat.toFixed(6); }).join(';');
    var url = base + '/table/v1/driving/' + coords + '?annotations=distance,duration';
    var res;
    try { res = await fetch(url); } catch (e) { throw new Error('Could not reach the routing service. Check your connection, or try again in a minute.'); }
    if (res.status === 429) throw new Error('Routing service is busy (rate limited). Try again in a minute.');
    var data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || data.code !== 'Ok') throw new Error('Routing failed: ' + ((data && (data.message || data.code)) || ('HTTP ' + res.status)));
    var bad = [];
    function clean(M) { return M.map(function (row, i) { return row.map(function (v, j) { if (v == null) { bad.push(i); return 1e12; } return v; }); }); }
    if (!data.distances) throw new Error('Routing failed: no distances returned.');
    var out = { distance: clean(data.distances) };
    if (data.durations) out.duration = data.durations.map(function (row) { return row.map(function (v) { return v == null ? 1e12 : v; }); });
    out.unreachable = bad;
    return out;
  }
  // Fetch the actual road geometry for the planned path, for the in-app map. Best-effort: returns null on failure.
  async function osrmRouteGeom(points) {
    try {
      var base = (S.settings.osrm || defaults.settings.osrm).replace(/\/+$/, '');
      var coords = points.map(function (p) { return p.lng.toFixed(6) + ',' + p.lat.toFixed(6); }).join(';');
      var res = await fetch(base + '/route/v1/driving/' + coords + '?overview=full&geometries=geojson&steps=false');
      if (!res.ok) return null;
      var data = await res.json();
      if (!data || !data.routes || !data.routes[0] || !data.routes[0].geometry) return null;
      var cs = data.routes[0].geometry.coordinates || [];
      // Downsample to keep localStorage small; a preview line does not need every point.
      var step = cs.length > 400 ? Math.ceil(cs.length / 400) : 1;
      var out = [];
      for (var i = 0; i < cs.length; i += step) out.push([+cs[i][1].toFixed(5), +cs[i][0].toFixed(5)]);
      if (cs.length) { var lastPt = cs[cs.length - 1]; out.push([+lastPt[1].toFixed(5), +lastPt[0].toFixed(5)]); }
      return out;
    } catch (e) { return null; }
  }

  // ---------- Plan ----------
  async function resolveOrigin() {
    if (S.originMode === 'gps') {
      if (!S.gps) await getGps();
      return { lat: S.gps.lat, lng: S.gps.lng, label: 'My location', short: 'My location' };
    }
    if (S.originMode === 'typed') {
      var t = $('originInput').value.trim(); if (!t) throw new Error('Type a start address.');
      S.originText = t; save();
      if (S.originPick && S.originPick.text === t) return { lat: S.originPick.lat, lng: S.originPick.lng, label: S.originPick.label, short: t };
      var g = await geocode(t); if (g.error) throw new Error('Start address not found: ' + t);
      return { lat: g.lat, lng: g.lng, label: g.label, short: t };
    }
    var o = S.saved[S.savedIdx]; if (!o) throw new Error('No saved start yet. Tap ⚙︎ to add Home, or choose My location / Type address.');
    if (o.lat == null) { var g2 = await geocode(o.text); if (g2.error) throw new Error('Saved start not found: ' + o.text); o.lat = g2.lat; o.lng = g2.lng; o.label = g2.label; save(); }
    return { lat: o.lat, lng: o.lng, label: o.label || o.text, short: o.name };
  }
  function getGps() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('Location is not available on this device.'));
      $('gpsStatus').textContent = 'Getting your location…';
      navigator.geolocation.getCurrentPosition(function (p) {
        S.gps = { lat: p.coords.latitude, lng: p.coords.longitude, at: Date.now() }; save();
        $('gpsStatus').textContent = 'Got it (±' + Math.round(p.coords.accuracy) + ' m).'; resolve();
      }, function (e) {
        $('gpsStatus').textContent = ''; reject(new Error('Could not get your location: ' + (e.code === 1 ? 'permission denied. Allow location for this app in Settings, or pick another start.' : e.message)));
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
  }

  async function plan() {
    var btn = $('btnPlan'); btn.disabled = true;
    if (S.last) { S.last.stale = true; save(); renderResult(); }
    try {
      var pending = L.splitLines($('stopsInput').value);
      if (pending.length) { addStops(pending); $('stopsInput').value = ''; }
      if (!S.stops.length) throw new Error('Add at least one stop.');
      if (S.stops.length > 90) throw new Error('Too many stops (max 90).');
      status('Finding your start…');
      var origin = await resolveOrigin();
      for (var i = 0; i < S.stops.length; i++) {
        var s = S.stops[i];
        if (s.lat != null) continue;
        status('Looking up address ' + (i + 1) + ' of ' + S.stops.length + '…');
        var g = await geocode(s.text);
        if (g.error) { s.error = g.error; } else { Object.assign(s, g); delete s.error; }
        save(); renderStops();
      }
      var failed = S.stops.filter(function (x) { return x.error; });
      if (failed.length) throw new Error(failed.length + ' address(es) not found. Edit them (try adding the city) or paste lat,lng instead.');
      var end = null;
      if (S.endMode === 'addr') {
        var et = $('endInput').value.trim(); if (!et) throw new Error('Type an end address, or pick another end option.');
        S.endText = et; save(); status('Finding your end point…');
        var ge = (S.endPick && S.endPick.text === et) ? S.endPick : await geocode(et); if (ge.error) throw new Error('End address not found: ' + et);
        end = { lat: ge.lat, lng: ge.lng, label: ge.label, short: et };
      }
      var amb = S.stops.filter(function (x) { return x.ambiguous && !x.confirmed; });
      for (var a = 0; a < amb.length; a++) {
        if (!confirm('"' + amb[a].text + '" matched more than one place. Using: ' + amb[a].label + '\n\nOK = use this one. Cancel = let me choose.')) {
          var picked = await pickMatch(amb[a]); if (!picked) { status(''); return; }
        } else { amb[a].confirmed = true; save(); }
      }
      renderStops();
      status('Calculating road distances…');
      var pts = [origin].concat(S.stops.map(function (x) { return { lat: x.lat, lng: x.lng, label: x.label, short: x.name || x.text, name: x.name || '' }; }));
      if (end) pts.push(end);
      var M = await osrmTable(pts);
      var n = S.stops.length, stopIdx = []; for (var k = 1; k <= n; k++) stopIdx.push(k);
      var endIdx = S.endMode === 'return' ? 0 : (S.endMode === 'addr' ? n + 1 : null);
      var r = L.solve(M.distance, 0, stopIdx, endIdx);
      var path = [0].concat(r.order); if (endIdx != null) path.push(endIdx);
      if (L.pathCost(M.distance, path) >= 1e12) throw new Error('One or more stops could not be reached by road. Check the addresses.');
      var durM = M.duration || null;
      status('Drawing your route…');
      var geom = await osrmRouteGeom(path.map(function (pi) { return pts[pi]; }));
      S.last = {
        at: Date.now(), exact: r.exact, stale: false,
        distMatrix: M.distance, durMatrix: durM, geom: geom,
        stops: path.map(function (pi, idx) {
          var p = pts[pi];
          return { lat: p.lat, lng: p.lng, label: p.label, short: p.short, name: p.name || '', ptIdx: pi, isStart: idx === 0, isEnd: idx === path.length - 1 && endIdx != null,
            legM: idx ? M.distance[path[idx - 1]][pi] : 0, legSec: idx && durM ? durM[path[idx - 1]][pi] : null };
        }),
        totM: L.pathCost(M.distance, path),
        totSec: durM ? L.pathCost(durM, path) : null
      };
      pushHistory();
      save(); renderResult(); renderRoutes();
      status('Route ready.', 'ok');
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      status(e.message || String(e), 'err');
    } finally { btn.disabled = false; }
  }

  // ---------- Saved routes & history ----------
  function snapshot() {
    return JSON.parse(JSON.stringify({
      stops: S.stops, originMode: S.originMode, originText: S.originText, originPick: S.originPick || null,
      savedIdx: S.savedIdx, gps: S.gps, endMode: S.endMode, endText: S.endText, endPick: S.endPick || null, last: S.last
    }));
  }
  function loadSnapshot(snap) {
    if (!snap) return;
    var c = JSON.parse(JSON.stringify(snap));
    S.stops = c.stops || []; S.originMode = c.originMode || 'saved'; S.originText = c.originText || ''; S.originPick = c.originPick || null;
    S.savedIdx = c.savedIdx || 0; S.gps = c.gps || null; S.endMode = c.endMode || 'last'; S.endText = c.endText || ''; S.endPick = c.endPick || null;
    S.last = c.last || null;
    save();
    $('originInput').value = S.originText || ''; $('endInput').value = S.endText || '';
    document.querySelectorAll('#originMode button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === S.originMode); });
    document.querySelectorAll('#endMode button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === S.endMode); });
    showOriginPane(); $('endAddrPane').classList.toggle('hidden', S.endMode !== 'addr');
    renderSaved(); renderStops(); renderResult(); renderRoutes();
    status('Route loaded.', 'ok');
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function pushHistory() {
    var name = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' · ' +
      S.last.stops.filter(function (p) { return !p.isStart && !p.isEnd; }).length + ' stops · ' + fmtKm(S.last.totM);
    S.history.unshift({ id: uid(), at: Date.now(), name: name, snap: snapshot() });
    S.history = S.history.slice(0, 10);
  }
  function renderRoutes() {
    var has = S.routes.length || S.history.length;
    $('routesCard').classList.toggle('hidden', !has);
    function fill(ulId, items, canDelete) {
      var ul = $(ulId); ul.innerHTML = '';
      if (!items.length) { ul.innerHTML = '<li><div class="txt muted">None yet.</div></li>'; return; }
      items.forEach(function (it, i) {
        var li = document.createElement('li');
        li.innerHTML = '<div class="txt"><div>' + esc(it.name) + '</div><div class="sub">' + new Date(it.at).toLocaleString() + '</div></div>' +
          '<button data-act="load" class="mini">Load</button>' + (canDelete ? '<button data-act="del" aria-label="Delete">✕</button>' : '');
        li.querySelector('[data-act="load"]').addEventListener('click', function () { loadSnapshot(it.snap); });
        var del = li.querySelector('[data-act="del"]');
        if (del) del.addEventListener('click', function () { items.splice(i, 1); save(); renderRoutes(); });
        ul.appendChild(li);
      });
    }
    fill('savedRoutesList', S.routes, true);
    fill('historyList', S.history, false);
  }

  // ---------- Result: map, reorder, share ----------
  var mapObj = null;
  function renderMap(R) {
    var el = $('map');
    if (!window.L || !R.stops || !R.stops.length) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    try {
      if (!mapObj) {
        mapObj = window.L.map(el, { scrollWheelZoom: false });
        window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(mapObj);
      }
      mapObj.eachLayer(function (layer) { if (!(layer instanceof window.L.TileLayer)) mapObj.removeLayer(layer); });
      var latlngs = [];
      if (R.geom && R.geom.length > 1) {
        var line = window.L.polyline(R.geom, { color: '#0f4c81', weight: 5, opacity: 0.85 }).addTo(mapObj);
        latlngs = R.geom;
      } else {
        latlngs = R.stops.map(function (p) { return [p.lat, p.lng]; });
        window.L.polyline(latlngs, { color: '#0f4c81', weight: 4, opacity: 0.7, dashArray: '6 6' }).addTo(mapObj);
      }
      R.stops.forEach(function (p, i) {
        var tag = p.isStart ? 'S' : (p.isEnd ? 'E' : String(i));
        var icon = window.L.divIcon({ className: '', html: '<div class="map-pin' + (p.isStart || p.isEnd ? ' se' : '') + '">' + tag + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
        window.L.marker([p.lat, p.lng], { icon: icon }).addTo(mapObj).bindPopup(esc(p.name || p.short || ''));
      });
      setTimeout(function () { try { mapObj.invalidateSize(); mapObj.fitBounds(latlngs, { padding: [24, 24] }); } catch (e) {} }, 60);
    } catch (e) { el.classList.add('hidden'); }
  }
  function recomputeLegs() {
    var R = S.last; if (!R || !R.distMatrix) return;
    var totM = 0, totSec = R.durMatrix ? 0 : null;
    R.stops.forEach(function (p, i) {
      if (!i) { p.legM = 0; p.legSec = null; return; }
      var prev = R.stops[i - 1];
      p.legM = R.distMatrix[prev.ptIdx][p.ptIdx];
      p.legSec = R.durMatrix ? R.durMatrix[prev.ptIdx][p.ptIdx] : null;
      totM += p.legM; if (totSec != null) totSec += p.legSec;
    });
    R.totM = totM; R.totSec = totSec; R.geom = null; // geometry no longer matches a hand-edited order; map falls back to a straight-line preview
    R.exact = false;
  }
  function moveResultStop(i, dir) {
    var R = S.last; if (!R) return;
    var j = i + dir;
    if (i <= 0 || j <= 0 || i >= R.stops.length - (R.stops[R.stops.length - 1].isEnd ? 1 : 0) || j >= R.stops.length - (R.stops[R.stops.length - 1].isEnd ? 1 : 0)) return;
    var tmp = R.stops[i]; R.stops[i] = R.stops[j]; R.stops[j] = tmp;
    recomputeLegs(); save(); renderResult();
    status('Order updated — distance and time recalculated. The map preview is now a straight line until you re-plan.', 'ok');
  }
  function routeText() {
    var R = S.last; if (!R) return '';
    var lines = ['Outreach route — ' + fmtKm(R.totM) + (R.totSec ? ' · about ' + fmtDur(R.totSec) + ' driving' : '')];
    R.stops.forEach(function (p, i) {
      var tag = p.isStart ? 'Start' : (p.isEnd ? 'End' : String(i));
      lines.push(tag + '. ' + (p.name || p.short) + (p.label && p.label !== p.short ? ' — ' + p.label : '') + (i ? ' (+' + fmtKm(p.legM) + (p.legSec ? ', ' + fmtDur(p.legSec) : '') + ')' : ''));
    });
    var legs = L.buildMapsUrls(R.stops, +S.settings.maxWp || 9);
    if (legs.length) lines.push('Google Maps: ' + legs[0].url);
    return lines.join('\n');
  }

  function renderResult() {
    var R = S.last; if (!R) { $('results').classList.add('hidden'); return; }
    $('results').classList.remove('hidden');
    $('results').classList.toggle('results-stale', !!R.stale);
    $('staleBanner').classList.toggle('hidden', !R.stale);
    $('totals').innerHTML =
      '<div class="box"><div class="muted small">Total distance</div><div class="big">' + fmtKm(R.totM) + '</div></div>' +
      '<div class="box"><div class="muted small">Drive time</div><div class="big">' + (R.totSec ? fmtDur(R.totSec) : '—') + '</div></div>' +
      '<div class="box"><div class="muted small">Stops</div><div class="big">' + R.stops.filter(function (p) { return !p.isStart && !p.isEnd; }).length + '</div></div>' +
      '<div class="cmp">Shortest driving distance' + (R.exact ? ' (best possible order)' : ' (near-best / hand-adjusted order)') + '. Drive time is an estimate with no live traffic.</div>';
    renderMap(R);
    var ol = $('legList'); ol.innerHTML = '';
    var hasEnd = R.stops.length && R.stops[R.stops.length - 1].isEnd;
    R.stops.forEach(function (p, i) {
      var li = document.createElement('li');
      var tag = p.isStart ? 'S' : (p.isEnd ? 'E' : String(i));
      var movable = !p.isStart && !p.isEnd;
      li.innerHTML = '<div class="n' + (p.isStart || p.isEnd ? ' s' : '') + '">' + tag + '</div><div class="txt" style="flex:1"><div>' + esc(p.name || p.short) + '</div>' +
        (p.name && p.label ? '<div class="leg">' + esc(p.label) + '</div>' : '') +
        (i ? '<div class="leg">+' + fmtKm(p.legM) + (p.legSec ? ' · ' + fmtDur(p.legSec) : '') + '</div>' : '<div class="leg">Start</div>') + '</div>' +
        (movable ? '<button class="mini" data-mv="-1" aria-label="Move earlier">↑</button><button class="mini" data-mv="1" aria-label="Move later">↓</button>' : '');
      li.querySelectorAll('[data-mv]').forEach(function (b) {
        b.addEventListener('click', function () { moveResultStop(i, +b.getAttribute('data-mv')); });
      });
      ol.appendChild(li);
    });
    var legs = L.buildMapsUrls(R.stops, +S.settings.maxWp || 9);
    var box = $('mapsBtns'); box.innerHTML = '';
    legs.forEach(function (lg, i) {
      var a = document.createElement('a'); a.className = 'btn maps'; a.href = lg.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = legs.length === 1 ? '🗺 Open in Google Maps' : '🗺 Leg ' + (i + 1) + ' of ' + legs.length + ': stops ' + labelOf(R, lg.from) + ' → ' + labelOf(R, lg.to);
      box.appendChild(a);
    });
    var apple = document.createElement('a'); apple.className = 'btn apple'; apple.href = L.buildAppleMapsUrl(R.stops); apple.target = '_blank'; apple.rel = 'noopener noreferrer';
    apple.textContent = '🍎 Open in Apple Maps'; box.appendChild(apple);
    if (legs.length > 1) { var p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'Google Maps takes ' + S.settings.maxWp + ' stops per route, so your day is split. Open the next leg when you finish one.'; box.appendChild(p); }
  }
  function labelOf(R, i) { var p = R.stops[i]; return p.isStart ? 'Start' : (p.isEnd ? 'End' : String(i)); }

  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ---------- Wire up ----------
  function init() {
    $('ver').textContent = VERSION;
    renderSaved(); renderStops(); renderResult(); renderRoutes();
    seg('originMode', S.originMode, function (v) { S.originMode = v; showOriginPane(); }); showOriginPane();
    seg('endMode', S.endMode, function (v) { S.endMode = v; $('endAddrPane').classList.toggle('hidden', v !== 'addr'); });
    $('endAddrPane').classList.toggle('hidden', S.endMode !== 'addr');
    $('originInput').value = S.originText || ''; $('endInput').value = S.endText || '';
    $('savedSelect').addEventListener('change', function (e) { S.savedIdx = +e.target.value; save(); });
    $('btnGps').addEventListener('click', function () { getGps().catch(function (e) { status(e.message, 'err'); }); });
    $('btnAddStops').addEventListener('click', function () { var l = L.splitLines($('stopsInput').value); if (l.length) { addStops(l); $('stopsInput').value = ''; } });
    $('btnClearStops').addEventListener('click', function () { if (confirm('Remove all stops?')) { S.stops = []; S.last = null; save(); renderStops(); renderResult(); } });
    $('originInput').addEventListener('input', function () { S.originPick = null; invalidateRoute(); });
    $('endInput').addEventListener('input', function () { S.endPick = null; invalidateRoute(); });
    $('btnSaveOrigin').addEventListener('click', function () {
      var t = $('originInput').value.trim();
      if (!t) { status('Type a start address first, then save it.', 'err'); return; }
      $('saveStartAddr').textContent = t;
      $('saveStartName').value = '';
      $('saveStartDlg').showModal();
      setTimeout(function () { $('saveStartName').focus(); }, 50);
    });
    $('btnSaveStartConfirm').addEventListener('click', function () {
      var t = $('originInput').value.trim(), name = $('saveStartName').value.trim();
      if (!name) { $('saveStartName').focus(); return; }
      var op = S.originPick && S.originPick.text === t ? S.originPick : null;
      S.saved.push(op ? { name: name, text: t, lat: op.lat, lng: op.lng, label: op.label } : { name: name, text: t });
      S.savedIdx = S.saved.length - 1;
      save(); renderSaved();
      $('saveStartDlg').close();
      status('Saved start "' + name + '" — you can pick it any time under Start → Saved.', 'ok');
    });
    $('btnEditSave').addEventListener('click', saveEditStop);
    $('btnCopyRoute').addEventListener('click', function () {
      var txt = routeText(); if (!txt) return;
      function done() { status('Route copied — paste it anywhere.', 'ok'); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt); done(); });
      else { fallbackCopy(txt); done(); }
    });
    $('btnShareRoute').addEventListener('click', function () {
      var txt = routeText(); if (!txt) return;
      if (navigator.share) navigator.share({ title: 'Outreach route', text: txt }).catch(function () {});
      else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { status('Sharing is not available here, so the route was copied instead.', 'ok'); });
      else { fallbackCopy(txt); status('Sharing is not available here, so the route was copied instead.', 'ok'); }
    });
    $('btnSaveRoute').addEventListener('click', function () {
      if (!S.last) return;
      var name = $('saveRouteName').value.trim() || new Date(S.last.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' route';
      S.routes.unshift({ id: uid(), at: Date.now(), name: name, snap: snapshot() });
      save(); renderRoutes(); $('saveRouteName').value = '';
      status('Route saved — find it under Saved routes below.', 'ok');
    });
    $('btnPlan').addEventListener('click', plan);
    attachAutocomplete($('originInput'), function (r, el) {
      el.value = r.label; S.originText = r.label; S.originPick = Object.assign({ text: r.label }, picked(r)); save();
    });
    attachAutocomplete($('endInput'), function (r, el) {
      el.value = r.label; S.endText = r.label; S.endPick = Object.assign({ text: r.label }, picked(r)); save();
    });
    attachAutocomplete($('newSavedAddr'), function (r, el) {
      el.value = r.label; savedPick = Object.assign({ text: r.label }, picked(r));
    });
    attachAutocomplete($('stopsInput'), function (r, el) {
      removeCaretLine(el);
      S.stops.push(Object.assign({ id: uid(), text: r.label }, picked(r))); save(); renderStops(); invalidateRoute();
      status('Added: ' + (r.name || r.label), 'ok'); el.focus();
    });
    $('btnSettings').addEventListener('click', function () {
      $('maxWp').value = String(S.settings.maxWp); $('osrmUrl').value = S.settings.osrm; $('contactEmail').value = S.settings.email || '';
      $('settingsDlg').showModal();
    });
    $('settingsDlg').addEventListener('close', function () {
      S.settings.maxWp = +$('maxWp').value || 9; S.settings.osrm = $('osrmUrl').value.trim() || defaults.settings.osrm;
      S.settings.email = $('contactEmail').value.trim(); save(); renderResult();
    });
    $('btnAddSaved').addEventListener('click', function () {
      var n = $('newSavedName').value.trim(), t = $('newSavedAddr').value.trim(); if (!n || !t) return;
      var sp = savedPick && savedPick.text === t ? savedPick : null;
      S.saved.push(sp ? { name: n, text: t, lat: sp.lat, lng: sp.lng, label: sp.label } : { name: n, text: t }); savedPick = null; $('newSavedName').value = ''; $('newSavedAddr').value = ''; save(); renderSaved();
    });
    $('btnClearCache').addEventListener('click', function () { geoCache = {}; saveGeo(); alert('Saved lookups cleared.'); });
    $('btnWipe').addEventListener('click', function () {
      if (!confirm('Erase all stops, saved starts and lookups from this phone?')) return;
      localStorage.removeItem(KEY); localStorage.removeItem(GEOKEY); location.reload();
    });
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  init();
})();
