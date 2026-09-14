/**
 * BloomWake Phase 1 — browser entry point.
 * Wires the pure simulation to input, renderer and HUD, and drives the loop.
 */

import { globalBus } from './core/event-bus.js';
import { GameState, GAME_STATES } from './core/game-state.js';
import { Simulation } from './core/simulation.js';
import { PHASE1 } from './core/constants.js';
import { mulberry32 } from './core/math.js';
import { purchaseUpgrade } from './core/meta-shop.js';
import { purchaseCosmetic, equipCosmetic, getEquippedCosmetic } from './core/cosmetics.js';
import { claimDailyBloom } from './core/daily-bloom.js';
import {
  openSmallCapsule,
  completeRun,
  forfeitsRunRewards,
  forfeitRunRewards,
} from './core/meta-progression.js';
import { KeyboardInput } from './input/input.js';
import { TouchControls, isTouchDevice } from './input/touch-controls.js';
import { Renderer } from './render/renderer.js';
import { assets, ASSET_MANIFEST } from './core/assets.js';
import { createPixiLoader, installPlaceholders } from './render/pixi-loader.js';
import { reportAssetContrast } from './render/asset-audit.js';
import { Hud } from './ui/hud.js';
import { equipActiveSkill } from './core/active-skills.js';
import { MetaUi } from './ui/meta-ui.js';
import { CrateModal } from './ui/crate-modal.js';
import { loadSave, saveState } from './ui/storage.js';
import { clearPendingScrap, loadState } from './core/state.js';
import { MetaEconomy } from './core/meta-economy.js';
import { getCrateTypeForWave } from './data/crates-config.js';
import { crazyGames, AD_TYPES } from './services/crazygames.js';
import { storageService } from './services/storage-service.js';
import { AudioManager, MUSIC_MODES } from './audio/audio-manager.js';
import { SettingsManager } from './core/settings-manager.js';
import { SettingsModal } from './ui/settings-modal.js';
import { PauseModal } from './ui/pause-modal.js';

/** Fixed simulation step keeps physics and damage timing frame-rate independent. */
const FIXED_DT = 1 / 60;
/** Cap on catch-up time after a stall (tab switch, breakpoint). */
const MAX_FRAME_TIME = 0.25;

const state = new GameState(globalBus, { maxWaves: PHASE1.MAX_WAVES });
const simulation = new Simulation({
  useCompositeBosses: true,
  // Regular arrivals now come from src/data/roster-config.js's archetypes
  // (spawnRosterEnemy) instead of the legacy Chitin Swarm roster, so the new
  // species — spore_barrage at wave 4, brood_bastion at wave 5 — actually
  // reach the field.
  useRosterConfig: true,
  bus: globalBus,
  state,
  seed: Math.floor(Math.random() * 0xffffffff),
});

const canvas = document.getElementById('game-canvas');
const uiLayer = document.getElementById('ui-layer');
const appContainer = document.getElementById('app-container');
/**
 * Renderer is created after preload, so it is assigned during boot() rather
 * than at module scope.
 * @type {Renderer}
 */
let renderer;

const hud = new Hud(uiLayer, simulation, {
  onChooseCard: (cardId) => state.chooseCard(cardId),
  onPause: () => openPause(),
});

/* ------------------------------------------------------------------------ */
/* Audio                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Sound, synthesised live. See src/audio/ for why there are no audio files.
 *
 * `connect` subscribes to the SAME events the renderer listens on, which is
 * the whole architecture in one line: the simulation announces what happened,
 * and the two presentation layers independently decide what that looks like
 * and what it sounds like. Neither knows the other exists, and core knows
 * about neither.
 */
const audio = new AudioManager();
audio.init();
audio.connect(globalBus);

/*
 * The autoplay unlock. Every browser refuses to start an AudioContext without
 * a gesture, so the listeners go on the document now and take themselves off
 * as soon as a resume actually lands — in practice the first click of the
 * menu's Play button.
 *
 * That first click is itself silent, and unavoidably so: `resume()` is async,
 * so the context is still suspended when the click handler runs. Everything
 * from the second gesture onward has sound, which is how every web game
 * behaves and is why the menu, not the arena, is where the unlock happens.
 */
audio.attachUnlock(document);

/*
 * Console clicks, in one delegated listener rather than a call in every
 * handler. Two reasons: the meta UI, the HUD and the crate modal build their
 * buttons independently and would each have to remember, and `pointerdown`
 * fires BEFORE the click handler, so the relay snaps at the moment of the
 * press rather than a frame after whatever the button did.
 */
uiLayer.addEventListener(
  'pointerdown',
  (event) => {
    if (event.target.closest?.('button, [role="button"]')) audio.playUiClick();
  },
  { passive: true }
);

