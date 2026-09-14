/**
 * Procedural SFX synthesis — every sound in BloomWake, made from oscillators.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE NO AUDIO FILES
 * ---------------------------------------------------------------------------
 * A web game pays for its audio twice: once in bytes over the wire, and again
 * in the first-play stutter while the decode finishes. A twenty-sound library
 * of even modest .ogg files is a megabyte the player waits through before the
 * first wave, on a portal where the first wave is the whole audition. Every
 * sound here is instead built at play time out of oscillators and one shared
 * noise buffer, so the audio budget of this game is zero KB and the latency is
 * one node-graph allocation.
 *
 * The trade is that a sound is a recipe, not a waveform: nobody can open these
 * in an editor and nudge them. That is what the numbers at the top of each
 * function are for — they ARE the sound design, and they are the only place it
 * exists.
 *
 * ---------------------------------------------------------------------------
 * EVERY SYNTH HAS THE SAME SHAPE
 * ---------------------------------------------------------------------------
 *   fn(ctx, destination, params) -> { duration }
 *
 * `destination` is whatever bus the caller wants this on — the manager passes
 * its SFX gain, never the raw context destination, so one `setSfxVolume` moves
 * all of them at once. `params` carries `{ gain, pitch, pan }`; `duration`
 * comes back so the voice pool knows when the graph is finished without having
 * to hang a timer off it.
 *
 * Nothing in here reads the simulation, the DOM, or any clock other than the
 * AudioContext's own. They are pure recipes against a context, which is why
 * they test under a mock with no browser present.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES THE WEB AUDIO API ENFORCES THE HARD WAY
 * ---------------------------------------------------------------------------
 * 1. `exponentialRampToValueAtTime` cannot touch zero. Every envelope here
 *    starts and ends at SILENT (1e-4), never at 0 — a literal 0 throws in some
 *    engines and silently discards the whole ramp in others.
 * 2. A node graph is not collected while a source inside it is still playing,
 *    and a graph nobody disconnects leaks once the game has fired a few
 *    thousand shots. `autoRelease` hangs teardown off the source's own
 *    `onended`, so the graph dies exactly when the sound does.
 */

/** Floor for exponential ramps. Below audibility, above the API's zero. */
const SILENT = 0.0001;

/** Seconds of noise rendered per context. Long enough that loops never buzz. */
const NOISE_SECONDS = 2;

/**
 * One noise buffer per context per colour, built on first use.
 *
 * Keyed by context so a test that spins up ten mock contexts never hands the
 * eleventh a buffer belonging to the first, and weakly so that a disposed
 * context takes its buffers with it.
 * @type {WeakMap<Object, Map<string, Object>>}
 */
const noiseCache = new WeakMap();

/**
 * Render a noise buffer.
 *
 * White is the raw random walk — bright, for impacts and hiss. Brown is white
 * integrated, which rolls off 6dB/octave and is what makes the afterburner
 * read as a ROAR rather than as static: engine noise has almost no energy up
 * top, and white noise through a lowpass never quite loses the hiss that the
 * integration removes outright.
 *
 * @param {BaseAudioContext} ctx
 * @param {'white'|'brown'} type
 * @returns {AudioBuffer}
 */
function renderNoise(ctx, type) {
  const rate = ctx.sampleRate || 44100;
  const length = Math.max(1, Math.floor(rate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);

  if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      // The integrator settles around ±0.28; scale back up to full range.
      data[i] = last * 3.5;
    }
  } else {
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }

  return buffer;
}

/**
 * The shared noise buffer for a context.
 * @param {BaseAudioContext} ctx
 * @param {'white'|'brown'} [type]
 * @returns {AudioBuffer}
 */
export function getNoiseBuffer(ctx, type = 'white') {
  let byType = noiseCache.get(ctx);
  if (!byType) {
    byType = new Map();
    noiseCache.set(ctx, byType);
  }
  let buffer = byType.get(type);
  if (!buffer) {
    buffer = renderNoise(ctx, type);
    byType.set(type, buffer);
  }
  return buffer;
}

/**
 * A looping voice on the shared noise buffer.
 *
 * Callers start it at a random offset, and that matters more than it looks:
 * without it every flak burst in a run replays the same 180ms of the same
 * buffer, which the ear picks up as a repeated "sample" within a dozen shots.
 *
 * @param {BaseAudioContext} ctx
 * @param {'white'|'brown'} [type]
 * @returns {AudioBufferSourceNode}
 */
export function createNoiseSource(ctx, type = 'white') {
  const source = ctx.createBufferSource();
  source.buffer = getNoiseBuffer(ctx, type);
  source.loop = true;
  return source;
}

/** A random offset into the noise buffer, kept clear of the loop point. */
const noiseOffset = () => Math.random() * NOISE_SECONDS * 0.5;

/**
 * Connect a chain of nodes left to right.
 * @param {...Object} nodes
 * @returns {Object} The last node
 */
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

/**
 * Tear the graph down when the source finishes.
 *
 * @param {Object} source - An oscillator or buffer source, already scheduled
 * @param {...Object} nodes - Everything to disconnect once it ends
 */
function autoRelease(source, ...nodes) {
  source.onended = () => {
    try {
      source.disconnect();
      for (const node of nodes) node.disconnect();
    } catch {
      // A context torn down mid-flight throws here. There is nothing left to
      // release in that case, which is the outcome we were after anyway.
    }
  };
}

/**
 * Percussive envelope: silence -> peak -> silence, exponentially.
 *
 * @param {AudioParam} param - A gain param
 * @param {number} t0 - Start time
 * @param {number} peak
 * @param {number} attack - Seconds to peak
 * @param {number} decay - Seconds from peak back to silence
 * @param {number} [hold] - Seconds held at peak between the two
 */
function pluck(param, t0, peak, attack, decay, hold = 0) {
  const top = Math.max(peak, SILENT);
  param.setValueAtTime(SILENT, t0);
  param.exponentialRampToValueAtTime(top, t0 + attack);
  if (hold > 0) param.setValueAtTime(top, t0 + attack + hold);
  param.exponentialRampToValueAtTime(SILENT, t0 + attack + hold + Math.max(decay, 0.001));
}

