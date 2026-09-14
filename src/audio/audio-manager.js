/**
 * The audio manager — the one module that owns the AudioContext.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * Three jobs, and deliberately no fourth:
 *
 *   1. THE MIX. One master gain with an SFX bus and a music bus under it, so
 *      the portal can kill every sound in the game with a single call before
 *      an ad and bring it back after.
 *   2. THE UNLOCK. Browsers will not start an AudioContext without a gesture.
 *      This is the only place that knows that.
 *   3. THE BRIDGE. The simulation announces what happened on the event bus;
 *      this decides what that sounds like.
 *
 * ---------------------------------------------------------------------------
 * THE SIMULATION STAYS DEAF, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * Nothing in src/core imports this file, knows an AudioContext exists, or ever
 * will. Core emits `boss:deflected`; the fact that a deflection makes a noise
 * is a decision made HERE, in exactly the same way the renderer decides that a
 * deflection makes a spark. That is what keeps the simulation testable in plain
 * Node, and it is why adding a sound never touches a rule.
 *
 * The bridge is therefore a table of subscriptions and nothing else. If a sound
 * needs information the events do not carry, the fix is a richer payload on the
 * event — never a reach into the simulation from here.
 *
 * ---------------------------------------------------------------------------
 * AUDIO IS NEVER ALLOWED TO BREAK THE GAME
 * ---------------------------------------------------------------------------
 * Every public method works before `init()`, after a failed `init()`, and in
 * an environment with no Web Audio at all — they become no-ops. A browser that
 * refuses to give us a context, a phone that runs out of voices, an ad SDK
 * that suspends us and never resumes: all of those cost the player the sound
 * and nothing else. There is no path here that can throw into a frame.
 */

import { SFX, playSfx } from './sound-synth.js';
import { MusicSynth, MUSIC_MODES, CROSSFADE_SEC } from './music-synth.js';

export { MUSIC_MODES };

/**
 * Opening levels.
 *
 * Music sits well under the effects on purpose: it is a bed, and a player who
 * notices the soundtrack during a wave is a player who cannot hear the lock-on
 * warning. Master is under 1 so that a loud moment — a crate blast over a boss
 * layer — has headroom to be loud instead of clipping.
 */
export const DEFAULT_VOLUMES = { master: 0.8, sfx: 0.9, music: 0.5 };

/**
 * How many sounds may be in flight at once.
 *
 * A late wave can kill fifteen enemies inside one frame. Past roughly two
 * dozen simultaneous voices nothing is individually audible anyway, so the
 * ceiling costs no information — and without it a swarm death spikes the audio
 * thread hard enough to drop frames on a phone.
 */
export const MAX_VOICES = 24;

/**
 * Minimum seconds between two plays of the same sound.
 *
 * Retriggering an identical graph faster than this does not sound like a
 * faster weapon, it sounds like a flanger: the copies phase against each other
 * and the result is a metallic whoosh instead of a shot. Only the sounds that
 * can genuinely machine-gun are listed; everything else is unthrottled.
 */
export const THROTTLE_SEC = {
  laser_repeater: 0.045,
  tesla_arc: 0.05,
  nova_flak: 0.05,
  missile_launch: 0.06,
  enemy_pop: 0.03,
  armor_deflect: 0.045,
  player_hit: 0.12,
  orb_pickup: 0.04,
  rammer_lock: 0.4,
  ui_click: 0.03,
  card_pop: 0.02,
};

/**
 * Per-play random pitch spread, as a fraction.
 *
 * The repeated sounds get the widest spread. A laser that fires at exactly
 * 900Hz ten times a second stops being a weapon and becomes a tone within
 * about thirty seconds; ±7% is enough to keep the ear hearing shots.
 */
const PITCH_VARIANCE = {
  laser_repeater: 0.07,
  tesla_arc: 0.12,
  nova_flak: 0.08,
  missile_launch: 0.06,
  enemy_pop: 0.16,
  player_hit: 0.08,
  orb_pickup: 0.05,
  armor_deflect: 0.1,
  card_pop: 0.08,
  crate_rattle: 0.06,
};

