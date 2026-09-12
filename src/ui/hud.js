/**
 * DOM HUD + run-flow overlays.
 *
 * Reads simulation state through the event bus and a per-frame sync; never
 * mutates gameplay state directly (start/restart go through the callbacks).
 *
 * The level-up draft is the one screen with real art behind it: Kenney sci-fi
 * plates from public/assets/ui/, 9-sliced in hud.css. Everything else is CSS,
 * because a HUD element that stretches is cheaper and sharper drawn than
 * scaled.
 */

import './hud.css';
import { GAME_STATES } from '../core/game-state.js';
import { PHASE1 } from '../core/constants.js';
import { describeOffer } from '../core/draft.js';
import { UI_ASSETS } from '../core/assets.js';
import { getCardById } from '../data/cards.js';

/**
 * Turkish labels for the rarity keys.
 *
 * The keys themselves stay English in src/data/cards.js because they are
 * identifiers — CSS class suffixes and draft-pool lookups. Translation is a
 * presentation concern, so it lives here, at the only place rarity is rendered.
 */
const RARITY_LABEL = {
  Common: 'Yaygın',
  Uncommon: 'Sıra Dışı',
  Rare: 'Nadir',
  Legendary: 'Efsanevi',
};

/**
 * Rarity badge plates, per the theme brief: blue / green / yellow / red.
 * Sourced from UI_ASSETS so the manifest stays the one place art paths live.
 */
