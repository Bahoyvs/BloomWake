/**
 * Chitin Swarm visual identity — how a simulation entity becomes a sprite.
 *
 * ---------------------------------------------------------------------------
 * TINT OVER DETAIL, NOT TINT INSTEAD OF DETAIL
 * ---------------------------------------------------------------------------
 * Every hull comes from one of the two Kenney atlases in public/assets/ships/,
 * and gets a `.tint` and a scale applied here. The tint is what makes the
 * palette enforceable — a tint is a number this module reads from a table,
 * where a baked-in colour is a pixel no test can check — and it is what lets
 * the whole swarm batch into one draw call per atlas.
 *
 * The frames underneath are NOT flat silhouettes. They carry canopies, wing
 * plates and engine blocks, and because a tint multiplies, that internal
 * shading survives it: a tinted hull reads as a lit object rather than as a
 * coloured cut-out. An earlier revision drew everything from a flat white
 * silhouette pack, which made the tint the only information on screen and left
 * every ship looking like a cursor.
 *
 * SILHOUETTE CARRIES THE SPECIES, SCALE CARRIES THE THREAT.
 * Tint cannot do that job: at speed, against a dark backdrop, five dark hulls
 * differ by outline and size long before they differ by hue. So each species
 * takes a different frame (see ASSET_MANIFEST) and the `scale` figures below
 * span 0.6x to 1.5x — a spread wide enough to read as chaff-vs-cruiser in
 * peripheral vision.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE DEFORMS
 * ---------------------------------------------------------------------------
 * These are machines. There is no squash-and-stretch, no sine on `scale.x/y`,
 * no jelly wobble anywhere in this module or in juice.js. An earlier pass gave
 * every hull a breathing cycle and the boss a volume-preserving squash, which
 * is the right language for something soft and completely wrong for a fleet:
 * at speed it read as the whole screen being made of rubber.
 *
 * What moves instead is what would move on a real ship — a reactor's light, a
 * turret bearing, an engine plume — plus hard, short, KINETIC reactions: a
 * two-frame white flash and a backward jolt when something is hit. Impact is
 * communicated by displacement and brightness, never by deformation.
 *
 * ---------------------------------------------------------------------------
 * THE DREADNOUGHT STATION IS DIFFERENT
 * ---------------------------------------------------------------------------
 * The boss exists exactly once and fills a quarter of the screen. It is the
 * only enemy the player studies rather than dodges, so it is built rather than
 * picked: a wide horizontal cross-member, a vertical keel over it, two turret
 * platforms at the beam tips, and a reactor at the hub. Five sprites on their
 * own clocks is the cheapest way to make something that large read as a machine
 * instead of a decal.
 */

import { Container, Sprite } from 'pixi.js';
import { ENEMIES } from '../data/enemies.js';
import { ENEMY_ARCHETYPES } from '../data/roster-config.js';
import { PALETTE, THEME } from './theme.js';

/** Pixi tints multiply, so white = no tint. */
export const NO_TINT = 0xffffff;

/**
 * Damage flash — pure white, for one or two frames.
 *
 * Was a warm orange, which reads as "on fire" rather than "struck" and, being a
 * multiply, could not brighten a dark hull past its own colour. White is the
 * only tint that makes a near-black carapace go bright, so it is the only one
 * that registers on the Swarm at all. It is paired with a kinetic knock in the
 * simulation (HIT_KICK_IMPULSE): flash says WHERE the hit landed, the knock
 * says that it landed hard.
 */
export const DAMAGE_TINT = 0xffffff;

/**
 * Kenney hulls are drawn pointing UP (-Y). The renderer's facing maths assumes
 * art points along +X, so every hull needs a quarter turn.
 */
export const HULL_ROTATION_OFFSET = Math.PI / 2;

