// city.js — Calvera Bay itself, built once from one seed and never changing: a 28-block grid of
// 8-tile blocks (2-tile boulevards, 1-tile sidewalks, 4-tile lots), towers downtown at the centre,
// low industrial sheds toward the edges, parks, palms along the boulevards, street lamps on the
// corners, and the sea wrapping the south and east quays so the whole city is an island. Every
// wall the game collides with is an AABB exported from here. Session 1 builds the static world:
// no actors yet, but the traffic lanes, the sidewalk spawn ring and the named landmarks later
// sessions stage missions around are all laid out now.
import { TILE, CITY_BLOCKS, BLOCK_TILES, CITY_TILES, WATER_START, LOT_TILES, WORLD_SIZE, PALETTE } from './config.js';
import { Rng, clamp, lerp, hash2, aabbOverlap } from './util.js';

export const CITY_SEED = 1337;
export const BUILDABLE_BLOCKS = 27; // block 27 of 28 is the southern/eastern waterfront strip

// Ground tile types; city.tiles is a flat Uint8Array, row-major at (tz * CITY_TILES + tx).
export const T_ROAD = 0, T_SIDEWALK = 1, T_LOT = 2, T_WATER = 3, T_PARK = 4, T_QUAY = 5;

// The lot inside one block starts after 2 road tiles + 1 sidewalk tile...
const LOT_OFFSET = 3;
const FIRST_WATER_TILE = WATER_START + 2;

/**
 * The named landmarks: mission hooks for later sessions, each a building the renderer signs and
 * the minimap badges. Low x/z is north-west; the sea lies on high x/z (south and east).
 */
const LANDMARK_PLANS = [
  { id: 'pawn', name: "Marisol's Pawn", bx: 3, bz: 3, h: 46, tint: '#a1907f', kind: 'shop' },
  { id: 'market', name: 'Bayside Market', bx: 22, bz: 4, h: 34, tint: '#b0a08e', kind: 'market' },
  { id: 'dock', name: 'Harbour Gate', bx: 3, bz: 26, h: 30, tint: '#7a7264', kind: 'dock' },
  { id: 'police', name: 'Calvera PD', bx: 14, bz: 11, h: 52, tint: PALETTE.policeBlue, kind: 'police' },
  { id: 'hospital', name: 'Cielo Hospital', bx: 13, bz: 16, h: 74, tint: PALETTE.hospitalRed, kind: 'hospital' },
  { id: 'autos', name: 'Sunset Autos', bx: 18, bz: 8, h: 24, tint: '#847a68', kind: 'autos' },
  { id: 'club', name: 'Club Mirador', bx: 11, bz: 11, h: 96, tint: '#8b7f96', kind: 'club' },
  { id: 'tower', name: 'Vela Tower', bx: 14, bz: 14, h: 220, tint: '#4f5f70', kind: 'tower' },
];

/** Distance of a block from downtown: 0 at the centre, 1 at the city rim. */
function rimFactor(bx, bz) {
  const c = (BUILDABLE_BLOCKS - 1) / 2;
  return Math.max(Math.abs(bx - 1 - c), Math.abs(bz - 1 - c)) / c;
}

/** A palm at world x,z: height, lean and a phase the renderer sways it by. */
function palmAt(rng, x, z) {
  return { x, z, h: rng.range(19, 27), lean: rng.range(-0.16, 0.16), phase: rng.int(64) };
}

/** A street lamp at world x,z (a corner of the sidewalk ring). */
function lampAt(x, z) {
  return { x, z, h: 22 };
}

/** Push a building footprint onto the arrays; world units, x/z is the min corner. */
function addBuilding(list, tx, tz, tw, td, h, tint, style, litSeed, name, landmark) {
  const b = {
    x: tx * TILE, z: tz * TILE, w: tw * TILE, d: td * TILE, h,
    tint, style, litSeed, name: name ?? null, landmark: landmark ?? null,
  };
  b.cx = b.x + b.w / 2;
  b.cz = b.z + b.d / 2;
  list.push(b);
  return b;
}

