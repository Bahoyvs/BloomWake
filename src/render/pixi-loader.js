/**
 * PixiJS-backed texture loader and placeholder factory.
 *
 * Two responsibilities, deliberately separated:
 *
 *   createPixiLoader() returns a loader that THROWS on a missing file or a
 *   missing atlas frame, so AssetStore records the key in `missing` and we keep
 *   an honest picture of what actually shipped.
 *
 *   installPlaceholders() then fills every gap with a generated texture. That
 *   ordering is what lets the game run and be tested with an empty
 *   public/assets folder while still reporting the truth about what is absent.
 *
 * Placeholders are intentionally crude — flat silhouettes in the Chitin Swarm
 * palette. They exist to keep the game playable and to make a missing asset
 * obvious at a glance, not to look good.
 */

import { Assets, Texture } from 'pixi.js';
import { ASSET_KEYS } from '../core/assets.js';
import { THEME, getEnemyPalette } from './theme.js';
import { DREADNOUGHT, THRUSTER } from './sprite-factory.js';

/**
 * Loader function for AssetStore, backed by the PixiJS 8 Assets API.
 *
 * Handles both manifest shapes:
 *   - `{ key, url }`            -> a standalone image; `Assets.load` yields the Texture.
 *   - `{ key, url, frame }`     -> `url` is a JSON spritesheet; the frame is
 *                                  pulled out of the resolved Spritesheet.
 *
 * SHEETS ARE FETCHED ONCE. AssetStore walks the manifest sequentially and ten
 * of its entries name the same atlas, so this memoises the in-flight promise
 * per url. Pixi's own cache would dedupe the network request anyway, but
 * holding the promise here also collapses ten awaits into one.
 *
 * @returns {(entry: {key: string, url: string, frame?: string}) => Promise<Texture>}
 */
export function createPixiLoader() {
  /** url -> Promise of whatever Assets.load resolved to. */
  const inFlight = new Map();

  const loadOnce = (url) => {
    let promise = inFlight.get(url);
    if (!promise) {
      // Assets.load rejects on 404/decode failure, which is exactly the signal
      // AssetStore needs. The rejection is cached with the promise so ten
      // frames off one dead atlas do not each retry the fetch.
      promise = Assets.load(url);
      inFlight.set(url, promise);
    }
    return promise;
  };

  return async (entry) => {
    const resource = await loadOnce(entry.url);
    if (!resource) throw new Error(`no asset for ${entry.url}`);

    if (!entry.frame) return resource;

    const texture = resource.textures?.[entry.frame];
    if (!texture) {
      throw new Error(`frame "${entry.frame}" not found in ${entry.url}`);
    }
    return texture;
  };
}

/**
 * Fill missing manifest entries with generated stand-ins.
 * @param {import('../core/assets.js').AssetStore} store
 * @returns {Array<string>} Keys that received a placeholder
 */
export function installPlaceholders(store) {
  const filled = [];
  for (const key of store.missing) {
    if (store.has(key)) continue;
    store.set(key, makePlaceholderTexture(key));
    filled.push(key);
  }
  return filled;
}

/**
 * @param {string} key
 * @returns {Texture}
 */
export function makePlaceholderTexture(key) {
  const canvas = document.createElement('canvas');
  const size = 128;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  switch (key) {
    case ASSET_KEYS.DRIFTER:
      drawDrifterPlaceholder(ctx, size);
      break;
    case ASSET_KEYS.WINGMAN:
      drawDrifterPlaceholder(ctx, size);
      break;
    case ASSET_KEYS.SHIELD:
      drawShieldPlaceholder(ctx, size);
      break;
    case ASSET_KEYS.PLASMA_MOTE:
      drawSoftDot(ctx, size, THEME.hero.core);
      break;
    case ASSET_KEYS.LENS_FLARE:
      drawSoftDot(ctx, size, THEME.hero.rim);
      break;
    case ASSET_KEYS.SPARK:
      drawSoftDot(ctx, size, THEME.hero.ion);
      break;
    case ASSET_KEYS.ION_BOLT:
      drawBoltPlaceholder(ctx, size, THEME.offence.ion);
      break;
    case ASSET_KEYS.ENEMY_BOLT:
      drawBoltPlaceholder(ctx, size, THEME.danger.telegraph);
      break;
    case ASSET_KEYS.NANITE_MISSILE:
      drawBoltPlaceholder(ctx, size, THEME.hero.rim);
      break;
    case ASSET_KEYS.AEGIS_SAT:
      drawPlatePlaceholder(ctx, size, THEME.offence.aegis);
      break;
    case ASSET_KEYS.DREADNOUGHT_REACTOR:
      drawSoftDot(ctx, size, THEME.danger.reactor);
      break;
    case ASSET_KEYS.DREADNOUGHT_TURRET:
      drawPlatePlaceholder(ctx, size, cssTint(DREADNOUGHT.turretTint));
      break;
    case ASSET_KEYS.DREADNOUGHT_BEAM:
      drawSlabPlaceholder(ctx, size, cssTint(DREADNOUGHT.beamTint));
      break;
    case ASSET_KEYS.THRUSTER:
      drawFlamePlaceholder(ctx, size);
      break;
    default:
      drawSwarmPlaceholder(ctx, size, key);
      break;
  }

  return Texture.from(canvas);
}

