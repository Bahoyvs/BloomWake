/**
 * BloomWake — Card Balance Simulation (Development Plan, Phase 3 Step A)
 *
 * Pure Node script. No DOM, no browser deps, no game-code mutation: it reads
 * the card table in src/data/cards.js and scores every card at every level so
 * balance can be iterated by editing numbers instead of rebuilding the game.
 *
 * Run:
 *   node tests/balance-sim.js              # console tables for both scenarios
 *   node tests/balance-sim.js --csv out.csv
 *   node tests/balance-sim.js --measure    # re-measure the reference scenario
 *                                          # from the live Phase 1 simulation
 *
 * ---------------------------------------------------------------------------
 * WHY A "SCENARIO" AT ALL
 * ---------------------------------------------------------------------------
 * A card's DPS is meaningless without knowing how many enemies are near the
 * Dewling. Measurement against the live Phase 1 simulation showed the number
 * swings wildly with play style:
 *
 *   policy       active enemies   incoming DPS   within 110px
 *   flee              17.3            0.18           0.29
 *   stationary        20.2            2.22           1.33
 *   orb-greedy        20.5            1.34           1.28
 *   mixed             20.5            0.63           0.93
 *
 * A perfect kiter gets almost nothing from AoE; a stationary player gets a lot.
 * The `mixed` policy (chase XP orbs, veer away from anything inside 120px) is
 * the closest model of real play and is what CURRENT is calibrated on.
 *
 * CURRENT is measured but describes Phase 1 content only: one enemy type and a
 * slow fill rate, ~20 active enemies. The shipping game targets a 200-enemy
 * bounded swarm (GDD Section 5). Every card that scales with enemy count gains
 * relative power as density rises, so cards are also scored against SWARM, a
 * projection to 120 active enemies. A card must clear the thresholds in BOTH
 * scenarios: passing only one means it is either dead now or broken later.
 */

import { CARDS, getCardById } from '../src/data/cards.js';
import { CARD_MODEL } from '../src/core/constants.js';

/* ==========================================================================
 * Model assumptions
 *
 * Split in two on purpose:
 *
 *   CARD_MODEL (imported from src/core/constants.js) holds the mechanics the
 *   GDD leaves unspecified — tick rates, hit gating, reach. These are shared
 *   with the live implementation so the table cannot drift from the game.
 *
 *   SCORING holds numbers that exist only to compare cards on one axis. They
 *   describe how this script values things, not how the game behaves, so they
 *   deliberately do NOT live in game code.
 * ======================================================================== */
export const MODEL = CARD_MODEL;

export const SCORING = {
  /**
   * Fraction of a movement-speed bonus that converts into damage avoided.
   * Speed helps you dodge, but only if you use it; 0.5 is a deliberate haircut
   * so a pure-speed passive cannot be scored as if it were pure mitigation.
   */
  SPEED_TO_MITIGATION: 0.5,

  /**
   * Ceiling on how much a mitigation card may be credited, as a fraction of the
   * build's damage core.
   *
   * Walked down 1.0 -> 0.5 -> 0.25 across Step B. The cap constrains a single
   * card, but the genre requirement is about the category: with three utility
   * cards each creditable at `cap`, defensive output reaches 3*cap / (1 + 3*cap)
   * of the build. At 0.5 that was ~58% and defense still outweighed offense;
   * 0.25 puts offense in front, which is the intended shape for a survivor game.
   */
  MAX_SURVIVAL_EXTENSION: 0.25,
};

/* ==========================================================================
 * Reference scenarios
 * ======================================================================== */

/**
 * Measured from the live Phase 1 simulation: `mixed` policy bot, seeds 1/7/99,
 * waves 1-12, sampled every 10th step. Regenerate with `--measure`.
 */
