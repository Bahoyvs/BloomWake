import { describe, it, expect } from 'vitest';
import { CHARGE_STATE, CompositeBoss } from '../src/core/composite-boss.js';
import {
  COMPOSITE_BOSSES,
  ENEMY_ARCHETYPES,
  WEAPON_TYPES,
  getBossTemplate,
  getChassisWeapons,
  getTemplateTotalHp,
  gravityWellForce,
} from '../src/data/roster-config.js';
import { WORLD } from '../src/core/constants.js';
import { WAVE_CONSTANTS } from '../src/core/wave.js';
import { Simulation } from '../src/core/simulation.js';
import { mulberry32 } from '../src/core/math.js';
import { Container } from 'pixi.js';
import {
  BOSS_TEXTURE_KEY,
  BOSS_VIEW,
  CompositeBossRenderer,
} from '../src/render/composite-boss-renderer.js';

/**
 * Collector context: everything the boss produces lands here.
 *
 * All six outbound channels, not just the two the boss needed before an
 * enrage existed. The point of routing wake, minions, pull and shockwave hits
 * through callbacks instead of through a Simulation handle is exactly this —
 * the whole enraged state machine is assertable without a pool, a bus or a
 * player anywhere in the test.
 */
function makeCtx(target = { x: 0, y: 0 }) {
  const bullets = [];
  const events = [];
  const hazards = [];
  const spawns = [];
  const impulses = [];
  const hurts = [];
  return {
    target,
    bullets,
    events,
    hazards,
    spawns,
    impulses,
    hurts,
    rng: mulberry32(17),
    fire: (spec) => bullets.push(spec),
    emit: (type, payload) => events.push({ type, payload }),
    hazard: (spec) => hazards.push(spec),
    spawn: (spec) => spawns.push(spec),
    impulse: (dvx, dvy) => impulses.push({ dvx, dvy }),
    hurt: (amount) => hurts.push(amount),
    of: (type) => events.filter((e) => e.type === type),
  };
}

function makeBoss(templateId = 'hive_cruiser', options = {}) {
  return new CompositeBoss(templateId, {
    x: 0,
    y: 0,
    id: 1,
    rng: mulberry32(5),
    ...options,
  });
}

function tick(boss, ctx, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) boss.update(dt, ctx);
}

/** Shoot a specific part until it is wrecked. */
function wreckPart(boss, partId, ctx) {
  const part = boss.getPart(partId);
  while (part.alive) boss.damagePart(partId, 100, ctx);
  return part;
}

/** Strip every part named in `chassis.armoredBy`, and nothing else. */
function stripArmor(boss, ctx) {
  for (const partId of boss.template.chassis.armoredBy ?? []) wreckPart(boss, partId, ctx);
}

/**
 * Tick until `predicate` holds, with a hard stop.
 *
 * Returns the seconds it took, so a test can assert WHEN something happened
 * rather than only that it eventually did — a charge that fires two seconds
 * late still satisfies "it charges".
 *
 * @returns {number} Seconds elapsed, or -1 if it never happened
 */
function tickUntil(boss, ctx, predicate, limitSec = 20, dt = 1 / 60) {
  for (let t = 0; t < limitSec; t += dt) {
    boss.update(dt, ctx);
    if (predicate(boss)) return t + dt;
  }
  return -1;
}

describe('CompositeBoss — assembly', () => {
  it('builds a chassis and one record per authored part', () => {
    const boss = makeBoss();
    const template = getBossTemplate('hive_cruiser');

    expect(boss.parts).toHaveLength(template.parts.length);
    expect(boss.parts.map((p) => p.id)).toEqual(template.parts.map((p) => p.id));
    expect(boss.totalMaxHp).toBe(getTemplateTotalHp(template));
    expect(boss.hpFraction).toBe(1);
    expect(boss.phaseNumber).toBe(1);
  });

  it('scales chassis AND parts by hpScale, so the bar stays honest', () => {
    const boss = makeBoss('hive_cruiser', { hpScale: 2 });
    const template = getBossTemplate('hive_cruiser');

    expect(boss.chassisMaxHp).toBe(template.chassis.hp * 2);
    expect(boss.getPart('turret_port').maxHp).toBe(
      template.parts.find((p) => p.id === 'turret_port').hp * 2
    );
    expect(boss.totalMaxHp).toBe(getTemplateTotalHp(template) * 2);
  });

  it('rejects an unknown template rather than spawning an empty boss', () => {
    expect(() => new CompositeBoss('no_such_station')).toThrow();
  });
});

describe('CompositeBoss — world transform', () => {
  it('places parts at their authored local offsets when unrotated', () => {
    const boss = makeBoss('hive_cruiser', { x: 500, y: 300 });
    const port = boss.getPart('turret_port');
    const def = getBossTemplate('hive_cruiser').parts.find((p) => p.id === 'turret_port');

    expect(port.worldX).toBeCloseTo(500 + def.offset.x, 6);
    expect(port.worldY).toBeCloseTo(300 + def.offset.y, 6);
  });

  it('rotates part offsets with the hull', () => {
    const boss = makeBoss('hive_cruiser', { x: 0, y: 0 });
    const def = getBossTemplate('hive_cruiser').parts.find((p) => p.id === 'turret_port');

    boss.rotation = Math.PI / 2;
    boss.syncParts();

    const port = boss.getPart('turret_port');
    // A quarter turn maps local (x, y) to world (-y, x).
    expect(port.worldX).toBeCloseTo(-def.offset.y, 6);
    expect(port.worldY).toBeCloseTo(def.offset.x, 6);
  });

  it('keeps the offset rigid: distance from the hub never changes', () => {
    const boss = makeBoss();
    const def = getBossTemplate('hive_cruiser').parts.find((p) => p.id === 'reactor_core');
    const authored = Math.hypot(def.offset.x, def.offset.y);
    const ctx = makeCtx({ x: 0, y: 0 });

    tick(boss, ctx, 5);
    const core = boss.getPart('reactor_core');
    expect(Math.hypot(core.worldX - boss.x, core.worldY - boss.y)).toBeCloseTo(authored, 6);
  });

  it('carries wrecked parts along with the hull, so debris stays bolted on', () => {
    const boss = makeBoss();
    const ctx = makeCtx({ x: 2000, y: 0 });
    wreckPart(boss, 'reactor_core', ctx);

    tick(boss, ctx, 2);
    const core = boss.getPart('reactor_core');
    expect(core.alive).toBe(false);
    expect(Math.hypot(core.worldX - boss.x, core.worldY - boss.y)).toBeGreaterThan(0);
  });
});

describe('CompositeBoss — hit resolution', () => {
  it('resolves a shot on a turret to the turret, not the hull', () => {
    const boss = makeBoss();
    const port = boss.getPart('turret_port');
    const hit = boss.hitTest(port.worldX, port.worldY, 4);

    expect(hit.kind).toBe('part');
    expect(hit.part.id).toBe('turret_port');
  });

  it('resolves a shot on the bare hull to the chassis, and a miss to null', () => {
    const boss = makeBoss();
    expect(boss.hitTest(boss.x, boss.y + 10, 2).kind).toBe('chassis');
    expect(boss.hitTest(boss.x + 5000, boss.y, 2)).toBeNull();
  });

  it('gives the nearest part the hit when two are in reach', () => {
    const boss = makeBoss('spire_station');
    const a = boss.getPart('pylon_a');
    const hit = boss.hitTest(a.worldX + 4, a.worldY, 10);
    expect(hit.part.id).toBe('pylon_a');
  });
});