/*
 * A paused game is a game the player has walked away from, so the score drops
 * to the menu bed rather than looping a combat line at a frozen arena.
 *
 * The mode is remembered rather than assumed, because pausing mid-boss and
 * coming back to combat music would quietly undo the one moment the score
 * exists for.
 */
let musicModeBeforePause = null;
globalBus.on('state:change', ({ from, to }) => {
  if (to === GAME_STATES.PAUSED) {
    musicModeBeforePause = audio.musicMode;
    audio.setMusicMode(MUSIC_MODES.AMBIENT);
  } else if (from === GAME_STATES.PAUSED && to === GAME_STATES.RUNNING) {
    audio.setMusicMode(musicModeBeforePause ?? MUSIC_MODES.COMBAT);
  }
});

/* ------------------------------------------------------------------------ */
/* Settings, pause and abandon                                               */
/* ------------------------------------------------------------------------ */

/**
 * The player's preferences, and the one place they are stored.
 *
 * Kept deliberately separate from the meta-save and the crate wallet: those
 * record what a player has earned, this records how they want the game to
 * behave, and a migration to one must never be able to damage the other.
 */
const settings = new SettingsManager();

/**
 * Push the current settings out to everything that consumes them.
 *
 * This is the ONLY place preferences reach the audio manager and the renderer.
 * Neither of them imports the settings module — they expose plain setters and
 * are told, which is what keeps a preference from becoming a hidden dependency
 * of the render loop.
 *
 * Called on every change and once at boot, so there is no path where a stored
 * preference is persisted but never applied.
 *
 * @param {Object} next - A complete settings object
 */
function applySettings(next) {
  audio.setMasterVolume(next.masterVolume);
  audio.setSfxVolume(next.sfxVolume);
  audio.setMusicVolume(next.musicVolume);
  // After the volumes, never before: `unmute` restores the master volume, so
  // applying it first would push the OLD level and leave the slider lying.
  if (next.muted) audio.mute();
  else audio.unmute();

  // Absent until boot() finishes the preload; the settings are re-applied
  // there once it exists.
  renderer?.applySettings(next);
}

settings.subscribe((next) => applySettings(next));
applySettings(settings.getAll());

/*
 * The portal's audio switch, which OUTRANKS the settings modal.
 *
 * CrazyGames puts a mute control in its own chrome around the iframe, and a
 * game that keeps playing through it is a QA failure. The override is not
 * implemented by reaching for the in-game toggle — that would leave the
 * player's stored preference lying about what they asked for, and un-muting
 * from our settings screen would defeat the platform. Instead the audio manager
 * holds the platform mute as a channel of its own and silences the master gain
 * while EITHER is set; releasing the platform's restores exactly the preference
 * in `settings`, because that is the only thing applySettings ever wrote.
 */
crazyGames.onMuteChange((muted) => audio.setPlatformMute(muted));
audio.setPlatformMute(crazyGames.isPlatformMuted());

const settingsModal = new SettingsModal(uiLayer, {
  getSettings: () => settings.getAll(),
  onChange: (key, value) => settings.set(key, value),
  onReset: () => settings.reset(),
  // Closing the settings hands focus back to the pause panel when it is the
  // screen underneath, so Escape keeps working without a second click.
  onClose: () => pauseModal.refocus(),
});

// A private window cannot persist anything; say so rather than letting the
// player make choices that quietly evaporate on reload.
settingsModal.setPersistence(settings.persists);

/*
 * Re-render the open modal whenever the store changes.
 *
 * Restore Defaults is why: it moves seven controls at once, and without this
 * the player would press it and watch nothing happen. Ordinary edits are
 * already reflected by the control the player is touching, so this is a no-op
 * for them.
 */
settings.subscribe(() => {
  if (settingsModal.isOpen) settingsModal.render();
});

const pauseModal = new PauseModal(uiLayer, {
  onResume: () => resumeRun(),
  onOpenSettings: () => settingsModal.open(),
  onAbandon: () => abandonRun(),
});

/** Pause the run and show the panel. No-op unless a run is actually running. */
function openPause() {
  if (state.currentState !== GAME_STATES.RUNNING) return;
  state.pause();
  // Gameplay has genuinely broken off, so the portal's playtime interval
  // closes here. Every route into the pause panel — the HUD button, Escape, a
  // lost window focus — arrives through this one function, which is why the
  // telemetry lives here rather than inside the modal: the modal is a view and
  // does not know whether the simulation is actually stopped.
  crazyGames.gameplayStop();
  pauseModal.open({
    wave: state.wave,
    hp: state.player.hp,
    maxHp: state.player.maxHp,
    // Told, not recomputed: forfeitsRunRewards is the one place that rule
    // lives, and it is written for the `game:over` payload's shape (an
    // `abandoned` flag alongside the wave), so it is asked the same question
    // Abandon Run would actually trigger rather than reimplemented here.
    belowRewardThreshold: forfeitsRunRewards({ abandoned: true, wave: state.wave }),
  });
}

