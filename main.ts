// main.ts — the hand-in step for Calvera Bay (bounty gta6-01).
//
// Shape of the job: look over the static site in game/ and the four stills in screenshots/,
// reject the entry if any figure the judge measures is over its ceiling, mirror both folders
// into the output directory, and drop dossier.json beside them. Node 22, nothing outside the
// standard library; the dossier itself is built by the library vendored in vendor/.
//
//   play it:   node serve.ts        -> http://localhost:8080
//   hand in:   MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Ceilings, as the bounty states them. Names read as the thing being measured.
const PAGE_CEILING = 1048576;
const STILL_COUNT = 4;
const STILL_CEILING = 262144;
const TREE_FILE_CEILING = 993;
const TREE_BYTE_CEILING = 50331648;
const TREE_PATH_CEILING = 1000;
const TEXT_CEILING = 163840;

// Any failed check ends the run here, on stderr, with a non-zero status.
function refuse(reason: string): never {
  process.stderr.write(`main.ts: ${reason}\n`);
  process.exit(1);
  throw new Error(reason); // unreachable; only there to satisfy the `never` return type
}

function sizeOf(file: string): number {
  return statSync(file).size;
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) pending.push(full);
      else found.push(full);
    }
  }
  return found;
}

// A file opens with the three bytes every JPEG starts with.
function looksLikeJpeg(file: string): boolean {
  const [a, b, c] = readFileSync(file).subarray(0, 3);
  return a === 0xff && b === 0xd8 && c === 0xff;
}

// --- the landing page -------------------------------------------------------------------

const pagePath = join(HERE, 'game', 'index.html');
try {
  if (!statSync(pagePath).isFile()) refuse('game/index.html is not a regular file');
} catch {
  refuse('game/index.html is absent');
}
const pageBytes = sizeOf(pagePath);
if (pageBytes > PAGE_CEILING) {
  refuse(`game/index.html weighs ${pageBytes} B; the ceiling is ${PAGE_CEILING} B`);
}

// --- the four stills --------------------------------------------------------------------

const stillsDir = join(HERE, 'screenshots');
let stills: string[];
try {
  stills = readdirSync(stillsDir).sort();
} catch {
  refuse('screenshots/ is absent');
}
if (stills.length !== STILL_COUNT) {
  refuse(`screenshots/ has ${stills.length} entries; exactly ${STILL_COUNT} are wanted`);
}
for (const still of stills) {
  const full = join(stillsDir, still);
  const bytes = sizeOf(full);
  if (bytes > STILL_CEILING) {
    refuse(`screenshots/${still} weighs ${bytes} B; the ceiling is ${STILL_CEILING} B`);
  }
  if (!looksLikeJpeg(full)) {
    refuse(`screenshots/${still} does not begin with JPEG magic (FF D8 FF)`);
  }
}

// --- the game tree ----------------------------------------------------------------------

const gameDir = join(HERE, 'game');
const gameFiles = filesUnder(gameDir);
if (gameFiles.length > TREE_FILE_CEILING) {
  refuse(`game/ holds ${gameFiles.length} files; the ceiling is ${TREE_FILE_CEILING}`);
}

let treeBytes = 0;
for (const file of gameFiles) {
  treeBytes += sizeOf(file);
  const rel = relative(gameDir, file);
  const relBytes = Buffer.byteLength(rel, 'utf8');
  if (relBytes > TREE_PATH_CEILING) {
    refuse(`game/${rel} has a ${relBytes} B path; the ceiling is ${TREE_PATH_CEILING} B`);
  }
}
if (treeBytes > TREE_BYTE_CEILING) {
  refuse(`game/ totals ${treeBytes} B; the ceiling is ${TREE_BYTE_CEILING} B`);
}

// --- hand it in -------------------------------------------------------------------------

mkdirSync(DEST, { recursive: true });
cpSync(gameDir, join(DEST, 'game'), { recursive: true });
cpSync(stillsDir, join(DEST, 'screenshots'), { recursive: true });

const dossier = buildDossier(DEST, {
  text_max_bytes: TEXT_CEILING,
  screenshots: { max: STILL_COUNT, max_bytes: STILL_CEILING },
  game_max_files: TREE_FILE_CEILING,
  game_max_bytes: TREE_BYTE_CEILING,
  game_path_max_bytes: TREE_PATH_CEILING,
});
writeFileSync(join(DEST, 'dossier.json'), dossier);

process.stdout.write(
  `Calvera Bay entry: ${gameFiles.length} game files / ${treeBytes} B, ` +
    `${stills.length} stills, dossier ${dossier.byteLength} B -> ${DEST}\n`,
);
