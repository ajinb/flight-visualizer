// Parsers for the FAA NASR 28-Day Subscription CSV files.
//
// The column names below follow the NASR CSV layout as documented in the FAA
// "TXT to CSV Mapping" document. Every lookup goes through pick(), which tries
// a list of candidate names and throws an error that prints the real headers,
// so a layout change fails loudly instead of producing a silently empty map.

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function headersOf(rows) {
  return rows.length ? Object.keys(rows[0]) : [];
}

export function pick(rows, names, what, required = true) {
  const headers = headersOf(rows);
  for (const n of names) if (headers.includes(n)) return n;
  if (required) {
    throw new Error(`${what}: none of [${names.join(', ')}] found. Headers are: ${headers.join(', ')}`);
  }
  return null;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? n : null;
};
const round = (n) => Math.round(n * 1e5) / 1e5;

/** APT_BASE.csv -> { ID: [name, city, lat, lon, icao] } */
export function buildAirports(rows, keepIds = new Set()) {
  const id = pick(rows, ['ARPT_ID'], 'APT_BASE ID');
  const lat = pick(rows, ['LAT_DECIMAL'], 'APT_BASE latitude');
  const lon = pick(rows, ['LONG_DECIMAL'], 'APT_BASE longitude');
  const name = pick(rows, ['ARPT_NAME'], 'APT_BASE name');
  const city = pick(rows, ['CITY'], 'APT_BASE city', false);
  const state = pick(rows, ['STATE_CODE'], 'APT_BASE state', false);
  const icao = pick(rows, ['ICAO_ID'], 'APT_BASE ICAO', false);
  const site = pick(rows, ['SITE_TYPE_CODE'], 'APT_BASE site type', false);
  const use = pick(rows, ['FACILITY_USE_CODE'], 'APT_BASE use', false);

  const out = {};
  for (const r of rows) {
    if (site && r[site] && r[site] !== 'A') continue; // airports only (not heliports, seaplane bases)
    const la = num(r[lat]), lo = num(r[lon]);
    if (la === null || lo === null) continue;
    const wanted = keepIds.has(r[id]) || (r[icao] && (!use || r[use] === 'PU'));
    if (!wanted) continue;
    out[r[id]] = [
      r[name],
      [city && r[city], state && r[state]].filter(Boolean).join(', '),
      round(la),
      round(lo),
      r[icao] || '',
    ];
  }
  return out;
}

/** FIX_BASE.csv + NAV_BASE.csv -> Map(ID -> [lat, lon]); navaids win over fixes. */
export function buildPointIndex(fixRows, navRows) {
  const index = new Map();
  const add = (rows, idNames, what) => {
    if (!rows.length) return 0;
    const id = pick(rows, idNames, `${what} ID`);
    const lat = pick(rows, ['LAT_DECIMAL'], `${what} latitude`);
    const lon = pick(rows, ['LONG_DECIMAL'], `${what} longitude`);
    let dupes = 0;
    for (const r of rows) {
      const la = num(r[lat]), lo = num(r[lon]);
      if (la === null || lo === null || !r[id]) continue;
      if (index.has(r[id])) { dupes++; continue; }
      index.set(r[id], [round(la), round(lo)]);
    }
    return dupes;
  };
  // Navaids first so a VOR keeps its place when a fix shares the identifier.
  const navDupes = add(navRows, ['NAV_ID'], 'NAV_BASE');
  const fixDupes = add(fixRows, ['FIX_ID'], 'FIX_BASE');
  return { index, duplicates: navDupes + fixDupes };
}

/**
 * AWY_SEG_ALT.csv -> { "J60": [[id, id, ...], ...] }
 * Rows are airway segments (FROM_POINT to TO_POINT). We chain them in
 * POINT_SEQ order and start a new segment wherever a row's TO_POINT is not the
 * next row's FROM_POINT (a gap in the airway).
 */
