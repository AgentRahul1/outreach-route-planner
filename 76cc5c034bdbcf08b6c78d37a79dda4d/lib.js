/* Outreach Route Planner core logic (pure functions, no network). Works in browser and Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RouteLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Parse "lat,lng" (also "lat lng", with optional degree signs / N S E W). Returns {lat,lng} or null.
  function parseCoord(text) {
    if (typeof text !== 'string') return null;
    var s = text.trim().replace(/[°]/g, '');
    var m = s.match(/^\(?\s*([-+]?\d{1,3}(?:\.\d+)?)\s*([NSns])?\s*[, ;]\s*([-+]?\d{1,3}(?:\.\d+)?)\s*([EWew])?\s*\)?$/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lng = parseFloat(m[3]);
    if (m[2] && /s/i.test(m[2])) lat = -Math.abs(lat);
    if (m[4] && /w/i.test(m[4])) lng = -Math.abs(lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: lat, lng: lng };
  }

  // Split pasted text into stop lines (one per line; ignores blanks and list bullets/numbers).
  function splitLines(text) {
    return String(text || '').split(/\r?\n/)
      .map(function (l) { return l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim(); })
      .filter(function (l) { return l.length > 0; });
  }

  // Remove unit/suite/apartment parts that confuse OSM geocoders.
  function cleanAddress(a) {
    return String(a)
      .replace(/\b(?:unit|suite|ste|apt|apartment|room|rm|floor|fl)\.?\s*#?\s*[\w-]+\s*,?/gi, '')
      .replace(/#\s*[\w-]+\s*,?/g, '')
      .replace(/^\s*\d+[A-Za-z]?\s*-\s*(?=\d)/, '') // "12A-100 Example Rd" -> "100 Example Rd"
      .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '');
  }

  // Cost of a full path given as list of matrix indices.
  function pathCost(M, path) {
    var c = 0;
    for (var i = 0; i + 1 < path.length; i++) c += M[path[i]][path[i + 1]];
    return c;
  }

  /*
   * Solve visiting order.
   *  M: square cost matrix. start: index of origin. stops: array of indices to visit.
   *  end: index of fixed end point, or null for "end at last stop" (free end).
   * Returns { order: [stop indices in visiting order], cost, exact: bool }
   */
  function solve(M, start, stops, end, opts) {
    opts = opts || {};
    var exactLimit = opts.exactLimit == null ? 12 : opts.exactLimit;
    var n = stops.length;
    if (n === 0) return { order: [], cost: end == null ? 0 : M[start][end], exact: true };
    if (n <= exactLimit) return heldKarp(M, start, stops, end);
    return heuristic(M, start, stops, end);
  }

  function full(start, order, end) {
    var p = [start].concat(order);
    if (end != null) p.push(end);
    return p;
  }

  // Held-Karp dynamic programming: exact optimum, O(2^n * n^2).
  function heldKarp(M, start, stops, end) {
    var n = stops.length, N = 1 << n;
    var dp = new Float64Array(N * n).fill(Infinity);
    var par = new Int16Array(N * n).fill(-1);
    for (var j = 0; j < n; j++) dp[(1 << j) * n + j] = M[start][stops[j]];
    for (var mask = 1; mask < N; mask++) {
      for (var j2 = 0; j2 < n; j2++) {
        if (!(mask & (1 << j2))) continue;
        var cur = dp[mask * n + j2];
        if (cur === Infinity) continue;
        for (var k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          var nm = mask | (1 << k), v = cur + M[stops[j2]][stops[k]];
          if (v < dp[nm * n + k]) { dp[nm * n + k] = v; par[nm * n + k] = j2; }
        }
      }
    }
    var fullMask = N - 1, best = Infinity, last = -1;
    for (var j3 = 0; j3 < n; j3++) {
      var v2 = dp[fullMask * n + j3] + (end == null ? 0 : M[stops[j3]][end]);
      if (v2 < best) { best = v2; last = j3; }
    }
    var order = [], m2 = fullMask, cur2 = last;
    while (cur2 !== -1) { order.push(stops[cur2]); var p = par[m2 * n + cur2]; m2 &= ~(1 << cur2); cur2 = p; }
    order.reverse();
    return { order: order, cost: best, exact: true };
  }

  // Nearest neighbour construction + 2-opt and or-opt improvement (handles asymmetric matrices).
  function heuristic(M, start, stops, end) {
    var left = stops.slice(), order = [], cur = start;
    while (left.length) {
      var bi = 0;
      for (var i = 1; i < left.length; i++) if (M[cur][left[i]] < M[cur][left[bi]]) bi = i;
      cur = left[bi]; order.push(cur); left.splice(bi, 1);
    }
    var best = pathCost(M, full(start, order, end)), improved = true, guard = 0;
    while (improved && guard++ < 1000) {
      improved = false;
      // 2-opt: reverse segment i..k
      for (var a = 0; a < order.length - 1; a++) {
        for (var b = a + 1; b < order.length; b++) {
          var cand = order.slice(0, a).concat(order.slice(a, b + 1).reverse(), order.slice(b + 1));
          var c = pathCost(M, full(start, cand, end));
          if (c < best - 1e-9) { best = c; order = cand; improved = true; }
        }
      }
      // or-opt: move one stop elsewhere
      for (var x = 0; x < order.length; x++) {
        for (var y = 0; y < order.length; y++) {
          if (x === y) continue;
          var cand2 = order.slice(); var node = cand2.splice(x, 1)[0]; cand2.splice(y, 0, node);
          var c2 = pathCost(M, full(start, cand2, end));
          if (c2 < best - 1e-9) { best = c2; order = cand2; improved = true; }
        }
      }
    }
    return { order: order, cost: best, exact: false };
  }

  function fmtLL(p) { return (+p.lat).toFixed(6) + ',' + (+p.lng).toFixed(6); }

  /*
   * Build Google Maps directions URLs for an ordered list of points [{lat,lng}], first = origin, last = destination.
   * Splits into sequential legs when there are more than maxWaypoints intermediate points.
   * Returns [{url, from, to, count}] where from/to are indices into points.
   */
  function buildMapsUrls(points, maxWaypoints) {
    maxWaypoints = maxWaypoints || 9;
    if (!points || points.length < 2) return [];
    var legs = [], i = 0, last = points.length - 1;
    while (i < last) {
      var j = Math.min(i + maxWaypoints + 1, last);
      var wps = points.slice(i + 1, j).map(fmtLL);
      var url = 'https://www.google.com/maps/dir/?api=1' +
        '&origin=' + encodeURIComponent(fmtLL(points[i])) +
        '&destination=' + encodeURIComponent(fmtLL(points[j])) +
        (wps.length ? '&waypoints=' + encodeURIComponent(wps.join('|')) : '') +
        '&travelmode=driving';
      legs.push({ url: url, from: i, to: j, count: j - i });
      i = j;
    }
    return legs;
  }

  /*
   * Build an Apple Maps directions URL for an ordered list of points [{lat,lng}].
   * Apple Maps accepts multiple destinations chained with " to: " in daddr.
   */
  function buildAppleMapsUrl(points) {
    if (!points || points.length < 2) return '';
    var dests = points.slice(1).map(fmtLL);
    return 'https://maps.apple.com/?saddr=' + encodeURIComponent(fmtLL(points[0])) +
      '&daddr=' + encodeURIComponent(dests.join(' to: ')) + '&dirflg=d';
  }

  // Format a duration in seconds as "12 min" / "1 h 5 min".
  function fmtDur(sec) {
    if (sec == null || !isFinite(sec)) return '';
    var m = Math.round(sec / 60);
    if (m < 1) return '<1 min';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' h ' + r + ' min' : h + ' h';
  }

  // ---- Photon (autocomplete) helpers ----
  var PHOTON = 'https://photon.komoot.io/api/';
  function photonUrl(q, limit) {
    return PHOTON + '?q=' + encodeURIComponent(q) + '&limit=' + (limit || 5) +
      '&lat=43.59&lon=-79.64&location_bias_scale=0.3&bbox=-95.2,41.6,-74.3,56.9&lang=en';
  }
  // Format a Photon GeoJSON feature as {label: 'house number street, city', sub, lat, lng}
  function formatPhoton(f) {
    if (!f || !f.geometry || !f.properties) return null;
    var p = f.properties, c = f.geometry.coordinates;
    var city = p.city || p.town || p.village || p.district || p.locality || p.county || '';
    var street = p.street ? ((p.housenumber ? p.housenumber + ' ' : '') + p.street) : '';
    var label, sub;
    if (p.housenumber && p.street) { label = street; sub = p.name && p.name !== street && p.type !== 'house' ? p.name : ''; }
    else if (p.name) { label = p.name; sub = street; }
    else if (street) { label = street; sub = ''; }
    else return null;
    if (city && label.indexOf(city) === -1) label += ', ' + city;
    var extra = [p.state, p.postcode].filter(Boolean).join(' ');
    sub = [sub, extra].filter(Boolean).join(' · ');
    // Preserve the place name (e.g. "Port Credit GO Station") separately from its street address,
    // so the UI can show the name the user actually recognises.
    var placeName = (p.name && p.name !== street && label.indexOf(p.name) === -1) ? p.name : '';
    return { label: label, sub: sub, name: placeName, lat: +c[1], lng: +c[0] };
  }
  function parsePhoton(json) {
    var seen = {}, out = [];
    ((json && json.features) || []).forEach(function (f) {
      var r = formatPhoton(f); if (!r) return;
      var k = r.label.toLowerCase(); if (seen[k]) return; seen[k] = 1; out.push(r);
    });
    return out;
  }

  return { photonUrl: photonUrl, formatPhoton: formatPhoton, parsePhoton: parsePhoton, parseCoord: parseCoord, splitLines: splitLines, cleanAddress: cleanAddress, pathCost: pathCost,
           solve: solve, heldKarp: heldKarp, heuristic: heuristic, buildMapsUrls: buildMapsUrls, buildAppleMapsUrl: buildAppleMapsUrl, fmtDur: fmtDur, fmtLL: fmtLL };
});