export const CURRENT = {
  id: 'CURRENT',
  label: 'Measured — Phase 1 content (1 enemy type, ~20 active)',
  measured: true,
  activeEnemies: 20.5,
  /** Contact DPS taken by a competent player. */
  incomingDps: 0.63,
  /**
   * Contact DPS while caught in the swarm (stationary measurement). Mitigation
   * cards are scored against this: a shield is worth nothing in the seconds you
   * are not being hit, so crediting it at the average rate understates it.
   */
  incomingDpsUnderPressure: 2.22,
  /** Tarling 10 HP x mean wave-1..12 HP multiplier (1.66). */
  enemyHp: 16.6,
  /** Tarling 64 px/s x mean wave-1..12 speed multiplier (1.165). */
  enemySpeed: 74.6,
  /** Mean enemies within radius (px) of the Dewling. */
  densityByRadius: {
    60: 0.43,
    85: 0.65,
    110: 0.93,
    150: 1.52,
    210: 2.51,
    300: 4.37,
    520: 10.77,
  },
};

/**
 * Projection, NOT a measurement. Same spatial shape as CURRENT scaled to 120
 * active enemies, with roster-weighted HP/speed at ~wave 15. Enemy stats are
 * the spawn-weighted mean of the five non-boss types in the GDD roster.
 *
 * This is the scenario Phase 4 should re-measure and replace.
 */
const SWARM_SCALE = 120 / CURRENT.activeEnemies;

export const SWARM = {
  id: 'SWARM',
  label: 'Projected — full roster bounded swarm (~120 active)',
  measured: false,
  activeEnemies: 120,
  incomingDps: CURRENT.incomingDps * SWARM_SCALE,
  incomingDpsUnderPressure: CURRENT.incomingDpsUnderPressure * SWARM_SCALE,
  /** Spawn-weighted roster mean 12.74 HP x wave-15 multiplier (2.68). */
  enemyHp: 34.1,
  /** Spawn-weighted roster mean 74.4 px/s x wave-15 speed multiplier (1.42). */
  enemySpeed: 105.7,
  densityByRadius: Object.fromEntries(
    Object.entries(CURRENT.densityByRadius).map(([r, n]) => [r, n * SWARM_SCALE])
  ),
};

export const SCENARIOS = { CURRENT, SWARM };

/* ==========================================================================
 * Thresholds (Development Plan, Section 1 — "Kart Sinerjisi" risk row)
 * ======================================================================== */
export const THRESHOLDS = {
  /**
   * THE GATE. Development Plan wording: no level-5 card may produce more than
   * 40% of the sum of all the other cards. Chosen over the looser
   * "share of total" reading to force synergy builds and prevent a one-card
   * dominant meta. Equivalent to a 28.6% share of total build output.
   */
  MAX_L5_RATIO_TO_OTHERS: 0.40,
  /**
   * Advisory only: the same rule read as a share of TOTAL build output. An even
   * 8-card split is 12.5%, so 40% would be 3.2x a fair share. Reported for
   * context; MAX_L5_RATIO_TO_OTHERS is what passes or fails.
   */
  MAX_L5_SHARE: 0.40,
  /**
   * A level-3 card is "dead" below this share. An even 8-card split is 12.5%;
   * this floor is a quarter of that, i.e. the card does under a quarter of what
   * an average card does at the same level.
   */
  DEAD_L3_SHARE: 0.125 * 0.25,
};

/**
 * Scenario that mitigation and crowd-control cards are balanced against.
 *
 * Design decision: CURRENT is early-game/tutorial density (2.22 DPS of contact
 * pressure), where any useful shield trivially absorbs everything. Immunity
 * there is expected and reported as advisory. SWARM is the real target loop, so
 * an immunity result there is a blocking failure.
 */
export const MITIGATION_TARGET_SCENARIO = 'SWARM';

/* ==========================================================================
 * Density model
 * ======================================================================== */

/**
 * Fit N(r) = c * r^a to the scenario's measured density table (least squares
 * in log-log space). The power law lets the model answer questions the sampled
 * radii do not cover directly, such as "how many enemies sit inside a 40px-wide
 * strip 620px long".
 *
 * @param {Object} scenario
 * @returns {{c: number, a: number}}
 */
