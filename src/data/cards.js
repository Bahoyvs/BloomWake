/**
 * Skill Cards data definitions.
 *
 * ---------------------------------------------------------------------------
 * IDs ARE NOT THEMED, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * The Void Drifter re-skin renames what the player reads. It does not rename
 * `id`. Those strings are dispatch keys in src/core/cards.js, the starter-weapon
 * constant in src/core/simulation.js, entries in the draft's gating rules, and —
 * critically — keys inside every player's saved run. Renaming them would be a
 * silent save-data migration in exchange for tidier-looking literals in a file
 * nobody but the simulation reads.
 *
 * So `dewdrop_barrage` is still how the code refers to the Phase Repeater. The
 * mapping is written out below on each card, so the connection is one grep away.
 *
 * NAMES vs DESCRIPTIONS
 * `name`, `type` and `description` are all player-facing and all English: they
 * render in the in-run draft, and every screen in the game — HUD and meta
 * alike — is English throughout. Rarity and behaviour values are English too,
 * but for a different reason — they are keys (CSS class suffixes, dispatch
 * labels), not prose. Nothing downstream translates any of this.
 */

export const CARD_RARITIES = {
  COMMON: 'Common',
  UNCOMMON: 'Uncommon',
  RARE: 'Rare',
  LEGENDARY: 'Legendary',
};

/** Player-facing category labels. Display only — nothing dispatches on these. */
export const CARD_TYPES = {
  PROJECTILE: 'Kinetic',
  BEAM: 'Beam',
  CHAIN_LIGHTNING: 'Arc',
  ORBIT: 'Orbital',
  AOE: 'Area',
  SHIELD: 'Shield',
  PASSIVE: 'Passive',
  CONTROL: 'Control',
};

/**
 * Effect kind each card runs. `type` above is the player-facing label; this is
 * the handler key the card system dispatches on, so adding a card means adding
 * a data row, not a branch in the simulation.
 * @see src/core/cards.js
 */
export const CARD_BEHAVIORS = {
  /** Volley of homing projectiles at the nearest enemy. */
  HOMING_VOLLEY: 'HOMING_VOLLEY',
  /** Persistent damage strip along the Drifter's own facing. */
  BEAM: 'BEAM',
  /** Satellites circling the Drifter, damaging on contact. */
  ORBIT: 'ORBIT',
  /** Salvo of projectiles in random directions. */
  RADIAL_BURST: 'RADIAL_BURST',
  /**
   * Guided micro-missiles that pick the highest-HP target on the field.
   *
   * Replaces the old AOE_PULSE ring. The build already had two ring blasts
   * (Corona Pulse and the Graviton EMP) doing the same job from the same
   * centre; a homing salvo that deliberately seeks the FATTEST enemy gives the
   * player something the rest of the kit cannot do — a way to answer a
   * Bio-Goliath without walking into it.
   */
  HOMING_MISSILE: 'HOMING_MISSILE',
  /** Hex barrier that negates one hit outright, then recharges on a timer. */
  SHIELD: 'SHIELD',
  /** Escort drone flying the Drifter's wing, with a turret of its own. */
  WINGMAN: 'WINGMAN',
  /** Ring blast that pushes enemies outward AND stuns them. */
  AOE_KNOCKBACK: 'AOE_KNOCKBACK',
};

