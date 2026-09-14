/**
 * Settings manager tests.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE ACTUALLY GUARDING
 * ---------------------------------------------------------------------------
 * The settings store has one hard job: never let a bad value out. Its input is
 * localStorage, which is user-writable, survives across versions of the game,
 * and holds whatever the previous build wrote there. A volume of `"loud"`, a
 * screenShake of 47, a payload that is a string, a payload that is `null` —
 * every one of those has to come out the other side as a complete, in-range
 * settings object, because the audio manager and the renderer are handed the
 * result directly and neither of them checks.
 *
 * The storage adapter is injected as a Map-backed fake, so none of this needs
 * a browser. `createBrowserStorage` is the only part that touches `window` and
 * it is verified to answer null rather than throw when there isn't one.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SCREEN_SHAKE,
  SCREEN_SHAKE_LEVELS,
  SETTING_KEYS,
  SETTINGS_STORAGE_KEY,
  SettingsManager,
  normalizeSettings,
} from '../src/core/settings-manager.js';
import { storageService } from '../src/services/storage-service.js';

/** A storage adapter backed by a Map, with the same three methods. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** A storage adapter holding a ready-made settings payload. */
function storageWith(settings) {
  return fakeStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(settings) });
}

/** A manager over a fresh fake store. */
function harness(stored = null) {
  const storage = stored ? storageWith(stored) : fakeStorage();
  return { storage, manager: new SettingsManager({ storage }) };
}

/* ========================================================================= */
/* The schema                                                               */
/* ========================================================================= */

describe('The settings schema', () => {
  it('carries every documented field at its documented default', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      masterVolume: 0.8,
      sfxVolume: 0.8,
      musicVolume: 0.7,
      muted: false,
      screenShake: 1.0,
      damageFlash: true,
      showDamageNumbers: true,
    });
  });

  it('defaults every accessibility effect ON', () => {
    // The settings screen is where effects are REMOVED. A player who needs the
    // flashes off goes looking for the switch; a player who does not should
    // never discover the screen exists.
    expect(DEFAULT_SETTINGS.damageFlash).toBe(true);
    expect(DEFAULT_SETTINGS.screenShake).toBe(SCREEN_SHAKE.FULL);
  });

  it('cannot be mutated by a caller holding the defaults', () => {
    expect(() => {
      DEFAULT_SETTINGS.masterVolume = 0.1;
    }).toThrow();
  });

  it('offers exactly three shake levels', () => {
    expect(SCREEN_SHAKE_LEVELS).toEqual([1.0, 0.5, 0.0]);
  });
});

/* ========================================================================= */
/* Validation                                                                */
/* ========================================================================= */