export function fitDensity(scenario) {
  if (scenario._fit) return scenario._fit;

  const points = Object.entries(scenario.densityByRadius)
    .map(([r, n]) => [Number(r), n])
    .filter(([, n]) => n > 0);

  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [r, n] of points) {
    const x = Math.log(r);
    const y = Math.log(n);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const k = points.length;
  const a = (k * sxy - sx * sy) / (k * sxx - sx * sx);
  const c = Math.exp((sy - a * sx) / k);

  scenario._fit = { c, a };
  return scenario._fit;
}

/**
 * Expected enemies within `radius` px of the Dewling.
 * @param {Object} scenario
 * @param {number} radius
 * @returns {number}
 */
export function enemiesWithin(scenario, radius) {
  if (radius <= 0) return 0;
  const { c, a } = fitDensity(scenario);
  return Math.min(c * Math.pow(radius, a), scenario.activeEnemies);
}

/**
 * Expected enemies inside a strip of width `w` running `len` px out from the
 * Dewling, obtained by integrating the radial density along the strip:
 *
 *   E = integral_0^len  N'(r) * w / (2*pi*r)  dr   with  N(r) = c * r^a
 *     = (a*c*w / 2*pi) * len^(a-1) / (a-1)
 *
 * @param {Object} scenario
 * @param {number} w - Strip width in px
 * @param {number} len - Strip length in px
 * @returns {number}
 */
export function enemiesInStrip(scenario, w, len) {
  const { c, a } = fitDensity(scenario);
  if (a <= 1) return Math.min(enemiesWithin(scenario, len), scenario.activeEnemies);
  const expected = ((a * c * w) / (2 * Math.PI)) * (Math.pow(len, a - 1) / (a - 1));
  return Math.min(expected, scenario.activeEnemies);
}

/**
 * Expected enemies inside an annulus centred on `radius` with thickness `band`.
 * @returns {number}
 */
export function enemiesInBand(scenario, radius, band) {
  const outer = enemiesWithin(scenario, radius + band / 2);
  const inner = enemiesWithin(scenario, Math.max(0, radius - band / 2));
  return Math.max(0, outer - inner);
}

/**
 * Damage actually landed by one hit. Damage above an enemy's HP is overkill and
 * is thrown away — this is what stops high-damage single-target cards from
 * looking infinitely scalable.
 */
function effectiveHit(damage, scenario) {
  return Math.min(damage, scenario.enemyHp);
}

/**
 * Convert a mitigation rate into a damage-equivalent multiplier.
 * Surviving X% longer means dealing X% more damage over a run, so mitigation is
 * scored as a fraction of the build's damage core.
 *
 * Two distinct outcomes, which stopped being the same thing once the credit cap
 * dropped below 1.0:
 *   - `immune`: the card removes ALL incoming contact damage. A gameplay
 *     failure — the player cannot die to the swarm.
 *   - `capped`: the card is merely worth more than the model will credit. Not a
 *     failure, just a conservative score.
 *
 * @param {number} mitigationRate - HP/sec of incoming damage removed
 * @param {Object} scenario
 * @returns {{extension: number, immune: boolean, capped: boolean}}
 */
function survivalExtension(mitigationRate, scenario) {
  const fraction = mitigationRate / scenario.incomingDpsUnderPressure;
  return {
    extension: Math.min(fraction, SCORING.MAX_SURVIVAL_EXTENSION),
    immune: fraction >= 1,
    capped: fraction > SCORING.MAX_SURVIVAL_EXTENSION,
  };
}

/* ==========================================================================
 * Per-card scoring
 *
 * Damage cards return { dps }. Utility cards return { utilityOf: fn } so they
 * can be scored in a second pass against the build's damage core.
 * ======================================================================== */

