/**
 * Dynamic retro-arcade score, played live by oscillators.
 *
 * ---------------------------------------------------------------------------
 * THREE LAYERS, ONE TRACK
 * ---------------------------------------------------------------------------
 * There is no "menu theme" and no "boss theme" — there is ONE piece of music
 * with three layers, and intensity is which layers are audible:
 *
 *   ambient  95 BPM  pad + slow root bass          menu, hangar, debrief
 *   combat  125 BPM  walking bass + 16th arpeggio  a wave is running
 *   boss    150 BPM  distorted bass + kick drum    a boss is on the field
 *
 * Layers do not replace each other, they ACCUMULATE: combat keeps the pad,
 * boss keeps the arpeggio. That is what makes a boss arrival feel like the
 * existing music getting worse rather than a different track starting, and it
 * is the whole reason this is a synth and not three audio files.
 *
 * ---------------------------------------------------------------------------
 * WHY A LOOKAHEAD SCHEDULER AND NOT setInterval PER NOTE
 * ---------------------------------------------------------------------------
 * `setTimeout` in a game tab is accurate to tens of milliseconds at best and
 * to whole seconds when the tab is backgrounded — as rhythm, that is unusable.
 * So the timer never plays a note. It wakes every LOOKAHEAD_MS, asks the audio
 * clock what time it is, and SCHEDULES every note falling inside the next
 * SCHEDULE_AHEAD seconds at its exact sample position. The timing then comes
 * from the audio hardware and jitter in the timer changes nothing.
 *
 * This is the standard Web Audio pattern (Chris Wilson's "A Tale of Two
 * Clocks"), and the two constants are its only tuning: the window has to be
 * comfortably wider than the timer's worst case, and short enough that a mode
 * change is heard within a beat or so.
 *
 * ---------------------------------------------------------------------------
 * PURE OF DOM, LIKE THE REST OF THE AUDIO LAYER
 * ---------------------------------------------------------------------------
 * Takes a context, a destination and (optionally) its own timer functions. It
 * never reads the simulation — `setMode` is called by the event bridge, and
 * this module has no opinion about what a wave or a boss is.
 */

const SILENT = 0.0001;

/** How often the scheduling timer wakes. */
export const LOOKAHEAD_MS = 25;

/** How far ahead of the audio clock notes are scheduled, in seconds. */
export const SCHEDULE_AHEAD = 0.18;

/** Crossfade between intensity modes, in seconds. */
export const CROSSFADE_SEC = 1.2;

/** The intensity modes, in ascending order of trouble. */
export const MUSIC_MODES = {
  AMBIENT: 'ambient',
  COMBAT: 'combat',
  BOSS: 'boss',
};

/**
 * Which layers are audible in each mode, and how loud.
 *
 * The pad never leaves. It is the harmonic bed the other two layers are tuned
 * against, and dropping it on a mode change is audible as the floor falling
 * out even when everything above it gets louder.
 */
const MIX = {
  [MUSIC_MODES.AMBIENT]: { pad: 0.5, bass: 0.32, arp: 0.0, drive: 0.0, drums: 0.0 },
  [MUSIC_MODES.COMBAT]: { pad: 0.26, bass: 0.42, arp: 0.3, drive: 0.0, drums: 0.0 },
  [MUSIC_MODES.BOSS]: { pad: 0.2, bass: 0.22, arp: 0.34, drive: 0.4, drums: 0.5 },
};

/** Tempo per mode. The scheduler reads the live mode's value every step. */
const BPM = {
  [MUSIC_MODES.AMBIENT]: 95,
  [MUSIC_MODES.COMBAT]: 125,
  [MUSIC_MODES.BOSS]: 150,
};

/**
 * A minor, four bars, i - VI - VII - v.
 *
 * Minor because the game is a last stand, and this particular progression
 * because it resolves without ever landing — it can loop for twenty minutes
 * without the ear filing it as finished, which is the only real requirement
 * for music nobody is listening to on purpose.
 *
 * `root` is the bass note in Hz; `chord` are the scale degrees the arpeggio
 * and the pad build from, as multipliers of the root.
 */
const PROGRESSION = [
  { name: 'Am', root: 110.0, chord: [1, 1.2, 1.5, 2] },
  { name: 'F', root: 87.31, chord: [1, 1.26, 1.5, 2] },
  { name: 'G', root: 98.0, chord: [1, 1.26, 1.5, 2] },
  { name: 'Em', root: 82.41, chord: [1, 1.2, 1.5, 2] },
];

/** Sixteenth-note steps in a bar. */
const STEPS_PER_BAR = 16;

/**
 * The walking bass figure, as scale-degree multipliers against the chord root.
 * `null` is a rest — and the rests are what make it walk instead of chug.
 */