/** One ordinary block: a tower downtown, shops mid-town, industrial sheds at the rim. */
function buildCityBlock(rng, bx, bz, lotTX, lotTZ, rim, buildings) {
  const downtown = 1 - rim;
  if (downtown > 0.72) {
    // Downtown: one tower filling the lot, occasionally a smaller shoulder tower beside it.
    const h = lerp(96, 230, rng.next() * rng.next() + 0.2 * rng.next());
    const slim = rng.chance(0.35) ? 1 : 0;
    addBuilding(buildings, lotTX, lotTZ, LOT_TILES - slim, LOT_TILES - slim, h,
      rng.pick(PALETTE.towerTints), 'tower', rng.int(1 << 30));
    if (slim) {
      // the freed strip becomes a low podium annex so downtown blocks still read as full
      addBuilding(buildings, lotTX + LOT_TILES - slim, lotTZ + rng.int(2), slim, LOT_TILES - 2,
        rng.range(28, 44), rng.pick(PALETTE.buildingTints), 'podium', rng.int(1 << 30));
    }
  } else if (rim > 0.7) {
    // Industrial edge: wide, low sheds with flat roofs, some of them paired.
    const first = addBuilding(buildings, lotTX + rng.int(2), lotTZ, LOT_TILES - rng.int(2), 2,
      rng.range(18, 34), rng.pick(PALETTE.industrialTints), 'industrial', rng.int(1 << 30));
    if (rng.chance(0.6)) {
      addBuilding(buildings, lotTX, lotTZ + 2 + rng.int(1), LOT_TILES - rng.int(2), 2 - rng.int(1),
        rng.range(14, 28), rng.pick(PALETTE.industrialTints), 'industrial', rng.int(1 << 30));
    }
  } else {
      // Mid-town: the 4x4 lot becomes 2x2 sub-lots, each maybe a shop with a shopfront.
    for (let sz = 0; sz < 2; sz += 1) {
      for (let sx = 0; sx < 2; sx += 1) {
        if (rng.chance(0.12)) continue; // a little open courtyard now and then
        const subTX = lotTX + sx * 2;
        const subTZ = lotTZ + sz * 2;
        const wither = rng.chance(0.25) ? 1 : 0;
        addBuilding(buildings, subTX + wither * rng.int(1), subTZ + wither * rng.int(1),
          2 - wither, 2 - wither, rng.range(24, 88), rng.pick(PALETTE.buildingTints),
          'shop', rng.int(1 << 30));
      }
    }
  }
}

/** A landmark block: one signed building centred on its lot. */
function buildLandmarkBlock(plan, lotTX, lotTZ, buildings, landmarks) {
  const b = addBuilding(buildings, lotTX, lotTZ, LOT_TILES, LOT_TILES, plan.h, plan.tint,
    plan.kind, plan.id.length * 7 + plan.bx, plan.name, plan.id);
  landmarks.push({
    id: plan.id, name: plan.name, kind: plan.kind, tint: plan.tint,
    x: b.cx, z: b.cz, w: b.w, d: b.d, h: b.h,
  });
  return b;
}

/**
 * Build the whole city. Deterministic: the same seed lays the same streets every time.
 * Returns { seed, tiles, buildings, colliders, landmarks, palms, lamps, parks, pier,
 *           playerSpawn, sidewalkSpots, size, worldSize, waterStart }.
 */
