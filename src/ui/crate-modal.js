/**
 * Salvage crate opening modal.
 *
 * ---------------------------------------------------------------------------
 * THE CRATE IS ALREADY BANKED BEFORE THIS OPENS
 * ---------------------------------------------------------------------------
 * `openCrate` writes its payout to the save the moment the run ends, so every
 * animation in here is a REVEAL of something the player already owns, not a
 * transaction waiting on them to finish watching. That is what makes the skip
 * safe, what makes closing the tab mid-reveal harmless, and what makes the
 * "Collect" button a dismissal rather than a commit. The only thing that
 * actually changes state on this screen is the 2x ad.
 *
 * ---------------------------------------------------------------------------
 * VIEW LAYER, LIKE THE REST OF src/ui
 * ---------------------------------------------------------------------------
 * It renders a crate result and calls handlers. It never touches the economy
 * state: the doubling goes out through `onDoubleRewards`, comes back as
 * `{ok, scrap, chips}`, and the cards re-render from that. Which crate was
 * earned, what it paid and what the ad multiplied are all decided in
 * src/core/meta-economy.js.
 *
 * ---------------------------------------------------------------------------
 * SKIPPING IS A FIRST-CLASS PATH
 * ---------------------------------------------------------------------------
 * A player on their fortieth run has seen the hydraulics. The whole sequence —
 * lid, stagger, cards — collapses on a second click anywhere, and the skip is
 * reachable from the first frame rather than after some minimum showing. A
 * reveal animation that cannot be skipped is a tax on exactly the players who
 * play most.
 */

import './crate-modal.css';
import { PITY_CRATE_THRESHOLD, SKILL_CHIPS, getUpgradeCost } from '../data/crates-config.js';
import { ACTIVE_SKILLS } from '../data/active-skills.js';

/**
 * The opening is three phases, and the timings are the whole feel of it.
 *
 * CHARGE: the seals resist. Long enough to register as pressure building and
 * short enough that it never reads as lag — past about 400ms a player starts
 * wondering whether their click landed.
 * BLAST: instantaneous, by definition. The shockwave and sparks are what give
 * it duration on screen; the pod itself simply IS open on the next frame.
 * EJECT: cards thrown out of the blast, 120ms apart — fast enough to feel like
 * one burst rather than a queue, slow enough to read each card as it lands.
 */
const CHARGE_MS = 300;
const STAGGER_MS = 120;
/** Radial sparks thrown by the blast. */
const SPARK_COUNT = 10;

/** Player-facing rarity names; the keys stay the save-data ids. */
const RARITY_LABEL = {
  common: 'Common',
  rare: 'Rare',
  legendary: 'Legendary',
};

/**
 * The stencil above each crate on the debrief and in the modal header.
 * Keyed by crate id, which is a save/dispatch key and stays English.
 */
export const CRATE_STENCIL = {
  standard_pod: 'STANDARD CARGO POD RECOVERED',
  military_pod: 'MILITARY SUPPLY CRATE RECOVERED',
  prototype_crate: 'PROTOTYPE R&D CASE RECOVERED',
};

export class CrateModal {
  /**
   * @param {HTMLElement} root - Container element
   * @param {Object} handlers
   * @param {(multiplier: number) => Promise<Object>} handlers.onDoubleRewards -
   *   Runs the ad and banks the bonus. Resolves {ok, scrap, chips}.
   * @param {(state: Object) => void} [handlers.onCollect] - Modal dismissed
   * @param {() => Object} [handlers.getState] - Economy state, for chip totals
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;

    /** The crate result being revealed, or null when closed. */
    this.result = null;
    /** 'sealed' | 'opening' | 'revealed' — gates what a click does. */
    this.phase = 'sealed';
    /** Pending stagger timers, so a skip can cancel them. */
    this.timers = [];
    /** Multiplier already applied. 2 once the ad has paid out. */
    this.multiplier = 1;

