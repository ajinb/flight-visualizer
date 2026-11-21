// Route engine: geometry, route-string expansion and airway-graph search.
// Pure functions only (no DOM, no network) so the same file runs in the
// browser and under `node --test`.
//
// Data shapes
//   airports: { FAA_ID: [name, city, lat, lon, icao] }
//   points:   { ID: [lat, lon] }              fixes + navaids
//   airways:  { "J60": [ [ID, ID, ...], ... ] }  one array per continuous segment
//   procedures: { sid: { NAME: [bodies, transitions] }, star: { ... } }
//             chains of point ids in flying order

const R_NM = 3440.065; // mean Earth radius in nautical miles
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in nautical miles between [lat, lon] pairs. */
export function distanceNm(a, b) {
  const p1 = rad(a[0]);
  const p2 = rad(b[0]);
  const dp = p2 - p1;
  const dl = rad(b[1] - a[1]);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** n+1 points along the great circle from a to b (spherical interpolation). */
export function greatCircle(a, b, n = 96) {
  const d = distanceNm(a, b) / R_NM;
  if (d === 0) return [a];
  const p1 = rad(a[0]), l1 = rad(a[1]), p2 = rad(b[0]), l2 = rad(b[1]);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))]);
  }
  return out;
}

/**
 * Shift longitudes by multiples of 360 so no step jumps more than 180 degrees.
 * Leaflet then draws a line across the antimeridian (Alaska to Guam) instead of
 * back across the whole map. Distances are unchanged.
 */
export function unwrapLons(latlngs) {
  const out = [];
  for (const [lat, lon] of latlngs) {
    const prev = out.length ? out[out.length - 1][1] : lon;
    out.push([lat, lon + 360 * Math.round((prev - lon) / 360)]);
  }
  return out;
}

/** Initial true bearing in degrees (0-360) from a to b. */
export function bearing(a, b) {
  const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Sum of leg lengths for a path of { lat, lon } objects. */
export function pathDistanceNm(path) {
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    sum += distanceNm([path[i - 1].lat, path[i - 1].lon], [path[i].lat, path[i].lon]);
  }
  return sum;
}

/** Strip the leading K from a 4-letter US ICAO code; upper-case everything. */
export function normalizeId(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return s.length === 4 && s[0] === 'K' ? s.slice(1) : s;
}

function locate(ctx, id) {
  const p = ctx.points && ctx.points[id];
  if (p) return p;
  const a = ctx.airports && ctx.airports[id];
  return a ? [a[2], a[3]] : null;
}

const isAirway = (ctx, t) => !!(ctx.airways && ctx.airways[t]);

/**
 * SID points in flying order: a body, then the transition that reaches `fix`.
 * Bodies branch per runway or airport, so take the one starting nearest `near`.
 * A STAR is the same walk on reversed chains. Returns null if `fix` is not on it.
 */
function sidIds(ctx, bodies, trans, fix, near) {
  const t = fix && trans.find((c) => c.includes(fix));
  let cands = bodies;
  if (t) cands = bodies.filter((b) => b[b.length - 1] === t[0]);
  else if (fix) cands = bodies.filter((b) => b.includes(fix)).map((b) => b.slice(0, b.indexOf(fix) + 1));
  if (fix && !t && !cands.length) return null;
  const d = (b) => (near && locate(ctx, b[0]) ? distanceNm(near, locate(ctx, b[0])) : 0);
  const body = [...cands].sort((x, y) => d(x) - d(y))[0] || [];
  return [...body, ...(t ? t.slice(0, t.indexOf(fix) + 1) : [])];
}

const rev = (chains) => chains.map((c) => c.slice().reverse());

function procedureIds(ctx, name, kind, fix, near) {
  const [bodies, trans] = ctx.procedures[kind][name];
  if (kind === 'sid') return sidIds(ctx, bodies, trans, fix, near);
  const ids = sidIds(ctx, rev(bodies), rev(trans), fix, near);
  return ids && ids.reverse();
}

/**
 * Expand a preferred-route token list into a drawable path.
 * Fixes and navaids become points; an airway token is replaced by every
 * point between the previous point and the next point on that airway.
 * A SID runs toward the next point and a STAR from the previous one, along the
 * transition that names that point. Tokens we can't place are reported, not guessed.
 * ends = { from, to } ([lat, lon] of the airports) picks the nearest runway branch.
 */
