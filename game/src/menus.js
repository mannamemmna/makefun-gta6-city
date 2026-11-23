// menus.js — the game's canvas-drawn state machine: titleMenu (the big game title, its subtitle,
// a pulsing "PRESS ENTER", a NEW GAME that starts clean and a CONTINUE lit only when a save
// slot exists, and a How-to-play overlay), pauseMenu (Resume / Load / Quit to title), the
// missionPassedBanner's shared lettering, and the cursor handling for all of them. Everything is
// drawn onto the same 2D context the world rendered into — DOM-free, so probing and the staged
// shots see one canvas, deterministic in every animation phase from the game's tick counter
// (no wall clock, no Math.random). menuTitleState() is the stack main.js flips: a menu object
// is {id:'title'|'howto'|'pause', cursor:0..n-1, items:[{key,label,hint,enabled}]}.
import { VIEW, PALETTE } from './config.js';
import { clamp } from './util.js';

const INK = '#0b0e14';
const AMBER = '#ffc65c';
const PALE = '#f2ecd9';
const RED = '#e0393f';
const GREEN = '#63e08c';
const PLATE_EDGE = '#d8aa4e';

export const MENU_ENTER = 'enter';

/** Build the title menu stack frame; continueOn when a save slot exists. */
export function menuTitleState(continueOn) {
  const items = continueOn
    ? [menuEntry('new', 'NEW GAME', 'start clean in Calvera Bay', false),
       menuEntry('continue', 'CONTINUE', 'load your saved story', false)]
    : [menuEntry('new', 'NEW GAME', 'start clean in Calvera Bay', true)];
  return {
    id: 'title',
    cursor: continueOn ? 1 : 0,
    showContinue: continueOn,
    howto: false,
    // how-to is a real row: the cursor reaches it, ENTER flips the overlay
    items: [...items, menuEntry('howto', 'HOW TO PLAY', 'the keys and the streets', false)],
  };
}

function menuEntry(key, label, hint, selected) {
  return { key, label, hint, selected };
}

/** The pause menu: Resume / Load Save / Quit to Title. */
export function menuPauseState() {
  return {
    id: 'pause',
    cursor: 0,
    items: [
      menuEntry('resume', 'RESUME', 'back to the street', true),
      menuEntry('load', 'LOAD SAVE', 'restore the last save', false),
      menuEntry('quit', 'QUIT TO TITLE', 'leave the session', false),
      menuEntry('howto', 'HOW TO PLAY', 'the keys and the streets', false),
    ],
  };
}

/** The How-to-play overlay's row list. */
export function menuHowtoState() {
  return {
    id: 'howto',
    cursor: 0,
    rows: [
      ['WASD / ARROWS', 'walk or drive'],
      ['SHIFT', 'sprint (on foot)'],
      ['E', 'enter a car / get out'],
      ['SPACE', 'handbrake'],
      ['F or RIGHT MOUSE', 'aim'],
      ['LEFT MOUSE', 'fire'],
      ['1 2 3 / Q', 'swap weapons'],
      ['H', 'horn'],
      ['P or ESC', 'pause and this menu'],
      ['M / ENTER', 'confirm a highlighted row'],
    ],
  };
}

/** Move the cursor down/up; wraps; skips nothing, all entries are live. */
export function menuMoveCursor(menu, dir) {
  if (!menu.items || menu.items.length === 0) return menu.cursor;
  menu.cursor = (menu.cursor + dir + menu.items.length) % menu.items.length;
  return menu.cursor;
}

/** menuSelect: returns the key of the highlighted row, or 'howto'/'back' for the overlay. */
export function menuSelect(menu) {
  if (menu.id === 'howto') return 'back';
  return menu.items[Math.max(0, Math.min(menu.cursor, menu.items.length - 1))].key;
}

