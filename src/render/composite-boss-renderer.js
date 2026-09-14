/**
 * Composite boss renderer — the Pixi container tree for a modular boss.
 *
 * ---------------------------------------------------------------------------
 * THE TREE MIRRORS THE DATA
 * ---------------------------------------------------------------------------
 * One root Container per boss, one child Container per part, positioned from
 * the SAME `offset` values src/core/composite-boss.js uses for its hitboxes.
 * The root carries the hull rotation, so a part authored on the port flank is
 * drawn on the port flank for free — no per-part world maths here, and no way
 * for the sprite to end up somewhere the collider is not.
 *
 * Aiming parts are the one exception: their barrel angle is written by the
 * simulation (the vector the round actually flies) and applied here as a LOCAL
 * angle with the hull's rotation subtracted out, so the gun points where it
 * shot rather than where it is bolted.
 *
 * ---------------------------------------------------------------------------
 * DAMAGE IS READ FROM THE HULL, NOT FROM A BAR
 * ---------------------------------------------------------------------------
 * A part darkens as it loses HP and is replaced by its wreck frame when it
 * goes, canted off its mount and left bolted to the ship. The silhouette
 * therefore records the fight: a player who glances at the boss can see which
 * guns they have already taken off it without reading a single number. Wrecks
 * are never removed — a boss that got visually cleaner as it lost its modules
 * would be telling the player the opposite of what is happening.
 *
 * Strictly display-side. It reads a render state and writes display objects; it
 * never mutates the boss.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import { ASSET_KEYS } from '../core/assets.js';
import { COMPOSITE_BOSSES } from '../data/roster-config.js';

/**
 * Roster sprite key -> loaded texture key.
 *
 * The roster names art in its own vocabulary ('boss_turret') so a designer can
 * write a boss before the art exists; this table binds those names to whatever
 * the atlas actually shipped. A key with no row here falls back to the
 * Dreadnought parts, which is why a half-authored boss renders as a grey
 * station rather than as nothing at all.
 */
export const BOSS_TEXTURE_KEY = {
  boss_cruiser_hull: ASSET_KEYS.DREADNOUGHT_BEAM,
  boss_spire_hull: ASSET_KEYS.DREADNOUGHT_SPINE,
  boss_turret: ASSET_KEYS.DREADNOUGHT_TURRET,
  boss_pylon: ASSET_KEYS.DREADNOUGHT_TURRET,
  boss_reactor: ASSET_KEYS.DREADNOUGHT_REACTOR,
  boss_turret_wreck: ASSET_KEYS.DREADNOUGHT_TURRET,
  boss_pylon_wreck: ASSET_KEYS.DREADNOUGHT_TURRET,
  boss_reactor_wreck: ASSET_KEYS.DREADNOUGHT_REACTOR,
};

export const BOSS_VIEW = {
  /** Sprite diameter as a multiple of collision diameter. */
  chassisFit: 2.2,
  partFit: 1.9,
  hullTint: 0x646b78,
  turretTint: 0x4e535f,
  /**
   * The reactor keeps its warning colour through everything, including a
   * damage flash: it is the weak point the player is aiming at, and losing it
   * to white at the exact moment they connect hides the target.
   */
  reactorTint: 0xff3d7a,
  /** Pure white. A tint multiplies, so this is the only value that brightens. */
  flashTint: 0xffffff,
  /** Wreckage: dark, desaturated, and canted off its mount. */
  wreckTint: 0x2a2d34,
  wreckAlpha: 0.85,
  wreckCant: 0.42,
  /**
   * How dark a part gets at 0 HP, before it is wrecked. Not to black — a part
   * that fades out entirely reads as already destroyed, and the player stops
   * shooting it one hit early.
   */
  damageFloor: 0.45,
  /**
   * Armour glint on the chassis while its modules still stand. It is the only
   * thing distinguishing "your shots are doing nothing" from "your shots are
   * missing", so it is not subtle.
   */
  armoredAlpha: 0.55,
  armoredTint: 0x3f4d7a,
};

/**
 * @param {import('pixi.js').Texture} texture
 * @param {number} radius - Collision radius, px
 * @param {number} fit
 * @returns {number}
 */
function scaleFor(texture, radius, fit) {
  const source = Math.max(texture?.width || 0, texture?.height || 0, 1);
  return (radius * 2 * fit) / source;
}

