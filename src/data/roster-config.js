/**
 * Roster config — the designer-facing enemy and boss catalogue.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 * Everything a designer needs to add a species or a boss lives here, as data.
 * No branching, no entity state, no Pixi. A new enemy is a row in
 * ENEMY_ARCHETYPES; a new boss is a row in COMPOSITE_BOSSES with a parts list.
 * Neither requires opening src/core/.
 *
 * The one thing data CANNOT invent is a new *kind* of movement. `behavior` is a
 * key into the state machines in src/core/enemy-system.js, and `weapon.type` a
 * key into the weapon dispatch in src/core/composite-boss.js. Picking an
 * existing behaviour and retuning its numbers is a data edit; inventing a
 * fifth way to move is a code edit plus a row here. That line is drawn on
 * purpose — a config format expressive enough to describe arbitrary movement is
 * a programming language with worse tooling.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SITS BESIDE enemies.js RATHER THAN REPLACING IT
 * ---------------------------------------------------------------------------
 * src/data/enemies.js is the shipped Chitin Swarm roster: its ids are save-data
 * and spawn-table keys, and its behaviours are hand-written branches in
 * Simulation.updateEnemies. This file is the parametric replacement those
 * branches are being migrated onto. Both are live — a roster-config archetype
 * spawns through Simulation.spawnArchetype and runs on the enemy-system state
 * machines, a legacy ENEMIES entry spawns through spawnEnemy and runs on the
 * old switch. Species move across one at a time, and nothing in a save breaks
 * on the day one does.
 *
 * All distances are pixels, all durations seconds, all speeds px/s. There is no
 * unit conversion on the way in: what is written here is what the simulation
 * uses, because a table that needs a multiplier applied before it means
 * anything is a table nobody can tune by reading.
 */

/**
 * Movement state machines, implemented in src/core/enemy-system.js.
 *
 * One entry per handler in BEHAVIOR_HANDLERS. Adding a value here without
 * adding the handler makes validateRosterConfig() fail, which is the point:
 * the failure lands in a unit test rather than as a motionless enemy.
 */
export const BEHAVIORS = {
  /** Straight at the Drifter, every frame. Chaff. */
  SWARM: 'swarm',
  /** Holds a standoff band and strafes inside it, firing across the gap. */
  KITING: 'kiting',
  /** Telegraphs a lock, then commits to a straight dash at dash speed. */
  RAMMER: 'rammer',
  /** Approaches on a sine weave, so it arrives from the flank. */
  SINE: 'sine',
};

/**
 * Hostile ordnance kinds. `type` is what the renderer paints; the numbers that
 * decide whether a shot is dodgeable (speed, damage) live on the firing
 * archetype or turret instead, because the same round fired by a scout and by a
 * capital turret should not have to be two bullet types to hit differently.
 */
export const BULLET_TYPES = {
  bio_plasma: {
    id: 'bio_plasma',
    name: 'Bio-Plasma',
    spriteKey: 'laserRed03',
    /** Hive magenta. Matches THEME.bio.magenta so hostile fire reads as hive. */
    tint: 0xff2fb3,
    radius: 7,
    lifeSec: 6.0,
  },
  siege_shell: {
    id: 'siege_shell',
    name: 'Siege Shell',
    spriteKey: 'bullet_siege_shell',
    /** Heavier, slower, and orange so a capital round never reads as chaff fire. */
    tint: 0xff8a3d,
    radius: 11,
    lifeSec: 7.0,
  },
};

/**
 * Weapon patterns, dispatched in src/core/composite-boss.js and
 * src/core/enemy-system.js. Same contract as BEHAVIORS: a value here needs a
 * handler there.
 */
export const WEAPON_TYPES = {
  /** One round, led at the target's current position. */
  SINGLE_AIMED: 'single_aimed',
  /** `count` rounds inside `spreadRad`, centred on the target. */
  SPREAD_VOLLEY: 'spread_volley',
  /** `count` rounds evenly around the full circle, at a random roll offset. */
  RADIAL_BURST: 'radial_burst',
  /**
   * Fires no rounds at all: it drops a lingering damage patch at the muzzle
   * position and leaves it in WORLD space.
   *
   * It is a weapon rather than a movement side-effect because it has a clock,
   * a damage number and an owner id like everything else that hurts the
   * player, and because a boss with two trail weapons at different cadences
   * should be a data edit. `interval` (not `fireInterval`) is the drop period,
   * `duration` how long a patch lives, and `damage` is damage PER SECOND of
   * standing in it — the same contract the spore pools already use, so the one
   * hazard resolver in the simulation serves both.
   */
  TRAIL_HAZARD: 'trail_hazard',
};

/**
 * How a chassis wakes up once its armour is gone.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * `chassis.armoredBy` makes the modules load-bearing: the hull takes nothing
 * while a named part stands. The cost of that rule is the endgame it creates.
 * Every gun on a composite boss belongs to a PART, so the moment the player
 * finishes stripping the armour they are left shooting 1,900-3,200 hp of inert
 * scenery that cannot answer. The hardest-fought minute of the fight is
 * followed by its dullest.
 *
 * `chassis.enrage` is the answer: the hull keeps the HP it has left and starts
 * fighting with weapons of its OWN. The turrets were the boss's reach; the
 * chassis is the boss's body, and a body with nothing left to hide behind
 * charges.
 *
 * Nothing here resets HP. Enrage is a state the boss enters on top of the
 * damage it has already taken — a threshold that healed the boss would make
 * stripping the armour a mistake.
 */
export const ENRAGE_TRIGGERS = {
  /**
   * Armed once the armour is stripped: every part named in `chassis.armoredBy`
   * is wrecked, or (for a chassis with no named armour) every part is.
   *
   * Deliberately the SAME moment the chassis becomes shootable, not one part
   * later. The frame the player earns the right to damage the hull is the frame
   * the hull earns the right to fight back, so the trade is legible: the reward
   * for stripping the armour is a target, and the price is a live boss.
   */
  ALL_PARTS_DESTROYED: 'ALL_PARTS_DESTROYED',
};

/**
 * How a phase arms itself.
 */