/**
 * The per-sound output stage: one gain carrying the caller's level, optionally
 * behind a panner.
 *
 * Panning is feature-detected rather than assumed — StereoPannerNode is absent
 * on older Safari, and a missing panner should cost the player the stereo
 * image, not the sound.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pan?: number}} params
 * @returns {{node: Object, tail: Object[]}} `node` to feed, `tail` to release
 */
function outputStage(ctx, destination, params) {
  const out = ctx.createGain();
  out.gain.value = params.gain ?? 1;

  const pan = params.pan ?? 0;
  if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(panner);
    panner.connect(destination);
    return { node: out, tail: [out, panner] };
  }

  out.connect(destination);
  return { node: out, tail: [out] };
}

/**
 * A silent voice whose only job is to outlive every other voice in a sound, so
 * a multi-voice graph has one `onended` late enough to release the shared
 * output stage.
 *
 * Cheaper than it sounds — a zero-gain oscillator is a handful of samples the
 * engine never mixes — and much simpler than reference-counting the voices.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} out
 * @param {number} t0
 * @param {number} duration
 * @param {Object[]} tail
 */
function releaseAfter(ctx, out, t0, duration, tail) {
  const keeper = ctx.createOscillator();
  keeper.frequency.value = 20;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  chain(keeper, mute, out);
  keeper.start(t0);
  keeper.stop(t0 + duration);
  autoRelease(keeper, mute, ...tail);
}

/** @param {Object} params @returns {number} Frequency multiplier. */
const pitchOf = (params) => params.pitch ?? 1;

/* ========================================================================= */
/* 1 — WEAPON FIRE                                                           */
/* ========================================================================= */

