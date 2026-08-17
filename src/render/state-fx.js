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
 * SHAPE LANGUAGE
 * Squash-and-stretch here is volume-preserving: when scaleY drops, scaleX rises
 * by roughly the inverse. A blob that only shrinks reads as a bug; a blob that
 * squashes and bulges reads as soft and alive, which is what the Dewling is.
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

/**
 * Apply a volume-preserving squash to a transform.
 *
 * @param {Object} out
 * @param {number} amount - Positive squashes flat and wide, negative stretches
 *   tall and thin
 */
function squash(out, amount) {
  out.scaleY *= 1 - amount;
  // Inverse on the other axis keeps apparent volume constant, which is what
  // makes it read as a deforming body rather than a resizing image.
  out.scaleX *= 1 + amount * 0.85;
}

/* ------------------------------------------------------------------ */
/* Hero state transforms                                               */
/* ------------------------------------------------------------------ */

/**
 * Procedural pose for the Dewling in a given state.
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
    case ANIM_STATES.MOVE: {
      // Three things sell movement on a radially symmetric blob, and it needs
      // all three — a bounce alone just looks like idling in place.
      const speed = clamp01(Math.abs(context.dx ?? 0) / 3);

      //   1. A bounce, faster and deeper the quicker it travels.
      const bounce = Math.sin(time * (11 + speed * 5)) * (0.05 + speed * 0.045);
      squash(out, bounce);

      //   2. A stretch along travel, so it elongates into its own motion.
      out.scaleX *= 1 + speed * 0.14;
      out.scaleY *= 1 - speed * 0.07;

      //   3. A lean in the direction of travel.
      out.rotation = Math.sign(context.dx ?? 0) * speed * 0.2;
      break;
    }

    case ANIM_STATES.ATTACK: {
      // Anticipation then release: wind down into a squash for the first
      // quarter, then spring back out through an overshoot.
      if (p < 0.25) {
        squash(out, (p / 0.25) * 0.22);
      } else {
        const release = (p - 0.25) / 0.75;
        squash(out, -0.28 * damped(release, 1.1, 4.2));
      }
      break;
    }

    case ANIM_STATES.HIT: {
      // Hard asymmetric squash that rings out, plus a flash over the first
      // third — long enough to register, short enough not to hide the sprite.
      squash(out, 0.34 * damped(p, 1.4, 5.5));
      out.flash = p < 0.34;
      // A small recoil wobble reads as "knocked", not merely "flashed".
      out.rotation = damped(p, 2.0, 6) * 0.13;
      break;
    }

    case ANIM_STATES.DEATH: {
      // Collapse and fade. Shrinking to zero looks like a deletion, so it
      // settles at a fifth of size and lets alpha finish the job.
      const collapse = 1 - 0.8 * p * p;
      out.scaleX *= collapse;
      out.scaleY *= collapse;
      out.alpha = 1 - clamp01(p * 1.15);
      out.rotation = p * 1.4;
      break;
    }

    case ANIM_STATES.IDLE:
    default: {
      // Slow breathing so a standing Dewling is never a still image.
      squash(out, Math.sin(time * 2.4) * 0.045);
      break;
    }
  }

  return out;
}

/**
 * Procedural pose for the Rustwhale.
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
      // The wind-up: a swell that beats faster and harder as the window closes,
      // so the threat reads as imminent rather than merely present. Frequency
      // and amplitude both ramp with p, and p is driven by telegraph_ms — the
      // same fairness number the sprite path derives its fps from, so this
      // peaks exactly as the AoE lands.
      const urgency = 0.5 + p * p * 3.5;
      const beat = Math.sin(stateElapsed * Math.PI * 2 * (2 + urgency * 3));
      const swell = (0.06 + p * 0.16) * beat;
      out.scaleX *= 1 + swell;
      out.scaleY *= 1 + swell;
      // Flash on the peak of each beat once the window is more than half gone.
      out.flash = p > 0.5 && beat > 0.6;
      break;
    }

    case ANIM_STATES.ATTACK: {
      // The slam: a violent stretch down and out, recovering slowly.
      squash(out, 0.3 * impact(p));
      break;
    }

    case ANIM_STATES.HIT: {
      squash(out, 0.12 * damped(p, 1.2, 5));
      out.flash = p < 0.5;
      break;
    }

    case ANIM_STATES.PHASE_UP: {
      // A heave: swells up, holds, settles. Bigger and slower than a hit so a
      // tier change is unmistakably a different event.
      const heave = Math.sin(p * Math.PI);
      out.scaleX *= 1 + heave * 0.22;
      out.scaleY *= 1 + heave * 0.22;
      out.flash = heave > 0.55;
      break;
    }

    case ANIM_STATES.DEATH: {
      const collapse = 1 - 0.65 * p;
      out.scaleX *= collapse;
      out.scaleY *= collapse * (1 - p * 0.3);
      out.alpha = 1 - clamp01(p * 1.1);
      // A slow list to one side as it goes down.
      out.rotation = p * 0.5;
      break;
    }

    case ANIM_STATES.IDLE:
    default: {
      // Heavy, slow swell — a big thing breathing.
      const breathe = Math.sin(time * 1.3) * 0.035;
      out.scaleX *= 1 + breathe;
      out.scaleY *= 1 - breathe * 0.6;
      break;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Continuous FX — the layers that run while a state is held            */
/* ------------------------------------------------------------------ */

/**
 * Droplets shed behind the Dewling while it moves.
 *
 * A wake does something the trail cannot: it persists in world space after the
 * player has gone, so it reads as displacement rather than as a graphic stuck
 * to the sprite.
 */
export const MOVE_WAKE = {
  /** Seconds between emissions at full speed. */
  interval: 0.05,
  /** Droplets per emission. */
  count: 2,
};

/**
 * Ghost copies of the sprite at recent positions — the "trace".
 *
 * This is the single most effective movement cue available without new art,
 * because it shows the actual silhouette displaced through space rather than
 * an abstract shape standing in for it.
 */
export const AFTERIMAGE = {
  /** Seconds between ghosts. */
  interval: 0.042,
  /** Lifetime of one ghost. */
  life: 0.24,
  /** Pool size — also the maximum on screen at once. */
  poolSize: 7,
  /** Alpha of a freshly placed ghost. */
  alpha: 0.42,
};

/**
 * Recoil kick, in pixels, at a point in the attack.
 *
 * The Dewling shoves backward off its own shot and springs back. Recoil is what
 * gives a projectile weight — without it the shot looks like it merely appeared
 * next to the character rather than being fired by it.
 *
 * @param {number} stateElapsed - Seconds since the attack began
 * @returns {number} Distance to displace OPPOSITE the firing angle
 */
export function attackRecoil(stateElapsed) {
  const duration = HERO_FX[ANIM_STATES.ATTACK].duration;
  const p = clamp01(stateElapsed / duration);
  // Snap out fast, ease back — a spring that never overshoots forward.
  return 7 * Math.sin(p * Math.PI) * (1 - p * 0.45);
}

/**
 * Whether a moving Dewling should shed wake droplets this frame.
 *
 * @param {number} accumulator - Seconds banked since the last emission
 * @param {number} speedFactor - 0..1, how fast it is travelling
 * @returns {boolean}
 */
export function wakeDue(accumulator, speedFactor) {
  if (speedFactor <= 0.05) return false;
  // Emit more often the faster it moves, so a drifting Dewling barely trickles.
  return accumulator >= MOVE_WAKE.interval / (0.4 + speedFactor * 0.6);
}

/**
 * How much to amplify the Dewling's motion trail in a given state.
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
