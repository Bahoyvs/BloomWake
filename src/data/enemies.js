/**
 * Enemy data definitions for BloomWake — The Chitin Swarm.
 *
 * ---------------------------------------------------------------------------
 * SIX CLASSES, SIX BEHAVIOURS
 * ---------------------------------------------------------------------------
 * Every roster entry has a movement rule nothing else has. That is the point:
 * a swarm made of one behaviour is a texture, and the player learns nothing by
 * looking at it. Xeno Larva walk straight in, Mantis Striders arc around the
 * flank, Dart Ravagers wind up and lunge, Brood Spores burst into more larvae,
 * Phantom Stalkers go dark on the approach, and Bio-Goliaths eat the shots
 * meant for whatever is behind them.
 *
 * The `behavior` string is the dispatch key in src/core/simulation.js. Adding a
 * species means a row here plus a branch there — the per-species NUMBERS all
 * live in this file so they can be retuned without reading simulation code.
 *
 * ---------------------------------------------------------------------------
 * WHY MOST IDS LOOK NOTHING LIKE THE NAMES
 * ---------------------------------------------------------------------------
 * The first five ids are the original pre-reskin roster ids and stay that way.
 * They are simulation-dispatch keys owned by src/core/ (spawn tables, behaviour
 * switches, save data), so a re-skin renames what the player SEES — `name`,
 * `description`, and the palette/scale tables in src/render/ — and leaves the
 * wiring untouched. Each entry records its old name so the mapping is one grep
 * away.
 *
 * `bio_goliath` is the exception, and for the same reason: it is a genuinely
 * new species with no historical id to preserve, so it gets a readable one.
 *
 * `color` mirrors the carapace tint the renderer actually paints. The renderer
 * does NOT read it — ENEMY_VIEW in src/render/sprite-factory.js is the single
 * source of truth, because a tint has to be a Pixi int and lives beside the
 * scale it ships with. It is kept in step here so this table still describes
 * the species accurately to anyone reading it on its own.
 */

export const ENEMY_TYPES = {
  TARLING: 'tarling',
  ASHFISH: 'ashfish',
  CRACKED_WISP: 'cracked_wisp',
  RUSTBLOOM: 'rustbloom',
  SMOGMOTH: 'smogmoth',
  BIO_GOLIATH: 'bio_goliath',
  RUSTWHALE: 'rustwhale',
};

/**
 * Movement/attack rule, dispatched on in src/core/simulation.js.
 * One per species, plus the boss.
 */
export const ENEMY_BEHAVIORS = {
  /** Straight line at the Drifter. */
  DIRECT: 'DIRECT',
  /** Sine weave across the approach vector, so it arrives from the flank. */
  SINE_WAVE: 'SINE_WAVE',
  /** Periodically locks on, flashes a warning, then dashes at double speed. */
  LOCK_ON_CHARGE: 'LOCK_ON_CHARGE',
  /** Slow drift; drops acid, and bursts into larvae when killed. */
  BROOD_SPORE: 'BROOD_SPORE',
  /** Fades to near-invisible and speeds up, decloaking in strike range. */
  CLOAK_STALK: 'CLOAK_STALK',
  /** Heavy escort: slow, high HP, strips pierce off anything that hits it. */
  ARMORED_GUARD: 'ARMORED_GUARD',
  /** The Dreadnought Station's three-phase pattern. */
  BOSS_STATION: 'BOSS_STATION',
};