/**
 * Repeater plasma: a sweep collapsing 480Hz -> 95Hz in 80ms.
 *
 * This is the sound the player hears more than every other sound in the game
 * combined — several times a second for twenty minutes — so it is the one the
 * whole palette is calibrated around. It used to run 900Hz down to 200Hz and
 * it was, correctly, described as an ice pick: a sawtooth at that pitch puts
 * its harmonic series straight through 2-5kHz, which is exactly where human
 * hearing is most sensitive and where listening fatigue is manufactured.
 *
 * The fix is not just to turn it down. Dropping it an octave moves the whole
 * harmonic stack below the painful band, and the 1600Hz lowpass removes what
 * is left of the sawtooth's upper edge. The energy that would have been in
 * those harmonics is instead put back as a 120Hz sub-thump on the attack — so
 * the shot keeps its transient and its perceived weight while losing the
 * frequencies that were doing the damage.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function laserRepeater(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.08;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(480 * p, t0);
  osc.frequency.exponentialRampToValueAtTime(95 * p, t0 + duration);

  // A hard ceiling rather than a sweep. The sawtooth's job here is body, not
  // brightness — everything above 1600Hz is the part that made it hurt.
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 1600;
  tone.Q.value = 0.7;

  const env = ctx.createGain();
  // Slightly hotter than the old bright version: the ear reads a dark sound as
  // quieter at equal amplitude, so the level compensates for the lost top end.
  pluck(env.gain, t0, 0.6, 0.004, duration - 0.004);

  chain(osc, tone, env, out);
  osc.start(t0);
  osc.stop(t0 + duration);
  autoRelease(osc, tone, env, ...tail);

  // The "tock" of the shot leaving. Twenty milliseconds of 120Hz, which the
  // ear fuses with the sweep into a single percussive event rather than
  // hearing as a second sound.
  const punch = ctx.createOscillator();
  punch.type = 'sine';
  punch.frequency.setValueAtTime(120 * p, t0);
  punch.frequency.exponentialRampToValueAtTime(80 * p, t0 + 0.02);

  const punchEnv = ctx.createGain();
  pluck(punchEnv.gain, t0, 0.5, 0.002, 0.018);

  chain(punch, punchEnv, out);
  punch.start(t0);
  punch.stop(t0 + 0.02);
  autoRelease(punch, punchEnv);

  return { duration };
}

/**
 * Nova flak: a noise burst slammed through a collapsing lowpass.
 *
 * The "thump" is the filter, not the noise — sweeping the cutoff down inside
 * 180ms is what makes a spray of random numbers read as an explosion with a
 * direction to it. The sweep now STARTS at 800Hz rather than 5kHz: opening at
 * 5k meant the first twenty milliseconds of every burst was unfiltered white
 * noise, which is a hiss, and a wave full of them is sandpaper. Starting the
 * sweep already closed costs the sound nothing it needed — the motion is what
 * reads, not the top end it was moving from.
 *
 * The kick underneath pays for it: 90Hz to 35Hz is the shrapnel's weight, and
 * it is where the burst now gets its size from.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function novaFlak(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.18;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const noise = createNoiseSource(ctx, 'white');
  const sweep = ctx.createBiquadFilter();
  sweep.type = 'lowpass';
  // Q down from 3.5 as well: a resonant peak dragged across the mid band is a
  // "pew", and four of them a second is the sound people reach for the mute on.
  sweep.Q.value = 1.4;
  sweep.frequency.setValueAtTime(800 * p, t0);
  sweep.frequency.exponentialRampToValueAtTime(240 * p, t0 + duration);

  const noiseEnv = ctx.createGain();
  pluck(noiseEnv.gain, t0, 0.75, 0.003, duration - 0.003);

  chain(noise, sweep, noiseEnv, out);
  noise.start(t0, noiseOffset());
  noise.stop(t0 + duration);
  autoRelease(noise, sweep, noiseEnv);

  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(90 * p, t0);
  body.frequency.exponentialRampToValueAtTime(35 * p, t0 + duration * 0.8);

  const bodyEnv = ctx.createGain();
  pluck(bodyEnv.gain, t0, 0.8, 0.005, duration - 0.005);

  chain(body, bodyEnv, out);
  body.start(t0);
  body.stop(t0 + duration);
  autoRelease(body, bodyEnv, ...tail);

  return { duration };
}

/**
 * Tesla arc: electricity, which is to say pitch that will not sit still.
 *
 * Built from stepped `setValueAtTime` jumps rather than a ramp, because an arc
 * is discontinuous — glide smoothly between the steps and it becomes a
 * theremin, and the zigzag is the entire identity of the sound.
 *
 * The zigzag used to run 700-2400Hz through a resonant bandpass, and a square
 * wave randomly jumping around that band is close to the definition of a
 * shriek. It now steps across 320-1100Hz behind a 1400Hz lowpass, so the
 * discharge keeps its erratic motion in a register the ear can take repeatedly.
 * The crackle layer came down with it — an unfiltered 3kHz highpass hiss on a
 * weapon that fires continuously was the single harshest thing in the palette.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function teslaArc(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.12;
  const steps = 9;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const osc = ctx.createOscillator();
  osc.type = 'square';
  for (let i = 0; i < steps; i += 1) {
    osc.frequency.setValueAtTime((320 + Math.random() * 780) * p, t0 + (duration * i) / steps);
  }

  // A square wave is nothing but odd harmonics, so the filter is doing more
  // work here than anywhere else in the file: without a ceiling, a fundamental
  // that jumps to 1100Hz puts partials at 3.3k, 5.5k and 7.7k on every step.
  const band = ctx.createBiquadFilter();
  band.type = 'lowpass';
  band.frequency.value = 1400;
  band.Q.value = 1;

  const env = ctx.createGain();
  pluck(env.gain, t0, 0.26, 0.002, duration - 0.002);

  chain(osc, band, env, out);
  osc.start(t0);
  osc.stop(t0 + duration);
  autoRelease(osc, band, env);

  // The crackle riding on top of the tone. A narrow mid band, not a highpass:
  // the texture is what sells the discharge, and the texture survives being
  // moved down two octaves. The hiss does not survive being listened to.
  const crackle = createNoiseSource(ctx, 'white');
  const hiss = ctx.createBiquadFilter();
  hiss.type = 'bandpass';
  hiss.frequency.value = 1300;
  hiss.Q.value = 1.6;

  const crackleEnv = ctx.createGain();
  pluck(crackleEnv.gain, t0, 0.16, 0.002, duration * 0.7);

  chain(crackle, hiss, crackleEnv, out);
  crackle.start(t0, noiseOffset());
  crackle.stop(t0 + duration);
  autoRelease(crackle, hiss, crackleEnv, ...tail);

  return { duration };
}

/**
 * Missile launch: the hiss of the tube, then the motor catching.
 *
 * Two events 60ms apart, and the gap is the point — fired together they read
 * as one noisy blob. The hiss falls in pitch (pressure escaping), the motor
 * rises (thrust building), and that opposed motion is what sells "something
 * just left the rail".
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function missileLaunch(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.34;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const hiss = createNoiseSource(ctx, 'white');
  // A bandpass falling through the mids, not a highpass opening onto 5kHz.
  // A highpass has no ceiling by definition, so the old version passed every
  // frequency the noise had — which on white noise is all of them.
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = 'bandpass';
  hissFilter.Q.value = 1.1;
  hissFilter.frequency.setValueAtTime(2000 * p, t0);
  hissFilter.frequency.exponentialRampToValueAtTime(650 * p, t0 + 0.2);

  const hissEnv = ctx.createGain();
  pluck(hissEnv.gain, t0, 0.42, 0.004, 0.2);

  chain(hiss, hissFilter, hissEnv, out);
  hiss.start(t0, noiseOffset());
  hiss.stop(t0 + 0.24);
  autoRelease(hiss, hissFilter, hissEnv);

  const motorAt = t0 + 0.06;
  const motor = ctx.createOscillator();
  motor.type = 'sawtooth';
  motor.frequency.setValueAtTime(150 * p, motorAt);
  motor.frequency.exponentialRampToValueAtTime(360 * p, motorAt + 0.22);

  // High Q on a moving bandpass is the resonance of the exhaust bell.
  const bell = ctx.createBiquadFilter();
  bell.type = 'bandpass';
  bell.Q.value = 6;
  bell.frequency.setValueAtTime(420 * p, motorAt);
  bell.frequency.exponentialRampToValueAtTime(1100 * p, motorAt + 0.22);

  const motorEnv = ctx.createGain();
  pluck(motorEnv.gain, motorAt, 0.4, 0.03, 0.22);

  chain(motor, bell, motorEnv, out);
  motor.start(motorAt);
  motor.stop(t0 + duration);
  autoRelease(motor, bell, motorEnv, ...tail);

  return { duration };
}

/* ========================================================================= */
/* 2 — ACTIVE SKILLS                                                         */
/* ========================================================================= */

