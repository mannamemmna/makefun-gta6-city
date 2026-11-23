// audio.js — a tiny WebAudio synth, no sound files anywhere. audioSetup() its own engine hum
// whose volume tracks the player's speed (engineLoop), a siren whose pitch ramps with the
// nearest cruiser's distance (sirenDoppler), plus one-shot effects: gunshotBurst for fired
// weapons, missionChime for a passed job. All optional: when AudioContext is unavailable or
// suspended (headless Chrome under a probe), every call becomes a clean no-op so the rest of
// the game never knows sound is off. Nothing here is random or wall-clocked.
export const AUDIO_READY = 1;

/** The audio system: createAudio() never throws; state 'off' until a context exists. */
export function createAudio() {
  return {
    state: 'off', // 'off' | 'on'
    ctx: null,
    engineOsc: null, engineGain: null,
    sirenOsc: null, sirenGain: null, sirenPan: null, sirenLfoTimer: 0,
    master: null,
  };
}

/**
 * Bring the synth up lazily: only when a browser hands us a working AudioContext and it
 * starts (autoplay policy). Returns true when sound is live this call or already was.
 */
export function audioStart(audio) {
  if (audio.state === 'on') return true;
  const Ctor = (typeof window !== 'undefined')
    && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return false;
  try {
    const ctx = new Ctor();
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    if (ctx.state === 'suspended') return false; // headless or pre-gesture: stay silent
    audio.ctx = ctx;
    audio.master = ctx.createGain();
    audio.master.gain.value = 0.5;
    audio.master.connect(ctx.destination);
    buildEngineLoop(audio);
    buildSirenDoppler(audio);
    audio.state = 'on';
    return true;
  } catch (err) {
    audio.state = 'off'; // no context, no sound: everything below no-ops cleanly
    return false;
  }
}

/** engineLoop: a soft low saw that rides the master gain, pitch and level by speed. */
function buildEngineLoop(audio) {
  const ctx = audio.ctx;
  audio.engineOsc = ctx.createOscillator();
  audio.engineOsc.type = 'sawtooth';
  audio.engineOsc.frequency.value = 42;
  audio.engineGain = ctx.createGain();
  audio.engineGain.gain.value = 0;
  audio.engineOsc.connect(audio.engineGain);
  audio.engineGain.connect(audio.master);
  audio.engineOsc.start();
}

/** sirenDoppler: a stereo-panned pair of detuned squares that wail while cruisers chase. */
function buildSirenDoppler(audio) {
  const ctx = audio.ctx;
  audio.sirenOsc = ctx.createOscillator();
  audio.sirenOsc.type = 'square';
  audio.sirenOsc.frequency.value = 640;
  audio.sirenGain = ctx.createGain();
  audio.sirenGain.gain.value = 0;
  audio.sirenPan = (typeof ctx.createStereoPanner === 'function') ? ctx.createStereoPanner() : null;
  if (audio.sirenPan) {
    audio.sirenOsc.connect(audio.sirenGain);
    audio.sirenGain.connect(audio.sirenPan);
    audio.sirenPan.connect(audio.master);
  } else {
    audio.sirenOsc.connect(audio.sirenGain);
    audio.sirenGain.connect(audio.master);
  }
  audio.sirenOsc.start();
}

/**
 * engineLoop(audio, speed01): the hum of the hero's ride. speed01 in 0..1 raises the pitch
 * toward a cruise and the level with it; on foot the engine fades out entirely.
 */
export function engineLoop(audio, speed01, driving) {
  if (audio.state !== 'on') return;
  const ctx = audio.ctx;
  const target = driving ? 0.055 + 0.075 * speed01 : 0;
  const freq = driving ? 38 + 90 * speed01 : 42;
  const t = ctx.currentTime;
  audio.engineGain.gain.setTargetAtTime(target, t, 0.12);
  audio.engineOsc.frequency.setTargetAtTime(freq, t, 0.16);
}

/**
 * sirenDoppler(audio, intensity, pan01): the pursuit wail. intensity 0..1 (distance of the
 * nearest cruiser), pan01 -1 (left) .. 1 (right) by the cruiser's screen bearing; the wobble
 * sweeps the pitch up and down at a fixed 3.4 Hz, no timers read.
 */
export function sirenDoppler(audio, intensity, pan01, worldTick) {
  if (audio.state !== 'on') return;
  const ctx = audio.ctx;
  const t = ctx.currentTime;
  const wob = 0.5 + 0.5 * Math.sin(worldTick * (Math.PI * 2 * 3.4 / 60));
  const gain = 0.028 * intensity;
  audio.sirenGain.gain.setTargetAtTime(gain, t, 0.25);
  audio.sirenOsc.frequency.setTargetAtTime(520 + 320 * wob, t, 0.05);
  if (audio.sirenPan) audio.sirenPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan01)), t, 0.3);
}

/** The common one-shot voice: an oscillator blip with a gain envelope, then cleanup. */
function blip(audio, type, freq0, freq1, holdS, level, delayS = 0) {
  if (audio.state !== 'on') return;
  const ctx = audio.ctx;
  const t0 = ctx.currentTime + delayS;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq1), t0 + holdS);
  gain.gain.setValueAtTime(level, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + holdS);
  osc.connect(gain);
  gain.connect(audio.master);
  osc.start(t0);
  osc.stop(t0 + holdS + 0.02);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
}

/** A weapon report: two stacked blips so it reads as a burst, not a beep. */
export function gunshotBurst(audio, worldTick) {
  blip(audio, 'square', 210, 46, 0.11, 0.16);
  blip(audio, 'sawtooth', 1260, 90, 0.07, 0.10, 0.012);
}

/** missionPassed's fanfare: a rising bright arpeggio, four thirds of a second long. */
export function missionChime(audio) {
  blip(audio, 'sine', 523, 528, 0.16, 0.2, 0.0);
  blip(audio, 'sine', 659, 664, 0.16, 0.2, 0.12);
  blip(audio, 'sine', 784, 789, 0.3, 0.22, 0.24);
}

/** A hard-tone sting for busted/wasted so the overlay lands with a thud. */
export function gameOverSting(audio) {
  blip(audio, 'sawtooth', 174, 58, 0.7, 0.22);
}

/** HUD ticks: cash pickups and star changes so the panel feels alive. */
export function cashPick(audio) {
  blip(audio, 'triangle', 900, 1350, 0.09, 0.14);
}
