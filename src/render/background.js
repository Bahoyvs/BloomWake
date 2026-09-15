/**
 * The Void — procedural space backdrop.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF IT: ONE PINNED NEBULA, PLUS TWO TILED DEPTHS
 * ---------------------------------------------------------------------------
 *   Layer 0 — the deep nebula. A SINGLE non-tiling Sprite sized to cover the
 *     whole arena (see NEBULA_WORLD_MARGIN), not a repeating tile. It drifts a
 *     little relative to the camera (PARALLAX.NEBULA_WORLD) for a depth cue,
 *     clamped so its edge can never show. See the FOURTH-PASS section below
 *     for why this is a Sprite and every earlier version was not.
 *   Layer 1 (parallax 0.058, tile 1536px) — distant starfield. Moves just
 *     enough to read as "very far away". STARFIELD.COUNT stars, deliberately
 *     kept near the low end of what the eye can register, so this layer reads
 *     as texture, not signal. The tactical grid rides its OWN rate
 *     (PARALLAX.GRID) on a separate tile.
 *   Layer 2 (parallax 0.45) — foreground cosmic dust, dimmed by DUST_ALPHA.
 *     Moves nearly half as fast as the ship, which is what actually sells
 *     speed; it does not need to be bright to do that.
 *
 * ---------------------------------------------------------------------------
 * FIFTH-PASS CORRECTION: THE CAUSTICS LATTICE WAS THE ACTUAL REPEATING PATTERN
 * ---------------------------------------------------------------------------
 * There USED to be a fourth layer here: the caustics shader
 * (caustics-shader.js), composed on top as a faint additive "energy lattice".
 * It is GONE, not merely dimmed, and it is worth recording exactly what it
 * was, because it is almost certainly what every earlier pass in this file's
 * history was actually fighting without knowing it.
 *
 * That shader evaluates two warped sine lattices in full-screen UV space every
 * frame (see the deleted CAUSTICS_TUNING.scaleA/scaleB) — which is to say, it
 * IS a procedural cellular/honeycomb pattern, running continuously, on top of
 * everything this file was otherwise doing to fix cellular/honeycomb
 * patterns. Its camera term was scaled by 0.00007, so a thousand-world-unit
 * flight moved its lattice by a fraction of a screen pixel: it read as static,
 * "identical at every position", regardless of how the nebula or starfield
 * beneath it changed. Every rework of THOSE layers was invisible proof against
 * a symptom that had never been in them.
 *
 * Nothing here toggles it back on. `usingShader`/`setShaderEnabled` are gone
 * along with the mesh; the file no longer imports caustics-shader.js at all.
 * That module still exists (tests/caustics-shader.test.js still exercises its
 * exports directly) — it is simply no longer wired into anything that renders.
 *
 * ---------------------------------------------------------------------------
 * SIXTH AND SEVENTH PASS: THE REAL BUG WAS A LEGACY ASSET, NOT THIS FILE
 * ---------------------------------------------------------------------------
 * After the caustics fix, the reported "repeating blue/purple pattern"
 * PERSISTED — because it had never come from this file at all. The starfield
 * layer used to accept a `voidTile` option and prefer it over its own
 * procedural texture; in production that option was fed a real, shipped
 * `bg_void.png` (build-time-generated sine-wave cyan/magenta nebula art), and
 * a real asset always wins a `??` fallback. Every rework of the nebula and
 * starfield across several sessions was correct and never once reached the
 * screen. See src/core/assets.js's ASSET_KEYS comment for the full account;
 * the fix was deleting that generator and the option that could feed its
 * output in, not touching this file's palette. That is the sixth pass.
 *
 * The seventh pass is a pure aesthetic correction on TOP of a now-confirmed-
 * working architecture: once the real bug was gone, the honest procedural
 * backdrop underneath it turned out to read as too stark, and — because a
 * single non-tiling Sprite cannot repeat no matter how it is coloured — there
 * was no longer a reason to hold the nebula's palette to the same "stay
 * near-black, avoid violet" caution a TILING layer needed. See NEBULA_HUES
 * for the richer palette that replaced it.
 *
 * ---------------------------------------------------------------------------
 * BLENDING IS LOAD-BEARING, NOT DECORATION
 * ---------------------------------------------------------------------------
 * The two TILED layers (stars, dust) blend additively: they are sparse,
 * mostly-transparent speckle, and additive is what lets them light up the
 * arena beneath without their own transparent black darkening it in turn.
 * `baseGfx`, the grid, and — since the EIGHTH pass, see BLEND's own comment
 * for why — the nebula all write `normal`, because each of those three is
 * already a complete, self-contained composite (an opaque rect, thin lines, a
 * canvas with its own baked-in dark rifts) rather than a sparse light source
 * that needs its own transparent black to disappear. An early version of this
 * backdrop composed EVERYTHING under normal blending regardless of which kind
 * of layer it was, which is what made it ship as a flat murky lattice with no
 * visible stars — a SPARSE layer's transparent black was still being blended
 * in, so each one partially DARKENED whatever was beneath it. The fix was
 * never "normal is wrong", it was "know which layers are sparse light and
 * which are not". Blend modes live in an exported `BLEND` table that tests
 * assert against, rather than as inline string literals nobody would
 * notice changing.
 *
 * ---------------------------------------------------------------------------
 * FOURTH-PASS CORRECTION: A TILED NEBULA CANNOT BE MADE TRULY APERIODIC
 * ---------------------------------------------------------------------------
 * Two earlier passes tried to fix nebula tiling from inside the tile: first by
 * enlarging it and replacing five fixed-position gradients with a continuous
 * noise field, then by pairing its size and parallax rate with the starfield's
 * so the two never realigned at the same offset. Both were real improvements
 * and neither was enough, because THE TILE STILL REPEATS — a TilingSprite
 * paints the exact same bitmap at every copy by definition. Noise softened the
 * shape of the repeat; it could not remove the repeat itself. A wide, zoomed-
 * out camera fits enough copies on screen simultaneously that even a
 * shapeless, cleverly-paired tile still reads as a grid, because the low
 * frequencies in that noise still happen to peak in roughly the same handful
 * of places every tile-width — the very thing a low-frequency-dominated field
 * is prone to.
 *
 * THE ACTUAL FIX IS TO STOP TILING THE NEBULA AT ALL. The arena is a bounded
 * $3240\times2160$ space, not an infinite scroller — which means, unlike an
 * endless runner, a single texture CAN afford to cover the whole thing. One
 * Sprite, one texture, drawn once: there is no second copy anywhere for the
 * eye to recognise, so "repeats every N pixels" stops being a question that
 * applies. `makeNebulaCanvas` paints one asymmetric diagonal dust stream —
 * deliberately NOT seamless, NOT periodic, because seamlessness was only ever
 * a requirement for something that tiles.
 *
 * The starfield and dust stay tiled. They are unstructured speckle at a
 * uniform, low-contrast density — there is no shape in them for the eye to
 * lock onto, so a repeat in either one was never the actual complaint.
 *
 * ---------------------------------------------------------------------------
 * PERFORMANCE
 * ---------------------------------------------------------------------------
 * The nebula canvas is baked ONCE at boot (a few hundred draw calls building
 * soft radial gradients, not a per-pixel field this time — see
 * `makeNebulaCanvas`), same as every other texture here. Per frame, the whole
 * backdrop costs one Sprite position write plus a couple of `tilePosition`
 * writes for the two remaining tiled layers — no allocation, no canvas work,
 * which is the 4GB-Chromebook budget this file has always been held to.
 *
 * ---------------------------------------------------------------------------
 * ZERO BYTES OF ASSETS, WITH A DROP-IN BRIDGE
 * ---------------------------------------------------------------------------
 * Every texture here is generated once at boot with no file on disk — the
 * game runs and is tested against an empty /assets folder. `tryLoadNebulaImage`
 * is the one deliberate exception: it is a best-effort, self-contained probe
 * for a real `bg_space.webp`/`.png` an artist can drop in later with no code
 * changes, kept OUTSIDE the ASSET_MANIFEST/AssetStore pipeline on purpose (see
 * that function's own doc comment for why). Its absence — the default,
 * shipped state — changes nothing: the procedural canvas is used exactly as
 * if the bridge did not exist.
 *
 * Follows the "Visual Soup" luminance split contract (theme.js): every
 * large-area colour here sits near black so the Drifter stays the brightest
 * thing on screen.
 */