/**
 * The Void Drifter's hull wash.
 *
 * NOT raw PALETTE.heroPrimary, and the difference matters. The hero frame is
 * already a blue fighter with a canopy, wing plates and engine blocks; a tint
 * multiplies, so washing it with saturated 0x00F0FF would zero the red channel
 * across the whole hull, flatten every one of those details into one cyan
 * shape, and drag the mean luminance under the 0.6 hero floor that keeps the
 * player findable in a 200-enemy swarm.
 *
 * A near-white cyan shifts the hull's hue without spending its brightness or
 * its shading. The saturated neon stays where it reads best and costs nothing:
 * the engine flames, the ion trail, the shield and the HUD.
 *
 * A cosmetic overrides this (see cosmeticTint), which is why it is a default
 * rather than something baked into the frame.
 */
export const HERO_TINT = 0xcffcff;

/**
 * Engine flames, stamped behind the hull at these hull-local offsets.
 *
 * `back` pushes the nozzle behind the centre and `side` splits the pair, both
 * as fractions of the rendered hull diameter, so the exhausts stay glued to the
 * ship at any scale. Length reacts to speed — see thrusterLength.
 */
export const THRUSTER = {
  back: 0.40,
  side: 0.20,
  /** Flame length as a fraction of hull diameter, idle -> full throttle. */
  minLength: 0.20,
  maxLength: 0.78,
  /**
   * Flame width as a fraction of hull diameter.
   *
   * Narrow on purpose. The source frame is a soft gradient plume, and at
   * anything near a quarter of the hull's width it stops reading as a jet and
   * starts reading as a blue smudge stuck to the back of the ship. Long and
   * thin is what says "thrust".
   */
  width: 0.15,
  minAlpha: 0.35,
  maxAlpha: 0.95,
  /** Flicker, so the burn is never a static triangle. */
  flicker: { rate: 34, amount: 0.16 },
  tint: PALETTE.heroPrimary,
};

/**
 * Flame length and alpha for a given throttle.
 *
 * @param {number} throttle - 0 (coasting) .. 1 (full burn)
 * @param {number} t - Seconds, for the flicker
 * @returns {{length: number, alpha: number}} Fractions of hull diameter
 */
export function thrusterFlame(throttle, t) {
  const drive = throttle < 0 ? 0 : throttle > 1 ? 1 : throttle;
  const flicker = 1 + Math.sin(t * THRUSTER.flicker.rate) * THRUSTER.flicker.amount * drive;
  return {
    length: (THRUSTER.minLength + (THRUSTER.maxLength - THRUSTER.minLength) * drive) * flicker,
    alpha: THRUSTER.minAlpha + (THRUSTER.maxAlpha - THRUSTER.minAlpha) * drive,
  };
}

/**
 * On-screen diameter, in px, of a species whose `scale` is exactly 1.
 *
 * THE SCALE FIGURES ARE ABSOLUTE, NOT RELATIVE TO THE HITBOX.
 * An earlier revision multiplied `scale` into the entity's collision radius,
 * which double-counted size: the radii already span 9px to 20px, so a 0.6x-1.5x
 * multiplier on top produced a near-5x spread and rendered the wave-1 chaff at
 * 28px — too small to have a silhouette at all, which defeated the point of
 * picking distinct hulls.
 *
 * Sizing off a shared reference instead means the brief's 0.6x-1.5x band is
 * exactly what lands on screen, and `fit` becomes a derived quantity rather
 * than a second number to keep in sync. See enemyFit.
 */
export const SWARM_REFERENCE_DIAMETER = 64;

/**
 * Per-species presentation, in three weight classes.
 *
 * `scale` is the designer-facing figure, relative to the base fit, and the
 * spread across the roster is the point: 0.6x chaff up to 1.5x cruiser, so
 * threat is legible from size alone before the player has resolved a shape.
 * `tint` washes the hull. `bioPulse` is the bioluminescent shell shimmer (see
 * bioLuminance). Everything here is presentation: not one field reaches the
 * simulation.
 */
