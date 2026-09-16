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
 * ---------------------------------------------------------------------------
 * TWO TREES PER BOSS, AND WHY
 * ---------------------------------------------------------------------------
 * The hull tree (`root`) carries the chassis rotation, which is what makes the
 * parts free. The FX tree (`fx`) is a sibling pinned to the same position with
 * rotation left at zero, and everything the enraged chassis draws in WORLD
 * bearings lives there: the charge telegraph beam, the gravity-well lensing,
 * the shockwave rings.
 *
 * The alternative is drawing them inside `root` and subtracting the hull angle
 * back out, the way an aiming turret does. That works for one number on one
 * child; it does not work for a 500px beam, a ring of inward-travelling specks
 * and three expanding circles, because every one of them would need the same
 * correction and the first one to be missed would silently windmill. Anything
 * that must rotate WITH the hull (a breach vent bolted to a dead part's socket)
 * goes in `root`; anything that must not goes in `fx`. The container it lives in
 * is the answer, so there is no per-frame trigonometry to get wrong.
 *
 * Strictly display-side. It reads a render state and writes display objects; it
 * never mutates the boss.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import { ASSET_KEYS } from '../core/assets.js';
import { COMPOSITE_BOSSES } from '../data/roster-config.js';
import { PIXI_TINT } from './sprites.js';

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
  /*
   * CHASSIS. Both are heavy station frames from the expansion atlas: a wide
   * cross-member for the Cruiser, whose silhouette is horizontal, and the tall
   * keel for the Spire, whose silhouette is vertical. Two bosses, two
   * outlines, before a single part is bolted on.
   */
  boss_cruiser_hull: ASSET_KEYS.DREADNOUGHT_BEAM,
  boss_spire_hull: ASSET_KEYS.DREADNOUGHT_SPINE,

  /*
   * MODULES. The turret and the pylon are DIFFERENT frames, which they were
   * not: with both bound to the Dreadnought's turret platform, the Spire's
   * three pylons and the Cruiser's two turrets were the same object at two
   * sizes, and the only thing separating the two bosses was how many of it
   * there were.
   */
  boss_turret: ASSET_KEYS.DREADNOUGHT_TURRET,
  boss_pylon: ASSET_KEYS.BOSS_PYLON,
  boss_reactor: ASSET_KEYS.DREADNOUGHT_REACTOR,

  /*
   * WRECKS reuse the live frame on purpose. A destroyed module stays bolted to
   * the hull, canted off its mount and drained to BOSS_VIEW.wreckTint — the
   * player has to recognise it as the gun they just silenced, and a different
   * silhouette in that slot reads as a NEW part rather than as a dead one.
   */
  boss_turret_wreck: ASSET_KEYS.DREADNOUGHT_TURRET,
  boss_pylon_wreck: ASSET_KEYS.BOSS_PYLON,
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

  /* ---- The enraged core ---- */
  /**
   * Seconds the breach flare takes to bloom and settle when the armour comes
   * off. The single most important transition in the fight gets its own
   * animation rather than a state flip: a boss that simply starts behaving
   * differently on one frame reads as a bug in the boss, not as a boss.
   */
  enrageFlareSec: 0.9,
  /** Hull tint once enraged. Running hot, and visibly not the grey it was. */
  enragedHullTint: 0x8a5a4a,
  /**
   * The charge telegraph beam. 500px long and 32px wide, drawn from the bow
   * down the LOCKED vector — not toward the player's current position, because
   * the locked vector is where the boss is actually going and the whole value
   * of a telegraph is that it does not lie.
   */
  telegraphLength: 500,
  telegraphWidth: 32,
  /** Dash pitch, px. A dashed beam reads as a trajectory; a solid one as a laser. */
  telegraphDash: 34,
  /** Thruster corona scale at full load, as a multiple of its idle size. */
  thrustFlareScale: 2.5,
  /** Breach vent smoke/flame burst radius, as a fraction of the part radius. */
  ventScale: 0.85,
  /** Inward-travelling specks drawn inside a live gravity well. */
  wellSpecks: 28,
  /** Seconds a speck takes to fall from the well's rim to the core. */
  wellSpeckSec: 2.4,
};