const BASS_PATTERN = [
  1, null, 1, null, 1.5, null, 1, null,
  2, null, 1.5, null, 1, null, 1.2, null,
];

/** Which chord tone the 16th arpeggio takes on each step. */
const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 0];

/** Kick pattern: the four-on-the-floor plus a panic hit on the last 16th. */
const KICK_STEPS = new Set([0, 4, 8, 12, 15]);

/**
 * A soft-clipping curve for the boss bass.
 *
 * `tanh`-shaped rather than a hard clip: a hard clip generates the full
 * harmonic series and turns a bass line into a buzz, while soft clipping adds
 * the low-order harmonics that read as "driven amplifier" and keeps the
 * fundamental intact — which matters, because the fundamental is the note.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} amount - 1 is gentle, 12 is aggressive
 * @returns {WaveShaperNode}
 */
function createDistortion(ctx, amount = 8) {
  const shaper = ctx.createWaveShaper();
  const samples = 1024;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  return shaper;
}

export class MusicSynth {
  /**
   * @param {BaseAudioContext} ctx
   * @param {Object} destination - The music bus; never the raw destination
   * @param {Object} [options]
   * @param {Function} [options.setInterval] - Injected for tests
   * @param {Function} [options.clearInterval] - Injected for tests
   */
  constructor(ctx, destination, options = {}) {
    this.ctx = ctx;
    this.destination = destination;
    this.setInterval = options.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.clearInterval = options.clearInterval ?? ((id) => globalThis.clearInterval(id));

    /** @type {string} */
    this.mode = MUSIC_MODES.AMBIENT;
    /** @type {boolean} */
    this.running = false;
    /** @type {*} Scheduler timer handle, or null when stopped. */
    this.timer = null;

    /**
     * The next 16th note's start time on the AUDIO clock, not the wall clock.
     * Everything about the rhythm derives from this one number.
     */
    this.nextNoteTime = 0;
    /** Absolute 16th-note counter; bar and step are derived from it. */
    this.step = 0;

    this.buildGraph();
  }

  /**
   * One gain per layer, all feeding the music bus.
   *
   * Building them up front rather than per note is what makes the crossfade a
   * single ramp on five params instead of a rebuild — and it means a layer at
   * zero gain costs nothing, because the scheduler skips it entirely.
   */
  buildGraph() {
    const { ctx } = this;

    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(this.destination);

    /** @type {Object<string, GainNode>} */
    this.layers = {};
    for (const name of ['pad', 'bass', 'arp', 'drive', 'drums']) {
      const gain = ctx.createGain();
      // Start silent: `start()` fades the opening mode in rather than punching
      // it in at full level on the first frame of the menu.
      gain.gain.value = 0;
      gain.connect(this.bus);
      this.layers[name] = gain;
    }

    // The boss bass runs through its own distortion stage on the way to its
    // layer gain, so the crossfade still controls it like any other layer.
    this.driveShaper = createDistortion(ctx, 8);
    this.driveShaper.connect(this.layers.drive);

    /** Live target per layer; the scheduler reads this to skip silent work. */
    this.levels = { pad: 0, bass: 0, arp: 0, drive: 0, drums: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* Transport                                                           */
  /* ------------------------------------------------------------------ */

  /** Start the scheduler and fade the current mode in. */
  start() {
    if (this.running) return;
    this.running = true;
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this.step = 0;
    this.applyMix(this.mode, CROSSFADE_SEC);
    this.timer = this.setInterval(() => this.tick(), LOOKAHEAD_MS);
  }

  /**
   * Stop the scheduler and silence every layer.
   *
   * Notes already scheduled inside the lookahead window still sound — they are
   * committed to the audio hardware and cannot be recalled — so the layer gains
   * are ramped down over the same window rather than cut, which is what stops
   * a `stop()` from leaving a 180ms fragment of arpeggio hanging.
   */
  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      this.clearInterval(this.timer);
      this.timer = null;
    }
    const t = this.ctx.currentTime;
    for (const name of Object.keys(this.layers)) {
      const param = this.layers[name].gain;
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(0, t + SCHEDULE_AHEAD);
      this.levels[name] = 0;
    }
  }

  /**
   * Change intensity. Idempotent — the bridge calls this on every wave start.
   *
   * @param {string} mode - One of MUSIC_MODES
   * @param {number} [fade] - Crossfade seconds
   */
  setMode(mode, fade = CROSSFADE_SEC) {
    if (!MIX[mode] || mode === this.mode) return;
    this.mode = mode;
    if (this.running) this.applyMix(mode, fade);
  }