/** Hand control back to the run. */
function resumeRun() {
  if (state.currentState !== GAME_STATES.PAUSED) return;
  state.resume();
  // Guarded on the state above rather than fired unconditionally: an unpause of
  // a run that was not paused would open a second playtime interval the portal
  // has no stop for. The service latches as well, so this is belt and braces on
  // a number we cannot correct after the fact.
  crazyGames.gameplayStart();
}

/**
 * End the run early.
 *
 * Routed through the ordinary game-over path rather than resetting to the
 * menu, so the debrief still appears — the `abandoned: true` on the event is
 * what lets finishRun tell this apart from a death. Past the reward threshold
 * (see forfeitsRunRewards) the salvage crate and the banked Scrap happen
 * exactly as they would have on a death: the player gives up the run, not the
 * twenty minutes of progress in it. Short of the threshold there was no
 * progress to give up, so there is nothing to bank — see finishRun.
 */
function abandonRun() {
  pauseModal.close();
  if (state.currentState === GAME_STATES.PAUSED || state.currentState === GAME_STATES.RUNNING) {
    state.triggerGameOver({ abandoned: true });
  }
}

/**
 * Escape, from anywhere.
 *
 * Both modals also handle Escape on their own layer and stop it there, so this
 * only runs when focus is OUTSIDE them — after a click on the canvas, most
 * often. It therefore has to be able to close whatever is open rather than
 * assuming the pause panel is the top of the stack.
 */
function togglePause() {
  if (settingsModal.isOpen) {
    settingsModal.close();
    return;
  }
  if (pauseModal.isOpen) {
    pauseModal.resume();
    return;
  }
  openPause();
}

/* ------------------------------------------------------------------------ */
/* Meta-progression (Phase 5)                                                */
/* ------------------------------------------------------------------------ */

/**
 * Persistent across runs; every core action returns a new one.
 *
 * Deliberately NOT read from storage here. At module scope the storage service
 * has not resolved a driver yet — it cannot, because that decision waits on the
 * SDK handshake — so a read now would come back empty from the memory driver
 * and, worse, the first autosave would write that emptiness over the player's
 * real save. `hydrateFromStorage()` does the read, and boot() calls it at the
 * one moment it is correct to.
 */
let metaState = loadState(null);

/**
 * The crate economy — the game's ONE Scrap balance, plus chips and skill levels.
 *
 * Still a separate save from metaState, under its own storage key, because the
 * two change for independent reasons: a breaking change to crate drops should
 * not push a migration onto a player's upgrades, cosmetics and stats. But the
 * WALLET is unambiguously here. metaState records what the player owns; this
 * records what they can spend, and the shop, the liveries and the chip ladder
 * all price against this single number.
 *
 * The manager writes through on every mutation, so nothing here has to remember
 * to persist.
 */
const metaEconomy = new MetaEconomy();

/**
 * Read every save into memory. THE one hydration point.
 *
 * Called by boot() once `storageService.init()` has resolved a driver, and
 * again whenever the player signs in mid-session and the Data module starts
 * answering for a different account. Both cases are the same job: everything
 * currently in memory belongs to the wrong save, and all three stores have to
 * be re-read together or the wallet and the upgrades end up from different
 * accounts.
 */
function hydrateFromStorage() {
  metaState = loadSave();
  metaEconomy.load();
  settings.load();

  /*
   * v1 -> v2 save migration: fold a legacy Petal balance into the one wallet.
   *
   * Order is the whole correctness argument. The Scrap is credited and
   * PERSISTED first; only then is the legacy balance marked as handed over. A
   * tab that dies between the two re-runs the migration on next boot and
   * credits it again — which is the failure we want, because the alternative
   * ordering loses the player's entire balance to the same crash and cannot be
   * recovered.
   */
  if (metaState.pendingScrapTransfer > 0) {
    metaEconomy.addScrap(metaState.pendingScrapTransfer);
    console.info(
      `[BloomWake] Migrated ${metaState.pendingScrapTransfer} Petals into the Scrap wallet.`
    );
    commitMeta(clearPendingScrap(metaState));
  }
}

/*
 * A guest signing in swaps which account the cloud save belongs to, with no
 * page reload and no warning beyond this callback. Re-reading is not optional:
 * the next autosave would otherwise put the guest session's wallet on top of
 * whatever the player already had on their account.
 *
 * The service announces; it does not call into the managers itself. It cannot —
 * they import it, and a cycle between a save file and the things being saved is
 * how one of them ends up as an empty object at start-up.
 */