/**
 * Sounds that ignore the voice ceiling.
 *
 * These are the ones the player must hear even in the middle of a swarm death,
 * because each of them is information rather than decoration: an alarm they
 * have to react to, or the payout of a run.
 */
const PRIORITY = new Set([
  'boss_inbound',
  'rammer_lock',
  'part_destroyed',
  'crate_blast',
  'crate_rattle',
  'level_up',
  'ui_click',
]);

/**
 * Which active skill sounds like what.
 *
 * Four of the seven have a synth of their own; the other three borrow, with
 * the pitch moved far enough that they read as separate events. Overcharge is
 * a low electrical surge, point defense a short high launch — both are
 * recognisably "a thing the ship did", which is all they need to be.
 */
const SKILL_SFX = {
  afterburner: { id: 'afterburner' },
  emp_shockwave: { id: 'emp_blast' },
  missile_salvo: { id: 'missile_launch', gain: 1.1 },
  phase_shift: { id: 'phase_shift' },
  singularity_anchor: { id: 'singularity' },
  overcharge_core: { id: 'tesla_arc', pitch: 0.55, gain: 1.2 },
  point_defense: { id: 'missile_launch', pitch: 1.35, gain: 0.8 },
};

/**
 * Gesture events that may unlock a suspended context.
 *
 * `touchend` is in the list specifically for iOS. WebKit suspends the context
 * when the tab is backgrounded or a call arrives, and will only resume it from
 * inside a handler it considers a completed user gesture — a `touchstart` that
 * turns out to be the start of a scroll does not always qualify, and a
 * visibilitychange never does. Listening on all four costs nothing: the
 * listeners take themselves off as soon as one resume actually lands.
 */
export const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'touchstart', 'keydown'];

/** @returns {number} A multiplier in [1 - spread, 1 + spread]. */
const jitter = (spread) => 1 + (Math.random() * 2 - 1) * spread;

/** @param {number} v @returns {number} */
const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

export class AudioManager {
  /**
   * @param {Object} [options]
   * @param {() => Object} [options.contextFactory] - Builds the AudioContext.
   *   Injected by tests, which have no Web Audio.
   * @param {Object} [options.volumes] - Overrides for DEFAULT_VOLUMES
   * @param {boolean} [options.autoStartMusic] - Start the score on unlock
   * @param {Object} [options.musicOptions] - Passed through to MusicSynth
   */
  constructor(options = {}) {
    this.contextFactory = options.contextFactory ?? defaultContextFactory;
    this.autoStartMusic = options.autoStartMusic ?? true;
    this.musicOptions = options.musicOptions ?? {};

    /** @type {Object|null} The AudioContext, once init() has succeeded. */
    this.ctx = null;
    /** @type {MusicSynth|null} */
    this.music = null;
    /** @type {boolean} True once a gesture has resumed the context. */
    this.unlocked = false;
    /** @type {boolean} The player's own mute — the settings toggle. */
    this.muted = false;
    /**
     * The portal's `muteAudio` setting.
     *
     * A THIRD mute rather than a call to `mute()`, because the portal's setting
     * OVERRIDES the player's and must survive them toggling theirs: a player
     * who un-mutes the game while CrazyGames has audio switched off gets
     * silence and a settings toggle that remembers what they asked for, not
     * sound. Folding it into `this.muted` would make un-muting from the
     * settings modal quietly defeat the platform.
     * @type {boolean}
     */
    this.platformMuted = false;
    /**
     * Ducked for the duration of a video ad.
     *
     * Also separate, and for the same reason in the other direction: the ad is
     * over in thirty seconds and the player's own preference has to come back
     * exactly as it was, including when it was "muted" before the ad started.
     * @type {boolean}
     */
    this.adMuted = false;

    this.volumes = { ...DEFAULT_VOLUMES, ...(options.volumes ?? {}) };

    /** Unsubscribe functions from the event bus and the unlock listeners. */
    this.subscriptions = [];
    this.unlockTeardown = null;

    /**
     * End times of the voices currently sounding, on the audio clock.
     *
     * An array of numbers rather than a pool of reusable nodes, because Web
     * Audio sources are single-use by design — an OscillatorNode cannot be
     * restarted once stopped. What is actually scarce is the audio thread's
     * mixing budget, so that is what this pools: the right to be one of
     * MAX_VOICES sounds playing at this instant.
     * @type {number[]}
     */
    this.voices = [];

    /** @type {Map<string, number>} Last play time per sound id. */
    this.lastPlayed = new Map();
  }

