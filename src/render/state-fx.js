/**
 * Procedural state FX for Tier A entities (Phase 7b).
 *
 * WHY THIS EXISTS
 * Tier A was built to play sprite sheets, and it does — but a sheet that is not
 * on disk animates nothing, and core emits its transient states (hit, attack)
 * for exactly one tick because core is not allowed to know about durations.
 * The result with no art was a 16ms state flicker: technically correct, visibly
 * nothing.
 *
 * So the semantic state machine in src/core/animation.js is unchanged — it was
 * never the broken part — and this module supplies the other half the renderer
 * always owed it: how long a state should be SHOWN, and what it looks like
 * while it is. Squash-and-stretch, a flash, a particle burst and a trail boost
 * carry the animation instead of frames.
 *
 * This is not a stopgap. When sheets do arrive they take over the entity's
 * texture, and these transforms stay as an additive layer — a sprite sheet and
 * a squash multiply together fine. The FX are authored to read on their own so
 * the game feels animated before a single frame is drawn.
 *
 * SHAPE LANGUAGE: NONE. THIS IS A SHIP.
 * The first version of this module was written for a soft creature and used
 * volume-preserving squash-and-stretch everywhere — the Drifter bounced as it
 * moved, bulged when it fired and flattened when it was hit, and the boss
 * swelled on a sine. Re-skinned as a fighter and a capital station, all of that
 * reads as the hardware being made of rubber.
 *
 * The replacement vocabulary is rigid and kinetic:
 *
 *   - IMPACT is displacement. Firing kicks the hull backward along the shot
 *     line and it snaps back (see RECOIL/attackRecoil); being hit shoves it and
 *     rings out. The sprite never changes shape.
 *   - EMPHASIS is brightness. A white flash for two or three frames.
 *   - DEATH is the one place scale still moves, as a straight collapse, because
 *     a ship being destroyed genuinely stops being ship-shaped.
 *
 * Same rules as juice.js: pure functions, no module state, results written into
 * a caller-owned transform. Tier A is two entities, so cost is irrelevant here —
 * the discipline is for consistency, not performance.
 */

import { ANIM_STATES } from '../core/animation.js';

/**
 * How long each state is SHOWN, in seconds, independent of how long core says
 * the entity was semantically in it.
 *
 * `duration: 0` means "hold until core says otherwise" — idle and move are
 * continuous states with no natural end. The others are one-shot reactions, and
 * their duration is the minimum time the player is guaranteed to see them. That
 * minimum is the actual fix for the one-frame flicker.
 *
 * Values are tuned to read at a glance without feeling sluggish: a hit needs to
 * survive being noticed (~13 frames), an attack should feel snappy (~10), and a
 * death wants room to land.
 */
export const HERO_FX = {
  [ANIM_STATES.IDLE]: { duration: 0, loop: true },
  [ANIM_STATES.MOVE]: { duration: 0, loop: true },
  [ANIM_STATES.ATTACK]: { duration: 0.17, loop: false },
  [ANIM_STATES.HIT]: { duration: 0.22, loop: false },
  [ANIM_STATES.DEATH]: { duration: 0.75, loop: false },
};

/**
 * The Drifter's weapon recoil.
 *
 * A LINEAR IMPULSE, NOT A SPRING. The hull is knocked straight back along the
 * inverse of the firing line and is home again in `duration`. The brief pins
 * that at ~0.06s, which is under four frames: fast enough to read as a snap
 * rather than as the ship drifting backwards, and short enough that at the
 * Phase Repeater's L5 fire rate consecutive shots do not overlap into a
 * permanent offset.
 *
 * `attackRecoil` reads these; the old version was a half-sine over the whole
 * 0.17s attack state, which was long enough to see the ship travelling.
 */
export const RECOIL = {
  /** Seconds from full kick back to rest. */
  duration: 0.06,
  /** Peak displacement in px, opposite the firing angle. */
  distance: 9,
};

/**
 * Boss states. `telegraph` has NO duration here on purpose: it is overridden at
 * runtime with the Black Tide fairness window, exactly as the sprite path
 * derives its fps from it. See Renderer.bindEvents.
 */
export const BOSS_FX = {
  [ANIM_STATES.IDLE]: { duration: 0, loop: true },
  [ANIM_STATES.TELEGRAPH]: { duration: 0, loop: false },
  [ANIM_STATES.ATTACK]: { duration: 0.3, loop: false },
  [ANIM_STATES.HIT]: { duration: 0.16, loop: false },
  [ANIM_STATES.PHASE_UP]: { duration: 0.6, loop: false },
  [ANIM_STATES.DEATH]: { duration: 1.2, loop: false },
};

/* ------------------------------------------------------------------ */
/* Easing                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Decaying oscillation — the shape of anything springy settling down.
 * @param {number} p - Progress in [0, 1]
 * @param {number} freq - Oscillations across the whole span
 * @param {number} decay - Higher settles faster
 * @returns {number} Starts near 1, rings out to 0
 */
