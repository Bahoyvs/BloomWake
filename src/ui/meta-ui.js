/**
 * Meta-progression UI (Phase 5 Step F): main menu, Petal Shop, Bloom Complete
 * results screen, small-capsule toast, Daily Bloom indicator.
 *
 * Strictly a view layer, same separation as Phases 1-4: it renders whatever the
 * core action functions return and never mutates meta-state itself. Every
 * purchase goes out through a handler, comes back as {ok, reason, state}, and
 * the screen re-renders from that.
 */

import './meta-ui.css';
import { describeShop } from '../core/meta-shop.js';
import { describeCosmetics } from '../core/cosmetics.js';
import { isDailyBloomAvailable, msUntilNextLocalDay } from '../core/daily-bloom.js';
import { REWARD_TIERS } from '../data/rewards.js';

/** Tier label styling hooks. */
const TIER_LABEL = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  legendary: 'Legendary',
};

export class MetaUi {
  /**
   * @param {HTMLElement} root - Container element
   * @param {Object} handlers
   * @param {() => Object} handlers.getState - Current meta-state
   * @param {() => void} handlers.onPlay
   * @param {(id: string) => void} handlers.onBuyUpgrade
   * @param {(id: string) => void} handlers.onBuyCosmetic
   * @param {(id: string) => void} handlers.onEquipCosmetic
   * @param {() => void} handlers.onClaimDaily
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    this.toastTimer = null;

    this.build();
    this.bind();
  }

  build() {
    this.layer = document.createElement('div');
    this.layer.className = 'meta';
    this.layer.innerHTML = `
      <!-- Main menu -->
      <section class="meta__screen meta__screen--menu" data-meta="menu">
        <h1 class="meta__title">BloomWake</h1>
        <p class="meta__tagline">Aeria: Last Bloom</p>

        <div class="meta__wallet"><b data-meta="menu-petals">0</b> Petal</div>

        <div class="meta__menu-actions">
          <button class="meta__btn meta__btn--primary" data-meta="play">Begin Run</button>
          <button class="meta__btn" data-meta="open-shop">Petal Shop</button>
          <button class="meta__btn meta__btn--daily" data-meta="daily"></button>
        </div>

        <p class="meta__stats" data-meta="menu-stats"></p>
      </section>

      <!-- Petal shop -->
      <section class="meta__screen" data-meta="shop">
        <header class="meta__header">
          <h2 class="meta__heading">Petal Shop</h2>
          <div class="meta__wallet"><b data-meta="shop-petals">0</b> Petal</div>
        </header>

        <h3 class="meta__section-label">Meta Upgrades</h3>
        <div class="meta__grid" data-meta="upgrades"></div>

        <h3 class="meta__section-label">Dewling Variants</h3>
        <div class="meta__grid" data-meta="cosmetics"></div>

        <button class="meta__btn meta__back" data-meta="close-shop">Back</button>
      </section>

      <!-- Bloom Complete -->
      <section class="meta__screen meta__screen--results" data-meta="results">
        <h2 class="meta__heading" data-meta="results-title">Bloom Complete</h2>

        <div class="meta__summary" data-meta="results-summary"></div>

        <div class="meta__capsule" data-meta="capsule">
          <div class="meta__bud" data-meta="bud"></div>
          <div class="meta__capsule-reveal" data-meta="capsule-reveal">
            <span class="meta__tier" data-meta="capsule-tier"></span>
            <span class="meta__petals" data-meta="capsule-petals"></span>
            <span class="meta__drop" data-meta="capsule-drop"></span>
          </div>
        </div>

        <button class="meta__odds-btn" data-meta="odds-toggle" title="Show drop rates">?</button>
        <div class="meta__odds" data-meta="odds"></div>

        <div class="meta__results-actions">
          <button class="meta__btn meta__btn--primary" data-meta="again">Run Again</button>
          <button class="meta__btn" data-meta="to-menu">Menu</button>
        </div>
      </section>

      <!-- Non-blocking wave capsule toast -->
      <div class="meta__toast" data-meta="toast"></div>
    `;

    this.root.appendChild(this.layer);

    this.el = {};
    for (const node of this.layer.querySelectorAll('[data-meta]')) {
      this.el[node.dataset.meta] = node;
    }
  }

  bind() {
    this.el.play.addEventListener('click', () => this.handlers.onPlay?.());
    this.el.again.addEventListener('click', () => this.handlers.onPlay?.());
    this.el['open-shop'].addEventListener('click', () => this.showShop());
    this.el['close-shop'].addEventListener('click', () => this.showMenu());
    this.el['to-menu'].addEventListener('click', () => this.showMenu());
    this.el.daily.addEventListener('click', () => this.handlers.onClaimDaily?.());
    this.el['odds-toggle'].addEventListener('click', () => {
      this.el.odds.classList.toggle('meta__odds--visible');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Screens                                                             */
  /* ------------------------------------------------------------------ */

