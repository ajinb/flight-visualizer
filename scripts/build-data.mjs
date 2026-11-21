#!/usr/bin/env node
// Builds the JSON the flight-path page loads, from public FAA data.
//
//   node scripts/build-data.mjs --seed
//       Airports only, from OurAirports (public domain). Enough for the
//       great-circle layer. Needs no FAA access.
//
//   node scripts/build-data.mjs [--cycle YYYY-MM-DD]
//       Downloads the FAA NASR 28-Day CSV groups (APT, FIX, NAV, AWY, PFR, DP,
//       STAR) and builds airports, points, airways, preferred routes and the
//       SIDs/STARs those routes name.
//
//   node scripts/build-data.mjs --local-dir ~/Downloads/nasr
//       Same, but reads zips or extracted CSVs you already downloaded.
//
// Output: app/data/*.json

import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCsv, buildAirports, buildPointIndex, buildAirways, buildRoutes, buildProcedures,
  routeTokenSet, routeEndpoints, currentCycle,
} from './nasr.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../app/data');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FILES = {
  APT: ['APT_BASE.csv'],
  FIX: ['FIX_BASE.csv'],
  NAV: ['NAV_BASE.csv'],
  AWY: ['AWY_SEG_ALT.csv'],
  PFR: ['PFR_SEG.csv', 'PFR_BASE.csv'],
  DP: ['DP_RTE.csv'],
  STAR: ['STAR_RTE.csv'],
};

function write(name, data) {
  mkdirSync(OUT, { recursive: true });
  const s = JSON.stringify(data);
  writeFileSync(join(OUT, `${name}.json`), s);
  console.log(`  ${name}.json  ${(s.length / 1024).toFixed(0)} KB`);
}

// ---- Seed mode: airports from OurAirports ----------------------------------
async function seed() {
  const url = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';
  console.log(`Seed mode: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OurAirports download failed: HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  const out = {};
  for (const r of rows) {
    if (r.iso_country !== 'US' || r.type === 'closed') continue;
    const keep = r.type === 'large_airport' || r.type === 'medium_airport'
      || (r.type === 'small_airport' && r.scheduled_service === 'yes');
    if (!keep || !r.latitude_deg || !r.longitude_deg) continue;
    const id = (r.local_code || r.ident).toUpperCase();
    if (id.length > 4 || !/^[A-Z0-9]+$/.test(id)) continue;
    out[id] = [r.name, [r.municipality, (r.iso_region || '').replace('US-', '')].filter(Boolean).join(', '),
      Math.round(Number(r.latitude_deg) * 1e5) / 1e5, Math.round(Number(r.longitude_deg) * 1e5) / 1e5,
      /^K/.test(r.ident) ? r.ident : ''];
  }
  write('airports', out);
  write('meta', {
    source: 'seed', airportSource: 'OurAirports (public domain)', built: new Date().toISOString(),
    airports: Object.keys(out).length, airways: 0, routes: 0, cycle: null,
  });
}

// ---- NASR mode -------------------------------------------------------------
function findFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) findFiles(p, out); else out.push(p);
  }
  return out;
}

function unzipMember(zipPath, member) {
  const r = spawnSync('unzip', ['-p', zipPath, member], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`unzip ${member} from ${zipPath} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

async function loadGroup(group, ctx) {
  const wanted = FILES[group];
  const texts = {};
  if (ctx.localDir) {
    const all = ctx.localFiles;
    for (const w of wanted) {
      const direct = all.find((f) => f.endsWith(`/${w}`) || f.endsWith(`\\${w}`));
      if (direct) { texts[w] = readFileSync(direct, 'utf8'); continue; }
      const zip = all.find((f) => new RegExp(`${group}_CSV\\.zip$`, 'i').test(f));
      if (zip) { texts[w] = unzipMember(zip, w); continue; }
      if (w === wanted[0]) throw new Error(`No ${w} (or *_${group}_CSV.zip) found under ${ctx.localDir}`);
    }
    return texts;
  }
  const [y, m, d] = ctx.cycle.split('-');
  const name = `${d}_${MONTHS[Number(m) - 1]}_${y}_${group}_CSV.zip`;
  const url = `${ctx.base}/${name}`;
  console.log(`  GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}. Try --cycle with a different effective date, or download manually and use --local-dir.`);
  const zip = join(ctx.tmp, name);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  for (const w of wanted) {
    try { texts[w] = unzipMember(zip, w); } catch (e) { if (w === wanted[0]) throw e; }
  }
  return texts;
}

async function nasr() {
  const localDir = opt('local-dir');
  const cycle = opt('cycle') || currentCycle();
  const ctx = {
    localDir, cycle,
    base: opt('base-url') || 'https://nfdc.faa.gov/webContent/28DaySub/extra',
    tmp: mkdtempSync(join(tmpdir(), 'nasr-')),
    localFiles: localDir ? findFiles(resolve(localDir)) : [],
  };
  console.log(localDir ? `NASR mode: local files in ${localDir}` : `NASR mode: cycle ${cycle}`);

  const apt = await loadGroup('APT', ctx);
  const fix = await loadGroup('FIX', ctx);
  const nav = await loadGroup('NAV', ctx);
  const awy = await loadGroup('AWY', ctx);
  const pfr = await loadGroup('PFR', ctx);
  const dp = await loadGroup('DP', ctx);
  const star = await loadGroup('STAR', ctx);

  const { index, duplicates } = buildPointIndex(parseCsv(fix['FIX_BASE.csv']), parseCsv(nav['NAV_BASE.csv']));
  const { airways, droppedPoints } = buildAirways(parseCsv(awy['AWY_SEG_ALT.csv']), index);
  const routes = buildRoutes(parseCsv(pfr['PFR_SEG.csv']), pfr['PFR_BASE.csv'] ? parseCsv(pfr['PFR_BASE.csv']) : []);
  const airports = buildAirports(parseCsv(apt['APT_BASE.csv']), routeEndpoints(routes));

  const used = routeTokenSet(routes);
  const procedures = {
    sid: buildProcedures(parseCsv(dp['DP_RTE.csv']), 'SID', index, used),
    star: buildProcedures(parseCsv(star['STAR_RTE.csv']), 'STAR', index, used),
  };

  // Only keep the points something refers to.
  for (const segs of Object.values(airways)) for (const s of segs) for (const id of s) used.add(id);
  for (const group of Object.values(procedures)) {
    for (const [bodies, trans] of Object.values(group)) for (const c of [...bodies, ...trans]) for (const id of c) used.add(id);
  }
  const points = {};
  for (const id of used) if (index.has(id)) points[id] = index.get(id);

  console.log('Writing:');
  write('airports', airports);
  write('points', points);
  write('airways', airways);
  write('routes', routes);
  write('procedures', procedures);
  write('meta', {
    source: 'FAA NASR 28-Day Subscription (CSV)', cycle: localDir ? (opt('cycle') || 'local files') : cycle,
    built: new Date().toISOString(),
    airports: Object.keys(airports).length, points: Object.keys(points).length,
    airways: Object.keys(airways).length, routePairs: Object.keys(routes).length,
    sids: Object.keys(procedures.sid).length, stars: Object.keys(procedures.star).length,
    notes: { duplicateIdsSkipped: duplicates, airwayPointsWithoutCoordinates: droppedPoints },
  });
}

try {
  if (flag('seed')) await seed(); else await nasr();
} catch (e) {
  console.error(`\nBuild failed: ${e.message}`);
  process.exit(1);
}