export const PHASE_TRIGGERS = {
  /** Active from spawn. Every boss needs exactly one. */
  INITIAL: 'initial',
  /** Armed once total HP (chassis + living parts) falls to `value`. */
  HP_FRACTION: 'hpFraction',
  /** Armed once `count` of the named parts (or of all parts) are wrecked. */
  PARTS_DESTROYED: 'partsDestroyed',
  /** Armed `value` seconds after the boss spawned. */
  TIME_ELAPSED: 'timeElapsed',
};

/* ------------------------------------------------------------------ */
/* Enemy archetypes                                                    */
/* ------------------------------------------------------------------ */

/**
 * The parametric roster.
 *
 * `behaviorParams` is where a species stops being a re-skin. Two archetypes on
 * `kiting` with different standoff bands play differently in a way the player
 * can feel without either of them needing a line of code; two archetypes that
 * differ only in hp and tint do not, and should not both exist.
 */
export const ENEMY_ARCHETYPES = {
  larva_swarm: {
    id: 'larva_swarm',
    name: 'Xeno Larva',
    spriteKey: 'enemy_larva',
    radius: 14,
    /**
     * EARLY-WAVE TUNING (was hp 24, speed 165, contact 12).
     *
     * The larva is the first thing a new player ever meets, and at 165 px/s it
     * was faster than a starting Drifter — which meant the opening wave could
     * not be kited at all, only out-damaged, with a level-1 Phase Repeater that
     * needed two shots per larva. Dropping to 135 puts it just under the
     * player's base speed: backing off now buys real distance, so the first
     * thing the game teaches is the thing the whole run is built on.
     *
     * 16 hp is the number that matters most: it takes a single Phase Repeater
     * round instead of two, so wave 1 reads as "I am clearing these" rather
     * than "these are accumulating".
     */
    hp: 16,
    speed: 135,
    /**
     * Mass scales knockback inversely: a shot that throws a larva clear barely
     * rocks a goliath. It is not used for anything else — there is no physics
     * solver here, and a "mass" that only ever divides an impulse is honest
     * about being a knockback resistance knob.
     *
     * Nudged up with the speed cut so the larva is not also trivially shoved:
     * it should lose the race, not the fight.
     */
    mass: 0.8,
    behavior: BEHAVIORS.SWARM,
    behaviorParams: {},
    attack: null,
    contactDamage: 8,
    scoreValue: 10,
    scrapValue: 2,
    xpValue: 4,
    minWave: 1,
    spawnWeight: 10,
  },

  spore_kiter: {
    id: 'spore_kiter',
    name: 'Spore Scout',
    spriteKey: 'enemy_scout',
    radius: 18,
    /**
     * EARLY-WAVE TUNING (was hp 55, speed 115).
     *
     * A scout that outlived four Phase Repeater rounds kept firing through the
     * whole exchange, so the player was always eating the NEXT volley while
     * still killing the last one. 42 hp ends that loop inside one standoff
     * cycle, and the slightly slower cruise means a player who breaks the band
     * actually escapes it rather than being followed at walking pace.
     */
    hp: 42,
    speed: 105,
    mass: 1.4,
    behavior: BEHAVIORS.KITING,
    behaviorParams: {
      /**
       * The standoff band. Inside `min` it backs off, outside `max` it closes,
       * and between the two it strafes and shoots. A BAND rather than a single
       * distance because a kiter holding one exact radius oscillates across it
       * every frame and reads as jitter.
       */
      standoffMin: 190,
      standoffMax: 270,
      /** Lateral travel inside the band, as a fraction of `speed`. */
      strafeScale: 0.95,
      /**
       * Seconds before it reverses its strafe direction. Without a reversal a
       * pack of scouts all orbit the same way and settle into one rotating
       * ring the player can stand still inside.
       */
      strafeFlipSec: 2.0,
    },
    attack: {
      type: WEAPON_TYPES.SINGLE_AIMED,
      bulletType: 'bio_plasma',
      /**
       * EARLY-WAVE TUNING (was 1.8s / 230 px/s / 18 dmg).
       *
       * Bullet speed is the real fix. At 230 px/s a round crossing a 190-270px
       * standoff band arrived in under a second from a shooter the player was
       * usually not looking at — not dodgeable, just chip damage on a timer.
       * At 180 the same gap takes long enough to see the shot leave and move,
       * which turns the scout from a damage tax into an actual threat to read.
       * The longer interval widens the same window between volleys.
       */
      fireInterval: 2.4,
      speed: 180,
      damage: 14,
      /** Only fires while inside the standoff band; see enemy-system.js. */
      requiresBand: true,
    },
    contactDamage: 12,
    scoreValue: 25,
    scrapValue: 5,
    xpValue: 8,
    minWave: 2,
    spawnWeight: 8,
  },

  spore_barrage: {
    id: 'spore_barrage',
    name: 'Spore Artillery',
    /**
     * Shares the Scout's silhouette on purpose — same body, heavier gun. The
     * player reads "kiter" from the shape and has to notice the three-shot
     * fan to know this one hits harder and further out than its twin.
     */
    spriteKey: 'enemy_scout',
    radius: 20,
    hp: 75,
    speed: 90,
    mass: 2.0,
    behavior: BEHAVIORS.KITING,
    behaviorParams: {
      standoffMin: 220,
      standoffMax: 310,
      /** Slower strafe than the Scout: it is a gun platform, not a skirmisher. */
      strafeScale: 0.7,
      strafeFlipSec: 2.4,
    },
    attack: {
      type: WEAPON_TYPES.SPREAD_VOLLEY,
      bulletType: 'bio_plasma',
      fireInterval: 2.4,
      speed: 210,
      damage: 15,
      count: 3,
      spreadRad: 0.32,
      requiresBand: true,
    },
    contactDamage: 14,
    scoreValue: 40,
    scrapValue: 7,
    xpValue: 12,
    minWave: 4,
    spawnWeight: 6,
  },

  dart_rammer: {
    id: 'dart_rammer',
    name: 'Dart Ravager',
    spriteKey: 'enemy_interceptor',
    radius: 16,
    /**
     * EARLY-WAVE TUNING (was hp 45, contact 24).
     *
     * 24 contact damage was a quarter of a starting hull in one hit, off a
     * species that arrives at wave 3 while the player still has base stats. At
     * 16 a missed read is a serious mistake rather than a run-ender, which is
     * what a telegraphed attack is supposed to be: survivable the first time,
     * then learned.
     */
    hp: 34,
    speed: 85,
    mass: 1.3,
    behavior: BEHAVIORS.RAMMER,
    behaviorParams: {
      /**
       * The whole species is this cycle: creep -> telegraph -> commit.
       *
       * `telegraphSec` is the contract with the player. For 0.75s the ravager
       * sits still with a red lock line drawn along the vector it is about to
       * fly, and that line does not update — the dash flies where the warning
       * pointed, not where the Drifter has since moved. A homing dash with a
       * warning on it is an unavoidable hit wearing a telegraph's clothes.
       * Shortened from the original 1.2s cut: a longer lock range means it
       * commits from further out, so the read window can afford to be tighter
       * without the dash becoming unreactable.
       */
      lockRange: 450,
      /**
       * EARLY-WAVE TUNING (was 0.75s telegraph / 460 dash / 0.65s recover).
       *
       * 0.75s is about a human's simple reaction time once you subtract
       * noticing the line, choosing a direction, and the ship's own
       * acceleration — so the warning was arriving too late to act on, and the
       * ravager read as undodgeable rather than hard. 1.05s leaves roughly a
       * third of a second of real decision time. The slower dash keeps total
       * closing distance near where it was, so the species still crosses the
       * arena instead of becoming a slow drifting threat, and the longer
       * recovery widens the punish window a successful dodge earns.
       */
      telegraphSec: 1.05,
      dashSpeed: 380,
      dashSec: 0.95,
      /** Dead time after a dash, so a miss is punishable. */
      recoverSec: 0.85,
    },
    attack: null,
    contactDamage: 16,
    scoreValue: 35,
    scrapValue: 5,
    xpValue: 10,
    minWave: 3,
    spawnWeight: 8,
  },

  mantis_weaver: {
    id: 'mantis_weaver',
    name: 'Mantis Strider',
    spriteKey: 'enemy_strider',
    radius: 15,
    /**
     * EARLY-WAVE TUNING (was hp 38, speed 145, contact 15).
     *
     * The strider's weave is what makes it interesting, and at 145 px/s the
     * weave was arriving faster than the player could re-aim through it — the
     * arc stopped being a pattern to read and became a reason the shots
     * missed. Slower and thinner, the same path is legible: you can see where
     * it will be and lead it.
     */
    hp: 26,
    speed: 120,
    mass: 1.0,
    behavior: BEHAVIORS.SINE,
    behaviorParams: {
      /**
       * Weave on the PERPENDICULAR of the approach vector, so the strider still
       * closes while it arcs. Amplitude is a fraction of the approach heading:
       * at 0.70 the path leans hard enough to arrive off the shoulder rather
       * than down the same lane every other species uses.
       */
      weaveAmount: 0.7,
      weaveRate: 5.4,
      /**
       * Weave amplitude is scaled down inside this range. A full-amplitude
       * weave at contact distance is a coin flip about whether it connects,
       * which reads as the enemy missing by accident rather than the player
       * dodging on purpose.
       */
      settleRange: 100,
    },
    attack: null,
    contactDamage: 10,
    scoreValue: 20,
    scrapValue: 3,
    xpValue: 7,
    minWave: 2,
    spawnWeight: 7,
  },

  brood_bastion: {
    id: 'brood_bastion',
    name: 'Brood Bastion',
    /**
     * Shares the Larva's silhouette at several times the size — the read is
     * "swarm chaff, but the big one", which is exactly what it is: the same
     * dumb straight-in swarm rule, just heavy enough that walking into one is
     * a real decision instead of a formality.
     */
    spriteKey: 'enemy_larva',
    radius: 24,
    hp: 120,
    speed: 75,
    mass: 3.5,
    behavior: BEHAVIORS.SWARM,
    behaviorParams: {},
    attack: null,
    contactDamage: 22,
    scoreValue: 50,
    scrapValue: 10,
    xpValue: 16,
    minWave: 5,
    spawnWeight: 5,
  },
};

