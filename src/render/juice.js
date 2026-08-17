/**
 * Tier B procedural animation (Phase 7) — the swarm's entire animation system.
 *
 * WHY THIS EXISTS INSTEAD OF SPRITE SHEETS
 * Tier A (src/render/spriteAnimator.js) animates the Dewling and the Rustwhale,
 * of which there is exactly one each. Swarm enemies run to 150-200 simultaneous
 * instances under the Phase 2 bounded-swarm cap, so anything paid per-instance
 * is paid two hundred times per frame. These transforms are a handful of
 * multiplies and one sin() each — cheap enough to multiply by 200 — and they
 * need no art at all, which is why the swarm reads as alive today, with nothing
 * but static PNGs on disk.
 *
 * THE TWO RULES
 *
 * 1. NO ALLOCATION. Every function writes into a caller-owned transform and
 *    returns it. The renderer keeps one scratch transform for the whole frame
 *    and reuses it for all 200 enemies. Returning a fresh {scale, rotation}
 *    object per call would be 200 objects per frame, 12000 per second — the
 *    exact GC churn the Phase 2 pooling work removed.
 *
 * 2. NO MODULE STATE. Nothing is cached between calls. Every function is a pure
 *    projection of (entity fields, time) onto a transform, so two entities can
 *    never influence each other and the same inputs always give the same
 *    output. The caller's scratch object is the only mutable thing in play, and
 *    applyJuice() resets it before writing — otherwise the previous entity's
 *    alpha would leak into the next one's draw.
 *
 * TIME UNIT: seconds, on the simulation clock (`Simulation.elapsed`), which is
 * the same clock that stamps spawnTime / lastHitTime / deathTime. Do not pass
 * the renderer's own wall clock — it keeps running through menus and pauses,
 * so every duration below would be measured against the wrong origin.
 *
 * OUT OF SCOPE, deliberately (Step B4): no WebGL, no soft-body or spring mesh,
 * no metaball merging, no per-entity shader pass. Every effect here is a
 * transform on an ordinary batched sprite.
 */

/** Flutter cycle speed in radians/sec. */
export const FLUTTER_SPEED = 6.5;
/** Flutter amplitude — 8% vertical squash, per the Tier B spec. */
export const FLUTTER_AMPLITUDE = 0.08;

/** Spawn grow-in duration (ms in the spec, seconds here). */
export const SPAWN_GROW_SEC = 0.18;
/** Death dissolve duration. */
export const DEATH_DISSOLVE_SEC = 0.25;
/** How far a dissolving enemy shrinks by the end. */
export const DEATH_SCALE_DROP = 0.25;
/** Hit flash window — two frames at 60Hz. */
export const HIT_FLASH_SEC = 0.033;

/** Idle breathe rate and amplitude, for stationary types only. */
export const BREATHE_SPEED = 2.2;
export const BREATHE_AMPLITUDE = 0.014;

/** Overshoot constant for the spawn ease — a small pop, not a bounce. */
const EASE_OVERSHOOT = 1.2;

/**
 * The transform every juice function writes into.
 *
 * Allocate ONE of these per renderer, not per entity. `flash` is a boolean flag
 * the renderer turns into a tint or composite operation; keeping it a flag here
 * means this module never touches a rendering API.
 *
 * @returns {{scaleX: number, scaleY: number, rotation: number, alpha: number, flash: boolean}}
 */
export function createTransform() {
  return { scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, flash: false };
}

/**
 * Return a transform to its neutral pose.
 * @param {Object} out
 * @returns {Object} The same object
 */
export function resetTransform(out) {
  out.scaleX = 1;
  out.scaleY = 1;
  out.rotation = 0;
  out.alpha = 1;
  out.flash = false;
  return out;
}

/**
 * Clamp to [0, 1]. Local copy rather than an import from core/math.js: this
 * module is called 200x per frame and stays dependency-free on purpose.
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Ease-out with a slight overshoot, so a spawning enemy pops into place rather
 * than sliding in linearly.
 * @param {number} p - Progress in [0, 1]
 * @returns {number}
 */
function easeOutBack(p) {
  const inv = p - 1;
  return 1 + (EASE_OVERSHOOT + 1) * inv * inv * inv + EASE_OVERSHOOT * inv * inv;
}

/* ------------------------------------------------------------------ */
/* The six juice functions                                             */
/* ------------------------------------------------------------------ */

/**
 * Vertical squash-and-stretch, the "swimming" tell.
 *
 * entity.phaseOffset is what stops 150 Ashfish from pulsing in lockstep. It is
 * assigned once at spawn from the pool and is a single number on the entity —
 * there is no per-instance animator object anywhere in Tier B.
 *
 * @param {Object} entity - Needs phaseOffset
 * @param {number} t - Simulation time, seconds
 * @param {Object} [out]
 * @returns {Object} out, with scaleY set
 */
export function flutter(entity, t, out = createTransform()) {
  out.scaleY = 1 + Math.sin(t * FLUTTER_SPEED + entity.phaseOffset) * FLUTTER_AMPLITUDE;
  return out;
}

/**
 * Point the sprite along its own velocity.
 *
 * Uses real velocity rather than the vector to the Dewling, so a sine-wave
 * Ashfish banks into its curve and a zigzagging Smogmoth actually leans through
 * the turn. A stationary entity keeps rotation 0 instead of snapping to an
 * arbitrary angle.
 *
 * @param {Object} entity - Needs vx, vy
 * @param {Object} [out]
 * @returns {Object} out, with rotation set
 */
export function facingRotation(entity, out = createTransform()) {
  const vx = entity.vx ?? 0;
  const vy = entity.vy ?? 0;
  out.rotation = vx === 0 && vy === 0 ? 0 : Math.atan2(vy, vx);
  return out;
}