describe('CompositeBoss — armour and part destruction', () => {
  it('deflects every shot at the chassis while its armour parts stand', () => {
    const boss = makeBoss();
    const ctx = makeCtx();

    expect(boss.isChassisVulnerable()).toBe(false);
    const result = boss.damageAt(boss.x, boss.y + 6, 500, ctx);

    expect(result.deflected).toBe(true);
    expect(result.applied).toBe(0);
    expect(boss.chassisHp).toBe(boss.chassisMaxHp);
    // The deflection is announced: silent immunity reads as a broken boss.
    expect(ctx.of('boss:deflected')).toHaveLength(1);
  });

  it('exposes the chassis only once every named armour part is gone', () => {
    const boss = makeBoss();
    const ctx = makeCtx();

    wreckPart(boss, 'turret_port', ctx);
    expect(boss.isChassisVulnerable()).toBe(false);

    // The reactor is not armour: wrecking it changes nothing about the hull.
    wreckPart(boss, 'reactor_core', ctx);
    expect(boss.isChassisVulnerable()).toBe(false);

    wreckPart(boss, 'turret_starboard', ctx);
    expect(boss.isChassisVulnerable()).toBe(true);

    const result = boss.damageAt(boss.x, boss.y, 300, ctx);
    expect(result.deflected).toBe(false);
    expect(result.applied).toBe(300);
    expect(boss.chassisHp).toBe(boss.chassisMaxHp - 300);
  });

  it('announces a wrecked part once, with whether it opened the hull', () => {
    const boss = makeBoss();
    const ctx = makeCtx();

    wreckPart(boss, 'turret_port', ctx);
    let destroyed = ctx.of('boss:part_destroyed');
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].payload.partId).toBe('turret_port');
    expect(destroyed[0].payload.exposesChassis).toBe(false);

    // Further damage to a wreck is a no-op and fires nothing.
    expect(boss.damagePart('turret_port', 999, ctx)).toBe(0);
    expect(ctx.of('boss:part_destroyed')).toHaveLength(1);

    wreckPart(boss, 'turret_starboard', ctx);
    destroyed = ctx.of('boss:part_destroyed');
    expect(destroyed).toHaveLength(2);
    expect(destroyed[1].payload.exposesChassis).toBe(true);
  });

  it('applies a wrecked part onDestroyed modifiers to the chassis', () => {
    const boss = makeBoss();
    const ctx = makeCtx();
    const def = getBossTemplate('hive_cruiser').parts.find((p) => p.id === 'reactor_core');

    expect(boss.wreckSpeedScale).toBe(1);
    wreckPart(boss, 'reactor_core', ctx);

    expect(boss.wreckSpeedScale).toBeCloseTo(def.onDestroyed.chassisSpeedScale, 6);
    expect(boss.wreckSpinScale).toBeCloseTo(def.onDestroyed.chassisSpinScale, 6);
  });

  it('counts total HP as chassis plus living parts, and reports it as a fraction', () => {
    const boss = makeBoss();
    const ctx = makeCtx();
    const before = boss.totalHp;

    boss.damagePart('turret_port', 60, ctx);
    expect(boss.totalHp).toBe(before - 60);

    const port = boss.getPart('turret_port');
    wreckPart(boss, 'turret_port', ctx);
    expect(boss.totalHp).toBe(before - port.maxHp);
    expect(boss.hpFraction).toBeCloseTo(boss.totalHp / boss.totalMaxHp, 9);
  });

  it('dies when the chassis is emptied, and pays out once', () => {
    const boss = makeBoss();
    const ctx = makeCtx();

    wreckPart(boss, 'turret_port', ctx);
    wreckPart(boss, 'turret_starboard', ctx);
    boss.damageChassis(boss.chassisHp, ctx);

    expect(boss.alive).toBe(false);
    expect(ctx.of('boss:destroyed')).toHaveLength(1);
    expect(ctx.of('boss:destroyed')[0].payload.scoreValue).toBe(
      COMPOSITE_BOSSES.hive_cruiser.scoreValue
    );

    boss.damageChassis(100, ctx);
    expect(ctx.of('boss:destroyed')).toHaveLength(1);
  });
});

describe('CompositeBoss — phases', () => {
  it('starts on the initial phase and fires only what it arms', () => {
    const boss = makeBoss();
    const ctx = makeCtx({ x: 600, y: 0 });

    tick(boss, ctx, 12);
    const fired = new Set(ctx.of('boss:weapon_fire').map((e) => e.payload.weaponId));

    expect(boss.phaseNumber).toBe(1);
    expect(fired.has('port_gun')).toBe(true);
    expect(fired.has('starboard_gun')).toBe(true);
    // The reactor ring is a phase-2 weapon and must stay silent at full HP.
    expect(fired.has('core_burst')).toBe(false);
  });

  it('arms the next phase when HP crosses its threshold', () => {
    const boss = makeBoss();
    const ctx = makeCtx({ x: 600, y: 0 });

    // Take it just under 0.70 of total HP: both flank turrets off, then a bite
    // out of the hull they were protecting.
    wreckPart(boss, 'turret_port', ctx);
    wreckPart(boss, 'turret_starboard', ctx);
    boss.damageChassis(300, ctx);
    expect(boss.hpFraction).toBeLessThan(0.7);
    expect(boss.hpFraction).toBeGreaterThan(0.35);

    boss.update(1 / 60, ctx);
    expect(boss.phaseNumber).toBe(2);
    expect(ctx.of('boss:phase')).toHaveLength(1);
    expect(ctx.of('boss:phase')[0].payload.phaseId).toBe('reactor_hot');

    tick(boss, ctx, 12);
    const fired = new Set(ctx.of('boss:weapon_fire').map((e) => e.payload.weaponId));
    expect(fired.has('core_burst')).toBe(true);
  });

  it('jumps straight to the phase the HP calls for, skipping intermediates', () => {
    const boss = makeBoss();
    const ctx = makeCtx({ x: 600, y: 0 });

    wreckPart(boss, 'turret_port', ctx);
    wreckPart(boss, 'turret_starboard', ctx);
    wreckPart(boss, 'reactor_core', ctx);
    boss.damageChassis(boss.chassisHp * 0.8, ctx);

    boss.update(1 / 60, ctx);
    expect(boss.phaseNumber).toBe(3);
    expect(ctx.of('boss:phase')).toHaveLength(1);
    expect(ctx.of('boss:phase')[0].payload.phase).toBe(3);
  });

  it('arms a partsDestroyed phase off structural damage alone', () => {
    const boss = makeBoss('spire_station');
    const ctx = makeCtx({ x: 600, y: 0 });

    expect(boss.phaseNumber).toBe(1);
    wreckPart(boss, 'pylon_a', ctx);
    boss.update(1 / 60, ctx);
    expect(boss.phase.id).toBe('breached');

    wreckPart(boss, 'pylon_b', ctx);
    boss.update(1 / 60, ctx);
    expect(boss.phase.id).toBe('venting');
  });

  it('never steps a phase backwards', () => {
    const boss = makeBoss('spire_station');
    const ctx = makeCtx({ x: 600, y: 0 });

    wreckPart(boss, 'pylon_a', ctx);
    wreckPart(boss, 'pylon_b', ctx);
    boss.update(1 / 60, ctx);
    const reached = boss.phaseIndex;

    // Even if a trigger stopped being satisfied, the phase holds.
    boss.getPart('pylon_a').alive = true;
    boss.update(1 / 60, ctx);
    expect(boss.phaseIndex).toBe(reached);
  });

  it('speeds every surviving gun up as phases escalate', () => {
    const count = (templateSetup) => {
      const boss = makeBoss('spire_station');
      const ctx = makeCtx({ x: 600, y: 0 });
      templateSetup(boss, ctx);
      const before = ctx.of('boss:weapon_fire').length;
      tick(boss, ctx, 10);
      return ctx.of('boss:weapon_fire').length - before;
    };

    const calm = count(() => {});
    const angry = count((boss, ctx) => {
      wreckPart(boss, 'pylon_a', ctx);
      boss.update(1 / 60, ctx);
    });

    // Two guns firing 1.4x beats three guns at 1x by less than the gun it lost,
    // so compare rate per gun rather than raw volume.
    expect(angry / 2).toBeGreaterThan(calm / 3);
  });
});

describe('CompositeBoss — weapons', () => {
  it('aims turrets at the target and fires down the barrel it points', () => {
    const boss = makeBoss('hive_cruiser', { x: 0, y: 0 });
    const ctx = makeCtx({ x: 1000, y: 0 });

    tick(boss, ctx, 6);
    const shot = ctx.bullets[0];
    expect(shot).toBeDefined();
    // Every round goes broadly downrange toward the target.
    expect(shot.vx).toBeGreaterThan(0);
    for (const bullet of ctx.bullets) expect(bullet.damage).toBeGreaterThan(0);
  });

  it('silences a wrecked part gun even while its phase still names it', () => {
    const boss = makeBoss();
    const ctx = makeCtx({ x: 600, y: 0 });

    wreckPart(boss, 'turret_port', ctx);
    tick(boss, ctx, 12);

    const fired = ctx.of('boss:weapon_fire').map((e) => e.payload.weaponId);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired).not.toContain('port_gun');
    expect(boss.phase.weapons).toContain('port_gun');
  });

  it('staggers the opening salvo instead of firing everything on frame one', () => {
    const boss = makeBoss();
    const ctx = makeCtx({ x: 600, y: 0 });

    boss.update(1 / 60, ctx);
    expect(ctx.bullets).toHaveLength(0);
  });

  it('fires a radial ring with the authored round count', () => {
    const boss = makeBoss();
    const ctx = makeCtx({ x: 600, y: 0 });
    const burst = getBossTemplate('hive_cruiser').parts.find((p) => p.id === 'reactor_core')
      .weapon;

    // Drop it into the phase that arms the ring, silencing the flank guns on the
    // way so only the ring's rounds land in the collector.
    wreckPart(boss, 'turret_port', ctx);
    wreckPart(boss, 'turret_starboard', ctx);
    boss.damageChassis(300, ctx);
    boss.update(1 / 60, ctx);
    expect(boss.phaseNumber).toBe(2);
    ctx.bullets.length = 0;

    tick(boss, ctx, burst.fireInterval + 0.2);
    expect(ctx.bullets.length % burst.count).toBe(0);
    expect(ctx.bullets.length).toBeGreaterThanOrEqual(burst.count);
    expect(ctx.bullets[0].bulletType).toBe(burst.bulletType);
  });
});