/* ------------------------------------------------------------------ */
/* Composite bosses                                                    */
/* ------------------------------------------------------------------ */

/**
 * Modular bosses: a chassis plus a parts list.
 *
 * THE LEGO RULE. A boss is not one HP bar with scripted attacks on a timer. It
 * is a chassis carrying independently-targetable parts, each with its own hull,
 * its own gun, and its own wreck. The player picks which gun to silence first,
 * and the boss's pattern changes because the thing that fired it is gone — not
 * because a script moved to the next line.
 *
 * `offset` is in CHASSIS-LOCAL pixels and rotates with the hull, so a designer
 * places a turret once and it stays bolted to the same plate for the whole
 * fight. src/core/composite-boss.js does the local -> world transform every
 * tick; src/render/composite-boss-renderer.js reads the same offsets to build
 * the Pixi container tree, so the sprite and the hitbox cannot drift apart.
 *
 * `armoredBy` is the reason parts are worth shooting at all: while any named
 * part lives, the chassis takes no damage. Without it the optimal play against
 * every modular boss is to ignore the modules and hit the big one.
 */
export const COMPOSITE_BOSSES = {
  hive_cruiser: {
    id: 'hive_cruiser',
    name: 'Hive Cruiser',
    /** Which boss wave this template is used for. See pickBossTemplate(). */
    bossTier: 1,
    chassis: {
      spriteKey: 'boss_cruiser_hull',
      radius: 74,
      hp: 1900,
      /** Slow drift toward the Drifter. A station closes; it does not chase. */
      speed: 40,
      /** Hull spin, rad/s. Reads as mass under power rather than as animation. */
      spin: 0.15,
      contactDamage: 30,
      /** Chassis is invulnerable while either flank turret still stands. */
      armoredBy: ['turret_port', 'turret_starboard'],
      /**
       * THE WOUNDED PREDATOR.
       *
       * A cruiser whose guns are gone still has engines and a bow. Stripped of
       * its turrets it stops trying to hold the player at range and starts
       * trying to run them down: quadruple drift speed, a telegraphed ramming
       * run on a 5.5s beat, burning fuel dumped in its wake, and larvae vented
       * out of the breached hull because the thing was a carrier all along.
       *
       * The pieces are chosen so that none of them is answered by the same
       * input. The charge is answered by reading the telegraph and moving
       * across it; the wake is answered by not following it home; the larvae
       * are answered by clearing them before the next charge. A player who
       * only dodges drowns in chaff, and one who only farms chaff gets rammed.
       */
      innateWeapons: [
        {
          id: 'afterburner_wake',
          type: WEAPON_TYPES.TRAIL_HAZARD,
          /** Damage per second of standing in a patch, not on touch. */
          damage: 12,
          /** Seconds a patch lingers in world space after it is dropped. */
          duration: 2.2,
          /** Drop period. At 380 px/s that is a patch every 57px of charge. */
          interval: 0.15,
          radius: 38,
        },
      ],
      enrage: {
        trigger: ENRAGE_TRIGGERS.ALL_PARTS_DESTROYED,
        /**
         * ABSOLUTE, not a multiplier on `speed` above, and not passed through
         * the phase's speedScale or a wrecked part's chassisSpeedScale. The
         * whole point of the reactor's 0.6 speed penalty was to make the hull
         * easier to out-run while the turrets were still shooting; keeping it
         * after the enrage would mean the player's own progress had defused
         * the thing the enrage exists to create. 135 is the statline, read as
         * written.
         */
        speed: 135,
        spin: 0.45,
        /** Ramming hurts: 30 -> 45 for touching an engine running this hot. */
        contactDamage: 45,
        chargeAttack: {
          cooldown: 5.5,
          /**
           * The lock is taken at the START of this window and never re-aimed,
           * exactly as the Dart Ravager's is (see stepRammer). 1.2s of a beam
           * pointing where the boss WILL go is a telegraph; 1.2s of a beam
           * tracking where the player currently is is an unavoidable hit
           * wearing a telegraph's clothes.
           */
          telegraphDuration: 1.2,
          chargeSpeed: 380,
          chargeDuration: 1.4,
          /**
           * The other half of the deal. A dodged charge leaves the cruiser
           * coasting and harmless while it bleeds off 380 px/s, so reading the
           * telegraph pays twice: once by not being hit, once by the free
           * damage window that follows.
           */
          recoveryDuration: 0.9,
        },
        ventMinions: {
          cooldown: 6.0,
          /**
           * ENEMY_ARCHETYPES key, not a sprite key. The larva is the right
           * chaff here precisely because it is the wave-1 enemy: the player
           * already knows exactly what it costs to ignore one.
           */
          archetypeId: 'larva_swarm',
          count: 4,
          spreadAngle: Math.PI * 2,
          /** Vented clear of the hull so a larva never spawns inside it. */
          spawnRadius: 96,
        },
      },
    },
    parts: [
      {
        id: 'turret_port',
        role: 'turret',
        spriteKey: 'boss_turret',
        wreckSpriteKey: 'boss_turret_wreck',
        offset: { x: -86, y: -10 },
        rotation: 0,
        radius: 24,
        hp: 380,
        /** Turrets track the Drifter; the renderer reads the same aim angle. */
        aims: true,
        weapon: {
          id: 'port_gun',
          type: WEAPON_TYPES.SINGLE_AIMED,
          bulletType: 'bio_plasma',
          fireInterval: 1.3,
          speed: 310,
          damage: 18,
          /** Muzzle offset along the turret's own facing, px. */
          muzzle: 22,
        },
        scoreValue: 150,
        scrapValue: 20,
      },
      {
        id: 'turret_starboard',
        role: 'turret',
        spriteKey: 'boss_turret',
        wreckSpriteKey: 'boss_turret_wreck',
        offset: { x: 86, y: -10 },
        rotation: 0,
        radius: 24,
        hp: 380,
        aims: true,
        weapon: {
          id: 'starboard_gun',
          type: WEAPON_TYPES.SPREAD_VOLLEY,
          bulletType: 'bio_plasma',
          fireInterval: 1.9,
          speed: 270,
          damage: 15,
          count: 5,
          spreadRad: 0.42,
          muzzle: 22,
        },
        scoreValue: 150,
        scrapValue: 20,
      },
      {
        id: 'reactor_core',
        role: 'reactor',
        spriteKey: 'boss_reactor',
        wreckSpriteKey: 'boss_reactor_wreck',
        offset: { x: 0, y: 54 },
        rotation: 0,
        radius: 26,
        hp: 550,
        aims: false,
        weapon: {
          id: 'core_burst',
          type: WEAPON_TYPES.RADIAL_BURST,
          bulletType: 'siege_shell',
          fireInterval: 2.8,
          speed: 240,
          damage: 24,
          count: 18,
        },
        /**
         * Wrecking the reactor costs the cruiser its ring AND slows the hull.
         * A destructible part that only removes a gun teaches "shoot the guns";
         * one that also changes how the chassis moves teaches "shoot THIS one
         * first", which is a decision rather than a checklist.
         */
        onDestroyed: { chassisSpeedScale: 0.6, chassisSpinScale: 0.5 },
        scoreValue: 250,
        scrapValue: 35,
      },
    ],
    /**
     * Phases arm in order and the LAST satisfied one wins, so the weapon lists
     * are absolute rather than cumulative — a designer reading phase 3 sees
     * exactly what is firing in phase 3 without replaying phases 1 and 2.
     *
     * A weapon whose part is wrecked stays silent whatever the phase says.
     */
    phases: [
      {
        id: 'approach',
        trigger: { type: PHASE_TRIGGERS.INITIAL },
        weapons: ['port_gun', 'starboard_gun'],
        fireRateScale: 1.15,
        spinScale: 1.1,
        speedScale: 1.1,
      },
      {
        id: 'reactor_hot',
        trigger: { type: PHASE_TRIGGERS.HP_FRACTION, value: 0.7 },
        weapons: ['port_gun', 'starboard_gun', 'core_burst'],
        fireRateScale: 1.45,
        spinScale: 1.8,
        speedScale: 1.25,
      },
      {
        id: 'meltdown',
        trigger: { type: PHASE_TRIGGERS.HP_FRACTION, value: 0.35 },
        weapons: ['port_gun', 'starboard_gun', 'core_burst'],
        /** Everything still standing fires twice as fast as the opener. */
        fireRateScale: 2.0,
        spinScale: 2.8,
        speedScale: 1.5,
      },
    ],
    /** Awarded on the chassis kill, on top of each part's own values. */
    scoreValue: 700,
    scrapValue: 80,
    xpValue: 160,
  },

  spire_station: {
    id: 'spire_station',
    name: 'Chitin Spire',
    bossTier: 2,
    chassis: {
      spriteKey: 'boss_spire_hull',
      radius: 88,
      hp: 3200,
      /** Stationary: the spire is the arena feature, not the pursuer. */
      speed: 0,
      spin: 0.22,
      contactDamage: 35,
      armoredBy: ['pylon_a', 'pylon_b', 'pylon_c'],
      /**
       * THE GRAVITATIONAL COLLAPSE.
       *
       * The Spire cannot chase — it is the arena feature, and giving it engines
       * on the last phase would make it a second Cruiser. So it does the
       * opposite of chasing: it stops letting the player leave.
       *
       * Everything below inverts the fight the pylons were teaching. For three
       * pylon-lengths of the encounter the correct play was to circle at
       * standoff range and pick a pylon; now standoff range is where the pull
       * is strongest against the player's own throttle, the safe bearing is
       * gone (the ring covers every angle), and the shockwave punishes standing
       * anywhere at all. The player has to close, because the pull is weakest
       * where the core is, and the core is also the 45-damage thing they are
       * trying to shoot.
       */
      innateWeapons: [
        {
          id: 'singularity_pulse',
          type: WEAPON_TYPES.RADIAL_BURST,
          bulletType: 'siege_shell',
          fireInterval: 2.2,
          speed: 210,
          damage: 20,
          count: 14,
          /**
           * The ring's gap advances by this many radians every burst instead of
           * being rolled at random the way a part-mounted radial burst is.
           *
           * A random gap is right for a turret the player only sees a few
           * bursts from: it stops them learning one safe bearing. This ring is
           * the last thirty seconds of the fight and the player will see a
           * dozen bursts, so a random gap reads as noise. A gap that walks
           * round the circle at a fixed rate is learnable — the player can see
           * where the next one will be — which is what makes a bullet wall
           * something to solve rather than something to survive.
           */
          spiralOffset: 0.2,
        },
      ],
      enrage: {
        trigger: ENRAGE_TRIGGERS.ALL_PARTS_DESTROYED,
        /** Still bolted to the floor. Only the spin changes. */
        speed: 0,
        spin: 0.9,
        contactDamage: 45,
        gravityWell: {
          radius: 450,
          /**
           * px/s of inward velocity added at the centre, falling linearly to
           * zero at `radius`. Under a base Drifter (~260 px/s) 110 is a
           * current, not a tractor beam: it bends every line the player tries
           * to fly and makes retreating cost about 40% of their throttle, but
           * it never takes control away. A pull that exceeded player speed
           * would be a cutscene.
           */
          pullForce: 110,
          /**
           * Adds a tangential component, so the pull curves the player into an
           * orbit rather than dragging them down a straight line into the
           * core. A straight-line pull is fought by holding one key; a spiral
           * has to actually be flown out of.
           */
          inwardSpiral: true,
        },
        /**
         * Seconds between shockwaves. Called out here rather than inside
         * `shockwave` because the CADENCE is the thing the player learns and
         * the designer retunes; the ring's own physics below it is set once.
         */
        shockwaveInterval: 4.0,
        shockwave: {
          /** Warning ring drawn at full radius before the wave is released. */
          warnDuration: 0.8,
          /** Expansion rate. 340 px/s outruns a walking Drifter, not a dashing one. */
          speed: 340,
          maxRadius: 560,
          /**
           * Band thickness. The wave is a RING, not a growing disc: inside it
           * is safe again once it has passed, which is what makes "dash
           * through it toward the core" the intended answer rather than "run".
           */
          thickness: 46,
          damage: 28,
        },
      },
    },
    parts: [
      /**
       * Three identical pylons on a 120-degree ring. Identical ON PURPOSE: the
       * question this boss asks is not "which part" but "can you get round the
       * back before the front one comes back on line", and three of a kind is
       * the cleanest way to ask it.
       */
      {
        id: 'pylon_a',
        role: 'turret',
        spriteKey: 'boss_pylon',
        wreckSpriteKey: 'boss_pylon_wreck',
        offset: { x: 0, y: -96 },
        rotation: 0,
        radius: 22,
        hp: 520,
        aims: true,
        weapon: {
          id: 'pylon_a_gun',
          type: WEAPON_TYPES.SPREAD_VOLLEY,
          bulletType: 'siege_shell',
          fireInterval: 1.8,
          speed: 260,
          damage: 22,
          count: 3,
          spreadRad: 0.35,
          muzzle: 20,
        },
        scoreValue: 200,
        scrapValue: 25,
      },
      {
        id: 'pylon_b',
        role: 'turret',
        spriteKey: 'boss_pylon',
        wreckSpriteKey: 'boss_pylon_wreck',
        offset: { x: 83, y: 48 },
        rotation: 2.094,
        radius: 22,
        hp: 520,
        aims: true,
        weapon: {
          id: 'pylon_b_gun',
          type: WEAPON_TYPES.SPREAD_VOLLEY,
          bulletType: 'siege_shell',
          fireInterval: 1.8,
          speed: 260,
          damage: 22,
          count: 3,
          spreadRad: 0.35,
          muzzle: 20,
        },
        scoreValue: 200,
        scrapValue: 25,
      },
      {
        id: 'pylon_c',
        role: 'turret',
        spriteKey: 'boss_pylon',
        wreckSpriteKey: 'boss_pylon_wreck',
        offset: { x: -83, y: 48 },
        rotation: 4.189,
        radius: 22,
        hp: 520,
        aims: true,
        weapon: {
          id: 'pylon_c_gun',
          type: WEAPON_TYPES.SPREAD_VOLLEY,
          bulletType: 'siege_shell',
          fireInterval: 1.8,
          speed: 260,
          damage: 22,
          count: 3,
          spreadRad: 0.35,
          muzzle: 20,
        },
        scoreValue: 200,
        scrapValue: 25,
      },
    ],
    phases: [
      {
        id: 'sealed',
        trigger: { type: PHASE_TRIGGERS.INITIAL },
        weapons: ['pylon_a_gun', 'pylon_b_gun', 'pylon_c_gun'],
        fireRateScale: 1.2,
        spinScale: 1.2,
        speedScale: 1,
      },
      {
        id: 'breached',
        /**
         * Armed by DAMAGE TO THE STRUCTURE, not by the clock or the HP bar:
         * lose a pylon and the survivors speed up. Taking a gun away making the
         * rest angrier is what stops "kill the weakest part first" from being
         * a free move.
         */
        trigger: { type: PHASE_TRIGGERS.PARTS_DESTROYED, count: 1 },
        weapons: ['pylon_a_gun', 'pylon_b_gun', 'pylon_c_gun'],
        fireRateScale: 1.7,
        spinScale: 2.2,
        speedScale: 1,
      },
      {
        id: 'venting',
        trigger: { type: PHASE_TRIGGERS.PARTS_DESTROYED, count: 2 },
        weapons: ['pylon_a_gun', 'pylon_b_gun', 'pylon_c_gun'],
        fireRateScale: 2.4,
        spinScale: 3.5,
        speedScale: 1,
      },
    ],
    scoreValue: 1000,
    scrapValue: 120,
    xpValue: 240,
  },
};