  /**
   * Ramp every layer gain to the target mix.
   *
   * `linearRampToValueAtTime` rather than exponential because a layer target is
   * frequently 0, which an exponential ramp cannot reach — and over 1.2s the
   * difference between the two curves is inaudible anyway.
   *
   * @param {string} mode
   * @param {number} fade
   */
  applyMix(mode, fade) {
    const target = MIX[mode];
    const t = this.ctx.currentTime;
    for (const [name, level] of Object.entries(target)) {
      const param = this.layers[name].gain;
      param.cancelScheduledValues(t);
      // Pin the CURRENT value first: without this, a mode change landing
      // mid-fade ramps from wherever the last ramp was aimed rather than from
      // where the layer actually is, and two quick changes step audibly.
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(level, t + fade);
      this.levels[name] = level;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The scheduler                                                       */
  /* ------------------------------------------------------------------ */

  /** Seconds per 16th note at the live tempo. */
  get stepDuration() {
    return 60 / (BPM[this.mode] ?? 120) / 4;
  }

  /**
   * One timer wake: schedule every note that starts inside the window.
   *
   * The `while` is not a formality — after a tab has been backgrounded the
   * audio clock has run on without the timer, and this is the loop that
   * catches the transport back up.
   */
  tick() {
    if (!this.running) return;
    const horizon = this.ctx.currentTime + SCHEDULE_AHEAD;

    // A long stall can leave the transport thousands of steps behind. Rather
    // than scheduling every one of them (which would dump a wall of notes into
    // the graph at once), jump the clock forward and carry on in time.
    if (this.nextNoteTime < this.ctx.currentTime - 1) {
      this.nextNoteTime = this.ctx.currentTime;
    }

    while (this.nextNoteTime < horizon) {
      this.scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += this.stepDuration;
      this.step += 1;
    }
  }

  /**
   * Schedule everything that happens on one 16th note.
   *
   * Every layer checks its own level first. That check is the performance
   * story of this whole module: in the menu, four of the five layers cost one
   * comparison per step and allocate nothing.
   *
   * @param {number} step - Absolute 16th counter
   * @param {number} time - Audio-clock start time
   */
  scheduleStep(step, time) {
    const stepInBar = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const chord = PROGRESSION[bar % PROGRESSION.length];

    // The pad changes on the downbeat only — it is the slowest-moving thing in
    // the arrangement and that is what makes the chord changes read.
    if (stepInBar === 0 && this.levels.pad > 0) this.schedulePad(chord, time);

    if (this.levels.bass > 0) this.scheduleBass(chord, stepInBar, time);
    if (this.levels.arp > 0) this.scheduleArp(chord, stepInBar, time);
    if (this.levels.drive > 0) this.scheduleDrive(chord, stepInBar, time);
    if (this.levels.drums > 0 && KICK_STEPS.has(stepInBar)) this.scheduleKick(stepInBar, time);
  }

  /**
   * A slow triangle chord behind a heavily closed lowpass.
   *
   * Two octaves up from the bass root so the pad and the bass never contest
   * the same frequencies, and long enough to overlap the next bar — the
   * overlap is what makes a progression sound like a pad rather than like four
   * separate chords.
   *
   * @param {Object} chord
   * @param {number} time
   */
  schedulePad(chord, time) {
    const { ctx } = this;
    const barLength = this.stepDuration * STEPS_PER_BAR;
    const length = barLength * 1.15;

    const voice = ctx.createGain();
    voice.gain.setValueAtTime(SILENT, time);
    voice.gain.linearRampToValueAtTime(0.16, time + barLength * 0.35);
    voice.gain.linearRampToValueAtTime(0, time + length);

    const veil = ctx.createBiquadFilter();
    veil.type = 'lowpass';
    veil.frequency.value = 620;
    veil.Q.value = 0.8;
    veil.connect(voice);
    voice.connect(this.layers.pad);

    const oscillators = chord.chord.slice(0, 3).map((ratio, index) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = chord.root * ratio * 4;
      // A couple of cents apart so the voices beat instead of phase-cancelling.
      osc.detune.value = (index - 1) * 7;
      osc.connect(veil);
      osc.start(time);
      osc.stop(time + length);
      return osc;
    });

    this.releaseOn(oscillators[oscillators.length - 1], [...oscillators, veil, voice]);
  }

  /**
   * The bass: one sustained root per bar in ambient, a walking figure in
   * combat and above.
   *
   * The mode check is the only place in the scheduler where a layer plays
   * something structurally different per mode, and it has to be here: a
   * walking bass under a menu is restless, and a whole note under a wave is
   * dead weight.
   *
   * @param {Object} chord
   * @param {number} stepInBar
   * @param {number} time
   */
  scheduleBass(chord, stepInBar, time) {
    if (this.mode === MUSIC_MODES.AMBIENT) {
      if (stepInBar !== 0) return;
      this.bassNote(chord.root, time, this.stepDuration * STEPS_PER_BAR * 0.9, 'sine', 0.5);
      return;
    }

    const degree = BASS_PATTERN[stepInBar];
    if (degree === null) return;
    this.bassNote(chord.root * degree, time, this.stepDuration * 1.6, 'sawtooth', 0.32);
  }

  /**
   * @param {number} freq
   * @param {number} time
   * @param {number} length
   * @param {OscillatorType} type
   * @param {number} peak
   */
  bassNote(freq, time, length, type, peak) {
    const { ctx } = this;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 340;
    tone.Q.value = 2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENT, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.012);
    env.gain.linearRampToValueAtTime(0, time + length);

    osc.connect(tone);
    tone.connect(env);
    env.connect(this.layers.bass);
    osc.start(time);
    osc.stop(time + length);

    this.releaseOn(osc, [osc, tone, env]);
  }