/**
 * Afterburner: two full seconds of resonant bass roar.
 *
 * The longest sound in the game, and the only one whose envelope has a real
 * sustain — it has to hold for the whole burn or the skill feels like it quit
 * early. Brown noise through a resonant lowpass that opens as the burn peaks
 * and closes as it dies, with an 80Hz sine under it so the roar has a
 * fundamental rather than just a band of rumble.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function afterburner(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 2.0;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const roar = createNoiseSource(ctx, 'brown');
  const throat = ctx.createBiquadFilter();
  throat.type = 'lowpass';
  throat.Q.value = 7;
  throat.frequency.setValueAtTime(180 * p, t0);
  throat.frequency.exponentialRampToValueAtTime(900 * p, t0 + 0.35);
  throat.frequency.exponentialRampToValueAtTime(260 * p, t0 + duration);

  const roarEnv = ctx.createGain();
  roarEnv.gain.setValueAtTime(SILENT, t0);
  roarEnv.gain.exponentialRampToValueAtTime(0.75, t0 + 0.12);
  roarEnv.gain.setValueAtTime(0.75, t0 + duration * 0.6);
  roarEnv.gain.exponentialRampToValueAtTime(SILENT, t0 + duration);

  chain(roar, throat, roarEnv, out);
  roar.start(t0, noiseOffset());
  roar.stop(t0 + duration);
  autoRelease(roar, throat, roarEnv);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(80 * p, t0);
  sub.frequency.exponentialRampToValueAtTime(112 * p, t0 + 0.4);
  sub.frequency.exponentialRampToValueAtTime(68 * p, t0 + duration);

  const subEnv = ctx.createGain();
  subEnv.gain.setValueAtTime(SILENT, t0);
  subEnv.gain.exponentialRampToValueAtTime(0.5, t0 + 0.08);
  subEnv.gain.setValueAtTime(0.5, t0 + duration * 0.65);
  subEnv.gain.exponentialRampToValueAtTime(SILENT, t0 + duration);

  chain(sub, subEnv, out);
  sub.start(t0);
  sub.stop(t0 + duration);
  autoRelease(sub, subEnv, ...tail);

  return { duration };
}

/**
 * Phase shift: the implosion pop, then the two halves ringing apart.
 *
 * The pop runs 120Hz -> 800Hz in 60ms. Upward, which is the counter-intuitive
 * part: a falling sweep reads as something arriving, a rising one as something
 * pulled inward and leaving. Behind it, two detuned sines hard-panned in
 * opposite directions, so the stereo field itself splits — the sound of the
 * ship being in two places.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function phaseShift(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const popDuration = 0.06;
  const ringDuration = 0.38;
  const duration = popDuration + ringDuration;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const pop = ctx.createOscillator();
  pop.type = 'triangle';
  pop.frequency.setValueAtTime(120 * p, t0);
  pop.frequency.exponentialRampToValueAtTime(800 * p, t0 + popDuration);

  const popEnv = ctx.createGain();
  pluck(popEnv.gain, t0, 0.55, 0.003, popDuration - 0.003);

  chain(pop, popEnv, out);
  pop.start(t0);
  pop.stop(t0 + popDuration);
  autoRelease(pop, popEnv);

  // The separation. Without a panner the two voices still ring — they just
  // ring in the middle, which costs the effect but not the sound.
  const canPan = typeof ctx.createStereoPanner === 'function';
  const ringAt = t0 + popDuration * 0.5;

  [-0.85, 0.85].forEach((side, index) => {
    const ring = ctx.createOscillator();
    ring.type = 'sine';
    // Detuned against each other: the beating between them is the shimmer.
    ring.frequency.setValueAtTime((1180 + index * 26) * p, ringAt);
    ring.frequency.exponentialRampToValueAtTime((620 + index * 18) * p, ringAt + ringDuration);

    const ringEnv = ctx.createGain();
    pluck(ringEnv.gain, ringAt, 0.2, 0.01, ringDuration - 0.01);

    if (canPan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = side;
      chain(ring, ringEnv, panner, out);
      autoRelease(ring, ringEnv, panner);
    } else {
      chain(ring, ringEnv, out);
      autoRelease(ring, ringEnv);
    }

    ring.start(ringAt);
    ring.stop(ringAt + ringDuration);
  });

  releaseAfter(ctx, out, t0, duration, tail);
  return { duration };
}

/**
 * Singularity anchor: a 45Hz well with a slow wobble in it.
 *
 * Sub-bass this low is felt more than heard on most hardware, so a fifth above
 * it carries the pitch on speakers that cannot reproduce 45Hz at all. The LFO
 * is on amplitude rather than pitch — a wobbling pitch down here reads as a
 * broken speaker, a wobbling amplitude reads as gravity.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function singularity(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 2.2;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const well = ctx.createGain();
  well.gain.setValueAtTime(SILENT, t0);
  well.gain.exponentialRampToValueAtTime(0.85, t0 + 0.5);
  well.gain.setValueAtTime(0.85, t0 + duration - 0.6);
  well.gain.exponentialRampToValueAtTime(SILENT, t0 + duration);
  well.connect(out);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(45 * p, t0);
  sub.frequency.exponentialRampToValueAtTime(38 * p, t0 + duration);
  sub.connect(well);
  sub.start(t0);
  sub.stop(t0 + duration);
  autoRelease(sub);

  const fifth = ctx.createOscillator();
  fifth.type = 'sine';
  fifth.frequency.setValueAtTime(67 * p, t0);
  fifth.frequency.exponentialRampToValueAtTime(57 * p, t0 + duration);
  const fifthGain = ctx.createGain();
  fifthGain.gain.value = 0.35;
  chain(fifth, fifthGain, well);
  fifth.start(t0);
  fifth.stop(t0 + duration);
  autoRelease(fifth, fifthGain);

  // 5.5Hz tremolo, driven straight into the well's own gain param.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 5.5;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.3;
  lfo.connect(lfoDepth);
  lfoDepth.connect(well.gain);
  lfo.start(t0);
  lfo.stop(t0 + duration);
  autoRelease(lfo, lfoDepth, well, ...tail);

  return { duration };
}

/**
 * EMP blast: a struck bell with the lights going out behind it.
 *
 * The partials are deliberately inharmonic — 1, 1.41, 1.83, 2.37 rather than
 * 1, 2, 3, 4. Harmonic partials make a musical note; inharmonic ones make
 * metal, and this has to sound like a hull, not a chord. The falling noise
 * sweep underneath is the discharge collapsing.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function empBlast(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 1.1;

  const { node: out, tail } = outputStage(ctx, destination, params);

  [1, 1.41, 1.83, 2.37].forEach((ratio, index) => {
    const bell = ctx.createOscillator();
    bell.type = 'sine';
    // Base down from 1400: at the old pitch the top partial sat at 3.3kHz,
    // which is a dentist's drill held for a second. 900 puts the whole stack
    // under 2.2kHz and the inharmonic ratios still read as metal.
    bell.frequency.value = 900 * ratio * p;

    const bellEnv = ctx.createGain();
    // Higher partials die first; that decay gradient IS the metallic timbre.
    pluck(bellEnv.gain, t0, 0.3 / (index + 1), 0.002, duration * (1 - index * 0.18));

    chain(bell, bellEnv, out);
    bell.start(t0);
    bell.stop(t0 + duration);
    autoRelease(bell, bellEnv);
  });

  const discharge = createNoiseSource(ctx, 'white');
  const collapse = ctx.createBiquadFilter();
  // Lowpass sweeping down, not a highpass sweeping down. Both descend; only
  // one of them has a top. The lights going out should be a darkening, and a
  // 7kHz highpass is a hiss no matter which way it moves.
  collapse.type = 'lowpass';
  collapse.Q.value = 1.2;
  collapse.frequency.setValueAtTime(2400 * p, t0);
  collapse.frequency.exponentialRampToValueAtTime(300 * p, t0 + 0.5);

  const dischargeEnv = ctx.createGain();
  pluck(dischargeEnv.gain, t0, 0.45, 0.003, 0.5);

  chain(discharge, collapse, dischargeEnv, out);
  discharge.start(t0, noiseOffset());
  discharge.stop(t0 + 0.55);
  autoRelease(discharge, collapse, dischargeEnv);

  const thump = ctx.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(95 * p, t0);
  thump.frequency.exponentialRampToValueAtTime(38 * p, t0 + 0.3);
  const thumpEnv = ctx.createGain();
  pluck(thumpEnv.gain, t0, 0.6, 0.004, 0.3);
  chain(thump, thumpEnv, out);
  thump.start(t0);
  thump.stop(t0 + duration);
  autoRelease(thump, thumpEnv, ...tail);

  return { duration };
}

/* ========================================================================= */
/* 3 — BOSSES AND FIELD THREATS                                              */
/* ========================================================================= */