export const ENEMY_VIEW = {
  /* --- Light: small, fast, and the only things that arrive in numbers. --- */

  /** Xeno Larva — faceted diamond core. The smallest thing on the field. */
  tarling: {
    name: 'Xeno Larva',
    class: 'light',
    scale: 0.55,
    tint: 0x1b1464,
    bioPulse: { rate: 3.1, amount: 0.07 },
  },
  /** Dart Ravager — needle wings, and the only hull that stops to aim. */
  cracked_wisp: {
    name: 'Dart Ravager',
    class: 'light',
    scale: 0.75,
    tint: 0x833471,
    bioPulse: { rate: 4.2, amount: 0.12 },
    /**
     * Lock-on warning. Painted while the simulation holds the enemy in its
     * WINDUP state, which is exactly the window the player has to move — so
     * the visual and the dodge window are the same object, not two numbers
     * that have to be kept in step.
     */
    lockOn: { tint: 0xff2a55, rings: 2 },
  },

  /* --- Medium: deliberate, and each with a trick. --- */

  /** Mantis Strider — twin mandibles; arcs in from the flank. */
  ashfish: {
    name: 'Mantis Strider',
    class: 'medium',
    scale: 0.8,
    tint: 0x006266,
    bioPulse: { rate: 2.4, amount: 0.1 },
  },
  /** Phantom Stalker — two-tier faceted shell, goes dark on the approach. */
  smogmoth: {
    name: 'Phantom Stalker',
    class: 'medium',
    scale: 0.95,
    tint: 0x2c3a47,
    bioPulse: { rate: 2.0, amount: 0.06 },
    /**
     * NOT a shimmer. The cloak is driven by `entity.visibility`, a simulation
     * value, because how visible it is decides whether the player can react to
     * it — that is gameplay, not decoration, and the renderer only reads it.
     */
    cloak: true,
  },

  /* --- Heavy: the ones that are in the way. --- */

  /** Brood Spore — four-node polyp body. Bursts into larvae when killed. */
  rustbloom: {
    name: 'Brood Spore',
    class: 'heavy',
    scale: 1.15,
    tint: 0x3b3b98,
    bioPulse: { rate: 1.5, amount: 0.14 },
  },
  /**
   * Bio-Goliath — the widest hull short of the boss, at 1.5x.
   *
   * The silhouette is doing real work here: this is the species that strips
   * pierce off anything that hits it, so the player has to be able to tell at a
   * glance that shooting THROUGH it is not going to happen.
   */
  bio_goliath: {
    name: 'Bio-Goliath',
    class: 'heavy',
    scale: 1.5,
    tint: 0x4a148c,
    bioPulse: { rate: 1.1, amount: 0.1 },
  },

  /** The Dreadnought Station. Scale is driven by DREADNOUGHT below, not `fit`. */
  rustwhale: {
    name: 'Dreadnought Station',
    class: 'boss',
    scale: 1.5,
    tint: PALETTE.alienObsidian,
    bioPulse: null,
  },
};