describe('CompositeBoss — movement', () => {
  it('closes on the target at the authored chassis speed, scaled by its phase', () => {
    const boss = makeBoss('hive_cruiser', { x: 0, y: 0 });
    const ctx = makeCtx({ x: 2000, y: 0 });
    const template = getBossTemplate('hive_cruiser');
    // The opening phase itself carries a speedScale (1.1), so the travelled
    // distance is the chassis speed times the active phase's own multiplier,
    // not the bare authored figure.
    const speed = template.chassis.speed * template.phases[0].speedScale;

    tick(boss, ctx, 1);
    expect(boss.x).toBeCloseTo(speed, 0);
  });

  it('holds station when the template says speed 0', () => {
    const boss = makeBoss('spire_station', { x: 100, y: 100 });
    const ctx = makeCtx({ x: 2000, y: 0 });

    tick(boss, ctx, 3);
    expect(boss.x).toBe(100);
    expect(boss.y).toBe(100);
    // Still turning, though: a stationary boss that is also rigid looks dead.
    expect(boss.rotation).toBeGreaterThan(0);
  });

  it('slows when a wrecked part says it should', () => {
    const ctx = makeCtx({ x: 4000, y: 0 });
    const intact = makeBoss('hive_cruiser', { x: 0, y: 0 });
    tick(intact, ctx, 2);

    const wrecked = makeBoss('hive_cruiser', { x: 0, y: 0 });
    wreckPart(wrecked, 'reactor_core', ctx);
    tick(wrecked, ctx, 2);

    expect(wrecked.x).toBeLessThan(intact.x);
  });
});

describe('CompositeBoss — the enrage latch', () => {
  it('wakes the chassis the moment its armour parts are all wrecked', () => {
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1400, y: 1000 });

    wreckPart(boss, 'turret_port', ctx);
    boss.update(1 / 60, ctx);
    // ONE turret is not the trigger. Half the armour off is still armour on,
    // and a boss that enraged here would punish the player mid-job.
    expect(boss.isEnraged).toBe(false);
    expect(boss.isArmorStripped()).toBe(false);

    wreckPart(boss, 'turret_starboard', ctx);
    expect(boss.isArmorStripped()).toBe(true);
    boss.update(1 / 60, ctx);
    expect(boss.isEnraged).toBe(true);
  });

  it('enrages on the same frame the chassis becomes shootable', () => {
    // The trade has to be legible: the reward for stripping the armour is a
    // target, and the price is a live boss. Two different frames would let the
    // player learn one without the other.
    const boss = makeBoss('hive_cruiser');
    const ctx = makeCtx({ x: 400, y: 0 });
    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);

    expect(boss.isChassisVulnerable()).toBe(true);
    expect(boss.isEnraged).toBe(true);
  });

  it('keeps every point of damage the player already did', () => {
    const boss = makeBoss('hive_cruiser');
    const ctx = makeCtx({ x: 400, y: 0 });
    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);
    boss.damageChassis(500, ctx);
    const before = boss.chassisHp;

    tick(boss, ctx, 3);
    // Nothing in the enrage path touches HP. A threshold that healed would make
    // stripping the armour a mistake, which is the opposite of the lesson.
    expect(boss.chassisHp).toBe(before);
    expect(boss.chassisHp).toBeLessThan(boss.chassisMaxHp);
  });

  it('latches: an enraged chassis never calms down', () => {
    const boss = makeBoss('spire_station');
    const ctx = makeCtx({ x: 300, y: 0 });
    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);
    expect(boss.isEnraged).toBe(true);

    for (let i = 0; i < 600; i++) {
      boss.update(1 / 60, ctx);
      expect(boss.isEnraged).toBe(true);
    }
  });

  it('announces the enrage once, with the HP the hull woke up with', () => {
    const boss = makeBoss('hive_cruiser');
    const ctx = makeCtx({ x: 400, y: 0 });
    stripArmor(boss, ctx);
    tick(boss, ctx, 4);

    const roars = ctx.of('boss:enraged');
    expect(roars).toHaveLength(1);
    expect(roars[0].payload.hp).toBe(boss.chassisMaxHp);
    // The reactor is NOT in armoredBy, so it is still standing and still
    // firing. That is the interesting version of the fight.
    expect(roars[0].payload.partsLeft).toBe(1);
  });

  it('wakes up with the reactor still live, so its ring keeps firing', () => {
    const boss = makeBoss('hive_cruiser');
    const ctx = makeCtx({ x: 400, y: 0 });
    stripArmor(boss, ctx);
    // Drop it into the phase that arms core_burst.
    boss.damageChassis(boss.chassisHp * 0.8, ctx);
    tick(boss, ctx, 4);

    expect(boss.isEnraged).toBe(true);
    expect(boss.getPart('reactor_core').alive).toBe(true);
    const fires = ctx.of('boss:weapon_fire').map((e) => e.payload.weaponId);
    expect(fires).toContain('core_burst');
  });

  it('takes an every-part reading too, for a chassis with no named armour', () => {
    // A template with an empty armoredBy has no armour to strip, so
    // isArmorStripped() must stay false forever — otherwise the boss would
    // spawn already enraged off a vacuous truth.
    const bare = {
      ...getBossTemplate('hive_cruiser'),
      chassis: { ...getBossTemplate('hive_cruiser').chassis, armoredBy: [] },
    };
    const boss = new CompositeBoss(bare, { id: 9, rng: mulberry32(2) });
    const ctx = makeCtx({ x: 400, y: 0 });

    boss.update(1 / 60, ctx);
    expect(boss.isArmorStripped()).toBe(false);
    expect(boss.isEnraged).toBe(false);

    for (const part of boss.parts) wreckPart(boss, part.id, ctx);
    boss.update(1 / 60, ctx);
    expect(boss.isEnraged).toBe(true);
  });

  it('swaps in the enraged statline, absolute rather than scaled', () => {
    const boss = makeBoss('hive_cruiser', { x: 0, y: 0 });
    const ctx = makeCtx({ x: 2000, y: 0 });
    const enrage = getBossTemplate('hive_cruiser').chassis.enrage;

    // Wreck the reactor FIRST, so its 0.6 speed penalty is on the books before
    // the enrage lands. The enraged speed must ignore it: the player's own
    // progress must not defuse the thing their progress created.
    wreckPart(boss, 'reactor_core', ctx);
    expect(boss.wreckSpeedScale).toBeCloseTo(0.6, 6);

    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);
    expect(boss.contactDamage).toBe(enrage.contactDamage);

    const x0 = boss.x;
    boss.update(1 / 60, ctx);
    const speed = (boss.x - x0) * 60;
    expect(speed).toBeCloseTo(enrage.speed, 0);
  });
});

