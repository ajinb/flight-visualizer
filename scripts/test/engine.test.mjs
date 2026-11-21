// Run with: node --test scripts/test/engine.test.mjs
// All fixtures are small synthetic networks made up for these tests. They are
// not FAA data and the point ids mean nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceNm, greatCircle, unwrapLons, bearing, normalizeId, expandRoute, buildGraph,
  shortestAirwayPath, compressRoute, routeFromString, routeFromGraph, routeStats,
} from '../../app/js/route-engine.js';
import {
  parseCsv, buildAirways, buildRoutes, buildPointIndex, buildAirports, buildProcedures, currentCycle,
} from '../nasr.mjs';

// Two airports 8 degrees of longitude apart on the equator-ish, joined by one
// straight airway (J1) and one slower detour (J2 through a northern fix).
const ctx = {
  airports: { AAA: ['A', 'x', 0, 0, ''], BBB: ['B', 'y', 0, 8, ''] },
  points: {
    F1: [0, 1], F2: [0, 2], F3: [0, 3], F4: [0, 5], F5: [0, 7],
    N1: [3, 3], N2: [3, 5],
  },
  airways: {
    J1: [['F1', 'F2', 'F3', 'F4', 'F5']],
    J2: [['F1', 'N1', 'N2', 'F5']],
    V9: [['F2', 'F3']],
  },
};

test('distance and bearing', () => {
  const den = [39.8617, -104.6732];
  const bos = [42.3643, -71.0052];
  const d = distanceNm(den, bos);
  assert.ok(d > 1500 && d < 1560, `DEN-BOS was ${d}`);
  assert.equal(distanceNm(den, den), 0);
  assert.ok(Math.abs(bearing([0, 0], [0, 10]) - 90) < 1e-6);
});

test('great circle keeps its endpoints and bows poleward', () => {
  const a = [39.86, -104.67];
  const b = [42.36, -71.0];
  const pts = greatCircle(a, b, 50);
  assert.equal(pts.length, 51);
  assert.ok(Math.abs(pts[0][0] - a[0]) < 1e-6 && Math.abs(pts[50][1] - b[1]) < 1e-6);
  assert.ok(Math.max(...pts.map((p) => p[0])) > Math.max(a[0], b[0]));
});

test('unwrapLons keeps an antimeridian crossing continuous', () => {
  // Anchorage to Guam crosses 180 degrees; raw great-circle longitudes jump from about +180 to -180.
  const line = unwrapLons(greatCircle([61.17, -149.99], [13.48, 144.80], 60));
  for (let i = 1; i < line.length; i++) assert.ok(Math.abs(line[i][1] - line[i - 1][1]) < 180);
  assert.ok(Math.abs(line[60][1] - (144.80 - 360)) < 1e-6, 'Guam lands west of Anchorage, at -215.2');
  assert.deepEqual(unwrapLons([[0, 10], [0, 20]]), [[0, 10], [0, 20]]);
});

test('normalizeId drops the K prefix on 4-letter US codes only', () => {
  assert.equal(normalizeId('kden'), 'DEN');
  assert.equal(normalizeId(' BOS '), 'BOS');
  assert.equal(normalizeId('KGLL'), 'GLL');
  assert.equal(normalizeId('PHNL'), 'PHNL');
});

test('expandRoute slices an airway forward and in reverse', () => {
  const fwd = expandRoute(['AAA', 'F1', 'J1', 'F4', 'BBB'], ctx);
  assert.deepEqual(fwd.path.map((p) => p.id), ['AAA', 'F1', 'F2', 'F3', 'F4', 'BBB']);
  assert.deepEqual(fwd.airwaysUsed, ['J1']);
  const rev = expandRoute(['F4', 'J1', 'F1'], ctx);
  assert.deepEqual(rev.path.map((p) => p.id), ['F4', 'F3', 'F2', 'F1']);
});

test('expandRoute reports what it cannot place instead of guessing', () => {
  const r = expandRoute(['AAA', 'ZZZSID1', 'F1', 'J9', 'F4'], ctx);
  assert.deepEqual(r.unresolved, ['ZZZSID1', 'J9']);
  const off = expandRoute(['F1', 'V9', 'F5'], ctx); // F1 and F5 are not both on V9
  assert.equal(off.warnings.length, 1);
  assert.deepEqual(off.path.map((p) => p.id), ['F1', 'F5']);
});

test('routeFromString anchors to the airports', () => {
  const r = routeFromString('F1 J1 F5', ctx, 'AAA', 'BBB');
  assert.equal(r.path[0].id, 'AAA');
  assert.equal(r.path.at(-1).id, 'BBB');
  const st = routeStats(r.path, [0, 0], [0, 8]);
  assert.ok(st.extraPct >= 0 && st.extraPct < 0.1);
});

