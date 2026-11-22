// util.js — the deterministic toolkit every module shares. All randomness in Calvera Bay comes
// from the mulberry32 RNG class here, seeded once: no Math.random and no Date.now anywhere in
// the game, so the same seed always rebuilds the same city and replays the same scenes.

/** mulberry32 as a small class: step() -> float in [0,1). Deterministic across browsers. */
export class Rng {
  constructor(seed) {
    this.state = (seed | 0) >>> 0;
  }
  /** Advance the sequence: the next float in [0,1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [0, n). */
  int(n) {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }
  /** Float in [min, max). */
  range(min, max) {
    return min + this.next() * (max - min);
  }
  /** A value from an array. */
  pick(list) {
    return list[this.int(list.length)];
  }
  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }
  /** A unit vector at a seeded angle, as {x, z}. */
  angle() {
    const a = this.next() * Math.PI * 2;
    return { x: Math.cos(a), z: Math.sin(a) };
  }
}

/** Smooth 0..1 ramp: 0 below edge0, 1 above edge1, eased between. */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Linear interpolation. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Constrain x to [min, max]. */
export function clamp(x, min, max) {
  return x < min ? min : x > max ? max : x;
}

/** Move `x` toward `target` by at most `maxDelta`. */
export function moveToward(x, target, maxDelta) {
  return x < target ? Math.min(x + maxDelta, target) : Math.max(x - maxDelta, target);
}

/** Exponential approach used by the camera: t = 1 - exp(-rate * dt). */
export function approach(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Stable 2D hash -> float in [0,1): the same (x, z, seed) always yields the same value, so
 * per-tile or per-building variety (window grids, worn asphalt, palm jitter) needs no storage.
 */
export function hash2(x, z, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Squared distance in the ground plane. */
export function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Axis-aligned box: {x, z, w, d} with optional y/h for height. */
export function makeAabb(x, z, w, d) {
  return { x, z, w, d };
}

/** True when two ground-plane AABBs overlap. */
export function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.d && a.z + a.d > b.z;
}

/** True when a point is inside an AABB. */
export function pointInAabb(px, pz, a) {
  return px >= a.x && px <= a.x + a.w && pz >= a.z && pz <= a.z + a.d;
}

export function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad) {
  return (rad * 180) / Math.PI;
}

/** Wrap an angle to [-PI, PI]. */
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Shortest signed turn from heading a to heading b, in radians. */
export function angleDelta(a, b) {
  return wrapAngle(b - a);
}

/** Blend two '#rrggbb' colours; t=0 gives a, t=1 gives b. */
export function blendHex(a, b, t) {
  const ca = hexRgb(a);
  const cb = hexRgb(b);
  return rgbHex(lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t));
}

/** '#rrggbb' -> [r, g, b] on 0..255. */
export function hexRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** [r, g, b] on 0..255 -> '#rrggbb'. */
export function rgbHex(r, g, b) {
  const c = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Multiply a hex colour's brightness by k (0..1+), clamped. */
export function shadeHex(hex, k) {
  const [r, g, b] = hexRgb(hex);
  return rgbHex(r * k, g * k, b * k);
}