/**
 * Boss inbound: a two-tone industrial alarm, 440Hz against 350Hz.
 *
 * Squares, because an alarm is supposed to be unpleasant, and the interval is
 * a minor third or so — close enough to be a recognisable klaxon, sour enough
 * that nobody mistakes it for the music. It runs 1.4s and it is the one sound
 * allowed to interrupt everything else.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function bossInbound(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const toneLength = 0.28;
  const gap = 0.06;
  const pattern = [440, 350, 440, 350];
  const duration = pattern.length * (toneLength + gap);

  const { node: out, tail } = outputStage(ctx, destination, params);

  pattern.forEach((hz, index) => {
    const at = t0 + index * (toneLength + gap);

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = hz * p;

    // Squares this low are all upper harmonics; without the lowpass the alarm
    // is pure fizz on small speakers and pure pain on headphones.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 1400;

    const env = ctx.createGain();
    pluck(env.gain, at, 0.28, 0.012, 0.05, toneLength - 0.062);

    chain(osc, body, env, out);
    osc.start(at);
    osc.stop(at + toneLength);
    autoRelease(osc, body, env);
  });

  releaseAfter(ctx, out, t0, duration, tail);
  return { duration };
}

/**
 * Armour deflect: a damped ricochet off plate.
 *
 * Has to be instantly distinguishable from a hit, because it is the only
 * feedback telling the player their damage went nowhere. The first version
 * bought that distinction with pitch — partials at 3.2k and 4.7k over a 5.2kHz
 * noise tick — and a boss fight is a deflection every few frames, so it bought
 * it at the cost of the fight being unlistenable.
 *
 * The distinction is now carried by SHAPE instead: a dry knock that falls
 * 1100Hz -> 600Hz and is fully damped inside 150ms, against the long low thud
 * of everything that connects. A ricochet off steel is damped in reality too —
 * the plate absorbs the ring, and the old version's singing 4.7kHz partial was
 * the least realistic thing about it.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function armorDeflect(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  // Damped, hard-capped. A metallic ring that outlasts this reads as a bell,
  // and bells accumulate: ten overlapping ones are a chord nobody asked for.
  const duration = 0.15;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const strike = createNoiseSource(ctx, 'white');
  const edge = ctx.createBiquadFilter();
  edge.type = 'bandpass';
  edge.frequency.setValueAtTime(1100 * p, t0);
  edge.frequency.exponentialRampToValueAtTime(600 * p, t0 + 0.06);
  edge.Q.value = 2;

  const strikeEnv = ctx.createGain();
  pluck(strikeEnv.gain, t0, 0.5, 0.001, 0.05);

  chain(strike, edge, strikeEnv, out);
  strike.start(t0, noiseOffset());
  strike.stop(t0 + 0.06);
  autoRelease(strike, edge, strikeEnv);

  // Two tones a fifth apart rather than an inharmonic pair: close enough to
  // read as metal, consonant enough that a flurry of them does not beat.
  [1100, 740].forEach((hz, index) => {
    const ping = ctx.createOscillator();
    ping.type = 'triangle';
    ping.frequency.setValueAtTime(hz * p, t0);
    ping.frequency.exponentialRampToValueAtTime(600 * p, t0 + duration);
    const pingEnv = ctx.createGain();
    pluck(pingEnv.gain, t0, 0.34 - index * 0.12, 0.001, duration - 0.01);
    chain(ping, pingEnv, out);
    ping.start(t0);
    ping.stop(t0 + duration);
    autoRelease(ping, pingEnv);
  });

  // The weight behind the bounce — what stops a quieter, darker deflect from
  // reading as weaker feedback than the hit it is replacing.
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(170 * p, t0);
  body.frequency.exponentialRampToValueAtTime(90 * p, t0 + 0.08);
  const bodyEnv = ctx.createGain();
  pluck(bodyEnv.gain, t0, 0.4, 0.002, 0.07);
  chain(body, bodyEnv, out);
  body.start(t0);
  body.stop(t0 + 0.09);
  autoRelease(body, bodyEnv);

  releaseAfter(ctx, out, t0, duration, tail);
  return { duration };
}

/**
 * Part destroyed: steel tearing, then the compartment going up.
 *
 * Three layers because a structural failure is three things at once — the
 * tear (bandpassed noise dragged downward), the groan of the frame giving
 * (a falling saw), and the detonation behind it (a sine dropped to 32Hz).
 * This is the loudest sound in the SFX palette and it should be: it is the
 * player's reward for focusing a limb instead of chipping the chassis.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function partDestroyed(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.7;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const tear = createNoiseSource(ctx, 'white');
  const rip = ctx.createBiquadFilter();
  rip.type = 'bandpass';
  rip.Q.value = 1.2;
  rip.frequency.setValueAtTime(1800 * p, t0);
  rip.frequency.exponentialRampToValueAtTime(180 * p, t0 + 0.55);

  const tearEnv = ctx.createGain();
  pluck(tearEnv.gain, t0, 0.6, 0.004, 0.55);

  chain(tear, rip, tearEnv, out);
  tear.start(t0, noiseOffset());
  tear.stop(t0 + 0.6);
  autoRelease(tear, rip, tearEnv);

  const groan = ctx.createOscillator();
  groan.type = 'sawtooth';
  groan.frequency.setValueAtTime(180 * p, t0);
  groan.frequency.exponentialRampToValueAtTime(58 * p, t0 + 0.45);
  const groanTone = ctx.createBiquadFilter();
  groanTone.type = 'lowpass';
  groanTone.frequency.value = 900;
  const groanEnv = ctx.createGain();
  pluck(groanEnv.gain, t0, 0.35, 0.02, 0.45);
  chain(groan, groanTone, groanEnv, out);
  groan.start(t0);
  groan.stop(t0 + 0.5);
  autoRelease(groan, groanTone, groanEnv);

  const boom = ctx.createOscillator();
  boom.type = 'sine';
  boom.frequency.setValueAtTime(110 * p, t0);
  boom.frequency.exponentialRampToValueAtTime(32 * p, t0 + 0.5);
  const boomEnv = ctx.createGain();
  pluck(boomEnv.gain, t0, 0.8, 0.006, duration - 0.006);
  chain(boom, boomEnv, out);
  boom.start(t0);
  boom.stop(t0 + duration);
  autoRelease(boom, boomEnv, ...tail);

  return { duration };
}

/**
 * Rammer lock-on: three clipped warning pips.
 *
 * Three, not one and not a continuous tone. One pip is missed in a busy wave;
 * a continuous tone is indistinguishable from the alarm. Three rising-urgency
 * ticks 100ms apart is a pattern the ear parses as a countdown, which is
 * exactly what a charging rammer is.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function rammerLock(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const pipLength = 0.045;
  const spacing = 0.1;
  const duration = spacing * 3;

  const { node: out, tail } = outputStage(ctx, destination, params);

  for (let i = 0; i < 3; i += 1) {
    const at = t0 + i * spacing;

    const pip = ctx.createOscillator();
    pip.type = 'square';
    // Each pip a little higher than the last: the rise is the urgency.
    pip.frequency.value = (1500 + i * 150) * p;

    const shape = ctx.createBiquadFilter();
    shape.type = 'bandpass';
    shape.frequency.value = (1600 + i * 150) * p;
    shape.Q.value = 4;

    const env = ctx.createGain();
    pluck(env.gain, at, 0.3, 0.002, pipLength);

    chain(pip, shape, env, out);
    pip.start(at);
    pip.stop(at + pipLength + 0.01);
    autoRelease(pip, shape, env);
  }

  releaseAfter(ctx, out, t0, duration, tail);
  return { duration };
}

/* ========================================================================= */
/* 4 — CONSOLE UI AND CRATES                                                 */
/* ========================================================================= */