test('graph search takes the straight airway, not the detour', () => {
  const g = buildGraph(ctx, 'high');
  const res = shortestAirwayPath(g, [0, 0], [0, 8]);
  // Entering at F1 or F2 is the same distance (the access leg is a straight line),
  // so only assert what matters: J1 all the way to F5, and no detour fixes.
  assert.equal(res.ids.at(-1), 'F5');
  assert.ok(res.ids.every((id) => !id.startsWith('N')));
  assert.ok(res.via.slice(1).every((a) => a === 'J1'));
  const route = routeFromGraph(g, ctx, 'AAA', 'BBB');
  assert.match(route.routeString, /^AAA F\d J1 F5 BBB$/);
  assert.deepEqual(route.airwaysUsed, ['J1']);
});

test('airway class filter keeps low-altitude routes out of a high search', () => {
  const high = buildGraph(ctx, 'high');
  assert.ok(![...high.values()].some((n) => n.edges.some((e) => e.airway === 'V9')));
  const low = buildGraph(ctx, 'low');
  assert.ok([...low.values()].every((n) => n.edges.every((e) => e.airway === 'V9')));
});

test('graph search returns null when nothing is in range', () => {
  const g = buildGraph(ctx, 'high');
  assert.equal(shortestAirwayPath(g, [60, 100], [0, 8]), null);
});

// A SID out of AAA with two runway branches (S1 near AAA, S9 far away) and a STAR
// into BBB whose branches end at R1 (near BBB) and R9 (far away).
const pctx = {
  ...ctx,
  points: { ...ctx.points, S1: [0, 0.3], S9: [5, 0], S2: [0, 0.6], T1: [0, 7.4], R1: [0, 7.8], R9: [5, 8] },
  procedures: {
    sid: { SIDA1: [[['S9', 'S2'], ['S1', 'S2']], [['S2', 'F1'], ['S2', 'N1']]] },
    star: { STRB2: [[['T1', 'R9'], ['T1', 'R1']], [['F4', 'T1'], ['N2', 'T1']]] },
  },
};

test('a SID follows the transition to the next fix from the nearest branch', () => {
  const r = routeFromString('SIDA1 F1 J1 F4', pctx, 'AAA', 'BBB');
  assert.deepEqual(r.path.map((p) => p.id), ['AAA', 'S1', 'S2', 'F1', 'F2', 'F3', 'F4', 'BBB']);
  assert.deepEqual(r.proceduresUsed, ['SIDA1']);
  assert.deepEqual(r.unresolved, []);
  assert.equal(r.path[1].kind, 'sid');
});

test('a STAR starts at the previous fix and ends on the branch nearest the airport', () => {
  const r = routeFromString('F1 J1 F4 STRB2', pctx, 'AAA', 'BBB');
  assert.deepEqual(r.path.map((p) => p.id), ['AAA', 'F1', 'F2', 'F3', 'F4', 'T1', 'R1', 'BBB']);
  const viaNorth = routeFromString('F1 J2 N2 STRB2', pctx, 'AAA', 'BBB');
  assert.deepEqual(viaNorth.path.slice(-4).map((p) => p.id), ['N2', 'T1', 'R1', 'BBB']);
});

test('a procedure that does not reach the named fix is a warning, not a guess', () => {
  const r = routeFromString('SIDA1 F5', pctx, 'AAA', 'BBB');
  assert.deepEqual(r.path.map((p) => p.id), ['AAA', 'F5', 'BBB']);
  assert.match(r.warnings[0], /SIDA1: F5 is not on this SID/);
});

test('buildProcedures keys SIDs and STARs the way preferred routes name them', () => {
  const idx = new Map(['A', 'B', 'C', 'X'].map((id, i) => [id, [0, i]]));
  const cols = 'COMPUTER_CODE,ROUTE_PORTION_TYPE,ROUTE_NAME,BODY_SEQ,TRANSITION_COMPUTER_CODE,POINT_SEQ,POINT';
  const dp = parseCsv([
    `DP_${cols}`,
    'SID1.B,BODY,A-B,1,,20,B', 'SID1.B,BODY,A-B,1,,10,A', 'SID1.B,BODY,A-B,1,,15,NOCOORD',
    'SID1.B,TRANSITION,X TRANSITION,1,SID1.X,10,B', 'SID1.B,TRANSITION,X TRANSITION,1,SID1.X,20,X',
    'OTHER2.B,BODY,A-B,1,,10,A', 'OTHER2.B,BODY,A-B,1,,20,B',
  ].join('\n'));
  assert.deepEqual(buildProcedures(dp, 'SID', idx, new Set(['SID1'])), { SID1: [[['A', 'B']], [['B', 'X']]] });
  const star = parseCsv([`STAR_${cols}`, 'B.ARR3,BODY,B-C,1,,10,B', 'B.ARR3,BODY,B-C,1,,20,C'].join('\n'));
  assert.deepEqual(buildProcedures(star, 'STAR', idx, new Set(['ARR3'])), { ARR3: [[['B', 'C']], []] });
});