  /** @returns {boolean} Whether sound can actually be produced right now. */
  get ready() {
    return this.ctx !== null;
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Build the context and the mix graph.
   *
   * Safe to call more than once and safe to call before any gesture — the
   * context is simply created suspended, and the first gesture resumes it.
   * Creating it EARLY rather than on the gesture is deliberate: context
   * construction takes a few milliseconds, and paying that on the player's
   * first click is a click that makes no sound.
   *
   * @returns {boolean} Whether audio is available
   */
  init() {
    if (this.ctx) return true;

    let ctx;
    try {
      ctx = this.contextFactory();
    } catch (error) {
      console.warn('[BloomWake] Web Audio unavailable; running silent.', error);
      return false;
    }
    if (!ctx) return false;

    this.ctx = ctx;

    //        master
    //       /      \
    //    sfx        music
    // One node between every sound and the speakers, which is what makes
    // mute() a single assignment instead of a walk over live voices.
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.isSilenced() ? 0 : this.volumes.master;
    this.masterGain.connect(ctx.destination);

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.volumes.sfx;
    this.sfxGain.connect(this.masterGain);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.volumes.music;
    this.musicGain.connect(this.masterGain);

    this.music = new MusicSynth(ctx, this.musicGain, this.musicOptions);

    // Already running (a context created during a gesture, or a browser with
    // no autoplay policy) means there is nothing to unlock.
    if (ctx.state === 'running') this.unlocked = true;

    return true;
  }

  /**
   * Listen for the first gesture and resume the context on it.
   *
   * Every browser gates audio on a user gesture, and the failure mode when you
   * get this wrong is the worst kind: the game works perfectly in development,
   * ships, and is silent for everybody. The listeners cover pointer, touch and
   * keyboard because the game is playable with any of the three, and they stay
   * attached until a resume actually succeeds — `resume()` can reject, and a
   * one-shot listener would have spent the only attempt.
   *
   * @param {EventTarget} [target] - Defaults to the document
   * @returns {() => void} Teardown
   */
  attachUnlock(target = globalThis.document ?? globalThis) {
    if (this.unlockTeardown) return this.unlockTeardown;
    if (!target?.addEventListener) return () => {};

    const handler = () => {
      this.unlock().then((ok) => {
        if (ok) this.detachUnlock();
      });
    };

    for (const type of UNLOCK_EVENTS) {
      target.addEventListener(type, handler, { passive: true });
    }

    this.unlockTeardown = () => {
      for (const type of UNLOCK_EVENTS) target.removeEventListener(type, handler);
      this.unlockTeardown = null;
    };
    return this.unlockTeardown;
  }

  /** Remove the unlock listeners. */
  detachUnlock() {
    this.unlockTeardown?.();
  }

  /**
   * Resume the context, and start the score if this is the first time.
   *
   * @returns {Promise<boolean>} Whether the context is running afterwards
   */
  async unlock() {
    if (!this.init()) return false;

    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (error) {
        // A resume outside a real gesture rejects. The listeners are still
        // attached, so the next click gets another go.
        console.warn('[BloomWake] Audio resume refused.', error);
        return false;
      }
    }

    this.unlocked = this.ctx.state !== 'suspended';
    if (this.unlocked && this.autoStartMusic) this.music?.start();
    return this.unlocked;
  }

