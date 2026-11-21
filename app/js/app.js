import {
  normalizeId, greatCircle, distanceNm, buildGraph, routeFromString, routeFromGraph, routeStats,
} from './route-engine.js';

const $ = (id) => document.getElementById(id);
const L = window.L;

async function loadJson(name) {
  try {
    const r = await fetch(`data/${name}.json`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const ctx = { airports: {}, points: {}, airways: {} };
let routes = {};
let meta = null;
const graphs = {};
let layers = { gc: null, route: null, pts: null };
let last = null;

// ---- Map -------------------------------------------------------------------
const map = L.map('map', { worldCopyJump: false, zoomSnap: 0.25 }).setView([39.5, -98.35], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 12,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#c25a12';

// ---- Data ------------------------------------------------------------------
function setStatus(msg) { $('status').textContent = msg; }

function fillAirportList() {
  const frag = document.createDocumentFragment();
  const ids = Object.keys(ctx.airports).sort();
  for (const id of ids) {
    const a = ctx.airports[id];
    const o = document.createElement('option');
    o.value = id;
    o.label = `${a[0]} (${a[1]})`;
    frag.appendChild(o);
  }
  $('airports').replaceChildren(frag);
}

function describeData() {
  const el = $('data-meta');
  if (!meta) { el.textContent = 'Data details are unavailable.'; return; }
  if (meta.source === 'seed') {
    el.textContent = `Airports: ${meta.airports.toLocaleString()} US airports from OurAirports. The FAA airway and preferred-route data has not been built yet, so only the great circle is drawn. Run the data pipeline (see the repository README) to add airways.`;
  } else {
    el.textContent = `${meta.source}, effective ${meta.cycle}. ${meta.airports.toLocaleString()} airports, ${meta.points.toLocaleString()} fixes and navaids, ${meta.airways.toLocaleString()} airways, ${meta.routePairs.toLocaleString()} airport pairs with preferred routes. Built ${meta.built.slice(0, 10)}.`;
  }
}

function sourceOptions(from, to) {
  const opts = [];
  const pref = routes[`${from}-${to}`] || [];
  pref.forEach((r, i) => {
    const alt = r[2] ? `, ${r[2]}` : '';
    opts.push({ value: `pref:${i}`, label: `Preferred (${r[0]}${alt}): ${r[1].slice(0, 46)}${r[1].length > 46 ? '…' : ''}` });
  });
  if (Object.keys(ctx.airways).length) {
    opts.push({ value: 'graph:high', label: 'Search airways: jet and RNAV high (J, Q)' });
    opts.push({ value: 'graph:low', label: 'Search airways: Victor and RNAV low (V, T)' });
  }
  opts.push({ value: 'gc', label: 'Great circle only' });
  return opts;
}

let lastPair = '';

function refreshSourceList() {
  const from = normalizeId($('from').value);
  const to = normalizeId($('to').value);
  // Keep the user's choice only while the airport pair is unchanged; a new pair
  // starts on the first option (a preferred route when one exists).
  const pair = `${from}-${to}`;
  const prev = pair === lastPair ? $('source').value : '';
  lastPair = pair;
  const opts = sourceOptions(from, to);
  $('source').replaceChildren(...opts.map((o) => {
    const e = document.createElement('option');
    e.value = o.value;
    e.textContent = o.label;
    return e;
  }));
  if (opts.some((o) => o.value === prev)) $('source').value = prev;
}

// ---- Route + render -----------------------------------------------------------
function compute(from, to, source) {
  if (source === 'gc') {
    return { path: [], unresolved: [], warnings: [], airwaysUsed: [], routeString: `${from} DCT ${to}`, method: 'great circle' };
  }
  if (source.startsWith('pref:')) {
    const r = routes[`${from}-${to}`][Number(source.slice(5))];
    const res = routeFromString(r[1], ctx, from, to);
    res.method = `FAA preferred route (${r[0]})`;
    return res;
  }
  const cls = source.split(':')[1];
  graphs[cls] ||= buildGraph(ctx, cls);
  const res = routeFromGraph(graphs[cls], ctx, from, to);
  if (!res) return { path: [], unresolved: [], warnings: [`No airway path found within 150 nm of both airports (${cls} network).`], airwaysUsed: [], routeString: '', method: 'search failed' };
  res.method = `A* search over ${cls === 'high' ? 'J/Q' : 'V/T'} airways`;
  return res;
}

function clearLayers() {
  for (const k of Object.keys(layers)) {
    if (layers[k]) map.removeLayer(layers[k]);
    layers[k] = null;
  }
}

function render(from, to, res) {
  clearLayers();
  const a = ctx.airports[from];
  const b = ctx.airports[to];
  const A = [a[2], a[3]];
  const B = [b[2], b[3]];

  layers.gc = L.polyline(greatCircle(A, B, 96), { color: css('--gc'), weight: 3, dashArray: '8 8', opacity: 0.9 });
  const drawn = res.path.length > 1;
  if (drawn) layers.route = L.polyline(res.path.map((p) => [p.lat, p.lon]), { color: css('--route'), weight: 4 });

  const pts = L.layerGroup();
  const list = drawn ? res.path : [{ id: from, lat: A[0], lon: A[1], kind: 'airport' }, { id: to, lat: B[0], lon: B[1], kind: 'airport' }];
  for (const p of list) {
    const apt = p.kind === 'airport';
    const m = L.circleMarker([p.lat, p.lon], {
      radius: apt ? 7 : 3.5, color: css('--route'), weight: apt ? 3 : 1.5, fillColor: apt ? css('--route') : '#fff', fillOpacity: 1,
    });
    const name = apt && ctx.airports[p.id] ? `${p.id}: ${ctx.airports[p.id][0]}` : p.id;
    m.bindTooltip(name, { direction: 'top' });
    pts.addLayer(m);
  }
  layers.pts = pts;
  syncLayerToggles();
  map.fitBounds(L.latLngBounds([A, B]).pad(0.25));
}

function syncLayerToggles() {
  const set = (layer, on) => { if (!layer) return; if (on && !map.hasLayer(layer)) layer.addTo(map); if (!on && map.hasLayer(layer)) map.removeLayer(layer); };
  set(layers.gc, $('l-gc').checked);
  set(layers.route, $('l-route').checked);
  set(layers.pts, $('l-pts').checked);
}

const fmt = (n) => Math.round(n).toLocaleString();

function showResults(from, to, res) {
  const A = [ctx.airports[from][2], ctx.airports[from][3]];
  const B = [ctx.airports[to][2], ctx.airports[to][3]];
  const drawn = res.path.length > 1;
  const st = routeStats(drawn ? res.path : [{ lat: A[0], lon: A[1] }, { lat: B[0], lon: B[1] }], A, B);
  $('s-gc').textContent = fmt(st.gcNm);
  $('s-route').textContent = fmt(st.routeNm);
  $('s-extra').textContent = drawn ? `+${st.extraPct.toFixed(1)}%` : '–';
  $('s-pts').textContent = drawn ? String(res.path.length) : '2';
  $('route-string').textContent = res.routeString || '(none)';
  $('method').textContent = `· ${res.method}`;

  const notes = [];
  if (res.unresolved.length) notes.push(`Not placed on the map (SIDs, STARs or unknown ids): ${res.unresolved.join(', ')}`);
  for (const w of res.warnings) notes.push(w);
  $('notes').replaceChildren(...notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));

  const rows = [];
  let total = 0;
  const list = drawn ? res.path : [{ id: from, lat: A[0], lon: A[1], kind: 'airport' }, { id: to, lat: B[0], lon: B[1], kind: 'airport' }];
  list.forEach((p, i) => {
    const leg = i ? distanceNm([list[i - 1].lat, list[i - 1].lon], [p.lat, p.lon]) : 0;
    total += leg;
    const tr = document.createElement('tr');
    const cells = [String(i + 1), p.id, p.kind, i ? fmt(leg) : '', i ? fmt(total) : ''];
    cells.forEach((c, j) => {
      const td = document.createElement(j === 0 ? 'th' : 'td');
      if (j === 0) td.scope = 'row';
      if (j >= 3) td.className = 'n';
      td.textContent = c;
      tr.appendChild(td);
    });
    rows.push(tr);
  });
  $('wp').replaceChildren(...rows);
  $('results').hidden = false;
  last = res.routeString;
}

function run() {
  const from = normalizeId($('from').value);
  const to = normalizeId($('to').value);
  if (!ctx.airports[from]) return setStatus(`"${$('from').value}" isn't in the airport list. Try a code such as DEN or KDEN.`);
  if (!ctx.airports[to]) return setStatus(`"${$('to').value}" isn't in the airport list. Try a code such as BOS or KBOS.`);
  if (from === to) return setStatus('Choose two different airports.');
  $('from').value = from;
  $('to').value = to;
  refreshSourceList();
  const res = compute(from, to, $('source').value);
  render(from, to, res);
  showResults(from, to, res);
  const gcNm = distanceNm([ctx.airports[from][2], ctx.airports[from][3]], [ctx.airports[to][2], ctx.airports[to][3]]);
  setStatus(`${from} to ${to}: ${fmt(gcNm)} nm great circle.`);
  history.replaceState(null, '', `#${from}-${to}`);
}

// ---- Wiring ----------------------------------------------------------------
$('form').addEventListener('submit', (e) => { e.preventDefault(); run(); });
$('swap').addEventListener('click', () => {
  const f = $('from').value;
  $('from').value = $('to').value;
  $('to').value = f;
  refreshSourceList();
  if ($('from').value && $('to').value) run();
});
for (const id of ['from', 'to']) $(id).addEventListener('change', refreshSourceList);
$('source').addEventListener('change', () => { if ($('from').value && $('to').value) run(); });
for (const id of ['l-gc', 'l-route', 'l-pts']) $(id).addEventListener('change', syncLayerToggles);
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(last || '');
    $('copy').textContent = 'Copied';
  } catch {
    $('copy').textContent = 'Copy failed: select the text instead';
  }
  setTimeout(() => { $('copy').textContent = 'Copy route string'; }, 1800);
});

(async function init() {
  const airports = await loadJson('airports');
  if (!airports) { setStatus('Could not load airport data. Reload the page to try again.'); return; }
  ctx.airports = airports;
  fillAirportList();
  $('go').disabled = false;
  setStatus('Pick two airports, such as DEN and BOS.');

  const [m, points, airways, r] = await Promise.all([loadJson('meta'), loadJson('points'), loadJson('airways'), loadJson('routes')]);
  meta = m;
  if (points) ctx.points = points;
  if (airways) ctx.airways = airways;
  if (r) routes = r;
  describeData();
  refreshSourceList();

  const hash = decodeURIComponent(location.hash.slice(1)).split('-');
  if (hash.length === 2 && ctx.airports[normalizeId(hash[0])] && ctx.airports[normalizeId(hash[1])]) {
    $('from').value = hash[0];
    $('to').value = hash[1];
    run();
  }
})();