/**
 * Per-archetype presentation for the roster-config catalogue.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECOND TABLE AND NOT SIX MORE ROWS ABOVE
 * ---------------------------------------------------------------------------
 * ENEMY_VIEW is the shipped Chitin Swarm: six classes at six distinct sizes,
 * and that "six" is a contract the theme suite asserts because it is what lets
 * a player triage a mixed wave by silhouette alone. The archetypes in
 * src/data/roster-config.js are a SECOND catalogue, live at the same time
 * behind Simulation's `useRosterConfig` flag, with its own ids. Merging them
 * would put twelve rows in a table whose whole premise is that it holds six.
 *
 * Both tables resolve through getEnemyView, so nothing downstream knows or
 * cares which catalogue an enemy came from.
 *
 * ---------------------------------------------------------------------------
 * THIS TABLE IS WHY THE SWARM USED TO BE WHITE
 * ---------------------------------------------------------------------------
 * Before it existed, every roster-config enemy missed its lookup and took
 * DEFAULT_VIEW: NO_TINT, scale 1. NO_TINT is white, and a Pixi tint multiplies,
 * so the entire live swarm rendered as untinted pale geometry at one uniform
 * size, turning on its facing angle — the "rotating white squares" this pass
 * was opened against. A default that renders *something* is right; a default
 * that renders something indistinguishable from correct art is how a whole
 * roster ships unpainted.
 *
 * ---------------------------------------------------------------------------
 * THE TINTS ARE DARKER THAN THE BRIEF ASKED FOR, DELIBERATELY
 * ---------------------------------------------------------------------------
 * The acid-green and blood-red the art brief named (0x10ac84, 0xff6b6b, and
 * the amber 0xfeca57) measure 0.31, 0.33 and 0.64 relative luminance, against
 * a MAX_ENEMY_LUMINANCE ceiling of 0.25 (src/render/theme.js). That ceiling is
 * not a style preference — it is what keeps the Drifter the brightest object on
 * a screen holding two hundred enemies, and tests/theme.test.js enforces it.
 * So each species keeps the HUE the brief chose and takes it down into the
 * band: venom green, void indigo, blood red, plated gunmetal, all under 0.25.
 * Saturated signal colour still exists in this game; it lives on the things
 * that must be read instantly — telegraphs, the reactor, death sprays — and
 * none of those are hulls.
 */
export const ARCHETYPE_VIEW = {
  /**
   * Xeno Larva — venom green, the acid swarm read, and the fastest shimmer on
   * the field. At 0.55 it is the smallest hull the game draws.
   */
  larva_swarm: {
    name: 'Xeno Larva',
    class: 'light',
    scale: 0.55,
    tint: 0x0e7a5c,
    bioPulse: { rate: 3.0, amount: 0.12 },
  },
  /** Mantis Strider — deep void indigo; the weave is its tell, not its colour. */
  mantis_weaver: {
    name: 'Mantis Strider',
    class: 'medium',
    scale: 0.75,
    tint: 0x3d1a8f,
    bioPulse: { rate: 2.4, amount: 0.1 },
  },
  /**
   * Dart Ravager — blood chitin, and the only aggressive red in the swarm.
   *
   * `lockOn` is read by the renderer for exactly as long as the simulation
   * holds this enemy in its telegraph state, so the warning and the dodge
   * window are the same object. Its red is NOT this hull's red: a telegraph
   * that matched the hull it came off would vanish into it.
   */
  dart_rammer: {
    name: 'Dart Ravager',
    class: 'medium',
    scale: 0.78,
    tint: 0xa02334,
    bioPulse: { rate: 4.2, amount: 0.12 },
    lockOn: { tint: 0xff2a55, rings: 2 },
  },
  /** Spore Scout — venom teal, a colder relative of the Larva's green. */
  spore_kiter: {
    name: 'Spore Scout',
    class: 'medium',
    scale: 0.8,
    tint: 0x0f6d75,
    bioPulse: { rate: 2.2, amount: 0.09 },
  },
  /**
   * Spore Artillery — the Scout's hull, darker and a fifth larger.
   *
   * Same silhouette on purpose (roster-config says so and means it): the
   * player reads "kiter" from the shape and has to notice the three-shot fan.
   * Size and depth of tint are the only warning that this twin hits harder.
   */
  spore_barrage: {
    name: 'Spore Artillery',
    class: 'heavy',
    scale: 0.95,
    tint: 0x105c63,
    bioPulse: { rate: 1.8, amount: 0.08 },
  },
  /**
   * Brood Bastion — plated carapace over the Larva's outline at 1.3x.
   *
   * The only gunmetal hull in the swarm, and the slowest pulse: it reads as
   * armour plate rather than as something alive, which is the point of the
   * species. The brief's amber cockpit highlight is not here — a Pixi tint is
   * one colour for the whole sprite, so a second accent would need either a
   * second sprite stacked on this one or a shader, and neither is worth a
   * per-entity cost on a hull that arrives in packs.
   */
  brood_bastion: {
    name: 'Brood Bastion',
    class: 'heavy',
    scale: 1.3,
    tint: 0x222f3e,
    bioPulse: { rate: 1.2, amount: 0.07 },
  },
};

