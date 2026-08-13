/**
 * Sprite configuration and factory (Phase 6b).
 *
 * Replaces the Phase 6 procedural `arc()`/`lineTo()` entity drawing. Every
 * character and enemy is now a PIXI.Sprite; this module owns how a simulation
 * entity maps onto one.
 *
 * TWO RULES THAT MATTER
 *
 * 1. Anchor is always (0.5, 0.5). Simulation entities are circles positioned by
 *    their centre, so a centre anchor makes the sprite's visual centre and its
 *    collision centre the same point by construction.
 *
 * 2. Scale is DERIVED from the entity's collision radius, never authored per
 *    asset. `scale = (radius * 2 * SPRITE_FIT) / texture.width` means art can
 *    ship at any resolution and still line up with the hitbox. Artists change
 *    the PNG; nobody edits code.
 */

import { Sprite } from 'pixi.js';
import { getEnemyTextureKey, ASSET_KEYS } from '../core/assets.js';
import { THEME } from './theme.js';

/**
 * Visual diameter as a multiple of the collision diameter.
 * Slightly over 1 because art usually carries soft edges and glow that should
 * not count as hitbox.
 */
export const SPRITE_FIT = 1.15;

/** Tint applied for one hit-flash frame. Pixi tints multiply, so white = off. */
export const NO_TINT = 0xffffff;
export const DAMAGE_TINT = 0xff8a6a;

/**
 * Per-type visual tweaks that are genuinely about presentation, not gameplay.
 * `fit` overrides SPRITE_FIT; `spin` rotates with travel; `bob` adds idle sway.
 */
export const ENEMY_SPRITE_CONFIG = {
  tarling: { fit: 1.2, bob: 0.06 },
  ashfish: { fit: 1.35, faceTravel: true },
  cracked_wisp: { fit: 1.15, spin: 1.6 },
  rustbloom: { fit: 1.3, bob: 0.04 },
  smogmoth: { fit: 1.4, faceTravel: true, bob: 0.1 },
  rustwhale: { fit: 1.5, faceTravel: true },
};

/**
 * @param {string} typeId
 * @returns {Object}
 */
export function getEnemySpriteConfig(typeId) {
  return ENEMY_SPRITE_CONFIG[typeId] ?? { fit: SPRITE_FIT };
}

/**
 * Scale factor that makes a texture render at the requested world diameter.
 *
 * @param {{width: number, height: number}} texture
 * @param {number} radius - Collision radius in world px
 * @param {number} [fit]
 * @returns {number}
 */
export function scaleForRadius(texture, radius, fit = SPRITE_FIT) {
  const source = Math.max(texture?.width || 0, 1);
  return (radius * 2 * fit) / source;
}

/**
 * Build a centre-anchored sprite.
 * @param {import('pixi.js').Texture} texture
 * @returns {Sprite}
 */
export function makeSprite(texture) {
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 0.5);
  return sprite;
}

/**
 * Point an existing sprite at an enemy's current state.
 *
 * Called every frame for every live enemy, so it allocates nothing and only
 * touches properties that actually change.
 *
 * Facing is derived from the vector to the Dewling rather than from a stored
 * velocity: enemies always steer at the player, so this needs no new field on
 * the simulation entity and keeps src/core/ free of render concerns.
 *
 * @param {{sprite: Sprite, baseScale: number}} view - Renderer-owned record
 * @param {Object} enemy - Simulation entity
 * @param {number} time - Seconds since run start
 * @param {{x: number, y: number}} player
 */
export function syncEnemySprite(view, enemy, time, player) {
  const { sprite } = view;
  const config = getEnemySpriteConfig(enemy.typeId);

  sprite.x = enemy.x;
  sprite.y = enemy.y;

  if (config.faceTravel) {
    sprite.rotation = Math.atan2(player.y - enemy.y, player.x - enemy.x);
  } else if (config.spin) {
    sprite.rotation = time * config.spin + enemy.id;
  }

  if (config.bob) {
    const wobble = 1 + Math.sin(time * 4 + enemy.id) * config.bob;
    sprite.scale.set(view.baseScale * wobble);
  }

  // Damage flash via GPU tint — no second sprite sheet, no filter allocation.
  sprite.tint = enemy.hitFlash > 0 ? DAMAGE_TINT : NO_TINT;
}

/**
 * Texture key for an enemy type.
 * @param {string} typeId
 * @returns {string}
 */
export function enemyTextureKey(typeId) {
  return getEnemyTextureKey(typeId);
}

/** Texture key for the Dewling. */
export const HERO_TEXTURE_KEY = ASSET_KEYS.DEWLING;

/**
 * Cosmetic variants recolour the hero sprite by tint rather than by shipping a
 * separate PNG per variant, so a new skin is a palette row.
 * @param {Object|null} cosmetic
 * @returns {number} Pixi tint
 */
export function cosmeticTint(cosmetic) {
  if (!cosmetic || !cosmetic.tint) return NO_TINT;
  return hexToPixi(cosmetic.tint);
}

/**
 * '#rrggbb' -> 0xrrggbb
 * @param {string} hex
 * @returns {number}
 */
export function hexToPixi(hex) {
  return parseInt(String(hex).replace('#', ''), 16);
}

/** Pixi tints for palette entries the renderer needs on Graphics/particles. */
export const PIXI_TINT = {
  heroCore: hexToPixi(THEME.hero.core),
  heroRim: hexToPixi(THEME.hero.rim),
  heroTrail: hexToPixi(THEME.hero.trail),
  heroShield: hexToPixi(THEME.hero.shield),
  dewdrop: hexToPixi(THEME.offence.dewdrop),
  petal: hexToPixi(THEME.offence.petal),
  beam: hexToPixi(THEME.offence.beam),
  blade: hexToPixi(THEME.offence.blade),
  pulse: hexToPixi(THEME.offence.pulse),
  tide: hexToPixi(THEME.offence.tide),
  orb: hexToPixi(THEME.pickup.orb),
  warning: hexToPixi(THEME.frutevil.warning),
  rust: hexToPixi(THEME.frutevil.rust),
  rustRim: hexToPixi(THEME.frutevil.rustRim),
  border: hexToPixi(THEME.background.border),
  grid: hexToPixi(THEME.background.grid),
};
