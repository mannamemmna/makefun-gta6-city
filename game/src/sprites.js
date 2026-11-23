// sprites.js — the shared paint functions for every moving thing in the city: pedestrians,
// officers, the player on foot, cars of every kind (with the police light bar strobing red and
// blue every six ticks), wreck flames, bullet tracers, muzzle flashes and sparks. Every painter
// here takes (ctx, p) where p is the projected point from render.js projectTo, so main.js only
// has to hand each actor an x/z and one of these closures. Painters draw in plain screen space;
// the world is a hand-drawn map, so these are bold simple shapes with strong outlines.
import { shadeHex, blendHex, clamp } from './util.js';
import { PALETTE } from './config.js';

/** The standing silhouette every walker shares: shirt block, head dot, a stride bob. */
function paintWalkerBody(ctx, p, sx, sy, scale, look, heading, phase, flat, armsUp, tint) {
  const s = scale;
  const k = Math.sin(phase * Math.PI / 32) * 1.6 * s * 0.4;
  if (flat) {
    // knocked flat: a lying silhouette with a shallower head
    const dirX = Math.sin(heading) * 7 * s, dirZ = platformHorizonLift(s);
    ctx.fillStyle = look.pants;
    ctx.fillRect(sx - 5 * s, sy - 2 * s, 14 * s, 2.4 * s);
    ctx.fillStyle = look.skin;
    ctx.fillRect(sx - 5 * s + dirX, sy - 2 * s - dirZ, 3.6 * s, 3 * s);
    return;
  }
  // legs
  ctx.fillStyle = look.pants;
  ctx.fillRect(sx - 2.1 * s, sy - 8 * s, 1.7 * s, 8 * s + k);
  ctx.fillRect(sx + 0.5 * s, sy - 8 * s, 1.7 * s, 8 * s - k);
  // torso
  ctx.fillStyle = tint ?? look.shirt;
  ctx.fillRect(sx - 2.6 * s, sy - 16 * s, 5.2 * s, 8.5 * s);
  // arms: down at the sides, or thrown up when panicking
  ctx.fillStyle = tint ?? look.shirt;
  if (armsUp) {
    ctx.fillRect(sx - 4.6 * s, sy - 21.5 * s, 1.8 * s, 6 * s);
    ctx.fillRect(sx + 2.8 * s, sy - 21.5 * s, 1.8 * s, 6 * s);
    ctx.fillStyle = look.skin;
    ctx.fillRect(sx - 4.6 * s, sy - 24 * s, 1.8 * s, 2.4 * s);
    ctx.fillRect(sx + 2.8 * s, sy - 24 * s, 1.8 * s, 2.4 * s);
  } else {
    ctx.fillStyle = look.skin;
    ctx.fillRect(sx - 4.2 * s, sy - 15 * s + k * 0.6, 1.6 * s, 5.5 * s);
    ctx.fillRect(sx + 2.6 * s, sy - 15 * s - k * 0.6, 1.6 * s, 5.5 * s);
  }
  // head
  ctx.fillStyle = look.skin;
  ctx.fillRect(sx - 1.8 * s, sy - 20.5 * s, 3.6 * s, 4.2 * s);
}

function platformHorizonLift(s) { return 1.4 * s; }

/** A pedestrian painter closure: paint(ctx, p) with scale and world time baked in. */
export function paintPedestrian(ped, world, ambient) {
  const ink = ambientShade(ambient);
  return (ctx, p) => {
    if (!p.visible) return;
    const s = 1.15;
    const x = p.sx, y = p.sy;
    if (ped.state === 'flat' && ped.flatTimer > 10) return; // long-gone bodies vanish
    const dark = 1 - 0.45 * (1 - ambient);
    paintWalkerBody(ctx, p, x, y, s, ped.look, ped.heading, ped.bob,
      ped.state === 'flat', ped.state === 'panic', undefined);
  };
}

/** An officer: navy shirt, flat cap, a gun hand raised when firing. */
export function paintOfficer(officer, world, ambient) {
  return (ctx, p) => {
    if (!p.visible) return;
    const s = 1.2;
    paintWalkerBody(ctx, p, p.sx, p.sy, s, officer.look, officer.heading, officer.bob,
      false, false, shadeHex(officer.look.shirt, 0.85));
    // the cap
    ctx.fillStyle = '#1c2333';
    ctx.fillRect(p.sx - 2.1 * s, p.sy - 22.6 * s, 4.2 * s, 1.5 * s);
    ctx.fillRect(p.sx - 2.6 * s, p.sy - 21.6 * s, 5.2 * s, 0.8 * s);
    // pistol hand when the burst flag is fresh
    if (officer.burst > 0) {
      officer.burst -= 0.25;
      ctx.fillStyle = '#11141c';
      ctx.fillRect(p.sx + 2.2 * s, p.sy - 15.4 * s, 3.4 * s, 1.1 * s);
    }
  };
}