import { Assets, Container, Graphics, Sprite, TilingSprite, Texture } from 'pixi.js';
import { WORLD } from '../core/constants.js';
import { ASSET_ROOT } from '../core/assets.js';
import { THEME } from './theme.js';

/**
 * Parallax rates.
 *
 * NEBULA_WORLD is a fraction of camera travel applied to a WORLD-PINNED
 * Sprite's own position, not a tiling rate — see `positionNebula`. It is
 * small and deliberately so: the nebula is meant to feel almost fixed to the
 * arena, with just enough drift relative to the foreground to read as
 * "distant" rather than "glued to the screen".
 *
 * STARS/GRID/DUST are unchanged from the tiled-layer scheme: a fraction of
 * camera travel applied to a TilingSprite's `tilePosition`, scaled by zoom in
 * `update` so the rate means the same fraction of the world's apparent motion
 * at any viewport.
 */
export const PARALLAX = {
  NEBULA_WORLD: 0.03,
  STARS: 0.058,
  GRID: 0.15,
  DUST: 0.45,
};

/**
 * Tactical grid: spacing in WORLD units, how faint it is drawn, and the cell
 * size of the tile it is baked into.
 *
 * The spacing is held in world units rather than pixels because the grid's only
 * job is to give the eye something of known size to measure travel against. A
 * grid pinned to screen pixels would change apparent scale every time the zoom
 * did — it would say the ship had got faster when the viewport merely got
 * shorter. `gridLayer.tileScale` is re-derived from the live zoom on every
 * resize to hold the world spacing constant instead.
 */
export const GRID = {
  SPACING: 100,
  /**
   * Right at the edge of the 8-bit quantisation floor this value has crossed
   * more than once (see git history): visible enough against the swarm's
   * darker tones to work as a speed cue, faint enough to stay subliminal.
   */
  ALPHA: 0.05,
  /** Cell size of the baked tile, in texture pixels. */
  CELL_PX: 128,
};

/**
 * Deep space black — the ground everything else is lifted off, and the Pixi
 * renderer's own clear colour (see renderer.js — the two are pinned to the
 * same value rather than picked independently, so a resize's one-frame gap
 * between the clear and this layer's own repaint is invisible). Matches
 * NEBULA_BASE: the nebula canvas's opaque background fill and the void
 * beneath it are the same near-black, so the Sprite reads as part of the
 * void rather than a rectangle sitting on top of it.
 */
export const VOID_BASE = 0x020307;

/**
 * Blend modes, named here rather than inline because they are the load-bearing
 * half of this file's fix.
 *
 * WHY THE TILED LAYERS ARE ADDITIVE. Stars and dust are sparse, mostly-
 * transparent speckle over a screen-space repeat — additive is what lets them
 * light up the swarm-dark arena beneath without their own transparent black
 * darkening it in turn.
 *
 * WHY THE NEBULA IS `normal`, NOT `screen` — EIGHTH PASS. It used to be
 * `screen`, and screen blending is exactly what turned the seventh pass's
 * richer palette into a wash: `screen` has no ceiling of its own short of
 * white, so a canvas whose gas puffs already cover much of its area, stacked
 * under `screen`, keeps compounding brighter wherever puffs overlap with no
 * natural floor. `normal` does not have that property — a semi-transparent
 * puff blended `normal` can only ever move the pixel TOWARD that puff's own
 * (deliberately capped, see NEBULA_HUES) colour, never past it, however many
 * puffs stack. Safe here specifically because the nebula canvas's own base
 * fill is fully OPAQUE (`ctx.fillRect` with no alpha) — under `normal` blend
 * the Sprite simply replaces whatever was behind it with its own finished
 * composite, which is exactly "the void, with some genuinely dark rifts and
 * some genuinely bright gas painted into it" rather than a light added on
 * top of something else.
 */
export const BLEND = {
  NEBULA: 'normal',
  STARS: 'add',
  DUST: 'add',
};

/**
 * Object alpha for the foreground dust layer — the single dial that controls
 * how much of the layer's colour actually reaches the screen, kept separate
 * from the per-speck alphas baked into the texture (see makeDustTexture).
 */
export const DUST_ALPHA = 0.16;

/**
 * Starfield generation parameters, gathered here (rather than as literals
 * inside makeStarfieldTexture) so a density or brightness pass has one place
 * to look, and so tests/background.test.js can assert the shipped numbers
 * directly against the design brief instead of trusting the generator.
 *
 * ONE FLAT POPULATION, DELIBERATELY. An earlier pass split stars into a large
 * dim population and a small bright one for depth. This pass collapses that
 * back to one low-contrast band: even a SMALL brighter population reads as its
 * own little cluster of "the eye-catching stars", which is a second, subtler
 * version of the exact "clustered blobs" complaint the nebula rework exists to
 * remove for clouds. One narrow radius/alpha band has nothing in it to cluster
 * into.
 */
