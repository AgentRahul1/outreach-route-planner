/* Outreach Route Planner — UI + network. All data stays in localStorage on this device. */
(function () {
  'use strict';
  var VERSION = '1.2.0';
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
    last: null
  };
  var S = load(KEY, defaults);
  S.settings = Object.assign({}, defaults.settings, S.settings || {});
  var geoCache = load(GEOKEY, {});
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

  // ---------- Stops ----------
  function addStops(lines) {
    lines.forEach(function (t) { S.stops.push({ id: uid(), text: t }); });
    save(); renderStops();
  }
  function renderStops() {
    var ul = $('stopList'); ul.innerHTML = '';
    S.stops.forEach(function (s, i) {
      var li = document.createElement('li');
      var sub = s.error ? '<span style="color:var(--bad)">⚠ ' + esc(s.error) + ' — edit or remove</span>' :
        (s.label ? esc(s.label) : '<span>not looked up yet</span>');
      li.innerHTML = '<div class="txt"><div>' + esc(s.text) + '</div><div class="sub">' + sub + '</div>' +
        (s.ambiguous && !s.confirmed ? '<button class="warn" data-act="pick">⚠ Several matches — tap to choose</button>' :
         (s.alts && s.alts.length > 1 ? '<button class="warn" data-act="pick" style="color:var(--m)">Change match</button>' : '')) +
        '</div><button data-act="edit" aria-label="Edit">✎</button><button data-act="del" aria-label="Remove">✕</button>';
      li.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          if (act === 'del') { S.stops.splice(i, 1); save(); renderStops(); }
          if (act === 'edit') { var t = prompt('Edit stop', s.text); if (t && t.trim()) { S.stops[i] = { id: s.id, text: t.trim() }; save(); renderStops(); } }
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
      b.addEventListener('click', function () { var v = b.getAttribute('data-v'); set(v); onChange(v); save(); });
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
    var url = base + '/table/v1/driving/' + coords + '?annotations=distance';
    var res;
    try { res = await fetch(url); } catch (e) { throw new Error('Could not reach the routing service. Check your connection, or try again in a minute.'); }
    if (res.status === 429) throw new Error('Routing service is busy (rate limited). Try again in a minute.');
    var data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || data.code !== 'Ok') throw new Error('Routing failed: ' + ((data && (data.message || data.code)) || ('HTTP ' + res.status)));
    var bad = [];
    function clean(M) { return M.map(function (row, i) { return row.map(function (v, j) { if (v == null) { bad.push(i); return 1e12; } return v; }); }); }
    if (!data.distances) throw new Error('Routing failed: no distances returned.');
    var out = { distance: clean(data.distances) };
    out.unreachable = bad;
    return out;
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
        var ge = await geocode(et); if (ge.error) throw new Error('End address not found: ' + et);
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
      var pts = [origin].concat(S.stops.map(function (x) { return { lat: x.lat, lng: x.lng, label: x.label, short: x.text }; }));
      if (end) pts.push(end);
      var M = await osrmTable(pts);
      var n = S.stops.length, stopIdx = []; for (var k = 1; k <= n; k++) stopIdx.push(k);
      var endIdx = S.endMode === 'return' ? 0 : (S.endMode === 'addr' ? n + 1 : null);
      var r = L.solve(M.distance, 0, stopIdx, endIdx);
      var path = [0].concat(r.order); if (endIdx != null) path.push(endIdx);
      if (L.pathCost(M.distance, path) >= 1e12) throw new Error('One or more stops could not be reached by road. Check the addresses.');
      S.last = {
        at: Date.now(), exact: r.exact,
        stops: path.map(function (pi, idx) {
          var p = pts[pi];
          return { lat: p.lat, lng: p.lng, label: p.label, short: p.short, isStart: idx === 0, isEnd: idx === path.length - 1 && endIdx != null,
            legM: idx ? M.distance[path[idx - 1]][pi] : 0 };
        }),
        totM: L.pathCost(M.distance, path)
      };
      save(); renderResult();
      status('Route ready.', 'ok');
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      status(e.message || String(e), 'err');
    } finally { btn.disabled = false; }
  }

  function renderResult() {
    var R = S.last; if (!R) { $('results').classList.add('hidden'); return; }
    $('results').classList.remove('hidden');
    $('totals').innerHTML =
      '<div class="box"><div class="muted small">Total distance</div><div class="big">' + fmtKm(R.totM) + '</div></div>' +
      '<div class="box"><div class="muted small">Stops</div><div class="big">' + R.stops.filter(function (p) { return !p.isStart && !p.isEnd; }).length + '</div></div>' +
      '<div class="cmp">Shortest driving distance' + (R.exact ? ' (best possible order)' : ' (near-best order)') + '.</div>';
    var ol = $('legList'); ol.innerHTML = '';
    R.stops.forEach(function (p, i) {
      var li = document.createElement('li');
      var tag = p.isStart ? 'S' : (p.isEnd ? 'E' : String(i));
      li.innerHTML = '<div class="n' + (p.isStart || p.isEnd ? ' s' : '') + '">' + tag + '</div><div class="txt"><div>' + esc(p.short) + '</div>' +
        (i ? '<div class="leg">+' + fmtKm(p.legM) + '</div>' : '<div class="leg">Start</div>') + '</div>';
      ol.appendChild(li);
    });
    var legs = L.buildMapsUrls(R.stops, +S.settings.maxWp || 9);
    var box = $('mapsBtns'); box.innerHTML = '';
    legs.forEach(function (lg, i) {
      var a = document.createElement('a'); a.className = 'btn maps'; a.href = lg.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = legs.length === 1 ? '🗺 Open in Google Maps' : '🗺 Leg ' + (i + 1) + ' of ' + legs.length + ': stops ' + labelOf(R, lg.from) + ' → ' + labelOf(R, lg.to);
      box.appendChild(a);
    });
    if (legs.length > 1) { var p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'Google Maps takes ' + S.settings.maxWp + ' stops per route, so your day is split. Open the next leg when you finish one.'; box.appendChild(p); }
  }
  function labelOf(R, i) { var p = R.stops[i]; return p.isStart ? 'Start' : (p.isEnd ? 'End' : String(i)); }

  // ---------- Wire up ----------
  function init() {
    $('ver').textContent = VERSION;
    renderSaved(); renderStops(); renderResult();
    seg('originMode', S.originMode, function (v) { S.originMode = v; showOriginPane(); }); showOriginPane();
    seg('endMode', S.endMode, function (v) { S.endMode = v; $('endAddrPane').classList.toggle('hidden', v !== 'addr'); });
    $('endAddrPane').classList.toggle('hidden', S.endMode !== 'addr');
    $('originInput').value = S.originText || ''; $('endInput').value = S.endText || '';
    $('savedSelect').addEventListener('change', function (e) { S.savedIdx = +e.target.value; save(); });
    $('btnGps').addEventListener('click', function () { getGps().catch(function (e) { status(e.message, 'err'); }); });
    $('btnAddStops').addEventListener('click', function () { var l = L.splitLines($('stopsInput').value); if (l.length) { addStops(l); $('stopsInput').value = ''; } });
    $('btnClearStops').addEventListener('click', function () { if (confirm('Remove all stops?')) { S.stops = []; S.last = null; save(); renderStops(); renderResult(); } });
    $('btnSaveOrigin').addEventListener('click', function () {
      var t = $('originInput').value.trim(); if (!t) return; var name = prompt('Name for this start (e.g. Office)'); if (!name) return;
      S.saved.push({ name: name.trim(), text: t }); save(); renderSaved();
    });
    $('btnPlan').addEventListener('click', plan);
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
      S.saved.push({ name: n, text: t }); $('newSavedName').value = ''; $('newSavedAddr').value = ''; save(); renderSaved();
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