export const CARDS = [
  {
    // Dewdrop Barrage -> Phase Repeater
    id: 'dewdrop_barrage',
    name: 'Phase Repeater',
    type: CARD_TYPES.PROJECTILE,
    behavior: CARD_BEHAVIORS.HOMING_VOLLEY,
    rarity: CARD_RARITIES.COMMON,
    description: 'Fires rapid blue laser needles at the nearest target; levels add bolts and piercing.',
    maxLevel: 5,
    /**
     * `pierce` is how many EXTRA enemies a needle passes through after its
     * first hit. It is the level-up the player feels most in a dense wave, and
     * it is the stat a Bio-Goliath exists to take away (see `breaksPierce` in
     * src/data/enemies.js) - which is what stops pierce from simply scaling
     * with swarm size forever.
     *
     * The cooldown curve was slackened when pierce landed. Multiplying hits per
     * shot and shortening the gap between shots at the same time put this card
     * through the 40%-of-all-others gate in tests/balance-sim.js; the fire rate
     * is what gave way, because pierce is the more interesting of the two.
     */
    levels: [
      { level: 1, damage: 12, cooldown: 1.0, count: 1, speed: 8, pierce: 0 },
      { level: 2, damage: 16, cooldown: 0.9, count: 1, speed: 9, pierce: 0 },
      { level: 3, damage: 22, cooldown: 0.9, count: 2, speed: 10, pierce: 1 },
      { level: 4, damage: 28, cooldown: 0.8, count: 2, speed: 11, pierce: 1 },
      { level: 5, damage: 36, cooldown: 0.7, count: 3, speed: 12, pierce: 2 },
    ],
  },
  {
    // Sunbeam Lance -> Singularity Lance -> Tesla Arc (Chain Lightning)
    id: 'sunbeam_lance',
    name: 'Tesla Arc',
    type: CARD_TYPES.CHAIN_LIGHTNING,
    behavior: CARD_BEHAVIORS.BEAM,
    rarity: CARD_RARITIES.COMMON,
    description: 'Throws an automatic arc at the nearest hostile; it chains between targets.',
    maxLevel: 5,
    levels: [
      { level: 1, damage: 22, cooldown: 2.2, range: 280, bounces: 1, bounceRadius: 160, shockSlow: 0, shockDuration: 0 },
      { level: 2, damage: 32, cooldown: 2.0, range: 300, bounces: 2, bounceRadius: 180, shockSlow: 0, shockDuration: 0 },
      { level: 3, damage: 45, cooldown: 1.8, range: 320, bounces: 3, bounceRadius: 200, shockSlow: 0.10, shockDuration: 1.2 },
      { level: 4, damage: 62, cooldown: 1.6, range: 340, bounces: 4, bounceRadius: 220, shockSlow: 0.15, shockDuration: 1.5 },
      { level: 5, damage: 85, cooldown: 1.4, range: 380, bounces: 5, bounceRadius: 260, shockSlow: 0.20, shockDuration: 2.0 },
    ],
  },
  {
    // Glasswing -> Aegis Satellites
    id: 'glasswing',
    name: 'Aegis Satellites',
    type: CARD_TYPES.ORBIT,
    behavior: CARD_BEHAVIORS.ORBIT,
    rarity: CARD_RARITIES.COMMON,
    description: 'Two to six defence satellites orbit the hull, shredding any hive unit they touch.',
    maxLevel: 5,
    // Step B: weakest card in the set (1.5% of build output at L5). Damage and
    // orbit radius both raised — a wider orbit sweeps a larger annulus, which is
    // what actually puts enemies in reach.
    levels: [
      { level: 1, damage: 14, count: 2, radius: 70, rotationSpeed: 2.0 },
      { level: 2, damage: 20, count: 3, radius: 78, rotationSpeed: 2.3 },
      { level: 3, damage: 28, count: 4, radius: 86, rotationSpeed: 2.6 },
      { level: 4, damage: 40, count: 5, radius: 95, rotationSpeed: 3.0 },
      { level: 5, damage: 56, count: 6, radius: 110, rotationSpeed: 3.5 },
    ],
  },
  {
    // Petal Storm -> Nova Flak
    id: 'petal_storm',
    name: 'Nova Flak',
    type: CARD_TYPES.PROJECTILE,
    behavior: CARD_BEHAVIORS.RADIAL_BURST,
    rarity: CARD_RARITIES.UNCOMMON,
    description: 'A 360-degree kinetic shrapnel burst; a close-quarters clearing tool.',
    maxLevel: 5,
    levels: [
      { level: 1, damage: 15, count: 6, cooldown: 4.0 },
      { level: 2, damage: 20, count: 8, cooldown: 3.6 },
      { level: 3, damage: 28, count: 10, cooldown: 3.2 },
      { level: 4, damage: 38, count: 12, cooldown: 2.8 },
      { level: 5, damage: 50, count: 16, cooldown: 2.2 },
    ],
  },
  {
    /**
     * Aurora Pulse -> Corona Pulse -> Nanite Swarm.
     *
     * The id is unchanged because it is a save key (see the header). What the
     * slot DOES changed: it used to be a ring blast centred on the Drifter,
     * which is the same shape of effect as the Graviton EMP from the same
     * origin — two cards competing to clear the same circle. Nanite Swarm
     * takes the one job nothing else in the kit does: it launches, arcs, and
     * goes after the single biggest thing on the field.
     *
     * TARGETING IS THE CARD. `targeting: 'highest_hp'` is why this is the
     * answer to a Bio-Goliath escort wall — every other weapon hits whatever
     * happens to be nearest, which in that fight is deliberately the chaff.
     */
    id: 'aurora_pulse',
    name: 'Nanite Swarm',
    type: CARD_TYPES.PROJECTILE,
    behavior: CARD_BEHAVIORS.HOMING_MISSILE,
    rarity: CARD_RARITIES.UNCOMMON,
    description: 'Guided micro-missiles that arc up trailing smoke; they lock the highest-HP target.',
    maxLevel: 5,
    targeting: 'highest_hp',
    levels: [
      { level: 1, damage: 22, count: 2, cooldown: 2.4 },
      { level: 2, damage: 30, count: 3, cooldown: 2.2 },
      { level: 3, damage: 42, count: 4, cooldown: 2.0 },
      { level: 4, damage: 58, count: 5, cooldown: 1.8 },
      { level: 5, damage: 80, count: 6, cooldown: 1.5 },
    ],
  },
  {
    // Bloomshield -> Hyperion Shield
    id: 'bloomshield',
    name: 'Hyperion Shield',
    type: CARD_TYPES.SHIELD,
    behavior: CARD_BEHAVIORS.SHIELD,
    rarity: CARD_RARITIES.RARE,
    description: 'A hard hexagonal barrier around the ship; while charged it cancels one incoming hit outright.',
    maxLevel: 5,
    /**
     * A CHARGE, NOT AN HP POOL.
     *
     * The old shield was a bucket of HP that drained: it absorbed 2.5 -> 26
     * HP/s, which is more than the swarm deals, so owning it at any level was
     * flat immunity to contact damage with a cosmetic timer attached. This
     * version negates ONE hit outright, whatever its size, and then goes down
     * for `rechargeTime`. The player still dies to sustained pressure — they
     * just get one mistake back per cycle, which is the thing a defensive card
     * should actually sell.
     *
     * Levels buy FREQUENCY, never size: a hit is a hit, and 15s at L1 is the
     * figure in the brief. L5 lands at 4.5s, roughly one save per engagement
     * rather than one per wave.
     */
    levels: [
      { level: 1, negates: 1, rechargeTime: 15 },
      { level: 2, negates: 1, rechargeTime: 12.5 },
      { level: 3, negates: 1, rechargeTime: 10 },
      { level: 4, negates: 1, rechargeTime: 7 },
      { level: 5, negates: 1, rechargeTime: 4.5 },
    ],
  },
  {
    // Buddy Boost -> Tactical Wingman
    id: 'buddy_boost',
    name: 'Tactical Wingman',
    type: CARD_TYPES.PASSIVE,
    behavior: CARD_BEHAVIORS.WINGMAN,
    rarity: CARD_RARITIES.COMMON,
    description: 'A turreted support drone flying your wing in V formation; it also adds speed and damage.',
    maxLevel: 5,
    /**
     * Was a pure stat passive. It is now an actual escort: one drone at L1, two
     * from L3, each flying a lagging V slot behind the Drifter and firing its
     * own bolts at whatever comes into range.
     *
     * The stat half PAID for the weapon. Step B had already trimmed it from
     * +45%/+40% to +30%/+25%; the damage multiplier came down again to +22% at
     * L5 when the drones landed, because this is now the only card that both
     * ADDS to the build's damage core and MULTIPLIES it. At +30% with turrets
     * it broke the 40%-of-all-others gate in the CURRENT scenario outright.
     * The movement bonus is untouched — it buys dodging, not output.
     */
    levels: [
      { level: 1, moveSpeedBonus: 0.08, damageBonus: 0.045, drones: 1, droneDamage: 8, droneCooldown: 1.3 },
      { level: 2, moveSpeedBonus: 0.12, damageBonus: 0.08, drones: 1, droneDamage: 12, droneCooldown: 1.1 },
      { level: 3, moveSpeedBonus: 0.16, damageBonus: 0.125, drones: 2, droneDamage: 16, droneCooldown: 1.0 },
      { level: 4, moveSpeedBonus: 0.20, damageBonus: 0.17, drones: 2, droneDamage: 21, droneCooldown: 0.85 },
      { level: 5, moveSpeedBonus: 0.25, damageBonus: 0.22, drones: 2, droneDamage: 26, droneCooldown: 0.7 },
    ],
  },
  {
    // Tidewave -> Graviton EMP
    id: 'tidewave',
    name: 'Graviton EMP',
    type: CARD_TYPES.CONTROL,
    behavior: CARD_BEHAVIORS.AOE_KNOCKBACK,
    rarity: CARD_RARITIES.RARE,
    description: 'An expanding neon ring wave; it knocks hostiles back and freezes them for 1.2 seconds.',
    maxLevel: 5,
    /**
     * Knockback AND a stun (CARD_MODEL.EMP_STUN_SEC) as of the control pass.
     *
     * The stun length is FLAT across levels on purpose — a freeze that gets
     * both longer and more frequent compounds into permanent lockdown — so
     * levels buy reach, damage and frequency only.
     *
     * The cooldown curve was lengthened to pay for it. Contact-free time is now
     * `stun + walk-back`, and at the old 3.2s L5 cooldown that came to 82%
     * uptime, which is contact immunity wearing a crowd-control costume for the
     * second time. The curve below holds the whole set under 70%.
     */
    levels: [
      { level: 1, damage: 20, knockback: 100, radius: 120, cooldown: 5.0 },
      { level: 2, damage: 30, knockback: 120, radius: 140, cooldown: 4.8 },
      { level: 3, damage: 45, knockback: 140, radius: 160, cooldown: 4.6 },
      { level: 4, damage: 65, knockback: 160, radius: 180, cooldown: 4.4 },
      { level: 5, damage: 95, knockback: 180, radius: 210, cooldown: 4.2 },
    ],
  },
];

/**
 * Helper to retrieve card definition by ID
 * @param {string} id - Card ID
 * @returns {Object|null}
 */
export function getCardById(id) {
  return CARDS.find((card) => card.id === id) || null;
}