storageService.onRehydrate(() => {
  hydrateFromStorage();
  // The menu is the only screen that can be up when this fires — a sign-in
  // happens through the portal's chrome, not from inside a run — and it shows
  // the Scrap balance that has just changed underneath it.
  if (metaUi.isMenuVisible?.()) metaUi.renderMenu();
});

/**
 * The crate the finished run earned, held between the debrief and the modal.
 *
 * Its payout is ALREADY BANKED — openCrate writes to the save the moment the
 * run ends. This reference only exists so the modal knows what to animate and
 * so a rewarded ad knows what to double; losing it costs the player nothing.
 */
let pendingCrate = null;

/** Capsule RNG. Seeded per session so rewards are not replayable by reload. */
const rewardRng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);

/**
 * Commit a new meta-state and persist it.
 * @param {Object} next
 */
function commitMeta(next) {
  metaState = next;
  saveState(metaState);
}

const metaUi = new MetaUi(uiLayer, {
  getState: () => metaState,
  onPlay: () => startRun(),
  onOpenSettings: () => settingsModal.open(),
  /*
   * Both purchases are two writes to two saves: the thing bought lands in
   * metaState, the price comes out of the economy wallet. The debit goes second
   * so a failure between them leaves the player holding Scrap they have already
   * spent rather than a purchase they never paid for — the error that favours
   * the player is the one to pick.
   */
  onBuyUpgrade: (id) => {
    const result = purchaseUpgrade(metaState, id, metaEconomy.getState().scrap);
    if (result.ok) {
      commitMeta(result.state);
      metaEconomy.spendScrap(result.cost);
    }
    metaUi.renderShop();
  },
  onBuyCosmetic: (id) => {
    const result = purchaseCosmetic(metaState, id, metaEconomy.getState().scrap);
    if (result.ok) {
      commitMeta(result.state);
      metaEconomy.spendScrap(result.cost);
    }
    metaUi.renderShop();
  },
  onEquipCosmetic: (id) => {
    const result = equipCosmetic(metaState, id);
    if (result.ok) commitMeta(result.state);
    metaUi.renderShop();
  },
  onEquipSkill: (id) => {
    const result = equipActiveSkill(metaState, id);
    if (result.ok) commitMeta(result.state);
    metaUi.renderShop();
  },
  onClaimDaily: () => {
    const result = claimDailyBloom(metaState, Date.now(), rewardRng);
    if (result.ok) {
      commitMeta(result.state);
      metaEconomy.addScrap(result.reward.scrap);
      metaUi.showToast(result.reward);
    }
    metaUi.renderMenu();
  },

  /* Crate economy. The manager persists itself, so these only re-render. */
  getEconomy: () => metaEconomy.getState(),
  onUpgradeSkill: (chipKey) => {
    metaEconomy.upgradeSkill(chipKey);
    // Re-render on failure too: the button that was pressed is the one whose
    // "Need 2 more chips" label has to stay accurate.
    metaUi.renderShop();
  },
  onOpenCrate: () => {
    if (pendingCrate) crateModal.open(pendingCrate);
  },

  /*
   * The one midgame ad placement in the game.
   *
   * Leaving the debrief for the hangar is a break the player was already
   * taking: the run is over, the crate is banked, nothing is on screen that
   * they are in the middle of. Every other candidate — a wave transition, a
   * level-up draft, the crate reveal — interrupts something, and the portal
   * rejects games that do that.
   *
   * "Fly Again" deliberately does NOT carry an ad. It is the button that starts
   * a run, and putting thirty seconds of video between a player deciding to
   * play and playing is the single fastest way to lose the session.
   */
  onReturnToHangar: () => returnToHangar(),
});

/**
 * Was there a legendary in this crate?
 * @param {Object|null} crate - A result from MetaEconomy.openCrate
 * @returns {boolean}
 */
function hasLegendaryChip(crate) {
  return Boolean(crate?.chips?.some((chip) => chip.rarity === 'legendary'));
}

/* ------------------------------------------------------------------------ */
/* Midgame interstitial                                                      */
/* ------------------------------------------------------------------------ */

/**
 * How many runs a new player gets before they ever see an interstitial.
 *
 * The retention shield. A player's first session is where they decide whether
 * this game is worth coming back to, and an ad landing before they understand
 * the loop reads as "this is an ad-farm" rather than as the price of a free
 * game. Two runs is roughly the point at which a player who is going to stay
 * has already decided to — and the cost of the shield is a handful of
 * impressions from the cohort least likely to have produced any.
 *
 * `stats.totalRuns` has ALREADY been incremented for the run being debriefed
 * (recordRun runs inside completeRun, before showResults), so this compares
 * with `>` : the third run is the first that can carry one.
 */