test('compressRoute collapses runs on the same airway', () => {
  assert.deepEqual(
    compressRoute(['A', 'B', 'C', 'D', 'E'], [undefined, 'J1', 'J1', 'J2', 'J2']),
    ['A', 'J1', 'C', 'J2', 'E'],
  );
});

// ---- NASR parsing (synthetic CSV in the documented column layout) -----------

test('parseCsv handles quotes, commas, CRLF and a BOM', () => {
  const rows = parseCsv('﻿A,B\r\n"x, y",2\r\n"say ""hi""",3\r\n');
  assert.deepEqual(rows, [{ A: 'x, y', B: '2' }, { A: 'say "hi"', B: '3' }]);
});

test('buildPointIndex lets navaids win over fixes with the same id', () => {
  const fix = parseCsv('FIX_ID,LAT_DECIMAL,LONG_DECIMAL\nABC,1,1\nFIXY,2,2\n');
  const nav = parseCsv('NAV_ID,LAT_DECIMAL,LONG_DECIMAL\nABC,9,9\n');
  const { index, duplicates } = buildPointIndex(fix, nav);
  assert.deepEqual(index.get('ABC'), [9, 9]);
  assert.equal(duplicates, 1);
});

test('buildAirways chains segments and splits at gaps', () => {
  const idx = new Map(['A', 'B', 'C', 'D', 'E'].map((id, i) => [id, [0, i]]));
  const rows = parseCsv([
    'AWY_ID,POINT_SEQ,FROM_POINT,TO_POINT',
    'J1,10,A,B', 'J1,20,B,C',
    'J1,30,D,E', // gap: C does not continue to D
    'J1,20,B,C', // duplicate row (e.g. second altitude block)
  ].join('\n'));
  const { airways } = buildAirways(rows, idx);
  assert.deepEqual(airways.J1, [['A', 'B', 'C'], ['D', 'E']]);
});

test('buildAirways drops points without coordinates and says so', () => {
  const idx = new Map([['A', [0, 0]], ['C', [0, 2]]]);
  const rows = parseCsv('AWY_ID,POINT_SEQ,FROM_POINT,TO_POINT\nJ1,10,A,B\nJ1,20,B,C\n');
  const { airways, droppedPoints } = buildAirways(rows, idx);
  assert.equal(airways.J1, undefined);
  assert.ok(droppedPoints > 0);
});

test('buildRoutes orders segments and attaches altitude text', () => {
  const seg = parseCsv([
    'ORIGIN_ID,DSTN_ID,PFR_TYPE_CODE,ROUTE_NO,SEGMENT_SEQ,SEG_VALUE',
    'DEN,BOS,H,1,2,J60', 'DEN,BOS,H,1,1,GLL', 'DEN,BOS,H,1,3,BOS',
  ].join('\n'));
  const base = parseCsv('ORIGIN_ID,DSTN_ID,PFR_TYPE_CODE,ROUTE_NO,ALTITUDE_DESCR\nDEN,BOS,H,1,FL240-FL450\n');
  assert.deepEqual(buildRoutes(seg, base), { 'DEN-BOS': [['H', 'GLL J60 BOS', 'FL240-FL450']] });
});

test('a changed column layout fails loudly with the real headers', () => {
  const rows = parseCsv('SOMETHING,ELSE\n1,2\n');
  assert.throws(() => buildAirways(rows, new Map()), /Headers are: SOMETHING, ELSE/);
});

test('buildAirports keeps ICAO public-use airports and route endpoints', () => {
  const rows = parseCsv([
    'ARPT_ID,ICAO_ID,ARPT_NAME,CITY,STATE_CODE,LAT_DECIMAL,LONG_DECIMAL,SITE_TYPE_CODE,FACILITY_USE_CODE',
    'DEN,KDEN,DENVER INTL,DENVER,CO,39.86,-104.67,A,PU',
    'XYZ,,PRIVATE STRIP,NOWHERE,CO,40,-105,A,PR',
    'HLP,,CITY HELIPORT,DENVER,CO,39.7,-105,H,PU',
    'KEP,,KEPT BY ROUTE,TOWN,CO,40.1,-105.1,A,PU',
  ].join('\n'));
  const out = buildAirports(rows, new Set(['KEP']));
  assert.deepEqual(Object.keys(out).sort(), ['DEN', 'KEP']);
  assert.equal(out.DEN[4], 'KDEN');
});

test('currentCycle returns the latest effective date on or before today', () => {
  assert.equal(currentCycle(new Date('2026-11-21T12:00:00Z')), '2026-10-29');
  assert.equal(currentCycle(new Date('2026-11-26T00:00:00Z')), '2026-11-26');
  assert.equal(currentCycle(new Date('2026-12-24T00:00:00Z')), '2026-12-24');
});