const SCORERS = {
  /** Homing single-target volley: every projectile finds the nearest enemy. */
  dewdrop_barrage: (lv, s) => ({
    dps: (effectiveHit(lv.damage, s) * lv.count) / lv.cooldown,
    note: `${lv.count}x${lv.damage} / ${lv.cooldown}s, single-target`,
  }),

  /** Fixed-direction piercing strip, re-ticking while active. */
  sunbeam_lance: (lv, s) => {
    const hit = enemiesInStrip(s, lv.width, MODEL.BEAM_LENGTH);
    const ticks = lv.duration / MODEL.BEAM_TICK_SEC;
    return {
      dps: (effectiveHit(lv.damage, s) * ticks * hit) / lv.cooldown,
      note: `${hit.toFixed(2)} in beam x ${ticks.toFixed(1)} ticks`,
    };
  },

  /** Orbiting blades: continuous, gated by a per-enemy re-hit cooldown. */
  glasswing: (lv, s) => {
    const inBand = enemiesInBand(s, lv.radius, MODEL.ORBIT_BAND);
    const sweepsPerSec = (lv.count * lv.rotationSpeed) / (2 * Math.PI);
    const hitsPerSec = Math.min(sweepsPerSec, 1 / MODEL.ORBIT_HIT_COOLDOWN);
    return {
      dps: effectiveHit(lv.damage, s) * hitsPerSec * inBand,
      note: `${inBand.toFixed(2)} in band x ${hitsPerSec.toFixed(2)} hits/s`,
    };
  },

  /** Radial salvo in random directions; each petal hits at most one enemy. */
  petal_storm: (lv, s) => {
    const expected = enemiesInStrip(s, MODEL.PETAL_SWEEP_WIDTH, MODEL.PETAL_RANGE);
    const hitChance = 1 - Math.exp(-expected);
    return {
      dps: (effectiveHit(lv.damage, s) * lv.count * hitChance) / lv.cooldown,
      note: `${(hitChance * 100).toFixed(0)}% hit chance x ${lv.count} petals`,
    };
  },

  /** Periodic ring blast centred on the Dewling. */
  aurora_pulse: (lv, s) => {
    const hit = enemiesWithin(s, lv.radius);
    return {
      dps: (effectiveHit(lv.damage, s) * hit) / lv.cooldown,
      note: `${hit.toFixed(2)} in radius ${lv.radius}`,
    };
  },

  /** Pure mitigation: absorbs shieldHp every rechargeTime seconds. */
  bloomshield: (lv, s) => {
    const rate = lv.shieldHp / lv.rechargeTime;
    const { extension, immune, capped } = survivalExtension(rate, s);
    return {
      utilityOf: (core) => core * extension,
      note:
        `${rate.toFixed(2)} HP/s vs ${s.incomingDpsUnderPressure.toFixed(1)} incoming` +
        `${immune ? ' [IMMUNE]' : ''}${capped ? ' [capped]' : ''}`,
      immune,
    };
  },

  /**
   * Multiplicative passive: scales the whole build, plus dodge from speed.
   * The speed half is routed through the same mitigation cap as the shields so
   * a passive cannot sidestep the defensive ceiling.
   */
  buddy_boost: (lv, s) => {
    const dodgeFraction = lv.moveSpeedBonus * SCORING.SPEED_TO_MITIGATION;
    const { extension } = survivalExtension(
      dodgeFraction * s.incomingDpsUnderPressure,
      s
    );
    return {
      utilityOf: (core) => core * lv.damageBonus + core * extension,
      note: `+${(lv.damageBonus * 100).toFixed(0)}% dmg, +${(lv.moveSpeedBonus * 100).toFixed(0)}% spd`,
    };
  },

  /** AoE damage plus knockback, which buys back contact-damage-free seconds. */
  tidewave: (lv, s) => {
    const hit = enemiesWithin(s, lv.radius);
    const direct = (effectiveHit(lv.damage, s) * hit) / lv.cooldown;
    const returnTime = lv.knockback / s.enemySpeed;
    const uptime = Math.min(1, returnTime / lv.cooldown);
    const { extension, immune, capped } = survivalExtension(
      uptime * s.incomingDpsUnderPressure,
      s
    );
    return {
      dps: direct,
      utilityOf: (core) => core * extension,
      note:
        `${hit.toFixed(2)} hit, ${(uptime * 100).toFixed(0)}% pushed off` +
        `${immune ? ' [IMMUNE]' : ''}${capped ? ' [capped]' : ''}`,
      immune,
    };
  },
};

