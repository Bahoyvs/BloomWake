/**
 * Audio layer tests.
 *
 * ---------------------------------------------------------------------------
 * WHAT A TEST CAN AND CANNOT SAY ABOUT SOUND
 * ---------------------------------------------------------------------------
 * No test here asserts that anything sounds good — that is a judgement made
 * with ears, and the acceptance criteria for the sound design live in the
 * comments in src/audio/sound-synth.js. What these DO pin down is everything
 * around the sound, which is where the bugs actually are:
 *
 *   - the bridge: does `boss:deflected` reach `playDeflect`, and only that
 *   - the platform controls: does mute() really zero the master gain
 *   - the survival rules: throttle, voice ceiling, suspended context
 *   - the graph: does every synth build a finite, connected, released graph
 *
 * The mock below is a recording AudioContext. It implements enough of the API
 * that a synth runs unmodified against it, and it counts what was built, so a
 * synth that forgets to `stop()` an oscillator — an actual, silent, permanent
 * CPU leak in a browser — fails here instead of in somebody's tab.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../src/core/event-bus.js';
import {
  AudioManager,
  DEFAULT_VOLUMES,
  MAX_VOICES,
  MUSIC_MODES,
  THROTTLE_SEC,
  UNLOCK_EVENTS,
} from '../src/audio/audio-manager.js';
import { SFX, SFX_IDS, playSfx } from '../src/audio/sound-synth.js';
import { MusicSynth, CROSSFADE_SEC, LOOKAHEAD_MS } from '../src/audio/music-synth.js';

/* ========================================================================= */
/* The mock context                                                          */
/* ========================================================================= */

/** An AudioParam that records every scheduled change. */
class MockParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(v, t) {
    this.value = v;
    this.events.push(['set', v, t]);
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.events.push(['linear', v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    // The one rule of exponential ramps: they cannot reach or cross zero. A
    // synth that breaks it throws in Firefox and silently drops the ramp in
    // Chrome, so it has to fail loudly here.
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime cannot target 0');
    this.events.push(['exp', v, t]);
    return this;
  }
  cancelScheduledValues(t) {
    this.events.push(['cancel', null, t]);
    return this;
  }
  setTargetAtTime(v, t, c) {
    this.events.push(['target', v, t, c]);
    return this;
  }
}

class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.connections = [];
    this.disconnected = false;
  }
  connect(target) {
    this.connections.push(target);
    this.ctx.connections += 1;
    return target;
  }
  disconnect() {
    this.disconnected = true;
    this.ctx.disconnections += 1;
  }
}

class MockSource extends MockNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = null;
    this.stopped = null;
    this.onended = null;
  }
  start(when = 0, offset) {
    this.started = when;
    this.offset = offset;
    this.ctx.started.push(this);
  }
  stop(when = 0) {
    this.stopped = when;
    this.ctx.stopped.push(this);
  }
}

/** A recording stand-in for BaseAudioContext. */
class MockAudioContext {
  constructor({ state = 'running', sampleRate = 44100 } = {}) {
    this.state = state;
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = new MockNode(this, 'destination');

    this.created = [];
    this.started = [];
    this.stopped = [];
    this.connections = 0;
    this.disconnections = 0;
    this.resumeCalls = 0;
    this.suspendCalls = 0;
  }

  track(node) {
    this.created.push(node);
    return node;
  }

  createGain() {
    const node = this.track(new MockNode(this, 'gain'));
    node.gain = new MockParam(1);
    return node;
  }

  createOscillator() {
    const node = this.track(new MockSource(this, 'oscillator'));
    node.type = 'sine';
    node.frequency = new MockParam(440);
    node.detune = new MockParam(0);
    return node;
  }

  createBufferSource() {
    const node = this.track(new MockSource(this, 'bufferSource'));
    node.buffer = null;
    node.loop = false;
    node.playbackRate = new MockParam(1);
    return node;
  }

  createBiquadFilter() {
    const node = this.track(new MockNode(this, 'filter'));
    node.type = 'lowpass';
    node.frequency = new MockParam(350);
    node.Q = new MockParam(1);
    node.gain = new MockParam(0);
    return node;
  }

  createStereoPanner() {
    const node = this.track(new MockNode(this, 'panner'));
    node.pan = new MockParam(0);
    return node;
  }

  createWaveShaper() {
    const node = this.track(new MockNode(this, 'shaper'));
    node.curve = null;
    node.oversample = 'none';
    return node;
  }

  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return {
      length,
      sampleRate: rate,
      numberOfChannels: channels,
      getChannelData: () => data,
    };
  }

  resume() {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  suspend() {
    this.suspendCalls += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }

  /** Advance the audio clock, the way a real context does on its own. */
  advance(seconds) {
    this.currentTime += seconds;
  }
}