// ---------------------------------------------------------------- title
/** main.drawTitleFrame = drawTitleMenu(ctx, state, blinkOn); the city passes behind it blurred. */
export function drawTitleMenu(ctx, state, blinkOn, worldTimeTick) {
  dimWorldForMenu(ctx, 0.44);
  drawGameTitle(ctx);
  // PRESS ENTER pulses on the game's tick alone
  if (blinkOn) {
    ctx.font = '800 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const pulse = 0.6 + 0.4 * Math.sin(worldTimeTick * 0.09);
    ctx.fillStyle = `rgba(255,198,92,${pulse.toFixed(2)})`;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 4;
    ctx.strokeText('PRESS ENTER', VIEW.width / 2, VIEW.height - 96);
    ctx.fillText('PRESS ENTER', VIEW.width / 2, VIEW.height - 96);
  }
  // the option rows
  const startY = VIEW.height / 2 + 14;
  state.items.forEach((item, i) => {
    drawMenuRow(ctx, item, state.cursor === i, startY + i * 64, i);
  });
  if (state.howto) drawHowtoOverlay(ctx, worldTimeTick);
  drawTitleFooter(ctx);
}

/** The game's name in its skyline colors, with a hard drop shadow so it reads at any size. */
export function drawGameTitle(ctx) {
  const cx = VIEW.width / 2;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '800 110px system-ui, sans-serif';
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 12;
  ctx.strokeText('CALVERA BAY', cx, VIEW.height / 2 - 66);
  const grad = ctx.createLinearGradient(0, VIEW.height / 2 - 140, 0, VIEW.height / 2 - 40);
  grad.addColorStop(0, '#ffd98c');
  grad.addColorStop(0.55, AMBER);
  grad.addColorStop(1, '#e2703c');
  ctx.fillStyle = grad;
  ctx.fillText('CALVERA BAY', cx, VIEW.height / 2 - 66);
  ctx.font = '800 26px system-ui, sans-serif';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 5;
  ctx.strokeText('A SUN-SOAKED OPEN-WORLD CRIME STORY', cx, VIEW.height / 2 - 26 + 2);
  ctx.fillStyle = PALE;
  ctx.fillText('A SUN-SOAKED OPEN-WORLD CRIME STORY', cx, VIEW.height / 2 - 26 + 2);
  ctx.restore();
}

function drawMenuRow(ctx, item, selected, y, i) {
  ctx.font = `800 ${selected ? 34 : 28}px system-ui, sans-serif`;
  const label = (selected ? '> ' : '  ') + item.label;
  const tw = ctx.measureText(label).width;
  const x = VIEW.width / 2 - tw / 2;
  ctx.fillStyle = selected ? 'rgba(10,13,20,0.85)' : 'rgba(10,13,20,0.55)';
  ctx.fillRect(x - 14, y - 30, tw + 28, selected ? 44 : 38);
  if (selected) {
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x - 14, y - 30, tw + 28, 44);
  }
  ctx.fillStyle = selected ? AMBER : 'rgba(242,236,217,0.78)';
  ctx.textAlign = 'left';
  ctx.fillText(label, x, y);
  ctx.textAlign = 'left';
  if (selected) {
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(242,236,217,0.7)';
    ctx.fillText(item.hint, x + 8, y + 34);
  }
}