export const STARFIELD = {
  /**
   * Tile dimension, in texture pixels. Large enough that the tile itself
   * repeats rarely at the wide zoomed-out camera this game ships with.
   */
  TILE_SIZE: 1536,
  /**
   * A perfect square (17^2) so a 17x17 jittered grid — see
   * makeStarfieldTexture — covers the tile with exactly one star per cell and
   * no remainder to place some other way. Falls inside the 250-350 design
   * band.
   */
  COUNT: 289,
  /** [min, max] radius, px. */
  RADIUS: [0.6, 1.4],
  /** [min, max] alpha. */
  ALPHA: [0.15, 0.4],
  /**
   * Colour-temperature split for the star population — three named tones
   * rather than the flat cool-white/grey pair an earlier pass used. Ratios
   * sum to 1; kept as an object (not three bare numbers) so
   * tests/background.test.js can assert the shares directly.
   *
   * STILL "ONE POPULATION" IN THE SENSE THAT MATTERS. The earlier pass's
   * objection to a two-tier system was about a size/alpha split creating its
   * own small cluster of "the eye-catching stars" — a structural clumping
   * risk. Varying HUE while every star keeps the same radius/alpha band
   * carries no such risk: nothing about a star's brightness or size marks it
   * as special, so there is nothing for the eye to cluster onto, only a
   * gentle temperature variation across an otherwise uniform field.
   */
  COLOR_MIX: {
    /** Cool diamond white, #e6f0fa. */
    WHITE: 0.75,
    /** Pale cyan / neon blue, #88ddff. */
    CYAN: 0.15,
    /** Warm amber / faint gold, #ffd288. */
    AMBER: 0.1,
  },
};

/**
 * How much larger than the arena the single nebula Sprite is drawn, in WORLD
 * units. The margin is what makes the parallax drift (PARALLAX.NEBULA_WORLD)
 * safe: the sprite is bigger than any possible camera view PLUS the maximum
 * drift, so `positionNebula`'s clamp has real room to work with rather than
 * clamping against zero slack.
 */
export const NEBULA_WORLD_MARGIN = 1.15;

/** Resolution the nebula canvas is baked at — independent of the arena's own
 * world-unit dimensions, since the Sprite stretches it to fit either way. */
export const NEBULA_CANVAS_SIZE = { width: 2048, height: 1365 };

/**
 * Deep-space base fill for the nebula canvas.
 *
 * EIGHTH PASS: THE SEVENTH PASS'S OWN RICHNESS WAS THE NEW PROBLEM. Six hues
 * at alpha up to 0.4, painted as 6-8 CIRCLES 600-1100px across on a
 * 2048x1365 canvas, cover most of the canvas by simple geometry — a handful
 * of near-1000px-radius discs cannot help but overlap into a field, and
 * `screen` blending a field of them is indistinguishable from a wash. The
 * seventh pass's fix for "too stark" overshot into "too flooded" the same way
 * the second pass once overshot on brightness — asking for colour and asking
 * for a GAS CLOUD SILHOUETTE turn out to be different requests, and this pass
 * is the second of the two. See NEBULA_PUFF and NEBULA_RIFT for how: many
 * SMALL, elongated, alpha-capped puffs along a narrow path, then genuinely
 * dark rifts carved back through them, rather than a few huge bright ones.
 */
export const NEBULA_BASE = '#020307';
/** `NEBULA_BASE` as an "r, g, b" triple — what the dust rifts are painted in. */
export const NEBULA_BASE_RGB = '2, 3, 7';

/**
 * Puff generation parameters for the glowing gas filament (see
 * `makeNebulaCanvas`'s "Filament Backbone" section).
 *
 * WHY MANY SMALL PUFFS READ AS A CLOUD AND FEW LARGE ONES READ AS A GRADIENT.
 * A single 900px soft-edged circle IS a radial gradient, visually — there is
 * no texture in one primitive for the eye to resolve. Forty 100-350px puffs,
 * each independently jittered in position, radius and elongation and packed
 * along a narrow corridor, overlap each other at ragged, irregular edges;
 * THAT irregularity, not the colour underneath it, is what reads as "gas"
 * rather than "gradient". The corridor is deliberately narrow (see
 * `PERP_SPREAD`) — scattered too widely, the puffs stop overlapping enough to
 * blend into a ribbon and just read as separate dots.
 */
export const NEBULA_PUFF = {
  /** Puff count. Within the 30-50 the brief asks for. */
  COUNT: 40,
  /** [min, max] puff radius, px, BEFORE the elongation scale below. */
  RADIUS: [100, 350],
  /**
   * [min, max] scale along the filament's own tangent direction, and
   * across it. Elongating along-tangent more than across is what turns a
   * scaled circle into a wisp pointing the same way the filament runs,
   * rather than a randomly-oriented blob that happens to sit near it.
   *
   * Capped at 1.7 rather than higher: a puff's full reach is
   * `RADIUS.max * ALONG_SCALE.max` (595px at 1.7), which has to stay well
   * under half the canvas's shorter edge (1365px) or a single puff's own
   * worst-case extent starts to rival the corridor's intended width and the
   * "many small wisps" premise breaks down into "a few long streaks".
   */
  ALONG_SCALE: [1.1, 1.7],
  ACROSS_SCALE: [0.5, 0.9],
  /**
   * How far a puff may jitter perpendicular to the backbone path, as a
   * fraction of the canvas height, at the filament's WIDEST point (the
   * middle — tapered to 0 at both ends exactly as the diagonal stream's
   * taper worked in earlier passes). Narrow on purpose: this is the number
   * that keeps the puffs overlapping into one ribbon instead of dispersing
   * into a scatter of separate clouds. 0.16 of a 1365px-tall canvas is
   * ~218px of half-width at the widest point — comparable to the puffs'
   * own radius, so most of them still touch their neighbours.
   */
  PERP_SPREAD: 0.16,
};

/**
 * Dark absorption-dust generation parameters (see `makeNebulaCanvas`'s
 * "Dark Absorption Dust Lanes" section) — the shapes carved back through the
 * gas puffs afterward, painted in NEBULA_BASE itself so they read as
 * genuinely dark rifts rather than merely dimmer gas.
 */
export const NEBULA_RIFT = {
  /** Rift count. Within the 4-8 the brief asks for. */
  COUNT: 6,
  /** [min, max] rift radius, px, before elongation. */
  RADIUS: [80, 220],
  /** [min, max] rift opacity — deliberately much higher than a puff's, since
   * these need to read as absorption, not as a fainter colour. */
  ALPHA: [0.4, 0.7],
  /** Rifts are drawn MORE elongated than puffs — thin tendrils threading
   * through the gas, not round dark blobs sitting on top of it. */
  ALONG_SCALE: [1.6, 2.6],
  ACROSS_SCALE: [0.3, 0.55],
  /**
   * Rifts are confined to a NARROWER band than puffs (a fraction of
   * NEBULA_PUFF.PERP_SPREAD) and to the interior of the path (never the
   * tapered ends) — a rift has to land ON the gas to carve anything; placed
   * as widely as the puffs, most of them would land in bare void and do
   * nothing visible.
   */
  PERP_SPREAD_FACTOR: 0.6,
};