describe('CompositeBoss — the Hive Cruiser charge cycle', () => {
  /** An enraged cruiser, parked with the target due east. */
  function enragedCruiser(target = { x: 1600, y: 1000 }) {
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx(target);
    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);
    return { boss, ctx };
  }

  it('runs the four beats in order, on the authored clocks', () => {
    const { boss, ctx } = enragedCruiser();
    const charge = getBossTemplate('hive_cruiser').chassis.enrage.chargeAttack;

    expect(boss.chargeState).toBe(CHARGE_STATE.IDLE_DRIFT);

    const toTelegraph = tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);
    expect(toTelegraph).toBeGreaterThan(0);

    const toCharge = tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.CHARGING);
    expect(toCharge).toBeCloseTo(charge.telegraphDuration, 1);

    const toRecovery = tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.RECOVERY);
    expect(toRecovery).toBeCloseTo(charge.chargeDuration, 1);

    const toIdle = tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.IDLE_DRIFT);
    expect(toIdle).toBeCloseTo(charge.recoveryDuration, 1);
  });

  it('waits out the cooldown between charges rather than chaining them', () => {
    const { boss, ctx } = enragedCruiser();
    const charge = getBossTemplate('hive_cruiser').chassis.enrage.chargeAttack;

    // Ride out one whole cycle first: the boss starts the enrage ALREADY in
    // idle on a shortened opening beat, so measuring from there would time the
    // opener rather than the cooldown.
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.IDLE_DRIFT);

    const gap = tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH, 15);
    expect(gap).toBeCloseTo(charge.cooldown, 0);
  });

  it('freezes the hull for the whole telegraph, so the stillness is the warning', () => {
    const { boss, ctx } = enragedCruiser();
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);

    const x0 = boss.x;
    const y0 = boss.y;
    while (boss.chargeState === CHARGE_STATE.TELEGRAPH) {
      boss.update(1 / 60, ctx);
      if (boss.chargeState !== CHARGE_STATE.TELEGRAPH) break;
      expect(boss.vx).toBe(0);
      expect(boss.vy).toBe(0);
    }
    expect(boss.x).toBeCloseTo(x0, 6);
    expect(boss.y).toBeCloseTo(y0, 6);
  });

  it('locks the vector at the telegraph and flies THAT, not the new position', () => {
    /*
     * THE CONTRACT. If the charge re-aimed during its wind-up it would be an
     * unavoidable hit wearing a telegraph's clothes, and the 1.2s warning would
     * be worth nothing. The target is moved a long way mid-telegraph; the boss
     * must still commit to where the beam was pointing.
     */
    const target = { x: 1600, y: 1000 };
    const { boss, ctx } = enragedCruiser(target);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);

    const lockedX = boss.chargeDirX;
    const lockedY = boss.chargeDirY;
    expect(lockedX).toBeCloseTo(1, 3);
    expect(lockedY).toBeCloseTo(0, 3);

    // Teleport the player due north, mid-wind-up.
    target.x = 1000;
    target.y = 200;
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.CHARGING);

    expect(boss.chargeDirX).toBeCloseTo(lockedX, 6);
    expect(boss.chargeDirY).toBeCloseTo(lockedY, 6);

    const y0 = boss.y;
    const x0 = boss.x;
    tick(boss, ctx, 0.5);
    // Still going east, which is where the warning pointed.
    expect(boss.x - x0).toBeGreaterThan(100);
    expect(Math.abs(boss.y - y0)).toBeLessThan
      (1e-6);
  });

  it('commits at chargeSpeed, not at drift speed', () => {
    const { boss, ctx } = enragedCruiser();
    const charge = getBossTemplate('hive_cruiser').chassis.enrage.chargeAttack;
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.CHARGING);

    const x0 = boss.x;
    boss.update(1 / 60, ctx);
    expect((boss.x - x0) * 60).toBeCloseTo(charge.chargeSpeed, 0);
    expect(charge.chargeSpeed).toBeGreaterThan(
      getBossTemplate('hive_cruiser').chassis.enrage.speed
    );
  });

  it('decelerates through the recovery, so a dodge buys a punish window', () => {
    const { boss, ctx } = enragedCruiser();
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.RECOVERY);

    const speeds = [];
    while (boss.chargeState === CHARGE_STATE.RECOVERY) {
      boss.update(1 / 60, ctx);
      speeds.push(Math.hypot(boss.vx, boss.vy));
    }
    // Monotonically down to (nearly) nothing.
    expect(speeds[0]).toBeGreaterThan(speeds[speeds.length - 1]);
    expect(speeds[speeds.length - 1]).toBeLessThan(speeds[0] * 0.25);
  });

  it('holds its locked heading through the recovery instead of re-acquiring', () => {
    const target = { x: 1600, y: 1000 };
    const { boss, ctx } = enragedCruiser(target);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.RECOVERY);

    // Player slips behind it. The coast must not turn around — the window the
    // telegraph promised is the whole reason reading it pays.
    target.x = 200;
    const y0 = boss.y;
    const x0 = boss.x;
    boss.update(1 / 60, ctx);
    expect(boss.x).toBeGreaterThan(x0);
    expect(boss.y).toBeCloseTo(y0, 6);
  });

  it('drops its burning wake only while it is actually charging', () => {
    const { boss, ctx } = enragedCruiser();
    const wake = getChassisWeapons(getBossTemplate('hive_cruiser')).get('afterburner_wake');

    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);
    expect(ctx.hazards).toHaveLength(0);

    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.RECOVERY);
    const duringCharge = ctx.hazards.length;
    // One patch per `interval` across `chargeDuration`, give or take the frame
    // the state changed on.
    const expected = Math.round(
      getBossTemplate('hive_cruiser').chassis.enrage.chargeAttack.chargeDuration / wake.interval
    );
    expect(duringCharge).toBeGreaterThanOrEqual(expected - 1);
    expect(duringCharge).toBeLessThanOrEqual(expected + 1);

    // And nothing more once it is coasting: the wake is the charge's
    // after-image, not a second attack.
    tick(boss, ctx, 0.8);
    expect(ctx.hazards.length).toBe(duringCharge);
  });

  it('carries the authored hazard numbers and lands the patch behind the hull', () => {
    const { boss, ctx } = enragedCruiser();
    const wake = getChassisWeapons(getBossTemplate('hive_cruiser')).get('afterburner_wake');
    expect(wake.type).toBe(WEAPON_TYPES.TRAIL_HAZARD);

    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.CHARGING);
    boss.update(1 / 60, ctx);

    const patch = ctx.hazards[0];
    expect(patch.damagePerSec).toBe(wake.damage);
    expect(patch.life).toBe(wake.duration);
    expect(patch.radius).toBe(wake.radius);
    expect(patch.kind).toBe('afterburner');
    // Behind the bow by about a hull radius: dropping at the centre would put
    // the patch under the boss, where nobody can be standing anyway. "About",
    // because the hull travels another 6px in the frame that dropped it.
    const lag = boss.x - patch.x;
    expect(lag).toBeGreaterThan(boss.radius * 0.5);
    expect(lag).toBeLessThan(boss.radius * 2);
  });

  it('vents larvae on the enrage frame, then on its own cooldown', () => {
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1600, y: 1000 });
    const vent = getBossTemplate('hive_cruiser').chassis.enrage.ventMinions;

    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);
    // The hull cracking open IS the transition telegraph — it fires at zero
    // delay, before any of the slower beats have had time to land.
    expect(ctx.spawns).toHaveLength(vent.count);
    for (const spawn of ctx.spawns) {
      expect(spawn.archetypeId).toBe(vent.archetypeId);
      expect(Math.hypot(spawn.x - boss.x, spawn.y - boss.y)).toBeCloseTo(vent.spawnRadius, 0);
    }

    tick(boss, ctx, vent.cooldown + 0.2);
    expect(ctx.spawns.length).toBe(vent.count * 2);
  });

  it('spreads a full-circle vent evenly without doubling up a bearing', () => {
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1600, y: 1000 });
    const vent = getBossTemplate('hive_cruiser').chassis.enrage.ventMinions;
    expect(vent.spreadAngle).toBeCloseTo(Math.PI * 2, 6);

    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);

    const bearings = ctx.spawns.map((s) => Math.atan2(s.y - boss.y, s.x - boss.x));
    const unique = new Set(bearings.map((b) => b.toFixed(4)));
    // A full ring divides by count, not by count - 1: the last bearing must not
    // land on top of the first, or one larva of the four is wasted.
    expect(unique.size).toBe(vent.count);
    const gaps = bearings
      .slice(1)
      .map((b, i) => Math.abs(((b - bearings[i] + Math.PI * 3) % (Math.PI * 2)) - Math.PI));
    for (const gap of gaps) {
      expect(gap).toBeCloseTo((Math.PI * 2) / vent.count, 2);
    }
  });

  it('names an archetype that exists, so a vent is never a silent no-op', () => {
    // The task brief called for 'enemy_larva', which is a SPRITE key — the
    // archetype is 'larva_swarm'. A vent naming a key the spawner cannot
    // resolve would throw or silently drop four minions every six seconds.
    const vent = getBossTemplate('hive_cruiser').chassis.enrage.ventMinions;
    expect(ENEMY_ARCHETYPES[vent.archetypeId]).toBeTruthy();
  });

  it('survives a caller that supplies no hazard or spawn hooks', () => {
    // The boss owns no pool and no spawner; a caller that wires up neither
    // should still get a boss that charges and rams, not a crash.
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const bare = { target: { x: 1600, y: 1000 }, rng: mulberry32(1), fire: () => {} };
    stripArmor(boss, bare);
    expect(() => tick(boss, bare, 14)).not.toThrow();
    expect(boss.isEnraged).toBe(true);
  });
});