/**
 * A manager wired to a fresh mock context and a fresh bus.
 * @param {Object} [options]
 */
function harness(options = {}) {
  const ctx = new MockAudioContext(options.context);
  const bus = new EventBus();
  const manager = new AudioManager({
    contextFactory: () => ctx,
    // The score's timer is never wanted in a test: it would schedule notes
    // into every later assertion about what got built.
    musicOptions: { setInterval: () => 1, clearInterval: () => {} },
    ...options.manager,
  });
  manager.init();
  return { ctx, bus, manager };
}

/* ========================================================================= */
/* The sound palette                                                         */
/* ========================================================================= */

describe('Procedural SFX', () => {
  it('has a synth for every id the manager can dispatch', () => {
    expect(SFX_IDS.length).toBeGreaterThan(0);
    for (const id of SFX_IDS) expect(typeof SFX[id]).toBe('function');
  });

  it('names every sound the brief calls for', () => {
    const required = [
      'laser_repeater',
      'nova_flak',
      'tesla_arc',
      'missile_launch',
      'afterburner',
      'phase_shift',
      'singularity',
      'emp_blast',
      'boss_inbound',
      'armor_deflect',
      'part_destroyed',
      'rammer_lock',
      'ui_click',
      'card_pop',
      'crate_rattle',
      'crate_blast',
    ];
    for (const id of required) expect(SFX_IDS).toContain(id);
  });

  it.each(SFX_IDS)('%s builds a finite, playable graph', (id) => {
    const ctx = new MockAudioContext();
    const out = ctx.createGain();

    const result = SFX[id](ctx, out, {});

    expect(result.duration).toBeGreaterThan(0);
    expect(Number.isFinite(result.duration)).toBe(true);
    expect(ctx.started.length).toBeGreaterThan(0);
    expect(ctx.connections).toBeGreaterThan(0);
  });

  it.each(SFX_IDS)('%s stops every source it starts', (id) => {
    // An oscillator that is started and never stopped runs for the lifetime of
    // the context. Twenty minutes of shooting makes that a dead tab.
    const ctx = new MockAudioContext();
    SFX[id](ctx, ctx.createGain(), {});

    for (const source of ctx.started) {
      expect(source.stopped, `${id}: a ${source.kind} was never stopped`).not.toBeNull();
      expect(source.stopped).toBeGreaterThanOrEqual(source.started);
    }
  });

  it.each(SFX_IDS)('%s releases its graph when it ends', (id) => {
    const ctx = new MockAudioContext();
    SFX[id](ctx, ctx.createGain(), {});

    // At least one source has to carry the teardown, or the nodes stay
    // connected to the bus forever.
    const releasing = ctx.started.filter((s) => typeof s.onended === 'function');
    expect(releasing.length).toBeGreaterThan(0);

    for (const source of releasing) source.onended();
    expect(ctx.disconnections).toBeGreaterThan(0);
  });

  it.each(SFX_IDS)('%s releases its output stage only after its longest voice', (id) => {
    // The bug this exists for: hanging the output stage's teardown off a short
    // layer disconnects the gain everything else is playing through, which
    // truncates the long voices mid-decay. It is inaudible in a unit test and
    // very audible in the game, so the invariant is checked structurally —
    // whichever source carries the teardown must outlast every other source.
    const ctx = new MockAudioContext();
    const out = ctx.createGain();
    SFX[id](ctx, out, {});

    const lastStop = Math.max(...ctx.stopped.map((s) => s.stopped));
    const releasers = ctx.started.filter((s) => typeof s.onended === 'function');
    const lastRelease = Math.max(...releasers.map((s) => s.stopped));

    expect(lastRelease).toBeCloseTo(lastStop, 6);
  });

  it.each(SFX_IDS)('%s reports a duration covering everything it scheduled', (id) => {
    // The voice pool budgets on this number. Under-reporting it hands the slot
    // back while the sound is still playing, so the ceiling stops holding.
    const ctx = new MockAudioContext();
    const { duration } = SFX[id](ctx, ctx.createGain(), {});
    const lastStop = Math.max(...ctx.stopped.map((s) => s.stopped));

    expect(duration).toBeGreaterThanOrEqual(lastStop - ctx.currentTime - 1e-6);
  });

  it('scales frequencies with the pitch parameter', () => {
    const low = new MockAudioContext();
    const high = new MockAudioContext();
    SFX.laser_repeater(low, low.createGain(), { pitch: 1 });
    SFX.laser_repeater(high, high.createGain(), { pitch: 2 });

    const startOf = (ctx) =>
      ctx.created.find((n) => n.kind === 'oscillator').frequency.events[0][1];

    expect(startOf(high)).toBeCloseTo(startOf(low) * 2);
  });

  it('carries the gain parameter on the output stage', () => {
    const ctx = new MockAudioContext();
    const out = ctx.createGain();
    SFX.ui_click(ctx, out, { gain: 0.25 });

    const gains = ctx.created.filter((n) => n.kind === 'gain');
    expect(gains.some((g) => g.gain.value === 0.25)).toBe(true);
  });

  it('pans through a StereoPanner when one is asked for', () => {
    const ctx = new MockAudioContext();
    SFX.ui_click(ctx, ctx.createGain(), { pan: -0.6 });

    const panner = ctx.created.find((n) => n.kind === 'panner');
    expect(panner).toBeDefined();
    expect(panner.pan.value).toBeCloseTo(-0.6);
  });

  it('still plays when the browser has no StereoPanner', () => {
    // Old Safari. Losing the stereo image is acceptable; losing the sound is not.
    const ctx = new MockAudioContext();
    ctx.createStereoPanner = undefined;

    expect(() => SFX.phase_shift(ctx, ctx.createGain(), { pan: 0.9 })).not.toThrow();
    expect(ctx.started.length).toBeGreaterThan(0);
  });

  it('shares one noise buffer per context instead of rebuilding it per shot', () => {
    // Rendering two seconds of noise per gunshot would allocate megabytes a
    // minute; the cache is what makes noise-based sounds free after the first.
    const ctx = new MockAudioContext();
    const spy = vi.spyOn(ctx, 'createBuffer');

    for (let i = 0; i < 10; i += 1) SFX.nova_flak(ctx, ctx.createGain(), {});

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unknown id rather than throwing', () => {
    const ctx = new MockAudioContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(playSfx('no_such_sound', ctx, ctx.createGain())).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/* ========================================================================= */
/* Acoustic calibration                                                      */
/* ========================================================================= */
/*
 * The palette was retuned after the first version came out too bright: a
 * sawtooth laser at 900Hz, 5kHz noise bursts and 4.7kHz deflection partials,
 * all firing several times a second. The result was listening fatigue within a
 * single run, which is a design failure even though every individual sound was
 * "correct".
 *
 * These lock in the fix. They are blunt on purpose — a frequency ceiling is
 * exactly the kind of thing that creeps back one sound at a time while
 * everybody is looking at something else.
 */

/** Every frequency a sound schedules, on oscillators and on filters alike. */
function scheduledFrequencies(id) {
  const ctx = new MockAudioContext();
  SFX[id](ctx, ctx.createGain(), {});

  const values = [];
  for (const node of ctx.created) {
    if (!node.frequency) continue;
    values.push(node.frequency.value);
    for (const [, value] of node.frequency.events) {
      if (typeof value === 'number') values.push(value);
    }
  }
  return values.filter((v) => Number.isFinite(v) && v > 0);
}

describe('Nothing in the palette sits in the harsh band', () => {
  /**
   * Where listening fatigue is manufactured. Human hearing peaks in
   * sensitivity around 2-5kHz, so a sound that repeats dozens of times a
   * minute must not put its fundamental or its filter cutoff up there.
   */
  const HARSH_HZ = 2500;

  it.each(SFX_IDS)('%s schedules no frequency above the harsh band', (id) => {
    const above = scheduledFrequencies(id).filter((hz) => hz > HARSH_HZ);
    expect(above).toEqual([]);
  });

  it('never reaches for a highpass, which by definition has no ceiling', () => {
    // A highpass passes everything above its cutoff — on white noise, that is
    // every frequency the buffer has. Every filter in the palette is a lowpass
    // or a bandpass so that something is always being taken off the top.
    for (const id of SFX_IDS) {
      const ctx = new MockAudioContext();
      SFX[id](ctx, ctx.createGain(), {});
      const types = ctx.created.filter((n) => n.kind === 'filter').map((n) => n.type);
      expect(types, `${id} uses a highpass`).not.toContain('highpass');
    }
  });

  it('puts the repeated sounds lowest of all', () => {
    // The weapon, the kill and the pickup fire more than everything else
    // combined, so they get the tightest ceiling in the palette.
    for (const id of ['laser_repeater', 'enemy_pop', 'orb_pickup', 'player_hit']) {
      const peak = Math.max(...scheduledFrequencies(id));
      expect(peak, `${id} peaks at ${peak}Hz`).toBeLessThanOrEqual(1600);
    }
  });
});

describe('The retuned sounds keep their weight', () => {
  /** Does this sound schedule anything in the body band? */
  const hasBody = (id) =>
    scheduledFrequencies(id).some((hz) => hz >= 30 && hz <= 400);

  it.each([
    'laser_repeater',
    'nova_flak',
    'enemy_pop',
    'player_hit',
    'armor_deflect',
  ])('%s carries low-mid weight to replace the lost top end', (id) => {
    // Darkening a sound without adding body just makes it quieter. Each of
    // these gained a sub or low-mid layer when its highs came off.
    expect(hasBody(id)).toBe(true);
  });

  it('gives the repeater a sub-thump on the attack', () => {
    const ctx = new MockAudioContext();
    SFX.laser_repeater(ctx, ctx.createGain(), {});

    const oscillators = ctx.created.filter((n) => n.kind === 'oscillator');
    const thump = oscillators.find((o) => o.frequency.events[0]?.[1] === 120);

    expect(thump).toBeDefined();
    // Short enough to fuse with the sweep into one percussive event.
    expect(thump.stopped - thump.started).toBeLessThanOrEqual(0.03);
  });

  it('sweeps the repeater down into the bass, not across the mids', () => {
    const ctx = new MockAudioContext();
    SFX.laser_repeater(ctx, ctx.createGain(), {});

    const sweep = ctx.created.find((n) => n.kind === 'oscillator').frequency.events;
    expect(sweep[0][1]).toBe(480);
    expect(sweep[1][1]).toBe(95);
  });

  it('damps the deflection inside 150ms', () => {
    // An undamped metallic ring accumulates: a boss fight is a deflection
    // every few frames, and ten overlapping bells are a chord.
    const { duration } = SFX.armor_deflect(new MockAudioContext(), null, {});
    expect(duration).toBeLessThanOrEqual(0.15);
  });

  it('leads the kill with the thud rather than the crack', () => {
    const ctx = new MockAudioContext();
    SFX.enemy_pop(ctx, ctx.createGain(), {});

    const noise = ctx.created.find((n) => n.kind === 'bufferSource');
    const thud = ctx.created.find((n) => n.kind === 'oscillator');

    // The noise is a transient behind the body, not the body itself.
    expect(noise.stopped - noise.started).toBeLessThanOrEqual(0.05);
    expect(thud.stopped - thud.started).toBeGreaterThan(noise.stopped - noise.started);
  });

  it('keeps the pickup a pure sine with no harmonics to shave', () => {
    const ctx = new MockAudioContext();
    SFX.orb_pickup(ctx, ctx.createGain(), {});

    const oscillators = ctx.created.filter((n) => n.kind === 'oscillator');
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].type).toBe('sine');
    expect(oscillators[0].frequency.events[0][1]).toBe(520);
  });
});

describe('Envelope safety', () => {
  it.each(SFX_IDS)('%s never ramps exponentially to zero', (id) => {
    // The mock throws on a zero target, so reaching this line at all is the
    // assertion. Kept explicit because it is the one Web Audio rule that fails
    // differently in every engine.
    const ctx = new MockAudioContext();
    expect(() => SFX[id](ctx, ctx.createGain(), {})).not.toThrow();
  });

  it('holds the 1e-4 floor rather than rounding to zero', () => {
    const ctx = new MockAudioContext();
    SFX.ui_click(ctx, ctx.createGain(), {});

    const targets = ctx.created
      .filter((n) => n.kind === 'gain')
      .flatMap((n) => n.gain.events)
      .filter(([kind]) => kind === 'exp')
      .map(([, value]) => value);

    expect(targets.length).toBeGreaterThan(0);
    for (const value of targets) expect(value).toBeGreaterThanOrEqual(1e-4);
  });
});

/* ========================================================================= */
/* The event bridge                                                          */
/* ========================================================================= */

describe('Simulation events reach the right sound', () => {
  /** @type {ReturnType<typeof harness>} */
  let h;

  beforeEach(() => {
    h = harness();
    h.manager.connect(h.bus);
  });

  const cases = [
    ['boss:deflected', 'playDeflect'],
    ['boss:part_destroyed', 'playPartDestroyed'],
    ['boss:phase', 'playPhaseShiftWarning'],
    ['enemy:lock_on', 'playLockOnAlert'],
    ['crate:open', 'playCrateRattle'],
    ['crate:blast', 'playCrateBlast'],
    ['boss:spawned', 'playBossInbound'],
    ['enemy:death', 'playEnemyDeath'],
    ['player:damage', 'playPlayerHit'],
    ['player:level_up', 'playLevelUp'],
    ['orb:collected', 'playOrbPickup'],
    ['draft:offer', 'playCardPop'],
    ['card:selected', 'playUiClick'],
  ];

  it.each(cases)('%s triggers %s', (event, method) => {
    const spy = vi.spyOn(h.manager, method);
    h.bus.emit(event, {});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('routes each weapon event to its own sound', () => {
    const spy = vi.spyOn(h.manager, 'playWeapon');

    h.bus.emit('weapon:fire', {});
    h.bus.emit('weapon:chain_lightning', {});
    h.bus.emit('card:burst', {});
    h.bus.emit('card:nanite_launch', {});

    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      'laser_repeater',
      'tesla_arc',
      'nova_flak',
      'missile_launch',
    ]);
  });

  it('plays the cast skill, not a generic skill sound', () => {
    const spy = vi.spyOn(h.manager, 'play');

    h.bus.emit('skill:cast', { skillId: 'singularity_anchor' });
    expect(spy).toHaveBeenCalledWith('singularity', expect.any(Object));

    h.ctx.advance(3);
    spy.mockClear();
    h.bus.emit('skill:cast', { skillId: 'phase_shift' });
    expect(spy).toHaveBeenCalledWith('phase_shift', expect.any(Object));
  });

  it('accepts skill:trigger as well as skill:cast', () => {
    const spy = vi.spyOn(h.manager, 'playSkill');
    h.bus.emit('skill:trigger', { skillId: 'afterburner' });
    expect(spy).toHaveBeenCalledWith('afterburner');
  });

  it('falls back to a stand-in for a skill nobody has given a sound', () => {
    const spy = vi.spyOn(h.manager, 'play');
    h.bus.emit('skill:cast', { skillId: 'skill_from_the_future' });
    expect(spy).toHaveBeenCalledWith('emp_blast', expect.any(Object));
  });

  it('does not fire a sound for an event it was never given', () => {
    const spy = vi.spyOn(h.manager, 'play');
    h.bus.emit('enemy:damaged', {});
    h.bus.emit('wave:spawn_closed', {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops listening after disconnect', () => {
    const spy = vi.spyOn(h.manager, 'playDeflect');
    h.manager.disconnect();
    h.bus.emit('boss:deflected', {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('survives a bus that has already been cleared', () => {
    h.bus.clear();
    expect(() => h.manager.disconnect()).not.toThrow();
  });
});

/* ========================================================================= */
/* Music intensity                                                           */
/* ========================================================================= */

describe('Score intensity follows the run', () => {
  /** @type {ReturnType<typeof harness>} */
  let h;

  beforeEach(() => {
    h = harness();
    h.manager.connect(h.bus);
  });

  it('starts in ambient', () => {
    expect(h.manager.musicMode).toBe(MUSIC_MODES.AMBIENT);
  });

  it('goes to combat when a wave starts', () => {
    h.bus.emit('wave:start', { wave: 1 });
    expect(h.manager.musicMode).toBe(MUSIC_MODES.COMBAT);
  });

  it('goes to boss when a boss arrives, and stays there for the wave', () => {
    h.bus.emit('wave:start', { wave: 5 });
    h.bus.emit('boss:spawned', { wave: 5 });
    expect(h.manager.musicMode).toBe(MUSIC_MODES.BOSS);

    // The boss's own phase changes must not knock the score back down.
    h.bus.emit('boss:phase', { phase: 2 });
    expect(h.manager.musicMode).toBe(MUSIC_MODES.BOSS);
  });

  it('returns to ambient when the run ends, either way', () => {
    h.bus.emit('boss:spawned', {});
    h.bus.emit('game:over', {});
    expect(h.manager.musicMode).toBe(MUSIC_MODES.AMBIENT);

    h.bus.emit('wave:start', {});
    h.bus.emit('game:victory', {});
    expect(h.manager.musicMode).toBe(MUSIC_MODES.AMBIENT);
  });
});

describe('MusicSynth', () => {
  /** Build a synth with an inspectable timer. */
  function musicHarness() {
    const ctx = new MockAudioContext();
    const out = ctx.createGain();
    const ticks = [];
    const music = new MusicSynth(ctx, out, {
      setInterval: (fn, ms) => {
        ticks.push({ fn, ms });
        return ticks.length;
      },
      clearInterval: () => ticks.pop(),
    });
    return { ctx, music, ticks, tick: () => ticks[0]?.fn() };
  }

  it('builds one gain per layer, all on the music bus', () => {
    const { music } = musicHarness();
    for (const layer of ['pad', 'bass', 'arp', 'drive', 'drums']) {
      expect(music.layers[layer]).toBeDefined();
      expect(music.layers[layer].gain.value).toBe(0);
    }
  });

  it('schedules notes ahead of the audio clock rather than on the timer', () => {
    const { ctx, music, tick } = musicHarness();
    music.start();
    tick();

    // Everything scheduled is in the future and inside the lookahead window.
    expect(ctx.started.length).toBeGreaterThan(0);
    for (const source of ctx.started) {
      expect(source.started).toBeGreaterThanOrEqual(ctx.currentTime);
      expect(source.started).toBeLessThan(ctx.currentTime + 1);
    }
  });

  it('runs its timer at the lookahead interval', () => {
    const { music, ticks } = musicHarness();
    music.start();
    expect(ticks[0].ms).toBe(LOOKAHEAD_MS);
  });

  it('crossfades over 1.2 seconds instead of cutting', () => {
    const { ctx, music } = musicHarness();
    music.start();
    ctx.advance(1);
    music.setMode(MUSIC_MODES.BOSS);

    const ramps = music.layers.drums.gain.events.filter((e) => e[0] === 'linear');
    const last = ramps[ramps.length - 1];
    expect(last[1]).toBeGreaterThan(0);
    expect(last[2] - ctx.currentTime).toBeCloseTo(CROSSFADE_SEC, 5);
  });

  it('keeps the pad audible in every mode', () => {
    // The pad is the harmonic bed; dropping it is audible as the floor
    // disappearing even when louder layers arrive.
    const { music } = musicHarness();
    music.start();
    for (const mode of Object.values(MUSIC_MODES)) {
      music.setMode(mode);
      expect(music.levels.pad).toBeGreaterThan(0);
    }
  });

  it('skips the work for layers that are silent', () => {
    const { ctx, music, tick } = musicHarness();
    music.start();
    // Only pad and bass have level in ambient, so no square-wave arp voice
    // should be built at all.
    tick();
    const built = ctx.created.filter((n) => n.kind === 'oscillator' && n.type === 'square');
    expect(built).toHaveLength(0);
  });

  it('plays the arpeggio once combat is up', () => {
    const { ctx, music, tick } = musicHarness();
    music.start();
    music.setMode(MUSIC_MODES.COMBAT, 0);
    tick();
    const arp = ctx.created.filter((n) => n.kind === 'oscillator' && n.type === 'square');
    expect(arp.length).toBeGreaterThan(0);
  });

  it('speeds up with intensity', () => {
    const { music } = musicHarness();
    music.setMode(MUSIC_MODES.AMBIENT);
    const ambient = music.stepDuration;
    music.setMode(MUSIC_MODES.COMBAT);
    const combat = music.stepDuration;
    music.setMode(MUSIC_MODES.BOSS);

    expect(combat).toBeLessThan(ambient);
    expect(music.stepDuration).toBeLessThan(combat);
  });

  it('catches the transport up after a backgrounded tab instead of dumping a wall of notes', () => {
    const { ctx, music, tick } = musicHarness();
    music.start();
    music.setMode(MUSIC_MODES.BOSS, 0);
    ctx.advance(600); // ten minutes in another tab
    tick();

    // At 150 BPM, ten minutes is ~6000 steps. Only the lookahead window's
    // worth may actually be scheduled.
    expect(ctx.started.length).toBeLessThan(40);
    expect(music.nextNoteTime).toBeGreaterThanOrEqual(ctx.currentTime);
  });

  it('is idempotent on start and stop', () => {
    const { music, ticks } = musicHarness();
    music.start();
    music.start();
    expect(ticks).toHaveLength(1);

    music.stop();
    music.stop();
    expect(music.running).toBe(false);
  });

  it('fades out on stop rather than cutting mid-note', () => {
    const { music } = musicHarness();
    music.start();
    music.stop();
    for (const layer of Object.values(music.layers)) {
      const ramps = layer.gain.events.filter((e) => e[0] === 'linear');
      expect(ramps[ramps.length - 1][1]).toBe(0);
    }
  });
});

/* ========================================================================= */
/* Platform controls                                                         */
/* ========================================================================= */

describe('Platform controls', () => {
  it('zeroes the master gain on mute', () => {
    const { manager } = harness();
    expect(manager.masterGain.gain.value).toBe(DEFAULT_VOLUMES.master);

    manager.mute();

    expect(manager.masterGain.gain.value).toBe(0);
    expect(manager.isMuted()).toBe(true);
  });

  it('restores the master volume on unmute', () => {
    const { manager } = harness();
    manager.setMasterVolume(0.6);
    manager.mute();
    manager.unmute();

    expect(manager.masterGain.gain.value).toBeCloseTo(0.6);
    expect(manager.isMuted()).toBe(false);
  });

  it('plays nothing at all while muted', () => {
    const { ctx, manager } = harness();
    manager.mute();
    const before = ctx.started.length;

    expect(manager.play('crate_blast')).toBe(false);
    expect(ctx.started.length).toBe(before);
  });

  it('toggles', () => {
    const { manager } = harness();
    expect(manager.toggleMute()).toBe(true);
    expect(manager.toggleMute()).toBe(false);
    expect(manager.masterGain.gain.value).toBeCloseTo(DEFAULT_VOLUMES.master);
  });

  it('remembers a volume set while muted without un-muting', () => {
    // The settings slider and the ad mute are independent controls; moving one
    // must not release the other.
    const { manager } = harness();
    manager.mute();
    manager.setMasterVolume(0.4);

    expect(manager.masterGain.gain.value).toBe(0);
    manager.unmute();
    expect(manager.masterGain.gain.value).toBeCloseTo(0.4);
  });

  it('moves the SFX and music buses independently', () => {
    const { manager } = harness();
    manager.setSfxVolume(0.25);
    manager.setMusicVolume(0.75);

    expect(manager.sfxGain.gain.value).toBeCloseTo(0.25);
    expect(manager.musicGain.gain.value).toBeCloseTo(0.75);
    expect(manager.masterGain.gain.value).toBeCloseTo(DEFAULT_VOLUMES.master);
  });

  it('clamps volumes to 0..1, including nonsense', () => {
    const { manager } = harness();
    manager.setMasterVolume(9);
    expect(manager.getVolumes().master).toBe(1);
    manager.setMasterVolume(-3);
    expect(manager.getVolumes().master).toBe(0);
    manager.setMasterVolume(Number.NaN);
    expect(manager.getVolumes().master).toBe(0);
  });

  it('hands back a copy of the volumes, not the live object', () => {
    const { manager } = harness();
    const snapshot = manager.getVolumes();
    snapshot.master = 0.01;
    expect(manager.getVolumes().master).toBe(DEFAULT_VOLUMES.master);
  });
});

/* ========================================================================= */
/* The autoplay unlock                                                       */
/* ========================================================================= */

describe('Autoplay unlock', () => {
  /** A minimal EventTarget that records what is bound to it. */
  function fakeTarget() {
    const handlers = new Map();
    return {
      handlers,
      addEventListener: (type, fn) => handlers.set(type, fn),
      removeEventListener: (type) => handlers.delete(type),
      fire: (type) => handlers.get(type)?.(),
    };
  }

  it('resumes a suspended context on the first gesture', async () => {
    const ctx = new MockAudioContext({ state: 'suspended' });
    const manager = new AudioManager({
      contextFactory: () => ctx,
      musicOptions: { setInterval: () => 1, clearInterval: () => {} },
    });
    manager.init();
    expect(manager.unlocked).toBe(false);

    const target = fakeTarget();
    manager.attachUnlock(target);
    target.fire('pointerdown');
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
    expect(manager.unlocked).toBe(true);
  });

  it('listens for a key press and a touch as well as a click', () => {
    const { manager } = harness({ context: { state: 'suspended' } });
    const target = fakeTarget();
    manager.attachUnlock(target);

    // Asserted against the exported list rather than a copy of it: the game is
    // playable with pointer, touch or keyboard, and iOS additionally needs a
    // completed `touchend` before WebKit will honour a resume, so the set is
    // expected to grow. What must stay true is that every listed gesture is
    // actually bound.
    expect([...target.handlers.keys()].sort()).toEqual([...UNLOCK_EVENTS].sort());
    expect(UNLOCK_EVENTS).toContain('touchend');
  });

  it('detaches once the context is actually running', async () => {
    const ctx = new MockAudioContext({ state: 'suspended' });
    const manager = new AudioManager({
      contextFactory: () => ctx,
      musicOptions: { setInterval: () => 1, clearInterval: () => {} },
    });
    manager.init();

    const target = fakeTarget();
    manager.attachUnlock(target);
    target.fire('keydown');
    await Promise.resolve();
    await Promise.resolve();

    expect(target.handlers.size).toBe(0);
  });

  it('keeps listening when a resume is refused', async () => {
    // Safari rejects a resume that is not inside a real gesture. Spending the
    // listener on that first attempt is how a game ends up permanently silent.
    const ctx = new MockAudioContext({ state: 'suspended' });
    ctx.resume = () => {
      ctx.resumeCalls += 1;
      return Promise.reject(new Error('not allowed'));
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = new AudioManager({
      contextFactory: () => ctx,
      musicOptions: { setInterval: () => 1, clearInterval: () => {} },
    });
    manager.init();

    const target = fakeTarget();
    manager.attachUnlock(target);
    target.fire('pointerdown');
    await Promise.resolve();
    await Promise.resolve();

    expect(target.handlers.size).toBe(UNLOCK_EVENTS.length);
    expect(manager.unlocked).toBe(false);
    warn.mockRestore();
  });

  it('starts the score on unlock', async () => {
    const { manager } = harness({ context: { state: 'suspended' } });
    expect(manager.music.running).toBe(false);

    await manager.unlock();

    expect(manager.music.running).toBe(true);
  });

  it('drops sounds triggered while the context is still suspended', () => {
    // A suspended context accepts scheduling and replays the backlog on
    // resume — a burst of stale sound at the worst possible moment.
    const { ctx, manager } = harness({ context: { state: 'suspended' } });
    expect(manager.play('ui_click')).toBe(false);
    expect(ctx.started).toHaveLength(0);
  });
});

/* ========================================================================= */
/* Survival rules                                                            */
/* ========================================================================= */

describe('Voice pooling and throttling', () => {
  it('refuses to retrigger the same sound inside its throttle window', () => {
    const { ctx, manager } = harness();

    expect(manager.play('laser_repeater')).toBe(true);
    expect(manager.play('laser_repeater')).toBe(false);

    ctx.advance(THROTTLE_SEC.laser_repeater + 0.001);
    expect(manager.play('laser_repeater')).toBe(true);
  });

  it('throttles each sound on its own clock', () => {
    const { manager } = harness();
    expect(manager.play('laser_repeater')).toBe(true);
    expect(manager.play('nova_flak')).toBe(true);
  });

  it('caps concurrent voices', () => {
    const { manager } = harness();
    // singularity is unthrottled and 2.2s long, so the ceiling is what stops it.
    let played = 0;
    for (let i = 0; i < MAX_VOICES * 2; i += 1) {
      if (manager.play('singularity')) played += 1;
    }
    expect(played).toBe(MAX_VOICES);
  });

  it('lets priority sounds through a full voice pool', () => {
    // An alarm the player has to react to must not be lost to a swarm death.
    const { manager } = harness();
    for (let i = 0; i < MAX_VOICES * 2; i += 1) manager.play('singularity');

    expect(manager.play('boss_inbound')).toBe(true);
    expect(manager.play('crate_blast')).toBe(true);
  });

  it('frees voices as they finish', () => {
    const { ctx, manager } = harness();
    for (let i = 0; i < MAX_VOICES; i += 1) manager.play('singularity');
    expect(manager.play('singularity')).toBe(false);

    ctx.advance(5);
    expect(manager.play('singularity')).toBe(true);
  });

  it('varies pitch between repeats of the same sound', () => {
    // Ten identical laser shots in a row stop reading as gunfire.
    const { ctx, manager } = harness();
    const pitches = new Set();

    for (let i = 0; i < 12; i += 1) {
      ctx.advance(0.1);
      manager.play('laser_repeater');
    }
    for (const node of ctx.created) {
      if (node.kind === 'oscillator' && node.frequency.events.length > 0) {
        pitches.add(node.frequency.events[0][1]);
      }
    }

    expect(pitches.size).toBeGreaterThan(1);
  });

  it('ignores an unknown sound id', () => {
    const { manager } = harness();
    expect(manager.play('not_a_sound')).toBe(false);
  });
});

/* ========================================================================= */
/* Failure paths                                                             */
/* ========================================================================= */

describe('A browser that will not give us audio', () => {
  it('reports failure from init instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new AudioManager({
      contextFactory: () => {
        throw new Error('no Web Audio here');
      },
    });

    expect(manager.init()).toBe(false);
    expect(manager.ready).toBe(false);
    warn.mockRestore();
  });

  it('handles a factory that simply returns nothing', () => {
    const manager = new AudioManager({ contextFactory: () => null });
    expect(manager.init()).toBe(false);
  });

  it('leaves every public method a safe no-op with no context', () => {
    const manager = new AudioManager({ contextFactory: () => null });
    const bus = new EventBus();
    manager.connect(bus);

    expect(() => {
      manager.play('crate_blast');
      manager.playDeflect();
      manager.playSkill('afterburner');
      manager.setMusicMode(MUSIC_MODES.BOSS);
      manager.startMusic();
      manager.stopMusic();
      manager.mute();
      manager.unmute();
      manager.setMasterVolume(0.5);
      manager.setSfxVolume(0.5);
      manager.setMusicVolume(0.5);
      manager.dispose();
      // The whole simulation firing into a manager that has no audio at all.
      bus.emit('boss:deflected', {});
      bus.emit('boss:spawned', {});
      bus.emit('crate:blast', {});
    }).not.toThrow();

    expect(manager.musicMode).toBeNull();
  });

  it('does not build a second context on a repeated init', () => {
    const factory = vi.fn(() => new MockAudioContext());
    const manager = new AudioManager({
      contextFactory: factory,
      musicOptions: { setInterval: () => 1, clearInterval: () => {} },
    });

    manager.init();
    manager.init();
    manager.init();

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('tears down cleanly', () => {
    const { bus, manager } = harness();
    manager.connect(bus);
    manager.dispose();

    expect(manager.ready).toBe(false);
    expect(manager.subscriptions).toHaveLength(0);
    expect(() => bus.emit('boss:deflected', {})).not.toThrow();
  });
});