export function createCity(seed = CITY_SEED) {
  const rng = new Rng(seed ^ 0x9e3779b9);
  const tiles = new Uint8Array(CITY_TILES * CITY_TILES);
  const buildings = [];
  const landmarks = [];
  const palms = [];
  const lamps = [];
  const parks = [];
  const sidewalkSpots = [];

  const mark = (tx, tz, type) => { tiles[tz * CITY_TILES + tx] = type; };

  const landmarkByBlock = new Map();
  for (const plan of LANDMARK_PLANS) landmarkByBlock.set(plan.bx + ',' + plan.bz, plan);

  // ------------------------------------------------ the ground grid, tile by tile
  for (let tz = 0; tz < CITY_TILES; tz += 1) {
    for (let tx = 0; tx < CITY_TILES; tx += 1) {
      const lx = tx % BLOCK_TILES, lz = tz % BLOCK_TILES;
      let type;
      if (tx >= FIRST_WATER_TILE || tz >= FIRST_WATER_TILE) type = T_WATER;
      else if (tx >= WATER_START || tz >= WATER_START) type = T_QUAY;
      else if (lx < 2 || lz < 2) type = T_ROAD; // two-tile boulevards, every block
      else if (lx === 2 || lz === 2 || lx === 7 || lz === 7) type = T_SIDEWALK; // ring around the lot
      else type = T_LOT;
      mark(tx, tz, type);
    }
  }

  // ------------------------------------------------ one block at a time
  for (let bz = 0; bz < BUILDABLE_BLOCKS; bz += 1) {
    for (let bx = 0; bx < BUILDABLE_BLOCKS; bx += 1) {
      const lotTX = bx * BLOCK_TILES + LOT_OFFSET;
      const lotTZ = bz * BLOCK_TILES + LOT_OFFSET;
      const rim = rimFactor(bx, bz);
      const plan = landmarkByBlock.get(bx + ',' + bz);
      const blockHash = hash2(bx, bz, seed);

      // Parks: roughly a block in ten, rarer downtown where the towers stand.
      const isPark = !plan && blockHash > (rim < 0.3 ? 0.96 : 0.9);
      if (isPark) {
        for (let lz = -1; lz < LOT_TILES + 1; lz += 1) {
          for (let lx = -1; lx < LOT_TILES + 1; lx += 1) mark(lotTX + lx, lotTZ + lz, T_PARK);
        }
        parks.push({ x: (lotTX + LOT_TILES / 2) * TILE, z: (lotTZ + LOT_TILES / 2) * TILE });
        for (let p = 0; p < 4; p += 1) {
          palms.push(palmAt(rng, (lotTX + rng.range(0.5, LOT_TILES - 0.5)) * TILE,
            (lotTZ + rng.range(0.5, LOT_TILES - 0.5)) * TILE));
        }
      }

      if (plan) buildLandmarkBlock(plan, lotTX, lotTZ, buildings, landmarks);
      else if (!isPark) buildCityBlock(rng, bx, bz, lotTX, lotTZ, rim, buildings);

      // Four sidewalk corners per block, in the ring the renderer and the walkers share.
      sidewalkSpots.push(
        { x: (lotTX - 0.5) * TILE, z: (lotTZ - 0.5) * TILE },
        { x: (lotTX + LOT_TILES + 0.5) * TILE, z: (lotTZ - 0.5) * TILE },
        { x: (lotTX - 0.5) * TILE, z: (lotTZ + LOT_TILES + 0.5) * TILE },
        { x: (lotTX + LOT_TILES + 0.5) * TILE, z: (lotTZ + LOT_TILES + 0.5) * TILE },
      );

      // Street lamps on two corners per block, on the sidewalk ring, deterministic pick.
      const lampCorner = (blockHash * 4) | 0;
      const off = (c) => (c === 0) ? [lotTX - 0.35, lotTZ - 0.35]
        : (c === 1) ? [lotTX + LOT_TILES + 0.35, lotTZ - 0.35]
        : (c === 2) ? [lotTX - 0.35, lotTZ + LOT_TILES + 0.35]
        : [lotTX + LOT_TILES + 0.35, lotTZ + LOT_TILES + 0.35];
      const a = off(lampCorner & 1 ? 1 : 0);
      const b2 = off((lampCorner & 2) ? 3 : 2);
      lamps.push(lampAt(a[0] * TILE, a[1] * TILE));
      lamps.push(lampAt(b2[0] * TILE, b2[1] * TILE));

      // Palms along the boulevard sidewalks, away from the downtown core.
      if (!isPark && rim > 0.2) {
        const side = (blockHash * 97) & 3; // one side stays clear, the rest carry a palm
        if (side !== 0) palms.push(palmAt(rng, (lotTX + rng.range(0, LOT_TILES)) * TILE, (lotTZ - 0.5) * TILE));
        if (side !== 1) palms.push(palmAt(rng, (lotTX + LOT_TILES + 0.5) * TILE, (lotTZ + rng.range(0, LOT_TILES)) * TILE));
        if (side !== 2) palms.push(palmAt(rng, (lotTX + rng.range(0, LOT_TILES)) * TILE, (lotTZ + LOT_TILES + 0.5) * TILE));
        if (side !== 3) palms.push(palmAt(rng, (lotTX - 0.5) * TILE, (lotTZ + rng.range(0, LOT_TILES)) * TILE));
      }
    }
  }

  // ------------------------------------------------ Harbour Gate's pier, over the south quay into open water
  const dock = landmarks.find((l) => l.id === 'dock');
  const pierTX = Math.floor(dock.x / TILE) - 1;
  const pier = { x: pierTX * TILE, z: WATER_START * TILE - TILE, w: TILE * 3, d: TILE * 5, h: 7, tint: PALETTE.quay, style: 'pier', name: 'Harbour Gate', walkable: true };
  for (let tz = WATER_START - 1; tz < WATER_START + 4; tz += 1) {
    for (let tx = pierTX; tx < pierTX + 3; tx += 1) mark(tx, tz, T_QUAY);
  }
  dock.pier = pier;
  buildings.push(pier);

  const colliders = [];
  for (const b of buildings) {
    if (b.walkable) continue; // the pier is a floor, not a wall
    colliders.push({ x: b.x, z: b.z, w: b.w, d: b.d, h: b.h });
  }

  // ------------------------------------------------ the street-dressing pass (deterministic)
  // A second, independent rng stream: the seeded street furniture, lot programmes (parking,
  // plaza, construction), parked bays and facade signs, laid over the block grid. It never
  // touches the block rng above, so the buildings and colliders stay exactly where they were.
  const street = buildStreetDetail(seed, buildings, landmarks);

  return {
    seed, size: CITY_TILES, worldSize: WORLD_SIZE, waterStart: WATER_START,
    tiles, buildings, colliders, landmarks, palms, lamps, parks, pier, sidewalkSpots,
    ...street,
    playerSpawn: { x: (3 * BLOCK_TILES + 2.5) * TILE, z: (3 * BLOCK_TILES + 2.5) * TILE },
  };
}