const AD_FREE_RUNS = 2;

/**
 * Whether an ad is on screen right now.
 *
 * Read by the frame loop, which stops stepping the simulation entirely while it
 * is set. The debrief is not a running state, so in practice nothing would
 * move anyway — but "the clock is stopped while somebody else's video is
 * playing" is a property worth holding unconditionally rather than one
 * inherited from wherever the ad happened to be requested.
 */
let adPaused = false;

/**
 * Freeze or thaw the game around an ad.
 *
 * Both halves of every pair are driven from here so there is no path — no
 * fill, an error, a listener that threw — that can unfreeze one and not the
 * others. The UI block is a class on the container rather than a disabled state
 * per button: the ad can arrive over any screen, and hunting down every
 * clickable thing on it is how a game ends up with one live button behind a
 * video.
 *
 * @param {boolean} on
 */
function setAdPresenting(on) {
  adPaused = on;
  document.body.classList.toggle('ad-presenting', on);
  // The accumulator is dropped rather than kept: holding thirty seconds of
  // unstepped time would make the loop try to catch all of it up in one frame
  // the moment the ad ends.
  if (!on) {
    accumulator = 0;
    lastTime = performance.now();
  }
}

/**
 * Leave the debrief for the hangar, with a midgame ad if one is due.
 *
 * The menu is shown on EVERY path, including a request that errors, one the SDK
 * refuses for its own cooldown, and one during Basic Launch where ads are
 * switched off entirely. A button that sometimes does not navigate because an
 * ad server did not answer is a soft-lock, and the portal tests for exactly
 * that.
 *
 * @returns {Promise<void>}
 */
async function returnToHangar() {
  if (metaState.stats.totalRuns <= AD_FREE_RUNS) {
    metaUi.showMenu();
    return;
  }

  await crazyGames.requestMidgameAd({
    // Before the network is touched: the request runs several auctions and can
    // take seconds, and the player must not be able to click through to the
    // hangar and back in the middle of one.
    adRequested: () => setAdPresenting(true),
    // Only once the ad's own audio actually starts, which is what the platform
    // asks for — a request that never fills never silences the game.
    adStarted: () => audio.setAdMute(true),
    adFinished: () => {
      audio.setAdMute(false);
      setAdPresenting(false);
    },
    adError: () => {
      audio.setAdMute(false);
      setAdPresenting(false);
    },
  });

  // After the await, unconditionally. Nothing above rejects, so there is no
  // path where the player is left on a debrief screen whose button did
  // nothing.
  metaUi.showMenu();
}

/**
 * The crate reveal, layered over the debrief.
 *
 * The only thing it can change is the 2x — the base payout was banked when the
 * run ended, so dismissing the modal, closing the tab or failing the ad all
 * leave the player with exactly what the crate rolled.
 */
const crateModal = new CrateModal(uiLayer, {
  getState: () => metaEconomy.getState(),

  // The reveal's two audible beats, announced on the bus so the audio layer
  // hears them the same way it hears everything else — through an event, not
  // through a reference to the mixer held by a modal.
  onPhase: (phase) => {
    globalBus.emit(phase === 'blast' ? 'crate:blast' : 'crate:open');
    // The blast is the moment the chips become visible, so it is the moment a
    // legendary is worth celebrating. Read off the crate rather than tracked
    // separately: `pendingCrate` is what the modal is animating, so the two can
    // never disagree about what was actually in it.
    if (phase === 'blast' && hasLegendaryChip(pendingCrate)) crazyGames.happyTime();
  },

  onDoubleRewards: async (multiplier) => {
    /*
     * The rewarded ad, through the same service and the same freeze/duck pair
     * as the midgame one.
     *
     * The duck is `setAdMute`, NOT `mute()`. They look interchangeable and are
     * not: `mute()` is the player's own toggle, so muting with it and unmuting
     * afterwards would hand sound back to a player who had switched it off
     * themselves, and would talk straight over the portal's own mute setting.
     * `setAdMute` is a channel of its own that the audio manager ORs in, so
     * releasing it restores whatever the player and the platform had asked for
     * without this callback having to know what that was.
     *
     * Every exit releases it. `ok`, no fill, a dismissal, an SDK that throws —
     * the service routes all of them through adFinished or adError, and a
     * player left permanently silent by an ad that broke is unrecoverable
     * without a reload.
     */
    const ad = await crazyGames.requestAd(AD_TYPES.REWARDED, {
      adRequested: () => setAdPresenting(true),
      adStarted: () => audio.setAdMute(true),
      adFinished: () => {
        audio.setAdMute(false);
        setAdPresenting(false);
      },
      adError: () => {
        audio.setAdMute(false);
        setAdPresenting(false);
      },
    });

    // The one rule of this callback: no ad, no payout. The base crate was
    // banked when the run ended and is untouched either way.
    if (!ad.ok) return { ok: false, reason: ad.reason };

    const granted = metaEconomy.applyCrateRewards(pendingCrate, multiplier);
    return { ok: true, ...granted };
  },

  onCollect: () => {
    // The crate stays on the debrief as the record of what the run earned; the
    // button just stops offering a second opening.
    metaUi.renderCrateAward(pendingCrate, true);
  },
});

