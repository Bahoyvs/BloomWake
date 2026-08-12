import { GameState } from './core/game-state.js';
import { globalBus } from './core/event-bus.js';
import { ENEMIES } from './data/enemies.js';
import { CARDS } from './data/cards.js';

console.log('🌸 BloomWake — Phase 0 Initialized');
console.log('Registered enemies:', Object.keys(ENEMIES));
console.log('Registered cards:', CARDS.map((c) => c.name));

const gameState = new GameState(globalBus);

// Setup event logging for dev verification
globalBus.on('state:change', (event) => {
  console.log(`[State] Transitioned: ${event.from} -> ${event.to}`);
});

globalBus.on('wave:start', (data) => {
  console.log(`[Wave ${data.wave}] Started. Enemy Cap: ${data.maxEnemies}, HP Mult: ${data.hpMultiplier.toFixed(2)}x`);
});

// Mount visual placeholder on canvas
const canvas = document.getElementById('game-canvas');
if (canvas) {
  const ctx = canvas.getContext('2d');
  
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawPlaceholder();
  }

  function drawPlaceholder() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Frutiger Aero Gradient
    const gradient = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, 50,
      canvas.width / 2, canvas.height / 2, canvas.width / 1.2
    );
    gradient.addColorStop(0, '#0f3443');
    gradient.addColorStop(1, '#08121e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title & Status
    ctx.font = 'bold 36px Outfit, sans-serif';
    ctx.fillStyle = '#70e0d6';
    ctx.textAlign = 'center';
    ctx.fillText('BLOOMWAKE', canvas.width / 2, canvas.height / 2 - 40);

    ctx.font = '18px Outfit, sans-serif';
    ctx.fillStyle = '#a8e6cf';
    ctx.fillText('Aeria: Last Bloom — Phase 0 Core Skeleton Active', canvas.width / 2, canvas.height / 2 + 10);

    ctx.font = '14px Outfit, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText('Pure Node simulation ready • Vitest test suites active', canvas.width / 2, canvas.height / 2 + 45);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
}