/**
 * The glowing gas palette: three named cosmic tones, each with its own alpha
 * band, matching the brief exactly.
 *
 * "TRAILING ALONG THE EDGES" IS IMPLEMENTED AS A PLACEMENT RULE, NOT A COLOUR
 * ONE. TEAL only gets a chance to be picked for puffs sitting toward the
 * OUTER part of the filament's cross-section (see `pickHue` in
 * makeNebulaCanvas); puffs near the backbone itself draw only from the two
 * core hues. That is what makes the teal read as a fringe around a violet
 * core rather than three colours shuffled at random through the same volume.
 */
export const NEBULA_HUES = {
  /** Deep Cosmic Orchid / Violet core, #32104d. */
  ORCHID: { rgb: '50, 16, 77', alpha: [0.18, 0.24] },
  /** Electric Indigo core, #121b52. */
  INDIGO: { rgb: '18, 27, 82', alpha: [0.16, 0.22] },
  /** Bioluminescent Cyan/Teal fringe, #093d42. */
  TEAL: { rgb: '9, 61, 66', alpha: [0.1, 0.15] },
};

/**
 * Candidate paths for a drop-in nebula background image, tried in order.
 * Neither file ships with this game — see `tryLoadNebulaImage`.
 */
export const NEBULA_IMAGE_CANDIDATES = [`${ASSET_ROOT.UI}bg_space.webp`, `${ASSET_ROOT.UI}bg_space.png`];

/**
 * Best-effort probe for a drop-in nebula image, so an artist can later ship
 * `public/assets/ui/bg_space.webp` (or `.png`) with no code changes.
 *
 * DELIBERATELY OUTSIDE ASSET_MANIFEST/AssetStore. That pipeline asserts (see
 * tests/assets.test.js, "ships a standalone file for every non-atlas entry")
 * that every manifest URL resolves to a file actually staged in the repo —
 * correctly, for art that is supposed to already exist. This asset is the
 * opposite case: genuinely optional, and absent from this repository by
 * design, so it cannot go through a pipeline that requires it to be present
 * without breaking that test. This function is the self-contained substitute:
 * it tries each candidate, in order, and resolves to `null` — NEVER throws —
 * the moment none of them load, which `Background` reads as "use the
 * procedural canvas". A 404 is the expected, common case, not a failure.
 *
 * Called from `Renderer.create()` (already async) BEFORE `Background` is
 * constructed, so `Background` itself stays fully synchronous and every
 * existing test that builds one directly is unaffected.
 *
 * @returns {Promise<import('pixi.js').Texture|null>}
 */
export async function tryLoadNebulaImage() {
  for (const url of NEBULA_IMAGE_CANDIDATES) {
    try {
      const texture = await Assets.load(url);
      if (texture) return texture;
    } catch {
      // Expected the overwhelming majority of the time: no file at this path.
    }
  }
  return null;
}

function getViewportDimensions() {
  if (typeof window !== 'undefined') {
    return { width: window.innerWidth || 800, height: window.innerHeight || 600 };
  }
  return { width: 800, height: 600 };
}

function safeTextureFrom(canvas) {
  try {
    return Texture.from(canvas);
  } catch {
    return Texture.EMPTY;
  }
}

/**
 * Fixed-seed LCG. See the module header for why the sky must not reshuffle.
 *
 * @param {number} seed
 * @returns {() => number} Floats in [0, 1)
 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * Draw a blob at (x, y) AND at every wrapped copy of it that its tile needs.
 *
 * WHY THIS EXISTS. A star drawn 3px from the tile's left edge has half its
 * glow clipped off, and the matching half never appears on the right edge — so
 * the seam is visible as a row of chopped stars the moment the camera pans. The
 * fix is to draw anything near an edge a second (or, in a corner, a fourth)
 * time offset by the tile size, so the halves meet across the wrap.
 *
 * Used by the two layers that still TILE (stars, dust). The nebula canvas is
 * no longer one of them — see the module header — so it has no seam to patch.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} size - Tile dimension
 * @param {number} reach - How far the mark extends from its centre
 * @param {(cx: number, cy: number) => void} draw
 */
function drawWrapped(ctx, x, y, size, reach, draw) {
  const xs = [x];
  const ys = [y];
  if (x < reach) xs.push(x + size);
  else if (x > size - reach) xs.push(x - size);
  if (y < reach) ys.push(y + size);
  else if (y > size - reach) ys.push(y - size);

  for (const cx of xs) {
    for (const cy of ys) draw(cx, cy);
  }
}

/**
 * The nebula's curving backbone: a cubic Bezier from the upper-left toward
 * centre-right, NOT corner-to-corner. A shorter, curved path (rather than the
 * full diagonal earlier passes used) is part of what keeps this a contained
 * "ribbon" instead of a band spanning the whole canvas — the void beyond
 * either end of the curve is never touched at all.
 */
export const NEBULA_PATH = {
  p0: { x: 0.08, y: 0.12 },
  p1: { x: 0.38, y: 0.04 },
  p2: { x: 0.55, y: 0.4 },
  p3: { x: 0.62, y: 0.56 },
};

/**
 * Point on the nebula's cubic Bezier backbone, in canvas pixels.
 * @param {number} width
 * @param {number} height
 * @param {number} t - [0, 1]
 * @returns {{x: number, y: number}}
 */
function nebulaPathPoint(width, height, t) {
  const { p0, p1, p2, p3 } = NEBULA_PATH;
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: (a * p0.x + b * p1.x + c * p2.x + d * p3.x) * width,
    y: (a * p0.y + b * p1.y + c * p2.y + d * p3.y) * height,
  };
}

/**
 * Unit tangent of the backbone at `t`, in canvas space (y grows downward, as
 * every canvas coordinate here does).
 * @param {number} width
 * @param {number} height
 * @param {number} t - [0, 1]
 * @returns {{x: number, y: number, angle: number}}
 */
function nebulaPathTangent(width, height, t) {
  const { p0, p1, p2, p3 } = NEBULA_PATH;
  const mt = 1 - t;
  const dx = (3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x)) * width;
  const dy = (3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y)) * height;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len, angle: Math.atan2(dy, dx) };
}

/**
 * Paint one elongated, soft-edged puff at a point along the nebula backbone.
 *
 * The ellipse is built by rotating the canvas to align its local x-axis with
 * the supplied angle and then non-uniformly scaling — `ctx.scale(along,
 * across)` — before drawing an ordinary radial gradient of radius `r`
 * centred on the origin. Scaling AFTER rotating is what makes "along" mean
 * "along the filament direction" rather than "along the canvas x-axis".
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx
 * @param {number} cy
 * @param {number} angle - Radians; the ellipse's long axis direction
 * @param {number} r - Base (pre-scale) radius, px
 * @param {number} along - Scale along `angle`
 * @param {number} across - Scale perpendicular to `angle`
 * @param {string} rgb - "r, g, b"
 * @param {number} alpha - Core alpha; the brief's 3-stop falloff is applied here
 */
