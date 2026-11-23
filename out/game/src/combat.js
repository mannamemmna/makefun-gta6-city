// combat.js — the guns of Calvera Bay. spawnBullet mints a tracer with position, velocity and
// a ttl measured in seconds (not pixels: bullets die at their weapon's range), the per-tick
// update moves each one and tests hits against the player, pedestrians, officers and cars,
// heardShot is the report combat fires into police.js so every trigger pull raises the heat,
// and the renderer reads the muzzleFlash and sparks lists this module keeps for its effect
// layer. Deterministic throughout: the one rng here seeds spread, and nothing else is random.
import { Rng, clamp, dist2, wrapAngle, angleDelta } from './util.js';

const BULLET_SPEED = 620;
const MAX_BULLETS = 48;
const MAX_SPARKS = 40;

let nextBulletId = 1;

/** The combat system: createCombat() carries the bullets, sparks, flashes and one Rng. */
export function createCombat(seed = 20260) {
  return {
    rng: new Rng(seed),
    bullets: [], // {x,z,vx,vz,ttl,damage,fromPlayer,trail}
    sparks: [], // {x,z,y,ttl,color}
    muzzleFlashes: [], // {x,z,heading,ttl}
    lastHeardShotTick: -999,
    combatSeed: seed,
  };
}

/**
 * Fire one bullet toward a heading, with a seeded spread. shot = the descriptor issued by
 * player.js tryFireWeapon or police.js; onShot is the heardShot callback into police.js.
 * Returns the bullet, or null if the shot could not be made.
 */
export function spawnBullet(combat, shot, worldTick, onShot) {
  if (shot == null) return null;
  const spreadA = combat.rng.range(-1, 1) * (shot.spread ?? 0.03);
  const heading = wrapAngle(shot.heading + spreadA);
  const bullet = {
    id: nextBulletId++,
    x: shot.x, z: shot.z, y: shot.muzzleY ?? 9,
    vx: Math.sin(heading) * BULLET_SPEED,
    vz: Math.cos(heading) * BULLET_SPEED,
    ttl: (shot.range ?? 300) / BULLET_SPEED,
    damage: shot.damage ?? 10,
    heading,
    fromPlayer: shot.fromPlayer !== false,
    shooter: shot.shooter ?? null,
    hits: [],
  };
  if (combat.bullets.length < MAX_BULLETS) combat.bullets.push(bullet);
  // the muzzle flash the renderer paints: one bloom at the barrel, gone in three ticks
  combat.muzzleFlashes.push({ x: shot.x, z: shot.z, heading, ttl: 0.05 });
  if (combat.muzzleFlashes.length > 12) combat.muzzleFlashes.shift();
  // every trigger pull is a heardShot: someone nearby is dialling the precinct
  if (onShot) onShot(shot.x, shot.z, worldTick);
  combat.lastHeardShotTick = worldTick;
  return bullet;
}

/** heardShot wrapped for modules that only want the report, not the muzzle. */
export function heardShot(combat, x, z, worldTick, report) {
  combat.lastHeardShotTick = worldTick;
  if (report) report(x, z, worldTick);
}

/** A short-lived impact spark, used for wall hits, ricochets and bloodless ped tumbles. */
export function spawnSparks(combat, x, z, count, color = '#ffd27a', y = 8) {
  for (let i = 0; i < count && combat.sparks.length < MAX_SPARKS; i += 1) {
    const a = combat.rng.next() * Math.PI * 2;
    combat.sparks.push({
      x, z, y,
      vx: Math.sin(a) * combat.rng.range(20, 90),
      vz: Math.cos(a) * combat.rng.range(20, 90),
      ttl: combat.rng.range(0.12, 0.3),
      color,
    });
  }
}

/** Segment vs circle: has the bullet swept through a rider's (or car's) radius this tick? */
function bulletHitsCircle(bx, bz, px, pz, radius) {
  return dist2(bx, bz, px, pz) < radius * radius;
}

/**
 * One tick of every bullet: advance by velocity*dt, expire by ttl, and test the sweep against
 * the world's hittables the caller registers via the pools object —
 *   pools = { player, peds, officers, cars, damagePlayer, runOverPunctual... }
 * A pedestrian or officer struck takes damage or falls; a car takes body damage; the player
 * takes routed damage; fromPlayer shots never hurt the hero, cop shots never hurt cops.
 */
