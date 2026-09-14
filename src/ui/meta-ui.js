/**
 * Meta-progression UI: main menu, Salvage Depot, mission-debrief results
 * screen, wave-clear toast, daily-shipment indicator.
 *
 * ALL COPY IS ENGLISH.
 * The reward tiers, the currency and the upgrade ids keep their original
 * English keys in src/data/ and src/core/ — they are save-game and dispatch
 * keys — and the words a player reads happen to be English too, on both this
 * screen and the in-run HUD (src/data/cards.js). Kept as its own module
 * rather than folded into the data tables anyway: a reward tier or an
 * upgrade id is a save-game key first, and tying its shape to what a menu
 * displays would make the data table awkward to touch for anyone who isn't
 * currently editing copy.
 *
 * Strictly a view layer, same separation as Phases 1-4: it renders whatever the
 * core action functions return and never mutates meta-state itself. Every
 * purchase goes out through a handler, comes back as {ok, reason, state}, and
 * the screen re-renders from that.
 *
 * EVERY SCREEN IS A CONSOLE.
 * The three meta screens share one chassis component — `.console`, a riveted
 * Kenney sci-fi plate with a coloured title tab — rather than floating their
 * contents on the void. The tab colour is the screen's job: blue for systems,
 * red for the depot, amber for economy. Markup for that chassis is built here
 * and its art lives in meta-ui.css, so adding a screen is a matter of picking
 * a tab colour, not of restating a panel.
 */

import './meta-ui.css';
import { describeShop } from '../core/meta-shop.js';
import { describeCosmetics } from '../core/cosmetics.js';
import { describeActiveSkills } from '../core/active-skills.js';
import { isDailyBloomAvailable, msUntilNextLocalDay } from '../core/daily-bloom.js';
import { REWARD_TIERS } from '../data/rewards.js';
import { describeSkillProgress, resolveSkillDefAtLevel } from '../core/meta-economy.js';
import { MAX_SKILL_LEVEL } from '../data/crates-config.js';
import { CRATE_STENCIL } from './crate-modal.js';
import { ABANDON_REWARD_THRESHOLD_WAVE } from '../core/meta-progression.js';

/**
 * Player-facing tier names. The keys stay the English identifiers the reward
 * tables and CSS class suffixes use; only the words change.
 */
const TIER_LABEL = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  legendary: 'Legendary',
};

/**
 * The stencilled corner tab on each upgrade bay.
 *
 * Keyed by the same English upgrade ids src/data/meta-upgrades.js owns, for the
 * same reason TIER_LABEL is: those ids are save-game keys and stay English,
 * while the words a player reads are decided here. Anything unmapped falls back
 * to a bay number, so a new upgrade renders a plausible tab rather than blank.
 */
const BAY_LABEL = {
  startHp: 'HULL',
  pickupRadius: 'PULL',
  startSpeed: 'THRUST',
  fourthCardSlot: 'SLOT',
};

/**
 * The scrap wallet as a recessed console badge: an amber energy cell beside the
 * count, in place of a line of text.
 *
 * @param {string} slot - data-meta key the count element answers to
 * @returns {string}
 */
function scrapBadge(slot) {
  const cells = '<i></i>'.repeat(5);
  return `
    <div class="scrap">
      <span class="scrap__cell" aria-hidden="true">${cells}</span>
      <b class="scrap__count" data-meta="${slot}">0</b>
      <span class="scrap__unit">Scrap</span>
    </div>`;
}

/**
 * Level as a segmented cell meter rather than a "3 / 5" string.
 *
 * The numbers still reach a screen reader through the label, because the
 * segments carry no text of their own — `role="img"` collapses the strip of
 * <i>s into that one description.
 *
 * @param {number} level
 * @param {number} maxLevel
 * @param {string} label - what the meter reads as, e.g. "Level 3 of 5"
 * @returns {string}
 */
function meter(level, maxLevel, label) {
  const segments = Array.from(
    { length: maxLevel },
    (_, i) => `<i class="meter__seg${i < level ? ' meter__seg--on' : ''}"></i>`
  ).join('');
  return `<div class="meter" role="img" aria-label="${label}">${segments}</div>`;
}

/**
 * The Level Up key on a skill bay.
 *
 * States, in the order they are checked:
 *  - maxed: inert, and says so rather than disappearing — a player looking for
 *    the button they pressed last time should find it, finished.
 *  - affordable: live, and prices itself in Scrap, which is the half of the
 *    cost the player can act on immediately.
 *  - short: inert, and names WHICH resource is missing and by how much. A grey
 *    button with no reason attached is the single most common way an upgrade
 *    screen wastes a player's time.
 *
 * @param {Object} row - A row from describeSkillProgress()
 * @returns {string}
 */