  /* ------------------------------------------------------------------ */
  /* The event bridge                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Subscribe to the simulation's events.
   *
   * Every handler calls a named method on `this` rather than reaching for a
   * synth directly. That indirection is what makes the bridge testable — a
   * test can spy on `playDeflect` and assert the wiring without a working
   * AudioContext — and it is also where a sound's parameters live, so the
   * table below stays a list of what-means-what.
   *
   * @param {import('../core/event-bus.js').EventBus} bus
   * @returns {() => void} Unsubscribe everything
   */
  connect(bus) {
    const on = (event, handler) => {
      this.subscriptions.push(bus.on(event, handler));
    };

    /* --- Weapons ---------------------------------------------------- */
    on('weapon:fire', () => this.playWeapon('laser_repeater'));
    on('weapon:chain_lightning', () => this.playWeapon('tesla_arc'));
    on('card:burst', () => this.playWeapon('nova_flak'));
    on('card:nanite_launch', () => this.playWeapon('missile_launch'));

    /* --- Active skills ---------------------------------------------- */
    // `skill:cast` is what the skill system actually emits; `skill:trigger` is
    // bound alongside it so a future rename, or a caller that fires the more
    // obvious name, still makes a sound.
    on('skill:cast', (data) => this.playSkill(data?.skillId));
    on('skill:trigger', (data) => this.playSkill(data?.skillId));

    /* --- Bosses and field threats ----------------------------------- */
    on('boss:spawned', () => {
      this.playBossInbound();
      this.setMusicMode(MUSIC_MODES.BOSS);
    });
    on('boss:deflected', () => this.playDeflect());
    on('boss:part_destroyed', () => this.playPartDestroyed());
    on('boss:phase', () => this.playPhaseShiftWarning());
    on('enemy:lock_on', () => this.playLockOnAlert());

    /* --- The arena floor -------------------------------------------- */
    on('enemy:death', () => this.playEnemyDeath());
    on('player:damage', () => this.playPlayerHit());
    on('player:level_up', () => this.playLevelUp());
    on('orb:collected', () => this.playOrbPickup());

    /* --- Console and crates ----------------------------------------- */
    on('draft:offer', () => this.playCardPop());
    on('card:selected', () => this.playUiClick());
    on('crate:open', () => this.playCrateRattle());
    on('crate:blast', () => this.playCrateBlast());

    /* --- Score intensity -------------------------------------------- */
    // wave:start rather than state:change, because a boss wave emits both and
    // the boss handler above must win. Ordering is not relied on: a boss wave
    // emits boss:spawned after wave:start, so BOSS lands last either way.
    on('wave:start', () => this.setMusicMode(MUSIC_MODES.COMBAT));
    on('game:over', () => this.setMusicMode(MUSIC_MODES.AMBIENT));
    on('game:victory', () => this.setMusicMode(MUSIC_MODES.AMBIENT));
    on('state:reset', () => this.setMusicMode(MUSIC_MODES.AMBIENT));

    return () => this.disconnect();
  }

  /** Drop every event subscription. */
  disconnect() {
    for (const off of this.subscriptions) {
      try {
        off();
      } catch {
        // A bus that has already been cleared; nothing to unsubscribe from.
      }
    }
    this.subscriptions = [];
  }

  /* ------------------------------------------------------------------ */
  /* Playback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Play one sound, subject to the throttle and the voice ceiling.
   *
   * Returns whether it actually sounded, which is information the callers
   * ignore and the tests do not.
   *
   * @param {string} id - A key of SFX
   * @param {Object} [params] - `{ gain, pitch, pan }`
   * @returns {boolean}
   */
  play(id, params = {}) {
    if (!this.ctx || this.isSilenced()) return false;
    // A suspended context accepts scheduling and plays the backlog all at once
    // on resume — a burst of stale sound at the exact moment the player first
    // clicks. Dropping them costs nothing: nobody can hear a sound played
    // while audio is off.
    if (this.ctx.state === 'suspended') return false;
    if (!SFX[id]) return false;

    const now = this.ctx.currentTime;

    const gap = THROTTLE_SEC[id];
    if (gap !== undefined) {
      const last = this.lastPlayed.get(id);
      if (last !== undefined && now - last < gap) return false;
    }

    this.pruneVoices(now);
    if (this.voices.length >= MAX_VOICES && !PRIORITY.has(id)) return false;

    const spread = PITCH_VARIANCE[id] ?? 0;
    const played = playSfx(id, this.ctx, this.sfxGain, {
      ...params,
      pitch: (params.pitch ?? 1) * (spread > 0 ? jitter(spread) : 1),
    });
    if (!played) return false;

    this.lastPlayed.set(id, now);
    this.voices.push(now + played.duration);
    return true;
  }