export function updateBullets(combat, pools, dt, worldTick) {
  const alive = [];
  for (const bullet of combat.bullets) {
    bullet.ttl -= dt;
    if (bullet.ttl <= 0) { spawnSparks(combat, bullet.x, bullet.z, 1, '#8a8f99', 6); continue; }
    const nx = bullet.x + bullet.vx * dt;
    const nz = bullet.z + bullet.vz * dt;
    let consumed = false;

    // ---- the hero
    if (!bullet.fromPlayer && pools.player && !pools.player.wastedState && !pools.player.bustedState) {
      const p = pools.player;
      const hitCar = p.inCar && bulletHitsCircle(nx, nz, p.inCar.x, p.inCar.z, p.inCar.l * 0.45);
      if (hitCar) {
        pools.damageCar ? pools.damageCar(p.inCar, bullet.damage * 0.8) : null;
        spawnSparks(combat, nx, nz, 3, '#ffca6a', 10);
        consumed = true;
      } else if (bulletHitsCircle(nx, nz, p.x, p.z, 7)) {
        pools.damagePlayer(bullet.damage);
        spawnSparks(combat, nx, nz, 3, '#c94f4f', 10);
        consumed = true;
      }
    }

    // ---- officers (only from the player's own gun)
    if (!consumed && bullet.fromPlayer && pools.officers) {
      for (const officer of pools.officers) {
        if (officer.state === 'gone' || officer.health <= 0) continue;
        if (bulletHitsCircle(nx, nz, officer.x, officer.z, 7)) {
          pools.damageOfficer(officer, bullet.damage);
          spawnSparks(combat, nx, nz, 2, '#c94f4f', 10);
          consumed = true;
          break;
        }
      }
    }

    // ---- civilians
    if (!consumed && pools.pedList) {
      for (const ped of pools.pedList) {
        if (ped.state === 'flat' || ped.state === 'gone') continue;
        if (bulletHitsCircle(nx, nz, ped.x, ped.z, 6)) {
          pools.hitPed(ped, bullet.damage);
          spawnSparks(combat, nx, nz, 2, '#c94f4f', 9);
          consumed = true;
          break;
        }
      }
    }

    // ---- cars
    if (!consumed && pools.cars) {
      for (const car of pools.cars) {
        if (car.dead) continue;
        if (bulletHitsCircle(nx, nz, car.x, car.z, car.l * 0.45)) {
          if (pools.damageCar) pools.damageCar(car, bullet.damage * 0.55);
          spawnSparks(combat, nx, nz, 2, '#ffca6a', 9);
          consumed = true;
          break;
        }
      }
    }

    if (!consumed && pools.wallBlocks && pools.wallBlocks(nx, nz)) {
      spawnSparks(combat, nx, nz, 2, '#c8ccd6', 8); // the wall wins
      consumed = true;
    }
    if (!consumed) {
      bullet.x = nx;
      bullet.z = nz;
      alive.push(bullet);
    }
  }
  combat.bullets = alive;
  // spark and flash decay
  const sparks = [];
  for (const s of combat.sparks) {
    s.ttl -= dt;
    if (s.ttl > 0) { s.x += s.vx * dt; s.z += s.vz * dt; s.y += 30 * dt; sparks.push(s); }
  }
  combat.sparks = sparks;
  combat.muzzleFlashes = combat.muzzleFlashes.filter((f) => (f.ttl -= dt) > 0);
}

/**
 * The whole combat subsystem per tick: drain any shots the police queued (wantShoot),
 * integrate the bullets, expire the effects. main.js passes the pools + hooks.
 */
export function updateCombat(combat, pools, dt, worldTick) {
  if (pools.police && pools.police.wantShoot) {
    for (const shot of pools.police.wantShoot) spawnBullet(combat, shot, worldTick, pools.onShotFromCop);
    pools.police.wantShoot.length = 0;
  }
  if (pools.playerShot) {
    spawnBullet(combat, pools.playerShot, worldTick, pools.onShotFromPlayer ?? pools.onShot);
    pools.playerShot = null;
  }
  updateBullets(combat, pools, dt, worldTick);
}

/** Draw-list contribution: tracers as brief line segments the renderer walks to draw. */
export function bulletTracers(combat) {
  // each bullet's tail: a point back along its heading for a streak ~30 units long
  return combat.bullets.map((b) => ({
    x: b.x, z: b.z, y: b.y,
    tailX: b.x - Math.sin(b.heading) * 26,
    tailZ: b.z - Math.cos(b.heading) * 26,
  }));
}