/** Full turn, in radians. Used often enough here to be worth a name. */
const TAU = Math.PI * 2;

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
 * The engine corona, drawn at IDLE size and scaled up by load.
 *
 * Three nested cones from white at the nozzle out to orange at the tip, which
 * is the whole of what makes an exhaust read as hot rather than as a coloured
 * triangle. Pointing along -X: the hull's own facing is +X (see the aim vectors
 * in composite-boss.js), so the wash comes out of the stern without this needing
 * to know which way round the ship is.
 *
 * @param {number} radius - Chassis collision radius, px
 * @returns {Graphics}
 */
function buildThrusterFlare(radius) {
  const g = new Graphics();
  const length = radius * 1.15;
  const mouth = radius * 0.62;

  const cone = (len, half, color, alpha) => {
    g.moveTo(-radius * 0.72, -half);
    g.lineTo(-radius * 0.72 - len, 0);
    g.lineTo(-radius * 0.72, half);
    g.closePath();
    g.fill({ color, alpha });
  };

  cone(length * 1.5, mouth, PIXI_TINT.afterburner, 0.42);
  cone(length, mouth * 0.62, PIXI_TINT.afterburnerRim, 0.6);
  cone(length * 0.55, mouth * 0.3, 0xffffff, 0.85);
  return g;
}

/**
 * A wrecked socket: torn plate, an ember pit, and a flame tongue.
 *
 * Drawn once and animated by scale and alpha only. The flame is a separate
 * child from the pit so the two can flicker on different clocks — a vent whose
 * every element pulses in unison reads as one blinking sprite, and the point of
 * a breach is that it is not under control.
 *
 * @param {number} radius - The dead part's collision radius, px
 * @returns {Container}
 */
function buildBreachVent(radius) {
  const holder = new Container();
  const r = radius * BOSS_VIEW.ventScale;

  const pit = new Graphics();
  pit.circle(0, 0, r * 0.7);
  pit.fill({ color: 0x0a0b0e, alpha: 0.92 });
  pit.circle(0, 0, r * 0.44);
  pit.fill({ color: PIXI_TINT.afterburner, alpha: 0.5 });
  // Torn plate: a few spikes off the rim, so the hole reads as broken open
  // rather than as a port that was always there.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.3;
    pit.moveTo(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62);
    pit.lineTo(Math.cos(a + 0.34) * r * 1.02, Math.sin(a + 0.34) * r * 1.02);
    pit.lineTo(Math.cos(a + 0.7) * r * 0.66, Math.sin(a + 0.7) * r * 0.66);
    pit.fill({ color: 0x23262d, alpha: 0.9 });
  }

  const flame = new Graphics();
  flame.circle(0, 0, r * 0.5);
  flame.fill({ color: PIXI_TINT.afterburnerRim, alpha: 0.7 });
  flame.circle(0, 0, r * 0.24);
  flame.fill({ color: 0xffffff, alpha: 0.85 });

  holder.addChild(pit, flame);
  holder.pit = pit;
  holder.flame = flame;
  return holder;
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

/**
 * Linear blend between two packed tints. `t` of 0 is `a`, 1 is `b`.
 *
 * Channel-wise on the ints for the same reason darken() is: this runs once a
 * frame for the length of the enrage flare, and a colour object per call is an
 * allocation with nothing to show for it.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t - 0..1
 * @returns {number}
 */