describe('CompositeBoss — the Chitin Spire singularity', () => {
  function enragedSpire(target = { x: 1200, y: 1000 }) {
    const boss = makeBoss('spire_station', { x: 1000, y: 1000 });
    const ctx = makeCtx(target);
    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);
    return { boss, ctx };
  }

  it('stays bolted to the floor: the spire collapses, it does not chase', () => {
    const { boss, ctx } = enragedSpire();
    const x0 = boss.x;
    const y0 = boss.y;
    tick(boss, ctx, 6);
    expect(boss.x).toBe(x0);
    expect(boss.y).toBe(y0);
    expect(boss.chargeState).toBe(CHARGE_STATE.IDLE_DRIFT);
  });

  it('is zero outside the radius and strongest at the core', () => {
    const well = getBossTemplate('spire_station').chassis.enrage.gravityWell;
    const { radius, pullForce } = well;

    // Outside: nothing at all, at the rim or beyond it.
    expect(gravityWellForce(radius, radius, pullForce)).toBe(0);
    expect(gravityWellForce(radius + 1, radius, pullForce)).toBe(0);
    expect(gravityWellForce(radius * 10, radius, pullForce)).toBe(0);

    // CONTINUOUS at the perimeter, approached from the inside. A force that
    // appeared at full strength the instant the player crossed a line would
    // snatch anyone skimming the edge.
    expect(gravityWellForce(radius - 0.001, radius, pullForce)).toBeCloseTo(0, 3);

    // And strongest where the boss is — the expensive ground is exactly the
    // ground the player has to reach to win.
    expect(gravityWellForce(0, radius, pullForce)).toBe(pullForce);
    expect(gravityWellForce(radius / 2, radius, pullForce)).toBeCloseTo(pullForce / 2, 6);

    // Monotonic the whole way in.
    let previous = 0;
    for (let d = radius; d >= 0; d -= radius / 20) {
      const force = gravityWellForce(d, radius, pullForce);
      expect(force).toBeGreaterThanOrEqual(previous);
      previous = force;
    }
  });

  it('pulls the target inward, and not at all from outside the well', () => {
    const well = getBossTemplate('spire_station').chassis.enrage.gravityWell;

    const inside = enragedSpire({ x: 1000 + well.radius * 0.4, y: 1000 });
    inside.boss.update(1 / 60, inside.ctx);
    // Target is due east of the core, so the pull must have a WEST component.
    expect(inside.boss.gravityPullX).toBeLessThan(0);
    expect(inside.ctx.impulses.length).toBeGreaterThan(0);

    const outside = enragedSpire({ x: 1000 + well.radius + 50, y: 1000 });
    outside.ctx.impulses.length = 0;
    tick(outside.boss, outside.ctx, 1);
    expect(outside.boss.gravityPullX).toBe(0);
    expect(outside.boss.gravityPullY).toBe(0);
    expect(outside.ctx.impulses).toHaveLength(0);
  });

  it('hands the pull out dt-scaled, as a velocity delta the player can fight', () => {
    const well = getBossTemplate('spire_station').chassis.enrage.gravityWell;
    const { boss, ctx } = enragedSpire({ x: 1000, y: 1000 });
    // Sitting on the core: maximum pull, and the radial part points nowhere, so
    // only the magnitude is worth asserting.
    ctx.impulses.length = 0;
    boss.update(1 / 60, ctx);

    const impulse = ctx.impulses[0];
    const magnitude = Math.hypot(impulse.dvx, impulse.dvy) * 60;
    const live = Math.hypot(boss.gravityPullX, boss.gravityPullY);
    expect(magnitude).toBeCloseTo(live, 4);
    // Under a base Drifter's own top speed: a current, not a tractor beam.
    expect(live).toBeLessThan(well.pullForce * 1.5);
  });

  it('adds a tangential component when the well spirals', () => {
    const well = getBossTemplate('spire_station').chassis.enrage.gravityWell;
    expect(well.inwardSpiral).toBe(true);

    const { boss } = enragedSpire({ x: 1000 + well.radius * 0.5, y: 1000 });
    boss.update(1 / 60, { target: { x: 1000 + well.radius * 0.5, y: 1000 }, rng: mulberry32(1) });
    // Purely radial would be straight west with zero Y. The swirl is what makes
    // the well something to fly out of rather than something to lean against.
    expect(Math.abs(boss.gravityPullY)).toBeGreaterThan(1);
  });

  it('fires the singularity ring with the authored round count', () => {
    const { boss, ctx } = enragedSpire();
    const pulse = getChassisWeapons(getBossTemplate('spire_station')).get('singularity_pulse');

    tickUntil(boss, ctx, () => ctx.bullets.length > 0, 6);
    expect(ctx.bullets.length).toBe(pulse.count);
    for (const bullet of ctx.bullets) {
      expect(bullet.damage).toBe(pulse.damage);
      expect(bullet.bulletType).toBe(pulse.bulletType);
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(pulse.speed, 4);
    }
  });

  it('walks the ring gap by spiralOffset each burst instead of rolling it', () => {
    const { boss, ctx } = enragedSpire();
    const pulse = getChassisWeapons(getBossTemplate('spire_station')).get('singularity_pulse');

    const gaps = [];
    for (let burst = 0; burst < 3; burst++) {
      ctx.bullets.length = 0;
      tickUntil(boss, ctx, () => ctx.bullets.length > 0, 6);
      gaps.push(Math.atan2(ctx.bullets[0].vy, ctx.bullets[0].vx));
    }

    /*
     * A learnable ring. The gap advances by a fixed step, so the player can see
     * where the next one will be — at a dozen bursts a random gap reads as
     * noise rather than as a puzzle.
     */
    for (let i = 1; i < gaps.length; i++) {
      const step = ((gaps[i] - gaps[i - 1]) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      expect(step).toBeCloseTo(pulse.spiralOffset, 4);
    }
  });

  it('credits the ring to the hull, not to a part that no longer exists', () => {
    const { boss, ctx } = enragedSpire();
    tickUntil(boss, ctx, () => ctx.bullets.length > 0, 6);

    const fire = ctx.of('boss:weapon_fire').find((e) => e.payload.weaponId === 'singularity_pulse');
    expect(fire).toBeTruthy();
    expect(fire.payload.partId).toBe(null);
    expect(fire.payload.innate).toBe(true);
  });

  it('warns before each shockwave, then releases an expanding ring', () => {
    const { boss, ctx } = enragedSpire();
    const wave = getBossTemplate('spire_station').chassis.enrage.shockwave;

    tickUntil(boss, ctx, (b) => b.shockwaves.length > 0, 6);
    const ring = boss.shockwaves[0];
    // Warning first, at zero radius: the ring cannot hit anybody yet.
    expect(ring.released).toBe(false);
    expect(ring.radius).toBe(0);
    expect(ctx.of('boss:shockwave_warn')).toHaveLength(1);

    tickUntil(boss, ctx, (b) => b.shockwaves[0]?.released, 3);
    expect(ctx.of('boss:shockwave')).toHaveLength(1);

    const r0 = boss.shockwaves[0].radius;
    boss.update(1 / 60, ctx);
    expect((boss.shockwaves[0].radius - r0) * 60).toBeCloseTo(wave.speed, 0);
  });

  it('hits a target the band sweeps over, exactly once', () => {
    const wave = getBossTemplate('spire_station').chassis.enrage.shockwave;
    const { boss, ctx } = enragedSpire({ x: 1000 + 250, y: 1000 });

    tickUntil(boss, ctx, () => ctx.hurts.length > 0, 8);
    expect(ctx.hurts[0]).toBe(wave.damage);

    // The band is 46px at 340 px/s — eight frames of overlap. Without the
    // once-only latch that is eight 28-damage hits for one ring.
    const after = ctx.hurts.length;
    tick(boss, ctx, 0.4);
    expect(ctx.hurts.length).toBe(after);
  });

  it('retires a ring at maxRadius instead of growing one forever', () => {
    const wave = getBossTemplate('spire_station').chassis.enrage.shockwave;
    const { boss, ctx } = enragedSpire({ x: 4000, y: 4000 });

    tick(boss, ctx, 30);
    for (const ring of boss.shockwaves) {
      expect(ring.radius).toBeLessThan(wave.maxRadius);
    }
    // And the list does not accumulate: one interval's worth in flight, not
    // seven rings' worth of geometry after half a minute.
    expect(boss.shockwaves.length).toBeLessThanOrEqual(3);
  });

  it('spares a target with no hurt hook rather than throwing at it', () => {
    const boss = makeBoss('spire_station', { x: 1000, y: 1000 });
    const bare = { target: { x: 1250, y: 1000 }, rng: mulberry32(1), fire: () => {} };
    stripArmor(boss, bare);
    expect(() => tick(boss, bare, 12)).not.toThrow();
  });
});

