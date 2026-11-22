// render.js — the Canvas 2D painter, ground-up deterministic. The projection is a yaw rotation
// plus a pitch shear (no 3D matrices): sx = W/2 + (dx*cos - dz*sin)*scale, a point's height lifts
// it by y*pitchScale, and depth = dz*cos + dx*sin drives painter-order sorting, far first. One
// frame draws the sky gradient and sun or moon, the distant skyline, the sea with shimmer, the
// ground as depth-ordered tile runs, every visible building with front faces, roof and lit
// window grids, palms and street lamps, then any actors the scene hands it, then the night
// vignette. projectTo(x, y, z) is exposed on the renderer so staging can pin a name to an exact
// pixel, and fillMinimap paints the whole island legibly at 200 px.
import { TILE, WATER_START, PALETTE, CAMERA, VIEW, MINIMAP } from './config.js';
import { T_ROAD, T_SIDEWALK, T_LOT, T_WATER, T_PARK, T_QUAY, tileType } from './city.js';
import { lerp, clamp, hash2, shadeHex, blendHex, smoothstep } from './util.js';
import {
  ambientLevel, lightsAreOn, windowLitFraction, sunPosition, skyGradient, tintForTime,
} from './world.js';

const GROUND_COLORS = {
  [T_ROAD]: PALETTE.asphalt,
  [T_SIDEWALK]: PALETTE.sidewalk,
  [T_LOT]: PALETTE.lotDark,
  [T_WATER]: PALETTE.water,
  [T_PARK]: PALETTE.park,
  [T_QUAY]: PALETTE.quay,
};

/** The one projection. Pure math: a camera object {x,z,yaw,scale,zoom,pitchShear,pitchScale,horizon}. */
export function projectTo(cam, x, y, z, viewW = VIEW.width, viewH = VIEW.height) {
  const dx = x - cam.x;
  const dz = z - cam.z;
  const cos = Math.cos(cam.yaw);
  const sin = Math.sin(cam.yaw);
  const rx = dx * cos - dz * sin; // across the screen
  const depth = dz * cos + dx * sin; // toward the viewer
  const scale = cam.scale * cam.zoom;
  const sx = viewW / 2 + rx * scale;
  const sy = viewH * cam.horizon + depth * scale * cam.pitchShear - y * scale * cam.pitchScale;
  return { sx, sy, depth, visible: sx > -220 && sx < viewW + 220 && sy < viewH + 320 && sy > -420 };
}

export function createCamera(x, z) {
  return {
    x, z,
    yaw: CAMERA.yaw,
    pitchShear: CAMERA.pitchShear,
    pitchScale: CAMERA.pitchScale,
    scale: CAMERA.scale,
    zoom: CAMERA.zoom,
    horizon: CAMERA.horizon,
    targetX: x,
    targetZ: z,
    focus: null, // cameraFocusOn locks the view to an actor; staging sets this
    heading: 0,
  };
}

/** Pin the view onto an actor at once (a cutscene lock or the very first frame). */
export function cameraFocusOn(cam, actor) {
  cam.focus = actor;
  cam.x = actor.x;
  cam.z = actor.z;
}

/** Release the lock; the camera then follows whatever targetX/targetZ staging keeps fresh. */
export function cameraRelease(cam) {
  cam.focus = null;
}

/** One frame of smooth follow: ease toward the focus (or targetX/targetZ when released). */
export function updateCameraFollow(cam, dt, rate = CAMERA.followLerp) {
  const tx = cam.focus ? cam.focus.x : cam.targetX;
  const tz = cam.focus ? cam.focus.z : cam.targetZ;
  const t = 1 - Math.exp(-rate * dt);
  cam.x = lerp(cam.x, tx, t);
  cam.z = lerp(cam.z, tz, t);
}