/**
 * UI click: a mechanical relay, 30ms of bandpassed noise.
 *
 * Thirty milliseconds is not a stylistic choice — it is the longest a click
 * can be before it stops feeling like the SAME EVENT as the press. Anything
 * with a tail reads as a response to the click rather than the click itself,
 * and the whole job of this sound is to make a DOM button feel like hardware.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function uiClick(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.03;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const relay = createNoiseSource(ctx, 'white');
  const contact = ctx.createBiquadFilter();
  contact.type = 'bandpass';
  contact.frequency.value = 1200 * p;
  contact.Q.value = 6;

  const env = ctx.createGain();
  pluck(env.gain, t0, 0.5, 0.001, duration - 0.001);

  chain(relay, contact, env, out);
  relay.start(t0, noiseOffset());
  relay.stop(t0 + duration);
  autoRelease(relay, contact, env, ...tail);

  return { duration };
}

/**
 * Card pop: something light landing on the console.
 *
 * A pitched tick rather than a noise one, so it sits apart from `uiClick` in
 * a screen where both fire within the same second — the draft deals cards and
 * the player clicks one, and those two events must not sound identical.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function cardPop(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.08;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(560 * p, t0);
  body.frequency.exponentialRampToValueAtTime(280 * p, t0 + duration);

  const env = ctx.createGain();
  pluck(env.gain, t0, 0.35, 0.002, duration - 0.002);

  chain(body, env, out);
  body.start(t0);
  body.stop(t0 + duration);
  autoRelease(body, env);

  // The slap of the edge hitting the surface, under the pitched body.
  const slap = createNoiseSource(ctx, 'white');
  const slapTone = ctx.createBiquadFilter();
  slapTone.type = 'bandpass';
  slapTone.frequency.value = 1500 * p;
  slapTone.Q.value = 2;
  const slapEnv = ctx.createGain();
  pluck(slapEnv.gain, t0, 0.22, 0.001, 0.02);
  chain(slap, slapTone, slapEnv, out);
  slap.start(t0, noiseOffset());
  slap.stop(t0 + 0.03);
  autoRelease(slap, slapTone, slapEnv);

  releaseAfter(ctx, out, t0, duration, tail);
  return { duration };
}

/**
 * Crate rattle: the seals resisting — a burst of micro ticks.
 *
 * Randomised in both spacing and pitch on every play. A fixed rattle pattern
 * is recognisable after two crates and dead after five, and this plays at the
 * single most repeated moment in the meta loop.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function crateRattle(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const ticks = 7;

  const { node: out, tail } = outputStage(ctx, destination, params);

  let at = t0;
  for (let i = 0; i < ticks; i += 1) {
    const tick = createNoiseSource(ctx, 'white');
    const metal = ctx.createBiquadFilter();
    metal.type = 'bandpass';
    metal.frequency.value = (1100 + Math.random() * 1000) * p;
    metal.Q.value = 8;

    const env = ctx.createGain();
    pluck(env.gain, at, 0.3 + Math.random() * 0.2, 0.001, 0.018);

    chain(tick, metal, env, out);
    tick.start(at, noiseOffset());
    tick.stop(at + 0.025);
    autoRelease(tick, metal, env);

    at += 0.03 + Math.random() * 0.03;
  }

  const duration = at - t0;
  releaseAfter(ctx, out, t0, duration, tail);
  return { duration };
}

/**
 * Crate blast: high-pressure decompression, and the shock ringing after it.
 *
 * The payoff sound of the entire meta loop, so it is the widest thing in the
 * palette — a 6kHz-to-150Hz noise collapse for the vent, a sine down to 30Hz
 * for the weight, and a high-Q bandpass ringing for a second and a quarter
 * afterwards so the room sounds like it is still recovering.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function crateBlast(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 1.25;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const vent = createNoiseSource(ctx, 'white');
  const decompress = ctx.createBiquadFilter();
  decompress.type = 'lowpass';
  decompress.Q.value = 1;
  decompress.frequency.setValueAtTime(2400 * p, t0);
  decompress.frequency.exponentialRampToValueAtTime(130 * p, t0 + 0.8);

  const ventEnv = ctx.createGain();
  pluck(ventEnv.gain, t0, 0.8, 0.005, 0.8);

  chain(vent, decompress, ventEnv, out);
  vent.start(t0, noiseOffset());
  vent.stop(t0 + 0.85);
  autoRelease(vent, decompress, ventEnv);

  const weight = ctx.createOscillator();
  weight.type = 'sine';
  weight.frequency.setValueAtTime(120 * p, t0);
  weight.frequency.exponentialRampToValueAtTime(30 * p, t0 + 0.7);
  const weightEnv = ctx.createGain();
  pluck(weightEnv.gain, t0, 0.85, 0.006, 0.7);
  chain(weight, weightEnv, out);
  weight.start(t0);
  weight.stop(t0 + 0.75);
  autoRelease(weight, weightEnv);

  // The shock wave: noise held in a very narrow band, which is what a ringing
  // metal chamber is. Long decay, low level — presence, not volume.
  const shock = createNoiseSource(ctx, 'white');
  const chamber = ctx.createBiquadFilter();
  chamber.type = 'bandpass';
  chamber.frequency.value = 1150 * p;
  chamber.Q.value = 14;
  const shockEnv = ctx.createGain();
  pluck(shockEnv.gain, t0, 0.3, 0.004, duration - 0.004);
  chain(shock, chamber, shockEnv, out);
  shock.start(t0, noiseOffset());
  shock.stop(t0 + duration);
  autoRelease(shock, chamber, shockEnv, ...tail);

  return { duration };
}

/* ========================================================================= */
/* 5 — THE SMALL CHANGE                                                      */
/* ========================================================================= */
/*
 * Four sounds that the named palette above does not cover but a playable mix
 * cannot do without. An arena where the boss roars and the crate detonates but
 * a dying enemy makes no sound at all is not a stylistic choice, it is a hole.
 * They are deliberately the quietest things here: they fire constantly, and
 * their job is to fill the floor of the mix, not to compete for it.
 */