/* ------------------------------------------------------------------ */
/* Pure lookups                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {string} id
 * @returns {Object|null} The archetype row, or null if the id is unknown
 */
export function getArchetype(id) {
  return ENEMY_ARCHETYPES[id] ?? null;
}

/**
 * @param {string} id
 * @returns {Object|null}
 */
export function getBossTemplate(id) {
  return COMPOSITE_BOSSES[id] ?? null;
}

/**
 * Archetypes unlocked at a wave, in declaration order.
 * @param {number} wave
 * @returns {Array<Object>}
 */
export function getArchetypesForWave(wave) {
  return Object.values(ENEMY_ARCHETYPES).filter((a) => wave >= (a.minWave ?? 1));
}

/**
 * Weighted pick from the archetypes unlocked at a wave.
 *
 * Returns null rather than a fallback species when nothing is unlocked: the
 * caller knows what it wants to do with an empty roster, and silently
 * substituting larvae would hide a mis-tuned minWave table for good.
 *
 * @param {number} wave
 * @param {() => number} rng - Floats in [0, 1)
 * @returns {Object|null}
 */
export function pickArchetypeForWave(wave, rng) {
  const pool = getArchetypesForWave(wave);
  if (pool.length === 0) return null;

  let total = 0;
  for (const a of pool) total += a.spawnWeight ?? 1;
  if (total <= 0) return pool[0];

  let roll = rng() * total;
  for (const a of pool) {
    roll -= a.spawnWeight ?? 1;
    if (roll <= 0) return a;
  }
  return pool[pool.length - 1];
}