/**
 * Score every card at one level against a scenario.
 *
 * Two passes: damage cards first to establish the build's damage core, then
 * utility cards as a fraction of that core. Utility is meaningless in isolation
 * — a shield on a build with no weapons is worth nothing.
 *
 * @param {number} level - 1..5
 * @param {Object} scenario
 * @returns {{rows: Array<Object>, total: number, damageCore: number}}
 */
export function scoreLevel(level, scenario) {
  const scored = CARDS.map((card) => {
    const levelData = card.levels[level - 1];
    const result = SCORERS[card.id](levelData, scenario);
    return { card, result };
  });

  const damageCore = scored.reduce((sum, { result }) => sum + (result.dps || 0), 0);

  const rows = scored.map(({ card, result }) => {
    const dps = result.dps || 0;
    const utility = result.utilityOf ? result.utilityOf(damageCore) : 0;
    return {
      id: card.id,
      name: card.name,
      type: card.type,
      level,
      dps,
      utility,
      total: dps + utility,
      note: result.note,
      immune: Boolean(result.immune),
    };
  });

  const total = rows.reduce((sum, r) => sum + r.total, 0);
  for (const row of rows) {
    row.share = total > 0 ? row.total / total : 0;
    const others = total - row.total;
    row.ratioToOthers = others > 0 ? row.total / others : Infinity;
  }

  return { rows, total, damageCore };
}

/**
 * Full sweep: all 8 cards x levels 1-5 for one scenario, plus threshold checks.
 * @param {Object} scenario
 * @returns {{scenario: Object, levels: Array, violations: Array}}
 */
export function analyze(scenario) {
  const levels = [1, 2, 3, 4, 5].map((lv) => scoreLevel(lv, scenario));
  const violations = [];

  const l5 = levels[4];
  for (const row of l5.rows) {
    if (row.ratioToOthers > THRESHOLDS.MAX_L5_RATIO_TO_OTHERS) {
      violations.push({
        kind: 'DOMINANT',
        scenario: scenario.id,
        card: row.name,
        level: 5,
        share: row.share,
        detail:
          `${(row.ratioToOthers * 100).toFixed(1)}% of the sum of the other cards ` +
          `(limit ${(THRESHOLDS.MAX_L5_RATIO_TO_OTHERS * 100).toFixed(0)}%, ` +
          `= ${(row.share * 100).toFixed(1)}% of total)`,
      });
    }
  }

  const l3 = levels[2];
  for (const row of l3.rows) {
    if (row.share < THRESHOLDS.DEAD_L3_SHARE) {
      violations.push({
        kind: 'DEAD',
        scenario: scenario.id,
        card: row.name,
        level: 3,
        share: row.share,
        detail:
          `${(row.share * 100).toFixed(2)}% of build output ` +
          `(floor ${(THRESHOLDS.DEAD_L3_SHARE * 100).toFixed(2)}%)`,
      });
    }
  }

  // Immunity is a real failure only in the scenario mitigation is tuned for.
  // In CURRENT's tutorial-grade pressure it is expected, so it is advisory.
  const immunityIsAdvisory = scenario.id !== MITIGATION_TARGET_SCENARIO;
  for (const level of levels) {
    for (const row of level.rows) {
      if (row.immune) {
        violations.push({
          kind: immunityIsAdvisory ? 'IMMUNE-EXPECTED' : 'IMMUNE',
          scenario: scenario.id,
          card: row.name,
          level: row.level,
          share: row.share,
          advisory: immunityIsAdvisory,
          detail: `removes all incoming contact damage — ${row.note}`,
        });
      }
    }
  }

  return {
    scenario,
    levels,
    violations,
    blocking: violations.filter((v) => !v.advisory),
  };
}

/* ==========================================================================
 * Reporting
 * ======================================================================== */

function pad(value, width, left = false) {
  const str = String(value);
  return left ? str.padStart(width) : str.padEnd(width);
}