function drawTitleFooter(ctx) {
  ctx.font = '700 15px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(242,236,217,0.5)';
  ctx.textAlign = 'center';
  ctx.fillText('make.fun \u00b7 original entry \u00b7 all art, names and sounds ours',
    VIEW.width / 2, VIEW.height - 26);
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------- howto
/** The How-to-play overlay: a full-screen dark card listing the controls. */
export function drawHowtoOverlay(ctx, worldTimeTick) {
  ctx.fillStyle = 'rgba(6,8,12,0.92)';
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  ctx.textAlign = 'center';
  ctx.font = '800 44px system-ui, sans-serif';
  ctx.fillStyle = AMBER;
  ctx.fillText('HOW TO PLAY', VIEW.width / 2, 96);
  const rows = menuHowtoState().rows;
  const startX = VIEW.width / 2 - 240;
  let y = 150;
  rows.forEach((row) => {
    drawSettingRow(ctx, row[0], row[1], startX, y);
    y += 38;
  });
  ctx.font = '800 20px system-ui, sans-serif';
  ctx.fillStyle = PALE;
  ctx.fillText('M or ENTER closes this page', VIEW.width / 2, y + 18);
  ctx.textAlign = 'left';
}

function drawSettingRow(ctx, key, desc, x, y) {
  ctx.fillStyle = 'rgba(26,30,40,0.9)';
  ctx.fillRect(x, y - 22, 130, 28);
  ctx.strokeStyle = 'rgba(216,170,78,0.4)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y - 22, 130, 28);
  ctx.font = '800 17px system-ui, sans-serif';
  ctx.fillStyle = AMBER;
  ctx.textAlign = 'left';
  ctx.fillText(key, x + 10, y - 3);
  ctx.font = '700 17px system-ui, sans-serif';
  ctx.fillStyle = PALE;
  ctx.fillText(desc, x + 150, y - 3);
}

// ---------------------------------------------------------------- pause
/** drawPauseMenu: a centered column over a dimmed, still-live world. */
export function drawPauseMenu(ctx, state, worldTimeTick) {
  dimWorldForMenu(ctx, 0.55);
  ctx.textAlign = 'center';
  ctx.font = '800 56px system-ui, sans-serif';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 8;
  ctx.strokeText('PAUSED', VIEW.width / 2, VIEW.height / 2 - 120);
  ctx.fillStyle = PALE;
  ctx.fillText('PAUSED', VIEW.width / 2, VIEW.height / 2 - 120);
  const startY = VIEW.height / 2 - 26;
  state.items.forEach((item, i) => {
    drawMenuRow(ctx, item, state.cursor === i, startY + i * 60, i);
  });
  ctx.font = '700 15px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(242,236,217,0.55)';
  ctx.fillText('W/S move \u00b7 ENTER choose', VIEW.width / 2, VIEW.height - 40);
  ctx.textAlign = 'left';
}

/** Common dimming plate behind every menu so the world reads as a backdrop. */
function dimWorldForMenu(ctx, alpha) {
  const g = ctx.createLinearGradient(0, 0, 0, VIEW.height);
  g.addColorStop(0, `rgba(6,7,12,${alpha + 0.18})`);
  g.addColorStop(1, `rgba(6,7,12,${alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
}

// ---------------------------------------------------------------- mission passed
/**
 * missionPassedBanner: the MISSION PASSED! card with its cash tally, drawn for ttl seconds
 * over the live HUD. Returns true while still showing (main decrements ttl itself or calls
 * updateBanner below per tick).
 */
export function missionPassedBanner(ctx, banner, worldTimeTick) {
  const ttl = banner.ttl;
  const riseT = clamp((banner.life - ttl) / 0.35, 0, 1); // 0.35s slide-in
  const slide = (1 - riseT) * 90;
  const cx = VIEW.width / 2;
  const y = VIEW.height / 2 - slide - 110;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '800 62px system-ui, sans-serif';
  const text = banner.failed ? 'MISSION FAILED' : 'MISSION PASSED!';
  const tw = Math.min(ctx.measureText(text).width + 80, VIEW.width * 0.8);
  ctx.globalAlpha = riseT;
  ctx.fillStyle = 'rgba(8,10,16,0.92)';
  ctx.fillRect(cx - tw / 2, y - 56, tw, 112);
  ctx.strokeStyle = banner.failed ? RED : AMBER;
  ctx.lineWidth = 4;
  ctx.strokeRect(cx - tw / 2, y - 56, tw, 112);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 6;
  ctx.strokeText(text, cx, y + 4);
  ctx.fillStyle = banner.failed ? '#ff6c70' : AMBER;
  ctx.fillText(text, cx, y + 4);
  ctx.font = '800 26px system-ui, sans-serif';
  ctx.strokeText(banner.title, cx, y + 36);
  ctx.fillStyle = PALE;
  ctx.fillText(banner.title, cx, y + 36);
  if (banner.reward) {
    ctx.font = '800 30px system-ui, sans-serif';
    ctx.fillStyle = GREEN;
    ctx.strokeText(`REWARD $${banner.reward}`, cx, VIEW.height / 2 - slide + 74);
    ctx.fillText(`REWARD $${banner.reward}`, cx, VIEW.height / 2 - slide + 74);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.textAlign = 'left';
  return ttl > 0;
}

/** Advance one banner's ttl by dt; caller drops it at 0. */
export function updateBanner(banner, dt) {
  if (banner && banner.ttl > 0) banner.ttl -= dt;
  return banner && banner.ttl > 0;
}