  /** @param {string|null} name - 'menu' | 'shop' | 'results' | null to hide all */
  showScreen(name) {
    for (const key of ['menu', 'shop', 'results']) {
      this.el[key].classList.toggle('meta__screen--visible', key === name);
    }
    this.layer.classList.toggle('meta--active', Boolean(name));
  }

  showMenu() {
    this.renderMenu();
    this.showScreen('menu');
  }

  showShop() {
    this.renderShop();
    this.showScreen('shop');
  }

  /** Hide all meta screens so the run is visible. */
  hide() {
    this.showScreen(null);
  }

  /* ------------------------------------------------------------------ */
  /* Main menu                                                           */
  /* ------------------------------------------------------------------ */

  renderMenu(nowMs = Date.now()) {
    const state = this.handlers.getState();

    this.el['menu-petals'].textContent = state.petals;
    const runs = state.stats.totalRuns;
    this.el['menu-stats'].textContent = runs
      ? `${runs} ${runs === 1 ? 'run' : 'runs'} · best wave ${state.stats.bestWaveReached}`
      : 'No runs yet.';

    const available = isDailyBloomAvailable(state.dailyBloom.lastClaimedAt, nowMs);
    this.el.daily.disabled = !available;
    this.el.daily.classList.toggle('meta__btn--ready', available);
    this.el.daily.textContent = available
      ? 'Daily Bloom · Ready'
      : `Daily Bloom · ${formatCountdown(msUntilNextLocalDay(nowMs))}`;
  }

  /* ------------------------------------------------------------------ */
  /* Shop                                                                */
  /* ------------------------------------------------------------------ */

