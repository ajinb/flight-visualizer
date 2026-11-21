// Flight animation: a plane flies the airway route while an optional second plane
// flies the great circle at the same ground speed, so the extra distance shows up as time.
import { greatCircle, distanceNm, bearing } from './route-engine.js';

export const GROUND_SPEED_KT = 450;   // fixed teaching speed, not a real aircraft model
const BASE_SECONDS = 14;              // wall-clock seconds for the longer track at 1x

/** Densify a polyline of [lat, lon] with great-circle steps and index it by distance. */
export function makeTrack(latlngs, stepNm = 20) {
  const pts = [];
  for (let i = 1; i < latlngs.length; i++) {
    const a = latlngs[i - 1];
    const b = latlngs[i];
    const n = Math.max(1, Math.ceil(distanceNm(a, b) / stepNm));
    const seg = greatCircle(a, b, n);
    for (let j = i === 1 ? 0 : 1; j < seg.length; j++) pts.push(seg[j]);
  }
  if (!pts.length && latlngs.length) pts.push(latlngs[0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distanceNm(pts[i - 1], pts[i]));
  return { pts, cum, total: cum[cum.length - 1] || 0 };
}

/** Index of the last point at or before nm (binary search). */
function indexAt(track, nm) {
  let lo = 0;
  let hi = track.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track.cum[mid] <= nm) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Position and heading after flying nm along the track. */
export function positionAt(track, nm) {
  const d = Math.max(0, Math.min(nm, track.total));
  const i = indexAt(track, d);
  const last = track.pts.length - 1;
  if (i >= last) {
    const h = last > 0 ? bearing(track.pts[last - 1], track.pts[last]) : 0;
    return { lat: track.pts[last][0], lon: track.pts[last][1], heading: h, index: last };
  }
  const a = track.pts[i];
  const b = track.pts[i + 1];
  const span = track.cum[i + 1] - track.cum[i];
  const f = span ? (d - track.cum[i]) / span : 0;
  return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, heading: bearing(a, b), index: i };
}

/** Points already flown, ending at the plane. */
export function trailTo(track, nm) {
  const p = positionAt(track, nm);
  return [...track.pts.slice(0, p.index + 1), [p.lat, p.lon]];
}

export function formatHours(hours) {
  const m = Math.round(hours * 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const PLANE_SVG = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" stroke="#fff" stroke-width="1" d="M12 1.5l2 7 8.5 4.5v2.2L14 12.8l-.8 5.2 3 2.2v1.6L12 20.5 7.8 21.5v-1.6l3-2.2-.8-5.2L1.5 15.2V13l8.5-4.5z"/></svg>';

export class Flight {
  constructor(map, L, onTick) {
    this.map = map;
    this.L = L;
    this.onTick = onTick || (() => {});
    this.speed = 1;
    this.race = true;
    this.flown = 0;
    this.playing = false;
    this.raf = 0;
    this.layers = [];
    this.route = null;
    this.gc = null;
  }

  /** Load a new pair: routeLatLngs is the airway route, gcLatLngs the straight-line endpoints. */
  set(routeLatLngs, gcLatLngs, colors) {
    this.stop();
    for (const l of this.layers) this.map.removeLayer(l);
    this.layers = [];
    this.route = makeTrack(routeLatLngs);
    this.gc = makeTrack(gcLatLngs, 40);
    this.flown = 0;
    const L = this.L;
    const mk = (cls, color) => {
      const icon = L.divIcon({ className: 'plane', html: `<div class="plane-i ${cls}" style="color:${color}">${PLANE_SVG}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
      return L.marker(this.route.pts[0], { icon, interactive: false, keyboard: false, zIndexOffset: cls === 'plane-route' ? 1000 : 900 });
    };
    this.gcTrail = L.polyline([], { color: colors.gc, weight: 5, opacity: 0.95, interactive: false });
    this.routeTrail = L.polyline([], { color: colors.route, weight: 6, opacity: 0.95, interactive: false });
    this.gcPlane = mk('plane-gc', colors.gc);
    this.routePlane = mk('plane-route', colors.route);
    this.layers = [this.gcTrail, this.routeTrail, this.gcPlane, this.routePlane];
    for (const l of this.layers) l.addTo(this.map);
    this.update();
  }

  get longest() { return Math.max(this.route?.total || 0, this.gc?.total || 0); }

  update() {
    if (!this.route) return;
    const place = (track, plane, trail, show) => {
      const p = positionAt(track, this.flown);
      plane.setLatLng([p.lat, p.lon]);
      const el = plane.getElement()?.firstChild;
      if (el) el.style.transform = `rotate(${p.heading}deg)`;
      trail.setLatLngs(trailTo(track, this.flown));
      if (show && !this.map.hasLayer(plane)) { plane.addTo(this.map); trail.addTo(this.map); }
      if (!show && this.map.hasLayer(plane)) { this.map.removeLayer(plane); this.map.removeLayer(trail); }
    };
    place(this.route, this.routePlane, this.routeTrail, true);
    place(this.gc, this.gcPlane, this.gcTrail, this.race);
    const total = this.longest;
    this.onTick({
      frac: total ? Math.min(1, this.flown / total) : 0,
      playing: this.playing,
      elapsedHours: this.flown / GROUND_SPEED_KT,
      routeHours: this.route.total / GROUND_SPEED_KT,
      gcHours: this.gc.total / GROUND_SPEED_KT,
      routeDone: this.flown >= this.route.total,
      gcDone: this.flown >= this.gc.total,
    });
  }

  play() {
    if (!this.route) return;
    if (this.flown >= this.longest) this.flown = 0;
    this.playing = true;
    let prev = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      this.flown = Math.min(this.longest, this.flown + (this.longest / BASE_SECONDS) * this.speed * dt);
      if (this.flown >= this.longest) this.playing = false;
      this.update();
      if (this.playing) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    this.update();
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  pause() { this.stop(); this.update(); }
  restart() { this.stop(); this.flown = 0; this.update(); }
  seek(frac) { this.stop(); this.flown = this.longest * Math.max(0, Math.min(1, frac)); this.update(); }
  setSpeed(x) { this.speed = x; }
  setRace(on) { this.race = on; this.update(); }
}