function paintNebulaPuff(ctx, cx, cy, angle, r, along, across, rgb, alpha) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(along, across);

  // 0% -> full alpha, 40% -> 0.4x, 100% -> transparent: the brief's exact
  // falloff shape, chosen (like the previous pass's 50%-midpoint version) to
  // feather a soft edge rather than show the gradient curve's own inflection
  // as a faint ring.
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0, `rgba(${rgb}, ${alpha})`);
  grad.addColorStop(0.4, `rgba(${rgb}, ${alpha * 0.4})`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(-r, -r, r * 2, r * 2);

  ctx.restore();
}

/**
 * Layer 0 — the single, arena-pinned nebula canvas.
 *
 * EIGHTH PASS: A CLUSTERED FILAMENT, NOT A HANDFUL OF GIANT CIRCLES. Built in
 * two ordered stages on one 2048x1365 canvas:
 *
 *   1. FILAMENT BACKBONE. NEBULA_PUFF.COUNT (40) small, independently
 *      jittered, elongated puffs (NEBULA_PUFF.RADIUS 100-350px, stretched by
 *      ALONG_SCALE/ACROSS_SCALE) are scattered in a narrow band around the
 *      curving Bezier path in NEBULA_PATH. Their ragged, overlapping edges —
 *      not their colour — are what reads as gas rather than gradient; see
 *      NEBULA_PUFF's own doc comment.
 *   2. DARK ABSORPTION RIFTS. NEBULA_RIFT.COUNT (6) elongated shapes, painted
 *      in NEBULA_BASE itself at a MUCH higher alpha (0.4-0.7) than any puff,
 *      are drawn back over the same band afterward. Because canvas
 *      compositing is ordered, these genuinely darken the gas beneath them —
 *      not "a fainter patch of colour" but an actual absorption lane, the way
 *      real nebulae (Orion, Carina) are cut through by dark dust.
 *
 * Everywhere outside the narrow band around the path — which is most of a
 * 2048x1365 canvas, given puffs cap out at 350px and the perpendicular spread
 * is a fraction of the canvas height — is untouched NEBULA_BASE: this is what
 * keeps the result 70%+ void by construction rather than by a luminance
 * budget checked after the fact.
 *
 * NOT SEAMLESS, AND THAT IS CORRECT. This canvas feeds a single Sprite
 * (`Background` stretches it via NEBULA_WORLD_MARGIN), never a TilingSprite —
 * its edges are never adjacent to a second copy of themselves, so there is no
 * wrap to preserve.
 *
 * Deterministic (fixed-seed LCG): the same unique nebula on every reload,
 * exactly like every other texture in this file.
 *
 * @returns {import('pixi.js').Texture}
 */
export function makeNebulaCanvas() {
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  const { width, height } = NEBULA_CANVAS_SIZE;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;

  ctx.fillStyle = NEBULA_BASE;
  ctx.fillRect(0, 0, width, height);

  const rand = seeded(20260915);

  /**
   * Pick a hue for a puff at fractional cross-section position `edge`
   * (0 = on the backbone, 1 = at the widest perpendicular jitter allowed).
   * Teal is the ONLY option once `edge` crosses 0.55, and never an option
   * before that — this is what makes the teal a fringe trailing the outside
   * of the violet/indigo core rather than a colour mixed uniformly through
   * the whole ribbon. Below the threshold, Orchid and Indigo alternate.
   *
   * @param {number} edge - [0, 1]
   * @param {number} i - Puff index, for the core alternation
   * @returns {{rgb: string, alpha: [number, number]}}
   */
  const pickHue = (edge, i) => {
    if (edge > 0.55) return NEBULA_HUES.TEAL;
    return i % 2 === 0 ? NEBULA_HUES.ORCHID : NEBULA_HUES.INDIGO;
  };

  // --- Stage 1: the glowing filament backbone -----------------------------
  for (let i = 0; i < NEBULA_PUFF.COUNT; i++) {
    // Walk the path with jitter, same principle as earlier passes: an
    // evenly-spaced walk is its own kind of visible regularity.
    const t = (i + 0.15 + rand() * 0.7) / NEBULA_PUFF.COUNT;
    const point = nebulaPathPoint(width, height, t);
    const tangent = nebulaPathTangent(width, height, t);
    const perpX = -tangent.y;
    const perpY = tangent.x;

    // Tapered toward both ends, exactly as earlier passes tapered their
    // diagonal stream — the filament's own two tips stay narrow rather than
    // the cluster spreading out right up to where the path starts and ends.
    const taper = Math.sin(t * Math.PI);
    const maxPerp = height * NEBULA_PUFF.PERP_SPREAD * taper;
    const perpFrac = rand() * 2 - 1; // [-1, 1]
    const perp = perpFrac * maxPerp;

    const cx = point.x + perpX * perp;
    const cy = point.y + perpY * perp;

    const [radiusMin, radiusMax] = NEBULA_PUFF.RADIUS;
    const r = radiusMin + rand() * (radiusMax - radiusMin);
    const [alongMin, alongMax] = NEBULA_PUFF.ALONG_SCALE;
    const [acrossMin, acrossMax] = NEBULA_PUFF.ACROSS_SCALE;
    const along = alongMin + rand() * (alongMax - alongMin);
    const across = acrossMin + rand() * (acrossMax - acrossMin);

    const hue = pickHue(Math.abs(perpFrac), i);
    const [alphaMin, alphaMax] = hue.alpha;
    const alpha = alphaMin + rand() * (alphaMax - alphaMin);

    // Slight random rotation off the pure tangent angle so puffs are not all
    // identically oriented — another source of the raggedness a uniform
    // field of parallel ellipses would lack.
    const angle = tangent.angle + (rand() - 0.5) * 0.6;
    paintNebulaPuff(ctx, cx, cy, angle, r, along, across, hue.rgb, alpha);
  }

  // --- Stage 2: dark absorption rifts, carved back through the gas --------
  for (let i = 0; i < NEBULA_RIFT.COUNT; i++) {
    // Kept off the path's own tapered tips (0.12-0.88) — a rift has to land
    // ON gas to carve anything, and the tips are the thinnest, sparsest part
    // of the filament.
    const t = 0.12 + rand() * 0.76;
    const point = nebulaPathPoint(width, height, t);
    const tangent = nebulaPathTangent(width, height, t);
    const perpX = -tangent.y;
    const perpY = tangent.x;

    const taper = Math.sin(t * Math.PI);
    const maxPerp = height * NEBULA_PUFF.PERP_SPREAD * NEBULA_RIFT.PERP_SPREAD_FACTOR * taper;
    const perp = (rand() * 2 - 1) * maxPerp;

    const cx = point.x + perpX * perp;
    const cy = point.y + perpY * perp;

    const [radiusMin, radiusMax] = NEBULA_RIFT.RADIUS;
    const r = radiusMin + rand() * (radiusMax - radiusMin);
    const [alongMin, alongMax] = NEBULA_RIFT.ALONG_SCALE;
    const [acrossMin, acrossMax] = NEBULA_RIFT.ACROSS_SCALE;
    const along = alongMin + rand() * (alongMax - alongMin);
    const across = acrossMin + rand() * (acrossMax - acrossMin);
    const [alphaMin, alphaMax] = NEBULA_RIFT.ALPHA;
    const alpha = alphaMin + rand() * (alphaMax - alphaMin);

    const angle = tangent.angle + (rand() - 0.5) * 0.5;

    // `source-over` (the canvas default) rather than an erase/mask operation:
    // the brief calls for exactly this — a soft-edged, semi-transparent
    // NEBULA_BASE shape alpha-composited over the gas, so it reads as a dark
    // dust lane THROUGH the cloud rather than a hole punched in it.
    ctx.globalCompositeOperation = 'source-over';
    paintNebulaPuff(ctx, cx, cy, angle, r, along, across, NEBULA_BASE_RGB, alpha);
  }

  return safeTextureFrom(canvas);
}