// ---------------------------------------------------------------- street dressing
const PROP_KINDS = ['hydrant', 'bin', 'bench', 'newsbox', 'shelter', 'planter', 'sign'];

/**
 * The whole street-dressing pass: one seeded walk over the block grid producing the sidewalk
 * furniture (hydrants, bins, benches, bus shelters, news boxes, potted palms, parking signs),
 * the lot programmes (parking lots with bay stripes, plazas with fountains, construction sites
 * with fencing and a crane), the parked cars that sit in the bays, and the shopfront awnings
 * and neon signs that hang off the mid-town facades. Deterministic: the same seed lays the
 * same dressing; nothing here changes the collision world.
 */
function buildStreetDetail(seed, buildings, landmarks) {
  const streetRng = new Rng(seed ^ 0x51ed270b);
  const props = []; // sidewalk furniture: { kind, x, z, rot }
  const bays = []; // parked-car spots: { x, z, heading, body, roof }
  const lots = []; // lot programmes: { kind, x, z, w, d, ... }
  const shopfronts = []; // awning/neon plates: { x, z, w, d, dir, tint, neon }

  for (let bz = 0; bz < BUILDABLE_BLOCKS; bz += 1) {
    for (let bx = 0; bx < BUILDABLE_BLOCKS; bx += 1) {
      const blockHash = hash2(bx, bz, seed ^ 0x51ed);
      const lotTX = bx * BLOCK_TILES + LOT_OFFSET;
      const lotTZ = bz * BLOCK_TILES + LOT_OFFSET;
      const lotX = lotTX * TILE;
      const lotZ = lotTZ * TILE;
      const lotW = LOT_TILES * TILE;
      const downtown = 1 - rimFactor(bx, bz);
      const isPark = blockHash > 0.9;

      // ---- the lot programme: parking / plaza / construction on the plain mid-town blocks
      if (!isPark && downtown < 0.8 && blockHash > 0.55 && blockHash <= 0.75) {
        lots.push({
          kind: 'parking', x: lotX, z: lotZ, w: lotW, d: lotD(lotW),
          rows: 2 + ((blockHash * 100) & 1), bay: 13, gap: 26,
        });
        const rowsN = 2 + ((blockHash * 100) & 1);
        for (let row = 0; row < rowsN; row += 1) {
          for (let c = 0; c < 4; c += 1) {
            if (streetRng.chance(0.45)) continue; // some bays stay empty
            bays.push({
              x: lotX + 14 + c * 15, z: lotZ + 22 + row * 26,
              heading: (row % 2 === 0) ? 0 : Math.PI,
              body: CAR_TINTS[streetRng.int(CAR_TINTS.length)],
              roof: '#242830',
            });
          }
        }
      } else if (!isPark && downtown < 0.8 && blockHash > 0.75 && blockHash <= 0.86) {
        lots.push({ kind: 'plaza', x: lotX, z: lotZ, w: lotW, d: lotW });
        // benches and planters ring the plaza
        for (let s = 0; s < 4; s += 1) {
          props.push({ kind: 'bench', x: lotX + 20 + s * 18, z: lotZ + 18, rot: 0 });
          props.push({ kind: 'planter', x: lotX + 18 + s * 18, z: lotZ + 44, rot: 0 });
        }
      } else if (!isPark && downtown < 0.8 && blockHash > 0.86 && blockHash <= 0.92) {
        lots.push({ kind: 'construction', x: lotX, z: lotZ, w: lotW, d: lotW });
        props.push({ kind: 'crane', x: lotX + lotW * 0.72, z: lotZ + lotW * 0.3, rot: 0 });
      }

      // ---- sidewalk furniture: walk the four kerb lines of the block's sidewalk ring
      if (isPark || downtown > 0.95) continue; // parks keep their own benches; skip towers
      const inner = (lotTX - 0.5) * TILE; // the sidewalk band's centre line (tile lx==2)
      const outer = (lotTZ + LOT_TILES + 0.5) * TILE; // the far sidewalk band's centre (lx==7)
      for (let s = 0; s < 5; s += 1) {
        const along = lotZ + 8 + s * 16 + ((blockHash * 71) & 7);
        const side = hash2(bx, bz, 33 + s) * 6.28;
        if (hash2(bx, bz, 101 + s) > 0.42) {
          props.push({ kind: PROP_KINDS[(hash2(bx, bz, 5 + s) * PROP_KINDS.length) | 0], x: inner, z: along, rot: side });
        }
        if (hash2(bx, bz, 211 + s) > 0.42) {
          props.push({ kind: PROP_KINDS[(hash2(bx, bz, 17 + s) * PROP_KINDS.length) | 0], x: outer, z: along, rot: side });
        }
        const vAlong = lotX + 8 + s * 16 + ((blockHash * 53) & 7);
        if (hash2(bx, bz, 301 + s) > 0.45) {
          props.push({ kind: PROP_KINDS[(hash2(bx, bz, 25 + s) * PROP_KINDS.length) | 0], x: vAlong, z: inner, rot: side });
        }
        if (hash2(bx, bz, 401 + s) > 0.45) {
          props.push({ kind: PROP_KINDS[(hash2(bx, bz, 31 + s) * PROP_KINDS.length) | 0], x: vAlong, z: outer, rot: side });
        }
      }

      // ---- kerb parking: a row of cars nosed into marked bays along one block edge
      if (blockHash > 0.62) {
        const side = (blockHash * 97) & 3;
        const off = 12; // into the lot's shoulder band, off the traffic lane
        for (let c = 0; c < 3; c += 1) {
          if (streetRng.chance(0.3)) continue;
          const along = lotZ + 30 + c * 30;
          if (side === 0 || side === 2) {
            bays.push({ x: lotX - off + (side === 2 ? lotW + off * 2 : 0), z: along, heading: side === 0 ? 0 : Math.PI, body: CAR_TINTS[streetRng.int(CAR_TINTS.length)], roof: '#242830', kerb: true });
          } else {
            bays.push({ x: along, z: lotZ - off + (side === 3 ? lotW + off * 2 : 0), heading: side === 1 ? Math.PI / 2 : -Math.PI / 2, body: CAR_TINTS[streetRng.int(CAR_TINTS.length)], roof: '#242830', kerb: true });
          }
        }
      }
    }
  }

  // ---- shopfronts: awnings and neon signs on the mid-town shops' street-facing walls
  for (const b of buildings) {
    if (b.style !== 'shop' || b.h < 20 || b.h > 92) continue;
    const h = hash2(b.cx | 0, b.cz | 0, 77);
    if (h > 0.62) continue;
    const side = ((h * 97) & 3);
    const w = side < 2 ? b.w : b.d;
    const d = side < 2 ? b.d : b.w;
    const x = side === 0 ? b.cx - w / 2 : side === 1 ? b.cx - w / 2 : b.x;
    const z = side === 0 ? b.z : side === 1 ? b.z + b.d - d : b.z;
    const x2 = side < 2 ? b.cx - w / 2 : b.x + (side === 3 ? 0 : b.w - d);
    const z2 = side < 2 ? b.z + (side === 0 ? 0 : b.d - d) : b.cz - d / 2;
    shopfronts.push({
      x: x2, z: z2, w, d,
      dir: side, tint: AWNING_TINTS[(h * 511) & 3],
      neon: h > 0.34 ? NEON_TINTS[(h * 911) & 3] : null,
    });
  }

  return { props, bays, lots, shopfronts };
}

