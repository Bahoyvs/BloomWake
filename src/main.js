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
import { openSmallCapsule, completeRun } from './core/meta-progression.js';
import { KeyboardInput } from './input/input.js';
import { Renderer } from './render/renderer.js';
import { assets, ASSET_MANIFEST } from './core/assets.js';
import { createPixiLoader, installPlaceholders } from './render/pixi-loader.js';
import { reportAssetContrast } from './render/asset-audit.js';
import { Hud } from './ui/hud.js';
import { MetaUi } from './ui/meta-ui.js';
import { loadSave, saveState } from './ui/storage.js';

/** Fixed simulation step keeps physics and damage timing frame-rate independent. */
const FIXED_DT = 1 / 60;
/** Cap on catch-up time after a stall (tab switch, breakpoint). */
const MAX_FRAME_TIME = 0.25;

const state = new GameState(globalBus, { maxWaves: PHASE1.MAX_WAVES });
const simulation = new Simulation({
  bus: globalBus,
  state,
  seed: Math.floor(Math.random() * 0xffffffff),
});

const canvas = document.getElementById('game-canvas');
const uiLayer = document.getElementById('ui-layer');
/**
 * Renderer is created after preload, so it is assigned during boot() rather
 * than at module scope.
 * @type {Renderer}
 */
let renderer;

const hud = new Hud(uiLayer, simulation, {
  onChooseCard: (cardId) => state.chooseCard(cardId),
});

/* ------------------------------------------------------------------------ */
/* Meta-progression (Phase 5)                                                */
/* ------------------------------------------------------------------------ */

/** Persistent across runs; every core action returns a new one. */
let metaState = loadSave();

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
  onBuyUpgrade: (id) => {
    const result = purchaseUpgrade(metaState, id);
    if (result.ok) commitMeta(result.state);
    metaUi.renderShop();
  },
  onBuyCosmetic: (id) => {
    const result = purchaseCosmetic(metaState, id);
    if (result.ok) commitMeta(result.state);
    metaUi.renderShop();
  },
  onEquipCosmetic: (id) => {
    const result = equipCosmetic(metaState, id);
    if (result.ok) commitMeta(result.state);
    metaUi.renderShop();
  },
  onClaimDaily: () => {
    const result = claimDailyBloom(metaState, Date.now(), rewardRng);
    if (result.ok) {
      commitMeta(result.state);
      metaUi.showToast({ ...result.reward, tier: result.reward.tier });
    }
    metaUi.renderMenu();
  },
});

// Small capsule per wave cleared: a toast, never a pause.
globalBus.on('wave:complete', () => {
  const { state: next, reward } = openSmallCapsule(metaState, rewardRng);
  commitMeta(next);
  metaUi.showToast(reward);
});

/**
 * End of run: open the large capsule and show Bloom Complete.
 * @param {Object} data - Payload from game:over / game:victory
 * @param {boolean} won
 */
function finishRun(data, won) {
  const outcome = completeRun(metaState, { wave: data.wave }, rewardRng);
  commitMeta(outcome.state);
  metaUi.showResults({ ...data, won }, outcome);
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
  onPause: () => {
    if (state.currentState === GAME_STATES.RUNNING) state.pause();
    else if (state.currentState === GAME_STATES.PAUSED) state.resume();
  },
  // Number keys pick from the level-up draft without reaching for the mouse.
  onSlot: (index) => {
    if (state.currentState !== GAME_STATES.LEVEL_UP) return;
    const cardId = state.pendingDraft?.[index];
    if (cardId) state.chooseCard(cardId);
  },
});

function startRun() {
  metaUi.hide();
  // Purchased upgrades are folded into the Dewling's starting stats here.
  simulation.startRun(metaState);
}

// Losing focus mid-swarm shouldn't cost the player HP.
window.addEventListener('blur', () => {
  if (state.currentState === GAME_STATES.RUNNING) state.pause();
});

// Dev-only inspection handle — used for manual verification and profiling.
if (import.meta.env.DEV) {
  window.__bloomwake = {
    simulation,
    state,
    renderer,
    hud,
    input,
    metaUi,
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

  const direction = input.getDirection();
  while (accumulator >= FIXED_DT) {
    simulation.update(FIXED_DT, direction);
    accumulator -= FIXED_DT;
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

  if (import.meta.env.DEV) window.__bloomwake.renderer = renderer;

  document.getElementById('boot-screen')?.remove();
  metaUi.showMenu();

  lastTime = performance.now();
  requestAnimationFrame(frame);
}

boot();