/**
 * Layer 1a — the tactical grid.
 *
 * One cell per tile, so the sprite's `tileScale` alone sets the cell size and
 * the wrap can never step at the seam. Its own layer rather than baked in with
 * the stars because the two have to scale differently: the grid tracks the
 * zoom to hold a constant world spacing, while the stars must stay at 1:1 or
 * they shrink below a pixel and disappear on a zoomed-out mobile viewport.
 *
 * @returns {import('pixi.js').Texture}
 */
export function makeGridTexture() {
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  const size = GRID.CELL_PX;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;

  ctx.clearRect(0, 0, size, size);

  // Two lines only — the left and top edges of the cell. The neighbouring tile
  // supplies the other two, which is what makes an arbitrary tileScale safe.
  ctx.strokeStyle = THEME.background.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0.5, 0);
  ctx.lineTo(0.5, size);
  ctx.moveTo(0, 0.5);
  ctx.lineTo(size, 0.5);
  ctx.stroke();

  return safeTextureFrom(canvas);
}

/**
 * Layer 1b — the distant starfield.
 *
 * STARFIELD.COUNT stars on a STARFIELD.TILE_SIZE (1536) tile, ONE flat
 * low-contrast radius/alpha band — see the constant's own doc comment for why
 * a two-TIER brightness split was dropped, and why a three-way HUE mix
 * (STARFIELD.COLOR_MIX) is not the same kind of risk and stayed.
 *
 * A JITTERED GRID, NOT INDEPENDENT RANDOM SCATTER. Pure uniform random
 * placement can still produce a visible clump by chance, especially at a
 * density low enough to read as "sparse distant sky" rather than noise — and
 * a clump is its own tiling cue on top of the tile-size question: "the little
 * cluster near the top" is exactly the kind of landmark that gives a repeat
 * away. STARFIELD.COUNT is a perfect square (17^2) so a 17x17 lattice of
 * cells covers the tile with EXACTLY one star per cell and no remainder to
 * place some other way; each star is then jittered to a random point inside
 * its own cell, so the placement still looks organic while a clump becomes
 * structurally impossible rather than merely unlikely.
 *
 * @returns {import('pixi.js').Texture}
 */
