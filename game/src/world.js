// world.js — the game's clock and its light: minutes tick forward, the sun crosses, and the sky,
// the street lamps and every window in Calvera Bay go on and off by that clock alone. No wall-clock
// reads anywhere; advanceWorld(world, seconds) is the only way time moves, so a replay of the
// same ticks shows the same sky. The renderer reads everything here each frame.
import { STEP, TICK_MINUTES, START_MINUTES, DAY_MINUTES, SKY_PRESETS } from './config.js';
import { clamp, lerp, smoothstep, blendHex, hexRgb, rgbHex, hash2 } from './util.js';

const PRESET_KEYS = ['night', 'dawn', 'day', 'dusk', 'night'];
const PRESET_COLORS = {
  night: SKY_PRESETS.night, dawn: SKY_PRESETS.dawn, day: SKY_PRESETS.day, dusk: SKY_PRESETS.dusk,
};

/**
 * Make the world's clock. starts at minutes (default START_MINUTES, 17:20 — golden hour, the
 * light the whole game opens in) and owns: minutes, the day index, whether the sun is rising,
 * its elevation and where it sits on the screen.
 */
export function createWorld(minutes = START_MINUTES) {
  const world = {
    minutes,
    day: 0,
    time: 0, // total fixed ticks elapsed, a render-phase clock for shimmer and sway
    sunElev: 0,
    sunAz: 0,
    rising: true,
  };
  computeSun(world);
  return world;
}

/** The clock at hh:mm, for staging scenes at a chosen hour. */
export function createWorldAt(hh, mm) {
  return createWorld(hh * 60 + mm);
}

/** One fixed step: TICK_MINUTES of game time per tick, plus the sun and phase bookkeeping. */
export function advanceWorld(world) {
  world.time += 1;
  world.minutes += TICK_MINUTES;
  if (world.minutes >= DAY_MINUTES) {
    world.minutes -= DAY_MINUTES;
    world.day += 1;
  }
  computeSun(world);
  return world;
}

/** Run n fixed steps in one deterministic gulp (the probe API and the shot staging use this). */
export function advanceWorldTicks(world, n) {
  for (let i = 0; i < n; i += 1) advanceWorld(world);
  return world;
}

/** Fold the clock into sun elevation (sine curve: 6:00 up, 12:00 high, 18:00 down) + azimuth. */
function computeSun(world) {
  const phase = world.minutes / DAY_MINUTES; // 0 midnight .. 0.5 noon
  world.sunElev = Math.sin((phase - 0.25) * Math.PI * 2);
  world.sunAz = (phase - 0.25) * Math.PI * 2; // 0 at 6:00 sunrise, PI at 18:00 sunset
  world.rising = phase >= 0.25 && phase < 0.75; // the sun climbs from 6:00 to 18:00
}

/** How much light is in the sky: 0 deep night .. 1 midday. */
export function ambientLevel(world) {
  return 0.15 + 0.85 * smoothstep(-0.14, 0.38, world.sunElev);
}

/** Day-of-light phase name: 'dawn' | 'day' | 'dusk' | 'night'. */
export function phaseName(world) {
  const e = world.sunElev;
  if (e > 0.32) return 'day';
  const twilight = e > -0.14;
  if (twilight) return world.rising ? 'dawn' : 'dusk';
  return 'night';
}

/**
 * Weight the hour's position between the sky presets: night and day hold the ends, dawn or dusk
 * (whichever half of the day it is) bridge the morning and evening. Weights sum to 1.
 */
function presetWeights(world) {
  const e = world.sunElev;
  const wDay = smoothstep(0.16, 0.42, e);
  const wNight = smoothstep(-0.10, -0.32, e); // grows as the sun sinks far below horizon
  const bridge = smoothstep(0.30, -0.02, e) * (1 - wNight); // twilight band around the horizon
  const warm = world.rising ? 'dawn' : 'dusk';
  const wBridgeName = bridge > 0 ? warm : (world.rising ? 'dawn' : 'dusk');
  const w = { night: wNight, day: wDay, dawn: 0, dusk: 0 };
  w[wBridgeName] = bridge;
  const total = w.night + w.day + w.dawn + w.dusk;
  if (total < 1e-6) { w.day = 1; return w; }
  w.night /= total; w.day /= total; w.dawn /= total; w.dusk /= total;
  return w;
}

/** The preset key with the largest weight right now — the palette samples below blend all. */
export function dominantPreset(world) {
  const w = presetWeights(world);
  let bestKey = 'day';
  let bestW = -1;
  for (const key of Object.keys(w)) {
    if (w[key] > bestW) { bestW = w[key]; bestKey = key; }
  }
  return bestKey;
}

/** Blend one colour key across the presets by weight. */
function blendPreset(weights, key) {
  let r = 0, g = 0, b = 0;
  for (const name of ['night', 'dawn', 'day', 'dusk']) {
    const w = weights[name];
    if (w <= 0) continue;
    const [cr, cg, cb] = hexRgb(PRESET_COLORS[name][key]);
    r += cr * w; g += cg * w; b += cb * w;
  }
  return rgbHex(r, g, b);
}

/**
 * The sky gradient for this minute: three stops from zenith (at=0) to horizon (at=1), plus the
 * haze colour buildings fade into near the horizon and the sun/moon disc colour.
 */
export function skyGradient(world) {
  const w = presetWeights(world);
  return {
    zenith: blendPreset(w, 'zenith'),
    mid: blendPreset(w, 'mid'),
    horizon: blendPreset(w, 'horizon'),
    haze: blendPreset(w, 'haze'),
    orb: blendPreset(w, 'sun'),
    cloud: blendPreset(w, 'cloud'),
  };
}

/**
 * The sun or moon's place in the sky, as canvas fractions ready to draw: x 0..1 across, y 0 at
 * the top of the sky, and elevation still there for glow sizing.
 */
export function sunPosition(world, horizon = 0.34, height = 720) {
  const e = world.sunElev;
  const isSun = e > -0.05;
  const xFrac = 0.5 - 0.42 * Math.cos(world.sunAz); // rises east (right), sets west (left)
  const yFrac = horizon - Math.max(e, -0.05) * 0.52; // the disc grazes the skyline at e = 0
  return { x: xFrac * 1280, y: Math.max(yFrac, 0.02) * height, isSun, elevation: e };
}

/** Out at dusk, in at night: the street lamps and the district's windows light up. */
export function lightsAreOn(world) {
  return smoothstep(0.55, 0.30, world.sunElev); // 0 in the day, 1 in full dusk and night
}

/**
 * How many of a building's windows burn, per building: a fraction 0..1 driven by the hour and the
 * building's own hash, so at night the towers read as dotted glass rather than equal stripes.
 */
export function windowLitFraction(world, litSeed) {
  const base = lightsAreOn(world);
  const own = 0.35 + 0.5 * hash2(litSeed & 0xffff, litSeed >>> 16, 7);
  return clamp(base * own * 1.35, 0, 1);
}

/** A steady readable clock string, 24h, for the HUD. */
export function clockString(world) {
  const h = Math.floor(world.minutes / 60);
  const m = Math.floor(world.minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A colour shaded for the hour: warmed by the sunset band, then dimmed toward night blue. */
export function tintForTime(hex, world) {
  const amb = ambientLevel(world);
  const warm = smoothstep(0.35, -0.10, world.sunElev); // 1 near and after sunset
  const warmed = blendHex(hex, '#e8905c', 0.15 * warm);
  return blendHex('#141a2c', warmed, amb); // ambient lifts it back to its daylight colour
}