export const ENEMIES = {
  [ENEMY_TYPES.TARLING]: {
    id: ENEMY_TYPES.TARLING,
    // Tarling -> Xeno Larva
    name: 'Xeno Larva',
    description: 'Fasetli elmas çekirdek; ince canlı, yüksek hızlı, sürü hâlinde düz hücum.',
    baseHp: 10,
    baseSpeed: 2.7,
    behavior: ENEMY_BEHAVIORS.DIRECT,
    minWave: 1,
    spawnWeight: 10,
    color: '#1b1464',
    radius: 12,
    contactDamage: 8,
    xpValue: 4,
    scoreValue: 10,
    shape: 'square',
  },
  [ENEMY_TYPES.ASHFISH]: {
    id: ENEMY_TYPES.ASHFISH,
    // Ashfish -> Mantis Strider
    name: 'Mantis Strider',
    description: 'Çift mandibulalı sivri gövde; sinüs dalgası çizerek oyuncuyu yandan kuşatır.',
    baseHp: 15,
    baseSpeed: 3.0,
    behavior: ENEMY_BEHAVIORS.SINE_WAVE,
    minWave: 3,
    spawnWeight: 7,
    color: '#006266',
    radius: 14,
    contactDamage: 10,
    xpValue: 6,
    scoreValue: 15,
    shape: 'circle',
    /** Weave amplitude as a fraction of the approach vector, and its rate. */
    weaveAmount: 0.55,
    weaveRate: 4.2,
  },
  [ENEMY_TYPES.CRACKED_WISP]: {
    id: ENEMY_TYPES.CRACKED_WISP,
    // Cracked Wisp -> Dart Ravager
    name: 'Dart Ravager',
    description: 'Sivri iğne kanat; kilitlenip kırmızı uyarı verir, sonra iki kat hızla düz dalar.',
    baseHp: 6,
    baseSpeed: 4.4,
    behavior: ENEMY_BEHAVIORS.LOCK_ON_CHARGE,
    minWave: 4,
    spawnWeight: 8,
    color: '#833471',
    radius: 9,
    contactDamage: 6,
    xpValue: 3,
    scoreValue: 8,
    shape: 'triangle',
    /**
     * The charge cycle: drift -> lock (a red warning the player can read) ->
     * dash. The wind-up exists so the dash is dodgeable; without it a 2x-speed
     * striker is an unavoidable hit with a colour on it.
     */
    chargeInterval: 3.4,
    chargeWindup: 0.55,
    chargeDuration: 0.8,
    chargeSpeedMultiplier: 2.0,
  },
  [ENEMY_TYPES.RUSTBLOOM]: {
    id: ENEMY_TYPES.RUSTBLOOM,
    // Rustbloom -> Brood Spore
    name: 'Brood Spore',
    description: '4 düğümlü polip gövde; ağır ilerler ve öldüğünde 4 Xeno Larva saçar.',
    baseHp: 30,
    baseSpeed: 1.0,
    behavior: ENEMY_BEHAVIORS.BROOD_SPORE,
    minWave: 6,
    spawnWeight: 4,
    color: '#3b3b98',
    radius: 20,
    contactDamage: 14,
    xpValue: 12,
    scoreValue: 30,
    shape: 'square',
    /** Larvae released on death, and how far out they are thrown. */
    broodCount: 4,
    broodType: ENEMY_TYPES.TARLING,
    broodSpread: 34,
    /** Seconds between acid pools. */
    sporeInterval: 3.5,
  },
  [ENEMY_TYPES.SMOGMOTH]: {
    id: ENEMY_TYPES.SMOGMOTH,
    // Smogmoth -> Phantom Stalker
    name: 'Phantom Stalker',
    description: 'Çift kademeli fasetli kabuk; kamufle olup hızlanır, vuruş mesafesinde belirir.',
    baseHp: 12,
    baseSpeed: 3.3,
    behavior: ENEMY_BEHAVIORS.CLOAK_STALK,
    minWave: 8,
    spawnWeight: 5,
    color: '#2c3a47',
    radius: 13,
    contactDamage: 9,
    xpValue: 8,
    scoreValue: 20,
    shape: 'triangle',
    /**
     * Cloak is a fair trade, not a free one: while dark it moves faster, and
     * it MUST drop the cloak before it can reach the Drifter. decloakRange is
     * comfortably outside contact range so the reveal is a warning, not a
     * simultaneous hit.
     */
    cloakAlpha: 0.2,
    cloakSpeedMultiplier: 1.45,
    decloakRange: 190,
  },
  [ENEMY_TYPES.BIO_GOLIATH]: {
    id: ENEMY_TYPES.BIO_GOLIATH,
    /**
     * New species (no legacy id). The heavy escort: it is slow and it is not
     * trying to reach you first — it is trying to be in the way.
     */
    name: 'Bio-Goliath',
    description: 'Çok düğümlü ağır zırhlı kütle; mermilerin delme özelliğini sıfırlar, arkasındakilere zırh olur.',
    baseHp: 90,
    baseSpeed: 0.9,
    behavior: ENEMY_BEHAVIORS.ARMORED_GUARD,
    minWave: 10,
    spawnWeight: 3,
    color: '#4a148c',
    radius: 26,
    contactDamage: 18,
    xpValue: 22,
    scoreValue: 60,
    shape: 'circle',
    /**
     * Armour rule: a projectile that hits this loses ALL remaining pierce and
     * stops here. Read by resolveCollisions; it is the whole reason the species
     * exists, and it is why it spawns late — a pierce-breaker before the player
     * owns any pierce is just a fat enemy.
     */
    breaksPierce: true,
  },
  [ENEMY_TYPES.RUSTWHALE]: {
    id: ENEMY_TYPES.RUSTWHALE,
    // Rustwhale -> Dreadnought Station
    name: 'Dreadnought Station',
    description: 'Boss: Üç aşamalı kovan istasyonu — radyal mermi çemberi, eskort çağrısı, mega ölüm ışını.',
    baseHp: 400, // Dynamic HP formula applied in wave logic
    baseSpeed: 1.35,
    behavior: ENEMY_BEHAVIORS.BOSS_STATION,
    minWave: 5,
    isBoss: true,
    color: '#1a1c23',
    radius: 45,
    contactDamage: 25,
    xpValue: 120,
    scoreValue: 500,
    shape: 'circle',
    /* ---- Phase 1: radial bullet ring ---- */
    /** Bullets per ring, and how often a ring goes out. */
    radialCount: 18,
    radialInterval: 2.6,
    radialDamage: 12,
    radialSpeed: 210,
    /* ---- Phase 2: escort call ---- */
    escortCount: 4,
    escortType: ENEMY_TYPES.CRACKED_WISP,
    escortInterval: 9.0,
    escortSpread: 90,
    /* ---- Phase 3: sweeping death ray ---- */
    /** Warning cone, then the beam itself. */
    rayTelegraphSec: 1.6,
    raySweepSec: 3.4,
    rayInterval: 13.0,
    rayLength: 1500,
    rayHalfWidth: 46,
    /** Damage per second while the beam is on you. */
    rayDamagePerSec: 34,
    /** How fast the beam can track the Drifter, rad/s. Slow enough to outrun. */
    rayTurnRate: 0.55,
    /* ---- Legacy Bio-Acid Bloom AoE (still phase-1 filler) ---- */
    telegraphRadius: 130,
    telegraphCooldown: 6.0,
    telegraphDamage: 40,
  },
};

