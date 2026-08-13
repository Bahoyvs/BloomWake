/**
 * Guards the Step A/B balance work against regressions.
 *
 * These assert the thresholds from the Development Plan (Section 1, "Kart
 * Sinerjisi" risk row) still hold for the shipped card table. Editing a card's
 * numbers without re-running the balance pass will fail here.
 */

import { describe, it, expect } from 'vitest';
import {
  SCENARIOS,
  THRESHOLDS,
  MITIGATION_TARGET_SCENARIO,
  MODEL,
  SCORING,
  analyze,
  scoreLevel,
  enemiesWithin,
  enemiesInStrip,
  enemiesInBand,
} from './balance-sim.js';
import { CARD_MODEL } from '../src/core/constants.js';
import { CARDS, getCardById } from '../src/data/cards.js';

const scenarios = Object.values(SCENARIOS);

describe('Card balance thresholds', () => {
  for (const scenario of scenarios) {
    describe(`Scenario ${scenario.id}`, () => {
      const report = analyze(scenario);

      it('has no blocking threshold violations', () => {
        const detail = report.blocking
          .map((v) => `${v.kind} ${v.card} L${v.level}: ${v.detail}`)
          .join('\n');
        expect(report.blocking, detail).toHaveLength(0);
      });

      it('keeps every level-5 card under 40% of the sum of the others', () => {
        for (const row of report.levels[4].rows) {
          expect(
            row.ratioToOthers,
            `${row.name} at ${(row.ratioToOthers * 100).toFixed(1)}%`
          ).toBeLessThanOrEqual(THRESHOLDS.MAX_L5_RATIO_TO_OTHERS);
        }
      });

      it('has no dead card at level 3', () => {
        for (const row of report.levels[2].rows) {
          expect(
            row.share,
            `${row.name} at ${(row.share * 100).toFixed(2)}%`
          ).toBeGreaterThanOrEqual(THRESHOLDS.DEAD_L3_SHARE);
        }
      });

      it('grows every card monotonically across its five levels', () => {
        for (let i = 0; i < CARDS.length; i++) {
          for (let level = 1; level < 5; level++) {
            const lower = report.levels[level - 1].rows[i];
            const higher = report.levels[level].rows[i];
            expect(
              higher.total,
              `${lower.name} L${level} (${lower.total.toFixed(1)}) -> L${level + 1} (${higher.total.toFixed(1)})`
            ).toBeGreaterThan(lower.total);
          }
        }
      });
    });
  }

  it('leaves no card immune to contact damage in the target scenario', () => {
    const target = SCENARIOS[MITIGATION_TARGET_SCENARIO];
    const report = analyze(target);
    const immune = report.violations.filter((v) => v.kind === 'IMMUNE');
    expect(immune).toHaveLength(0);
  });

  it('puts offence ahead of defence in build value', () => {
    // The design call behind SCORING.MAX_SURVIVAL_EXTENSION = 0.25: a survivor
    // game should reward damage over turtling.
    for (const scenario of scenarios) {
      const l5 = scoreLevel(5, scenario);
      const damage = l5.rows.reduce((sum, row) => sum + row.dps, 0);
      expect(damage / l5.total, scenario.id).toBeGreaterThan(0.5);
    }
  });
});

describe('Balance model wiring', () => {
  it('scores the card table the game actually ships', () => {
    // The sim reads src/data/cards.js directly; this catches a card being
    // added to the game without a balance entry.
    const report = analyze(SCENARIOS.CURRENT);
    expect(report.levels[0].rows).toHaveLength(CARDS.length);
    expect(report.levels[0].rows.map((r) => r.id)).toEqual(CARDS.map((c) => c.id));
  });

  it('shares its mechanical constants with the implementation', () => {
    // Not a tautology worth skipping: it pins the contract that the balance
    // model must never fork its own copy of the tick rates.
    expect(MODEL).toBe(CARD_MODEL);
  });

  it('caps defensive credit where the design decision set it', () => {
    expect(SCORING.MAX_SURVIVAL_EXTENSION).toBe(0.25);
  });

  it('scores every card in the table', () => {
    const rows = scoreLevel(1, SCENARIOS.CURRENT).rows;
    for (const row of rows) {
      expect(Number.isFinite(row.total), row.name).toBe(true);
      expect(row.total).toBeGreaterThan(0);
    }
  });
});

describe('Density model', () => {
  const scenario = SCENARIOS.CURRENT;

  it('grows monotonically with radius', () => {
    let previous = 0;
    for (const radius of [50, 100, 150, 200, 300, 500]) {
      const count = enemiesWithin(scenario, radius);
      expect(count).toBeGreaterThan(previous);
      previous = count;
    }
  });

  it('never reports more enemies than are alive', () => {
    expect(enemiesWithin(scenario, 100000)).toBeLessThanOrEqual(scenario.activeEnemies);
    expect(enemiesInStrip(scenario, 100000, 100000)).toBeLessThanOrEqual(
      scenario.activeEnemies
    );
  });

  it('tracks the measured samples it was fitted to', () => {
    // Power-law fit against the measured table; 35% tolerance keeps this a
    // regression guard rather than a restatement of the fit.
    for (const [radius, measured] of Object.entries(scenario.densityByRadius)) {
      const modelled = enemiesWithin(scenario, Number(radius));
      expect(Math.abs(modelled - measured) / measured, `r=${radius}`).toBeLessThan(0.35);
    }
  });

  it('reports a wider band as holding more enemies', () => {
    const narrow = enemiesInBand(scenario, 110, 20);
    const wide = enemiesInBand(scenario, 110, 80);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('scales the projected swarm above the measured baseline', () => {
    for (const radius of [110, 210, 520]) {
      expect(enemiesWithin(SCENARIOS.SWARM, radius)).toBeGreaterThan(
        enemiesWithin(SCENARIOS.CURRENT, radius)
      );
    }
  });
});

describe('Step B retunes hold', () => {
  it('keeps Bloomshield below the swarm contact-damage rate', () => {
    const l5 = getCardById('bloomshield').levels[4];
    const rate = l5.shieldHp / l5.rechargeTime;
    expect(rate).toBeLessThan(SCENARIOS.SWARM.incomingDpsUnderPressure);
  });

  it('keeps Tidewave knockback uptime monotonic across levels', () => {
    // An L4 card out-performing its L5 upgrade breaks progression logic.
    const card = getCardById('tidewave');
    let previous = 0;
    for (const level of card.levels) {
      const uptime = level.knockback / SCENARIOS.CURRENT.enemySpeed / level.cooldown;
      expect(uptime, `L${level.level}`).toBeGreaterThan(previous);
      previous = uptime;
    }
  });

  it('never lets Tidewave push enemies away for a whole cooldown', () => {
    for (const scenario of scenarios) {
      for (const level of getCardById('tidewave').levels) {
        const uptime = level.knockback / scenario.enemySpeed / level.cooldown;
        expect(uptime, `${scenario.id} L${level.level}`).toBeLessThan(1);
      }
    }
  });
});