/**
 * Enemy death: a satisfying low thud, not a crisp pop.
 *
 * The most-played sound in the game after the weapon, and the one where the
 * old balance was most wrong: a 2.6kHz noise burst leading the hit meant that
 * clearing twenty enemies produced twenty bright cracks on top of each other.
 * Individually fine, in aggregate a snare roll.
 *
 * It is now led by the THUD — a sine falling 180Hz to 45Hz over the full
 * 120ms — with the noise demoted to a 40ms crush at 1200Hz behind it. That is
 * deliberately closer to a cardboard box giving way than to something
 * exploding: a kill that happens dozens of times a minute wants to feel
 * satisfying and soft, not violent. Violence is what part_destroyed is for,
 * and it works because this one stays out of its way.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function enemyPop(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.12;

  const { node: out, tail } = outputStage(ctx, destination, params);

  // The body of the sound. Triangle rather than sine: one extra pair of weak
  // harmonics is enough to make the fall audible on a laptop speaker that
  // gives up somewhere around 150Hz, without putting anything near the top.
  const thud = ctx.createOscillator();
  thud.type = 'triangle';
  thud.frequency.setValueAtTime(180 * p, t0);
  thud.frequency.exponentialRampToValueAtTime(45 * p, t0 + duration);

  const thudEnv = ctx.createGain();
  pluck(thudEnv.gain, t0, 0.85, 0.003, duration - 0.003);

  chain(thud, thudEnv, out);
  thud.start(t0);
  thud.stop(t0 + duration);
  autoRelease(thud, thudEnv, ...tail);

  // The crush. Short enough to be an attack transient rather than a texture.
  const crush = createNoiseSource(ctx, 'white');
  const shape = ctx.createBiquadFilter();
  shape.type = 'lowpass';
  shape.frequency.value = 1200 * p;
  shape.Q.value = 0.9;

  const crushEnv = ctx.createGain();
  pluck(crushEnv.gain, t0, 0.3, 0.002, 0.038);

  chain(crush, shape, crushEnv, out);
  crush.start(t0, noiseOffset());
  crush.stop(t0 + 0.04);
  autoRelease(crush, shape, crushEnv);

  return { duration };
}

/**
 * Player hit: a heavy body blow, felt rather than heard.
 *
 * The player is already being told they were hit by the screen shake and the
 * health bar, so the audio only has to confirm it — and confirmation in a
 * bullet hell has to be something you can take a hundred times in a run. It is
 * all bottom end: 110Hz down to 30Hz for the hull resonance, and a 500Hz
 * muffled steel knock for the contact. Nothing above 500Hz at all.
 *
 * That ceiling is the point. Damage is the moment a player is most stressed,
 * and any high-frequency content on it converts stress into fatigue.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function playerHit(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.26;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const impact = ctx.createOscillator();
  impact.type = 'sine';
  impact.frequency.setValueAtTime(110 * p, t0);
  impact.frequency.exponentialRampToValueAtTime(30 * p, t0 + duration);
  const impactEnv = ctx.createGain();
  pluck(impactEnv.gain, t0, 0.85, 0.004, duration - 0.004);
  chain(impact, impactEnv, out);
  impact.start(t0);
  impact.stop(t0 + duration);
  // The tail rides the LONGEST voice. Hanging it off one of the short layers
  // disconnects the output stage while this one is still decaying, which
  // truncates the very sub-bass the sound is built around.
  autoRelease(impact, impactEnv, ...tail);

  // The steel, heard through the hull rather than against it.
  const knock = ctx.createOscillator();
  knock.type = 'triangle';
  knock.frequency.setValueAtTime(500 * p, t0);
  knock.frequency.exponentialRampToValueAtTime(190 * p, t0 + 0.11);
  const knockEnv = ctx.createGain();
  pluck(knockEnv.gain, t0, 0.3, 0.003, 0.1);
  chain(knock, knockEnv, out);
  knock.start(t0);
  knock.stop(t0 + 0.12);
  autoRelease(knock, knockEnv);

  const crunch = createNoiseSource(ctx, 'white');
  const crunchTone = ctx.createBiquadFilter();
  crunchTone.type = 'lowpass';
  crunchTone.frequency.value = 500 * p;
  crunchTone.Q.value = 0.8;
  const crunchEnv = ctx.createGain();
  pluck(crunchEnv.gain, t0, 0.4, 0.002, 0.08);
  chain(crunch, crunchTone, crunchEnv, out);
  crunch.start(t0, noiseOffset());
  crunch.stop(t0 + 0.1);
  autoRelease(crunch, crunchTone, crunchEnv);

  return { duration };
}

/**
 * Orb pickup: a warm magnetic chime.
 *
 * Fires more often than any sound but the weapon, so it is a single sine with
 * no filter and no noise — the cheapest graph in the file, by design, and now
 * also the softest. A pure sine has no harmonics at all, which means there is
 * literally nothing here to shave: 520Hz rising to 780Hz is the entire
 * spectrum of the sound.
 *
 * The rise is gentle rather than snapped, and the decay is quick — closer to a
 * marimba than to a pickup beep. At this repetition rate the difference
 * between "chime" and "beep" is the difference between collecting and being
 * nagged.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function orbPickup(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const duration = 0.09;

  const { node: out, tail } = outputStage(ctx, destination, params);

  const chime = ctx.createOscillator();
  chime.type = 'sine';
  chime.frequency.setValueAtTime(520 * p, t0);
  // Most of the rise happens early, then it settles — a linear glide across
  // the whole note reads as a siren, however short.
  chime.frequency.exponentialRampToValueAtTime(780 * p, t0 + duration * 0.45);

  const env = ctx.createGain();
  // A slower attack than the impacts: 8ms is still instant to the ear but
  // takes the click off the front, which is what made it read as a "beep".
  pluck(env.gain, t0, 0.26, 0.008, duration - 0.008);

  chain(chime, env, out);
  chime.start(t0);
  chime.stop(t0 + duration);
  autoRelease(chime, env, ...tail);

  return { duration };
}

/**
 * Level up: a rising three-note arpeggio on the music's own root.
 *
 * Tuned to A minor so it lands IN the track rather than across it — a reward
 * jingle in an unrelated key is the fastest way to make a soundtrack sound
 * cheap.
 *
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {{gain?: number, pitch?: number, pan?: number}} [params]
 * @returns {{duration: number}}
 */