/** Neutral view for an id with no row — a new enemy renders, it just renders plain. */
const DEFAULT_VIEW = { name: 'Unknown', scale: 1, tint: NO_TINT, bioPulse: null };

/**
 * Presentation row for an enemy id, from EITHER catalogue.
 *
 * @param {string} typeId - Legacy roster typeId, or a roster-config archetype id
 * @returns {Object}
 */
export function getEnemyView(typeId) {
  return ENEMY_VIEW[typeId] ?? ARCHETYPE_VIEW[typeId] ?? DEFAULT_VIEW;
}

/**
 * Pixi tint for a species.
 * @param {string} typeId
 * @returns {number}
 */
export function enemyTint(typeId) {
  return getEnemyView(typeId).tint ?? NO_TINT;
}

/**
 * Rendered diameter for a species, in px.
 * @param {string} typeId
 * @returns {number}
 */
export function enemyDiameter(typeId) {
  return SWARM_REFERENCE_DIAMETER * (getEnemyView(typeId).scale ?? 1);
}

/**
 * `fit` for scaleForRadius: the multiple of the collision DIAMETER that lands
 * the species at its intended on-screen size.
 *
 * Derived rather than authored, so the roster's visual sizes stay in the
 * designed ratio even when a collision radius is retuned for gameplay reasons.
 * A species with no radius in the data table falls back to 1 — it renders at
 * its hitbox size, which is wrong-looking but never wrong-sized.
 *
 * @param {string} typeId
 * @returns {number}
 */
export function enemyFit(typeId) {
  // Both catalogues, for the same reason getEnemyView reads both: an archetype
  // has a radius too, it just lives in roster-config rather than in ENEMIES.
  // Missing it here was the second half of the untinted-swarm bug — every
  // archetype fell to fit 1 and rendered at its hitbox size, which is a third
  // smaller than its designed footprint.
  const radius = ENEMIES[typeId]?.radius ?? ENEMY_ARCHETYPES[typeId]?.radius;
  if (!(radius > 0)) return 1;
  return enemyDiameter(typeId) / (radius * 2);
}

/* ------------------------------------------------------------------ */
/* Bioluminescence                                                     */
/* ------------------------------------------------------------------ */

/**
 * Sine shell-glow, as an alpha multiplier.
 *
 * Alpha rather than a brightness filter for one reason: a filter is a render
 * pass per entity and this runs on up to 200 of them. Alpha is a number Pixi
 * already writes into the batch it was going to build anyway, so the whole
 * effect is free.
 *
 * `phaseOffset` is the entity's existing per-instance jitter (the same number
 * the shared swim-cycle uses), so a wall of larvae shimmers out of step
 * instead of breathing in unison like one organism.
 *
 * @param {number} t - Seconds
 * @param {number} phaseOffset - Per-entity offset
 * @param {Object} view - Row from ENEMY_VIEW
 * @returns {number} Alpha multiplier, <= 1
 */
export function bioLuminance(t, phaseOffset, view, entity = null) {
  let alpha = 1;

  const pulse = view?.bioPulse;
  if (pulse) {
    // Sits at or below 1 so a shimmer never brightens an enemy past its
    // painted luminance — the Visual Soup contract is on the palette, and an
    // effect that could exceed it would move the ceiling at runtime.
    alpha -= pulse.amount * (0.5 + 0.5 * Math.sin(t * pulse.rate + phaseOffset));
  }

  /*
   * The Phantom Stalker's cloak, read straight off the simulation entity.
   *
   * This used to be a free-running sine on the renderer's own clock, which
   * meant the moment an enemy was hard to see had nothing to do with where it
   * was or what it was doing — decoration wearing a mechanic's clothes. It is
   * now `entity.visibility`, set by Simulation.updateCloak, so the fade IS the
   * mechanic and the reveal happens at exactly the range the player can act on.
   */
  if (view?.cloak && entity && entity.visibility !== undefined) {
    alpha *= entity.visibility;
  }

  return alpha;
}