/** The hero: a white tee that stays readable at any hour, arms up when fleeing gunfire. */
export function paintPlayer(player) {
  const look = { shirt: '#e8e2d2', pants: '#31415f', skin: '#d9a184' };
  return (ctx, p) => {
    if (!p.visible) return;
    const s = 1.25;
    paintWalkerBody(ctx, p, p.sx, p.sy, s, look, player.heading, player.bob,
      false, false, undefined);
    // hair
    ctx.fillStyle = '#2c2117';
    ctx.fillRect(p.sx - 1.9 * s, p.sy - 21.9 * s, 3.8 * s, 1.8 * s);
  };
}

// ---------------------------------------------------------------- cars
/**
 * One car body in screen space: the roof plane skewed by the heading (a parallelogram that
 * reads as a 3/4 view whichever way the street runs), plus windshield, wheels and — for
 * cruisers — the strobing light bar: lightPhase 0..5 red on the left, 6..11 blue.
 */
export function paintCar(car, world, ambient) {
  const lit = ambientShade(ambient);
  return (ctx, p) => {
    if (!p.visible) return;
    const s = 1.0;
    const cos = Math.cos(car.heading), sin = Math.sin(car.heading);
    // ground shadow: car footprint skewed along the heading
    const gx = -sin * car.l * 0.5, gz = cos * car.l * 0.5; // heading-forward half-extent in xz
    const intoScreen = (dx, dz) => ({ // rotate world offset into screen axes like projectTo
      rx: dx * Math.cos(0.60) - dz * Math.sin(0.60),
      depth: dz * Math.cos(0.60) + dx * Math.sin(0.60),
    });
    // body: draw as a box around the projected centre; wide axis follows the car's cross axis
    const halfL = (car.l * 1.45) * 0.5 * s;
    const bodyW = car.w * 1.55 * s;
    ctx.save();
    ctx.translate(p.sx, p.sy);
    // rough screen rotation: full turn only reads in yaw; approximate with heading directly
    ctx.rotate(-car.heading * 0.55);
    // shadow
    ctx.fillStyle = 'rgba(10,12,16,0.4)';
    ctx.fillRect(-halfL, -1.2 * s, halfL * 2, bodyW * 0.42);
    // wheels
    ctx.fillStyle = '#15171c';
    ctx.fillRect(-halfL * 0.72, -bodyW * 0.52, 4.4 * s, 2.2 * s);
    ctx.fillRect(-halfL * 0.72, bodyW * 0.52 - 2.2 * s, 4.4 * s, 2.2 * s);
    ctx.fillRect(halfL * 0.52, -bodyW * 0.52, 4.4 * s, 2.2 * s);
    ctx.fillRect(halfL * 0.52, bodyW * 0.52 - 2.2 * s, 4.4 * s, 2.2 * s);
    // body slab
    const bodyCol = car.dead ? shadeHex(car.body, 0.28) : shadeHex(car.body, lit);
    ctx.fillStyle = bodyCol;
    ctx.fillRect(-halfL, -bodyW * 0.42, halfL * 2, bodyW * 0.84);
    // roof + cabin
    const roofY = -car.h * 0.62 * s;
    ctx.fillStyle = car.dead ? '#232220' : shadeHex(car.roof, lit);
    ctx.fillRect(-halfL * 0.52, -bodyW * 0.34, halfL * 1.04, bodyW * 0.68);
    // windshield glint
    ctx.fillStyle = car.dead ? '#3a3a36' : shadeHex('#a8c4d6', lit);
    ctx.fillRect(halfL * 0.52 - 3.2 * s, -bodyW * 0.30, 3.2 * s, bodyW * 0.60);
    // police livery: dark doors band with a shield
    if (car.spec.police && !car.dead) {
      ctx.fillStyle = '#22262e';
      ctx.fillRect(-halfL, -bodyW * 0.42, halfL * 2, bodyW * 0.84 * 0.28);
      ctx.fillStyle = PALETTE.policeBlue;
      ctx.fillRect(-halfL * 0.3, -bodyW * 0.18, halfL * 0.6, bodyW * 0.36);
    }
    // pickup: an open bed; van: a taller box with a high roofline
    if (car.spec.bed && !car.dead) {
      ctx.fillStyle = shadeHex(car.body, lit * 0.72);
      ctx.fillRect(-halfL, -bodyW * 0.36, halfL * 0.5, bodyW * 0.72);
    }
    if (car.spec.tall && !car.dead) {
      ctx.fillStyle = car.body === '#d8d5cb' ? '#e9e6dd' : shadeHex(car.body, lit * 1.04);
      ctx.fillRect(-halfL * 0.78, -bodyW * 0.3, halfL * 1.32, bodyW * 0.6);
    }
    // THE LIGHT BAR: red left 6 ticks, blue right 6 ticks, alternating — the money shot
    if (car.spec.lightbar && car.sirenOn) {
      const blue = car.lightPhase >= 6;
      // wide pooled glow: at thumbnail scale the chase is a street washed in red/blue
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = blue ? '#2f5fff' : '#ff3049';
      ctx.beginPath();
      ctx.ellipse(0, 2 * s, halfL * 1.6, bodyW * 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = blue ? '#6f8fff' : '#ff6b78';
      ctx.beginPath();
      ctx.ellipse(0, 2 * s, halfL * 3.2, bodyW * 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      const bulbH = 4.2 * s; // the bulbs themselves: oversized so they survive shrinking
      ctx.fillStyle = blue ? '#5588ff' : '#ff5a66';
      ctx.fillRect(-3.4 * s, -bodyW * 0.24 - car.h * 0.66 * s, 3 * s, bulbH);
      ctx.fillStyle = blue ? '#ff3049' : '#2f5fff';
      ctx.fillRect(0.6 * s, -bodyW * 0.24 - car.h * 0.66 * s, 3 * s, bulbH);
      // mirrored twin bars: a police light bar is read from its reflection lane
      ctx.fillStyle = blue ? '#2f5fff' : '#ff3049';
      ctx.fillRect(-3.4 * s, -bodyW * 0.24 - car.h * 0.66 * s - bulbH * 0.35, 3 * s, bulbH * 0.4);
      ctx.fillStyle = blue ? '#ff3049' : '#2f5fff';
      ctx.fillRect(0.6 * s, -bodyW * 0.24 - car.h * 0.66 * s - bulbH * 0.35, 3 * s, bulbH * 0.4);
    }
    ctx.restore();
    // damage smoke and the wreck fireball
    if (car.dead) {
      paintWreckFlames(ctx, p, car, s);
    } else if (car.smoke > 0) {
      ctx.fillStyle = `rgba(60,64,70,${0.16 + 0.2 * car.smoke})`;
      ctx.beginPath();
      ctx.arc(p.sx - halfL * 0.3, p.sy - car.h * 0.9 * s, (3 + 8 * car.smoke) * s, 0, Math.PI * 2);
      ctx.fill();
    }
  };
}

/** The burn overlay for an exploded car: a three-lobed flame in the wreck's first seconds. */
export function paintWreckFlames(ctx, p, car, s) {
  const age = car.burn ?? 0;
  if (age > 6) return; // the fire burns out; the charred hulk stays
  const fade = clamp(1 - age / 6, 0, 1);
  for (let i = 0; i < 3; i += 1) {
    const fx = p.sx + (i - 1) * 7 * s;
    const h = (16 + i * 5) * s * fade * (age < 0.6 ? 1.3 : 1);
    ctx.fillStyle = i === 1 ? 'rgba(255,168,54,' + (0.85 * fade) + ')' : 'rgba(255,96,40,' + (0.7 * fade) + ')';
    ctx.beginPath();
    ctx.moveTo(fx - 4 * s, p.sy - 4 * s);
    ctx.quadraticCurveTo(fx, p.sy - 4 * s - h, fx + 4 * s, p.sy - 4 * s);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(40,38,34,0.5)';
  ctx.beginPath();
  ctx.arc(p.sx, p.sy - 9 * s, 9 * s * fade, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------- effects
/** A tracer: a bright head with a fading tail streaking back along the bullet's path. */
export function paintTracer(tracer) {
  return (ctx, p) => {
    if (!p.visible) return;
    const t = { sx: 0, sy: 0 };
    // the tail projects by offsetting in screen space along the heading's 2D direction
    const dx = (tracer.tailX - tracer.x), dz = (tracer.tailZ - tracer.z);
    const m = 6.2; // screen-units-per-world approx at zoom 1; close enough for a streak
    const tx = p.sx + dx * m, ty = p.sy + dz * m * 0.55 - 5;
    const grad = ctx.createLinearGradient(p.sx, p.sy - 5, tx, ty);
    grad.addColorStop(0, 'rgba(255,232,170,0.95)');
    grad.addColorStop(1, 'rgba(255,232,170,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(p.sx, p.sy - 5);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  };
}

/** The muzzle flash: a warm four-point bloom, alive for its 0.05s ttl. */
export function paintMuzzleFlash(flash) {
  return (ctx, p) => {
    if (!p.visible) return;
    ctx.fillStyle = 'rgba(255,224,150,0.9)';
    ctx.beginPath();
    ctx.arc(p.sx, p.sy - 6, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,180,80,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.sx, p.sy - 6);
    ctx.lineTo(p.sx + Math.sin(flash.heading) * 9, p.sy - 6 + Math.cos(flash.heading) * 5);
    ctx.stroke();
  };
}

/** One spark: a tiny dot arcing upward, fading with its ttl. */
export function paintSpark(spark) {
  const c = spark.color.startsWith('rgba') ? spark.color : spark.color;
  return (ctx, p) => {
    if (!p.visible) return;
    ctx.globalAlpha = clamp(spark.ttl * 4, 0, 1);
    ctx.fillStyle = spark.color;
    ctx.fillRect(p.sx - 1, p.sy - spark.y * 0.4, 2, 2);
    ctx.globalAlpha = 1;
  };
}

/** Ambient light level 0..1 -> brightness multiplier for painted actors. */
function ambientShade(ambient) {
  return 0.62 + 0.38 * clamp(ambient, 0, 1);
}
