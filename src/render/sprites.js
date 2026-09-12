/**
 * Sprite sizing and per-frame sync.
 *
 * This module owns how a simulation entity's NUMBERS land on a display object.
 * What an entity LOOKS like — tint, scale multiplier, bioluminescence, the
 * boss composite — lives in src/render/sprite-factory.js. The split is
 * deliberate: re-skinning the game should not touch the per-frame hot path,
 * and tuning the hot path should not require reading a palette table.
 *
 * TWO RULES THAT MATTER
 *
 * 1. Anchor is always (0.5, 0.5). Simulation entities are circles positioned by
 *    their centre, so a centre anchor makes the sprite's visual centre and its
 *    collision centre the same point by construction.
 *
 * 2. Scale is DERIVED from the entity's collision radius, never authored per
 *    asset. `scale = (radius * 2 * fit) / texture.width` means art can ship at
 *    any resolution and still line up with the hitbox. Artists change the
 *    atlas; nobody edits code.
 */

import { Sprite } from 'pixi.js';
import { getEnemyTextureKey, ASSET_KEYS } from '../core/assets.js';
import { THEME } from './theme.js';
import {
  DAMAGE_TINT,
  HERO_TINT,
  HULL_ROTATION_OFFSET,
  NO_TINT,
  bioLuminance,
  enemyFit,
  enemyTint,
  getEnemyView,
} from './sprite-factory.js';

export { NO_TINT, DAMAGE_TINT, HERO_TINT, HULL_ROTATION_OFFSET } from './sprite-factory.js';

/**
 * Default visual diameter as a multiple of the collision diameter, for
 * anything with no per-species row.
 */
export const SPRITE_FIT = 1.15;

/**
 * Per-type visual tweaks the renderer reads at view-construction time.
 *
 * `fit` comes from the theme spec's per-species scale (sprite-factory.js) so
 * there is one number to tune, not two. `faceTravel` is kept as a hint for the
 * boss path; the swarm derives facing from real velocity in juice.js.
 */
