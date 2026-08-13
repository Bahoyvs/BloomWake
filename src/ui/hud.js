/**
 * DOM HUD + run-flow overlays for BloomWake Phase 1.
 * Reads simulation state through the event bus and a per-frame sync; never
 * mutates gameplay state directly (start/restart go through the callbacks).
 */

import './hud.css';
import { GAME_STATES } from '../core/game-state.js';
import { PHASE1 } from '../core/constants.js';
import { describeOffer } from '../core/draft.js';
import { getCardById } from '../data/cards.js';

export class Hud {
  /**
   * @param {HTMLElement} root - Container element (#ui-layer)
   * @param {import('../core/simulation.js').Simulation} simulation
   * @param {Object} handlers
   * @param {() => void} handlers.onStart
   */
  constructor(root, simulation, handlers = {}) {
    this.root = root;
    this.sim = simulation;
    this.handlers = handlers;
    this.bannerTimer = 0;

    this.build();
    this.bindEvents();
  }

  build() {
    this.root.innerHTML = `
      <div class="hud">
        <div class="hud__top">
          <div class="hud__stat"><span class="hud__stat-label">Wave</span><span class="hud__stat-value" data-hud="wave">1/${PHASE1.MAX_WAVES}</span></div>
          <div class="hud__stat"><span class="hud__stat-label">Time</span><span class="hud__stat-value" data-hud="time">35</span></div>
          <div class="hud__stat"><span class="hud__stat-label">Level</span><span class="hud__stat-value" data-hud="level">1</span></div>
          <div class="hud__stat"><span class="hud__stat-label">Kills</span><span class="hud__stat-value" data-hud="kills">0</span></div>
          <div class="hud__stat"><span class="hud__stat-label">Score</span><span class="hud__stat-value" data-hud="score">0</span></div>
        </div>

        <div class="hud__bars">
          <div class="hud__bar hud__bar--hp">
            <div class="hud__bar-fill" data-hud="hp-fill"></div>
            <div class="hud__bar-text" data-hud="hp-text">100 / 100</div>
          </div>
          <div class="hud__bar hud__bar--xp">
            <div class="hud__bar-fill" data-hud="xp-fill"></div>
          </div>
        </div>

        <div class="hud__banner" data-hud="banner"></div>
        <div class="hud__cards" data-hud="owned"></div>
        <div class="hud__phase">Phase 4 — Frutevil Roster & Boss Rustwhale</div>

        <div class="hud__draft" data-hud="draft">
          <div class="hud__draft-title" data-hud="draft-title">Level up</div>
          <div class="hud__draft-options" data-hud="draft-options"></div>
        </div>

        <div class="hud__overlay hud__overlay--visible" data-hud="overlay">
          <div class="hud__title" data-hud="overlay-title">BloomWake</div>
          <div class="hud__subtitle" data-hud="overlay-subtitle">
            Move with WASD or the arrow keys. The Dewling fires on its own —
            survive ${PHASE1.MAX_WAVES} waves and collect the drops to level up.
          </div>
          <div class="hud__summary" data-hud="overlay-summary" hidden></div>
          <button class="hud__hint" data-hud="overlay-action" type="button">Press Enter to bloom</button>
        </div>
      </div>
    `;

    this.el = {};
    for (const node of this.root.querySelectorAll('[data-hud]')) {
      this.el[node.dataset.hud] = node;
    }

    this.el['overlay-action'].addEventListener('click', () => this.handlers.onStart?.());
  }

  bindEvents() {
    const bus = this.sim.bus;

    bus.on('wave:start', (data) => {
      if (data.wave > 1) this.showBanner(`Wave ${data.wave}`);
    });

    bus.on('boss:spawned', () => {
      this.showBanner('⚠️ BOSS: Rustwhale Arrives!', 3.0);
    });

    bus.on('wave:complete', (data) => {
      if (!data.isFinalWave) this.showBanner(`Wave ${data.wave} cleared`);
    });

    bus.on('player:level_up', (data) => this.showBanner(`Level ${data.level}`));
    bus.on('game:over', (data) => this.showEnd('The Stain wins', data, false));
    bus.on('game:victory', (data) => this.showEnd('Bloom Complete', data, true));

    bus.on('draft:offer', (data) => this.showDraft(data));
    bus.on('draft:choice', () => this.hideDraft());
    bus.on('card:selected', () => this.renderOwnedCards());
    bus.on('state:reset', () => {
      this.hideDraft();
      this.renderOwnedCards();
    });
  }

