/**
 * Asset staging: Kenney source packs -> public/assets/.
 *
 * WHY THIS EXISTS
 * The Kenney packs in assets/ are raw vendor drops: Starling/Sparrow `.xml`
 * atlases and hundreds of loose UI PNGs. PixiJS 8 reads JSON spritesheets, not
 * Starling XML, and the game only needs a handful of the UI files. Rather than
 * commit a hand-edited JSON that silently rots the next time a pack is updated,
 * this script derives everything from the vendor files:
 *
 *   assets/spaceship_shooter/   -> public/assets/ships/raider.{png,json}
 *   assets/spaceship_expansion/ -> public/assets/ships/armada.{png,json}
 *   assets/spaceship_UI/        -> public/assets/ui/*.png
 *
 * THIS SCRIPT NO LONGER GENERATES bg_void.png. It used to bake one, via a
 * `makeVoidTile()` that wrote cyan/magenta sine-wave "nebula" lobes into a
 * seamless 512x512 tile plus 900 stars. That file was the actual, persistent
 * source of a "repeating blue/purple cellular pattern" bug reported against
 * the game's background across several unrelated rework passes — the
 * runtime backdrop (src/render/background.js) was rewritten from scratch
 * more than once in that time, and none of it mattered, because
 * `Background` preferred this baked PNG over its own procedural texture
 * whenever the PNG loaded successfully, which — being a real committed file
 * — was always. See src/core/assets.js's ASSET_KEYS comment for the full
 * account. Do not re-add a call that writes `ui/bg_void.png`: nothing
 * consumes that path any more, and doing so would silently resurrect the
 * exact bug this note exists to prevent.
 *
 * Only `public/assets/` is served and shipped; `assets/` is source material.
 *
 * BOTH SHIP PACKS ARE COMPILED WHOLE, no frame filter.
 * An earlier revision emitted only the ordnance subset of the shooter pack and
 * skipped the expansion pack entirely, which left the game drawing everything
 * from one monochrome silhouette sheet. Filtering saved ~70KB of JSON and cost
 * the entire art direction; the frames are offsets into a PNG that ships either
 * way, so the only real cost of keeping them all is parse time. Pick frames in
 * src/core/assets.js, not here — this script's job is to make the packs
 * available, not to have opinions about them.
 *
 * assets/spaceship_simple/ is intentionally NOT compiled any more. It is the
 * flat white silhouette pack the detailed art replaced; nothing references it.
 *
 * NO IMAGE DECODING. Atlas PNGs are copied byte-for-byte and their dimensions
 * read straight out of the IHDR header, so this runs on a bare Node with no
 * native image dependency. The one generated file (the starfield backdrop) is
 * written with a ~40-line PNG encoder built on the `zlib` builtin.
 *
 * Run with: npm run assets
 */

import { deflateSync } from 'node:zlib';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'assets');
const OUT = resolve(ROOT, 'public', 'assets');

/* ------------------------------------------------------------------ */
/* PNG helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Width/height straight out of a PNG's IHDR chunk.
 * IHDR is always the first chunk, so the two big-endian uint32s live at fixed
 * offsets 16 and 20. Cheaper and more portable than decoding the image.
 *
 * @param {string} file
 * @returns {{width: number, height: number}}
 */