export function expandRoute(tokens, ctx, ends = {}) {
  const path = [];
  const unresolved = [];
  const airwaysUsed = [];
  const warnings = [];
  const proceduresUsed = [];

  const push = (id, kind) => {
    const p = locate(ctx, id);
    if (!p) return false;
    const last = path[path.length - 1];
    if (last && last.id === id) return true;
    path.push({ id, lat: p[0], lon: p[1], kind });
    return true;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isAirway(ctx, t) && !(ctx.points && ctx.points[t])) {
      if (!path.length) { unresolved.push(t); continue; }
      const entry = path[path.length - 1].id;
      let j = i + 1;
      while (j < tokens.length && !locate(ctx, tokens[j])) j++;
      if (j >= tokens.length) { warnings.push(`${t}: no exit point after the airway`); continue; }
      const exit = tokens[j];
      let found = false;
      for (const seg of ctx.airways[t]) {
        const ei = seg.indexOf(entry);
        const xi = seg.indexOf(exit);
        if (ei < 0 || xi < 0) continue;
        const slice = ei <= xi ? seg.slice(ei, xi + 1) : seg.slice(xi, ei + 1).reverse();
        for (let k = 1; k < slice.length; k++) push(slice[k], 'airway');
        found = true;
        break;
      }
      if (found) airwaysUsed.push(t);
      else warnings.push(`${t}: ${entry} to ${exit} are not on one segment, so that leg is drawn direct`);
    } else if (!(ctx.points && ctx.points[t]) && (ctx.procedures?.sid?.[t] || ctx.procedures?.star?.[t])) {
      const kind = ctx.procedures.sid?.[t] ? 'sid' : 'star';
      let fix;
      if (kind === 'sid') {
        let j = i + 1;
        while (j < tokens.length && !locate(ctx, tokens[j])) j++;
        fix = tokens[j];
      } else fix = path.length ? path[path.length - 1].id : undefined;
      const ids = procedureIds(ctx, t, kind, fix, kind === 'sid' ? ends.from : ends.to);
      if (!ids) { warnings.push(`${t}: ${fix} is not on this ${kind.toUpperCase()}, so that leg is drawn direct`); continue; }
      for (const id of ids) push(id, kind);
      proceduresUsed.push(t);
    } else if (locate(ctx, t)) {
      const isApt = ctx.airports && ctx.airports[t] && !(ctx.points && ctx.points[t]);
      push(t, isApt ? 'airport' : 'fix');
    } else {
      unresolved.push(t);
    }
  }
  return { path, unresolved, airwaysUsed, proceduresUsed, warnings };
}

// ---- Airway graph --------------------------------------------------------

/** Which designators a graph search may use. */
const CLASS_TEST = {
  high: (id) => /^[JQ]\d/.test(id),
  low: (id) => /^[VT]\d/.test(id),
  all: () => true,
};

export function buildGraph(ctx, airwayClass = 'high') {
  const ok = CLASS_TEST[airwayClass] || CLASS_TEST.all;
  const nodes = new Map();
  const node = (id) => {
    let n = nodes.get(id);
    if (!n) {
      const p = ctx.points[id];
      n = { id, lat: p[0], lon: p[1], edges: [] };
      nodes.set(id, n);
    }
    return n;
  };
  for (const [name, segs] of Object.entries(ctx.airways || {})) {
    if (!ok(name)) continue;
    for (const seg of segs) {
      for (let k = 0; k + 1 < seg.length; k++) {
        const a = seg[k], b = seg[k + 1];
        if (!ctx.points[a] || !ctx.points[b]) continue;
        const w = distanceNm(ctx.points[a], ctx.points[b]);
        node(a).edges.push({ to: b, w, airway: name });
        node(b).edges.push({ to: a, w, airway: name });
      }
    }
  }
  return nodes;
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item, key) {
    const a = this.a;
    a.push([key, item]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top[1];
  }
}

/**
 * A* over the airway graph from one coordinate to another.
 * The airports attach to the k nearest airway points within maxAccessNm.
 * Ignores one-way rules and altitude limits: it is a teaching model.
 */