function lotD(w) { return w; }

const CAR_TINTS = ['#b23b3b', '#3b62b2', '#c8c8cf', '#2f7a4f', '#8a6ec8', '#caa23b', '#7a4a2b'];
const AWNING_TINTS = ['#a83a3a', '#2f6b46', '#3f5f8f', '#8a6ec8'];
const NEON_TINTS = ['#ff5c8a', '#5cd6ff', '#ffd25c', '#8affa0'];

/** Tile type at integer tile coords; everything outside the grid is open water. */
export function tileType(city, tx, tz) {
  if (tx < 0 || tz < 0 || tx >= city.size || tz >= city.size) return T_WATER;
  return city.tiles[tz * city.size + tx];
}

/**
 * Ground class at a world point: 'road' | 'sidewalk' | 'lot' | 'water' | 'park' | 'quay'.
 * Traffic keeps to 'road', pedestrians to 'sidewalk', nothing may enter 'water'.
 */
export function roadAt(city, x, z) {
  const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
  switch (tileType(city, tx, tz)) {
    case T_ROAD: return 'road';
    case T_SIDEWALK: return 'sidewalk';
    case T_LOT: return 'lot';
    case T_PARK: return 'park';
    case T_QUAY: return 'quay';
    default: return 'water';
  }
}