  renderShop() {
    const state = this.handlers.getState();
    this.el['shop-petals'].textContent = state.petals;

    this.el.upgrades.innerHTML = describeShop(state)
      .map(
        (row) => `
        <article class="meta__card${row.maxed ? ' meta__card--maxed' : ''}">
          <h4 class="meta__card-name">${row.name}</h4>
          <p class="meta__card-desc">${row.description}</p>
          <div class="meta__card-level">${
            row.maxLevel > 1 ? `Level ${row.level} / ${row.maxLevel}` : row.level ? 'Unlocked' : 'Locked'
          }</div>
          <button class="meta__btn meta__btn--buy" data-upgrade="${row.id}"
            ${row.maxed || !row.affordable ? 'disabled' : ''}>
            ${row.maxed ? 'Maxed' : `${row.cost} Petal`}
          </button>
        </article>`
      )
      .join('');

    this.el.cosmetics.innerHTML = describeCosmetics(state)
      .map(
        (row) => `
        <article class="meta__card${row.equipped ? ' meta__card--equipped' : ''}">
          <h4 class="meta__card-name">${row.name}</h4>
          <p class="meta__card-desc">${row.description}</p>
          <div class="meta__card-level">${
            row.locked ? 'Legendary capsule only' : row.owned ? 'Owned' : `${row.cost} Petal`
          }</div>
          ${
            row.owned
              ? `<button class="meta__btn meta__btn--buy" data-equip="${row.id}" ${
                  row.equipped ? 'disabled' : ''
                }>${row.equipped ? 'Equipped' : 'Equip'}</button>`
              : `<button class="meta__btn meta__btn--buy" data-cosmetic="${row.id}" ${
                  row.affordable ? '' : 'disabled'
                }>${row.locked ? 'Locked' : 'Buy'}</button>`
          }
        </article>`
      )
      .join('');

    for (const button of this.el.upgrades.querySelectorAll('[data-upgrade]')) {
      button.addEventListener('click', () => this.handlers.onBuyUpgrade?.(button.dataset.upgrade));
    }
    for (const button of this.el.cosmetics.querySelectorAll('[data-cosmetic]')) {
      button.addEventListener('click', () => this.handlers.onBuyCosmetic?.(button.dataset.cosmetic));
    }
    for (const button of this.el.cosmetics.querySelectorAll('[data-equip]')) {
      button.addEventListener('click', () => this.handlers.onEquipCosmetic?.(button.dataset.equip));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Results                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Show the Bloom Complete screen with the run's large capsule.
   *
   * @param {Object} result - Run outcome {wave, score, kills, won}
   * @param {Object} capsule - From completeRun(): {reward, newCosmetics, pityApplied, odds}
   */
  showResults(result, capsule) {
    this.el['results-title'].textContent = result.won ? 'Bloom Complete' : 'The Stain Wins';

    this.el['results-summary'].innerHTML = [
      ['Wave', result.wave],
      ['Score', result.score],
      ['Kills', result.kills],
    ]
      .map(
        ([label, value]) =>
          `<div class="meta__summary-item"><b>${value}</b><span>${label}</span></div>`
      )
      .join('');

    const { reward, newCosmetics, pityApplied, odds } = capsule;

    this.el['capsule-tier'].textContent = TIER_LABEL[reward.tier] ?? reward.tier;
    this.el['capsule-tier'].className = `meta__tier meta__tier--${reward.tier}`;
    this.el['capsule-petals'].textContent = `+${reward.petals} Petal`;
    this.el['capsule-drop'].textContent = newCosmetics.length
      ? `New variant unlocked: ${newCosmetics.join(', ')}`
      : pityApplied
        ? 'Pity guarantee applied'
        : '';

    this.el.odds.innerHTML = renderOdds(odds);
    this.el.odds.classList.remove('meta__odds--visible');

    // Restart the bloom animation from the closed bud each time.
    this.el.capsule.classList.remove('meta__capsule--open');
    void this.el.capsule.offsetWidth;
    this.el.capsule.classList.add('meta__capsule--open');

    this.showScreen('results');
  }

  /* ------------------------------------------------------------------ */
  /* Wave toast                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Brief end-of-wave capsule notice. Non-blocking by design: it never pauses
   * the simulation and never takes pointer events, so the next wave can start
   * underneath it.
   *
   * @param {Object} reward - From openSmallCapsule()
   */
  showToast(reward) {
    this.el.toast.innerHTML =
      `<span class="meta__toast-tier meta__toast-tier--${reward.tier}">` +
      `${TIER_LABEL[reward.tier] ?? reward.tier}</span> Bloom Capsule · +${reward.petals} Petal`;
    this.el.toast.classList.add('meta__toast--visible');

    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.el.toast.classList.remove('meta__toast--visible');
    }, 2200);
  }
}

/**
 * Render the exact weight table for a band — the transparency principle from
 * GDD Section 8: no hidden rates, ever.
 * @param {{minWave: number, maxWave: number, weights: Object}} odds
 * @returns {string}
 */
function renderOdds(odds) {
  const range = odds.maxWave >= 999 ? `${odds.minWave}+` : `${odds.minWave}-${odds.maxWave}`;
  const rows = REWARD_TIERS.map(
    (tier) =>
      `<tr><td>${TIER_LABEL[tier]}</td><td>${(odds.weights[tier] * 100).toFixed(0)}%</td></tr>`
  ).join('');

  return `
    <p class="meta__odds-title">Drop rates · waves ${range}</p>
    <table class="meta__odds-table">${rows}</table>
  `;
}

/**
 * @param {number} ms
 * @returns {string} e.g. "7h 12m"
 */
function formatCountdown(ms) {
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