/* ------------------------------------------------------------------ */
/* The Dreadnought Station                                             */
/* ------------------------------------------------------------------ */

/**
 * The boss chassis.
 *
 * Four sprites, and each one is doing a job the others cannot:
 *
 *   SPINE    the cross-shaped station keel. Heavy, grey, armoured — it is the
 *            thing the player is shooting at, so it stays the largest and the
 *            least decorated element.
 *   TURRETS  two mirrored platforms bolted to the flanks. They break the keel's
 *            vertical symmetry and give the outline shoulders, which is what
 *            makes a cross read as a warship rather than as a plus sign.
 *   REACTOR  a housed core seated INTO the chassis, not stuck on top of it.
 *            It is the only warm colour on the boss and the only thing that
 *            pulses, so it is where the eye goes.
 *
 * The whole assembly turns slowly on its own axis. That rotation is the single
 * cheapest signal that this is a station under power and not a backdrop: at
 * `spin` rad/s it takes the better part of a minute to come round, which reads
 * as mass rather than as motion.
 */
export const DREADNOUGHT = {
  /**
   * Base scale, as a multiple of collision diameter.
   *
   * A SINGLE FIGURE, not a range. The station used to breathe between 1.92 and
   * 2.08 with a volume-preserving squash on top, which at boss size read as the
   * whole structure being made of rubber. A capital ship does not pulse. What
   * moves now is the reactor's light and the turrets' bearings — parts that
   * have a reason to move — and the hull itself is rigid.
   */
  scale: 2.2,
  /**
   * Hull spin, rad/s. Deliberately near-imperceptible per frame — this is the
   * ~0.002 rad/frame figure the brief asks for, expressed per second so it
   * stays correct if the frame rate ever moves. It is the one motion left on
   * the chassis, and it reads as mass rather than as animation.
   */
  spin: 0.12,

  /**
   * Part sizes, as fractions of the container's box.
   *
   * The assembly is authored against the BOX rather than against the keel's
   * width, because the widest element is now the horizontal cross-member and
   * it is sized to fill the box outright. The keel is laid over it.
   */
  /** Horizontal cross-member: the thing that gives the station its shoulders. */
  beamScale: 1.0,
  /**
   * Vertical keel, laid over the beam.
   *
   * Smaller than the beam ON PURPOSE. The keel frame is portrait, so at any
   * scale it is narrower than it is tall; letting the beam out-span it is what
   * turns a tall bar into a wide cross.
   */
  keelScale: 0.86,
  /** Turret platforms, bolted at the beam's tips. */
  turretScale: 0.34,
  turretOffset: 0.4,
  /**
   * Turrets rotate slowly and continuously, like bearings under power. Not a
   * sine wobble — a wobble reads as a loose plate.
   */
  turretSpin: 0.55,
  reactorScale: 0.28,

  /**
   * Where the keel's own hub sits inside its normalised box, as a fraction.
   *
   * MEASURED FROM THE FRAME, not guessed: spaceStation_026's widest row — the
   * horizontal arm of its own cross — sits at y = -0.245 of its normalised box,
   * because the frame has a long lower arm that drags its geometric centre well
   * below the hub. The keel is shifted so that hub lands on the container
   * origin, where the beam, the turrets and the reactor all are.
   *
   * Swapping the keel frame means re-measuring this. Parts mounted at the
   * keel's CENTRE instead hang in the empty space under the chassis, which is
   * exactly what the first assembly looked like.
   */
  keelHubY: -0.245,

  /** Reactor warning pulse. The only thing on the boss that changes size. */
  reactorGlow: { rate: 2.2, min: 0.5, max: 1.0 },
  reactorSwell: 0.12,
  /** Extra glow while a phase-3 death ray is charging. */
  reactorCharge: 1.45,

  hullTint: 0x646b78,
  beamTint: 0x585e6a,
  turretTint: 0x4e535f,
  /**
   * Reactor warning light. Between the theme's danger red and hive magenta —
   * the boss's own hazard colour, distinct from both the telegraph ring (pure
   * danger red) and a corpse burst (acid green), so three different red-ish
   * events on one screen stay three different events.
   */
  reactorTint: 0xff3d7a,
};