/**
 * The boss template for a given boss wave.
 *
 * Tiers cycle rather than run out: wave 5 gets tier 1, wave 10 tier 2, wave 15
 * tier 1 again at whatever HP scale the caller applies. A roster that ran out
 * of bosses would have to fall back to "no boss on wave 20", and a boss wave
 * with no boss cannot be completed.
 *
 * @param {number} wave
 * @returns {Object|null}
 */
export function pickBossTemplate(wave) {
  const templates = Object.values(COMPOSITE_BOSSES).sort(
    (a, b) => (a.bossTier ?? 0) - (b.bossTier ?? 0)
  );
  if (templates.length === 0) return null;
  const tier = Math.max(1, Math.floor(wave / 5));
  return templates[(tier - 1) % templates.length];
}

/**
 * Total authored HP of a boss: chassis plus every part.
 *
 * The number the HP bar is drawn from and the denominator for every
 * hpFraction phase trigger, so it is computed in ONE place. A boss whose bar
 * counted only the chassis would sit at 100% through the entire opening phase
 * while the player wrecked two turrets.
 *
 * @param {Object} template
 * @returns {number}
 */
export function getTemplateTotalHp(template) {
  if (!template) return 0;
  let total = template.chassis?.hp ?? 0;
  for (const part of template.parts ?? []) total += part.hp ?? 0;
  return total;
}