function printScenario(report) {
  const { scenario, levels, violations } = report;

  console.log('');
  console.log('='.repeat(104));
  console.log(`SCENARIO ${scenario.id} — ${scenario.label}`);
  console.log(
    `  active enemies ${scenario.activeEnemies} | enemy HP ${scenario.enemyHp} | ` +
      `incoming ${scenario.incomingDps.toFixed(2)} DPS ` +
      `(${scenario.incomingDpsUnderPressure.toFixed(2)} under pressure)` +
      `${scenario.measured ? '' : '  [PROJECTION]'}`
  );
  console.log('='.repeat(104));

  console.log(
    pad('CARD', 18) +
      pad('TYPE', 11) +
      [1, 2, 3, 4, 5].map((l) => pad(`L${l}`, 10, true)).join('') +
      pad('  L5 SHARE', 12, true) +
      pad('  vs OTHERS', 12, true)
  );
  console.log('-'.repeat(104));

  for (let i = 0; i < CARDS.length; i++) {
    const card = CARDS[i];
    const cells = levels.map((lv) => lv.rows[i].total.toFixed(1));
    const { share, ratioToOthers } = levels[4].rows[i];
    const gateFlag = ratioToOthers > THRESHOLDS.MAX_L5_RATIO_TO_OTHERS ? ' <<' : '';
    console.log(
      pad(card.name, 18) +
        pad(card.type, 11) +
        cells.map((c) => pad(c, 10, true)).join('') +
        pad(`  ${(share * 100).toFixed(1)}%`, 12, true) +
        pad(`  ${(ratioToOthers * 100).toFixed(1)}%${gateFlag}`, 12, true)
    );
  }

  console.log('-'.repeat(104));
  console.log(
    pad('TOTAL BUILD', 29) + levels.map((lv) => pad(lv.total.toFixed(1), 10, true)).join('')
  );

  console.log('');
  console.log('  Level-5 breakdown (damage vs utility):');
  for (const row of levels[4].rows) {
    console.log(
      '   ' +
        pad(row.name, 18) +
        pad(`dps ${row.dps.toFixed(1)}`, 14) +
        pad(`util ${row.utility.toFixed(1)}`, 14) +
        row.note
    );
  }

  console.log('');
  const blocking = violations.filter((v) => !v.advisory);
  const advisory = violations.filter((v) => v.advisory);

  if (blocking.length === 0) {
    console.log('  ✅ No blocking violations.');
  } else {
    console.log(`  ❌ ${blocking.length} BLOCKING violation(s):`);
    for (const v of blocking) {
      console.log(`     [${v.kind}] ${v.card} L${v.level} — ${v.detail}`);
    }
  }
  if (advisory.length > 0) {
    console.log(`  ℹ️  ${advisory.length} advisory (expected in this scenario):`);
    for (const v of advisory) {
      console.log(`     [${v.kind}] ${v.card} L${v.level} — ${v.detail}`);
    }
  }
}

/**
 * Flatten every scenario/level/card row for CSV export.
 * @returns {string}
 */