export function buildAirways(rows, index) {
  const awy = pick(rows, ['AWY_ID'], 'AWY_SEG_ALT airway');
  const seq = pick(rows, ['POINT_SEQ'], 'AWY_SEG_ALT sequence');
  const from = pick(rows, ['FROM_POINT'], 'AWY_SEG_ALT from');
  const to = pick(rows, ['TO_POINT'], 'AWY_SEG_ALT to', false);

  const byAirway = new Map();
  const seen = new Set();
  for (const r of rows) {
    const key = `${r[awy]}|${r[seq]}`;
    if (seen.has(key)) continue; // same segment repeated per altitude block
    seen.add(key);
    if (!byAirway.has(r[awy])) byAirway.set(r[awy], []);
    byAirway.get(r[awy]).push(r);
  }

  const out = {};
  let dropped = 0;
  for (const [name, list] of byAirway) {
    list.sort((a, b) => Number(a[seq]) - Number(b[seq]));
    const segments = [];
    let cur = [];
    const flush = () => { if (cur.length > 1) segments.push(cur); cur = []; };
    for (let i = 0; i < list.length; i++) {
      const f = list[i][from];
      const t = to ? list[i][to] : '';
      if (!index.has(f)) { dropped++; flush(); continue; }
      if (cur[cur.length - 1] !== f) cur.push(f);
      const next = list[i + 1];
      const continues = next && next[from] === t;
      if (t && index.has(t)) {
        if (cur[cur.length - 1] !== t) cur.push(t);
      } else if (t) { dropped++; flush(); continue; }
      if (!continues) flush();
    }
    flush();
    if (segments.length) out[name] = segments;
  }
  return { airways: out, droppedPoints: dropped };
}

/**
 * PFR_SEG.csv (+ optional PFR_BASE.csv) -> { "DEN-BOS": [[type, routeString, altitude], ...] }
 */
export function buildRoutes(segRows, baseRows = []) {
  const org = pick(segRows, ['ORIGIN_ID'], 'PFR_SEG origin');
  const dst = pick(segRows, ['DSTN_ID', 'DEST_ID'], 'PFR_SEG destination');
  const type = pick(segRows, ['PFR_TYPE_CODE'], 'PFR_SEG type');
  const rno = pick(segRows, ['ROUTE_NO'], 'PFR_SEG route number');
  const seq = pick(segRows, ['SEGMENT_SEQ', 'SEG_SEQ'], 'PFR_SEG sequence');
  const val = pick(segRows, ['SEG_VALUE', 'SEGMENT_VALUE'], 'PFR_SEG value');

  const altOf = new Map();
  if (baseRows.length) {
    const bo = pick(baseRows, ['ORIGIN_ID'], 'PFR_BASE origin');
    const bd = pick(baseRows, ['DSTN_ID', 'DEST_ID'], 'PFR_BASE destination');
    const bt = pick(baseRows, ['PFR_TYPE_CODE'], 'PFR_BASE type');
    const bn = pick(baseRows, ['ROUTE_NO'], 'PFR_BASE route number');
    const ba = pick(baseRows, ['ALTITUDE_DESCR'], 'PFR_BASE altitude', false);
    if (ba) for (const r of baseRows) altOf.set(`${r[bo]}|${r[bd]}|${r[bt]}|${r[bn]}`, r[ba].slice(0, 48));
  }

  const groups = new Map();
  for (const r of segRows) {
    const key = `${r[org]}|${r[dst]}|${r[type]}|${r[rno]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = {};
  for (const [key, list] of groups) {
    list.sort((a, b) => Number(a[seq]) - Number(b[seq]));
    const [o, d, t] = key.split('|');
    const str = list.map((r) => r[val]).filter(Boolean).join(' ');
    if (!str) continue;
    const pair = `${o}-${d}`;
    (out[pair] ||= []).push([t, str, altOf.get(key) || '']);
  }
  return out;
}

/** Which ids do the routes mention? Used to keep points.json small. */
export function routeTokenSet(routes) {
  const s = new Set();
  for (const list of Object.values(routes)) {
    for (const [, str] of list) for (const t of str.split(/\s+/)) s.add(t);
  }
  return s;
}

export function routeEndpoints(routes) {
  const s = new Set();
  for (const pair of Object.keys(routes)) for (const id of pair.split('-')) s.add(id);
  return s;
}

/** Latest 28-day AIRAC-style effective date on or before `today` (UTC). */
export function currentCycle(today = new Date()) {
  const ref = Date.UTC(2026, 10, 26); // 2026-11-26 is a published effective date
  const step = 28 * 86400000;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const eff = new Date(ref + Math.floor((t - ref) / step) * step);
  return eff.toISOString().slice(0, 10);
}