/**
 * Every weapon on a template, keyed by weapon id, with its owning part.
 * @param {Object} template
 * @returns {Map<string, {weapon: Object, part: Object}>}
 */
export function getTemplateWeapons(template) {
  const out = new Map();
  for (const part of template?.parts ?? []) {
    if (part.weapon?.id) out.set(part.weapon.id, { weapon: part.weapon, part });
  }
  return out;
}

/**
 * A chassis's own weapons — the ones that fire on the enrage rather than off a
 * part, keyed by weapon id the same way getTemplateWeapons keys the parts'.
 *
 * Separate function rather than a flag on getTemplateWeapons because the two
 * answer different questions. getTemplateWeapons answers "what can a phase
 * arm?", and the answer must never include an innate weapon: a phase list
 * describes the boss while its parts live, and the innate guns exist precisely
 * for when they do not.
 *
 * @param {Object} template
 * @returns {Map<string, Object>}
 */
export function getChassisWeapons(template) {
  const out = new Map();
  for (const weapon of template?.chassis?.innateWeapons ?? []) {
    if (weapon?.id) out.set(weapon.id, weapon);
  }
  return out;
}

/**
 * @param {Object} template
 * @returns {Object|null} The chassis enrage block, or null for a boss that
 *   goes quiet when its armour comes off
 */
export function getEnrageConfig(template) {
  return template?.chassis?.enrage ?? null;
}