/**
 * Normalise a sprite to a box `size` wide, so the container's scale is the only
 * place absolute size is decided.
 *
 * Sized off the frame's LARGER dimension rather than its width. The parts come
 * from two atlases and are wildly non-square — the keel is a tall cross, a
 * turret platform is a squat diamond — and dividing a tall frame by its width
 * would blow it up to several times the intended height.
 *
 * @param {Sprite} sprite
 * @param {{width: number, height: number}} texture
 * @param {number} size - Target box, as a fraction of the container's scale
 */
function fitToBox(sprite, texture, size) {
  const source = Math.max(texture?.width || 0, texture?.height || 0, 1);
  sprite.scale.set(size / source);
}

/**
 * Build the boss's five-layer display object.
 *
 * LAYER ORDER IS THE DESIGN:
 *
 *   BEAM     a wide horizontal slab laid across the middle. Goes down first,
 *            and it is the reason the station has a silhouette at all — the
 *            keel alone is a tall thin cross that reads as a single bar at any
 *            distance, which is exactly what the brief asked to be rid of.
 *   TURRETS  two platforms at the beam's tips. They sit on the beam and give
 *            the outline shoulders.
 *   KEEL     the vertical cross-section, laid over the join so the beam and
 *            the turret roots disappear under it and the whole thing reads as
 *            one welded structure rather than three overlapping decals.
 *   REACTOR  a housed core at the hub. The only warm colour on the boss and
 *            the only part that changes size, so it is where the eye goes.
 *
 * EVERYTHING IS AUTHORED AROUND THE ORIGIN. The keel is offset DOWN by its own
 * measured hub so that its arms cross at (0,0), which is where the beam, the
 * turrets and the reactor all live. Mounting parts at the keel's geometric
 * centre instead hangs them in the empty space under the chassis.
 *
 * The returned record is also attached to the container as `.dreadnought`. The
 * renderer pools display objects by texture key and gets a bare container back
 * on reuse, so the parts have to be recoverable from the container alone —
 * reading `children[0]` would work right up until someone added a sixth layer.
 *
 * @param {import('pixi.js').Texture} spineTexture - The vertical keel
 * @param {import('pixi.js').Texture} turretTexture
 * @param {import('pixi.js').Texture} reactorTexture
 * @param {import('pixi.js').Texture} [beamTexture] - Horizontal cross-member
 * @returns {{container: Container, spine: Sprite, beam: Sprite,
 *   turrets: Array<Sprite>, reactor: Sprite, tintTargets: Array<Sprite>}}
 */