/**
 * A riveted dark-metal block with a glowing core, drawn with Pixi Graphics.
 *
 * THE LAST LINE OF DEFENCE AGAINST AN INVISIBLE BOSS. `resolve()` can come
 * back with `undefined` — an unmapped roster sprite key, or a critical asset
 * that failed to load — and passing `undefined` to a Sprite substitutes
 * Texture.EMPTY, which is zero-size and renders nothing. A boss silhouette
 * built entirely from Sprites then has no silhouette at all: not a wrong
 * texture, an absent one. This shape needs no texture, so it is always
 * something rather than sometimes nothing.
 *
 * Sized in local pixels, drawn once at construction and left static — it is a
 * fallback, not a second art pass, so it does not need to track hitFlash or
 * damage wear the way the sprite it stands in for does.
 *
 * @param {number} radius - Collision radius, px
 * @param {boolean} isReactor - Warm core instead of a flat plate
 * @returns {Graphics}
 */
function buildFallbackHull(radius, isReactor) {
  const g = new Graphics();
  const size = radius * 2;
  const tint = isReactor ? BOSS_VIEW.reactorTint : BOSS_VIEW.hullTint;

  g.rect(-radius, -radius, size, size);
  g.fill({ color: tint });
  g.rect(-radius, -radius, size, size);
  g.stroke({ color: 0x14151a, width: Math.max(2, radius * 0.08) });

  // Corner rivets: the cheapest way to read "hull plate" rather than "box".
  const rivetRadius = Math.max(2, radius * 0.09);
  const inset = radius * 0.7;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      g.circle(sx * inset, sy * inset, rivetRadius);
      g.fill({ color: 0x0c0d10 });
    }
  }

  if (isReactor) {
    g.circle(0, 0, radius * 0.4);
    g.fill({ color: BOSS_VIEW.reactorTint, alpha: 0.95 });
  }

  return g;
}

/**
 * Blend a tint toward black by `amount` (0 = untouched, 1 = black).
 * Channel-wise on the packed int, because Pixi tints are ints and going via a
 * colour object per part per frame is an allocation the boss fight does not
 * need.
 *
 * @param {number} tint
 * @param {number} amount
 * @returns {number}
 */