export function makeStarfieldTexture() {
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  const size = STARFIELD.TILE_SIZE;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;

  ctx.clearRect(0, 0, size, size);

  const rand = seeded(20260915);
  const [radiusMin, radiusMax] = STARFIELD.RADIUS;
  const [alphaMin, alphaMax] = STARFIELD.ALPHA;

  const gridDim = Math.round(Math.sqrt(STARFIELD.COUNT));
  const cellSize = size / gridDim;

  for (let gy = 0; gy < gridDim; gy++) {
    for (let gx = 0; gx < gridDim; gx++) {
      // Jittered anywhere inside the cell, including right up to its edges —
      // drawWrapped below is what keeps a star jittered near a TILE edge from
      // showing as a clipped seam, exactly as it always has.
      const x = (gx + rand()) * cellSize;
      const y = (gy + rand()) * cellSize;

      const r = radiusMin + rand() * (radiusMax - radiusMin);
      const a = alphaMin + rand() * (alphaMax - alphaMin);

      // Three colour temperatures, per STARFIELD.COLOR_MIX: mostly cool
      // diamond white, a minority pale cyan, a smaller minority warm amber.
      // The thresholds are cumulative shares of the mix, not independent
      // rolls, so they always sum to the configured ratios exactly.
      const roll = rand();
      const rgb =
        roll < STARFIELD.COLOR_MIX.WHITE
          ? '230, 240, 250' // #e6f0fa
          : roll < STARFIELD.COLOR_MIX.WHITE + STARFIELD.COLOR_MIX.CYAN
            ? '136, 221, 255' // #88ddff
            : '255, 210, 136'; // #ffd288

      drawWrapped(ctx, x, y, size, r + 1, (cx, cy) => {
        ctx.fillStyle = `rgba(${rgb}, ${a})`;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  return safeTextureFrom(canvas);
}

/**
 * Layer 2 — foreground cosmic dust.
 *
 * A SPARSE 256 tile: ~40 specks, most of them under a pixel. Sparse is the
 * point. At parallax 0.45 this layer moves fast, and a dense fast layer reads
 * as television static crawling over the arena — it fights the swarm for the
 * player's attention and loses the Drifter in the noise. Forty faint motes are
 * enough to feel the ship moving and few enough to ignore.
 *
 * The per-speck alphas below (0.35-0.8) look brighter than the layer actually
 * reads on screen — that is intentional and it is DUST_ALPHA's job, not this
 * function's, to bring them down to their final 0.12-0.20-ish visibility.
 *
 * @returns {import('pixi.js').Texture}
 */
export function makeDustTexture() {
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  const size = 256;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.WHITE;

  ctx.clearRect(0, 0, size, size);

  const rand = seeded(778899);

  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.8 + rand() * 1.1;
    const a = 0.35 + rand() * 0.45;

    drawWrapped(ctx, x, y, size, r + 1, (cx, cy) => {
      ctx.fillStyle = `rgba(206, 232, 255, ${a})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  return safeTextureFrom(canvas);
}

/**
 * Kept for the asset pipeline and any caller that still asks for a void tile:
 * the starfield IS the void tile now.
 *
 * @returns {import('pixi.js').Texture}
 */
export function makeVoidTileTexture() {
  return makeStarfieldTexture();
}

export class Background {
  /**
   * @param {import('pixi.js').Application} app
   * @param {Object} [options]
   * @param {*} [options.nebulaImage] - Drop-in nebula texture, from
   *   `tryLoadNebulaImage()`. Used, stretched to the arena-covering Sprite,
   *   when present; the procedural canvas stands in otherwise.
   *
   *   NO `voidTile` OPTION, DELIBERATELY — one used to exist here, accepting a
   *   shipped starfield texture and preferring it over `makeStarfieldTexture()`
   *   via `voidTile ?? makeStarfieldTexture()`. It was how a legacy
   *   bg_void.png (blue/purple nebula-cloud art from before this backdrop
   *   became procedural) silently overrode every tuned starfield pass for
   *   several sessions running: a real asset always wins a `??` fallback,
   *   however wrong that asset now is for the design. The starfield is
   *   ALWAYS `makeStarfieldTexture()` now. A future drop-in for it should
   *   get its own reviewed bridge, the way `tryLoadNebulaImage` is for the
   *   nebula — not a silent asset-manifest fallback.
   */
  constructor(app, { nebulaImage = null } = {}) {
    /*
     * Hard diagnostic. This exists for one reason: to distinguish "the new
     * background code never actually reached the browser" (a stale build, a
     * cache, a bundling error swallowed somewhere) from "the new code ran and
     * still looks wrong" — two failure modes that otherwise look identical
     * from a screenshot. If this line is not in the console, nothing else in
     * this file is running yet, however new the source looks in the editor.
     */
    console.log(
      '%c[BloomWake Background]%c Initialized: Single Non-Tiling Mode (Caustics DISABLED)',
      'background: #00e5ff; color: #000; font-weight: bold;',
      'color: #fff;'
    );

    this.app = app;
    this.time = 0;

    /**
     * Camera position as of the previous frame, so `update` can derive camera
     * VELOCITY without the caller having to supply it. Null until the first
     * real `update` call — the dust-drift smoothing below is keyed off that,
     * because feeding it a synthetic "previous position" would read the first
     * frame's camera snap as an enormous instantaneous velocity spike.
     */
    this.lastCameraX = null;
    this.lastCameraY = null;
    /** Smoothed camera velocity in px/s, so the dust does not jitter. */
    this.driftX = 0;
    this.driftY = 0;

    /**
     * Camera position `positionNebula` was last given — SEPARATE from
     * `lastCameraX/Y` above, and deliberately defaulted to the arena centre
     * rather than left null. `resize()` calls `positionNebula` directly (so a
     * resize alone, before the next `update`, still leaves the sprite
     * correctly placed rather than stale), and it needs SOME camera position
     * to do that with before any real one has ever arrived — the arena centre
     * is the same assumption the camera itself starts a run centred on.
     */
    this.nebulaCameraX = WORLD.WIDTH / 2;
    this.nebulaCameraY = WORLD.HEIGHT / 2;

    this.container = new Container();

    /**
     * Live camera zoom, pushed in by `resize`. The tiled layers' parallax
     * rates are fractions of the WORLD's apparent motion, so every one of
     * them has to be multiplied by the zoom — see `update`. The nebula
     * Sprite's on-screen size is scaled by it too, for the same reason.
     */
    this.zoom = 1;

    this.textures = {
      nebula: nebulaImage ?? makeNebulaCanvas(),
      grid: makeGridTexture(),
      stars: makeStarfieldTexture(),
      dust: makeDustTexture(),
    };

    const { width, height } = getViewportDimensions();

    // Base: the void itself. Everything above is translucent, so this is what
    // the player is actually looking at between the stars.
    this.baseGfx = new Graphics();
    this.container.addChild(this.baseGfx);

    // Layer 0 — the single arena-pinned nebula. A plain Sprite, not a
    // TilingSprite: see the module header's FOURTH-PASS section for why a
    // repeating tile can never fully solve this, however it is drawn.
    this.nebulaSprite = new Sprite(this.textures.nebula);
    this.nebulaSprite.blendMode = BLEND.NEBULA;
    this.container.addChild(this.nebulaSprite);

    // Layer 1a — tactical grid (its own PARALLAX.GRID rate, scaled to hold 100
    // world units). Normal blending: the grid is a drawn LINE, not a light
    // source, and under add it would tint rather than read as structure.
    this.gridLayer = new TilingSprite({ texture: this.textures.grid, width, height });
    this.gridLayer.alpha = GRID.ALPHA;
    this.container.addChild(this.gridLayer);

    // Layer 1b — distant starfield (parallax 0.058, always 1:1 so stars survive).
    this.starLayer = new TilingSprite({ texture: this.textures.stars, width, height });
    this.starLayer.alpha = 1;
    this.starLayer.blendMode = BLEND.STARS;
    this.container.addChild(this.starLayer);

    // Layer 2 — foreground cosmic dust (parallax 0.45).
    this.dustLayer = new TilingSprite({ texture: this.textures.dust, width, height });
    this.dustLayer.alpha = DUST_ALPHA;
    this.dustLayer.blendMode = BLEND.DUST;
    this.container.addChild(this.dustLayer);

    // There used to be a fourth layer here — the caustics shader, composed on
    // top as a faint additive lattice. It is gone; see the module header's
    // FIFTH-PASS section for why. Nothing replaces it.

    this.drawVoid(width, height);
    this.resize(width, height);
  }

  drawVoid(width, height) {
    const g = this.baseGfx;
    g.clear();
    g.rect(0, 0, width, height);
    g.fill({ color: VOID_BASE });
  }

  /**
   * Position the single nebula Sprite for the given camera state.
   *
   * The Sprite is sized (in `resize`) to `WORLD.WIDTH/HEIGHT * NEBULA_WORLD_MARGIN`
   * scaled by zoom — comfortably larger than any viewport at any legal zoom.
   * At rest (camera centred on the arena) it is centred under the viewport;
   * as the camera pans, it drifts by a SMALL fraction of that pan
   * (PARALLAX.NEBULA_WORLD) rather than the full amount, which is what gives
   * it a "distant, almost-but-not-quite-fixed" depth cue instead of either
   * looking glued to the screen (zero drift) or looking like another
   * foreground object (full drift). The result is clamped so the Sprite's
   * edge can never enter the viewport, however far the camera pans or however
   * large the viewport is.
   *
   * @param {number} cameraX - Camera world position X
   * @param {number} cameraY - Camera world position Y
   * @param {number} viewWidth - Screen viewport width
   * @param {number} viewHeight - Screen viewport height
   */
  positionNebula(cameraX, cameraY, viewWidth, viewHeight) {
    if (!this.nebulaSprite) return;

    const spriteW = this.nebulaSprite.width;
    const spriteH = this.nebulaSprite.height;

    // Drift measured from the ARENA CENTRE, not from raw cameraX/Y, so the
    // Sprite sits centred under the viewport at the one camera position
    // (arena centre) every run starts at, and drifts symmetrically either
    // side of that as the camera pans away from it.
    const driftX = -(cameraX - WORLD.WIDTH / 2) * PARALLAX.NEBULA_WORLD * this.zoom;
    const driftY = -(cameraY - WORLD.HEIGHT / 2) * PARALLAX.NEBULA_WORLD * this.zoom;

    const rawX = (viewWidth - spriteW) / 2 + driftX;
    const rawY = (viewHeight - spriteH) / 2 + driftY;

    this.nebulaSprite.x = clampSpriteAxis(rawX, viewWidth, spriteW);
    this.nebulaSprite.y = clampSpriteAxis(rawY, viewHeight, spriteH);
  }

  /**
   * Offset the layers for this frame.
   *
   * One Sprite position write for the nebula, two `tilePosition` writes for
   * the remaining tiled layers, and (when the lattice is live) five uniform
   * writes. No allocation, no canvas work, no display-list churn — this is
   * the whole per-frame cost of the backdrop, and it is meant to stay that way.
   *
   * @param {number} dt - Delta time in seconds
   * @param {number} cameraX - Camera world position X
   * @param {number} cameraY - Camera world position Y
   * @param {number} width - Screen viewport width
   * @param {number} height - Screen viewport height
   * @param {number} [zoom] - Camera zoom; defaults to the value `resize` stored
   */
  update(dt = 1 / 60, cameraX = 0, cameraY = 0, width = 800, height = 600, zoom = this.zoom) {
    this.time += dt;

    /*
     * Every TILED layer's parallax rate is multiplied by the zoom, and that is
     * not a refinement — it is what makes the rates mean anything.
     *
     * The layers live in SCREEN space while `cameraX` is a WORLD offset, so a
     * layer written as `-cameraX * rate` moves by `rate` screen pixels per
     * world unit travelled while the arena beneath it moves by `zoom`. At the
     * mobile zoom of ~0.45 the foreground dust (rate 0.45) would therefore
     * track the arena EXACTLY: the fastest parallax layer would sit perfectly
     * still relative to the ground and the depth would collapse on precisely
     * the devices this rework is for. Scaling by zoom keeps each rate a
     * fraction of the world's apparent motion at any viewport.
     */
    const rate = zoom;

    /*
     * Camera velocity, smoothed.
     *
     * Derived here rather than passed in because the backdrop's one job is to
     * react to camera motion and making every caller thread a velocity through
     * would be two more arguments that can be forgotten or fed stale values.
     * The smoothing matters: the camera already lerps, so its raw frame delta
     * is noisy, and unsmoothed noise in a fast layer reads as the dust
     * shivering while the ship holds still.
     */
    if (this.lastCameraX !== null && dt > 0) {
      const instantX = (cameraX - this.lastCameraX) / dt;
      const instantY = (cameraY - this.lastCameraY) / dt;
      const k = Math.min(1, dt * 6);
      this.driftX += (instantX - this.driftX) * k;
      this.driftY += (instantY - this.driftY) * k;
    }
    this.lastCameraX = cameraX;
    this.lastCameraY = cameraY;

    this.zoom = zoom > 0 ? zoom : this.zoom;
    this.nebulaCameraX = cameraX;
    this.nebulaCameraY = cameraY;
    this.positionNebula(cameraX, cameraY, width, height);

    if (this.gridLayer) {
      this.gridLayer.tilePosition.x = -cameraX * PARALLAX.GRID * rate;
      this.gridLayer.tilePosition.y = -cameraY * PARALLAX.GRID * rate;
    }

    if (this.starLayer) {
      this.starLayer.tilePosition.x = -cameraX * PARALLAX.STARS * rate;
      this.starLayer.tilePosition.y = -cameraY * PARALLAX.STARS * rate;
    }

    if (this.dustLayer) {
      /*
       * The dust gets the camera parallax PLUS a kick opposite the direction of
       * travel. Parallax alone is proportional to distance moved; the kick is
       * proportional to SPEED, so accelerating throws the motes backward before
       * the ship has actually covered any ground. That is the cue the eye reads
       * as momentum, and it is why this layer is worth having at all.
       *
       * 0.06 s/unit keeps the kick under ~10px at the Drifter's top speed —
       * present in peripheral vision, never a smear across the arena.
       */
      this.dustLayer.tilePosition.x = -cameraX * PARALLAX.DUST * rate - this.driftX * 0.06 * rate;
      this.dustLayer.tilePosition.y = -cameraY * PARALLAX.DUST * rate - this.driftY * 0.06 * rate;
    }
  }

  /**
   * @param {number} width - Screen viewport width
   * @param {number} height - Screen viewport height
   * @param {number} [zoom] - Camera zoom, so the grid and nebula can hold their world scale
   */
  resize(width, height, zoom = this.zoom) {
    this.zoom = zoom > 0 ? zoom : 1;
    this.drawVoid(width, height);

    for (const layer of [this.gridLayer, this.starLayer, this.dustLayer]) {
      if (layer) {
        layer.width = width;
        layer.height = height;
      }
    }

    // A GRID.SPACING-unit cell occupies `SPACING * zoom` screen pixels, and the
    // baked cell is CELL_PX across — so this is the scale that makes the two
    // agree. Re-derived on every resize because the zoom is derived from the
    // viewport and both move together.
    if (this.gridLayer) {
      const cellScale = (GRID.SPACING * this.zoom) / GRID.CELL_PX;
      this.gridLayer.tileScale.set(cellScale, cellScale);
    }

    // The nebula Sprite's on-screen size is the arena's WORLD footprint,
    // scaled by the same zoom every world object uses — so at any zoom level
    // it maps 1:1 with how big a same-sized foreground object would be. Set
    // BEFORE repositioning: `positionNebula` reads `this.nebulaSprite.width/height`.
    if (this.nebulaSprite) {
      this.nebulaSprite.width = WORLD.WIDTH * NEBULA_WORLD_MARGIN * this.zoom;
      this.nebulaSprite.height = WORLD.HEIGHT * NEBULA_WORLD_MARGIN * this.zoom;
      this.positionNebula(this.nebulaCameraX, this.nebulaCameraY, width, height);
    }
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}

/**
 * Clamp one axis of the nebula Sprite's raw (pre-clamp) screen position so its
 * edge can never enter the viewport.
 *
 * The valid range for a TOP-LEFT position is `[viewSize - spriteSize, 0]`:
 * the upper bound (0) stops the LEADING edge entering the viewport, the lower
 * bound stops the TRAILING edge doing the same. That range is only sensible
 * when the sprite is at least as big as the viewport (`spriteSize >= viewSize`,
 * guaranteed by NEBULA_WORLD_MARGIN under any zoom this game's camera can
 * reach) — the degenerate opposite case is handled by centring instead, so an
 * unusually large monitor gets a centred, undersized backdrop rather than a
 * NaN or an inverted clamp.
 *
 * @param {number} raw - Unclamped top-left position
 * @param {number} viewSize - Viewport width or height, px
 * @param {number} spriteSize - Sprite's on-screen width or height, px
 * @returns {number}
 */
function clampSpriteAxis(raw, viewSize, spriteSize) {
  if (spriteSize <= viewSize) return (viewSize - spriteSize) / 2;
  return Math.min(0, Math.max(viewSize - spriteSize, raw));
}