/** Zoom for cutscene close-ups, clamped to the tuned range. */
export function setCameraZoom(cam, zoom) {
  cam.zoom = clamp(zoom, CAMERA.minZoom, CAMERA.maxZoom);
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const view = { w: VIEW.width, h: VIEW.height, dpr: 1 };
  let city = null;
  let cam = null;

  function resize() {
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
  }
  resize();

  // ---------------------------------------------------------------- sky
  function drawSkyGradient(world, sky) {
    const horizonY = view.h * cam.horizon;
    const grad = ctx.createLinearGradient(0, 0, 0, horizonY + 2);
    grad.addColorStop(0, sky.zenith);
    grad.addColorStop(0.58, sky.mid);
    grad.addColorStop(1, sky.horizon);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, view.w, horizonY + 2);
  }

  function drawSunAndMoon(world, sky) {
    const sun = sunPosition(world, cam.horizon, view.h);
    const r = sun.isSun ? 24 + 9 * (1 - Math.max(0, sun.elevation)) : 17;
    const glow = ctx.createRadialGradient(sun.x, sun.y, 2, sun.x, sun.y, r * 5);
    glow.addColorStop(0, sky.orb);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = glow;
    ctx.fillRect(sun.x - r * 5, sun.y - r * 5, r * 10, r * 10);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(sun.x, sun.y, r, 0, Math.PI * 2);
    ctx.fillStyle = sky.orb;
    ctx.fill();
  }

  /** Hashed tower silhouettes on the horizon, two haze layers deep, drifting with the camera. */
  function drawDistantSkyline(sky) {
    const base = view.h * cam.horizon + 1;
    const drift = (cam.x * Math.cos(cam.yaw) - cam.z * Math.sin(cam.yaw)) * 0.06;
    const layers = [
      { alpha: 1, hMax: 26, tint: blendHex(sky.haze, sky.zenith, 0.45), gap: 46 },
      { alpha: 1, hMax: 58, tint: blendHex(sky.haze, sky.zenith, 0.15), gap: 62 },
    ];
    for (const layer of layers) {
      ctx.fillStyle = layer.tint;
      for (let i = -6; i < 52; i += 1) {
        const h = 10 + hash2(i * 17 + Math.floor(drift / layer.gap), i * 3 + 1, 5) * layer.hMax;
        const w = 20 + hash2(i, 9, 5) * 40;
        let sx = i * layer.gap - (drift % layer.gap);
        sx = ((sx % (view.w + 200)) + view.w + 200) % (view.w + 200) - 100;
        ctx.fillRect(sx, base - h, w, h + 1);
      }
    }
  }

  // ---------------------------------------------------------------- sea
  /** The water band beyond the quays: sea fill under the ground pass, shimmer lines on top. */
  function drawWaterAndShimmer(world, sky) {
    const horizonY = view.h * cam.horizon;
    const scale = cam.scale * cam.zoom;
    const grad = ctx.createLinearGradient(0, horizonY, 0, view.h);
    grad.addColorStop(0, blendHex(tintForTime(PALETTE.water, world), sky.horizon, 0.22));
    grad.addColorStop(1, tintForTime(PALETTE.waterDeep, world));
    ctx.fillStyle = grad;
    ctx.fillRect(0, horizonY, view.w, view.h - horizonY);

    const phase0 = world.time * 0.012;
    ctx.lineWidth = 1.4;
    for (let row = 0; row < 18; row += 1) {
      const depth = 30 + row * row * 1.9 + row * 20;
      const y = horizonY + depth * scale * cam.pitchShear;
      if (y > view.h) break;
      const phase = hash2(row, 3, 7) * 6.28 + phase0 + row * 0.35;
      ctx.strokeStyle = sky.horizon;
      ctx.globalAlpha = 0.20 - row * 0.008;
      ctx.beginPath();
      for (let sx = -20; sx <= view.w + 20; sx += 70) {
        const yy = y + Math.sin(sx * 0.010 + phase) * (2 + row * 0.28);
        if (sx === -20) ctx.moveTo(sx, yy);
        else ctx.lineTo(sx, yy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- ground
  /**
   * Depth-ordered tile runs. For each tile row (constant tz, one shared depth across the row)
   * we merge neighbouring tiles of the same type into a single quad, so a whole block face is
   * one fill. Rows sort far-to-near by depth; that is the painter order for the ground.
   */
  function drawGroundTiles(world) {
    const scale = cam.scale * cam.zoom;
    const shear = cam.pitchShear;
    const horizonY = view.h * cam.horizon;
    const cos = Math.cos(cam.yaw);
    const sin = Math.sin(cam.yaw);
    const halfW = (view.w / 2) / scale + TILE * 2;
    // how far (world units) the camera can see between the horizon and the bottom edge
    const depthMax = (view.h - horizonY + 40) / (shear * scale);
    const camTX = cam.x / TILE;
    const camTZ = cam.z / TILE;
    const reachT = Math.ceil(halfW / TILE) + Math.ceil(depthMax / TILE) + 6;

    const amb = ambientLevel(world);
    const rows = [];
    for (let dt = -reachT; dt <= reachT; dt += 1) {
      // rows at constant rotated depth: walk out in world z and read the row's true depth
      const tz = camTZ + dt;
      if (tz < -40 || tz > city.size + 40) continue;
      const dz = tz * TILE - cam.z;
      const depth = dz * cos;
      if (depth < -depthMax * 0.55 || depth > depthMax) continue;
      rows.push({ tz: Math.floor(tz), depth });
    }
    rows.sort((a, b) => a.depth - b.depth);

    for (const row of rows) {
      const tz = row.tz;
      // which tx can land on screen: solve the rotated x band, then pad it
      let txMin = 1 << 30;
      let txMax = -(1 << 30);
      for (let zz = tz; zz <= tz + 1; zz += 0.5) {
        const dz = zz * TILE - cam.z;
        const rxNeeded = halfW;
        // dx*cos - dz*sin in [-rxNeeded, rxNeeded] bounds dx
        const lo = (-rxNeeded + dz * sin) / cos;
        const hi = (rxNeeded + dz * sin) / cos;
        const t0 = Math.floor(lo / TILE) - 1;
        const t1 = Math.ceil(hi / TILE) + 1;
        if (t0 < txMin) txMin = t0;
        if (t1 > txMax) txMax = t1;
      }
      txMin = Math.max(txMin, -1);
      txMax = Math.min(txMax, city.size);
      let runType = -1;
      let runStart = -1;
      const flush = (endTx) => {
        if (runType < 0 || runStart >= endTx) return;
        paintGroundRun(runStart, endTx, tz, runType, amb);
        runType = -1;
      };
      for (let tx = txMin; tx <= txMax + 1; tx += 1) {
        const type = tx < 0 || tx >= city.size ? T_WATER : tileType(city, tx, tz);
        if (type === runType) continue;
        flush(tx);
        runType = type;
        runStart = tx;
      }
      flush(txMax + 1);
    }
  }

  function paintGroundRun(tx0, tx1, tz, type, amb) {
    const x0 = tx0 * TILE;
    const x1 = tx1 * TILE;
    const z0 = tz * TILE;
    const z1 = (tz + 1) * TILE;
    const a = projectTo(cam, x0, 0, z0, view.w, view.h);
    const b = projectTo(cam, x1, 0, z0, view.w, view.h);
    const c = projectTo(cam, x1, 0, z1, view.w, view.h);
    const d = projectTo(cam, x0, 0, z1, view.w, view.h);
    if (a.sy < -60 && b.sy < -60) return;
    if (a.sy > view.h && c.sy > view.h) return;
    let col = GROUND_COLORS[type];
    if (type === T_ROAD) {
      col = (tx0 + tz) % 11 === 0 ? PALETTE.asphaltWorn : PALETTE.asphalt;
    }
    ctx.fillStyle = shadeHex(col, 0.5 + 0.5 * amb);
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.lineTo(c.sx, c.sy);
    ctx.lineTo(d.sx, d.sy);
    ctx.closePath();
    ctx.fill();
  }

  /** The boulevards' centre dashes, one pass over every boulevard mid-line, far to near. */
  function drawLaneMarks(world) {
    const amb = ambientLevel(world);
    ctx.strokeStyle = shadeHex(PALETTE.laneMark, 0.45 + 0.55 * amb);
    ctx.lineWidth = 1.6;
    ctx.setLineDash([9, 13]);
    for (let b = 0; b <= 28; b += 1) {
      const mid = (b * 8 + 1) * TILE; // the seam between a boulevard's two tiles
      const end = WATER_START * TILE - TILE;
      const p0 = projectTo(cam, mid, 0, 0, view.w, view.h);
      const p1 = projectTo(cam, mid, 0, end, view.w, view.h);
      if (p1.sy - p0.sy > 1) {
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.stroke();
      }
      const q0 = projectTo(cam, 0, 0, mid, view.w, view.h);
      const q1 = projectTo(cam, end, 0, mid, view.w, view.h);
      if (q1.sx - q0.sx > 1) {
        ctx.beginPath();
        ctx.moveTo(q0.sx, q0.sy);
        ctx.lineTo(q1.sx, q1.sy);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  // ---------------------------------------------------------------- buildings
  /**
   * Every visible building: the two faces the yaw leaves fronting the camera, then the roof, all
   * from one box. Windows are a grid interpolated across the front face, lit by the game clock.
   * Improved detail: buildings near the camera get roof top-lines and AC boxes.
   */
  function drawBuildings(world) {
    const scale = cam.scale * cam.zoom;
    const depthMax = ((view.h - view.h * cam.horizon) + 60) / (cam.pitchShear * scale);
    const halfW = (view.w / 2) / scale;
    const cos = Math.cos(cam.yaw);
    const sin = Math.sin(cam.yaw);
    const amb = ambientLevel(world);

    const visible = [];
    for (const b of city.buildings) {
      const cxw = b.cx - cam.x;
      const czw = b.cz - cam.z;
      const depth = czw * cos + cxw * sin;
      if (depth < -160 || depth > depthMax + b.d) continue;
      const rx = cxw * cos - czw * sin;
      if (Math.abs(rx) > halfW + b.w + b.d + 80) continue;
      visible.push({ b, depth });
    }
    visible.sort((p, q) => p.depth - q.depth);

    // The sun's ground bearing at this hour, for deciding which walls it grazes.
    const sunGroundX = Math.cos(world.sunAz) * Math.max(world.sunElev, 0);
    const sunGroundZ = Math.sin(world.sunAz) * Math.max(world.sunElev, 0);

    for (const { b } of visible) {
      const corners = boxCorners(b);
      const faces = [];
      // the two walls the yaw leaves fronting the camera: south or north, east or west
      if (sin >= 0) faces.push(faceFromEdge(corners.sw, corners.se, b.h, 0, 1));
      else faces.push(faceFromEdge(corners.nw, corners.ne, b.h, 0, -1));
      if (cos >= 0) faces.push(faceFromEdge(corners.se, corners.ne, b.h, 1, 0));
      else faces.push(faceFromEdge(corners.sw, corners.nw, b.h, -1, 0));

      for (const f of faces) {
        const nx = f.nx, nz = f.nz;
        const sunOn = 0.5 + 0.5 * (nx * sunGroundX + nz * sunGroundZ) * 1.6; // 0..1 wall light
        const bodyTint = tintForTime(b.tint, world);
        ctx.fillStyle = shadeHex(bodyTint, (0.42 + 0.58 * amb) * (0.78 + 0.24 * sunOn));
        drawQuad(f.p0, f.p1, f.p2, f.p3);
        drawWindowGrid(world, f, b, amb);
      }

      // roof
      const r0 = projectTo(cam, b.x, b.h, b.z, view.w, view.h);
      const r1 = projectTo(cam, b.x + b.w, b.h, b.z, view.w, view.h);
      const r2 = projectTo(cam, b.x + b.w, b.h, b.z + b.d, view.w, view.h);
      const r3 = projectTo(cam, b.x, b.h, b.z + b.d, view.w, view.h);
      const roofCol = b.style === 'tower' ? PALETTE.roofTower : PALETTE.roofTint;
      ctx.fillStyle = shadeHex(roofCol, 0.5 + 0.5 * amb);
      drawQuad(r0, r1, r2, r3);
      if (b.style === 'tower' && b.h > 120) {
        // a rooftop slab edge: reads as a parapet at small scale
        ctx.fillStyle = shadeHex(bodyTint, 0.3 + 0.4 * amb);
        ctx.fillRect(r3.sx, r3.sy - 2.4, r2.sx - r3.sx + 2, 2.4);
      } else {
        // low buildings get a hashed rooftop AC box for texture
        const u = hash2(b.cx | 0, b.cz | 0, 3);
        if (b.w > 40 && u > 0.4) {
          const bx = lerp(0.2, 0.6, u);
          const p = projectTo(cam, b.x + b.w * bx, b.h + 3, b.z + b.d * bx, view.w, view.h);
          ctx.fillStyle = shadeHex(PALETTE.roofTint, 0.35 + 0.45 * amb);
          ctx.fillRect(p.sx - 4, p.sy - 3, 8, 4);
        }
      }
      if (b.name) drawLandmarkSign(b, world, amb);
    }
  }

  function boxCorners(b) {
    return {
      sw: { x: b.x, z: b.z + b.d },
      se: { x: b.x + b.w, z: b.z + b.d },
      nw: { x: b.x, z: b.z },
      ne: { x: b.x + b.w, z: b.z },
    };
  }

  /** The quad for one wall: two ground corners swept up to height h. nx/nz is its outward normal. */
  function faceFromEdge(c0, c1, h, nx, nz) {
    const g0 = projectTo(cam, c0.x, 0, c0.z, view.w, view.h);
    const g1 = projectTo(cam, c1.x, 0, c1.z, view.w, view.h);
    const t0 = projectTo(cam, c0.x, h, c0.z, view.w, view.h);
    const t1 = projectTo(cam, c1.x, h, c1.z, view.w, view.h);
    return { p0: g0, p1: g1, p2: t1, p3: t0, depth: g0.depth, nx, nz };
  }

  function drawQuad(a, b, c, d) {
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.lineTo(c.sx, c.sy);
    ctx.lineTo(d.sx, d.sy);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * The window grid on one wall: rows and columns interpolated along the wall's screen quad, each
   * pane lit or dark from the pane's own hash and the game clock's windowLitFraction.
   */
  function drawWindowGrid(world, face, b, amb) {
    const wallW = Math.hypot(face.p1.sx - face.p0.sx, face.p1.sy - face.p0.sy);
    const wallH = face.p0.sy - face.p3.sy; // ground-to-roof on screen
    if (wallW < 10 || wallH < 10) return;
    const cols = Math.max(1, Math.min(12, Math.floor(wallW / 7)));
    const rowsN = Math.max(1, Math.min(Math.floor(wallH / 8), 34));
    const litFrac = windowLitFraction(world, b.litSeed);
    const litGlow = lightsAreOn(world);
    const ux = (face.p1.sx - face.p0.sx) / cols;
    const uy = (face.p1.sy - face.p0.sy) / cols;
    const dy = -wallH / (rowsN + 1);
    const paneW = Math.max(1.2, Math.abs(ux) * 0.55);
    const paneH = Math.max(1.4, -dy * 0.52);
    const darkPane = shadeHex(PALETTE.windowDark, 0.4 + 0.6 * amb);
    for (let row = 1; row <= rowsN; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cellHash = hash2(b.litSeed % 100000 + row * 31, col * 17 + (b.style === 'tower' ? 5 : 0), 3);
        const lit = litGlow > 0.12 && cellHash < litFrac * 1.2;
        if (lit) {
          ctx.globalAlpha = litGlow;
          ctx.fillStyle = cellHash > 0.78 ? PALETTE.windowLitCool : PALETTE.windowLit;
        } else {
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = darkPane;
        }
        ctx.fillRect(
          face.p0.sx + ux * (col + 0.25), // gap before each pane
          face.p0.sy + uy * (col + 0.25) + dy * row,
          paneW, paneH,
        );
      }
    }
    ctx.globalAlpha = 1;
  }

  /** A painted sign board with the landmark's name, big enough to read in a screenshot. */
  function drawLandmarkSign(b, world, amb) {
    // pin to the centre of whichever wall faces the camera, 42% of the way up
    const faceZ = Math.sin(cam.yaw) >= 0 ? b.z + b.d : b.z;
    const p = projectTo(cam, b.cx, b.h * 0.42, faceZ, view.w, view.h);
    if (!p.visible || p.sy < 0) return;
    const text = b.name ?? '';
    ctx.font = '700 13px system-ui, sans-serif';
    const width = ctx.measureText(text).width + 10;
    if (width < 14) return;
    ctx.fillStyle = shadeHex('#1c2028', 0.5 + 0.5 * amb);
    ctx.fillRect(p.sx - width / 2 - 5, p.sy - 11, width, 15);
    ctx.fillStyle = PALETTE.signInk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, p.sx, p.sy - 3);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // ---------------------------------------------------------------- props
  function drawPalmTree(p, world) {
    const sway = Math.sin(world.time * 0.02 + p.phase) * 1.6;
    const base = projectTo(cam, p.x, 0, p.z, view.w, view.h);
    if (!base.visible) return;
    const top = projectTo(cam, p.x + p.lean * p.h + sway, p.h, p.z, view.w, view.h);
    const amb = ambientLevel(world);
    ctx.strokeStyle = shadeHex(PALETTE.palmTrunk, 0.45 + 0.55 * amb);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(base.sx, base.sy);
    ctx.quadraticCurveTo(base.sx + (top.sx - base.sx) * 0.6, base.sy - (base.sy - top.sy) * 0.55, top.sx, top.sy);
    ctx.stroke();
    ctx.strokeStyle = shadeHex(lightsAreOn(world) > 0.5 ? PALETTE.palmLeafLit : PALETTE.palmLeaf, 0.5 + 0.5 * amb);
    ctx.lineWidth = 2.1;
    for (let f = 0; f < 5; f += 1) {
      const ang = (f / 5) * Math.PI * 2 + p.phase;
      ctx.beginPath();
      ctx.moveTo(top.sx, top.sy);
      ctx.quadraticCurveTo(
        top.sx + Math.cos(ang) * 6, top.sy - 2 + Math.sin(ang) * 2.4,
        top.sx + Math.cos(ang) * 13, top.sy + 4 + Math.sin(ang) * 5,
      );
      ctx.stroke();
    }
  }

  function drawStreetLamp(l, world, sky) {
    const base = projectTo(cam, l.x, 0, l.z, view.w, view.h);
    if (!base.visible) return;
    const head = projectTo(cam, l.x, l.h, l.z, view.w, view.h);
    const amb = ambientLevel(world);
    ctx.strokeStyle = shadeHex(PALETTE.lampPost, 0.4 + 0.6 * amb);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(base.sx, base.sy);
    ctx.lineTo(head.sx, head.sy);
    ctx.stroke();
    const on = lightsAreOn(world);
    if (on > 0.15) {
      const glow = ctx.createRadialGradient(head.sx, head.sy, 1, head.sx, head.sy, 12);
      glow.addColorStop(0, PALETTE.lampGlow);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = on;
      ctx.fillStyle = glow;
      ctx.fillRect(head.sx - 12, head.sy - 12, 24, 24);
      ctx.globalAlpha = 1;
      ctx.fillStyle = PALETTE.lampGlow;
      ctx.fillRect(head.sx - 1.6, head.sy - 1.6, 3.2, 3.2);
    }
  }

  /** Night vignette: the city dims at the edges after the sun is down. */
  function drawVignette(world) {
    const dark = smoothstep(0.45, 0.08, ambientLevel(world));
    if (dark <= 0.02) return;
    const g = ctx.createRadialGradient(view.w / 2, view.h * 0.55, view.h * 0.35, view.w / 2, view.h * 0.55, view.h * 0.85);
    g.addColorStop(0, 'rgba(0,0,10,0)');
    g.addColorStop(1, `rgba(2,4,14,${0.5 * dark})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, view.h);
  }

  // ---------------------------------------------------------------- frame
  /**
   * Paint one whole frame. scene (optional, from later sessions) may carry:
   *   scene.drawables: [{x, z, y(optional), paint(ctx, p), depthBias(optional)}]
   * sorted here by depth between the props and the vignette, so cars, cops and peds slot in
   * correctly without knowing anything about the projection.
   */
  function render(world, scene = null) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const sky = skyGradient(world);
    drawSkyGradient(world, sky);
    drawSunAndMoon(world, sky);
    drawDistantSkyline(sky);
    drawWaterAndShimmer(world, sky);
    drawGroundTiles(world);
    drawLaneMarks(world);
    drawBuildings(world);

    // depth-sorted layer: palms, lamps and whatever actors the scene brings
    const layer = [];
    for (const p of city.palms) {
      const d = depthOf(p.x, p.z);
      if (d !== null) layer.push({ d, kind: 'palm', ref: p });
    }
    for (const l of city.lamps) {
      const d = depthOf(l.x, l.z);
      if (d !== null) layer.push({ d, kind: 'lamp', ref: l });
    }
    if (scene && scene.drawables) {
      for (const drawable of scene.drawables) {
        const d = depthOf(drawable.x, drawable.z);
        if (d !== null) layer.push({ d, kind: 'custom', ref: drawable });
      }
    }
    layer.sort((a, b) => a.d - b.d);
    for (const item of layer) {
      if (item.kind === 'palm') drawPalmTree(item.ref, world);
      else if (item.kind === 'lamp') drawStreetLamp(item.ref, world, sky);
      else item.ref.paint(ctx, projectTo(cam, item.ref.x, item.ref.y ?? 0, item.ref.z, view.w, view.h));
    }
    drawVignette(world);
  }

  /** Depth of a point, or null when it is far behind the camera or miles away. */
  function depthOf(x, z) {
    const dx = x - cam.x;
    const dz = z - cam.z;
    const cos = Math.cos(cam.yaw);
    const sin = Math.sin(cam.yaw);
    const depth = dz * cos + dx * sin;
    const scale = cam.scale * cam.zoom;
    const horizonY = view.h * cam.horizon;
    const depthMax = (view.h - horizonY + 140) / (cam.pitchShear * scale);
    const halfW = (view.w / 2) / scale + 140;
    if (depth < -40 || depth > depthMax) return null;
    const rx = dx * cos - dz * sin;
    if (Math.abs(rx) > halfW) return null;
    return depth;
  }

  /** The probe helpers and the staging hooks later sessions lean on. */
  const renderer = {
    canvas, ctx, view, resize,
    render,
    setCity(value) { city = value; },
    setCamera(value) { cam = value; },
    get camera() { return cam; },
    projectTo: (x, y, z) => projectTo(cam, x, y, z, view.w, view.h),
    fillMinimap: (mctx, marks, size) => fillMinimap(mctx, cam, city, marks, size),
  };
  return renderer;
}

// ---------------------------------------------------------------- the minimap
/**
 * The whole island on one canvas, north-up: streets as pale lines, the sea wrapping the south
 * and east, parks, the landmark badges and the ringed blips. scaleTo(200px) keeps every block a
 * readable 5px cell — the HUD later draws this into its corner, big and high-contrast.
 */
export function fillMinimap(mctx, cam, city, marks = [], size = MINIMAP.size) {
  const worldToMap = size / city.worldSize;
  const px = (x) => x * worldToMap;
  mctx.save();
  mctx.fillStyle = '#20242c'; // the island's base: sidewalk grey by night and day
  mctx.fillRect(0, 0, size, size);

  // streets: one pale line per boulevard centre, both axes
  mctx.strokeStyle = MINIMAP.roadInk;
  mctx.lineWidth = Math.max(1, size / 224);
  for (let b = 0; b <= 27; b += 1) {
    const at = px(b * 8 * TILE);
    if (at > size) continue;
    mctx.beginPath();
    mctx.moveTo(at, 0);
    mctx.lineTo(at, px(WATER_START * TILE));
    mctx.stroke();
    mctx.beginPath();
    mctx.moveTo(0, at);
    mctx.lineTo(px(WATER_START * TILE), at);
    mctx.stroke();
  }

  // the sea: a thick blue L wrapping the south and east quays
  mctx.fillStyle = MINIMAP.waterInk;
  const wStart = px(WATER_START * TILE);
  mctx.fillRect(wStart, 0, size - wStart, size);
  mctx.fillRect(0, wStart, size, size - wStart);

  // parks: soft green squares
  mctx.fillStyle = '#3f6b46';
  for (const park of city.parks) {
    mctx.fillRect(px(park.x) - 4, px(park.z) - 4, 8, 8);
  }

  // landmark badges: white-dot rings with the initials of the place
  mctx.font = '700 9px system-ui, sans-serif';
  mctx.textAlign = 'center';
  mctx.textBaseline = 'middle';
  for (const lm of city.landmarks) {
    const x = px(lm.x);
    const z = px(lm.z);
    if (x < 4 || z < 4 || x > size - 4 || z > size - 4) continue;
    mctx.fillStyle = '#f3e9d2';
    mctx.beginPath();
    mctx.arc(x, z, 3.4, 0, Math.PI * 2);
    mctx.fill();
    mctx.fillStyle = '#14161c';
    mctx.fillText(lm.name.replace(/[^A-Z]/g, '').slice(0, 1) || '•', x, z + 0.5);
  }

  // blips: mission targets, police, the player — ringed so they pop at small scale
  for (const mark of marks) {
    const x = px(mark.x);
    const z = px(mark.z);
    if (x < -10 || z < -10 || x > size + 10 || z > size + 10) continue;
    mctx.strokeStyle = '#ffffff';
    mctx.lineWidth = 1.6;
    mctx.fillStyle = mark.color ?? '#ff5c5c';
    mctx.beginPath();
    mctx.arc(x, z, mark.size ?? 4, 0, Math.PI * 2);
    mctx.fill();
    mctx.stroke();
    if (mark.kind === 'player') {
      // the heading wedge, north-up like the map itself
      const a = mark.heading ?? cam.heading ?? 0;
      mctx.fillStyle = '#ffffff';
      mctx.beginPath();
      mctx.moveTo(x + Math.sin(a) * 7, z - Math.cos(a) * 7);
      mctx.lineTo(x + Math.sin(a + 2.5) * 7, z - Math.cos(a + 2.5) * 7);
      mctx.lineTo(x + Math.sin(a - 2.5) * 7, z - Math.cos(a - 2.5) * 7);
      mctx.closePath();
      mctx.fill();
    }
  }

  // the north badge, so the map reads at a glance
  const nx = size - 13;
  mctx.fillStyle = '#f3e9d2';
  mctx.beginPath();
  mctx.arc(nx, 13, 8.5, 0, Math.PI * 2);
  mctx.fill();
  mctx.fillStyle = '#14161c';
  mctx.font = '800 10px system-ui, sans-serif';
  mctx.fillText('N', nx, 13.5);
  mctx.restore();
}