function damped(p, freq, decay) {
  return Math.cos(p * Math.PI * 2 * freq) * Math.exp(-p * decay);
}

/**
 * Fast attack, slow release — the standard impact curve.
 * @param {number} p
 * @returns {number} 1 at p=0, easing to 0 at p=1
 */
function impact(p) {
  const inv = 1 - clamp01(p);
  return inv * inv;
}

/* ------------------------------------------------------------------ */
/* Hero state transforms                                               */
/* ------------------------------------------------------------------ */

/**
 * Procedural pose for the Drifter in a given state.
 *
 * @param {string} state - One of ANIM_STATES
 * @param {number} stateElapsed - Seconds since this state began
 * @param {number} time - Free-running clock, for continuous idle motion
 * @param {Object} out - Reused transform (from juice.js createTransform)
 * @param {Object} [context]
 * @param {number} [context.dx] - Horizontal travel, for the movement lean
 * @returns {Object} out
 */
export function heroStateTransform(state, stateElapsed, time, out, context = {}) {
  const config = HERO_FX[state];
  const p = config?.duration > 0 ? clamp01(stateElapsed / config.duration) : 0;

  switch (state) {
    case ANIM_STATES.ATTACK: {
      /*
       * NOTHING. The whole of firing is the recoil kick, which is a POSITION
       * offset applied by the renderer (see attackRecoil), not a transform.
       *
       * This branch used to wind the hull down into a 22% squash and spring it
       * back out through an overshoot. On a fighter that reads as the fuselage
       * compressing every time the gun fires, and at the Phase Repeater's L5
       * rate of two shots a second it never stopped.
       */
      break;
    }

    case ANIM_STATES.HIT: {
      /*
       * A flash and a jolt. The rotation is a damped rock — the hull is knocked
       * off its bearing and settles — which is rigid-body motion; the previous
       * version paired it with a 34% asymmetric squash that flattened the ship.
       */
      out.flash = p < 0.34;
      out.rotation = damped(p, 2.0, 6) * 0.13;
      break;
    }

    case ANIM_STATES.DEATH: {
      /*
       * The one place scale still moves, and it earns it: a ship being
       * destroyed genuinely stops being ship-shaped. Uniform on both axes so it
       * collapses rather than deforming, and it settles at a fifth of size
       * because shrinking to zero looks like a deletion rather than a death.
       */
      const collapse = 1 - 0.8 * p * p;
      out.scaleX *= collapse;
      out.scaleY *= collapse;
      out.alpha = 1 - clamp01(p * 1.15);
      out.rotation = p * 1.4;
      break;
    }

    case ANIM_STATES.MOVE:
    case ANIM_STATES.IDLE:
    default: {
      /*
       * Also nothing, and deliberately.
       *
       * MOVE used to bounce, stretch along travel and lean; IDLE breathed on a
       * sine. Both were written for a soft creature. A ship under thrust
       * communicates speed through its ENGINES and its heading — the flames
       * lengthen with throttle (THRUSTER in sprite-factory.js) and the hull
       * turns toward its travel — and neither of those needs the sprite to
       * change shape.
       */
      break;
    }
  }

  return out;
}

/**
 * Procedural pose for the Dreadnought.
 *
 * @param {string} state
 * @param {number} stateElapsed - Seconds since this state began
 * @param {number} time
 * @param {Object} out
 * @param {Object} [context]
 * @param {number} [context.duration] - Overrides the table; the telegraph
 *   passes the Black Tide fairness window here
 * @returns {Object} out
 */