describe('CompositeBoss — the render state carries the enrage', () => {
  it('reports the telegraph off the SAME vector the charge will fly', () => {
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1600, y: 1000 });
    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);

    const state = boss.getRenderState();
    expect(state.enraged).toBe(true);
    expect(state.chargeState).toBe(CHARGE_STATE.TELEGRAPH);
    /*
     * ONE copy of the direction. The beam the renderer paints and the vector the
     * hull commits to are the same two numbers, so a lunge with no warning — or
     * a warning pointing somewhere the boss is not going — has nowhere to live.
     */
    expect(state.chargeTelegraph.dirX).toBe(boss.chargeDirX);
    expect(state.chargeTelegraph.dirY).toBe(boss.chargeDirY);
    expect(state.chargeTelegraph.progress).toBeGreaterThanOrEqual(0);
    expect(state.chargeTelegraph.progress).toBeLessThanOrEqual(1);
  });

  it('runs the telegraph progress from 0 to 1 across the window', () => {
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1600, y: 1000 });
    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);

    const first = boss.getRenderState().chargeTelegraph.progress;
    let last = first;
    while (boss.chargeState === CHARGE_STATE.TELEGRAPH) {
      boss.update(1 / 60, ctx);
      const state = boss.getRenderState();
      if (!state.chargeTelegraph) break;
      expect(state.chargeTelegraph.progress).toBeGreaterThanOrEqual(last);
      last = state.chargeTelegraph.progress;
    }
    expect(first).toBeLessThan(0.1);
    expect(last).toBeGreaterThan(0.9);
  });

  it('leaves the telegraph null outside the window, so no beam can linger', () => {
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1600, y: 1000 });
    expect(boss.getRenderState().chargeTelegraph).toBe(null);

    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.CHARGING);
    expect(boss.getRenderState().chargeTelegraph).toBe(null);
    expect(boss.getRenderState().charging).toBe(true);
  });

  it('ramps the thruster load off real velocity, not off the charge state', () => {
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 2600, y: 1000 });
    expect(boss.getRenderState().thrust).toBe(0);

    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.CHARGING);
    boss.update(1 / 60, ctx);
    expect(boss.getRenderState().thrust).toBeCloseTo(1, 2);

    // Bleeding off through the coast rather than snapping to zero: a flare that
    // cut out while the hull was still visibly moving would read as a death.
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.RECOVERY);
    tick(boss, ctx, 0.45);
    const mid = boss.getRenderState().thrust;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('spools the thruster through the telegraph, while the hull is still', () => {
    /*
     * The telegraph window is the one time velocity says nothing: the hull is
     * deliberately frozen. A flare driven only off speed would stay dark for
     * the entire wind-up and waste the best part of the warning — a boss
     * visibly revving says "soon" even to a player looking at their own ship.
     */
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1600, y: 1000 });
    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);

    const opening = boss.getRenderState().thrust;
    expect(boss.vx).toBe(0);
    expect(opening).toBeLessThan(0.2);

    let last = opening;
    while (boss.chargeState === CHARGE_STATE.TELEGRAPH) {
      boss.update(1 / 60, ctx);
      if (boss.chargeState !== CHARGE_STATE.TELEGRAPH) break;
      const load = boss.getRenderState().thrust;
      expect(load).toBeGreaterThanOrEqual(last);
      last = load;
    }
    expect(last).toBeGreaterThan(0.9);
  });

  it('carries each shockwave ring its own reach, so the warning cannot lie', () => {
    const wave = getBossTemplate('spire_station').chassis.enrage.shockwave;
    const boss = makeBoss('spire_station', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1150, y: 1000 });
    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.shockwaves.length > 0, 6);

    // The warning circle is drawn at THIS radius while the ring is held, so it
    // has to be the radius the wave will actually sweep — a warning at any
    // other size tells the player the wrong ground is safe.
    expect(boss.getRenderState().shockwaves[0].maxRadius).toBe(wave.maxRadius);
  });

  it('reports the well and its live rings for the spire', () => {
    const well = getBossTemplate('spire_station').chassis.enrage.gravityWell;
    const boss = makeBoss('spire_station', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1150, y: 1000 });
    expect(boss.getRenderState().gravityWell).toBe(null);

    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.shockwaves.length > 0, 6);

    const state = boss.getRenderState();
    expect(state.gravityWell.radius).toBe(well.radius);
    expect(state.gravityWell.pull).toBeGreaterThan(0);
    expect(state.shockwaves).toHaveLength(1);
    expect(state.shockwaves[0].warnProgress).toBeGreaterThanOrEqual(0);
  });

  it('hands the renderer a copy of the ring list, not the live array', () => {
    // The simulation splices rings out of this list mid-frame; a renderer
    // holding the same array would be iterating it while it shrank.
    const boss = makeBoss('spire_station', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1150, y: 1000 });
    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.shockwaves.length > 0, 6);

    const state = boss.getRenderState();
    expect(state.shockwaves).not.toBe(boss.shockwaves);
    expect(state.shockwaves[0]).not.toBe(boss.shockwaves[0]);
  });
});

describe('CompositeBossRenderer — the enraged core', () => {
  const makeRenderer = () => new CompositeBossRenderer({ layer: new Container() });

  it('paints the telegraph beam only while the boss is telegraphing', () => {
    const renderer = makeRenderer();
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1600, y: 1000 });

    renderer.sync(boss.getRenderState(), 1 / 60);
    const view = renderer.views.get(boss.id);
    expect(view.telegraphGfx.bounds.maxX).toBeLessThanOrEqual(0);

    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.TELEGRAPH);
    renderer.sync(boss.getRenderState(), 1 / 60);
    // The beam is 500px long, so it cannot hide inside a 74px hull.
    expect(view.telegraphGfx.bounds.maxX).toBeGreaterThan(300);

    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.RECOVERY);
    renderer.sync(boss.getRenderState(), 1 / 60);
    expect(view.telegraphGfx.bounds.maxX).toBeLessThanOrEqual(0);
  });

  it('keeps the fx tree unrotated so a world-bearing beam does not windmill', () => {
    const renderer = makeRenderer();
    const boss = makeBoss('hive_cruiser', { x: 1234, y: 567 });
    boss.rotation = 1.1;
    renderer.sync(boss.getRenderState(), 1 / 60);

    const view = renderer.views.get(boss.id);
    expect(view.root.rotation).toBeCloseTo(1.1, 6);
    // Same origin, zero rotation. This is what buys the beam, the well rings
    // and the shockwaves their freedom from per-frame derotation.
    expect(view.fx.rotation).toBe(0);
    expect(view.fx.x).toBe(1234);
    expect(view.fx.y).toBe(567);
  });

  it('lights the thruster on an enraged charge and leaves it dark otherwise', () => {
    const renderer = makeRenderer();
    const boss = makeBoss('hive_cruiser', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 2600, y: 1000 });

    renderer.sync(boss.getRenderState(), 1 / 60);
    const view = renderer.views.get(boss.id);
    expect(view.thruster.alpha).toBe(0);

    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.chargeState === CHARGE_STATE.CHARGING);
    boss.update(1 / 60, ctx);
    renderer.sync(boss.getRenderState(), 1 / 60);
    expect(view.thruster.alpha).toBeGreaterThan(0.5);
    expect(view.thruster.scale.y).toBeGreaterThan(2);
  });

  it('opens a smoking breach in every wrecked socket', () => {
    const renderer = makeRenderer();
    const boss = makeBoss('hive_cruiser');
    const ctx = makeCtx({ x: 400, y: 0 });

    renderer.sync(boss.getRenderState(), 1 / 60);
    const view = renderer.views.get(boss.id);
    expect(view.parts.get('turret_port').vent.visible).toBe(false);

    wreckPart(boss, 'turret_port', ctx);
    renderer.sync(boss.getRenderState(), 1 / 60);
    expect(view.parts.get('turret_port').vent.visible).toBe(true);
    // The wreck stays too: the breach is a hole in the ship, not a replacement
    // for the debris bolted over it.
    expect(view.parts.get('turret_port').wreck.visible).toBe(true);
    expect(view.parts.get('turret_starboard').vent.visible).toBe(false);
  });

  it('washes the hull to running-hot over the flare, not in one frame', () => {
    const renderer = makeRenderer();
    const boss = makeBoss('hive_cruiser');
    const ctx = makeCtx({ x: 400, y: 0 });
    renderer.sync(boss.getRenderState(), 1 / 60);
    expect(renderer.views.get(boss.id).chassis.tint).toBe(BOSS_VIEW.hullTint);

    stripArmor(boss, ctx);
    boss.update(1 / 60, ctx);
    renderer.sync(boss.getRenderState(), 1 / 60);
    const view = renderer.views.get(boss.id);
    const opening = view.chassis.tint;
    expect(opening).not.toBe(BOSS_VIEW.hullTint);
    expect(opening).not.toBe(BOSS_VIEW.enragedHullTint);

    // Settled, once the flare has run.
    for (let i = 0; i < 90; i++) renderer.sync(boss.getRenderState(), 1 / 60);
    expect(view.chassis.tint).toBe(BOSS_VIEW.enragedHullTint);
  });

  it('draws the well and its rings for an enraged spire', () => {
    const renderer = makeRenderer();
    const boss = makeBoss('spire_station', { x: 1000, y: 1000 });
    const ctx = makeCtx({ x: 1150, y: 1000 });

    renderer.sync(boss.getRenderState(), 1 / 60);
    const view = renderer.views.get(boss.id);
    expect(view.wellGfx.bounds.maxX).toBeLessThanOrEqual(0);

    stripArmor(boss, ctx);
    tickUntil(boss, ctx, (b) => b.shockwaves.length > 0, 6);
    renderer.sync(boss.getRenderState(), 1 / 60);

    const well = getBossTemplate('spire_station').chassis.enrage.gravityWell;
    // The boundary ring is drawn at the full authored reach, so the player can
    // see where the pull starts.
    expect(view.wellGfx.bounds.maxX).toBeGreaterThanOrEqual(well.radius - 1);
    expect(view.waveGfx.bounds.maxX).toBeGreaterThan(0);
  });
});