/**
 * Inward pull, px/s, at a given distance from a gravity well's centre.
 *
 * Lives here rather than in the boss because it is the whole of the well's
 * DESIGN: linear falloff from `pullForce` at the core to exactly zero at the
 * rim, and zero everywhere beyond. Two properties matter and both are easier
 * to see in four lines than in a state machine —
 *
 *   - it is CONTINUOUS at the rim, so a player skimming the edge is not
 *     snatched by a force that appears at full strength the moment they cross
 *     an invisible line;
 *   - it is STRONGEST where the boss is, so running away is cheap and the
 *     expensive place to be is exactly the place the player has to reach to
 *     win. The well does not chase them; it charges them rent on the ground
 *     they need.
 *
 * @param {number} distance - px from the well's centre
 * @param {number} radius - px, the well's reach
 * @param {number} pullForce - px/s at the centre
 * @returns {number} px/s of inward pull; 0 at or beyond `radius`
 */
export function gravityWellForce(distance, radius, pullForce) {
  if (!(radius > 0) || !(pullForce > 0)) return 0;
  if (!(distance < radius)) return 0;
  const d = Math.max(0, distance);
  return pullForce * (1 - d / radius);
}

/**
 * Check the whole catalogue for the mistakes a data edit actually makes.
 *
 * Run from tests/roster-config.test.js, so a designer who mistypes a behaviour
 * name or points a phase at a weapon that no longer exists finds out from a red
 * test naming the row, rather than from an enemy that stands still in a
 * playtest. Returns messages instead of throwing so one run reports every
 * problem in the file.
 *
 * @returns {Array<string>} Human-readable problems; empty means the file is sound
 */
