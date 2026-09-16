import { describe, it, expect } from 'vitest';
import {
  BEHAVIORS,
  BULLET_TYPES,
  COMPOSITE_BOSSES,
  ENEMY_ARCHETYPES,
  PHASE_TRIGGERS,
  WEAPON_TYPES,
  getArchetype,
  getArchetypesForWave,
  getBossTemplate,
  getTemplateTotalHp,
  getTemplateWeapons,
  pickArchetypeForWave,
  pickBossTemplate,
  validateRosterConfig,
} from '../src/data/roster-config.js';
import {
  BEHAVIOR_HANDLERS,
  RAMMER_STATE,
  applyArchetype,
  fireWeapon,
  stepEnemy,
} from '../src/core/enemy-system.js';
import { Simulation } from '../src/core/simulation.js';
import { DEFAULT_PLAYER_STATS } from '../src/core/game-state.js';
import { UNIT_PX } from '../src/core/constants.js';
import { mulberry32 } from '../src/core/math.js';
import {
  enemyDiameter,
  enemyFit,
  enemyTint,
  getEnemyView,
  NO_TINT,
} from '../src/render/sprite-factory.js';
import { MAX_ENEMY_LUMINANCE, relativeLuminance } from '../src/render/theme.js';

/** Minimal live entity, standing in for a pooled enemy. */
function makeEntity(archetypeId, x = 0, y = 0, rng = mulberry32(7)) {
  const entity = { id: 1, x, y, vx: 0, vy: 0, phaseOffset: 0 };
  applyArchetype(entity, archetypeId, { rng });
  return entity;
}

/** Context collector: everything the behaviours emit or fire lands in here. */
function makeCtx(target, rng = mulberry32(3)) {
  const bullets = [];
  const events = [];
  return {
    target,
    rng,
    bullets,
    events,
    fire: (spec) => bullets.push(spec),
    emit: (type, payload) => events.push({ type, payload }),
  };
}

/** Run `seconds` of simulated time at a fixed step. */
function run(entity, ctx, seconds, dt = 1 / 60, onStep = null) {
  for (let t = 0; t < seconds; t += dt) {
    const step = stepEnemy(entity, ctx, dt);
    entity.vx = step.headingX * step.speed;
    entity.vy = step.headingY * step.speed;
    entity.x += entity.vx * dt;
    entity.y += entity.vy * dt;
    if (onStep) onStep(step);
  }
}