const RARITY_BADGE = {
  Common: UI_ASSETS.BADGE_COMMON,
  Uncommon: UI_ASSETS.BADGE_UNCOMMON,
  Rare: UI_ASSETS.BADGE_RARE,
  Legendary: UI_ASSETS.BADGE_LEGENDARY,
};

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
          <div class="hud__stat"><span class="hud__stat-label">Dalga</span><span class="hud__stat-value" data-hud="wave">1/${PHASE1.MAX_WAVES}</span></div>
          <div class="hud__stat"><span class="hud__stat-label" data-hud="timeLabel">Süre</span><span class="hud__stat-value" data-hud="time">45</span></div>
          <div class="hud__stat"><span class="hud__stat-label">Seviye</span><span class="hud__stat-value" data-hud="level">1</span></div>
          <div class="hud__stat"><span class="hud__stat-label">Kill</span><span class="hud__stat-value" data-hud="kills">0</span></div>
          <div class="hud__stat"><span class="hud__stat-label">Skor</span><span class="hud__stat-value" data-hud="score">0</span></div>
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

        <!-- Fixed Top-Screen Boss Health Bar -->
        <div class="hud__boss" data-hud="boss-container">
          <div class="hud__boss-header">
            <span class="hud__boss-title" data-hud="boss-title">DREADNOUGHT STATION</span>
            <span class="hud__boss-phase" data-hud="boss-phase">AŞAMA 1</span>
          </div>
          <div class="hud__boss-track">
            <div class="hud__boss-ghost" data-hud="boss-ghost"></div>
            <div class="hud__boss-fill" data-hud="boss-fill"></div>
            <div class="hud__boss-text" data-hud="boss-text"></div>
          </div>
        </div>

        <div class="hud__banner" data-hud="banner"></div>
        <!--
          The clear-out prompt. A persistent state readout, NOT a banner: it
          stays up for as long as the condition holds, because it is telling the
          player what they have to DO to advance, and a message that times out
          leaves them wondering why the wave has not ended.
        -->
        <div class="hud__objective" data-hud="objective">
          <span class="hud__objective-text">SWARM CLEARED TO ADVANCE</span>
          <span class="hud__objective-count" data-hud="objective-count"></span>
        </div>
        <div class="hud__cards" data-hud="owned"></div>
        <div class="hud__phase">Void Drifter // Chitin Swarm</div>

        <div class="hud__draft" data-hud="draft">
          <div class="hud__draft-title" data-hud="draft-title">Seviye atlandı</div>
          <div class="hud__draft-options" data-hud="draft-options"></div>
        </div>
      </div>
    `;

    // Full-screen states (menu, shop, Bloom Complete) belong to MetaUi as of
    // Phase 5; the HUD now only owns in-run chrome.
    this.el = {};
    for (const node of this.root.querySelectorAll('[data-hud]')) {
      this.el[node.dataset.hud] = node;
    }
  }

  bindEvents() {
    const bus = this.sim.bus;

    bus.on('wave:start', (data) => {
      if (data.wave > 1) this.showBanner(`Dalga ${data.wave}`);
    });

    bus.on('boss:spawned', (data) => {
      const wave = data?.wave || this.sim.state.wave;
      const tier = Math.floor(wave / 5);
      const title =
        wave >= 15
          ? '⚠️ SON PATRON: Dreadnought Station (Kademe 3)'
          : `⚠️ PATRON ${tier}: Dreadnought Station Beliriyor!`;
      this.showBanner(title, 3.5);
    });

    bus.on('boss:phase', (data) => {
      // Phase 1 is the opening state, not a transition — announcing it would
      // fire a banner on the same frame as the spawn banner.
      if (data.phase > 1) {
        this.showBanner(`⚠️ AŞAMA ${data.phase}`, 2.0);
      }
    });

    bus.on('boss:ray_telegraph', () => this.showBanner('⚠️ ÖLÜM IŞINI', 1.4));

    bus.on('wave:spawn_closed', () =>
      this.showBanner('Sürü akını durdu — sahayı temizle', 2.2)
    );

    bus.on('wave:complete', (data) => {
      if (!data.isFinalWave) this.showBanner(`Dalga ${data.wave} temizlendi`);
    });

    bus.on('player:level_up', (data) => this.showBanner(`Seviye ${data.level}`));
    // game:over / game:victory are handled by MetaUi's Bloom Complete screen.

    bus.on('draft:offer', (data) => this.showDraft(data));
    bus.on('draft:choice', () => this.hideDraft());
    bus.on('card:selected', () => this.renderOwnedCards());
    bus.on('state:reset', () => {
      this.hideDraft();
      this.renderOwnedCards();
    });
  }

  /**
   * Level pips along the card's bottom edge.
   *
   * Shows where this pick would LAND, not where the card is now: the filled
   * count is `nextLevel`, because the player is choosing a future, and a card
   * that shows its current level makes an upgrade look like a sidegrade.
   *
   * @param {number} filled - Levels the card would have after this pick
   * @param {number} max
   * @returns {string} HTML
   */
  renderLevelPips(filled, max) {
    let html = '';
    for (let i = 1; i <= max; i++) {
      html += `<i class="hud__pip${i <= filled ? ' hud__pip--on' : ''}"></i>`;
    }
    return html;
  }

  /**
   * Render the level-up card draft.
   * @param {{cards: Array<string>, level: number}} data
   */
  showDraft(data) {
    const offers = data.cards.map((id) => describeOffer(id, this.sim.state.activeCards));

    this.el['draft-title'].textContent = `Seviye ${data.level} — sistem yükseltmesi seç`;
    this.el['draft-options'].innerHTML = offers
      .map((offer, index) => {
        // maxLevel is not part of the draft's presentation payload, and adding
        // it would mean editing src/core/. The data table is right here.
        const maxLevel = getCardById(offer.id)?.maxLevel ?? 5;
        const rarity = offer.rarity.toLowerCase();

        return `
        <button class="hud__card hud__card--${rarity}" data-card="${offer.id}" type="button">
          <span class="hud__card-badge" style="background-image:url('/${RARITY_BADGE[offer.rarity]}')" aria-hidden="true"></span>
          <span class="hud__card-key">${index + 1}</span>
          <span class="hud__card-name">${offer.name}</span>
          <span class="hud__card-meta">${RARITY_LABEL[offer.rarity] ?? offer.rarity} · ${offer.type}</span>
          <span class="hud__card-level">${
            offer.isNew ? 'YENİ' : `Sv ${offer.currentLevel} → ${offer.nextLevel}`
          }</span>
          <span class="hud__card-desc">${offer.description}</span>
          <span class="hud__card-pips" aria-label="Seviye ${offer.nextLevel} / ${maxLevel}">
            ${this.renderLevelPips(offer.nextLevel, maxLevel)}
          </span>
        </button>`;
      })
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

  /**
   * Per-frame HUD sync.
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    const state = this.sim.state;
    const player = state.player;

    this.el.wave.textContent = `${state.wave}/${PHASE1.MAX_WAVES}`;
    this.el.level.textContent = player.level;
    this.el.kills.textContent = state.kills;
    this.el.score.textContent = state.score;

    /*
     * The wave clock is the SPAWN clock. Once it runs out the number stops
     * being meaningful — the wave lasts as long as it takes to clear — so the
     * readout switches to the live enemy count, which is the number that is
     * now actually counting down to the end of the wave.
     */
    const clearing = state.spawnWindowClosed && state.currentState === GAME_STATES.RUNNING;
    const alive = this.sim.enemies.length;
    this.el.time.textContent = clearing
      ? alive
      : Math.ceil(Math.max(0, state.waveTimeRemaining));
    this.el.timeLabel.textContent = clearing ? 'Kalan' : 'Süre';

    this.el.objective.classList.toggle('hud__objective--visible', clearing);
    if (clearing) this.el['objective-count'].textContent = alive > 0 ? `${alive}` : '';

    const hpRatio = Math.max(0, player.hp / player.maxHp) * 100;
    this.el['hp-fill'].style.width = `${hpRatio}%`;
    // shieldCharge is 0..1 readiness now, not an HP pool: the barrier either
    // eats the next hit or it does not.
    const shieldReady = this.sim.cards.getShieldState()?.ready;
    this.el['hp-text'].textContent =
      `${Math.ceil(player.hp)} / ${player.maxHp}` + (shieldReady ? ' ⬡' : '');

    const xpRatio = Math.min(1, player.xp / player.xpToNextLevel) * 100;
    this.el['xp-fill'].style.width = `${xpRatio}%`;

    // Fixed Top-Screen Boss Health Bar sync
    const boss = this.sim.enemies.find((e) => e.alive && e.isBoss);
    if (boss && boss.maxHp > 0) {
      const bossHpRatio = Math.max(0, (boss.hp / boss.maxHp) * 100);
      this.el['boss-container']?.classList.add('hud__boss--visible');
      if (this.el['boss-title']) {
        const tier = Math.floor(state.wave / 5);
        this.el['boss-title'].textContent =
          state.wave >= 15 ? 'DREADNOUGHT STATION // SON KADEME' : `DREADNOUGHT STATION // KADEME ${tier}`;
      }
      if (this.el['boss-phase']) {
        this.el['boss-phase'].textContent = `AŞAMA ${boss.phase}`;
      }
      if (this.el['boss-fill']) {
        this.el['boss-fill'].style.width = `${bossHpRatio}%`;
      }
      if (this.bossGhostRatio === undefined || this.bossGhostRatio < bossHpRatio) {
        this.bossGhostRatio = bossHpRatio;
      } else {
        // Lag bar erodes smoothly toward actual HP
        this.bossGhostRatio += (bossHpRatio - this.bossGhostRatio) * Math.min(1, dt * 2.8);
      }
      if (this.el['boss-ghost']) {
        this.el['boss-ghost'].style.width = `${this.bossGhostRatio}%`;
      }
      if (this.el['boss-text']) {
        this.el['boss-text'].textContent = `${Math.ceil(boss.hp)} / ${boss.maxHp}`;
      }
    } else {
      this.el['boss-container']?.classList.remove('hud__boss--visible');
      this.bossGhostRatio = 100;
    }

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.el.banner.classList.remove('hud__banner--visible');
      }
    }

    if (state.currentState === GAME_STATES.PAUSED) {
      this.showBanner('Duraklatıldı', 0.2);
    }
  }
}