export function validateRosterConfig() {
  const problems = [];
  const behaviors = new Set(Object.values(BEHAVIORS));
  const weaponTypes = new Set(Object.values(WEAPON_TYPES));
  const triggers = new Set(Object.values(PHASE_TRIGGERS));
  const enrageTriggers = new Set(Object.values(ENRAGE_TRIGGERS));

  const checkAttack = (where, attack) => {
    if (!attack) return;
    if (!weaponTypes.has(attack.type)) {
      problems.push(`${where}: unknown weapon type "${attack.type}"`);
    }
    /*
     * A trail hazard is checked against a different contract because it fires
     * no rounds: no bullet type to resolve, `interval` instead of
     * `fireInterval`, and a `duration` the patch lives for. Running it through
     * the projectile checks would demand a bulletType it has no use for, and
     * the only way a designer could satisfy that is by naming one at random.
     */
    if (attack.type === WEAPON_TYPES.TRAIL_HAZARD) {
      if (!(attack.interval > 0)) problems.push(`${where}: trail_hazard needs interval > 0`);
      if (!(attack.duration > 0)) problems.push(`${where}: trail_hazard needs duration > 0`);
      if (!(attack.damage > 0)) problems.push(`${where}: trail_hazard needs damage > 0`);
      if (!(attack.radius > 0)) problems.push(`${where}: trail_hazard needs radius > 0`);
      return;
    }
    if (!BULLET_TYPES[attack.bulletType]) {
      problems.push(`${where}: unknown bulletType "${attack.bulletType}"`);
    }
    if (!(attack.fireInterval > 0)) {
      problems.push(`${where}: fireInterval must be > 0`);
    }
    if (attack.type === WEAPON_TYPES.SPREAD_VOLLEY && !(attack.count > 1)) {
      problems.push(`${where}: spread_volley needs count > 1`);
    }
    if (attack.type === WEAPON_TYPES.RADIAL_BURST && !(attack.count > 1)) {
      problems.push(`${where}: radial_burst needs count > 1`);
    }
  };

  for (const [key, archetype] of Object.entries(ENEMY_ARCHETYPES)) {
    const where = `ENEMY_ARCHETYPES.${key}`;
    if (archetype.id !== key) problems.push(`${where}: id "${archetype.id}" does not match its key`);
    if (!behaviors.has(archetype.behavior)) {
      problems.push(`${where}: unknown behavior "${archetype.behavior}"`);
    }
    if (!(archetype.hp > 0)) problems.push(`${where}: hp must be > 0`);
    if (!(archetype.radius > 0)) problems.push(`${where}: radius must be > 0`);
    if (!(archetype.speed >= 0)) problems.push(`${where}: speed must be >= 0`);
    if (!archetype.spriteKey) problems.push(`${where}: missing spriteKey`);
    checkAttack(where, archetype.attack);

    const params = archetype.behaviorParams ?? {};
    if (archetype.behavior === BEHAVIORS.KITING) {
      if (!(params.standoffMin > 0) || !(params.standoffMax > params.standoffMin)) {
        problems.push(`${where}: kiting needs 0 < standoffMin < standoffMax`);
      }
    }
    if (archetype.behavior === BEHAVIORS.RAMMER) {
      if (!(params.telegraphSec > 0)) problems.push(`${where}: rammer needs telegraphSec > 0`);
      if (!(params.dashSpeed > archetype.speed)) {
        problems.push(`${where}: rammer dashSpeed must exceed its cruise speed`);
      }
    }
  }

  for (const [key, template] of Object.entries(COMPOSITE_BOSSES)) {
    const where = `COMPOSITE_BOSSES.${key}`;
    if (template.id !== key) problems.push(`${where}: id "${template.id}" does not match its key`);
    if (!(template.chassis?.hp > 0)) problems.push(`${where}: chassis.hp must be > 0`);
    if (!(template.chassis?.radius > 0)) problems.push(`${where}: chassis.radius must be > 0`);

    const partIds = new Set();
    const weaponIds = new Set();
    for (const part of template.parts ?? []) {
      const partWhere = `${where}.parts.${part.id}`;
      if (!part.id) problems.push(`${where}: a part is missing an id`);
      if (partIds.has(part.id)) problems.push(`${where}: duplicate part id "${part.id}"`);
      partIds.add(part.id);
      if (!(part.hp > 0)) problems.push(`${partWhere}: hp must be > 0`);
      if (!(part.radius > 0)) problems.push(`${partWhere}: radius must be > 0`);
      if (!part.offset || !Number.isFinite(part.offset.x) || !Number.isFinite(part.offset.y)) {
        problems.push(`${partWhere}: offset must be {x, y} numbers`);
      }
      if (part.weapon) {
        if (weaponIds.has(part.weapon.id)) {
          problems.push(`${where}: duplicate weapon id "${part.weapon.id}"`);
        }
        weaponIds.add(part.weapon.id);
        checkAttack(partWhere, part.weapon);
      }
    }

    for (const armorId of template.chassis?.armoredBy ?? []) {
      if (!partIds.has(armorId)) {
        problems.push(`${where}: chassis.armoredBy names unknown part "${armorId}"`);
      }
    }

    /*
     * Innate weapons share the weapon-id namespace with the parts on purpose:
     * `boss:weapon_fire` carries one weaponId and the renderer keys muzzle
     * flashes off it, so two weapons answering to the same name would paint
     * one of them in the wrong place. They are collected into their own set
     * because a PHASE must not be able to arm one — a phase list is the boss's
     * armed guns while its parts live, and an innate weapon fires on the
     * enrage state instead.
     */
    const innateIds = new Set();
    for (const weapon of template.chassis?.innateWeapons ?? []) {
      const innateWhere = `${where}.chassis.innateWeapons.${weapon.id ?? 'unnamed'}`;
      if (!weapon.id) problems.push(`${where}: an innate weapon is missing an id`);
      if (weaponIds.has(weapon.id) || innateIds.has(weapon.id)) {
        problems.push(`${where}: duplicate weapon id "${weapon.id}"`);
      }
      innateIds.add(weapon.id);
      checkAttack(innateWhere, weapon);
    }

    const enrage = template.chassis?.enrage ?? null;
    if (enrage) {
      const enrageWhere = `${where}.chassis.enrage`;
      if (!enrageTriggers.has(enrage.trigger)) {
        problems.push(`${enrageWhere}: unknown enrage trigger "${enrage.trigger}"`);
      }
      if (!(enrage.speed >= 0)) problems.push(`${enrageWhere}: speed must be >= 0`);
      if (!(enrage.contactDamage >= 0)) {
        problems.push(`${enrageWhere}: contactDamage must be >= 0`);
      }
      /*
       * An enrage with no weapon of its own is the exact bug this whole block
       * exists to prevent, so it is a validator failure rather than a design
       * choice: a chassis that wakes up angry and then does nothing is worse
       * than one that stayed inert, because now it looks like it should be
       * dangerous.
       */
      const hasThreat =
        (template.chassis?.innateWeapons ?? []).length > 0 ||
        Boolean(enrage.chargeAttack) ||
        Boolean(enrage.gravityWell) ||
        Boolean(enrage.ventMinions) ||
        enrage.shockwaveInterval > 0;
      if (!hasThreat) {
        problems.push(`${enrageWhere}: enrages with no innate weapon, charge, well or vent`);
      }

      const charge = enrage.chargeAttack;
      if (charge) {
        if (!(charge.cooldown > 0)) {
          problems.push(`${enrageWhere}.chargeAttack: cooldown must be > 0`);
        }
        if (!(charge.telegraphDuration > 0)) {
          problems.push(`${enrageWhere}.chargeAttack: telegraphDuration must be > 0`);
        }
        if (!(charge.chargeDuration > 0)) {
          problems.push(`${enrageWhere}.chargeAttack: chargeDuration must be > 0`);
        }
        // The charge has to actually be faster than the drift it interrupts,
        // or the telegraph warns the player about nothing.
        if (!(charge.chargeSpeed > (enrage.speed ?? 0))) {
          problems.push(`${enrageWhere}.chargeAttack: chargeSpeed must exceed the enraged speed`);
        }
      }

      const vent = enrage.ventMinions;
      if (vent) {
        if (!(vent.cooldown > 0)) problems.push(`${enrageWhere}.ventMinions: cooldown must be > 0`);
        if (!(vent.count > 0)) problems.push(`${enrageWhere}.ventMinions: count must be > 0`);
        if (!ENEMY_ARCHETYPES[vent.archetypeId]) {
          problems.push(`${enrageWhere}.ventMinions: unknown archetypeId "${vent.archetypeId}"`);
        }
      }

      const well = enrage.gravityWell;
      if (well) {
        if (!(well.radius > 0)) problems.push(`${enrageWhere}.gravityWell: radius must be > 0`);
        if (!(well.pullForce > 0)) {
          problems.push(`${enrageWhere}.gravityWell: pullForce must be > 0`);
        }
      }

      if (enrage.shockwaveInterval !== undefined && !(enrage.shockwaveInterval > 0)) {
        problems.push(`${enrageWhere}: shockwaveInterval must be > 0`);
      }
      const wave = enrage.shockwave;
      if (wave) {
        if (!(enrage.shockwaveInterval > 0)) {
          problems.push(`${enrageWhere}: shockwave needs a shockwaveInterval`);
        }
        if (!(wave.speed > 0)) problems.push(`${enrageWhere}.shockwave: speed must be > 0`);
        if (!(wave.maxRadius > 0)) {
          problems.push(`${enrageWhere}.shockwave: maxRadius must be > 0`);
        }
        if (!(wave.thickness > 0)) {
          problems.push(`${enrageWhere}.shockwave: thickness must be > 0`);
        }
        if (!(wave.damage > 0)) problems.push(`${enrageWhere}.shockwave: damage must be > 0`);
      }
    }

    const phases = template.phases ?? [];
    if (phases.length === 0) problems.push(`${where}: needs at least one phase`);
    if (phases[0] && phases[0].trigger?.type !== PHASE_TRIGGERS.INITIAL) {
      problems.push(`${where}: the first phase must use the "initial" trigger`);
    }
    for (const phase of phases) {
      const phaseWhere = `${where}.phases.${phase.id}`;
      if (!triggers.has(phase.trigger?.type)) {
        problems.push(`${phaseWhere}: unknown trigger type "${phase.trigger?.type}"`);
      }
      for (const weaponId of phase.weapons ?? []) {
        if (innateIds.has(weaponId)) {
          problems.push(
            `${phaseWhere}: arms innate weapon "${weaponId}" — those fire on enrage, not on a phase`
          );
        } else if (!weaponIds.has(weaponId)) {
          problems.push(`${phaseWhere}: arms unknown weapon "${weaponId}"`);
        }
      }
      const names = phase.trigger?.parts ?? [];
      for (const partId of names) {
        if (!partIds.has(partId)) {
          problems.push(`${phaseWhere}: trigger names unknown part "${partId}"`);
        }
      }
    }
  }

  return problems;
}