/**
 * The milestone the portal's confetti is reserved for.
 *
 * `happytime` triggers a site-wide celebration on CrazyGames, and the platform
 * asks for it sparingly — a wave clear happens five times a run and would make
 * the effect meaningless, so only the Hive Cruiser counts.
 */
const CELEBRATED_BOSS = 'hive_cruiser';

/** Whether this run has already spent its celebration. Reset by startRun. */
let bossCelebrated = false;

globalBus.on('boss:destroyed', (data) => {
  if (data?.templateId !== CELEBRATED_BOSS || bossCelebrated) return;
  bossCelebrated = true;
  crazyGames.happyTime();
});

// Small capsule per wave cleared: a toast, never a pause.
globalBus.on('wave:complete', () => {
  const { state: next, reward } = openSmallCapsule(metaState, rewardRng);
  commitMeta(next);
  // The capsule resolves the reward; banking it is this layer's job, because
  // the wallet lives in the other save.
  metaEconomy.addScrap(reward.scrap);
  metaUi.showToast(reward);
});

/**
 * End of run: open the large capsule and show Bloom Complete.
 * @param {Object} data - Payload from game:over / game:victory
 * @param {boolean} won
 */
function finishRun(data, won) {
  // Death, victory or forfeit — all three end gameplay, and all three land
  // here before the debrief is built.
  crazyGames.gameplayStop();

  /*
   * An abandoned run short of the first boss wave gets nothing: no capsule
   * roll, no crate, no Scrap. Checked before touching either economy save, so
   * a forfeited run cannot even open a crate that gets thrown away — it never
   * exists.
   */
  const forfeited = forfeitsRunRewards(data);
  const outcome = forfeited
    ? forfeitRunRewards(metaState, { wave: data.wave })
    : completeRun(metaState, { wave: data.wave }, rewardRng);
  commitMeta(outcome.state);

  if (forfeited) {
    pendingCrate = null;
  } else {
    metaEconomy.addScrap(outcome.reward.scrap);

    // The salvage crate, keyed to how deep the run got. Opened — and therefore
    // BANKED — here rather than when the player presses the button on the
    // debrief, so a run's earnings survive the tab being closed on the results
    // screen. The modal is a reveal of something already owned.
    const crate = metaEconomy.openCrate(getCrateTypeForWave(data.wave));
    pendingCrate = crate.ok ? crate.result : null;
  }

  metaUi.showResults({ ...data, won }, outcome, pendingCrate);
}

globalBus.on('game:over', (data) => finishRun(data, false));
globalBus.on('game:victory', (data) => finishRun(data, true));

const input = new KeyboardInput({
  onConfirm: () => {
    const status = state.currentState;
    if (status === GAME_STATES.IDLE || status === GAME_STATES.GAME_OVER || status === GAME_STATES.VICTORY) {
      startRun();
    }
  },
  // Space and Shift both cast. simulation.triggerActiveSkill refuses outside a
  // running state, so this shares Space with onConfirm without a guard here.
  onSkill: () => simulation.triggerActiveSkill(),
  // Escape and P both land here. The panel is part of pausing now: a run
  // frozen with no UI on screen reads as a crash, not as a pause.
  onPause: () => togglePause(),
  // Number keys pick from the level-up draft without reaching for the mouse.
  onSlot: (index) => {
    if (state.currentState !== GAME_STATES.LEVEL_UP) return;
    const cardId = state.pendingDraft?.[index];
    if (cardId) state.chooseCard(cardId);
  },
});

/* ------------------------------------------------------------------------ */
/* Touch                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The left-thumb stick. Built on every device, armed only on touch ones.
 *
 * Built unconditionally because the predicate is about the device's INPUTS, not
 * its form factor: a touchscreen laptop answers true, a phone with a keyboard
 * case answers true as well, and neither should have to reload to change its
 * mind. The listeners ignore `pointerType: 'mouse'` outright, so a desktop that
 * reports touch support pays for nothing but an empty div.
 */