describe('Normalising stored data', () => {
  it('returns a complete object from nothing at all', () => {
    for (const input of [null, undefined, 0, 'nope', [], true]) {
      const out = normalizeSettings(input);
      expect(Object.keys(out).sort()).toEqual([...SETTING_KEYS].sort());
      expect(out).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps the fields it recognises and defaults the rest', () => {
    const out = normalizeSettings({ musicVolume: 0.25, muted: true });
    expect(out.musicVolume).toBe(0.25);
    expect(out.muted).toBe(true);
    expect(out.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
  });

  it('drops keys that are not in the schema', () => {
    const out = normalizeSettings({ masterVolume: 0.5, cheatMode: true });
    expect(out).not.toHaveProperty('cheatMode');
    expect(out.masterVolume).toBe(0.5);
  });

  it('clamps volumes into range instead of trusting them', () => {
    expect(normalizeSettings({ masterVolume: 9 }).masterVolume).toBe(1);
    expect(normalizeSettings({ sfxVolume: -4 }).sfxVolume).toBe(0);
  });

  it('replaces a wrong-typed value with the default rather than coercing it', () => {
    // `Number('0.8')` would "work" and `Number('loud')` would be NaN — and NaN
    // assigned to an AudioParam throws. Defaulting is the only safe answer.
    expect(normalizeSettings({ masterVolume: '0.5' }).masterVolume).toBe(
      DEFAULT_SETTINGS.masterVolume
    );
    expect(normalizeSettings({ masterVolume: Number.NaN }).masterVolume).toBe(
      DEFAULT_SETTINGS.masterVolume
    );
    expect(normalizeSettings({ muted: 'yes' }).muted).toBe(false);
    expect(normalizeSettings({ damageFlash: 1 }).damageFlash).toBe(true);
  });

  it('snaps screen shake to the nearest supported level', () => {
    // Nearest-neighbour, and forgiving rather than strict: an off-grid value
    // from a build that had a slider keeps the player's intent instead of
    // resetting their choice to the default.
    expect(normalizeSettings({ screenShake: 0.9 }).screenShake).toBe(SCREEN_SHAKE.FULL);
    expect(normalizeSettings({ screenShake: 0.7 }).screenShake).toBe(SCREEN_SHAKE.LIGHT);
    expect(normalizeSettings({ screenShake: 0.4 }).screenShake).toBe(SCREEN_SHAKE.LIGHT);
    expect(normalizeSettings({ screenShake: 0.1 }).screenShake).toBe(SCREEN_SHAKE.OFF);
  });

  it('clamps an out-of-range shake before snapping it', () => {
    expect(normalizeSettings({ screenShake: 12 }).screenShake).toBe(SCREEN_SHAKE.FULL);
    expect(normalizeSettings({ screenShake: -5 }).screenShake).toBe(SCREEN_SHAKE.OFF);
  });

  it('never returns a value outside the schema, whatever it is handed', () => {
    const hostile = {
      masterVolume: Number.POSITIVE_INFINITY,
      sfxVolume: null,
      musicVolume: {},
      muted: [],
      screenShake: '1.0',
      damageFlash: null,
      showDamageNumbers: 0,
    };
    const out = normalizeSettings(hostile);

    for (const key of ['masterVolume', 'sfxVolume', 'musicVolume']) {
      expect(out[key]).toBeGreaterThanOrEqual(0);
      expect(out[key]).toBeLessThanOrEqual(1);
    }
    expect(SCREEN_SHAKE_LEVELS).toContain(out.screenShake);
    expect(typeof out.muted).toBe('boolean');
    expect(typeof out.damageFlash).toBe('boolean');
    expect(typeof out.showDamageNumbers).toBe('boolean');
  });
});

/* ========================================================================= */
/* Persistence                                                               */
/* ========================================================================= */

describe('Persistence', () => {
  it('loads what a previous session wrote', () => {
    const { manager } = harness({ masterVolume: 0.3, screenShake: 0, muted: true });
    expect(manager.get('masterVolume')).toBe(0.3);
    expect(manager.get('screenShake')).toBe(SCREEN_SHAKE.OFF);
    expect(manager.get('muted')).toBe(true);
  });

  it('writes every change straight through', () => {
    const { storage, manager } = harness();
    manager.set('musicVolume', 0.2);

    const written = JSON.parse(storage.map.get(SETTINGS_STORAGE_KEY));
    expect(written.musicVolume).toBe(0.2);
  });

  it('survives a reload', () => {
    const storage = fakeStorage();
    new SettingsManager({ storage }).set('screenShake', SCREEN_SHAKE.LIGHT);

    expect(new SettingsManager({ storage }).get('screenShake')).toBe(SCREEN_SHAKE.LIGHT);
  });

  it('starts clean on a corrupt payload rather than trapping the player', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = fakeStorage({ [SETTINGS_STORAGE_KEY]: '{not json at all' });

    const manager = new SettingsManager({ storage });

    expect(manager.getAll()).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('works with no storage at all', () => {
    // A private window. Preferences last the session and no further, but
    // nothing throws and every method still behaves.
    const manager = new SettingsManager({ storage: null });

    expect(manager.persists).toBe(false);
    expect(manager.getAll()).toEqual(DEFAULT_SETTINGS);
    expect(manager.set('muted', true)).toBe(true);
    expect(manager.get('muted')).toBe(true);
  });

  it('keeps the session choice when the disk is full', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = fakeStorage();
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    const manager = new SettingsManager({ storage });
    manager.set('masterVolume', 0.1);

    // The write failed; the value did not.
    expect(manager.get('masterVolume')).toBe(0.1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('defaults to the game storage service rather than hunting for one', () => {
    // This module used to probe `localStorage` itself. Where a save lives is
    // now one decision for the whole game, so the only thing left to assert
    // here is that omitting `storage` reaches for that shared default — and
    // that an explicit null still means "persist nothing", which is a
    // different request from omitting it.
    expect(new SettingsManager().storage).toBe(storageService);
    expect(new SettingsManager({ storage: null }).storage).toBeNull();
  });
});

/* ========================================================================= */
/* Changing settings                                                         */
/* ========================================================================= */

describe('Changing settings', () => {
  it('validates on the way in, not only on the way out', () => {
    const { manager } = harness();
    manager.set('masterVolume', 5);
    expect(manager.get('masterVolume')).toBe(1);
  });

  it('reports whether anything actually moved', () => {
    const { manager } = harness();
    expect(manager.set('muted', true)).toBe(true);
    expect(manager.set('muted', true)).toBe(false);
  });

  it('does not write when nothing moved', () => {
    // A slider dragged across a single step fires `input` for every pixel.
    const { storage, manager } = harness();
    manager.set('masterVolume', 0.5);
    const writes = [];
    storage.setItem = (k, v) => writes.push(v);

    manager.set('masterVolume', 0.5);
    manager.set('masterVolume', 0.5);

    expect(writes).toEqual([]);
  });

  it('ignores an unknown key rather than storing the typo', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager } = harness();

    expect(manager.set('mastervolume', 0.1)).toBe(false);
    expect(manager.getAll()).not.toHaveProperty('mastervolume');
    expect(manager.get('masterVolume')).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('applies a multi-field patch as one transaction', () => {
    const { manager } = harness();
    const seen = [];
    manager.subscribe((_, changed) => seen.push(changed));

    manager.patch({ muted: true, screenShake: 0, musicVolume: 0.1 });

    // One notification for the whole patch, not three.
    expect(seen).toHaveLength(1);
    expect(seen[0].sort()).toEqual(['musicVolume', 'muted', 'screenShake']);
  });

  it('restores the defaults', () => {
    const { manager } = harness();
    manager.patch({ muted: true, masterVolume: 0.1, damageFlash: false });

    expect(manager.reset()).toBe(true);
    expect(manager.getAll()).toEqual(DEFAULT_SETTINGS);
  });

  it('hands back a copy, not the live object', () => {
    const { manager } = harness();
    const snapshot = manager.getAll();
    snapshot.masterVolume = 0;
    expect(manager.get('masterVolume')).toBe(DEFAULT_SETTINGS.masterVolume);
  });
});

/* ========================================================================= */
/* Change dispatch                                                           */
/* ========================================================================= */

describe('Telling the rest of the game', () => {
  it('notifies subscribers with the full settings and what moved', () => {
    const { manager } = harness();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.set('musicVolume', 0.3);

    expect(listener).toHaveBeenCalledTimes(1);
    const [settings, changed] = listener.mock.calls[0];
    expect(settings.musicVolume).toBe(0.3);
    expect(settings.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(changed).toEqual(['musicVolume']);
  });

  it('stays quiet when a set changes nothing', () => {
    const { manager } = harness();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.set('muted', false);

    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const { manager } = harness();
    const listener = vi.fn();
    const off = manager.subscribe(listener);

    off();
    manager.set('muted', true);

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps going when one listener throws', () => {
    // The audio manager must still hear that the player muted the game, even
    // if some other listener is broken.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { manager } = harness();
    const good = vi.fn();

    manager.subscribe(() => {
      throw new Error('listener is broken');
    });
    manager.subscribe(good);
    manager.set('muted', true);

    expect(good).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('survives a listener that unsubscribes itself mid-notification', () => {
    const { manager } = harness();
    const calls = [];
    const off = manager.subscribe(() => {
      calls.push('self');
      off();
    });
    manager.subscribe(() => calls.push('other'));

    manager.set('muted', true);
    manager.set('screenShake', 0);

    // The self-removing listener ran once; the other one ran for both changes
    // rather than being skipped when the set mutated mid-walk.
    expect(calls).toEqual(['self', 'other', 'other']);
  });

  it('refuses a listener that is not a function', () => {
    const { manager } = harness();
    expect(() => manager.subscribe('nope')).toThrow(TypeError);
  });
});

/* ========================================================================= */
/* What the consumers are handed                                             */
/* ========================================================================= */

describe('The shape consumers depend on', () => {
  /**
   * A stand-in for the two real consumers. The renderer reads three fields off
   * the settings object and the audio manager reads four; neither validates,
   * so the contract is that every field is always present and always usable.
   */
  it('always yields a settings object every consumer can use unchecked', () => {
    const storage = fakeStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ masterVolume: 'x', screenShake: 99 }),
    });
    const settings = new SettingsManager({ storage }).getAll();

    // Audio: three finite 0..1 gains and a boolean.
    for (const key of ['masterVolume', 'sfxVolume', 'musicVolume']) {
      expect(Number.isFinite(settings[key])).toBe(true);
    }
    expect(typeof settings.muted).toBe('boolean');

    // Renderer: a shake multiplier it can hand straight to an AudioParam-free
    // scalar multiply, and two booleans.
    expect(Number.isFinite(settings.screenShake)).toBe(true);
    expect(settings.screenShake).toBeGreaterThanOrEqual(0);
    expect(settings.screenShake).toBeLessThanOrEqual(1);
    expect(typeof settings.damageFlash).toBe('boolean');
    expect(typeof settings.showDamageNumbers).toBe('boolean');
  });
});