export const ENEMY_SPRITE_CONFIG = {
  tarling: { fit: enemyFit('tarling') },
  ashfish: { fit: enemyFit('ashfish'), faceTravel: true },
  cracked_wisp: { fit: enemyFit('cracked_wisp'), faceTravel: true },
  rustbloom: { fit: enemyFit('rustbloom') },
  smogmoth: { fit: enemyFit('smogmoth'), faceTravel: true },
  bio_goliath: { fit: enemyFit('bio_goliath'), faceTravel: true },
  rustwhale: { fit: enemyFit('rustwhale'), faceTravel: true },
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
 * Sized off the frame's LARGER dimension, not its width. The roster now draws
 * from two atlases of wildly different aspect ratios — a dart hull is tall and
 * narrow, a cruiser hull is wide and squat — and dividing by width alone would
 * render the tall frames several times over their intended size. Fitting the
 * bounding square means `radius * 2 * fit` is the diameter of the circle the
 * sprite fits INSIDE, whatever shape it is, which is the guarantee the
 * collision radius actually needs.
 *
 * @param {{width: number, height: number}} texture
 * @param {number} radius - Collision radius in world px
 * @param {number} [fit]
 * @returns {number}
 */
export function scaleForRadius(texture, radius, fit = SPRITE_FIT) {
  const source = Math.max(texture?.width || 0, texture?.height || 0, 1);
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
 * Point an existing sprite at an enemy's current state, using a Tier B
 * transform.
 *
 * Called every frame for every live enemy — up to 200 of them — so it
 * allocates nothing and only writes properties that actually change. All the
 * motion decisions were made by src/render/juice.js; this function moves the
 * numbers onto the sprite and layers the species' bioluminescence on top.
 *
 * @param {{sprite: Sprite, baseScale: number, tint?: number, view?: Object}} view
 *   Renderer-owned record
 * @param {Object} entity - Simulation entity, or a dissolving snapshot
 * @param {{scaleX: number, scaleY: number, rotation: number, alpha: number, flash: boolean}} transform
 * @param {number} [t] - Seconds, for the bioluminescent pulse. Omit to skip it.
 */
export function syncEnemySprite(view, entity, transform, t = null) {
  const { sprite } = view;

  sprite.x = entity.x;
  sprite.y = entity.y;
  sprite.rotation = transform.rotation + HULL_ROTATION_OFFSET;
  sprite.alpha = transform.alpha;
  sprite.scale.x = view.baseScale * transform.scaleX;
  sprite.scale.y = view.baseScale * transform.scaleY;

  if (t !== null && view.view) {
    const phaseOffset = entity.phaseOffset ?? 0;
    // Multiplied, not assigned: the dissolve and spawn fades already wrote
    // transform.alpha, and the shimmer (and the Phantom Stalker's cloak, which
    // reads `entity.visibility`) must modulate those rather than erase them.
    sprite.alpha = transform.alpha * bioLuminance(t, phaseOffset, view.view, entity);
  }

  // Damage flash via GPU tint — no second atlas, no filter allocation, and no
  // per-entity shader pass. Off-flash, the sprite wears its species colour.
  sprite.tint = transform.flash ? DAMAGE_TINT : view.tint ?? NO_TINT;
}

/**
 * Texture key for an enemy type.
 * @param {string} typeId
 * @returns {string}
 */
export function enemyTextureKey(typeId) {
  return getEnemyTextureKey(typeId);
}

/** Texture key for the Void Drifter. */
export const HERO_TEXTURE_KEY = ASSET_KEYS.DRIFTER;

/** Species tint, re-exported so the renderer has one import for sprite concerns. */
export { enemyTint, getEnemyView };

/**
 * Cosmetic variants recolour the hero hull by tint rather than by shipping a
 * separate frame per variant, so a new skin is a palette row.
 *
 * With nothing equipped this returns the Drifter's own hull colour, NOT white:
 * the atlas frame is untinted white geometry, so "no cosmetic" has to mean the
 * default livery rather than no livery at all.
 *
 * @param {Object|null} cosmetic
 * @returns {number} Pixi tint
 */
export function cosmeticTint(cosmetic) {
  if (!cosmetic || !cosmetic.tint) return HERO_TINT;
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

/**
 * Pixi ints for the palette entries the renderer paints on Graphics.
 *
 * Only entries the renderer actually uses live here — THEME remains the full
 * palette. A mirror that drifts ahead of its consumers is just a second place
 * to look when a colour is wrong.
 */
export const PIXI_TINT = {
  heroCore: hexToPixi(THEME.hero.core),
  heroRim: hexToPixi(THEME.hero.rim),
  heroTrail: hexToPixi(THEME.hero.trail),
  heroShield: hexToPixi(THEME.hero.shield),
  heroIon: hexToPixi(THEME.hero.ion),
  /** Phase Repeater bolts. */
  ion: hexToPixi(THEME.offence.ion),
  /** Singularity Lance hot core. */
  beam: hexToPixi(THEME.offence.beam),
  /** Aegis Satellite drones. */
  aegis: hexToPixi(THEME.offence.aegis),
  /** Hyperion Shield bubble. */
  pulse: hexToPixi(THEME.offence.pulse),
  /** Graviton EMP ring. */
  graviton: hexToPixi(THEME.offence.graviton),
  orb: hexToPixi(THEME.pickup.orb),
  /** Telegraph and eruption. */
  danger: hexToPixi(THEME.danger.telegraph),
  hazard: hexToPixi(THEME.danger.hazard),
  hazardRim: hexToPixi(THEME.danger.hazardRim),
  /** Bio-acid, for the telegraph's inner ring. */
  acid: hexToPixi(THEME.bio.acid),
  /** Swarm carapace black — the enemy health-bar track. */
  chitin: hexToPixi(THEME.swarm.chitin),
  border: hexToPixi(THEME.background.border),
  grid: hexToPixi(THEME.background.grid),
};
