/**
 * Animation STATE resolution (Phase 7, Tier A) — core, DOM-free.
 *
 * This module decides *what an entity is semantically doing* and nothing else.
 * It has no concept of a frame index, a sprite sheet coordinate, or an fps.
 * The renderer subscribes to EVENTS.ANIMATION_STATE and owns every one of those
 * decisions; swapping the whole render layer would not touch this file.
 *
 * WHY A PRIORITY LIST RATHER THAN A TRANSITION GRAPH
 * Several signals are true at once constantly — the boss is nearly always both
 * "moving" and "being shot". A transition graph would need an edge for every
 * pair; a priority list needs one ordering and answers the same question. The
 * orderings below are the design decisions, and each is load-bearing:
 *
 *   Dewling:   death > hit > attack > move > idle
 *   Rustwhale: death > telegraph > phaseUp > hit > attack > idle
 *
 * The boss ordering puts TELEGRAPH above HIT on purpose. A boss under sustained
 * fire takes damage on almost every tick, so a hit-wins ordering would mean the
 * telegraph animation essentially never plays — and the telegraph is the
 * fairness signal the whole Black Tide window is calibrated around (see
 * calculateTelegraphMs in src/data/enemies.js). Losing the wind-up to a damage
 * flash would make a deterministic attack read as an unfair one.
 */

import { EVENTS } from './event-bus.js';

/** Semantic animation states. Values match the ANIMATION_MANIFEST clip keys. */
export const ANIM_STATES = {
  IDLE: 'idle',
  MOVE: 'move',
  ATTACK: 'attack',
  HIT: 'hit',
  DEATH: 'death',
  TELEGRAPH: 'telegraph',
  PHASE_UP: 'phaseUp',
};

/** Stable id for the Dewling, which is a singleton and has no numeric entity id. */
export const DEWLING_ENTITY_ID = 'dewling';

/**
 * Highest priority first. Exported so the renderer can decide whether an
 * incoming state is allowed to interrupt a non-looping clip mid-playback,
 * without inventing a second, divergent ordering.
 */
export const DEWLING_PRIORITY = [
  ANIM_STATES.DEATH,
  ANIM_STATES.HIT,
  ANIM_STATES.ATTACK,
  ANIM_STATES.MOVE,
  ANIM_STATES.IDLE,
];

export const RUSTWHALE_PRIORITY = [
  ANIM_STATES.DEATH,
  ANIM_STATES.TELEGRAPH,
  ANIM_STATES.PHASE_UP,
  ANIM_STATES.HIT,
  ANIM_STATES.ATTACK,
  ANIM_STATES.IDLE,
];

/**
 * Rank of a state within a priority list. Lower number wins.
 * @param {string} state
 * @param {Array<string>} priority
 * @returns {number}
 */
export function statePriority(state, priority) {
  const index = priority.indexOf(state);
  return index === -1 ? priority.length : index;
}

/**
 * Resolve the Dewling's animation state from already-existing game signals.
 * Pure: same signals in, same state out, no reads of module or entity state.
 *
 * @param {Object} signals
 * @param {number} signals.hp
 * @param {boolean} [signals.damaged] - Took damage on THIS tick only
 * @param {boolean} [signals.attacking] - Fired a weapon on THIS tick only
 * @param {boolean} [signals.moving] - Non-zero movement input this tick
 * @returns {string} One of ANIM_STATES
 */
export function resolveDewlingState({ hp, damaged = false, attacking = false, moving = false }) {
  if (hp <= 0) return ANIM_STATES.DEATH;
  if (damaged) return ANIM_STATES.HIT;
  if (attacking) return ANIM_STATES.ATTACK;
  if (moving) return ANIM_STATES.MOVE;
  return ANIM_STATES.IDLE;
}

/**
 * Resolve the Rustwhale's animation state.
 *
 * @param {Object} signals
 * @param {number} signals.hp
 * @param {boolean} [signals.telegraphing] - Black Tide wind-up is running
 * @param {boolean} [signals.phaseUp] - Crossed a tier threshold on THIS tick
 * @param {boolean} [signals.damaged] - Took damage on THIS tick only
 * @param {boolean} [signals.attacking] - Telegraph erupted on THIS tick
 * @returns {string} One of ANIM_STATES
 */
export function resolveRustwhaleState({
  hp,
  telegraphing = false,
  phaseUp = false,
  damaged = false,
  attacking = false,
}) {
  if (hp <= 0) return ANIM_STATES.DEATH;
  if (telegraphing) return ANIM_STATES.TELEGRAPH;
  if (phaseUp) return ANIM_STATES.PHASE_UP;
  if (damaged) return ANIM_STATES.HIT;
  if (attacking) return ANIM_STATES.ATTACK;
  return ANIM_STATES.IDLE;
}

/**
 * Health fractions at which the 3-tier Rustwhale changes tier.
 *
 * NOTE FOR REVIEW: Phase 4 expresses the boss's three tiers as a per-wave HP
 * scale (getBossHp: 400 + floor(wave/5) * 250) — there is no in-fight tier
 * transition anywhere in the simulation. A phaseUp animation therefore had no
 * existing trigger to reuse. These thresholds split a single boss fight into
 * three equal HP bands so the state has something real to fire on. They are
 * PURELY VISUAL: nothing in this module changes HP, damage, speed or timing.
 * If the intended meaning was the per-wave tier instead, this constant is the
 * only thing that needs to change.
 */
export const BOSS_TIER_THRESHOLDS = [2 / 3, 1 / 3];

