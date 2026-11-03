import { lerp, TAU } from './math';
import { CENTRELINE, KERB_STROKES, LAP_DIRECTION, photoX, photoZ, START_LINE_CP, WIDTH_PER_PX } from './track-data';

export type Vec2 = [x: number, z: number];

/** The centreline resampled at an even step, as parallel arrays indexed by station. */
export interface Track {
  N: number;
  X: Float32Array;
  Z: Float32Array;
  /** Half width. */
  HW: Float32Array;
  TX: Float32Array;
  TZ: Float32Array;
  NX: Float32Array;
  NZ: Float32Array;
  /** Signed curvature. */
  K: Float32Array;
  /** Position in control points. */
  CP: Float32Array;
  length: number;
  step: number;
  idxOfCP: (cp: number) => number;
  avgWidth: number;
  nCP: number;
}

const SAMPLES_PER_SPAN = 24;

export const track = buildTrack();

function buildTrack(): Track {
  const controls = CENTRELINE.map(([x, y, w]) => ({ x: photoX(x), z: photoZ(y), w: w * WIDTH_PER_PX }));
  const nCP = controls.length;
  const fine: { x: number; z: number; w: number; cp: number }[] = [];

  // Centripetal Catmull-Rom, by the Barry-Goldman recursion.
  for (let i = 0; i < nCP; i++) {
    const p0 = controls[(i - 1 + nCP) % nCP];
    const p1 = controls[i];
    const p2 = controls[(i + 1) % nCP];
    const p3 = controls[(i + 2) % nCP];
    const knot = (a: typeof p0, b: typeof p0) => Math.pow(Math.hypot(b.x - a.x, b.z - a.z), 0.5) || 1e-4;
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let s = 0; s < SAMPLES_PER_SPAN; s++) {
      const t = t1 + ((t2 - t1) * s) / SAMPLES_PER_SPAN;
      const a1 = weighted(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
      const a2 = weighted(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
      const a3 = weighted(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
      const b1 = weighted(a1, a2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
      const b2 = weighted(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
      const c = weighted(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
      fine.push({
        x: c.x,
        z: c.z,
        w: lerp(p1.w, p2.w, s / SAMPLES_PER_SPAN),
        cp: i + s / SAMPLES_PER_SPAN,
      });
    }
  }
  function weighted(a: { x: number; z: number }, b: { x: number; z: number }, wa: number, wb: number) {
    return { x: a.x * wa + b.x * wb, z: a.z * wa + b.z * wb };
  }

  const cumulative = [0];
  for (let i = 1; i <= fine.length; i++) {
    const a = fine[i - 1];
    const b = fine[i % fine.length];
    cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const length = cumulative[cumulative.length - 1];

  // Resample by arc length.
  const step = 0.5;
  const N = Math.floor(length / step);
  const X = new Float32Array(N);
  const Z = new Float32Array(N);
  const rawHalfWidth = new Float32Array(N);
  const CP = new Float32Array(N);
  let seg = 0;
  for (let i = 0; i < N; i++) {
    const s = (i * length) / N;
    while (cumulative[seg + 1] < s) seg++;
    const a = fine[seg];
    const b = fine[(seg + 1) % fine.length];
    const t = (s - cumulative[seg]) / (cumulative[seg + 1] - cumulative[seg] || 1);
    X[i] = lerp(a.x, b.x, t);
    Z[i] = lerp(a.z, b.z, t);
    rawHalfWidth[i] = lerp(a.w, b.w, t) / 2;
    let nextCP = b.cp;
    if (nextCP < a.cp) nextCP += nCP;
    CP[i] = lerp(a.cp, nextCP, t) % nCP;
  }

  const HW = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let o = -8; o <= 8; o++) sum += rawHalfWidth[(i + o + N) % N];
    HW[i] = sum / 17;
  }

  const TX = new Float32Array(N);
  const TZ = new Float32Array(N);
  const NX = new Float32Array(N);
  const NZ = new Float32Array(N);
  const K = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const prev = (i - 1 + N) % N;
    const next = (i + 1) % N;
    let tx = X[next] - X[prev];
    let tz = Z[next] - Z[prev];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    TX[i] = tx;
    TZ[i] = tz;
    NX[i] = tz;
    NZ[i] = -tx;
  }
  for (let i = 0; i < N; i++) {
    const back = (i - 4 + N) % N;
    const ahead = (i + 4) % N;
    const heading = Math.atan2(TX[back], TZ[back]);
    let turn = Math.atan2(TX[ahead], TZ[ahead]) - heading;
    while (turn > Math.PI) turn -= TAU;
    while (turn < -Math.PI) turn += TAU;
    K[i] = turn / (8 * step);
  }

  const idxOfCP = (cp: number) => {
    let best = 0;
    let bestDist = 1e9;
    for (let i = 0; i < N; i++) {
      let dist = Math.abs(CP[i] - cp);
      dist = Math.min(dist, nCP - dist);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  };

  let widthSum = 0;
  for (let i = 0; i < N; i++) widthSum += HW[i] * 2;

  return { N, X, Z, HW, TX, TZ, NX, NZ, K, CP, length, step, idxOfCP, avgWidth: widthSum / N, nCP };
}

/** Closest station to a point. With a hint, only searches `window` stations either side of it. */
export function nearestOnTrack(x: number, z: number, hint = -1, window = 80) {
  const { N, X, Z } = track;
  let i = 0;
  let best = Infinity;
  if (hint < 0) {
    for (let c = 0; c < N; c++) {
      const dist = (X[c] - x) ** 2 + (Z[c] - z) ** 2;
      if (dist < best) {
        best = dist;
        i = c;
      }
    }
  } else {
    for (let o = -window; o <= window; o++) {
      const c = (hint + o + N) % N;
      const dist = (X[c] - x) ** 2 + (Z[c] - z) ** 2;
      if (dist < best) {
        best = dist;
        i = c;
      }
    }
  }
  return { i, d: Math.sqrt(best), lat: (x - track.X[i]) * track.NX[i] + (z - track.Z[i]) * track.NZ[i] };
}

/** A point on the track edge at station `i`; `side` is -1 or 1, `extra` widens the half width. */
export const edgePoint = (i: number, side: number, extra = 0): Vec2 => {
  const offset = track.HW[i] + extra;
  return [track.X[i] + track.NX[i] * offset * side, track.Z[i] + track.NZ[i] * offset * side];
};

/** The heading of a car driving the lap at station `i`. */
export const lapHeading = (i: number): number => Math.atan2(track.TX[i] * LAP_DIRECTION, track.TZ[i] * LAP_DIRECTION);

/** The station `metres` from the start line the way the centreline was traced, whichever way the lap runs. */
export function stationAt(metres: number): number {
  const along = ((metres % track.length) + track.length) % track.length;
  return (track.idxOfCP(START_LINE_CP) + Math.round((along / track.length) * track.N)) % track.N;
}

/** Stations from `from` to `to`, wrapping past the start line. */
export function stationRange(from: number, to: number): number[] {
  const stations: number[] = [];
  const n = track.N;
  let i = from;
  for (let c = 0; c < n; c++) {
    stations.push(i);
    if (i === to) break;
    i = (i + 1) % n;
  }
  return stations;
}

export interface Kerb {
  side: number;
  i0: number;
  i1: number;
}

const kerbs: Kerb[] = KERB_STROKES.map((stroke) => {
  const hits = stroke.map(([x, y]) => nearestOnTrack(photoX(x), photoZ(y)));
  const side = Math.sign(hits.reduce((sum, hit) => sum + hit.lat, 0)) || 1;
  const n = track.N;
  const first = hits[0].i;
  const offsets = hits.map((hit) => ((hit.i - first + n + n / 2) % n) - n / 2);
  const lo = Math.min(...offsets) - 3;
  const hi = Math.max(...offsets) + 3;
  return { side, i0: (first + lo + n) % n, i1: (first + hi + n) % n };
});

export function forEachKerb(visit: (inner: Vec2[], outer: Vec2[], stations: number[], kerb: Kerb) => void): void {
  for (const kerb of kerbs) {
    const stations = stationRange(kerb.i0, kerb.i1);
    const inner = stations.map((i) => edgePoint(i, kerb.side, -0.35));
    const outer = stations.map((i) => edgePoint(i, kerb.side, 0.85));
    visit(inner, outer, stations, kerb);
  }
}