function pngSize(file) {
  const buffer = readFileSync(file);
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a PNG: ${file}`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Encode raw RGBA pixels as a PNG.
 * Colour type 6 (RGBA), bit depth 8, filter 0 on every row — the simplest
 * conformant encoding, and small enough after deflate for a backdrop tile.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba - width * height * 4 bytes
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      rowStart + 1
    );
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/* ------------------------------------------------------------------ */
/* Starling XML -> Pixi JSON spritesheet                               */
/* ------------------------------------------------------------------ */

/**
 * Convert a Kenney/Starling `.xml` atlas into the JSON hash format PixiJS 8's
 * spritesheet parser expects.
 *
 * Frame names lose their `.png` suffix: the game refers to them as `ship_C`,
 * not `ship_C.png`, and the suffix inside a key is noise.
 *
 * @param {string} xmlPath - Source .xml
 * @param {string} pngPath - Source .png beside it
 * @param {string} outDir - Destination directory under public/assets/
 * @param {string} name - Basename for the emitted pair
 * @param {(key: string) => boolean} [include] - Keep only matching frames. The
 *   PNG is copied whole either way — frames are just offsets into it — so this
 *   trims the JSON the browser parses, not the download.
 * @returns {number} Frame count
 */
function buildSheet(xmlPath, pngPath, outDir, name, include = () => true) {
  const xml = readFileSync(xmlPath, 'utf8');
  const { width, height } = pngSize(pngPath);

  const frames = {};
  const pattern =
    /<SubTexture\s+name="([^"]+)"\s+x="(\d+)"\s+y="(\d+)"\s+width="(\d+)"\s+height="(\d+)"/g;

  for (const match of xml.matchAll(pattern)) {
    const [, rawName, x, y, w, h] = match;
    const key = rawName.replace(/\.png$/i, '');
    if (!include(key)) continue;
    const frame = { x: +x, y: +y, w: +w, h: +h };
    frames[key] = {
      frame,
      rotated: false,
      // Kenney atlases are packed untrimmed, so the source size and the packed
      // rect are the same and every sprite's anchor maths stays honest.
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: frame.w, h: frame.h },
      sourceSize: { w: frame.w, h: frame.h },
    };
  }

  if (Object.keys(frames).length === 0) throw new Error(`no SubTextures in ${xmlPath}`);

  mkdirSync(outDir, { recursive: true });
  copyFileSync(pngPath, resolve(outDir, `${name}.png`));
  writeFileSync(
    resolve(outDir, `${name}.json`),
    `${JSON.stringify(
      {
        frames,
        meta: {
          app: 'tools/build-assets.mjs',
          version: '1.0',
          image: `${name}.png`,
          format: 'RGBA8888',
          size: { w: width, h: height },
          scale: '1',
        },
      },
      null,
      2
    )}\n`
  );

  return Object.keys(frames).length;
}

/* ------------------------------------------------------------------ */
/* UI plates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Loose UI PNGs, renamed to what they are used FOR rather than what Kenney
 * called them. The rarity badges are the four colour variants of the same
 * source file, which is why the mapping is worth writing down in one place.
 */
const UI_FILES = [
  ['PNG/Extra/Default/panel_rectangle.png', 'panel_card.png'],
  ['PNG/Extra/Default/panel_glass.png', 'panel_glass.png'],
  ['PNG/Extra/Default/button_rectangle.png', 'panel_button.png'],
  // Meta-UI console chrome. All three 9-slice at 16px, which is what keeps the
  // corner screws intact: every screw sits at source pixels 8-11 from its edge,
  // so a 16px corner region contains one whole and stretches none of it.
  ['PNG/Extra/Default/panel_rectangle_screws.png', 'console_plate.png'],
  ['PNG/Extra/Default/panel_glass_screws.png', 'console_bay.png'],
  ['PNG/Extra/Default/button_rectangle_depth.png', 'console_key.png'],
  // Rarity badge colours, per the theme spec: blue/green/yellow/red.
  ['PNG/Blue/Default/button_square_header_notch_square.png', 'badge_common.png'],
  ['PNG/Green/Default/button_square_header_notch_square.png', 'badge_uncommon.png'],
  ['PNG/Yellow/Default/button_square_header_notch_square.png', 'badge_rare.png'],
  ['PNG/Red/Default/button_square_header_notch_square.png', 'badge_legendary.png'],
];

function buildUi() {
  const dir = resolve(OUT, 'ui');
  mkdirSync(dir, { recursive: true });
  for (const [from, to] of UI_FILES) {
    copyFileSync(resolve(SRC, 'spaceship_UI', from), resolve(dir, to));
  }
  return UI_FILES.length;
}

/* ------------------------------------------------------------------ */
/*
 * There used to be a "Generated starfield backdrop" section here: a
 * `makeVoidTile()` that baked cyan/magenta sine-wave nebula lobes plus 900
 * stars into public/assets/ui/bg_void.png. See the module header for why it
 * is gone and why it must not come back. `encodePng`/`crc32` above are
 * general-purpose and kept — they were never the bug, only the content that
 * used to flow through them.
 */
/* ------------------------------------------------------------------ */

/**
 * Kenney Space Shooter Redux: detailed fighters, wings, cockpits, turrets,
 * shields, laser bolts and explosion frames. The light and medium half of the
 * roster plus every projectile comes from here.
 */
const raider = buildSheet(
  resolve(SRC, 'spaceship_shooter/sheet.xml'),
  resolve(SRC, 'spaceship_shooter/sheet.png'),
  resolve(OUT, 'ships'),
  'raider'
);

/**
 * Kenney Space Shooter Expansion (2X): heavy hulls, station spines, solar
 * arrays, turret platforms, reactor modules and thruster flames. The boss and
 * the heavy guardians come from here.
 */
const armada = buildSheet(
  resolve(SRC, 'spaceship_expansion/spaceShooter2_spritesheet_2X.xml'),
  resolve(SRC, 'spaceship_expansion/spaceShooter2_spritesheet_2X.png'),
  resolve(OUT, 'ships'),
  'armada'
);

const ui = buildUi();

console.log(
  `[assets] ships/raider.json ${raider} frames, ships/armada.json ${armada} frames, ` +
    `ui/ ${ui} plates`
);
