/**
 * PixiJS-backed texture loader and placeholder factory (Phase 6b).
 *
 * Two responsibilities, deliberately separated:
 *
 *   createPixiLoader() returns a loader that THROWS on a missing file, so
 *   AssetStore records the key in `missing` and we keep an honest picture of
 *   what actually shipped.
 *
 *   installPlaceholders() then fills every gap with a generated texture. That
 *   ordering is what lets the game run and be tested with an empty /assets
 *   folder while still reporting the truth about what is absent.
 *
 * Placeholders are intentionally crude — flat silhouettes in the Frutevil
 * palette. They exist to keep the game playable and to make a missing asset
 * obvious at a glance, not to look good.
 */

import { Assets, Texture } from 'pixi.js';
import { ASSET_KEYS } from '../core/assets.js';
import { THEME, getEnemyPalette } from './theme.js';

/**
 * Loader function for AssetStore, backed by PIXI.Assets.
 * @returns {(entry: {key: string, url: string}) => Promise<Texture>}
 */
export function createPixiLoader() {
  return async (entry) => {
    // Assets.load rejects on 404/decode failure, which is exactly the signal
    // AssetStore needs.
    const texture = await Assets.load(entry.url);
    if (!texture) throw new Error(`no texture for ${entry.url}`);
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
  const size = key === ASSET_KEYS.BG_AQUA ? 256 : 128;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  switch (key) {
    case ASSET_KEYS.BG_AQUA:
      drawBackgroundTile(ctx, size);
      break;
    case ASSET_KEYS.DEWLING:
      drawDewlingPlaceholder(ctx, size);
      break;
    case ASSET_KEYS.BUBBLE_PARTICLE:
      drawSoftDot(ctx, size, THEME.hero.core);
      break;
    case ASSET_KEYS.LENS_FLARE:
      drawSoftDot(ctx, size, THEME.hero.rim);
      break;
    default:
      drawEnemyPlaceholder(ctx, size, key);
      break;
  }

  return Texture.from(canvas);
}

/** Two-stop aqua gradient, tileable enough to stand in for the real backdrop. */
function drawBackgroundTile(ctx, size) {
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, THEME.background.top);
  gradient.addColorStop(1, THEME.background.bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
}

/** Glossy sphere stand-in for the Dewling. */
function drawDewlingPlaceholder(ctx, size) {
  const r = size * 0.42;
  const c = size / 2;

  const body = ctx.createRadialGradient(c - r * 0.3, c - r * 0.4, r * 0.1, c, c, r);
  body.addColorStop(0, THEME.hero.core);
  body.addColorStop(0.55, THEME.hero.body);
  body.addColorStop(1, THEME.hero.rim);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.ellipse(c - r * 0.32, c - r * 0.38, r * 0.22, r * 0.16, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

/** Radial falloff dot, used for both particle textures. */
function drawSoftDot(ctx, size, color) {
  const c = size / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
}

/** Flat dark blob in the right Frutevil hue, with a rim so it reads as a shape. */
function drawEnemyPlaceholder(ctx, size, key) {
  const typeId = Object.entries({
    tarling: ASSET_KEYS.TARLING,
    ashfish: ASSET_KEYS.ASHFISH,
    cracked_wisp: ASSET_KEYS.CRACKED_WISP,
    rustbloom: ASSET_KEYS.RUSTBLOOM,
    smogmoth: ASSET_KEYS.SMOGMOTH,
    rustwhale: ASSET_KEYS.RUSTWHALE_BOSS,
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
  ctx.strokeStyle = palette.rim;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(c - r * 0.6, c - r * 0.6);
  ctx.lineTo(c + r * 0.6, c + r * 0.6);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