export function bossStateTransform(state, stateElapsed, time, out, context = {}) {
  const duration = context.duration ?? BOSS_FX[state]?.duration ?? 0;
  const p = duration > 0 ? clamp01(stateElapsed / duration) : 0;

  switch (state) {
    case ANIM_STATES.TELEGRAPH: {
      /*
       * The wind-up, as a STROBE rather than a swell.
       *
       * Frequency ramps with p, so the warning beats faster as the window
       * closes and peaks exactly as the AoE lands — p is driven by
       * telegraph_ms, the same fairness number the sprite path derives its fps
       * from. What changed is the channel: this used to inflate the whole
       * station by up to 22%, which on a 200px chassis was the single worst
       * offender in the "everything is rubber" read.
       */
      const urgency = 0.5 + p * p * 3.5;
      const beat = Math.sin(stateElapsed * Math.PI * 2 * (2 + urgency * 3));
      out.flash = beat > 0.6 - p * 0.5;
      break;
    }

    case ANIM_STATES.ATTACK: {
      // The slam. A hard flash on the strike, decaying — no deformation.
      out.flash = impact(p) > 0.55;
      break;
    }

    case ANIM_STATES.HIT: {
      out.flash = p < 0.5;
      // Rigid rock on its axis, settling. The station is knocked, not squashed.
      out.rotation = damped(p, 1.2, 5) * 0.02;
      break;
    }

    case ANIM_STATES.PHASE_UP: {
      // A tier change is announced by a sustained strobe, longer and steadier
      // than a hit flash so the two are unmistakably different events.
      const heave = Math.sin(p * Math.PI);
      out.flash = heave > 0.4;
      break;
    }

    case ANIM_STATES.DEATH: {
      // Same exemption as the hero: destruction is the one time a hull is
      // allowed to stop being hull-shaped. Uniform collapse, plus a list.
      const collapse = 1 - 0.65 * p;
      out.scaleX *= collapse;
      out.scaleY *= collapse;
      out.alpha = 1 - clamp01(p * 1.1);
      out.rotation = p * 0.5;
      break;
    }

    case ANIM_STATES.IDLE:
    default: {
      // Nothing. The station's idle motion is its axial spin and its reactor
      // glow, both owned by dreadnoughtPulse — it does not breathe.
      break;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Continuous FX — the layers that run while a state is held            */
/* ------------------------------------------------------------------ */

/**
 * Exhaust grit shed from the engine nozzles.
 *
 * REPLACES A GHOST CHAIN. The Drifter used to leave a trail of semi-transparent
 * copies of its own sprite (the old AFTERIMAGE pool). Seven translucent ships
 * stacked up behind the real one is the single most confusing thing that can
 * be put on screen in a game whose headline risk is the player losing track of
 * their own hull — and it is a liquid, smeary effect on top of that.
 *
 * What comes out of the nozzles now is small, hard and high-frequency: a few
 * plasma sparks per emission, thrown backward, which reads as thrust without
 * ever competing with the ship for identity.
 */
export const MOVE_WAKE = {
  /** Seconds between emissions at full throttle. Short — this is grit. */
  interval: 0.028,
  /** Sparks per emission, per nozzle. */
  count: 2,
};

/**
 * Recoil kick, in pixels, at a point in the attack.
 *
 * A LINEAR RETURN, NOT A SPRING. The hull snaps to full displacement on the
 * frame the shot goes out and slides back to rest over RECOIL.duration (~0.06s,
 * under four frames). The previous version was a half-sine spread across the
 * whole 0.17s attack state, which ramped UP over the first 85ms — so the ship
 * drifted backward after the shot instead of being kicked by it, and at a high
 * fire rate never returned to centre.
 *
 * @param {number} stateElapsed - Seconds since the attack began
 * @returns {number} Distance to displace OPPOSITE the firing angle
 */
export function attackRecoil(stateElapsed) {
  const p = clamp01(stateElapsed / RECOIL.duration);
  return RECOIL.distance * (1 - p);
}

/**
 * Whether a moving Drifter should shed exhaust sparks this frame.
 *
 * @param {number} accumulator - Seconds banked since the last emission
 * @param {number} speedFactor - 0..1, how fast it is travelling
 * @returns {boolean}
 */
export function wakeDue(accumulator, speedFactor) {
  if (speedFactor <= 0.05) return false;
  // Emit more often the faster it moves, so a drifting Drifter barely trickles.
  return accumulator >= MOVE_WAKE.interval / (0.4 + speedFactor * 0.6);
}

/**
 * How much to amplify the Drifter's motion trail in a given state.
 *
 * The trail is the readability device the GDD leans on to find the player in a
 * crowd, so states that matter push it harder — this is the "trace" half of the
 * FX, and it costs nothing because the trail is already drawn every frame.
 *
 * @param {string} state
 * @param {number} stateElapsed
 * @returns {number} Multiplier on trail alpha and width
 */
export function trailIntensity(state, stateElapsed) {
  switch (state) {
    case ANIM_STATES.MOVE:
      return 1.35;
    case ANIM_STATES.ATTACK: {
      const p = clamp01(stateElapsed / HERO_FX[ANIM_STATES.ATTACK].duration);
      return 1 + impact(p) * 1.1;
    }
    case ANIM_STATES.HIT: {
      const p = clamp01(stateElapsed / HERO_FX[ANIM_STATES.HIT].duration);
      return 1 + impact(p) * 1.8;
    }
    case ANIM_STATES.DEATH:
      return 0.5;
    default:
      return 1;
  }
}

/**
 * One-shot particle spec for entering a state, or null when a state needs no
 * burst. The renderer turns these into ParticleSystem calls; keeping them as
 * data means this module stays free of rendering APIs and stays testable.
 *
 * @param {string} state
 * @returns {{kind: string, count: number, palette: string}|null}
 */
export function stateBurst(state) {
  switch (state) {
    case ANIM_STATES.ATTACK:
      return { kind: 'burst', count: 11, palette: 'offence' };
    case ANIM_STATES.HIT:
      return { kind: 'impact', count: 14, palette: 'warning' };
    case ANIM_STATES.DEATH:
      return { kind: 'dissolve', count: 22, palette: 'hero' };
    case ANIM_STATES.PHASE_UP:
      return { kind: 'ring', count: 1, palette: 'warning' };
    default:
      return null;
  }
}