    this.build();
    this.bind();
  }

  build() {
    this.layer = document.createElement('div');
    this.layer.className = 'crate';
    this.layer.setAttribute('role', 'dialog');
    this.layer.setAttribute('aria-modal', 'true');
    this.layer.setAttribute('aria-label', 'Salvage crate');
    this.layer.innerHTML = `
      <div class="crate__scrim" data-crate="scrim"></div>

      <div class="console console--crate" data-crate="console">
        <div class="console__tab console__tab--amber" data-crate="stencil"></div>
        <div class="console__body crate__body">

          <!--
            The pod: riveted steel under pressure. The lid is a separate element
            from the hull because it has to come OFF — it is thrown back and up
            by the blast, which a single sliced image could never do.
          -->
          <div class="crate__chamber">
          <div class="crate__pod" data-crate="pod" role="button" tabindex="0"
               aria-label="Open the crate">
            <div class="crate__glow"></div>

            <!-- Pressure venting through the seams while the seals hold. -->
            <span class="crate__vent crate__vent--l" aria-hidden="true"></span>
            <span class="crate__vent crate__vent--r" aria-hidden="true"></span>

            <!-- The blast: one expanding ring, plus radial debris. -->
            <span class="crate__shockwave" data-crate="shockwave" aria-hidden="true"></span>
            <span class="crate__sparks" data-crate="sparks" aria-hidden="true"></span>

            <div class="crate__lid">
              <span class="crate__latch crate__latch--tl"></span>
              <span class="crate__latch crate__latch--tr"></span>
              <span class="crate__seam"></span>
              <span class="crate__stripe"></span>
            </div>
            <div class="crate__hull">
              <span class="crate__latch crate__latch--bl"></span>
              <span class="crate__latch crate__latch--br"></span>
              <span class="crate__hazard"></span>
            </div>
            <p class="crate__prompt" data-crate="prompt">Tap to blow the seals</p>
          </div>
          </div>

          <!-- Reward cards, dealt on a stagger. -->
          <div class="crate__cards" data-crate="cards"></div>

          <div class="crate__actions" data-crate="actions">
            <button class="meta__btn crate__btn--double" data-crate="double">
              <span class="crate__btn-spark" aria-hidden="true"></span>
              <span data-crate="double-label">Watch Ad // Double Rewards</span>
            </button>
            <button class="meta__btn meta__btn--primary" data-crate="collect">Collect Rewards</button>
          </div>

          <p class="crate__pity" data-crate="pity"></p>
        </div>
      </div>
    `;

    this.root.appendChild(this.layer);

    this.el = {};
    for (const node of this.layer.querySelectorAll('[data-crate]')) {
      this.el[node.dataset.crate] = node;
    }
  }

  bind() {
    /*
     * ONE click handler, on the whole layer.
     *
     * "Tap again to skip" has to mean anywhere, and the obvious targets are the
     * pod, the scrim AND the console plate the pod is sitting on — a player
     * being told to tap again does not aim. Binding the pod and the scrim
     * separately left the plate between them dead, which is the one spot an
     * impatient player is most likely to hit.
     *
     * The buttons bubble through here too, and that is harmless: they only
     * exist once `phase` is 'revealed', where advance() is a no-op.
     */
    this.layer.addEventListener('click', () => this.advance());

    this.el.pod.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.advance();
      }
    });

    this.el.collect.addEventListener('click', () => this.close());
    this.el.double.addEventListener('click', () => this.requestDouble());
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Show a crate, sealed.
   *
   * @param {Object} result - The `result` from openCrate()
   * @param {Object} [options]
   * @param {boolean} [options.canDouble] - Offer the rewarded-ad button
   */
  open(result, { canDouble = true } = {}) {
    this.clearTimers();
    this.result = result;
    this.phase = 'sealed';
    this.multiplier = 1;

    this.el.stencil.textContent = `[ ${CRATE_STENCIL[result.crateId] ?? 'SALVAGE RECOVERED'} ]`;
    this.el.prompt.textContent = 'Tap to blow the seals';

    // Every phase class from the last opening, cleared: the modal is reused
    // across runs, and a leftover --blown would show the next crate already
    // open before the player touched it.
    this.layer.classList.remove('crate--instant');
    this.el.pod.classList.remove('crate__pod--charging', 'crate__pod--blown');
    this.el.shockwave.classList.remove('crate__shockwave--fire');
    this.el.sparks.classList.remove('crate__sparks--fire');
    this.el.sparks.innerHTML = '';
    this.el.console.classList.remove('crate__console--thud');
    this.el.cards.innerHTML = '';
    this.el.cards.classList.remove('crate__cards--dealt');
    this.el.actions.classList.remove('crate__actions--visible');

    this.el.double.hidden = !canDouble;
    this.el.double.disabled = false;
    this.el.double.classList.remove('crate__btn--spent', 'crate__btn--pending');
    this.el['double-label'].textContent = 'Watch Ad // Double Rewards';

    this.el.pity.textContent = pityLine(result);

    this.layer.classList.add('crate--active');
    this.el.pod.focus({ preventScroll: true });
  }

  /** Dismiss the modal and hand control back to the debrief. */
  close() {
    this.clearTimers();
    this.layer.classList.remove('crate--active');
    this.phase = 'sealed';
    this.handlers.onCollect?.(this.result);
  }

  /** @returns {boolean} Whether the modal is on screen. */
  get isOpen() {
    return this.layer.classList.contains('crate--active');
  }

  /**
   * One click, three meanings — which is why every pointer path routes here
   * rather than binding its own behaviour:
   *   sealed   -> break the seals and start dealing
   *   opening  -> skip: every card lands at once
   *   revealed -> nothing; the buttons take over
   */
  advance() {
    if (this.phase === 'sealed') this.breakSeals();
    else if (this.phase === 'opening') this.revealAll();
  }

  /* ------------------------------------------------------------------ */
  /* The reveal                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * PHASE 1 — charge-up. The seals resist: the pod rattles in place and
   * pressure vents out through the rivet gaps.
   *
   * The cards are rendered here, at the start, rather than at the blast. They
   * sit invisible until their eject class lands, and building them up front is
   * what lets the skip add one class per card instead of racing the timers it
   * is trying to cancel.
   */
  breakSeals() {
    this.phase = 'opening';
    this.el.pod.classList.add('crate__pod--charging');
    this.el.prompt.textContent = 'Tap again to skip';

    this.renderCards();
    this.spawnSparks();

    this.timers.push(setTimeout(() => this.detonate(), CHARGE_MS));
  }

  /**
   * PHASE 2 — decompression blast, and PHASE 3 behind it.
   *
   * Everything here fires on the same frame on purpose: the ring, the sparks,
   * the lid leaving, the whole console taking a hit. A blast whose parts arrive
   * even 50ms apart reads as a sequence of effects rather than one impact.
   */
  detonate() {
    this.el.pod.classList.remove('crate__pod--charging');
    this.el.pod.classList.add('crate__pod--blown');
    this.el.shockwave.classList.add('crate__shockwave--fire');
    this.el.sparks.classList.add('crate__sparks--fire');
    this.el.console.classList.add('crate__console--thud');

    const cards = [...this.el.cards.children];
    cards.forEach((card, index) => {
      this.timers.push(
        setTimeout(() => card.classList.add('crate__card--in'), index * STAGGER_MS)
      );
    });

    this.timers.push(
      setTimeout(() => this.finishReveal(), cards.length * STAGGER_MS + 260)
    );
  }

  /**
   * Collapse the whole sequence for a player who has seen it.
   *
   * `crate--instant` is what makes this honest: it kills every keyframe on the
   * pod, the debris and the cards and pins them to their end state, so a skip
   * lands on exactly the frame the full sequence would have finished on rather
   * than leaving a half-played rattle running underneath the reward cards.
   */
  revealAll() {
    this.clearTimers();
    this.layer.classList.add('crate--instant');

    this.el.pod.classList.remove('crate__pod--charging');
    this.el.pod.classList.add('crate__pod--blown');
    this.el.shockwave.classList.remove('crate__shockwave--fire');
    this.el.sparks.classList.remove('crate__sparks--fire');
    this.el.console.classList.remove('crate__console--thud');

    for (const card of this.el.cards.children) card.classList.add('crate__card--in');
    this.finishReveal();
  }

  /**
   * Build the radial debris the blast throws.
   *
   * Each spark carries its own angle and travel distance as CSS custom
   * properties, so one keyframe animation serves all ten and the scatter is
   * data rather than ten hand-written rules. The angles are evenly spaced and
   * then jittered — a perfectly regular starburst reads as a graphic, not as
   * debris.
   */
  spawnSparks() {
    if (this.el.sparks.childElementCount > 0) return;

    let html = '';
    for (let i = 0; i < SPARK_COUNT; i++) {
      const spread = 360 / SPARK_COUNT;
      const angle = i * spread + (Math.random() - 0.5) * spread * 0.6;
      const distance = 70 + Math.random() * 55;
      const delay = Math.random() * 40;
      html +=
        `<i style="--spark-angle:${angle.toFixed(1)}deg;` +
        `--spark-dist:${distance.toFixed(0)}px;` +
        `--spark-delay:${delay.toFixed(0)}ms"></i>`;
    }
    this.el.sparks.innerHTML = html;
  }

  finishReveal() {
    this.phase = 'revealed';
    this.el.prompt.textContent = '';
    this.el.cards.classList.add('crate__cards--dealt');
    this.el.actions.classList.add('crate__actions--visible');
    // Focus the safe action, not the ad: a player mashing Enter to get back to
    // the menu should collect, never accidentally start a video.
    this.el.collect.focus({ preventScroll: true });
  }

  /**
   * Build one scrap card plus one card per chip.
   *
   * Every card carries its own `data-base` amount so a later doubling can
   * rewrite the number from the source figure rather than from whatever is
   * currently on screen — reading the DOM back as state is how a second
   * doubling would quietly become a quadrupling.
   */
  renderCards() {
    const state = this.handlers.getState?.() ?? null;
    const scrapCard = `
      <article class="crate__card crate__card--scrap">
        <span class="crate__card-icon crate__card-icon--cell" aria-hidden="true">
          <i></i><i></i><i></i>
        </span>
        <b class="crate__card-amount" data-base="${this.result.scrap}"
           data-crate-amount="scrap">+${this.result.scrap}</b>
        <span class="crate__card-label">Scrap</span>
      </article>`;

    const chipCards = this.result.chips
      .map((chip, index) => {
        const def = SKILL_CHIPS[chip.chipId];
        const skill = ACTIVE_SKILLS[chip.skillId];
        const progress = chipProgress(state, chip.key);

        return `
      <article class="crate__card crate__card--chip crate__card--${chip.rarity}"
               data-chip-index="${index}">
        <span class="crate__card-icon crate__card-icon--badge" aria-hidden="true">${skill?.mark ?? '◆'}</span>
        <span class="crate__rarity">${RARITY_LABEL[chip.rarity] ?? chip.rarity}</span>
        <b class="crate__card-amount" data-base="1" data-crate-amount="chip">+1</b>
        <span class="crate__card-label">${def?.name ?? chip.key}</span>
        ${
          chip.forcedBy
            ? `<span class="crate__forced">${
                chip.forcedBy === 'pity' ? 'Dry-streak guarantee' : 'Crate guarantee'
              }</span>`
            : ''
        }
        ${
          progress
            ? `<span class="crate__progress">[ CHIP: ${progress.owned} / ${progress.needed} ]</span>`
            : ''
        }
      </article>`;
      })
      .join('');

    this.el.cards.innerHTML = scrapCard + chipCards;
  }

  /* ------------------------------------------------------------------ */
  /* Rewarded ad                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Watch an ad to double the crate.
   *
   * The button is disabled for the whole request and never re-enabled on
   * success, so a double-click or a second thought cannot bank the bonus twice.
   * On every failure path it comes back enabled with its original label: the
   * player watched nothing, was charged nothing, and can try again.
   */
  async requestDouble() {
    if (this.multiplier > 1 || this.el.double.disabled) return;

    this.el.double.disabled = true;
    this.el.double.classList.add('crate__btn--pending');
    this.el['double-label'].textContent = 'Loading ad…';

    let outcome = { ok: false };
    try {
      outcome = (await this.handlers.onDoubleRewards?.(2)) ?? { ok: false };
    } catch (error) {
      // requestRewardedAd does not reject, but a handler above it might. The
      // base reward is already banked, so the safe response is to let the
      // player collect it.
      console.warn('[BloomWake] Reward doubling failed.', error);
    }

    this.el.double.classList.remove('crate__btn--pending');

    if (!outcome.ok) {
      this.el.double.disabled = false;
      this.el['double-label'].textContent = 'Watch Ad // Double Rewards';
      return;
    }

    this.multiplier = 2;
    this.el.double.classList.add('crate__btn--spent');
    this.el['double-label'].textContent = 'Doubled!';
    this.applyMultiplierToCards(2);
  }

  /**
   * Rewrite every card's figure from its recorded base and punch it.
   * @param {number} multiplier
   */
  applyMultiplierToCards(multiplier) {
    const state = this.handlers.getState?.() ?? null;

    for (const node of this.el.cards.querySelectorAll('[data-base]')) {
      const base = Number(node.dataset.base) || 0;
      node.textContent = `+${base * multiplier}`;
      node.classList.remove('crate__card-amount--pop');
      // Reflow between removing and adding restarts the keyframe; without it a
      // second application would be silent.
      void node.offsetWidth;
      node.classList.add('crate__card-amount--pop');
    }

    // The chip totals moved too, so the progress badges are now stale.
    for (const node of this.el.cards.querySelectorAll('[data-chip-index]')) {
      const chip = this.result.chips[Number(node.dataset.chipIndex)];
      const badge = node.querySelector('.crate__progress');
      const progress = chipProgress(state, chip?.key);
      if (badge && progress) {
        badge.textContent = `[ CHIP: ${progress.owned} / ${progress.needed} ]`;
      }
    }
  }

  /* ------------------------------------------------------------------ */

  clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
  }
}

/**
 * Chips held versus chips needed for this skill's next level.
 *
 * Returns null at max level — a "4 / 4" badge under a skill that cannot be
 * upgraded any further reads as progress toward something that does not exist.
 *
 * @param {Object|null} state - Economy state
 * @param {string} key - Chip save key
 * @returns {{owned: number, needed: number}|null}
 */
function chipProgress(state, key) {
  if (!state || !key) return null;
  const level = state.skillLevels?.[key] ?? 1;
  const cost = getUpgradeCost(level);
  if (!cost) return null;
  return { owned: state.chips?.[key] ?? 0, needed: cost.chips };
}

/**
 * The line under the cards explaining the guarantee clock — the same
 * transparency rule the capsule odds table follows: the player is told how
 * close the floor is rather than left to infer it.
 *
 * @param {Object} result
 * @returns {string}
 */
function pityLine(result) {
  if (result.pityApplied) return 'Dry-streak guarantee applied — counter reset.';
  const left = Math.max(0, PITY_CRATE_THRESHOLD - result.pityCounter);
  if (left === 0) return 'Next crate guarantees a Rare or better.';
  return `${left} crate${left === 1 ? '' : 's'} until a Rare is guaranteed.`;
}
