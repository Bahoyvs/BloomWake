import { describe, it, expect } from 'vitest';
import {
  getEnemyCount,
  getEnemyHpMultiplier,
  getEnemySpeedMultiplier,
  isBossWave,
  getBossHp,
  getWaveDuration,
  WAVE_CONSTANTS,
} from '../src/core/wave.js';

describe('Wave Calculations & Formulas (GDD Section 6)', () => {
  it('should scale enemy count per wave and enforce 200 cap', () => {
    expect(getEnemyCount(1)).toBe(14); // 8 + 1*6
    expect(getEnemyCount(5)).toBe(38); // 8 + 5*6
    expect(getEnemyCount(20)).toBe(128); // 8 + 20*6
    expect(getEnemyCount(32)).toBe(200); // 8 + 32*6 = 200 (exact cap)
    expect(getEnemyCount(50)).toBe(200); // Hard cap at 200
  });

  it('should scale enemy HP multiplier correctly', () => {
    expect(getEnemyHpMultiplier(1)).toBe(1.0);
    expect(getEnemyHpMultiplier(2)).toBeCloseTo(1.12); // 1 + (2-1)*0.12
    expect(getEnemyHpMultiplier(10)).toBeCloseTo(2.08); // 1 + 9*0.12
  });

  it('should scale enemy speed multiplier and enforce 1.5x cap', () => {
    expect(getEnemySpeedMultiplier(1)).toBe(1.0);
    expect(getEnemySpeedMultiplier(5)).toBeCloseTo(1.12); // 1 + 4*0.03
    expect(getEnemySpeedMultiplier(20)).toBe(1.5); // Capped at 1.5
    expect(getEnemySpeedMultiplier(100)).toBe(1.5);
  });

  it('should correctly flag boss waves (every 5th wave)', () => {
    expect(isBossWave(1)).toBe(false);
    expect(isBossWave(4)).toBe(false);
    expect(isBossWave(5)).toBe(true);
    expect(isBossWave(10)).toBe(true);
    expect(isBossWave(15)).toBe(true);
  });

  it('should calculate Rustwhale boss HP based on wave tier', () => {
    // 1000 + (wave/5) * 625 (Base HP x 2.5)
    expect(getBossHp(5)).toBe(1625); // Tier 1: 1000 + 625
    expect(getBossHp(10)).toBe(2250); // Tier 2: 1000 + 1250
    expect(getBossHp(15)).toBe(2875); // Tier 3: 1000 + 1875
  });

  it('opens the spawn window at the floor and ramps it to the ceiling', () => {
    // getWaveDuration is the SPAWN WINDOW, not the wave length — a wave now
    // ends when the field is empty. See the note on the function.
    expect(getWaveDuration(1)).toBe(WAVE_CONSTANTS.WAVE_SPAWN_SEC_MIN);
    expect(getWaveDuration(WAVE_CONSTANTS.WAVE_SPAWN_RAMP_TO)).toBe(
      WAVE_CONSTANTS.WAVE_SPAWN_SEC_MAX
    );
    // Holds at the ceiling rather than growing without bound.
    expect(getWaveDuration(50)).toBe(WAVE_CONSTANTS.WAVE_SPAWN_SEC_MAX);
  });

  it('ramps the spawn window monotonically', () => {
    let previous = 0;
    for (let wave = 1; wave <= 15; wave++) {
      const duration = getWaveDuration(wave);
      expect(duration).toBeGreaterThanOrEqual(previous);
      previous = duration;
    }
  });
});