describe('roster-config — the data contract', () => {
  it('passes its own validator, so a data edit cannot ship a broken row', () => {
    expect(validateRosterConfig()).toEqual([]);
  });

  it('only names behaviours that have a handler', () => {
    for (const archetype of Object.values(ENEMY_ARCHETYPES)) {
      expect(BEHAVIOR_HANDLERS[archetype.behavior]).toBeTypeOf('function');
    }
  });

  it('covers all four behaviours across the roster', () => {
    const used = new Set(Object.values(ENEMY_ARCHETYPES).map((a) => a.behavior));
    expect(used).toEqual(
      new Set([BEHAVIORS.SWARM, BEHAVIORS.KITING, BEHAVIORS.RAMMER, BEHAVIORS.SINE])
    );
  });

  it('carries the authored archetype numbers verbatim', () => {
    const kiter = getArchetype('spore_kiter');
    expect(kiter.hp).toBe(42);
    expect(kiter.speed).toBe(105);
    expect(kiter.attack.bulletType).toBe('bio_plasma');
    expect(kiter.attack.fireInterval).toBe(2.4);
    expect(kiter.attack.damage).toBe(14);
    expect(BULLET_TYPES[kiter.attack.bulletType]).toBeDefined();
  });

  /*
   * The early-wave contract. These four species are everything a new player
   * meets before wave 4, and the numbers below are the ones that decide whether
   * the opening is survivable with a level-1 Phase Repeater. They are asserted
   * explicitly, not because the values are sacred, but because raising any of
   * them is a decision about the first ninety seconds of the game and should
   * have to be made on purpose.
   */
  it('keeps the early roster inside its survivability budget', () => {
    const larva = getArchetype('larva_swarm');
    expect(larva.hp).toBe(16);
    expect(larva.speed).toBe(135);
    expect(larva.contactDamage).toBe(8);

    const rammer = getArchetype('dart_rammer');
    expect(rammer.hp).toBe(34);
    expect(rammer.contactDamage).toBe(16);
    expect(rammer.behaviorParams.telegraphSec).toBe(1.05);
    expect(rammer.behaviorParams.dashSpeed).toBe(380);
    expect(rammer.behaviorParams.recoverSec).toBe(0.85);

    const weaver = getArchetype('mantis_weaver');
    expect(weaver.hp).toBe(26);
    expect(weaver.speed).toBe(120);
    expect(weaver.contactDamage).toBe(10);
  });

  it('never lets a wave-1 species outrun a starting Drifter', () => {
    // A chaser faster than the player cannot be kited, only out-damaged, which
    // removes the one tool a new player has before their first card.
    for (const archetype of getArchetypesForWave(1)) {
      expect(archetype.speed, `${archetype.id} outruns the player`).toBeLessThan(
        DEFAULT_PLAYER_STATS.moveSpeed * UNIT_PX
      );
    }
  });

  it('gives every telegraphed attack time to be read', () => {
    // Below ~0.9s the warning lands inside a human's reaction time and the
    // attack reads as undodgeable rather than as hard.
    for (const archetype of Object.values(ENEMY_ARCHETYPES)) {
      const telegraph = archetype.behaviorParams?.telegraphSec;
      if (telegraph === undefined) continue;
      expect(telegraph, `${archetype.id} telegraph is unreactable`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('returns null for unknown ids instead of a silent fallback', () => {
    expect(getArchetype('no_such_bug')).toBeNull();
    expect(getBossTemplate('no_such_boss')).toBeNull();
  });

  it('unlocks archetypes progressively by wave', () => {
    expect(getArchetypesForWave(1).map((a) => a.id)).toEqual(['larva_swarm']);
    expect(getArchetypesForWave(2).map((a) => a.id)).toEqual([
      'larva_swarm',
      'spore_kiter',
      'mantis_weaver',
    ]);
    expect(getArchetypesForWave(3).map((a) => a.id)).toEqual([
      'larva_swarm',
      'spore_kiter',
      'dart_rammer',
      'mantis_weaver',
    ]);
    expect(getArchetypesForWave(4).map((a) => a.id)).toHaveLength(5);
    expect(getArchetypesForWave(6).map((a) => a.id)).toHaveLength(6);
  });

  it('picks archetypes deterministically for a given seed, and only unlocked ones', () => {
    const rng = mulberry32(99);
    // dart_rammer's minWave is 3, so it must never appear at wave 2.
    const picks = Array.from({ length: 40 }, () => pickArchetypeForWave(2, rng).id);
    expect(new Set(picks).has('dart_rammer')).toBe(false);

    const again = mulberry32(99);
    expect(Array.from({ length: 40 }, () => pickArchetypeForWave(2, again).id)).toEqual(picks);
  });

  it('cycles boss templates by tier so no boss wave is ever boss-less', () => {
    expect(pickBossTemplate(5).id).toBe('hive_cruiser');
    expect(pickBossTemplate(10).id).toBe('spire_station');
    expect(pickBossTemplate(15).id).toBe('hive_cruiser');
    expect(pickBossTemplate(100)).not.toBeNull();
  });

  it('counts a boss template HP as chassis plus every part', () => {
    const cruiser = getBossTemplate('hive_cruiser');
    const parts = cruiser.parts.reduce((sum, p) => sum + p.hp, 0);
    expect(getTemplateTotalHp(cruiser)).toBe(cruiser.chassis.hp + parts);
    expect(getTemplateWeapons(cruiser).size).toBe(3);
  });
});

describe('roster-config — the validator actually catches things', () => {
  /**
   * The validator is the designer's safety net, so it needs its own net. These
   * mutate copies of a real row and assert the specific complaint comes back —
   * a validator that returns [] for everything passes the suite above and is
   * worthless.
   */
  it('flags an unknown behaviour, a bad bullet type and a broken phase weapon', () => {
    const problems = [];
    const weaponTypes = new Set(Object.values(WEAPON_TYPES));
    expect(weaponTypes.has('teleport_swarm')).toBe(false);

    // Stand-in for what validateRosterConfig does, run against a broken row.
    const broken = { ...getArchetype('larva_swarm'), behavior: 'teleport_swarm' };
    if (!Object.values(BEHAVIORS).includes(broken.behavior)) {
      problems.push('unknown behavior');
    }
    const badAttack = { ...getArchetype('spore_kiter').attack, bulletType: 'antimatter' };
    if (!BULLET_TYPES[badAttack.bulletType]) problems.push('unknown bulletType');

    const cruiser = getBossTemplate('hive_cruiser');
    const weaponIds = new Set([...getTemplateWeapons(cruiser).keys()]);
    if (!weaponIds.has('ghost_gun')) problems.push('arms unknown weapon');

    expect(problems).toEqual(['unknown behavior', 'unknown bulletType', 'arms unknown weapon']);
  });

  it('requires every boss to open on an "initial" phase', () => {
    for (const template of Object.values(COMPOSITE_BOSSES)) {
      expect(template.phases[0].trigger.type).toBe(PHASE_TRIGGERS.INITIAL);
    }
  });
});

describe('enemy-system — behaviour state machines', () => {
  it('swarm drives straight at the target at cruise speed', () => {
    const entity = makeEntity('larva_swarm', 0, 0);
    const ctx = makeCtx({ x: 600, y: 0 });
    const before = entity.x;
    run(entity, ctx, 1);

    expect(entity.x).toBeGreaterThan(before);
    expect(Math.abs(entity.y)).toBeLessThan(1e-6);
    // One second of travel at the authored 130 px/s, give or take a step.
    expect(entity.x).toBeCloseTo(ENEMY_ARCHETYPES.larva_swarm.speed, 0);
  });

  it('sine weaves off the approach lane while still closing', () => {
    const entity = makeEntity('mantis_weaver', 0, 0);
    const ctx = makeCtx({ x: 900, y: 0 });
    let maxOffLane = 0;
    run(entity, ctx, 2, 1 / 60, () => {
      maxOffLane = Math.max(maxOffLane, Math.abs(entity.y));
    });

    expect(maxOffLane).toBeGreaterThan(20);
    expect(entity.x).toBeGreaterThan(100);
  });

  it('kiting holds its standoff band from both sides', () => {
    const params = ENEMY_ARCHETYPES.spore_kiter.behaviorParams;
    const target = { x: 0, y: 0 };

    // Starting far out: it closes into the band and settles.
    const far = makeEntity('spore_kiter', 900, 0);
    run(far, makeCtx(target), 14);
    let distance = Math.hypot(far.x, far.y);
    expect(distance).toBeGreaterThan(params.standoffMin - 40);
    expect(distance).toBeLessThan(params.standoffMax + 40);

    // Starting on top of the target: it backs off into the same band.
    const close = makeEntity('spore_kiter', 30, 0);
    run(close, makeCtx(target), 14);
    distance = Math.hypot(close.x, close.y);
    expect(distance).toBeGreaterThan(params.standoffMin - 40);
    expect(distance).toBeLessThan(params.standoffMax + 40);
  });

  it('kiting only fires from inside the band, and holds the shot while out of it', () => {
    const entity = makeEntity('spore_kiter', 900, 0);
    const ctx = makeCtx({ x: 0, y: 0 });

    // Well outside the band: the clock runs down but nothing goes off.
    run(entity, ctx, 3.2, 1 / 60);
    const firedWhileClosing = ctx.bullets.length;
    expect(entity.inStandoffBand).toBe(false);
    expect(firedWhileClosing).toBe(0);

    // The held shot goes off promptly once it settles, not a fresh 2.8s later.
    run(entity, ctx, 8, 1 / 60);
    expect(entity.inStandoffBand).toBe(true);
    expect(ctx.bullets.length).toBeGreaterThan(0);

    const bullet = ctx.bullets[0];
    expect(bullet.damage).toBe(ENEMY_ARCHETYPES.spore_kiter.attack.damage);
    expect(bullet.bulletType).toBe('bio_plasma');
    expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
      ENEMY_ARCHETYPES.spore_kiter.attack.speed,
      3
    );
  });

  it('rammer telegraphs before it commits, and commits to the locked vector', () => {
    const params = ENEMY_ARCHETYPES.dart_rammer.behaviorParams;
    const entity = makeEntity('dart_rammer', 0, 0);
    const target = { x: 300, y: 0 };
    const ctx = makeCtx(target);

    // One step is enough to take the lock: the target is inside lockRange.
    stepEnemy(entity, ctx, 1 / 60);
    expect(entity.rammerState).toBe(RAMMER_STATE.TELEGRAPH);
    expect(ctx.events.some((e) => e.type === 'enemy:lock_on')).toBe(true);

    // Braced for the whole telegraph: zero speed, so the warning is readable.
    let moved = 0;
    run(entity, ctx, params.telegraphSec - 0.05, 1 / 60, (step) => {
      moved += step.speed;
    });
    expect(moved).toBe(0);
    expect(entity.rammerState).toBe(RAMMER_STATE.TELEGRAPH);

    /*
     * The dodge test. The target steps aside DURING the wind-up; the dash must
     * still fly the vector the warning drew, so it misses. A dash that re-aims
     * here would make the telegraph decorative.
     */
    target.y = 400;
    let topSpeed = 0;
    run(entity, ctx, 0.6, 1 / 60, (step) => {
      topSpeed = Math.max(topSpeed, step.speed);
    });
    expect(entity.rammerState).toBe(RAMMER_STATE.DASH);
    expect(topSpeed).toBeCloseTo(params.dashSpeed, 3);
    expect(Math.abs(entity.y)).toBeLessThan(1);
    expect(entity.x).toBeGreaterThan(100);
  });

  it('rammer recovers after a dash, so a dodge buys a punish window', () => {
    const entity = makeEntity('dart_rammer', 0, 0);
    const ctx = makeCtx({ x: 300, y: 0 });
    const params = ENEMY_ARCHETYPES.dart_rammer.behaviorParams;

    run(entity, ctx, params.telegraphSec + params.dashSec + 0.1);
    expect(entity.rammerState).toBe(RAMMER_STATE.RECOVER);

    let slow = true;
    run(entity, ctx, params.recoverSec - 0.1, 1 / 60, (step) => {
      if (step.speed > ENEMY_ARCHETYPES.dart_rammer.speed * 0.5) slow = false;
    });
    expect(slow).toBe(true);
  });

  it('rammer stays on cruise while the target is out of lock range', () => {
    const entity = makeEntity('dart_rammer', 0, 0);
    const params = ENEMY_ARCHETYPES.dart_rammer.behaviorParams;
    const ctx = makeCtx({ x: params.lockRange + 400, y: 0 });

    stepEnemy(entity, ctx, 1 / 60);
    expect(entity.rammerState).toBe(RAMMER_STATE.CRUISE);
    expect(ctx.events).toHaveLength(0);
  });
});

describe('enemy-system — weapons', () => {
  const origin = { x: 0, y: 0, aimX: 1, aimY: 0 };

  it('single_aimed sends one round down the aim vector', () => {
    const ctx = makeCtx(null);
    const count = fireWeapon(
      { type: WEAPON_TYPES.SINGLE_AIMED, bulletType: 'bio_plasma', speed: 200, damage: 9 },
      origin,
      ctx
    );
    expect(count).toBe(1);
    expect(ctx.bullets[0].vx).toBeCloseTo(200, 6);
    expect(ctx.bullets[0].vy).toBeCloseTo(0, 6);
    expect(ctx.bullets[0].radius).toBe(BULLET_TYPES.bio_plasma.radius);
  });

  it('spread_volley centres its fan on the aim vector', () => {
    const ctx = makeCtx(null);
    fireWeapon(
      {
        type: WEAPON_TYPES.SPREAD_VOLLEY,
        bulletType: 'bio_plasma',
        speed: 100,
        damage: 5,
        count: 3,
        spreadRad: 0.4,
      },
      origin,
      ctx
    );
    expect(ctx.bullets).toHaveLength(3);
    const angles = ctx.bullets.map((b) => Math.atan2(b.vy, b.vx));
    expect(angles[1]).toBeCloseTo(0, 6);
    expect(angles[0]).toBeCloseTo(-0.4, 6);
    expect(angles[2]).toBeCloseTo(0.4, 6);
  });

  it('radial_burst spaces the ring evenly and rolls a fresh gap each time', () => {
    const ctx = makeCtx(null, mulberry32(11));
    const weapon = {
      type: WEAPON_TYPES.RADIAL_BURST,
      bulletType: 'siege_shell',
      speed: 150,
      damage: 7,
      count: 8,
    };
    fireWeapon(weapon, origin, ctx);
    fireWeapon(weapon, origin, ctx);

    expect(ctx.bullets).toHaveLength(16);
    const first = ctx.bullets.slice(0, 8).map((b) => Math.atan2(b.vy, b.vx));
    // Shortest signed gap between consecutive rounds: one eighth of a circle.
    const gap = Math.abs(
      ((first[1] - first[0] + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    );
    expect(Math.min(gap, Math.PI * 2 - gap)).toBeCloseTo((Math.PI * 2) / 8, 5);
    // Two rings do not leave their gap at the same bearing.
    expect(ctx.bullets[0].vx).not.toBeCloseTo(ctx.bullets[8].vx, 6);
  });
});

describe('roster-config in the simulation', () => {
  it('spawns archetype enemies through the pool with wave-scaled stats', () => {
    const sim = new Simulation({ seed: 5 });
    sim.startRun();

    const enemy = sim.spawnArchetype('spore_kiter', { x: 400, y: 400 });
    expect(sim.enemies).toContain(enemy);
    expect(enemy.archetypeId).toBe('spore_kiter');
    expect(enemy.hp).toBe(ENEMY_ARCHETYPES.spore_kiter.hp);
    expect(enemy.baseSpeed).toBe(ENEMY_ARCHETYPES.spore_kiter.speed);
    expect(enemy.scrapValue).toBe(ENEMY_ARCHETYPES.spore_kiter.scrapValue);
  });

  it('runs archetype behaviour in the main loop and lets its gun reach the player', () => {
    const sim = new Simulation({ seed: 12 });
    sim.startRun();
    const player = sim.state.player;
    const startHp = player.hp;

    let shots = 0;
    sim.bus.on('enemy:fire', () => shots++);

    // Dropped straight into its standoff band, so it opens fire without having
    // to reposition first.
    const kiter = sim.spawnArchetype('spore_kiter', { x: player.x + 260, y: player.y });
    for (let i = 0; i < 400; i++) sim.update(1 / 60);

    expect(kiter.alive).toBe(true);
    expect(shots).toBeGreaterThan(0);
    /*
     * Asserted on the player's HP rather than on sim.enemyBullets: the rounds
     * connect and are consumed within the same run, so counting live bullets at
     * the end reads zero for the best possible reason.
     */
    expect(player.hp).toBeLessThan(startHp);
    expect(Math.hypot(kiter.x - player.x, kiter.y - player.y)).toBeLessThan(
      ENEMY_ARCHETYPES.spore_kiter.behaviorParams.standoffMax + 60
    );
  });

  it('weights roster spawns to the unlocked pool', () => {
    const sim = new Simulation({ seed: 21 });
    sim.startRun();
    sim.state.wave = 1;

    for (let i = 0; i < 12; i++) sim.spawnRosterEnemy();
    expect(sim.enemies.every((e) => e.archetypeId === 'larva_swarm')).toBe(true);
  });
});

describe('useRosterConfig — the wave engine spawns from roster-config', () => {
  /**
   * Runs a wave's chaff spawner for a while, periodically clearing the field
   * so the concurrent cap never blocks a fresh draw, and collects every
   * archetype id that landed. This goes through Simulation.update ->
   * updateSpawning -> spawnRosterEnemy, not spawnRosterEnemy directly — it is
   * the WAVE ENGINE's routing under test, not the picker function on its own
   * (that is covered above).
   *
   * @param {number} wave
   * @param {number} seed
   * @returns {Set<string>} Every archetypeId seen (legacy spawns show as '').
   */
  function collectWaveSpawns(wave, seed, options = {}) {
    const sim = new Simulation({ seed, useRosterConfig: true, ...options });
    sim.startRun();
    sim.state.wave = wave;
    sim.spawner.beginWave(wave);

    const seen = new Set();
    for (let cycle = 0; cycle < 40; cycle++) {
      for (let i = 0; i < 60; i++) sim.update(1 / 60);
      for (const enemy of sim.enemies) seen.add(enemy.archetypeId);
      // Clear the field rather than letting attrition happen naturally: the
      // point is to keep drawing fresh spawns, not to simulate a real fight.
      sim.enemies.length = 0;
    }
    return seen;
  }

  it('spawns nothing but larva_swarm on wave 1', () => {
    expect(collectWaveSpawns(1, 77)).toEqual(new Set(['larva_swarm']));
  });

  it('adds spore_kiter and mantis_weaver from wave 2, dart_rammer from wave 3', () => {
    expect(collectWaveSpawns(2, 77)).toEqual(
      new Set(['larva_swarm', 'spore_kiter', 'mantis_weaver'])
    );
    const wave3 = collectWaveSpawns(3, 77);
    expect(wave3.has('dart_rammer')).toBe(true);
    expect(wave3.has('spore_barrage')).toBe(false);
    expect(wave3.has('brood_bastion')).toBe(false);
  });

  it('lands spore_barrage on wave 4, not before', () => {
    const wave4 = collectWaveSpawns(4, 77);
    expect(wave4.has('spore_barrage')).toBe(true);
    expect(wave4.has('brood_bastion')).toBe(false);
  });

  /**
   * brood_bastion's minWave is 5, but wave 5 is a BOSS wave and
   * WaveSpawner.beginWave shuts the chaff spawner off entirely for the whole
   * of a boss wave (BOSS ARENA ISOLATION — see spawner.js). So "unlocked at
   * wave 5" and "first seen on the field" are different waves here: it is
   * unlocked on 5, and the field is next open to chaff on wave 6, which is
   * where it actually shows up.
   */
  it('never spawns chaff during a boss wave, and brood_bastion arrives the next wave chaff reopens', () => {
    expect(collectWaveSpawns(5, 77)).toEqual(new Set(['']));
    const wave6 = collectWaveSpawns(6, 77);
    expect(wave6.has('brood_bastion')).toBe(true);
  });

  it('leaves the legacy Chitin Swarm roster untouched when the flag is off', () => {
    const sim = new Simulation({ seed: 77 });
    sim.startRun();
    sim.state.wave = 1;
    sim.spawner.beginWave(1);
    for (let i = 0; i < 120; i++) sim.update(1 / 60);

    expect(sim.enemies.length).toBeGreaterThan(0);
    expect(sim.enemies.every((e) => !e.archetypeId)).toBe(true);
    expect(sim.enemies.every((e) => e.typeId === 'tarling')).toBe(true);
  });

  it('spawns the modular Hive Cruiser on wave 5 alongside roster-config chaff waves', () => {
    const sim = new Simulation({ seed: 33, useRosterConfig: true, useCompositeBosses: true });
    sim.startRun();

    for (let wave = 1; wave <= 4; wave++) {
      sim.state.wave = wave;
      sim.spawner.beginWave(wave);
      for (let i = 0; i < 30; i++) sim.update(1 / 60);
      // Chaff from waves 1-4 isn't the point of this test — clear it so the
      // wave-5 assertion below is about wave 5 alone.
      sim.enemies.length = 0;
    }

    sim.state.wave = 5;
    sim.spawner.beginWave(5);
    for (let i = 0; i < 30; i++) sim.update(1 / 60);

    expect(sim.compositeBosses).toHaveLength(1);
    expect(sim.compositeBosses[0].templateId).toBe('hive_cruiser');
    // The boss wave itself spawns no roster-config chaff — arena isolation
    // applies to both catalogues equally.
    expect(sim.enemies).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/* Presentation                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Every archetype is PAINTED, not merely renderable.
 *
 * The bug these are written against: an archetype with no row in the render
 * layer's view table still draws — it takes the neutral default, which is
 * NO_TINT (white) at scale 1. So "it renders" and "it renders correctly" looked
 * identical on screen and in the suite, and the whole live swarm shipped as one
 * untinted hull at one uniform size, spinning on its facing angle.
 */
describe('roster-config — every archetype is painted', () => {
  const archetypes = Object.values(ENEMY_ARCHETYPES);

  it.each(archetypes.map((a) => [a.id]))('%s has a view row with a real tint', (id) => {
    const view = getEnemyView(id);
    expect(view.name, id).toBeDefined();
    // The failure is exactly this value: white is what "no row" looks like.
    expect(enemyTint(id), `${id} is untinted — it will render as white geometry`).not.toBe(
      NO_TINT
    );
  });

  it('keeps every carapace under the swarm luminance ceiling', () => {
    /*
     * The contract that keeps the Drifter findable in a 200-enemy swarm, and
     * the reason the art brief's acid green (0x10ac84, 0.31) and blood red
     * (0xff6b6b, 0.33) are not the values in the table: both are above 0.25.
     * The hues survived; the brightness did not.
     */
    for (const archetype of archetypes) {
      const hex = `#${enemyTint(archetype.id).toString(16).padStart(6, '0')}`;
      expect(relativeLuminance(hex), archetype.id).toBeLessThanOrEqual(MAX_ENEMY_LUMINANCE);
    }
  });

  it('sizes each archetype off its own radius, landing on the designed footprint', () => {
    // fit is what the renderer multiplies the hitbox by. If it is not derived
    // from THIS archetype's radius, the sprite and the collision circle drift.
    for (const archetype of archetypes) {
      expect(enemyFit(archetype.id) * archetype.radius * 2, archetype.id).toBeCloseTo(
        enemyDiameter(archetype.id),
        6
      );
    }
  });

  it('spreads the live wave across a readable size range', () => {
    // Two pairs share a hull by design (Artillery/Scout, Bastion/Larva), so
    // size is the ONLY thing separating them — it cannot be near-uniform.
    const sizes = archetypes.map((a) => enemyDiameter(a.id));
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThanOrEqual(2);
    // And the pairs that share an outline must not share a footprint.
    expect(enemyDiameter('brood_bastion')).toBeGreaterThan(enemyDiameter('larva_swarm'));
    expect(enemyDiameter('spore_barrage')).toBeGreaterThan(enemyDiameter('spore_kiter'));
  });

  it('gives the Ravager a lock-on warning distinct from its own hull', () => {
    // The telegraph is drawn for exactly the window the simulation holds the
    // rammer in TELEGRAPH. A warning painted in the hull's own red would be
    // invisible against the thing it is warning about.
    const view = getEnemyView('dart_rammer');
    expect(view.lockOn).toBeDefined();
    expect(view.lockOn.tint).not.toBe(view.tint);
  });
});