/**
 * Arrowhead stand-in for the Drifter.
 * Drawn pointing UP, matching the real atlas hulls, so HULL_ROTATION_OFFSET
 * stays correct whether or not the art loaded.
 */
function drawDrifterPlaceholder(ctx, size) {
  const c = size / 2;
  const r = size * 0.44;

  const body = ctx.createLinearGradient(c, c - r, c, c + r);
  body.addColorStop(0, THEME.hero.core);
  body.addColorStop(0.6, THEME.hero.body);
  body.addColorStop(1, THEME.hero.ion);

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(c, c - r);
  ctx.lineTo(c + r * 0.72, c + r * 0.8);
  ctx.lineTo(c, c + r * 0.42);
  ctx.lineTo(c - r * 0.72, c + r * 0.8);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.ellipse(c, c - r * 0.1, r * 0.13, r * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Squat diamond stand-in for a turret platform.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size
 * @param {string} color
 */
function drawPlatePlaceholder(ctx, size, color) {
  const c = size / 2;
  const r = size * 0.4;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(c, c - r);
  ctx.lineTo(c + r, c);
  ctx.lineTo(c, c + r);
  ctx.lineTo(c - r, c);
  ctx.closePath();
  ctx.fill();
}

/**
 * Wide horizontal slab, standing in for the station's cross-member.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size
 * @param {string} color
 */
function drawSlabPlaceholder(ctx, size, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, size * 0.36, size, size * 0.28);
}

/**
 * Vertical capsule, standing in for any ordnance frame.
 *
 * Drawn pointing UP like every real hull frame, because the renderer applies
 * HULL_ROTATION_OFFSET to missiles too — a stand-in drawn along +X would fly
 * sideways the moment the real art went missing.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size
 * @param {string} color
 */
function drawBoltPlaceholder(ctx, size, color) {
  const c = size / 2;
  const w = size * 0.16;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect?.(c - w, size * 0.14, w * 2, size * 0.72, w);
  if (!ctx.roundRect) ctx.rect(c - w, size * 0.14, w * 2, size * 0.72);
  ctx.fill();
}

/**
 * Circular energy ring for shield placeholder.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size
 */
function drawShieldPlaceholder(ctx, size) {
  const c = size / 2;
  const r = size * 0.42;
  ctx.strokeStyle = THEME.hero.shield ?? '#00e5ff';
  ctx.lineWidth = size * 0.08;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Downward-tapering flame, matching the real frame's orientation.
 *
 * Direction matters even in a placeholder: the renderer pins the flame by its
 * TOP edge and lets it grow astern, so a stand-in drawn any other way up would
 * make the engines look like they were firing into the hull.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size
 */
function drawFlamePlaceholder(ctx, size) {
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, THEME.hero.core);
  gradient.addColorStop(0.35, cssTint(THRUSTER.tint));
  gradient.addColorStop(1, 'rgba(0, 240, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size);
  ctx.lineTo(size * 0.78, 0);
  ctx.lineTo(size * 0.22, 0);
  ctx.closePath();
  ctx.fill();
}

/** Radial falloff dot, used for particle and glow textures. */
function drawSoftDot(ctx, size, color) {
  const c = size / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
}

/**
 * Flat dark carapace in the right Swarm hue, with a rim so it reads as a shape.
 *
 * NOTE the placeholder paints the species colour directly, where the real
 * pipeline paints a WHITE hull and tints it. Same colour on screen either way;
 * this path just has no tint stage to lean on.
 */
function drawSwarmPlaceholder(ctx, size, key) {
  const typeId = Object.entries({
    tarling: ASSET_KEYS.XENO_LARVA,
    ashfish: ASSET_KEYS.MANTIS_STRIDER,
    cracked_wisp: ASSET_KEYS.DART_RAVAGER,
    rustbloom: ASSET_KEYS.BROOD_SPORE,
    smogmoth: ASSET_KEYS.PHANTOM_STALKER,
    bio_goliath: ASSET_KEYS.BIO_GOLIATH,
    rustwhale: ASSET_KEYS.DREADNOUGHT_SPINE,
  }).find(([, assetKey]) => assetKey === key)?.[0];

  const palette = getEnemyPalette(typeId ?? 'tarling');
  const c = size / 2;
  const r = size * 0.4;

  ctx.fillStyle = palette.fill;
  ctx.strokeStyle = palette.rim;
  ctx.lineWidth = size * 0.04;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Diagonal hatch marks the sprite as a stand-in, not final art.
  ctx.strokeStyle = typeId === 'rustwhale' ? cssTint(DREADNOUGHT.reactorTint) : palette.rim;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(c - r * 0.6, c - r * 0.6);
  ctx.lineTo(c + r * 0.6, c + r * 0.6);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * 0xrrggbb -> '#rrggbb', for the canvas 2D context.
 * @param {number} tint
 * @returns {string}
 */
function cssTint(tint) {
  return `#${tint.toString(16).padStart(6, '0')}`;
}