/**
 * Scale-in over the first SPAWN_GROW_SEC of life.
 * @param {Object} entity - Needs spawnTime
 * @param {number} t
 * @param {Object} [out]
 * @returns {Object} out, with scaleX and scaleY multiplied
 */
export function spawnGrow(entity, t, out = createTransform()) {
  const progress = clamp01((t - entity.spawnTime) / SPAWN_GROW_SEC);
  const scale = progress >= 1 ? 1 : easeOutBack(progress);
  out.scaleX *= scale;
  out.scaleY *= scale;
  return out;
}

/**
 * Damage flash flag, active for one or two frames after the last hit.
 *
 * A flag, not a colour: the renderer applies it as a GPU tint on a sprite that
 * is already batched. A per-entity shader pass for this would be 200 draw-call
 * breaks a frame, and is explicitly out of scope for Tier B.
 *
 * @param {Object} entity - Needs lastHitTime
 * @param {number} t
 * @param {Object} [out]
 * @returns {Object} out, with flash set
 */
export function hitFlash(entity, t, out = createTransform()) {
  const since = t - entity.lastHitTime;
  out.flash = since >= 0 && since <= HIT_FLASH_SEC;
  return out;
}

/**
 * Fade and shrink a dead enemy out over DEATH_DISSOLVE_SEC.
 *
 * Reads deathTime rather than `alive`, because by the time the renderer sees
 * this the simulation entity has already been swept back into the pool. The
 * renderer keeps its own view alive for the length of the dissolve.
 *
 * @param {Object} entity - Needs deathTime
 * @param {number} t
 * @param {Object} [out]
 * @returns {Object} out, with alpha set and scale reduced
 */
export function deathDissolve(entity, t, out = createTransform()) {
  const progress = clamp01((t - entity.deathTime) / DEATH_DISSOLVE_SEC);
  out.alpha = 1 - progress;
  const shrink = 1 - progress * DEATH_SCALE_DROP;
  out.scaleX *= shrink;
  out.scaleY *= shrink;
  return out;
}

/**
 * Slow breathing for stationary types (Rustbloom). Amplitude is 1.4% — enough
 * to stop the sprite reading as a static decal, small enough not to compete
 * with the swarm's motion for attention.
 *
 * Note: no phaseOffset term, matching the Tier B spec. At this amplitude
 * unison is not perceptible, and Rustblooms are rare enough that they seldom
 * share a screen.
 *
 * @param {Object} entity
 * @param {number} t
 * @param {Object} [out]
 * @returns {Object} out, with scale multiplied
 */
export function idleBreathe(entity, t, out = createTransform()) {
  const scale = 1 + Math.sin(t * BREATHE_SPEED) * BREATHE_AMPLITUDE;
  out.scaleX *= scale;
  out.scaleY *= scale;
  return out;
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

/**
 * Which juice a type gets. Data-driven in the same spirit as
 * ENEMY_SPRITE_CONFIG — a new swarm enemy is a row here, not a code change.
 *
 * `stationary` types breathe instead of fluttering and do not rotate to face
 * travel; everything else swims.
 */
export const JUICE_PROFILE = {
  tarling: { flutter: true, face: false },
  ashfish: { flutter: true, face: true },
  cracked_wisp: { flutter: true, face: true },
  rustbloom: { stationary: true },
  smogmoth: { flutter: true, face: true },
};

/** Fallback for any future swarm type not listed above. */
export const DEFAULT_PROFILE = { flutter: true, face: false };

/**
 * @param {string} typeId
 * @returns {Object}
 */
export function getJuiceProfile(typeId) {
  return JUICE_PROFILE[typeId] ?? DEFAULT_PROFILE;
}

/**
 * Full Tier B transform for one entity. This is the function the renderer
 * calls, once per enemy per frame.
 *
 * Order matters: flutter/breathe establish the base scale, spawnGrow and
 * deathDissolve multiply into it, so an enemy killed mid-flutter still shrinks
 * from wherever its flutter had it.
 *
 * The reset on entry is the load-bearing line for the "no state leaks between
 * entities" property — `out` is shared across all 200 calls in a frame.
 *
 * @param {Object} entity - Pooled simulation enemy
 * @param {number} t - Simulation time, seconds
 * @param {Object} out - Reused transform; REQUIRED in the hot path
 * @param {Object} [profile] - Defaults to the entity type's profile
 * @returns {Object} out
 */
export function applyJuice(entity, t, out = createTransform(), profile = null) {
  resetTransform(out);
  const config = profile ?? getJuiceProfile(entity.typeId);

  if (config.stationary) {
    idleBreathe(entity, t, out);
  } else {
    if (config.flutter) flutter(entity, t, out);
    if (config.face) facingRotation(entity, out);
  }

  spawnGrow(entity, t, out);
  hitFlash(entity, t, out);

  // Only pay for the dissolve maths on entities that are actually dying.
  if (entity.deathTime > -Infinity && t >= entity.deathTime) {
    deathDissolve(entity, t, out);
  }

  return out;
}

/**
 * Shared swim-cycle frame index (Step B3).
 *
 * The cheap half of frame animation: one sheet shared by every instance of a
 * type, and the only per-instance state is the phaseOffset number the entity
 * already carries. No per-entity animator, no per-entity texture.
 *
 * @param {number} t - Simulation time, seconds
 * @param {number} phaseOffset
 * @param {number} fps
 * @param {number} frameCount
 * @returns {number} Frame index in [0, frameCount)
 */
export function sharedCycleFrame(t, phaseOffset, fps, frameCount) {
  if (!(frameCount > 1) || !(fps > 0)) return 0;
  const index = Math.floor((t + phaseOffset) * fps) % frameCount;
  return index < 0 ? index + frameCount : index;
}