  /**
   * Render the level-up card draft.
   * @param {{cards: Array<string>, level: number}} data
   */
  showDraft(data) {
    const offers = data.cards.map((id) => describeOffer(id, this.sim.state.activeCards));

    this.el['draft-title'].textContent = `Level ${data.level} — choose a bloom`;
    this.el['draft-options'].innerHTML = offers
      .map(
        (offer, index) => `
        <button class="hud__card hud__card--${offer.rarity.toLowerCase()}" data-card="${offer.id}" type="button">
          <span class="hud__card-key">${index + 1}</span>
          <span class="hud__card-name">${offer.name}</span>
          <span class="hud__card-meta">${offer.rarity} · ${offer.type}</span>
          <span class="hud__card-level">${
            offer.isNew ? 'NEW' : `Lv ${offer.currentLevel} → ${offer.nextLevel}`
          }</span>
          <span class="hud__card-desc">${offer.description}</span>
        </button>`
      )
      .join('');

    for (const button of this.el['draft-options'].querySelectorAll('[data-card]')) {
      button.addEventListener('click', () => this.handlers.onChooseCard?.(button.dataset.card));
    }

    this.el.draft.classList.add('hud__draft--visible');
  }

  hideDraft() {
    this.el.draft.classList.remove('hud__draft--visible');
  }

  /** Compact list of owned cards and their levels. */
  renderOwnedCards() {
    const owned = [...this.sim.state.activeCards.entries()];
    this.el.owned.innerHTML = owned
      .map(([id, level]) => `<span class="hud__owned"><b>${getCardById(id).name}</b> ${level}</span>`)
      .join('');
  }

  /**
   * @param {string} text
   * @param {number} [duration] - Seconds visible
   */
  showBanner(text, duration = 1.4) {
    this.el.banner.textContent = text;
    this.el.banner.classList.add('hud__banner--visible');
    this.bannerTimer = duration;
  }

  showEnd(title, data, won) {
    this.el['overlay-title'].textContent = title;
    this.el['overlay-subtitle'].textContent = won
      ? `All ${PHASE1.MAX_WAVES} waves survived. The core loop held.`
      : 'The Dewling faded before the last wave.';

    this.el['overlay-summary'].hidden = false;
    this.el['overlay-summary'].innerHTML = `
      <div class="hud__summary-item">
        <span class="hud__summary-value">${data.wave}</span>
        <span class="hud__summary-label">Wave</span>
      </div>
      <div class="hud__summary-item">
        <span class="hud__summary-value">${data.kills}</span>
        <span class="hud__summary-label">Kills</span>
      </div>
      <div class="hud__summary-item">
        <span class="hud__summary-value">${data.score}</span>
        <span class="hud__summary-label">Score</span>
      </div>
      <div class="hud__summary-item">
        <span class="hud__summary-value">${this.sim.state.player.level}</span>
        <span class="hud__summary-label">Level</span>
      </div>
    `;

    this.el['overlay-action'].textContent = 'Press Enter to run again';
    this.el.overlay.classList.add('hud__overlay--visible');
  }

  hideOverlay() {
    this.el.overlay.classList.remove('hud__overlay--visible');
  }

  /**
   * Per-frame HUD sync.
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    const state = this.sim.state;
    const player = state.player;

    this.el.wave.textContent = `${state.wave}/${PHASE1.MAX_WAVES}`;
    this.el.time.textContent = Math.ceil(Math.max(0, state.waveTimeRemaining));
    this.el.level.textContent = player.level;
    this.el.kills.textContent = state.kills;
    this.el.score.textContent = state.score;

    const hpRatio = Math.max(0, player.hp / player.maxHp) * 100;
    this.el['hp-fill'].style.width = `${hpRatio}%`;
    const shield = this.sim.cards.shieldCharge;
    this.el['hp-text'].textContent =
      `${Math.ceil(player.hp)} / ${player.maxHp}` +
      (shield > 0 ? ` (+${Math.ceil(shield)})` : '');

    const xpRatio = Math.min(1, player.xp / player.xpToNextLevel) * 100;
    this.el['xp-fill'].style.width = `${xpRatio}%`;

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.el.banner.classList.remove('hud__banner--visible');
      }
    }

    if (state.currentState === GAME_STATES.PAUSED) {
      this.showBanner('Paused', 0.2);
    }
  }
}
