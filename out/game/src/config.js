// config.js — every tuned number for Calvera Bay sits here: the tile grid the city is built on,
// the colour palette for each hour, the physics the player and the cars obey, and the camera
// defaults the renderer starts from. This file has no behaviour; it is the tuning table every
// other module reads, so the whole game stays consistent and deterministic.
// Session 1 of 5: the static world. Sessions 2+ add actors, missions, police, HUD on top.

// ---------------------------------------------------------------- the city grid
export const TILE = 16; // world units per tile; a boulevard is 2 tiles, a car ~1.6 tiles long
export const CITY_BLOCKS = 28; // blocks per side (the ~28x28 city grid)
export const BLOCK_TILES = 8; // tiles per block, boulevard included
export const ROAD_TILES = 2; // a boulevard is two tiles wide
export const SIDEWALK_TILES = 1; // one-tile sidewalk ring around every lot
export const LOT_TILES = BLOCK_TILES - ROAD_TILES - SIDEWALK_TILES * 2; // 4 tiles of buildable lot
export const CITY_TILES = CITY_BLOCKS * BLOCK_TILES; // 224 tiles a side
export const WATER_TILES = 8; // open sea beyond the south and east quays
export const WATER_START = CITY_TILES - WATER_TILES;
export const WORLD_SIZE = CITY_TILES * TILE; // 3584 world units a side
export const QUAY_TILE = WATER_START - 1;

// ---------------------------------------------------------------- simulation
export const STEP = 1 / 60; // the fixed simulation step, seconds
export const TICK_MINUTES = 0.4; // game minutes advanced by one fixed tick
export const START_MINUTES = 17 * 60 + 20; // the city opens at golden hour
export const DAY_MINUTES = 1440;

// ---------------------------------------------------------------- palette
export const PALETTE = {
  asphalt: '#2f333c',
  asphaltWorn: '#3a3f49',
  asphaltEdge: '#262a32',
  laneMark: '#d8c163',
  crosswalk: '#c9cdd6',
  sidewalk: '#767b86',
  sidewalkEdge: '#8b909b',
  sidewalkCurb: '#565a63',
  lot: '#3c4048',
  lotDark: '#33363d',
  park: '#3f6b46',
  parkDark: '#33583b',
  parkPath: '#8a7f6a',
  water: '#1f5364',
  waterDeep: '#123743',
  waterShallow: '#2f7284',
  sand: '#9c8763',
  quay: '#5a5f68',
  paint: '#e8e2d2',
  palmTrunk: '#6b5138',
  palmLeaf: '#3f7a45',
  palmLeafLit: '#63a35a',
  lampPost: '#26292f',
  lampGlow: '#ffd79a',
  // building body tints, picked per building by seeded hash
  buildingTints: ['#8e7f74', '#a1907f', '#7d8592', '#9a8b8a', '#6f7b84', '#b0a08e', '#8b7f96'],
  towerTints: ['#5d6b7d', '#6d7686', '#4f5f70', '#7a8494', '#59667a'],
  industrialTints: ['#6d6a60', '#7a7264', '#5f6259', '#847a68'],
  roofTint: '#4a4d55',
  roofTower: '#3f4750',
  windowLit: '#ffd28a',
  windowLitCool: '#bfe0ff',
  windowDark: '#1d2530',
  shopfront: '#2b3038',
  policeBlue: '#2f5fa8',
  hospitalRed: '#a83a3a',
  signInk: '#f6ecd8',
};

// ---------------------------------------------------------------- sky & light per hour
// Each preset is the sky gradient (zenith, mid, horizon), plus haze and the light colour that
// tints every lit face. world.js blends adjacent presets by sun elevation, never snapping.
export const SKY_PRESETS = {
  dawn: { zenith: '#2c3a66', mid: '#8f6f8f', horizon: '#f0b98a', haze: '#e8c6a8', sun: '#ffd9a0', cloud: '#c9a6b4' },
  day: { zenith: '#2f6fb0', mid: '#79b3dd', horizon: '#cfe6f2', haze: '#cfe0ea', sun: '#fff6dc', cloud: '#eef4f8' },
  dusk: { zenith: '#241b46', mid: '#7a3b5e', horizon: '#f0a05c', haze: '#c98a6e', sun: '#ffb35c', cloud: '#7d4a63' },
  night: { zenith: '#05070f', mid: '#0d1426', horizon: '#1d2a44', haze: '#16203a', sun: '#cfe0ff', cloud: '#141d33' },
};

// ---------------------------------------------------------------- physics
export const PLAYER = {
  walkSpeed: 24,
  runSpeed: 44,
  accel: 220,
  friction: 14,
  radius: 6,
  eyeHeight: 16,
  height: 17,
  health: 100,
};

export const CAR = {
  accel: 165, // units/s^2 at full throttle
  brake: 300,
  reverseAccel: 95,
  maxSpeed: 205,
  maxReverse: 70,
  steer: 2.5, // rad/s at full lock, easing off at speed
  grip: 0.90, // lateral velocity kept per tick (1 = ice, 0 = rails)
  handbrakeGrip: 0.55,
  length: 26,
  width: 13,
  height: 9,
};

export const WEAPONS = [
  { id: 'pistol', name: 'Pistol', ammo: 12, damage: 18, range: 300, cooldown: 0.28 },
  { id: 'smg', name: 'SMG', ammo: 90, damage: 11, range: 340, cooldown: 0.09 },
  { id: 'shotgun', name: 'Shotgun', ammo: 24, damage: 42, range: 170, cooldown: 0.7 },
];

// ---------------------------------------------------------------- camera & view
export const CAMERA = {
  yaw: 0.60, // world rotation: the street grid reads diagonally, like a hand-drawn city map
  pitchShear: 0.55, // vertical compression of world depth (0 = edge-on, 1 = top-down)
  pitchScale: 0.58, // how far a point's height lifts it up the screen
  scale: 2.05, // pixels per world unit at zoom 1
  zoom: 1,
  minZoom: 1.15,
  maxZoom: 3.2,
  horizon: 0.34, // fraction of canvas height where sky meets the distant skyline
  followLerp: 5.5, // camera catch-up rate, per second
  lookAhead: 26, // units the camera leads a moving actor
};

export const VIEW = { width: 1280, height: 720 };

// ---------------------------------------------------------------- tuning later sessions share
export const WANTED = {
  maxStars: 5,
  heatDecayPerSecond: 0.9,
  starHeat: [0, 40, 90, 170, 280, 420],
  policeUnitsPerStar: [0, 1, 2, 3, 4, 6],
};

export const TRAFFIC = { cars: 26, pedestrians: 40, spawnRadius: 620, despawnRadius: 1000 };
export const MINIMAP = { size: 208, pad: 14, roadInk: '#c8cfd8', waterInk: '#1b4d5e' };