export function levelUp(ctx, destination, params = {}) {
  const t0 = ctx.currentTime;
  const p = pitchOf(params);
  const step = 0.07;
  const ring = step * 2.4;
  // The third note starts two steps in and rings for `ring` after that, so the
  // sound is not over at step*4 — the arpeggio's last note would have been cut
  // off by its own output stage being released early.
  const duration = step * 2 + ring;

  const { node: out, tail } = outputStage(ctx, destination, params);

  // A4, C5, E5 — the tonic triad, straight up.
  [440, 523.25, 659.25].forEach((hz, index) => {
    const at = t0 + index * step;
    const note = ctx.createOscillator();
    note.type = 'triangle';
    note.frequency.value = hz * p;
    const env = ctx.createGain();
    pluck(env.gain, at, 0.28, 0.005, step * 2.2);
    chain(note, env, out);
    note.start(at);
    note.stop(at + ring);
    autoRelease(note, env);
  });

  releaseAfter(ctx, out, t0, duration, tail);
  return { duration };
}

/* ========================================================================= */
/* THE PALETTE                                                               */
/* ========================================================================= */

/**
 * Every sound, by id.
 *
 * The ids are the contract between the event bridge and the synths — the
 * manager dispatches strings, so adding a sound is adding one entry here and
 * one line in the bridge, with no other file involved.
 *
 * @type {Object<string, (ctx: Object, destination: Object, params?: Object) => {duration: number}>}
 */
export const SFX = {
  /* Weapons */
  laser_repeater: laserRepeater,
  nova_flak: novaFlak,
  tesla_arc: teslaArc,
  missile_launch: missileLaunch,

  /* Active skills */
  afterburner: afterburner,
  phase_shift: phaseShift,
  singularity: singularity,
  emp_blast: empBlast,

  /* Bosses and field threats */
  boss_inbound: bossInbound,
  armor_deflect: armorDeflect,
  part_destroyed: partDestroyed,
  rammer_lock: rammerLock,

  /* Console UI and crates */
  ui_click: uiClick,
  card_pop: cardPop,
  crate_rattle: crateRattle,
  crate_blast: crateBlast,

  /* The small change */
  enemy_pop: enemyPop,
  player_hit: playerHit,
  orb_pickup: orbPickup,
  level_up: levelUp,
};

/** @type {string[]} Every id in SFX, for tests and dev tooling. */
export const SFX_IDS = Object.keys(SFX);

/**
 * Play one sound by id.
 *
 * Unknown ids return null rather than throwing: a typo in the bridge should
 * cost the player one sound effect, not the frame it was triggered on.
 *
 * @param {string} id
 * @param {BaseAudioContext} ctx
 * @param {Object} destination
 * @param {Object} [params]
 * @returns {{duration: number}|null}
 */
export function playSfx(id, ctx, destination, params = {}) {
  const synth = SFX[id];
  if (!synth) {
    console.warn(`[BloomWake] Unknown sound id "${id}".`);
    return null;
  }
  return synth(ctx, destination, params);
}