describe('CompositeBoss — the enrage in the simulation', () => {
  function enragedRun(templateId) {
    const sim = new Simulation({ seed: 31, useCompositeBosses: true });
    sim.state.startRun();
    sim.state.wave = templateId === 'spire_station' ? 10 : 5;
    const boss = sim.spawnCompositeBoss(templateId, { x: 1600, y: 1100 });
    sim.state.player.x = 1600 + 200;
    sim.state.player.y = 1100;
    for (const partId of boss.template.chassis.armoredBy) {
      const part = boss.getPart(partId);
      while (part.alive) boss.damagePart(partId, 500, sim.behaviorCtx);
    }
    return { sim, boss };
  }

  it('lands vented larvae in the enemy list as real, wave-scaled enemies', () => {
    const { sim, boss } = enragedRun('hive_cruiser');
    const before = sim.enemies.filter((e) => e.alive).length;

    sim.updateCompositeBosses(1 / 60);
    expect(boss.isEnraged).toBe(true);

    const larvae = sim.enemies.filter((e) => e.alive && e.archetypeId === 'larva_swarm');
    expect(larvae.length).toBe(
      before + getBossTemplate('hive_cruiser').chassis.enrage.ventMinions.count
    );
    // Through the same spawnArchetype path as any other roster enemy, so they
    // are HP-scaled, pooled and animated exactly like wave chaff.
    for (const larva of larvae) {
      expect(larva.hp).toBeGreaterThan(0);
      expect(larva.radius).toBeGreaterThan(0);
    }
  });

  it('declines a vent once the arena is at its enemy budget', () => {
    /*
     * A stalled fight is the failure case. The cruiser vents four larvae every
     * six seconds for as long as it lives and has no idea how long that is, so
     * a player kiting a 2,800 HP hull would otherwise accumulate minions past
     * the size the enemy pool was built for. The boss still asks on schedule;
     * the arena is what says no.
     */
    const { sim, boss } = enragedRun('hive_cruiser');
    for (let i = 0; i < WAVE_CONSTANTS.MAX_ACTIVE_ENEMIES; i++) {
      sim.spawnArchetype('larva_swarm', { x: 100 + i, y: 100 });
    }
    const full = sim.enemies.filter((e) => e.alive).length;
    expect(full).toBeGreaterThanOrEqual(WAVE_CONSTANTS.MAX_ACTIVE_ENEMIES);

    sim.updateCompositeBosses(1 / 60);
    expect(boss.isEnraged).toBe(true);
    expect(sim.enemies.filter((e) => e.alive).length).toBe(full);

    // And it resumes the moment there is room, rather than staying disabled.
    for (let i = 0; i < 20; i++) sim.enemies[i].alive = false;
    const room = sim.enemies.filter((e) => e.alive).length;
    for (let i = 0; i < 60 * 7; i++) sim.updateCompositeBosses(1 / 60);
    expect(sim.enemies.filter((e) => e.alive).length).toBeGreaterThan(room);
  });

  it('lands the burning wake in the hazard list, tagged so it paints as flame', () => {
    const { sim, boss } = enragedRun('hive_cruiser');
    for (let i = 0; i < 60 * 6; i++) sim.updateCompositeBosses(1 / 60);

    const wake = sim.sporePools.filter((h) => h.kind === 'afterburner');
    expect(wake.length).toBeGreaterThan(0);
    expect(wake[0].damagePerSec).toBe(12);
    expect(wake[0].sourceId).toBe(boss.id);
    // One list, one resolver: an afterburner patch and a spore bloom are the
    // same object to the player, and `kind` is the only thing they differ by.
    expect(sim.sporePools.some((h) => h.kind === 'spore')).toBe(false);
  });

  it('burns the player standing in the wake, and lets it expire', () => {
    const { sim } = enragedRun('hive_cruiser');
    const player = sim.state.player;
    const hazard = sim.spawnHazard({
      x: player.x,
      y: player.y,
      radius: 38,
      life: 0.5,
      damagePerSec: 12,
      kind: 'afterburner',
    });

    const hp = player.hp;
    sim.updateSporePools(1 / 60);
    expect(player.hp).toBeLessThan(hp);

    for (let i = 0; i < 60; i++) sim.updateSporePools(1 / 60);
    expect(hazard.alive).toBe(false);
  });

  it('drags the player toward the spire through their own momentum channel', () => {
    const { sim } = enragedRun('spire_station');
    sim.playerVx = 0;
    sim.playerVy = 0;

    sim.updateCompositeBosses(1 / 60);
    // Player is EAST of the core, so the pull must show up as westward
    // momentum — written into playerVx, where thrust and drag can fight it.
    expect(sim.playerVx).toBeLessThan(0);
  });

  it('leaves the player able to out-fly the pull rather than being towed', () => {
    const { sim } = enragedRun('spire_station');
    const startX = sim.state.player.x;

    // Holding "east", straight out of the well.
    for (let i = 0; i < 120; i++) {
      sim.updatePlayer(1 / 60, { x: 1, y: 0 });
      sim.updateCompositeBosses(1 / 60);
    }
    expect(sim.state.player.x).toBeGreaterThan(startX);
  });

  it('keeps a charging chassis inside the arena', () => {
    const sim = new Simulation({ seed: 7, useCompositeBosses: true });
    sim.state.startRun();
    sim.state.wave = 5;
    // Parked hard against the east wall, with the player past it, so the charge
    // vector points straight out of the world.
    const boss = sim.spawnCompositeBoss('hive_cruiser', { x: 3100, y: 1000 });
    sim.state.player.x = 3235;
    sim.state.player.y = 1200;
    for (const partId of boss.template.chassis.armoredBy) {
      const part = boss.getPart(partId);
      while (part.alive) boss.damagePart(partId, 500, sim.behaviorCtx);
    }

    for (let i = 0; i < 60 * 10; i++) {
      sim.updateCompositeBosses(1 / 60);
      expect(boss.x).toBeLessThanOrEqual(WORLD.WIDTH - boss.radius);
      expect(boss.y).toBeGreaterThanOrEqual(boss.radius);
    }
    // And its parts came with it, rather than being left behind in the void.
    for (const part of boss.parts) {
      expect(Math.hypot(part.worldX - boss.x, part.worldY - boss.y)).toBeLessThan(200);
    }
  });

  it('stays killable while enraged, and still ends the boss wave', () => {
    const { sim, boss } = enragedRun('hive_cruiser');
    sim.updateCompositeBosses(1 / 60);
    expect(boss.isEnraged).toBe(true);

    // The enrage is a state, not an invulnerability phase: the chassis is
    // exposed, so the whole point is that it can now be shot.
    boss.damageChassis(boss.chassisHp, sim.behaviorCtx);
    expect(boss.alive).toBe(false);

    sim.updateCompositeBosses(1 / 60);
    expect(sim.compositeBosses).toHaveLength(0);
  });
});

describe('CompositeBoss — render state', () => {
  it('reports everything the renderer needs and nothing it must reach in for', () => {
    const boss = makeBoss('hive_cruiser', { x: 40, y: 60 });
    const ctx = makeCtx({ x: 600, y: 0 });
    tick(boss, ctx, 1);

    const state = boss.getRenderState();
    expect(state.id).toBe(boss.id);
    expect(state.templateId).toBe('hive_cruiser');
    expect(state.rotation).toBeCloseTo(boss.rotation, 9);
    expect(state.chassisVulnerable).toBe(false);
    expect(state.parts).toHaveLength(boss.parts.length);

    const port = state.parts.find((p) => p.id === 'turret_port');
    expect(port.hpFraction).toBe(1);
    expect(port.alive).toBe(true);
    expect(port.x).toBeCloseTo(boss.getPart('turret_port').worldX, 9);
  });

  it('reports a wrecked part at zero and the hull as exposed', () => {
    const boss = makeBoss();
    const ctx = makeCtx();
    wreckPart(boss, 'turret_port', ctx);
    wreckPart(boss, 'turret_starboard', ctx);

    const state = boss.getRenderState();
    expect(state.chassisVulnerable).toBe(true);
    expect(state.parts.find((p) => p.id === 'turret_port').hpFraction).toBe(0);
    expect(state.parts.find((p) => p.id === 'turret_port').alive).toBe(false);
  });

  it('binds every authored sprite key to a loadable texture key', () => {
    for (const template of Object.values(COMPOSITE_BOSSES)) {
      expect(BOSS_TEXTURE_KEY[template.chassis.spriteKey]).toBeDefined();
      for (const part of template.parts) {
        expect(BOSS_TEXTURE_KEY[part.spriteKey]).toBeDefined();
        if (part.wreckSpriteKey) expect(BOSS_TEXTURE_KEY[part.wreckSpriteKey]).toBeDefined();
      }
    }
    // The armour glint has to be visible or the immunity is unreadable.
    expect(BOSS_VIEW.armoredAlpha).toBeGreaterThan(0);
  });
});