const touch = new TouchControls(appContainer, canvas);

/*
 * One predicate, two consumers.
 *
 * The class is what hud.css keys its enlarged socket, its safe-area offsets and
 * its hidden `[ SPACE ]` badge off. Deriving that from `(pointer: coarse)` in
 * CSS instead would leave two definitions of "this is a touch session" that can
 * disagree — and the device where they disagree is always one nobody has.
 */
if (isTouchDevice()) document.body.classList.add('touch-mode');

/*
 * The stick is live only while a run is.
 *
 * Without this, a press on the menu's backdrop spawns a joystick over the
 * console, and — worse — a run that ends mid-drag leaves the vector latched at
 * whatever it held when the player died, so the next run starts already
 * thrusting. `setEnabled(false)` releases, so both fall out of the same call.
 */
globalBus.on('state:change', ({ to }) => {
  touch.setEnabled(to === GAME_STATES.RUNNING);
});

/**
 * Keyboard and touch, summed.
 *
 * Summed rather than switched on a mode flag: a tablet with a keyboard case has
 * both, and a player who uses both at once should get the obvious result rather
 * than whichever branch the flag happened to pick. Neither source produces a
 * vector longer than 1 on its own, and the simulation clamps the total, so the
 * sum cannot outrun the speed cap.
 *
 * @returns {{x: number, y: number}}
 */
function readDirection() {
  const keys = input.getDirection();
  if (!touch.isActive) return keys;
  const stick = touch.getDirection();
  return { x: keys.x + stick.x, y: keys.y + stick.y };
}

function startRun() {
  metaUi.hide();
  pauseModal.close();
  // First time this fires is the boundary the portal measures our initial
  // download against, so it must mean "playable", not "menu is up" — which is
  // exactly what launching a run means here.
  crazyGames.gameplayStart();
  bossCelebrated = false;
  // Purchased upgrades are folded into the Dewling's starting stats here, and
  // the equipped skill arrives with its chip levels already applied — a level-3
  // Afterburner reaches the handler as a def whose duration and speed are
  // already multiplied, so nothing in the simulation reads the economy save.
  simulation.startRun(metaState, {
    activeSkillDef: metaEconomy.getSkillDef(metaState.activeSkillId),
  });
}

/**
 * Keys that scroll the page they are pressed on.
 *
 * The game is an iframe on somebody else's page, and Space or an arrow key that
 * reaches the browser's default handler scrolls THAT page — the player presses
 * a movement key and the game slides off screen. The input module already
 * cancels the keys it binds, but it only sees the ones it has a mapping for,
 * and its listener does not run at all while focus sits on a modal button.
 */
const SCROLL_KEYS = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
]);

/**
 * Cancel the scroll, keep the keyboard usable.
 *
 * Only cancelled when the key lands on the game itself — the body, the canvas,
 * the UI container — and never when it lands on a control. Tab is the reason
 * for the distinction: it scrolls when there is nowhere to go, but it is also
 * the only way to reach the pause panel's three buttons without a mouse, and a
 * blanket preventDefault would trade a scroll bug for an accessibility one.
 *
 * Nothing here touches Ctrl/Cmd combinations. `Ctrl+W` closes the tab and
 * intercepting it is both futile outside fullscreen and, per the platform
 * guidelines, not ours to take.
 */