/**
 * Phase boundaries for the Dreadnought Station, as fractions of max HP.
 *
 * The station does not swap attacks — it ACCUMULATES them. At full health it
 * only sprays rings; below `escort` it also calls fighters; below `ray` it also
 * sweeps. A boss that trades one attack for another gets easier as it dies,
 * which is the wrong shape for a wave-5 wall.
 */
export const BOSS_PHASES = {
  /** Above this HP fraction: Phase 1 (radial rings). Below this: Phase 2 (escort call unlocked). */
  escort: 0.66,
  /** Below this HP fraction: Phase 3 (death ray unlocked). */
  ray: 0.33,
};

/**
 * Which attacks are live at a given HP fraction.
 * @param {number} hpFraction - hp / maxHp
 * @returns {{phase: number, radial: boolean, escort: boolean, ray: boolean}}
 */
export function getBossPhase(hpFraction) {
  const f = Number.isFinite(hpFraction) ? hpFraction : 1;
  const escort = f <= BOSS_PHASES.escort;
  const ray = f <= BOSS_PHASES.ray;
  return {
    phase: ray ? 3 : escort ? 2 : 1,
    radial: true,
    escort,
    ray,
  };
}

/**
 * Calculates deterministic telegraph duration for the Dreadnought Station's AoE
 * Formula: telegraph_ms = (AoE_radius / dewling_speed) * 1000 + 300ms_safety_margin
 * @param {number} aoeRadius - Radius of AoE telegraph circle in pixels
 * @param {number} dewlingSpeedPxPerSec - Drifter speed in pixels per second
 * @param {number} [safetyMarginMs=300] - Safety margin in milliseconds
 * @returns {number} Duration in milliseconds
 */
export function calculateTelegraphMs(aoeRadius, dewlingSpeedPxPerSec, safetyMarginMs = 300) {
  if (dewlingSpeedPxPerSec <= 0) return 1500;
  return (aoeRadius / dewlingSpeedPxPerSec) * 1000 + safetyMarginMs;
}

/**
 * Returns available enemy types unlocked for a given wave (excluding bosses)
 * @param {number} wave - Current wave number
 * @returns {Array<Object>} List of unlocked enemy definitions
 */
export function getUnlockedEnemiesForWave(wave) {
  return Object.values(ENEMIES).filter(
    (enemy) => !enemy.isBoss && wave >= enemy.minWave
  );
}