describe('CompositeBoss in the simulation', () => {
  it('spawns onto its own list and announces itself as composite', () => {
    const sim = new Simulation({ seed: 8 });
    sim.startRun();

    const seen = [];
    sim.bus.on('boss:spawned', (payload) => seen.push(payload));
    const boss = sim.spawnCompositeBoss('hive_cruiser', { x: 800, y: 800 });

    expect(boss).toBeInstanceOf(CompositeBoss);
    expect(sim.compositeBosses).toContain(boss);
    // Not in the enemy list: it is not one circle and does not belong there.
    expect(sim.enemies).not.toContain(boss);
    expect(seen[0].composite).toBe(true);
    expect(seen[0].templateId).toBe('hive_cruiser');
  });

  it('picks the wave-appropriate template when none is named', () => {
    const sim = new Simulation({ seed: 8 });
    sim.startRun();
    sim.state.wave = 10;
    expect(sim.spawnCompositeBoss().templateId).toBe('spire_station');
  });

  it('takes projectile hits on its parts and pays out the wrecks', () => {
    const sim = new Simulation({ seed: 8 });
    sim.startRun();
    const boss = sim.spawnCompositeBoss('hive_cruiser', { x: 900, y: 800 });
    const port = boss.getPart('turret_port');
    const startScore = sim.state.score;

    // Park a heavy round on the turret and let the collision pass resolve it.
    sim.spawnProjectile({
      x: port.worldX,
      y: port.worldY,
      vx: 0,
      vy: 0,
      damage: port.hp,
      radius: 5,
      life: 1,
    });
    sim.update(1 / 60);

    expect(port.alive).toBe(false);
    expect(sim.state.score).toBeGreaterThan(startScore);
    expect(sim.orbs.length).toBeGreaterThan(0);
  });

  it('deflects shots at the armoured hull without damaging it', () => {
    const sim = new Simulation({ seed: 8 });
    sim.startRun();
    const boss = sim.spawnCompositeBoss('hive_cruiser', { x: 900, y: 800 });
    const before = boss.chassisHp;

    let deflections = 0;
    sim.bus.on('boss:deflected', () => deflections++);
    sim.spawnProjectile({
      x: boss.x,
      y: boss.y,
      vx: 0,
      vy: 0,
      damage: 400,
      radius: 5,
      life: 1,
    });
    sim.update(1 / 60);

    expect(boss.chassisHp).toBe(before);
    expect(deflections).toBe(1);
  });

  it('completes a boss wave when the chassis goes down', () => {
    const sim = new Simulation({ seed: 8 });
    sim.startRun();
    sim.state.wave = 5;
    const boss = sim.spawnCompositeBoss('hive_cruiser', { x: 900, y: 800 });
    const ctx = { emit: (type, payload) => sim.bus.emit(type, payload) };

    let completed = 0;
    sim.bus.on('wave:complete', () => completed++);

    for (const part of [...boss.parts]) {
      while (part.alive) boss.damagePart(part.id, 200, ctx);
    }
    boss.damageChassis(boss.chassisHp, ctx);
    sim.update(1 / 60);

    expect(boss.alive).toBe(false);
    expect(sim.compositeBosses).toHaveLength(0);
    expect(completed).toBe(1);
  });

  it('takes over boss waves when the simulation is flagged for it', () => {
    const sim = new Simulation({ seed: 8, useCompositeBosses: true });
    sim.startRun();
    sim.state.wave = 5;
    sim.spawner.beginWave(5);
    sim.update(0.1);

    expect(sim.compositeBosses).toHaveLength(1);
    expect(sim.compositeBosses[0].templateId).toBe('hive_cruiser');
    // And the legacy Dreadnought stays off the field entirely.
    expect(sim.enemies.some((e) => e.isBoss)).toBe(false);
  });

  it('leaves boss waves to the shipped Dreadnought by default', () => {
    const sim = new Simulation({ seed: 8 });
    sim.startRun();
    sim.state.wave = 5;
    sim.spawner.beginWave(5);
    sim.update(0.1);

    expect(sim.compositeBosses).toHaveLength(0);
    expect(sim.enemies.some((e) => e.isBoss)).toBe(true);
  });

  it('clears modular bosses on a run reset', () => {
    const sim = new Simulation({ seed: 8 });
    sim.startRun();
    sim.spawnCompositeBoss('hive_cruiser', { x: 900, y: 800 });
    sim.startRun();
    expect(sim.compositeBosses).toHaveLength(0);
  });
});

describe('CompositeBossRenderer — the container tree', () => {
  /**
   * Textures are left unresolved on purpose: Pixi substitutes Texture.EMPTY,
   * which is exactly the degradation path a half-authored boss takes. What is
   * under test is the TREE — that it mirrors the parts list, carries the hull
   * rotation once, and swaps a wreck in when a part goes.
   */
  const makeRenderer = () => new CompositeBossRenderer({ layer: new Container() });

  it('builds one holder per part, at the authored local offsets', () => {
    const renderer = makeRenderer();
    const boss = makeBoss('hive_cruiser', { x: 200, y: 120 });
    renderer.sync(boss.getRenderState());

    const view = renderer.views.get(boss.id);
    expect(view.parts.size).toBe(boss.parts.length);
    expect(view.root.x).toBe(200);
    expect(view.root.y).toBe(120);

    const def = getBossTemplate('hive_cruiser').parts.find((p) => p.id === 'turret_port');
    const holder = view.parts.get('turret_port').holder;
    expect(holder.x).toBe(def.offset.x);
    expect(holder.y).toBe(def.offset.y);
  });

  it('reuses the same tree across frames instead of rebuilding it', () => {
    const renderer = makeRenderer();
    const boss = makeBoss();
    renderer.sync(boss.getRenderState());
    const first = renderer.views.get(boss.id).root;

    boss.rotation = 0.5;
    boss.syncParts();
    renderer.sync(boss.getRenderState());

    expect(renderer.views.get(boss.id).root).toBe(first);
    expect(first.rotation).toBeCloseTo(0.5, 9);
  });

  it('does not double-count the hull spin on an aiming turret', () => {
    const renderer = makeRenderer();
    const boss = makeBoss('hive_cruiser', { x: 0, y: 0 });
    const ctx = makeCtx({ x: 1000, y: 0 });
    tick(boss, ctx, 2);

    const state = boss.getRenderState();
    renderer.sync(state);

    const port = state.parts.find((p) => p.id === 'turret_port');
    const holder = renderer.views.get(boss.id).parts.get('turret_port').holder;
    // Local angle + parent rotation must land back on the world aim angle the
    // simulation fired along.
    expect(holder.rotation + state.rotation).toBeCloseTo(port.rotation, 9);
  });

  it('swaps a wrecked part for its debris and leaves it on the hull', () => {
    const renderer = makeRenderer();
    const boss = makeBoss();
    const ctx = makeCtx();
    renderer.sync(boss.getRenderState());

    const part = renderer.views.get(boss.id).parts.get('reactor_core');
    expect(part.live.visible).toBe(true);
    expect(part.wreck.visible).toBe(false);

    wreckPart(boss, 'reactor_core', ctx);
    renderer.sync(boss.getRenderState());

    expect(part.live.visible).toBe(false);
    expect(part.wreck.visible).toBe(true);
    expect(part.holder.parent).toBe(renderer.views.get(boss.id).root);
  });

  it('shows the armour glint only while the chassis is protected', () => {
    const renderer = makeRenderer();
    const boss = makeBoss();
    const ctx = makeCtx();
    renderer.sync(boss.getRenderState());
    expect(renderer.views.get(boss.id).armorGlow.alpha).toBe(BOSS_VIEW.armoredAlpha);

    wreckPart(boss, 'turret_port', ctx);
    wreckPart(boss, 'turret_starboard', ctx);
    renderer.sync(boss.getRenderState());
    expect(renderer.views.get(boss.id).armorGlow.alpha).toBe(0);
  });

  it('darkens a damaged part and flashes it white on a hit', () => {
    const renderer = makeRenderer();
    const boss = makeBoss();
    const ctx = makeCtx();
    renderer.sync(boss.getRenderState());
    const live = renderer.views.get(boss.id).parts.get('turret_port').live;
    const intact = live.tint;

    boss.damagePart('turret_port', 200, ctx);
    boss.getPart('turret_port').hitFlash = 0;
    renderer.sync(boss.getRenderState());
    expect(live.tint).toBeLessThan(intact);

    boss.damagePart('turret_port', 10, ctx);
    renderer.sync(boss.getRenderState());
    expect(live.tint).toBe(BOSS_VIEW.flashTint);
  });

  it('drops a boss view on release, and all of them on clear', () => {
    const renderer = makeRenderer();
    const boss = makeBoss();
    renderer.sync(boss.getRenderState());
    /*
     * TWO containers per boss, not one: the hull tree and the world-bearing fx
     * tree beside it (see the note at the top of composite-boss-renderer.js).
     * The count is asserted because the fx tree is a SIBLING — destroying the
     * root does not take it along, so a release that forgot it would leave a
     * telegraph beam painted on the arena for the rest of the run, and nothing
     * else in the suite would notice.
     */
    expect(renderer.layer.children).toHaveLength(2);

    renderer.release(boss.id);
    expect(renderer.views.size).toBe(0);
    expect(renderer.layer.children).toHaveLength(0);

    renderer.sync(boss.getRenderState());
    renderer.clear();
    expect(renderer.views.size).toBe(0);
  });
});
