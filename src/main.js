/**
 * BloomWake Phase 1 — browser entry point.
 * Wires the pure simulation to input, renderer and HUD, and drives the loop.
 */

import { globalBus } from './core/event-bus.js';
import { GameState, GAME_STATES } from './core/game-state.js';
import { Simulation } from './core/simulation.js';
import { PHASE1 } from './core/constants.js';
import { KeyboardInput } from './input/input.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './ui/hud.js';

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
const renderer = new Renderer(canvas, simulation);

const hud = new Hud(uiLayer, simulation, {
  onStart: () => startRun(),
  onChooseCard: (cardId) => state.chooseCard(cardId),
});

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
  hud.hideOverlay();
  simulation.startRun();
}

// Losing focus mid-swarm shouldn't cost the player HP.
window.addEventListener('blur', () => {
  if (state.currentState === GAME_STATES.RUNNING) state.pause();
});

// Dev-only inspection handle — used for manual verification and Phase 2 profiling.
if (import.meta.env.DEV) {
  window.__bloomwake = { simulation, state, renderer, hud, input };
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
  renderer.render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