function upgradeButton(row) {
  if (row.isMax) {
    return `<button class="meta__btn meta__btn--buy meta__btn--level" disabled>Max Level</button>`;
  }

  if (row.canAfford) {
    return `<button class="meta__btn meta__btn--buy meta__btn--level meta__btn--ready"
      data-upgrade-chip="${row.key}">Level Up · ${row.cost.scrap} Scrap</button>`;
  }

  const missing =
    row.missingChips > 0
      ? `Need ${row.missingChips} more chip${row.missingChips === 1 ? '' : 's'}`
      : `Need ${row.missingScrap} more Scrap`;

  return `<button class="meta__btn meta__btn--buy meta__btn--level" disabled>${missing}</button>`;
}

export class MetaUi {
  /**
   * @param {HTMLElement} root - Container element
   * @param {Object} handlers
   * @param {() => Object} handlers.getState - Current meta-state (what is owned)
   * @param {() => Object} handlers.getEconomy - Crate economy state, which holds
   *   the game's single Scrap balance and the chip inventory
   * @param {() => void} handlers.onPlay
   * @param {() => void} [handlers.onOpenSettings] - Settings pressed in the menu
   * @param {(id: string) => void} handlers.onBuyUpgrade
   * @param {(id: string) => void} handlers.onBuyCosmetic
   * @param {(id: string) => void} handlers.onEquipCosmetic
   * @param {(id: string) => void} handlers.onEquipSkill
   * @param {() => void} handlers.onClaimDaily
   * @param {() => void} [handlers.onReturnToHangar] - Leaving the DEBRIEF for
   *   the main menu. Separate from the shop's Back button, which also lands on
   *   the menu, because this one is the end of a run — the natural break the
   *   midgame interstitial is placed at. Optional: with no handler the screen
   *   simply navigates, which is what keeps this component usable without the
   *   portal wired up.
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
        <div class="console console--menu">
          <div class="console__tab console__tab--blue">TERMINAL // SECTOR CONTROL</div>
          <div class="console__body">
            <h1 class="meta__title">BloomWake</h1>
            <p class="meta__tagline">Void Drifter // Chitin Swarm</p>

            ${scrapBadge('menu-scrap')}

            <div class="meta__menu-actions">
              <button class="meta__btn meta__btn--primary" data-meta="play">Launch Mission</button>
              <button class="meta__btn" data-meta="open-shop">Salvage Depot</button>
              <button class="meta__btn" data-meta="open-settings">Settings</button>
              <button class="meta__btn meta__btn--daily" data-meta="daily"></button>
            </div>

            <p class="meta__stats" data-meta="menu-stats"></p>
          </div>
        </div>
      </section>

      <!-- Salvage depot -->
      <section class="meta__screen meta__screen--shop" data-meta="shop">
        <div class="console console--bay">
          <div class="console__tab console__tab--red">[ REINFORCEMENT BAY // SALVAGE DEPOT ]</div>
          <div class="console__body">
            <header class="meta__header">
              <h2 class="meta__heading">Salvage Depot</h2>
              ${scrapBadge('shop-scrap')}
            </header>

            <h3 class="meta__section-label">Permanent Upgrades</h3>
            <div class="meta__grid" data-meta="upgrades"></div>

            <!--
              No wallet badge of its own any more: hull upgrades, liveries and
              chip levels all spend the single Scrap balance shown in the header
              above, so a second figure here would only invite the reader to
              wonder which one a button is charging.
            -->
            <h3 class="meta__section-label">Tactical Systems</h3>
            <div class="meta__grid" data-meta="skills"></div>

            <h3 class="meta__section-label">Drifter Liveries</h3>
            <div class="meta__grid" data-meta="cosmetics"></div>

            <button class="meta__btn meta__back" data-meta="close-shop">Back</button>
          </div>
        </div>
      </section>

      <!-- Mission debrief -->
      <section class="meta__screen meta__screen--results" data-meta="results">
        <div class="console console--results">
          <div class="console__tab console__tab--amber">[ DEBRIEF // MISSION REPORT ]</div>
          <div class="console__body">
            <h2 class="meta__heading" data-meta="results-title">Mission Complete</h2>

            <!--
              Forfeit notice: an abandoned run that quit before the first boss
              wave. Sits ABOVE the score box on purpose — the player has to see
              why the capsule and the crate below are both about to be missing
              before they go looking for numbers that will not be there.
            -->
            <p class="meta__warning" data-meta="results-warning" hidden></p>

            <div class="meta__summary" data-meta="results-summary"></div>

            <div class="meta__capsule" data-meta="capsule">
              <div class="meta__bud" data-meta="bud"></div>
              <div class="meta__capsule-reveal" data-meta="capsule-reveal">
                <span class="meta__tier" data-meta="capsule-tier"></span>
                <span class="meta__capsule-scrap" data-meta="capsule-scrap"></span>
                <span class="meta__drop" data-meta="capsule-drop"></span>
              </div>
            </div>

            <button class="meta__odds-btn" data-meta="odds-toggle" title="Show drop odds">?</button>
            <div class="meta__odds" data-meta="odds"></div>

            <!--
              Salvage crate earned by the run. A riveted sub-console rather than
              another line in the summary: the crate is the thing the player is
              here for, and it has to out-weigh the score above it.
            -->
            <div class="crate-award" data-meta="crate-award" hidden>
              <span class="crate-award__stencil" data-meta="crate-stencil"></span>
              <div class="crate-award__pod" aria-hidden="true">
                <span class="crate-award__band"></span>
              </div>
              <button class="meta__btn meta__btn--primary crate-award__btn" data-meta="open-crate">
                Open Crate
              </button>
            </div>

            <div class="meta__results-actions">
              <button class="meta__btn meta__btn--primary" data-meta="again">Fly Again</button>
              <button class="meta__btn" data-meta="to-menu">Menu</button>
            </div>
          </div>
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
    /*
     * The run is over, the crate is banked and nothing is half-finished on
     * screen — the one moment in the game where an interstitial interrupts
     * nothing. The handler owns both the ad and the navigation, because the
     * menu has to appear whether or not an ad played and this screen cannot
     * know which happened.
     */
    this.el['to-menu'].addEventListener('click', () => {
      if (this.handlers.onReturnToHangar) this.handlers.onReturnToHangar();
      else this.showMenu();
    });
    this.el.daily.addEventListener('click', () => this.handlers.onClaimDaily?.());
    // The menu's way in. The pause screen has the other one, and a player who
    // wants to turn the shake down before their first run must not have to
    // start a run to reach it.
    this.el['open-settings'].addEventListener('click', () => this.handlers.onOpenSettings?.());
    this.el['open-crate'].addEventListener('click', () => this.handlers.onOpenCrate?.());
    this.el['odds-toggle'].addEventListener('click', () => {
      this.el.odds.classList.toggle('meta__odds--visible');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Screens                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The player's Scrap. THE one balance — hull upgrades, liveries and chip
   * levels all price against this single number, and every badge on every
   * screen reads it from here so two of them can never disagree.
   *
   * @returns {number}
   */
  scrap() {
    return this.handlers.getEconomy?.()?.scrap ?? 0;
  }

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

  /**
   * @returns {boolean} Whether the main menu is the screen currently up.
   *
   * Asked by the re-hydration path: signing in swaps which account's Scrap
   * balance is live, and the menu is the one screen that has that number
   * printed on it.
   */
  isMenuVisible() {
    return this.el.menu.classList.contains('meta__screen--visible');
  }

  /* ------------------------------------------------------------------ */
  /* Main menu                                                           */
  /* ------------------------------------------------------------------ */

  renderMenu(nowMs = Date.now()) {
    const state = this.handlers.getState();

    this.el['menu-scrap'].textContent = this.scrap();
    const runs = state.stats.totalRuns;
    this.el['menu-stats'].textContent = runs
      ? `${runs} runs · best wave ${state.stats.bestWaveReached}`
      : 'No runs yet.';

    const available = isDailyBloomAvailable(state.dailyBloom.lastClaimedAt, nowMs);
    this.el.daily.disabled = !available;
    this.el.daily.classList.toggle('meta__btn--ready', available);
    this.el.daily.textContent = available
      ? 'Daily Shipment · Ready'
      : `Daily Shipment · ${formatCountdown(msUntilNextLocalDay(nowMs))}`;
  }

  /* ------------------------------------------------------------------ */
  /* Shop                                                                */
  /* ------------------------------------------------------------------ */

  renderShop() {
    const state = this.handlers.getState();
    const scrap = this.scrap();
    this.el['shop-scrap'].textContent = scrap;

    this.el.upgrades.innerHTML = describeShop(state, scrap)
      .map(
        (row, index) => `
        <article class="bay${row.maxed ? ' bay--maxed' : ''}">
          <span class="bay__tab">${BAY_LABEL[row.id] ?? `BAY ${String(index + 1).padStart(2, '0')}`}</span>
          <h4 class="bay__name">${row.name}</h4>
          <p class="bay__desc">${row.description}</p>
          ${meter(
            row.level,
            row.maxLevel,
            row.maxLevel > 1
              ? `Level ${row.level} of ${row.maxLevel}`
              : row.level
                ? 'Unlocked'
                : 'Locked'
          )}
          <button class="meta__btn meta__btn--buy" data-upgrade="${row.id}"
            ${row.maxed || !row.affordable ? 'disabled' : ''}>
            ${row.maxed ? 'Maxed' : `${row.cost} Scrap`}
          </button>
        </article>`
      )
      .join('');

    /*
     * Active skills. Two independent decisions share one card, because they are
     * about the same object and splitting them across two screens would make a
     * player check one to understand the other:
     *
     *  - WHICH to fly with. Free, always available — a tactical choice, not a
     *    purchase, so there is no price on the Equip button.
     *  - HOW STRONG it is. Paid for in chips and Scrap, and the numbers shown
     *    (cooldown, active window) are the LEVELLED ones from
     *    resolveSkillDefAtLevel, not the level-1 table. A card that advertised
     *    8s while the player's own upgraded skill runs at 6.56s would make the
     *    upgrade look like it did nothing.
     */
    const economy = this.handlers.getEconomy?.() ?? null;
    const progressBySkill = new Map(
      economy ? describeSkillProgress(economy).map((row) => [row.skillId, row]) : []
    );

    this.el.skills.innerHTML = describeActiveSkills(state)
      .map((row) => {
        const progress = progressBySkill.get(row.id);
        const level = progress?.level ?? 1;
        const def = resolveSkillDefAtLevel(row.id, level) ?? row;

        return `
        <article class="bay bay--livery${row.equipped ? ' bay--equipped' : ''}">
          <span class="bay__tab">${row.mark} SYSTEM</span>
          <h4 class="bay__name">${row.name}</h4>
          <p class="bay__desc">${row.description}</p>
          <div class="bay__status">${def.cooldown}s cooldown${
            def.duration > 0 ? ` · ${def.duration}s active` : ' · instant'
          }</div>
          ${
            progress
              ? `
          ${meter(level, MAX_SKILL_LEVEL, `Level ${level} of ${MAX_SKILL_LEVEL}`)}
          <div class="chip-tube${progress.isMax ? ' chip-tube--max' : ''}">
            <span class="chip-tube__label">Chip</span>
            <b class="chip-tube__count">${
              progress.isMax
                ? `${progress.ownedChips}`
                : `${progress.ownedChips} / ${progress.cost.chips}`
            }</b>
          </div>`
              : ''
          }
          <div class="bay__actions">
            <button class="meta__btn meta__btn--buy" data-skill="${row.id}" ${
              row.equipped ? 'disabled' : ''
            }>${row.equipped ? 'Equipped' : 'Equip'}</button>
            ${progress ? upgradeButton(progress) : ''}
          </div>
        </article>`;
      })
      .join('');

    this.el.cosmetics.innerHTML = describeCosmetics(state, scrap)
      .map(
        (row) => `
        <article class="bay bay--livery${row.equipped ? ' bay--equipped' : ''}${
          row.locked ? ' bay--locked' : ''
        }">
          <span class="bay__tab">LIVERY</span>
          <h4 class="bay__name">${row.name}</h4>
          <p class="bay__desc">${row.description}</p>
          <div class="bay__status">${
            row.locked ? 'Legendary capsule only' : row.owned ? 'Owned' : `${row.cost} Scrap`
          }</div>
          ${
            row.owned
              ? `<button class="meta__btn meta__btn--buy" data-equip="${row.id}" ${
                  row.equipped ? 'disabled' : ''
                }>${row.equipped ? 'Equipped' : 'Equip'}</button>`
              : `<button class="meta__btn meta__btn--buy" data-cosmetic="${row.id}" ${
                  row.affordable ? '' : 'disabled'
                }>${row.locked ? 'Locked' : 'Purchase'}</button>`
          }
        </article>`
      )
      .join('');

    for (const button of this.el.upgrades.querySelectorAll('[data-upgrade]')) {
      button.addEventListener('click', () => this.handlers.onBuyUpgrade?.(button.dataset.upgrade));
    }
    for (const button of this.el.skills.querySelectorAll('[data-skill]')) {
      button.addEventListener('click', () => this.handlers.onEquipSkill?.(button.dataset.skill));
    }
    for (const button of this.el.skills.querySelectorAll('[data-upgrade-chip]')) {
      button.addEventListener('click', () =>
        this.handlers.onUpgradeSkill?.(button.dataset.upgradeChip)
      );
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
   * Show the mission debrief with the run's large salvage capsule.
   *
   * @param {Object} result - Run outcome {wave, score, kills, won}
   * @param {Object} capsule - From completeRun(): {reward, newCosmetics,
   *   pityApplied, odds}, or from forfeitRunRewards() when the run was
   *   abandoned before the reward threshold: {reward: {scrap: 0, ...},
   *   newCosmetics: [], pityApplied: false, odds: null, forfeited: true}
   * @param {Object} [crate] - The salvage crate the run earned, from openCrate().
   *   Omitted leaves the crate console hidden, so a run that somehow failed to
   *   award one shows a debrief without it rather than an empty box. Always
   *   omitted when `capsule.forfeited` is true.
   */
  showResults(result, capsule, crate = null) {
    this.el['results-title'].textContent = result.won ? 'Mission Complete' : 'Hive Wins';

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

    /*
     * A forfeited run (Abandon Run before the first boss wave) never rolled a
     * capsule — forfeitRunRewards() hands back a zeroed reward specifically so
     * this branch never has to guess whether one exists. The capsule display,
     * the odds toggle and the crate console are hidden rather than shown at
     * zero: a "+0 Scrap" capsule still looks like a reward, and the warning
     * banner above the score box is the honest version of that message.
     */
    const forfeited = Boolean(capsule.forfeited);
    this.el['results-warning'].hidden = !forfeited;
    if (forfeited) {
      this.el['results-warning'].textContent =
        `// MISSION ABORTED: INSUFFICIENT PROGRESS (MIN. WAVE ${ABANDON_REWARD_THRESHOLD_WAVE}) // NO SALVAGE RECOVERED`;
    }
    this.el.capsule.hidden = forfeited;
    this.el['odds-toggle'].hidden = forfeited;
    this.el.odds.classList.remove('meta__odds--visible');

    if (!forfeited) {
      const { reward, newCosmetics, pityApplied, odds } = capsule;

      this.el['capsule-tier'].textContent = TIER_LABEL[reward.tier] ?? reward.tier;
      this.el['capsule-tier'].className = `meta__tier meta__tier--${reward.tier}`;
      this.el['capsule-scrap'].textContent = `+${reward.scrap} Scrap`;
      this.el['capsule-drop'].textContent = newCosmetics.length
        ? `New livery unlocked: ${newCosmetics.join(', ')}`
        : pityApplied
          ? 'Pity guarantee applied'
          : '';

      this.el.odds.innerHTML = renderOdds(odds);

      // Restart the capsule-opening animation from closed each time.
      this.el.capsule.classList.remove('meta__capsule--open');
      void this.el.capsule.offsetWidth;
      this.el.capsule.classList.add('meta__capsule--open');
    } else {
      this.el.odds.innerHTML = '';
    }

    // Forfeited implies no crate — finishRun never passes one for a forfeited
    // run — but the guard costs nothing and keeps this method correct even if
    // a future caller gets that ordering wrong.
    this.renderCrateAward(forfeited ? null : crate);

    this.showScreen('results');
  }

  /**
   * The earned-crate console under the scoreboard.
   *
   * @param {Object|null} crate - openCrate() result, or null to hide the box
   * @param {boolean} [opened] - Whether the modal has already been through it
   */
  renderCrateAward(crate, opened = false) {
    this.el['crate-award'].hidden = !crate;
    if (!crate) return;

    this.el['crate-stencil'].textContent = `[ ${
      CRATE_STENCIL[crate.crateId] ?? 'SALVAGE RECOVERED'
    } ]`;
    this.el['crate-award'].dataset.crateType = crate.crateId;

    // A crate stays visible after it has been opened — it is the record of what
    // the run earned — but its button stops inviting a second opening.
    this.el['open-crate'].disabled = opened;
    this.el['open-crate'].textContent = opened ? 'Collected' : 'Open Crate';
  }

  /* ------------------------------------------------------------------ */
  /* Wave toast                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Brief end-of-wave salvage notice. Non-blocking by design: it never pauses
   * the simulation and never takes pointer events, so the next wave can start
   * underneath it.
   *
   * @param {Object} reward - From openSmallCapsule()
   */
  showToast(reward) {
    this.el.toast.innerHTML =
      `<span class="meta__toast-tier meta__toast-tier--${reward.tier}">` +
      `${TIER_LABEL[reward.tier] ?? reward.tier}</span> Salvage Capsule · +${reward.scrap} Scrap`;
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
    <p class="meta__odds-title">Drop odds · wave ${range}</p>
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