export function createDreadnought(spineTexture, turretTexture, reactorTexture, beamTexture) {
  const container = new Container();

  // Pixi accepts `undefined` for a texture and substitutes Texture.EMPTY, but
  // throws on `null`. A missing asset must degrade to an invisible part, not
  // take the boss down with it, so coalesce before constructing.
  const spineTex = spineTexture ?? undefined;
  const turretTex = turretTexture ?? undefined;
  const reactorTex = reactorTexture ?? undefined;
  const beamTex = beamTexture ?? undefined;

  const beam = new Sprite(beamTex);
  beam.anchor.set(0.5, 0.5);
  beam.tint = DREADNOUGHT.beamTint;
  fitToBox(beam, beamTex, DREADNOUGHT.beamScale);

  const turrets = [-1, 1].map((side) => {
    const turret = new Sprite(turretTex);
    turret.anchor.set(0.5, 0.5);
    turret.tint = DREADNOUGHT.turretTint;
    fitToBox(turret, turretTex, DREADNOUGHT.turretScale);
    turret.x = side * DREADNOUGHT.turretOffset;
    return turret;
  });

  const spine = new Sprite(spineTex);
  spine.anchor.set(0.5, 0.5);
  spine.tint = DREADNOUGHT.hullTint;
  fitToBox(spine, spineTex, DREADNOUGHT.keelScale);
  // Bring the keel's measured hub onto the container origin.
  spine.y = -DREADNOUGHT.keelHubY * DREADNOUGHT.keelScale;

  const reactor = new Sprite(reactorTex);
  reactor.anchor.set(0.5, 0.5);
  reactor.tint = DREADNOUGHT.reactorTint;
  fitToBox(reactor, reactorTex, DREADNOUGHT.reactorScale);

  container.addChild(beam, turrets[0], turrets[1], spine, reactor);

  const record = {
    container,
    spine,
    beam,
    turrets,
    reactor,
    // The reactor is deliberately absent: it must keep its warning colour
    // through a damage flash, because it is the weak point the player is
    // aiming at and losing it to the flash hides the target at exactly the
    // moment they are hitting it.
    tintTargets: [spine, beam, ...turrets],
  };
  container.dreadnought = record;
  return record;
}

/**
 * Recover the composite record from a container the pool handed back.
 * @param {Container} container
 * @returns {{spine: Sprite, turrets: Array<Sprite>, reactor: Sprite,
 *   tintTargets: Array<Sprite>}|null}
 */
export function getDreadnoughtParts(container) {
  return container?.dreadnought ?? null;
}

/**
 * Drive one frame of the Dreadnought.
 *
 * THE HULL IS RIGID. `scale` is a constant and nothing here writes a squash
 * into `out` any more — the previous version deformed the whole chassis on a
 * sine, which at boss size read as a rubber station. What is left moves for a
 * reason: the hull turns on its axis, the turret bearings turn, and the reactor
 * glows. `out` is still accepted so the caller's authored state FX (a death
 * collapse) can compose on top.
 *
 * @param {number} t - Seconds
 * @param {Object} [out] - Caller's transform; untouched, kept for symmetry
 * @param {boolean} [charging] - True while a death ray is winding up
 * @returns {{scale: number, hullRotation: number, turretSpin: number,
 *   reactorAlpha: number, reactorScale: number}}
 */
export function dreadnoughtPulse(t, out, charging = false) {
  const glow = DREADNOUGHT.reactorGlow;
  const glowWave = 0.5 + 0.5 * Math.sin(t * glow.rate * (charging ? 3 : 1));
  const alpha = glow.min + (glow.max - glow.min) * glowWave;

  return {
    scale: DREADNOUGHT.scale,
    hullRotation: t * DREADNOUGHT.spin,
    /** Continuous, not oscillating: these are bearings, not loose plates. */
    turretSpin: t * DREADNOUGHT.turretSpin,
    // Clamped, because the charge multiplier would otherwise push a display
    // object past full opacity and silently do nothing.
    reactorAlpha: Math.min(1, charging ? alpha * DREADNOUGHT.reactorCharge : alpha),
    reactorScale:
      1 + DREADNOUGHT.reactorSwell * glowWave * (charging ? DREADNOUGHT.reactorCharge : 1),
  };
}

/* ------------------------------------------------------------------ */
/* Death VFX                                                           */
/* ------------------------------------------------------------------ */

/**
 * What a ruptured carapace throws off: bio-acid green and hive magenta, never
 * the enemy's own body colour.
 *
 * A corpse burst painted in the enemy's tint is invisible against the enemies
 * still alive around it — the player cannot tell a kill from a near-miss in a
 * crowd. Spraying the two bioluminescent signal colours instead means a kill
 * always reads, at any swarm density.
 */
export const DEATH_SPRAY = {
  primary: THEME.bio.acid,
  secondary: THEME.bio.magenta,
  /** Fraction of motes that take the secondary colour. */
  secondaryShare: 0.4,
};
