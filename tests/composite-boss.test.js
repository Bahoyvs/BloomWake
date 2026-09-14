import { describe, it, expect } from 'vitest';
import { CompositeBoss } from '../src/core/composite-boss.js';
import {
  COMPOSITE_BOSSES,
  getBossTemplate,
  getTemplateTotalHp,
} from '../src/data/roster-config.js';
import { Simulation } from '../src/core/simulation.js';
import { mulberry32 } from '../src/core/math.js';
import { Container } from 'pixi.js';
import {
  BOSS_TEXTURE_KEY,
  BOSS_VIEW,
  CompositeBossRenderer,
} from '../src/render/composite-boss-renderer.js';

/** Collector context: bullets and events the boss produces land here. */
function makeCtx(target = { x: 0, y: 0 }) {
  const bullets = [];
  const events = [];
  return {
    target,
    bullets,
    events,
    rng: mulberry32(17),
    fire: (spec) => bullets.push(spec),
    emit: (type, payload) => events.push({ type, payload }),
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
    expect(renderer.layer.children).toHaveLength(1);

    renderer.release(boss.id);
    expect(renderer.views.size).toBe(0);
    expect(renderer.layer.children).toHaveLength(0);

    renderer.sync(boss.getRenderState());
    renderer.clear();
    expect(renderer.views.size).toBe(0);
  });
});