function darken(tint, amount) {
  const k = Math.max(0, Math.min(1, 1 - amount));
  const r = Math.round(((tint >> 16) & 0xff) * k);
  const g = Math.round(((tint >> 8) & 0xff) * k);
  const b = Math.round((tint & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}

export class CompositeBossRenderer {
  /**
   * @param {Object} options
   * @param {import('pixi.js').Container} options.layer - Where roots are added
   * @param {{get: (key: string) => any}} [options.assets] - Texture store
   * @param {(spriteKey: string) => any} [options.resolve] - Texture lookup
   *   override. Tests pass a stub; the game leaves it out and gets `assets`.
   */
  constructor({ layer, assets = null, resolve = null } = {}) {
    this.layer = layer ?? new Container();
    this.assets = assets;
    this.resolve = resolve ?? ((spriteKey) => this.assets?.get(BOSS_TEXTURE_KEY[spriteKey] ?? spriteKey));
    /** boss id -> view record */
    this.views = new Map();
  }

  /**
   * Build the container tree for one boss.
   *
   * Called once per boss, not per frame. Parts go down in authored order, which
   * is the designer's z-order: write the hull-mounted plates before the things
   * that sit on top of them.
   *
   * @param {Object} state - CompositeBoss.getRenderState()
   * @returns {Object} The view record
   */
  createView(state) {
    const template = COMPOSITE_BOSSES[state.templateId] ?? null;
    const root = new Container();

    const chassisTex = this.resolve(template?.chassis?.spriteKey);
    const chassis = new Sprite(chassisTex ?? undefined);
    chassis.anchor.set(0.5, 0.5);
    chassis.tint = BOSS_VIEW.hullTint;
    chassis.scale.set(scaleFor(chassisTex, state.radius, BOSS_VIEW.chassisFit));
    // Present whether or not the texture resolved; only visible when it did
    // not, so a missing asset never reads as an empty patch of space.
    const chassisFallback = buildFallbackHull(state.radius, false);
    chassisFallback.visible = !chassisTex;
    root.addChild(chassisFallback, chassis);

    /**
     * Armour glint: a second copy of the hull, additive-bright, shown only
     * while the chassis is still protected. A separate sprite rather than a
     * tint on the hull because it has to survive the hull's own damage
     * darkening — the two states are independent and must not fight.
     */
    const armorGlow = new Sprite(chassisTex ?? undefined);
    armorGlow.anchor.set(0.5, 0.5);
    armorGlow.tint = BOSS_VIEW.armoredTint;
    armorGlow.alpha = 0;
    armorGlow.scale.set(scaleFor(chassisTex, state.radius * 1.08, BOSS_VIEW.chassisFit));
    root.addChild(armorGlow);

    const parts = new Map();
    for (const partDef of template?.parts ?? []) {
      const holder = new Container();
      holder.x = partDef.offset.x;
      holder.y = partDef.offset.y;

      const liveTex = this.resolve(partDef.spriteKey);
      const live = new Sprite(liveTex ?? undefined);
      live.anchor.set(0.5, 0.5);
      live.tint = partDef.role === 'reactor' ? BOSS_VIEW.reactorTint : BOSS_VIEW.turretTint;
      live.scale.set(scaleFor(liveTex, partDef.radius, BOSS_VIEW.partFit));

      const liveFallback = buildFallbackHull(partDef.radius, partDef.role === 'reactor');
      liveFallback.visible = !liveTex;

      // The wreck is built up front and parked invisible. Building it at the
      // moment of destruction would resolve a texture and allocate a Sprite on
      // the exact frame the screen is busiest with the explosion that caused it.
      const wreckTex = this.resolve(partDef.wreckSpriteKey ?? partDef.spriteKey);
      const wreck = new Sprite(wreckTex ?? undefined);
      wreck.anchor.set(0.5, 0.5);
      wreck.tint = BOSS_VIEW.wreckTint;
      wreck.alpha = BOSS_VIEW.wreckAlpha;
      wreck.rotation = BOSS_VIEW.wreckCant;
      wreck.scale.set(scaleFor(wreckTex, partDef.radius, BOSS_VIEW.partFit * 0.92));
      wreck.visible = false;

      holder.addChild(liveFallback, live, wreck);
      root.addChild(holder);
      parts.set(partDef.id, { def: partDef, holder, live, liveFallback, wreck });
    }

    this.layer.addChild(root);
    const view = { root, chassis, chassisFallback, armorGlow, parts, templateId: state.templateId };
    this.views.set(state.id, view);
    return view;
  }

  /**
   * Drive one frame.
   *
   * @param {Object} state - CompositeBoss.getRenderState()
   */
  sync(state) {
    if (!state) return;
    let view = this.views.get(state.id);
    if (!view || view.templateId !== state.templateId) {
      if (view) this.release(state.id);
      view = this.createView(state);
    }

    view.root.x = state.x;
    view.root.y = state.y;
    view.root.rotation = state.rotation;
    view.root.visible = state.alive;

    const flashing = state.hitFlash > 0;
    const chassisTint = flashing ? BOSS_VIEW.flashTint : BOSS_VIEW.hullTint;
    view.chassis.tint = chassisTint;
    // The fallback block is a stand-in for the sprite, not a second layer of
    // feedback — it mirrors the same tint so a flash still reads when the
    // texture never resolved.
    view.chassisFallback.tint = chassisTint;
    view.armorGlow.alpha = state.chassisVulnerable ? 0 : BOSS_VIEW.armoredAlpha;

    for (const partState of state.parts) {
      const part = view.parts.get(partState.id);
      if (!part) continue;

      if (!partState.alive) {
        part.live.visible = false;
        part.liveFallback.visible = false;
        part.wreck.visible = true;
        continue;
      }

      // liveFallback's own visibility (texture present or not) was already
      // decided at construction; only the wreck swap toggles it off entirely.
      part.wreck.visible = false;
      /**
       * The barrel angle comes from the simulation as a WORLD angle, and the
       * holder already carries the hull's rotation, so the hull angle is
       * subtracted back out. Writing the world angle straight onto a child of a
       * rotating parent double-counts the spin and the turrets windmill.
       */
      part.holder.rotation = part.def.aims
        ? partState.rotation - state.rotation
        : part.def.rotation ?? 0;

      const base = part.def.role === 'reactor' ? BOSS_VIEW.reactorTint : BOSS_VIEW.turretTint;
      if (partState.hitFlash > 0) {
        part.live.tint = BOSS_VIEW.flashTint;
        part.liveFallback.tint = BOSS_VIEW.flashTint;
      } else {
        const wear = (1 - partState.hpFraction) * BOSS_VIEW.damageFloor;
        part.live.tint = darken(base, wear);
        part.liveFallback.tint = darken(base, wear);
      }
    }
  }

  /**
   * Drop a boss's display objects.
   *
   * Destroyed rather than parked for reuse: there is at most one composite boss
   * on the field and the next one is a different template with a different
   * parts list, so a pool here would cache a tree that never fits again.
   *
   * @param {number} bossId
   */
  release(bossId) {
    const view = this.views.get(bossId);
    if (!view) return;
    this.layer.removeChild(view.root);
    view.root.destroy({ children: true });
    this.views.delete(bossId);
  }

  /** Tear down every live boss view — run start, or renderer teardown. */
  clear() {
    for (const bossId of [...this.views.keys()]) this.release(bossId);
  }
}