/**
 * Which tier a boss is in, 0-based, given its remaining HP fraction.
 * @param {number} hpFraction - hp / maxHp
 * @returns {number} 0 while above the first threshold, rising as HP falls
 */
export function bossTierForHpFraction(hpFraction) {
  let tier = 0;
  for (const threshold of BOSS_TIER_THRESHOLDS) {
    if (hpFraction <= threshold) tier++;
  }
  return tier;
}

/**
 * Watches the simulation and emits EVENTS.ANIMATION_STATE when — and only
 * when — an entity's semantic state changes.
 *
 * Transient signals (damage, weapon fire, tier crossings) arrive as events and
 * are latched until the next update, then cleared. That latch is what makes
 * "hit lasts exactly one tick" true: the flag is consumed by the update that
 * observes it, so the following tick resolves to whatever is genuinely
 * happening instead of a stale hit.
 */
export class AnimationDirector {
  /**
   * @param {import('./event-bus.js').EventBus} bus
   */
  constructor(bus) {
    this.bus = bus;
    /** entityId -> last emitted state */
    this.states = new Map();
    /** Boss entity id -> last observed tier, for crossing detection. */
    this.bossTiers = new Map();
    /** Reused scratch for boss pruning — allocating here would run every tick. */
    this.seenBosses = [];

    /* Transient, cleared every update. */
    this.playerDamaged = false;
    this.playerAttacked = false;
    /** Entity ids that took damage since the last update. */
    this.damagedIds = new Set();
    /** Entity ids whose telegraph erupted since the last update. */
    this.eruptedIds = new Set();

    this.unsubscribe = [
      bus.on(EVENTS.PLAYER_DAMAGE, () => {
        this.playerDamaged = true;
      }),
      bus.on(EVENTS.WEAPON_FIRE, () => {
        this.playerAttacked = true;
      }),
      bus.on(EVENTS.ENEMY_DAMAGED, (data) => {
        if (data && data.id !== undefined) this.damagedIds.add(data.id);
      }),
      bus.on(EVENTS.BOSS_TELEGRAPH_ERUPT, () => {
        // The erupt payload carries no boss id, so mark every tracked boss.
        // There is exactly one boss alive at a time by design.
        for (const id of this.bossTiers.keys()) this.eruptedIds.add(id);
      }),
      bus.on(EVENTS.STATE_RESET, () => this.reset()),
    ];
  }

  /** Forget every tracked entity. Called on run reset. */
  reset() {
    this.states.clear();
    this.bossTiers.clear();
    this.clearTransients();
  }

  clearTransients() {
    this.playerDamaged = false;
    this.playerAttacked = false;
    this.damagedIds.clear();
    this.eruptedIds.clear();
  }

  /**
   * Emit only on change, so the renderer can treat every event as a real
   * transition rather than filtering a per-tick firehose.
   *
   * @param {string|number} entityId
   * @param {string} state
   */
  setState(entityId, state) {
    const previous = this.states.get(entityId);
    if (previous === state) return;
    this.states.set(entityId, state);
    this.bus.emit(EVENTS.ANIMATION_STATE, { entityId, state, previous: previous ?? null });
  }

  /**
   * @param {string|number} entityId
   * @returns {string|undefined}
   */
  getState(entityId) {
    return this.states.get(entityId);
  }

  /** Stop tracking a dead or despawned entity. */
  forget(entityId) {
    this.states.delete(entityId);
    this.bossTiers.delete(entityId);
  }

  /**
   * Evaluate every Tier A entity for this tick.
   *
   * Tier A is the Dewling plus the Rustwhale — at most two entities, ever —
   * which is exactly why this per-entity work is allowed to be this thorough.
   *
   * @param {Object} sim - The Simulation
   */
  update(sim) {
    this.updateDewling(sim);
    this.updateBosses(sim);
    this.clearTransients();
  }

  updateDewling(sim) {
    const player = sim.state.player;
    this.setState(
      DEWLING_ENTITY_ID,
      resolveDewlingState({
        hp: player.hp,
        damaged: this.playerDamaged,
        attacking: this.playerAttacked,
        moving: sim.playerMoving === true,
      })
    );
  }

  updateBosses(sim) {
    this.seenBosses.length = 0;

    for (const enemy of sim.enemies) {
      if (!enemy.isBoss) continue;
      this.seenBosses.push(enemy.id);

      // Register on first sight so tier crossings have a baseline to compare
      // against and an erupt event knows which boss to attribute itself to.
      const hpFraction = enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 0;
      const tier = bossTierForHpFraction(hpFraction);
      const knownTier = this.bossTiers.get(enemy.id);
      const phaseUp = knownTier !== undefined && tier > knownTier;
      this.bossTiers.set(enemy.id, tier);

      const telegraph = sim.bossTelegraph;
      this.setState(
        enemy.id,
        resolveRustwhaleState({
          hp: enemy.alive ? enemy.hp : 0,
          telegraphing: Boolean(telegraph && telegraph.active),
          phaseUp,
          damaged: this.damagedIds.has(enemy.id),
          attacking: this.eruptedIds.has(enemy.id),
        })
      );
    }

    // A boss that left the field (killed and swept, or wiped by wave end) must
    // stop being tracked, or its stale state would suppress the first event of
    // the next boss to reuse that id.
    if (this.bossTiers.size !== this.seenBosses.length) {
      for (const id of [...this.bossTiers.keys()]) {
        if (!this.seenBosses.includes(id)) this.forget(id);
      }
    }
  }

  /** Detach every listener. */
  destroy() {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }
}