  /**
   * Drop finished voices.
   *
   * Timer-free on purpose: the audio clock already knows when each graph ends,
   * so the pool is reconciled on the next play instead of by MAX_VOICES
   * pending timeouts.
   *
   * @param {number} now
   */
  pruneVoices(now) {
    let kept = 0;
    for (const end of this.voices) {
      if (end > now) this.voices[kept++] = end;
    }
    this.voices.length = kept;
  }

  /* -- Named triggers. The bridge calls these; tests spy on them. ----- */

  /** @param {string} id @param {Object} [params] */
  playWeapon(id, params) {
    return this.play(id, params);
  }

  /**
   * @param {string} [skillId] - An ACTIVE_SKILL_IDS value
   * @returns {boolean}
   */
  playSkill(skillId) {
    const spec = SKILL_SFX[skillId];
    // An unmapped skill is a new skill that nobody gave a sound yet. The EMP
    // is the most generic of the seven, so it is the stand-in that makes a
    // missing mapping sound underwhelming rather than broken.
    if (!spec) return this.play('emp_blast', { gain: 0.8 });
    return this.play(spec.id, { gain: spec.gain ?? 1, pitch: spec.pitch ?? 1 });
  }

  /** The two-tone klaxon when a boss enters the field. */
  playBossInbound() {
    return this.play('boss_inbound', { gain: 0.9 });
  }

  /** A round bouncing off boss armour. */
  playDeflect() {
    return this.play('armor_deflect');
  }

  /** A boss limb coming off. */
  playPartDestroyed() {
    return this.play('part_destroyed', { gain: 1.05 });
  }

  /**
   * The boss changing phase.
   *
   * The same klaxon as the arrival, pitched up and shortened by the pitch
   * shift itself — "this got worse", in the vocabulary the player already
   * learned twenty seconds ago, rather than a new sound to decode mid-fight.
   */
  playPhaseShiftWarning() {
    return this.play('boss_inbound', { pitch: 1.25, gain: 0.7 });
  }

  /** A rammer has locked on and is about to charge. */
  playLockOnAlert() {
    return this.play('rammer_lock', { gain: 0.85 });
  }

  /** @returns {boolean} */
  playEnemyDeath() {
    return this.play('enemy_pop', { gain: 0.55 });
  }

  /** @returns {boolean} */
  playPlayerHit() {
    return this.play('player_hit', { gain: 0.9 });
  }

  /** @returns {boolean} */
  playOrbPickup() {
    return this.play('orb_pickup', { gain: 0.35 });
  }

  /** @returns {boolean} */
  playLevelUp() {
    return this.play('level_up', { gain: 0.8 });
  }

  /** A console button. */
  playUiClick() {
    return this.play('ui_click', { gain: 0.6 });
  }

  /** A card landing on the console. */
  playCardPop() {
    return this.play('card_pop', { gain: 0.7 });
  }

  /** Crate seals resisting. */
  playCrateRattle() {
    return this.play('crate_rattle', { gain: 0.8 });
  }

  /** Crate seals losing. */
  playCrateBlast() {
    return this.play('crate_blast', { gain: 1 });
  }

  /* ------------------------------------------------------------------ */
  /* Music                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * @param {string} mode - One of MUSIC_MODES
   * @param {number} [fade] - Crossfade seconds
   */
  setMusicMode(mode, fade = CROSSFADE_SEC) {
    this.music?.setMode(mode, fade);
  }

  /** @returns {string|null} The live intensity mode. */
  get musicMode() {
    return this.music?.mode ?? null;
  }

  /** Start the score. No-op before init or before the unlock. */
  startMusic() {
    if (this.unlocked) this.music?.start();
  }

  /** Stop the score. */
  stopMusic() {
    this.music?.stop();
  }

  /* ------------------------------------------------------------------ */
  /* Platform controls                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Silence everything.
   *
   * One assignment on the master gain, which is what makes this usable from an
   * ad callback: the portal gives us no warning and no time, and anything that
   * had to walk live voices or await a suspend would still be running when the
   * ad's own audio starts.
   *
   * The cut is instantaneous rather than ramped. A hard gain change can click,
   * but every caller for this is a hand-off to somebody else's audio (an ad, a
   * backgrounded tab), where a two-millisecond artefact is the correct price
   * for being silent NOW.
   */
  mute() {
    this.muted = true;
    this.applyMasterGain();
  }