function mixTint(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const mix = (shift) => {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    return Math.round(ca + (cb - ca) * k);
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
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
    /**
     * Whether white hit flashes are drawn, from the accessibility settings.
     *
     * A plain field the renderer writes, not a settings import: this module
     * draws a boss from a render state and has no business knowing that player
     * preferences exist.
     */
    this.damageFlash = true;
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

    /**
     * Engine corona, drawn once at unit size and then SCALED by load.
     *
     * In `root`, so it stays bolted to the stern as the hull turns — the flare
     * is part of the ship, unlike the beam it fires down. Scaling a static
     * shape rather than redrawing it every frame keeps a flicker that runs at
     * 18Hz off the geometry rebuild path entirely.
     */
    const thruster = buildThrusterFlare(state.radius);
    thruster.alpha = 0;
    root.addChildAt(thruster, 0);

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

      /**
       * The breach vent: what is left of the socket once the module is gone.
       *
       * Built up front and parked invisible for the same reason the wreck is —
       * the frame a part dies is the busiest frame on screen, and it is the
       * wrong moment to be allocating Graphics. In the part's OWN holder, so it
       * turns with the hull and stays in the hole it belongs to.
       */
      const vent = buildBreachVent(partDef.radius);
      vent.visible = false;

      holder.addChild(liveFallback, live, wreck, vent);
      root.addChild(holder);
      parts.set(partDef.id, { def: partDef, holder, live, liveFallback, wreck, vent });
    }

    this.layer.addChild(root);

    /**
     * The world-bearing effects tree — see the note at the top of the file. A
     * SIBLING of root rather than a child, pinned to the same position with
     * rotation left at zero, so nothing drawn in it has to undo the hull spin.
     *
     * Added after root, so the telegraph beam and the well rings paint over the
     * hull. A charge warning the boss's own silhouette could hide is a charge
     * warning that does not work from the one angle it matters most.
     */
    const fx = new Container();
    this.layer.addChild(fx);
    const telegraphGfx = new Graphics();
    const wellGfx = new Graphics();
    const waveGfx = new Graphics();
    fx.addChild(wellGfx, waveGfx, telegraphGfx);

    const view = {
      root,
      fx,
      chassis,
      chassisFallback,
      armorGlow,
      thruster,
      telegraphGfx,
      wellGfx,
      waveGfx,
      parts,
      templateId: state.templateId,
      /** Seconds since this view first saw the boss enraged. Drives the flare. */
      enrageElapsed: 0,
      /** Local animation clock. Independent of the simulation's. */
      time: 0,
    };
    this.views.set(state.id, view);
    return view;
  }

  /**
   * Drive one frame.
   *
   * @param {Object} state - CompositeBoss.getRenderState()
   * @param {number} [dt] - Seconds. Drives the view's own animation clocks
   *   (thruster flicker, enrage flare, well specks) — the ones whose values the
   *   simulation has no reason to hold.
   */
  sync(state, dt = 1 / 60) {
    if (!state) return;
    let view = this.views.get(state.id);
    if (!view || view.templateId !== state.templateId) {
      if (view) this.release(state.id);
      view = this.createView(state);
    }

    view.time += dt;
    view.enrageElapsed = state.enraged ? view.enrageElapsed + dt : 0;

    view.root.x = state.x;
    view.root.y = state.y;
    view.root.rotation = state.rotation;
    view.root.visible = state.alive;
    // Same position, ZERO rotation. Everything in here is authored in world
    // bearings; see the note at the top of the file.
    view.fx.x = state.x;
    view.fx.y = state.y;
    view.fx.visible = state.alive;

    /**
     * The breach flare: the hull washes from grey to running-hot over
     * `enrageFlareSec`, overshooting to white at the moment of the breach and
     * settling back.
     *
     * Ramped rather than switched because this one frame is the payoff for the
     * whole armour-stripping phase of the fight. A hull that simply changed
     * colour between two frames would be missed by a player who was, reasonably
     * enough, looking at the turret they had just destroyed.
     */
    const flashing = this.damageFlash && state.hitFlash > 0;
    let baseHull = BOSS_VIEW.hullTint;
    if (state.enraged) {
      const bloom = Math.min(1, view.enrageElapsed / BOSS_VIEW.enrageFlareSec);
      baseHull =
        bloom < 1
          ? mixTint(BOSS_VIEW.flashTint, BOSS_VIEW.enragedHullTint, bloom)
          : BOSS_VIEW.enragedHullTint;
    }
    const chassisTint = flashing ? BOSS_VIEW.flashTint : baseHull;
    view.chassis.tint = chassisTint;
    // The fallback block is a stand-in for the sprite, not a second layer of
    // feedback — it mirrors the same tint so a flash still reads when the
    // texture never resolved.
    view.chassisFallback.tint = chassisTint;
    view.armorGlow.alpha = state.chassisVulnerable ? 0 : BOSS_VIEW.armoredAlpha;

    this.syncThruster(view, state);

    for (const partState of state.parts) {
      const part = view.parts.get(partState.id);
      if (!part) continue;

      if (!partState.alive) {
        part.live.visible = false;
        part.liveFallback.visible = false;
        part.wreck.visible = true;
        this.syncBreachVent(view, part, state);
        continue;
      }

      // liveFallback's own visibility (texture present or not) was already
      // decided at construction; only the wreck swap toggles it off entirely.
      part.wreck.visible = false;
      part.vent.visible = false;
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
      if (this.damageFlash && partState.hitFlash > 0) {
        part.live.tint = BOSS_VIEW.flashTint;
        part.liveFallback.tint = BOSS_VIEW.flashTint;
      } else {
        const wear = (1 - partState.hpFraction) * BOSS_VIEW.damageFloor;
        part.live.tint = darken(base, wear);
        part.liveFallback.tint = darken(base, wear);
      }
    }

    this.drawTelegraph(view, state);
    this.drawGravityWell(view, state);
    this.drawShockwaves(view, state);
  }

  /* ---------------------------------------------------------------- */
  /* The enraged core                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Engine flare, scaled and flickered by load.
   *
   * `state.thrust` is derived from the chassis's actual velocity (see
   * thrustLoad), so the flare swells through a charge and bleeds off through the
   * recovery coast instead of snapping between two sizes. The flicker is layered
   * on top at a frequency that rises with load: a steady corona reads as a
   * thruster, a jittering one reads as a thruster being over-driven.
   *
   * @param {Object} view
   * @param {Object} state
   */
  syncThruster(view, state) {
    const load = state.enraged ? (state.thrust ?? 0) : 0;
    if (load <= 0.01) {
      view.thruster.alpha = 0;
      return;
    }
    const flicker = 0.86 + Math.sin(view.time * (14 + load * 22)) * 0.14;
    const scale = 1 + (BOSS_VIEW.thrustFlareScale - 1) * load;
    view.thruster.alpha = Math.min(1, 0.45 + load * 0.55) * flicker;
    view.thruster.scale.set(scale * flicker, scale);
  }

  /**
   * Smoke and intermittent flame out of a wrecked socket.
   *
   * Pit and flame flicker on DIFFERENT clocks, offset by the part's own id
   * length so two breaches on the same hull are never in step. The flame gutters
   * out entirely at the bottom of its cycle (a clamped sine, not a scaled one)
   * because a vent that burns steadily reads as a working engine — the thing
   * being communicated is that this hole is not supposed to be here.
   *
   * @param {Object} view
   * @param {Object} part
   * @param {Object} state
   */
  syncBreachVent(view, part, state) {
    part.vent.visible = true;
    const offset = part.def.id.length * 0.7;
    const t = view.time + offset;

    // Embers breathe; they never go out.
    part.vent.pit.alpha = 0.72 + Math.sin(t * 3.1) * 0.18;

    // The flame is a burst, not a glow: zero for most of the cycle, and a
    // guttering tongue for the rest of it.
    const burst = Math.max(0, Math.sin(t * 5.3) - 0.35) / 0.65;
    part.vent.flame.alpha = burst * 0.9;
    part.vent.flame.scale.set(0.5 + burst * 1.3);
    // A hull running hot vents harder. Enrage is not a new vent, it is the same
    // holes with more pressure behind them.
    part.vent.scale.set(state.enraged ? 1.25 : 1);
  }

  /**
   * The charge telegraph: a dashed vector beam down the LOCKED heading.
   *
   * The beam is built from `state.chargeTelegraph.dirX/dirY`, which is the same
   * pair of numbers the charge will actually fly (see CHARGE_STATE in
   * composite-boss.js) — not a fresh look at where the player is standing. That
   * identity is the entire contract: a beam drawn from a second, independently
   * computed heading could point somewhere the boss is not going, and a lying
   * telegraph is worse than none.
   *
   * It TIGHTENS as the window runs out: dashes brighten, close up, and the
   * beam narrows toward its centreline, so the player reads time-to-impact off
   * the beam's shape without a number anywhere on screen.
   *
   * @param {Object} view
   * @param {Object} state
   */
  drawTelegraph(view, state) {
    const g = view.telegraphGfx;
    g.clear();

    const lock = state.chargeTelegraph;
    if (!lock) return;

    const progress = lock.progress ?? 0;
    const angle = Math.atan2(lock.dirY, lock.dirX);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const perpX = -sin;
    const perpY = cos;

    const length = BOSS_VIEW.telegraphLength;
    // Narrows toward the line the bow will actually take, so the danger zone
    // gets MORE precise as it gets more imminent rather than less.
    const half = (BOSS_VIEW.telegraphWidth / 2) * (1 - progress * 0.35);
    const urgency = 0.3 + progress * 0.55;

    // Corridor: the ground the charge is about to occupy, as a filled band.
    const startX = cos * state.radius * 0.8;
    const startY = sin * state.radius * 0.8;
    g.moveTo(startX + perpX * half, startY + perpY * half);
    g.lineTo(startX + cos * length + perpX * half, startY + sin * length + perpY * half);
    g.lineTo(startX + cos * length - perpX * half, startY + sin * length - perpY * half);
    g.lineTo(startX - perpX * half, startY - perpY * half);
    g.closePath();
    g.fill({ color: PIXI_TINT.afterburner, alpha: 0.1 + progress * 0.14 });

    /*
     * Dashes MARCHING OUTWARD along the beam, at a rate that climbs with the
     * clock. A static dashed line says "a charge is coming"; one whose dashes
     * run away from the boss says which way, and how soon.
     */
    const pitch = BOSS_VIEW.telegraphDash;
    const march = (view.time * (140 + progress * 320)) % pitch;
    for (let d = -march; d < length; d += pitch) {
      const a = Math.max(0, d);
      const b = Math.min(length, d + pitch * 0.55);
      if (b <= a) continue;
      g.moveTo(startX + cos * a, startY + sin * a);
      g.lineTo(startX + cos * b, startY + sin * b);
    }
    g.stroke({ color: PIXI_TINT.afterburnerRim, width: half * 0.75, alpha: urgency });

    // Hard edges, so the corridor has a boundary the player can commit to
    // standing outside of. Full radius from frame one — an edge that moved
    // would be an edge nobody could plan against.
    const edge = BOSS_VIEW.telegraphWidth / 2;
    for (const side of [-1, 1]) {
      g.moveTo(startX + perpX * edge * side, startY + perpY * edge * side);
      g.lineTo(
        startX + cos * length + perpX * edge * side,
        startY + sin * length + perpY * edge * side
      );
    }
    g.stroke({ color: PIXI_TINT.danger, width: 2, alpha: 0.35 + progress * 0.45 });
  }

  /**
   * The gravity well: a lensing ring plus specks falling inward.
   *
   * Two jobs, and they are different. The RING marks the boundary, so the
   * player knows where the pull starts and can decide whether to be inside it.
   * The SPECKS are the only thing that shows a force is acting at all — a field
   * is invisible by nature, and without visible matter moving down it the
   * player's ship drifting off their input reads as broken controls.
   *
   * Specks travel from the rim to the core on a fixed clock and are spaced by a
   * deterministic hash of their index, so nothing here needs a particle pool or
   * per-speck state.
   *
   * @param {Object} view
   * @param {Object} state
   */
  drawGravityWell(view, state) {
    const g = view.wellGfx;
    g.clear();

    const well = state.gravityWell;
    if (!well) return;

    const radius = well.radius;
    // Fades in with the enrage rather than appearing at full strength: a 450px
    // field that materialises in one frame reads as a rendering glitch.
    const bloom = Math.min(1, view.enrageElapsed / BOSS_VIEW.enrageFlareSec);
    const breathe = 0.86 + Math.sin(view.time * 1.6) * 0.06;

    // The dark heart. A near-black disc UNDER the violet rings is what makes the
    // core read as swallowing light rather than emitting it.
    g.circle(0, 0, radius * 0.16 * breathe);
    g.fill({ color: 0x05060c, alpha: 0.85 * bloom });

    // Lensing rings: three, contracting, so the field reads as being drawn in.
    for (let i = 0; i < 3; i++) {
      const phase = (view.time * 0.35 + i / 3) % 1;
      const r = radius * (0.24 + (1 - phase) * 0.76);
      g.circle(0, 0, r);
      g.stroke({
        color: i === 0 ? PIXI_TINT.singularityRim : PIXI_TINT.singularity,
        width: 1.5 + (1 - phase) * 2,
        alpha: (0.1 + phase * 0.3) * bloom,
      });
    }

    // The boundary. Solid, at full radius, unmoving.
    g.circle(0, 0, radius);
    g.stroke({ color: PIXI_TINT.singularity, width: 2.5, alpha: 0.42 * bloom });

    /*
     * Infalling specks. `fall` is shared by all of them and the per-speck
     * offset is a hash of the index, which spreads them without an RNG and
     * without storing anything: the same index always draws in the same lane,
     * so the field looks like a field rather than like flickering noise.
     */
    for (let i = 0; i < BOSS_VIEW.wellSpecks; i++) {
      const lane = ((i * 2.399963) % TAU) + view.time * 0.25;
      const offset = ((i * 0.6180339887) % 1);
      const fall = ((view.time / BOSS_VIEW.wellSpeckSec + offset) % 1);
      // Squared, so a speck accelerates as it falls. Linear travel would say
      // the force is uniform, and the whole point of the well is that it is not.
      const r = radius * (1 - fall) * (1 - fall);
      if (r < radius * 0.12) continue;
      // Curved by the same amount the pull curves the player, so the specks
      // and the ship are visibly in the same field.
      const a = lane + fall * 1.1;
      g.circle(Math.cos(a) * r, Math.sin(a) * r, 1.4 + (1 - fall) * 1.6);
      g.fill({ color: PIXI_TINT.singularityRim, alpha: (0.25 + fall * 0.55) * bloom });
    }
  }

  /**
   * Shockwave rings: the warning, then the wave.
   *
   * Both come from `state.shockwaves`, which is the simulation's own list — so
   * a ring drawn here is a ring that can hit, at the radius it can hit at. The
   * warning is drawn at the wave's FINAL radius while `released` is false,
   * which is the same convention the Bio-Acid Bloom telegraph uses: the
   * boundary never moves, so the player can pick their ground before the clock
   * runs out.
   *
   * @param {Object} view
   * @param {Object} state
   */
  drawShockwaves(view, state) {
    const g = view.waveGfx;
    g.clear();

    const rings = state.shockwaves ?? [];
    for (const ring of rings) {
      const reach = ring.maxRadius > 0 ? ring.maxRadius : state.radius * 6;

      if (!ring.released) {
        /*
         * Pre-release: a pulsing outline at the wave's FINAL radius, pulsing
         * faster as the warning runs out. The circle does not grow — an edge
         * that moved would be an edge nobody could plan against, which is the
         * same rule the Bio-Acid Bloom telegraph follows.
         */
        const pulse = 0.3 + Math.sin(view.time * (8 + ring.warnProgress * 16)) * 0.2;
        g.circle(0, 0, reach);
        g.stroke({
          color: PIXI_TINT.danger,
          width: 2 + ring.warnProgress * 4,
          alpha: pulse + ring.warnProgress * 0.3,
        });
        continue;
      }

      // The band itself: two strokes a thickness apart, so the ring reads as
      // something with an inside and an outside rather than as a growing disc.
      // It thins out as it nears its reach, so the wave dying is visible and
      // the player knows when the ground behind them is clean again.
      const fade = Math.max(0, 1 - ring.radius / Math.max(1, reach));
      g.circle(0, 0, ring.radius);
      g.stroke({ color: PIXI_TINT.singularityRim, width: 7, alpha: 0.75 * fade + 0.15 });
      g.circle(0, 0, ring.radius * 0.94);
      g.stroke({ color: PIXI_TINT.singularity, width: 3, alpha: 0.4 * fade + 0.1 });
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
    // The fx tree is a SIBLING, not a child (see the note at the top), so
    // destroying the root does not take it with it. A boss released without
    // this leaves its telegraph beam painted on the arena forever.
    if (view.fx) {
      this.layer.removeChild(view.fx);
      view.fx.destroy({ children: true });
    }
    this.views.delete(bossId);
  }

  /** Tear down every live boss view — run start, or renderer teardown. */
  clear() {
    for (const bossId of [...this.views.keys()]) this.release(bossId);
  }
}