window.addEventListener(
  'keydown',
  (event) => {
    if (!SCROLL_KEYS.has(event.code)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const target = event.target;
    const interactive = target?.closest?.(
      'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]'
    );
    if (interactive) return;

    event.preventDefault();
  },
  // Not passive: the whole point is to be able to cancel the default.
  { passive: false }
);

/*
 * Losing focus mid-swarm shouldn't cost the player HP.
 *
 * This opens the panel rather than pausing silently. A player who alt-tabs and
 * comes back to a motionless arena with no explanation reads it as a hang —
 * and then clicks the canvas trying to fix it, which does nothing, because the
 * only way out was a key they were never told about.
 *
 * `openPause` reports the gameplay stop to the portal, which is correct here
 * and would not be if this were the ONLY thing blur did: the platform detects
 * an iframe losing focus on its own and asks games not to report it. This stop
 * is paired with a real pause the player has to click out of, not with the
 * focus event.
 */
window.addEventListener('blur', () => openPause());

/*
 * A hidden tab gets silence AND its CPU back. Suspending the context stops the
 * score's scheduler at the source, which matters on a portal where a player
 * routinely leaves the game open in a background tab for an hour.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend();
  else audio.resume();
});

// Dev-only inspection handle — used for manual verification and profiling.
if (import.meta.env.DEV) {
  window.__bloomwake = {
    simulation,
    state,
    renderer,
    hud,
    input,
    touch,
    metaUi,
    crateModal,
    metaEconomy,
    audio,
    settings,
    settingsModal,
    pauseModal,
    getMeta: () => metaState,
    setMeta: (next) => commitMeta(next),
  };
}

let accumulator = 0;
let lastTime = performance.now();

function frame(now) {
  const frameTime = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME);
  lastTime = now;
  accumulator += frameTime;

  const direction = readDirection();
  // dt = 0 for the duration of an ad. The renderer still runs, so the arena
  // behind the video is a still frame rather than a black one.
  if (!adPaused) {
    while (accumulator >= FIXED_DT) {
      simulation.update(FIXED_DT, direction);
      accumulator -= FIXED_DT;
    }
  }

  hud.update(frameTime);
  renderer.render(frameTime);
  requestAnimationFrame(frame);
}

/**
 * Preload every texture, then build the renderer and start the loop.
 *
 * The game deliberately does not render a frame until the manifest resolves.
 * Missing files do not block boot: they are recorded and replaced with
 * generated placeholders, so an empty /assets folder still yields a playable
 * game and dropping the real PNGs in changes nothing but the pixels.
 */
const ASSET_MANIFEST_SIZE = ASSET_MANIFEST.length;

async function boot() {
  const status = document.getElementById('boot-status');
  const setStatus = (text) => {
    if (status) status.textContent = text;
  };

  /*
   * The SDK comes up first, on the loading screen, which is where v3 wants it:
   * `init()` must be awaited before ANY other `SDK.game`/`SDK.ad` call, or the
   * real portal SDK throws `sdkNotInitialized` — it does not buffer calls made
   * before its own init promise resolves, whatever a stale comment near here
   * used to claim. The data init() preloads (the platform settings, among them
   * the mute) also has to be in hand before the score starts. It never throws
   * on our side — a portal that is down leaves the service on its mock — so
   * there is no catch here and no branch below.
   */
  setStatus('Linking uplink…');
  await crazyGames.init();

  // Only NOW is a `SDK.game` call safe. This is deliberately the first thing
  // to run once init() resolves, so the loading window it reports starts as
  // close to the true beginning of the load as the SDK contract allows.
  crazyGames.loadingStart();

  /*
   * Storage second, state third, and the order is not negotiable.
   *
   * `storageService.init()` picks a driver — the player's CrazyGames cloud
   * save, this browser, or memory — and that choice depends on the handshake
   * that just finished above. It also runs the one-time local -> cloud
   * migration, so a returning player's existing progress is in the cloud
   * before anything reads from it.
   *
   * Only then is it safe to hydrate. Reading a save before the driver is
   * resolved would come back empty from the memory driver, and the first
   * autosave after that would write the emptiness over the real thing.
   */
  setStatus('Syncing save data…');
  await storageService.init();
  hydrateFromStorage();

  setStatus('Loading assets…');
  const result = await assets.load(createPixiLoader(), {
    onProgress: (loaded, total) => setStatus(`Loading assets… ${loaded}/${total}`),
  });

  if (result.missing.length > 0) {
    const filled = installPlaceholders(assets);
    console.warn(
      `[BloomWake] ${filled.length} asset(s) missing, using placeholders:`,
      filled.join(', ')
    );
    setStatus(`Running with ${filled.length} placeholder asset(s)`);
  }

  // Real art can violate the Phase 6 luminance contract in ways a palette test
  // cannot see, so measure the loaded pixels once art is present.
  if (import.meta.env.DEV && result.missing.length < ASSET_MANIFEST_SIZE) {
    reportAssetContrast(assets);
  }

  renderer = await Renderer.create(canvas, simulation, {
    // Read live so equipping a variant in the shop takes effect immediately.
    getCosmetic: () => getEquippedCosmetic(metaState),
  });

  // The renderer did not exist when the stored settings were first applied, so
  // the display half of them lands here. Without this, a player who turned the
  // shake off last session would get one full-intensity run before it took.
  renderer.applySettings(settings.getAll());

  if (import.meta.env.DEV) window.__bloomwake.renderer = renderer;

  document.getElementById('boot-screen')?.remove();
  metaUi.showMenu();

  /*
   * Loading is over: the textures are resident, the renderer exists and the
   * audio graph was built at module scope. Reported here rather than after the
   * first frame because this is the point at which the player can act — the
   * menu is up and its buttons work.
   *
   * Note this is NOT gameplayStart. That fires when a run launches, and the gap
   * between the two is the menu, which the portal explicitly does not want
   * counted as part of the initial download.
   */
  crazyGames.loadingStop();

  lastTime = performance.now();
  requestAnimationFrame(frame);
}

boot();
