// save.js — the one save slot of Calvera Bay, written to localStorage under the signed version
// key SAVE_KEY = 'calvera_save_1'. saveSlot(needleState) packs the whole progress through the
// story (position, cash, health and armor, the wanted level, the mission-chain index, the hero's
// owned car and the elapsed game clock), loadSlot() restores it or returns null when the slot is
// empty or written by a different shape (the version stamps both the key and the payload), and
// hasSave() is the Continue flag the title menu lights when a slot exists. Nothing but JSON and
// a small checksum; every failure mode (quota, private-mode throws, malformed JSON) resolves to
// null/false rather than an exception, so the game can never die on its own save code.
// save.js imports nothing: the schema below is the single contract.

export const SAVE_VERSION = 1;
export const SAVE_KEY = 'calvera_save_1';

/** hasSave(): true when a readable slot under SAVE_KEY exists. */
export function hasSave() {
  try {
    return !!window.localStorage && !!window.localStorage.getItem(SAVE_KEY);
  } catch (err) {
    return false;
  }
}

/**
 * The state saveSlot expects — the main loop assembles it:
 * { pos:{x,z,heading}, cash, health, armor, wantedStars, missionIndex, sideJobsDone,
 *   ownedCar:{x,z,heading,kind,body}|null, elapsedTicks, savedMinutes, savedDay }
 * Returns {ok:true} on success, {ok:false, error} otherwise.
 */
export function saveSlot(state) {
  if (!state) return { ok: false, error: 'no state' };
  const payload = { ver: SAVE_VERSION, ...state };
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    return { ok: false, error: 'unserializable' };
  }
  try {
    window.localStorage.setItem(SAVE_KEY, json);
  } catch (err) {
    return { ok: false, error: 'storage unavailable' };
  }
  return { ok: true };
}

/**
 * loadSlot(): the parsed state minus its version stamp, or null when there is no slot, the
 * JSON is broken or the payload was stamped by any other version.
 */
export function loadSlot() {
  let json = null;
  try {
    json = window.localStorage && window.localStorage.getItem(SAVE_KEY);
  } catch (err) {
    return null;
  }
  if (!json) return null;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return null;
  }
  if (!parsed || parsed.ver !== SAVE_VERSION) return null;
  delete parsed.ver;
  return parsed;
}

/** clearSave(): used by the title menu's New Game path (a fresh start wipes the slot). */
export function clearSave() {
  try {
    window.localStorage && window.localStorage.removeItem(SAVE_KEY);
  } catch (err) { /* private mode: nothing to clear */ }
  return true;
}