export function shortestAirwayPath(graph, from, to, opts = {}) {
  const k = opts.k ?? 4;
  const maxAccessNm = opts.maxAccessNm ?? 150;
  const nearest = (pt) =>
    [...graph.values()]
      .map((n) => ({ id: n.id, d: distanceNm(pt, [n.lat, n.lon]) }))
      .filter((c) => c.d <= maxAccessNm)
      .sort((x, y) => x.d - y.d)
      .slice(0, k);

  const starts = nearest(from);
  const goals = new Map(nearest(to).map((c) => [c.id, c.d]));
  if (!starts.length || !goals.size) return null;

  const h = (id) => {
    const n = graph.get(id);
    return distanceNm([n.lat, n.lon], to);
  };
  const g = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  for (const s of starts) {
    g.set(s.id, s.d);
    heap.push(s.id, s.d + h(s.id));
  }
  const done = new Set();
  let best = null;
  let bestCost = Infinity;
  while (heap.size) {
    const id = heap.pop();
    if (done.has(id)) continue;
    done.add(id);
    const cost = g.get(id);
    if (goals.has(id) && cost + goals.get(id) < bestCost) {
      bestCost = cost + goals.get(id);
      best = id;
    }
    // Once the cheapest open node is already worse than the best finish, stop.
    if (cost + h(id) >= bestCost) break;
    for (const e of graph.get(id).edges) {
      const c = cost + e.w;
      if (c < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, c);
        prev.set(e.to, { from: id, airway: e.airway });
        heap.push(e.to, c + h(e.to));
      }
    }
  }
  if (best === null) return null;

  const ids = [];
  const via = []; // via[i] = airway used to arrive at ids[i] (undefined for the first)
  let cur = best;
  while (cur) {
    ids.unshift(cur);
    const p = prev.get(cur);
    via.unshift(p ? p.airway : undefined);
    cur = p ? p.from : null;
  }
  return { ids, via };
}

/** Compress a found path into a route string like "GLL J60 DBS J80 BOS". */
export function compressRoute(ids, via) {
  const out = [];
  let currentAirway = null;
  for (let i = 0; i < ids.length; i++) {
    if (i === 0) { out.push(ids[0]); continue; }
    const a = via[i];
    const next = via[i + 1];
    if (a !== currentAirway) {
      out.push(a);
      currentAirway = a;
    }
    if (i === ids.length - 1 || next !== a) out.push(ids[i]);
  }
  return out;
}

// ---- Putting it together ---------------------------------------------------

/** Make sure a path starts at the origin airport and ends at the destination. */
export function anchor(path, ctx, origin, dest) {
  const out = path.slice();
  const o = locate(ctx, origin);
  const d = locate(ctx, dest);
  if (o && (!out.length || out[0].id !== origin)) out.unshift({ id: origin, lat: o[0], lon: o[1], kind: 'airport' });
  if (d && (!out.length || out[out.length - 1].id !== dest)) out.push({ id: dest, lat: d[0], lon: d[1], kind: 'airport' });
  return out;
}

/** Route from a preferred-route token string. */
export function routeFromString(routeStr, ctx, origin, dest) {
  const tokens = routeStr.split(/\s+/).filter(Boolean);
  const res = expandRoute(tokens, ctx, { from: locate(ctx, origin), to: locate(ctx, dest) });
  return { ...res, path: anchor(res.path, ctx, origin, dest), routeString: routeStr, method: 'preferred' };
}

/** Route found by searching the airway graph. */
export function routeFromGraph(graph, ctx, origin, dest, opts = {}) {
  const o = locate(ctx, origin);
  const d = locate(ctx, dest);
  if (!o || !d) return null;
  const found = shortestAirwayPath(graph, o, d, opts);
  if (!found) return null;
  const path = anchor(
    found.ids.map((id, i) => ({ id, lat: ctx.points[id][0], lon: ctx.points[id][1], kind: i ? 'airway' : 'fix' })),
    ctx, origin, dest,
  );
  const tokens = compressRoute(found.ids, found.via);
  return {
    path,
    unresolved: [],
    warnings: [],
    airwaysUsed: [...new Set(found.via.filter(Boolean))],
    routeString: [origin, ...tokens, dest].filter((t, i, a) => t !== a[i - 1]).join(' '),
    method: 'graph',
  };
}

/** Distance stats comparing a route against the great circle. */
export function routeStats(path, from, to) {
  const routeNm = pathDistanceNm(path);
  const gcNm = distanceNm(from, to);
  return { routeNm, gcNm, extraNm: routeNm - gcNm, extraPct: gcNm ? ((routeNm - gcNm) / gcNm) * 100 : 0 };
}