  /**
   * Release the player's own mute.
   *
   * Does NOT necessarily make a sound: the portal's `muteAudio` and an ad in
   * progress both outrank it, and `applyMasterGain` is what decides. That is
   * the whole reason this goes through a single evaluator rather than writing
   * `volumes.master` straight onto the node.
   */
  unmute() {
    this.muted = false;
    this.applyMasterGain();
  }

  /**
   * The portal's `muteAudio` setting, which the platform requires us to honour
   * above the in-game toggle.
   *
   * @param {boolean} value
   */
  setPlatformMute(value) {
    this.platformMuted = Boolean(value);
    this.applyMasterGain();
  }

  /**
   * Duck for a video ad.
   *
   * Called from the ad's `adStarted` and released on `adFinished`/`adError`.
   * Idempotent and total: releasing it restores whatever the player and the
   * platform had asked for, so an ad that errors halfway cannot strand the
   * game silent.
   *
   * @param {boolean} value
   */
  setAdMute(value) {
    this.adMuted = Boolean(value);
    this.applyMasterGain();
  }

  /**
   * @returns {boolean} Whether anything at all should be audible right now.
   *   Any one of the three mutes is enough to silence the game.
   */
  isSilenced() {
    return this.muted || this.platformMuted || this.adMuted;
  }

  /**
   * Push the three mutes and the master volume onto the gain node.
   *
   * The ONE place the master gain is ever written, so there is no ordering
   * between "the portal muted us" and "the player un-muted" to get wrong —
   * every caller states its own flag and asks this to resolve the result.
   */
  applyMasterGain() {
    if (!this.masterGain) return;
    this.masterGain.gain.value = this.isSilenced() ? 0 : this.volumes.master;
  }

  /** @returns {boolean} The new muted state. */
  toggleMute() {
    if (this.muted) this.unmute();
    else this.mute();
    return this.muted;
  }

  /** @returns {boolean} */
  isMuted() {
    return this.muted;
  }

  /**
   * @param {number} value - 0..1
   */
  setMasterVolume(value) {
    this.volumes.master = clamp01(value);
    // A volume set while any mute is in force is remembered, not applied —
    // otherwise the settings slider would silently override the portal, or
    // talk over an ad.
    this.applyMasterGain();
  }

  /** @param {number} value - 0..1 */
  setSfxVolume(value) {
    this.volumes.sfx = clamp01(value);
    if (this.sfxGain) this.sfxGain.gain.value = this.volumes.sfx;
  }

  /** @param {number} value - 0..1 */
  setMusicVolume(value) {
    this.volumes.music = clamp01(value);
    if (this.musicGain) this.musicGain.gain.value = this.volumes.music;
  }

  /** @returns {{master: number, sfx: number, music: number}} A copy. */
  getVolumes() {
    return { ...this.volumes };
  }

  /**
   * Suspend the context entirely — a deeper cut than mute, for a backgrounded
   * tab, where the goal is to stop burning CPU rather than to stop being
   * heard.
   * @returns {Promise<void>}
   */
  async suspend() {
    if (this.ctx?.state === 'running') {
      try {
        await this.ctx.suspend();
      } catch {
        // Nothing to suspend; a context that will not suspend is not a bug we
        // can do anything about from here.
      }
    }
  }

  /** @returns {Promise<void>} */
  async resume() {
    if (this.ctx?.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // Lost the gesture grant; the unlock listeners handle the next click.
      }
    }
  }

  /** Tear everything down. Used by tests and hot reload, not by the game. */
  dispose() {
    this.disconnect();
    this.detachUnlock();
    this.music?.dispose();
    try {
      this.ctx?.close?.();
    } catch {
      // Already closed.
    }
    this.ctx = null;
    this.music = null;
    this.voices.length = 0;
    this.lastPlayed.clear();
  }
}

/**
 * The real browser AudioContext, behind the webkit prefix that iOS still needs.
 * @returns {Object|null}
 */
function defaultContextFactory() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}