/** True where wheels and feet may go: any tile that is not open water. */
export function isWalkable(city, x, z) {
  return roadAt(city, x, z) !== 'water';
}

/**
 * Traffic lanes: one entry per lane, { axis: 'x'|'z', at, from, to, dir }. Vertical boulevards
 * (axis 'z' means the car travels along z at world x = at) carry two lanes a tile apart, right-hand
 * traffic, clipped to the built streets before the quays. Session 2's trafficSpawnLane picks here.
 */
export function laneCenters(city) {
  const lanes = [];
  const fromTile = 4;
  const toTile = (BUILDABLE_BLOCKS * BLOCK_TILES) - 3;
  for (let b = 0; b <= BUILDABLE_BLOCKS; b += 1) {
    const road = b * BLOCK_TILES;
    const centre = (road + 0.5) * TILE; // northbound / westbound lane
    const offside = (road + 1.5) * TILE; // southbound / eastbound lane
    if (road < toTile) {
      lanes.push({ axis: 'z', at: centre, from: fromTile * TILE, to: toTile * TILE, dir: -1 });
      lanes.push({ axis: 'z', at: offside, from: fromTile * TILE, to: toTile * TILE, dir: 1 });
      lanes.push({ axis: 'x', at: centre, from: fromTile * TILE, to: toTile * TILE, dir: 1 });
      lanes.push({ axis: 'x', at: offside, from: fromTile * TILE, to: toTile * TILE, dir: -1 });
    }
  }
  return lanes;
}

/**
 * Colliders an AABB at (x, z, w, d) could touch. The grid is coarse (few hundred boxes) so a
 * distance pre-filter on centres keeps this cheap enough to call per actor per tick.
 */
export function collidersNear(city, x, z, w, d) {
  const out = [];
  const reach = Math.max(w, d) / 2 + 180;
  for (const c of city.colliders) {
    if (Math.abs(c.x + c.w / 2 - x - w / 2) > c.w / 2 + reach + w) continue;
    if (Math.abs(c.z + c.d / 2 - z - d / 2) > c.d / 2 + reach + d) continue;
    out.push(c);
  }
  return out;
}

/** True when a ground-plane box overlaps any building wall. */
export function boxHitsBuilding(city, x, z, w, d) {
  const box = { x, z, w, d };
  for (const c of collidersNear(city, x, z, w, d)) {
    if (aabbOverlap(box, c)) return c;
  }
  return null;
}