  /**
   * Sixteenth-note arpeggio: the thing that actually reads as "the music".
   *
   * Square through a highpass, kept short and quiet. It sits two and three
   * octaves above the bass, which is the only register left once the pad has
   * the middle and the kick has the bottom.
   *
   * @param {Object} chord
   * @param {number} stepInBar
   * @param {number} time
   */
  scheduleArp(chord, stepInBar, time) {
    const { ctx } = this;
    const tone = chord.chord[ARP_PATTERN[stepInBar]];
    const length = this.stepDuration * 0.9;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = chord.root * tone * 8;

    const cut = ctx.createBiquadFilter();
    cut.type = 'highpass';
    cut.frequency.value = 500;

    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENT, time);
    env.gain.linearRampToValueAtTime(0.12, time + 0.006);
    env.gain.exponentialRampToValueAtTime(SILENT, time + length);

    osc.connect(cut);
    cut.connect(env);
    env.connect(this.layers.arp);
    osc.start(time);
    osc.stop(time + length);

    this.releaseOn(osc, [osc, cut, env]);
  }

  /**
   * Boss-only distorted bass, doubling the root an octave down on the beat.
   *
   * Only on the quarter notes: at 150 BPM a distorted line on every 16th is a
   * solid wall of low-mid that buries the arpeggio, the kick and most of the
   * SFX with it.
   *
   * @param {Object} chord
   * @param {number} stepInBar
   * @param {number} time
   */
  scheduleDrive(chord, stepInBar, time) {
    if (stepInBar % 4 !== 0) return;
    const { ctx } = this;
    const length = this.stepDuration * 3.5;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = chord.root * 0.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENT, time);
    env.gain.linearRampToValueAtTime(0.5, time + 0.02);
    env.gain.linearRampToValueAtTime(0, time + length);

    osc.connect(env);
    env.connect(this.driveShaper);
    osc.start(time);
    osc.stop(time + length);

    this.releaseOn(osc, [osc, env]);
  }

  /**
   * Kick drum: a sine dropped from 150Hz to 45Hz in 80ms, plus a click.
   *
   * The pitch drop IS the drum — a fixed-frequency sine is a bass note, and
   * the click on top is what makes it audible on a laptop speaker that cannot
   * reproduce the 45Hz it lands on.
   *
   * @param {number} stepInBar
   * @param {number} time
   */
  scheduleKick(stepInBar, time) {
    const { ctx } = this;
    const length = 0.22;
    // The off-beat panic hit sits back so it reads as a flam, not a downbeat.
    const peak = stepInBar === 15 ? 0.45 : 0.8;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.08);

    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENT, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.004);
    env.gain.exponentialRampToValueAtTime(SILENT, time + length);

    osc.connect(env);
    env.connect(this.layers.drums);
    osc.start(time);
    osc.stop(time + length);

    this.releaseOn(osc, [osc, env]);
  }

  /**
   * Disconnect a note's nodes once it has finished sounding.
   *
   * The score schedules something like eight notes a second for an entire run;
   * without this the graph grows for twenty minutes and the tab's memory grows
   * with it.
   *
   * @param {Object} source - The last-stopping source in the note
   * @param {Object[]} nodes
   */
  releaseOn(source, nodes) {
    source.onended = () => {
      try {
        for (const node of nodes) node.disconnect();
      } catch {
        // Context already gone; nothing to release.
      }
    };
  }

  /** Stop the transport and drop the layer graph off the bus. */
  dispose() {
    this.stop();
    try {
      this.bus.disconnect();
    } catch {
      // Already torn down with the context.
    }
  }
}