export function toCsv(reports) {
  const lines = [
    'scenario,card,id,type,level,dps,utility,total,share_pct,ratio_to_others_pct,note',
  ];
  for (const report of reports) {
    for (const level of report.levels) {
      for (const row of level.rows) {
        lines.push(
          [
            report.scenario.id,
            row.name,
            row.id,
            row.type,
            row.level,
            row.dps.toFixed(3),
            row.utility.toFixed(3),
            row.total.toFixed(3),
            (row.share * 100).toFixed(2),
            (row.ratioToOthers * 100).toFixed(2),
            `"${row.note}"`,
          ].join(',')
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * Re-measure the CURRENT scenario against the live Phase 1 simulation.
 * Imports game code lazily so the pure scoring path stays dependency-free.
 * @returns {Promise<Object>}
 */
export async function measureScenario() {
  const { Simulation } = await import('../src/core/simulation.js');
  const { GameState } = await import('../src/core/game-state.js');
  const { EventBus } = await import('../src/core/event-bus.js');
  const { distanceSq, normalize } = await import('../src/core/math.js');

  const STEP = 1 / 60;
  const RADII = [60, 85, 110, 150, 210, 300, 520];
  const acc = Object.fromEntries(RADII.map((r) => [r, 0]));
  let samples = 0;
  let activeSum = 0;
  let damage = 0;
  let time = 0;

  for (const seed of [1, 7, 99]) {
    const bus = new EventBus();
    const state = new GameState(bus, { maxWaves: Infinity });
    const sim = new Simulation({ bus, state, seed });
    bus.on('player:damage', (d) => {
      damage += d.damage;
    });
    sim.startRun();
    // Immortal so the measurement covers the whole wave range, not just the
    // waves a 100 HP Dewling happens to survive.
    state.player.maxHp = 1e9;
    state.player.hp = 1e9;

    for (let i = 0; i < 60 * 600; i++) {
      if (state.wave > 12) break;
      const p = state.player;

      // `mixed` policy: seek the nearest orb, veer off anything inside 120px.
      let orb = null;
      let best = Infinity;
      for (const o of sim.orbs) {
        if (!o.alive) continue;
        const d = distanceSq(p.x, p.y, o.x, o.y);
        if (d < best) {
          best = d;
          orb = o;
        }
      }
      const threat = sim.findNearestEnemy(120);
      const seek = orb ? normalize(orb.x - p.x, orb.y - p.y) : { x: 0, y: 0 };
      const flee = threat ? normalize(p.x - threat.x, p.y - threat.y) : { x: 0, y: 0 };
      sim.update(STEP, { x: seek.x + flee.x * 1.5, y: seek.y + flee.y * 1.5 });
      time += STEP;

      if (i % 10 === 0 && state.currentState === 'RUNNING') {
        samples++;
        activeSum += sim.enemies.length;
        for (const r of RADII) {
          let count = 0;
          for (const e of sim.enemies) {
            if (distanceSq(p.x, p.y, e.x, e.y) <= r * r) count++;
          }
          acc[r] += count;
        }
      }
    }
  }

  return {
    activeEnemies: Number((activeSum / samples).toFixed(2)),
    incomingDps: Number((damage / time).toFixed(3)),
    densityByRadius: Object.fromEntries(
      RADII.map((r) => [r, Number((acc[r] / samples).toFixed(3))])
    ),
    samples,
  };
}

/* ==========================================================================
 * CLI
 * ======================================================================== */

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--measure')) {
    console.log('Measuring reference scenario from the live simulation...');
    const measured = await measureScenario();
    console.log(JSON.stringify(measured, null, 2));
    console.log('\nUpdate the CURRENT constant in this file with these values.');
    return;
  }

  console.log('BLOOMWAKE — CARD BALANCE SIMULATION (Phase 3, Step A)');
  console.log(`Cards: ${CARDS.length} | Levels: 5 | Scenarios: ${Object.keys(SCENARIOS).length}`);

  const reports = Object.values(SCENARIOS).map(analyze);
  for (const report of reports) printScenario(report);

  const all = reports.flatMap((r) => r.violations);
  const blocking = all.filter((v) => !v.advisory);
  console.log('');
  console.log('='.repeat(104));
  console.log(
    `VERDICT: ${blocking.length} blocking, ${all.length - blocking.length} advisory ` +
      `across ${reports.length} scenarios`
  );
  console.log(
    `  Gate: no L5 card above ${(THRESHOLDS.MAX_L5_RATIO_TO_OTHERS * 100).toFixed(0)}% of the ` +
      `sum of the others | mitigation tuned against ${MITIGATION_TARGET_SCENARIO} | ` +
      `defensive credit cap ${SCORING.MAX_SURVIVAL_EXTENSION}`
  );
  console.log('='.repeat(104));
  for (const v of all) {
    console.log(
      `  ${v.advisory ? ' ' : '!'} [${pad(v.kind, 16)}] ${pad(v.scenario, 8)} ` +
        `${pad(v.card, 18)} L${v.level}  ${v.detail}`
    );
  }

  const csvFlag = args.indexOf('--csv');
  if (csvFlag !== -1) {
    const path = args[csvFlag + 1] || 'balance-report.csv';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, toCsv(reports));
    console.log(`\nCSV written to ${path}`);
  }
}

// Only run the CLI when invoked directly, so tests can import this module.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tests/balance-sim.js')) {
  main();
}
