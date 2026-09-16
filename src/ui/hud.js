/**
 * DOM HUD + run-flow overlays.
 *
 * Reads simulation state through the event bus and a per-frame sync; never
 * mutates gameplay state directly (start/restart go through the callbacks).
 *
 * THE HUD IS COCKPIT HARDWARE, NOT TEXT ON GLASS.
 * Every readout lives in a module built from the same Kenney sci-fi plates the
 * meta screens use — telemetry bays across the top, a hull deck at the bottom,
 * a loadout rail down the left, a module socket bottom-right. The plates are
 * darkened to gunmetal in hud.css rather than shipped light, because this layer
 * sits OVER the playfield and a light panel would out-read the Drifter.
 *
 * ALL COPY IN THE GAME IS ENGLISH.
 * Card names, types and descriptions come from src/data/cards.js already in
 * English, so this module never translates anything — the rarity keys ARE the
 * words the player reads.
 */

import './hud.css';
import { GAME_STATES } from '../core/game-state.js';
import { PHASE1 } from '../core/constants.js';
import { describeOffer } from '../core/draft.js';
import { UI_ASSETS } from '../core/assets.js';
import { getCardById, CARD_TYPES } from '../data/cards.js';

/**
 * Rarity badge plates, per the theme brief: blue / green / yellow / red.
 * Sourced from UI_ASSETS so the manifest stays the one place art paths live.
 *
 * These paths are RELATIVE (`assets/ui/...`) and must be used as-is. The draft
 * card used to interpolate them behind a leading slash, which turned them
 * absolute and 404'd every badge the moment the game was served from anything
 * but a domain root — which is exactly what the portal does, and why the build
 * now sets `base: './'`. Nothing in this file may reintroduce that slash.
 */
const RARITY_BADGE = {
  Common: UI_ASSETS.BADGE_COMMON,
  Uncommon: UI_ASSETS.BADGE_UNCOMMON,
  Rare: UI_ASSETS.BADGE_RARE,
  Legendary: UI_ASSETS.BADGE_LEGENDARY,
};

/**
 * Weapon-class badge for a loadout chip: a three-letter bay code and the slug
 * hud.css colours it by.
 *
 * Keyed off CARD_TYPES rather than off raw strings so renaming a label in the
 * data table cannot silently drop every badge to the fallback. The codes are
 * deliberately terse — the full weapon name sits immediately beside them, and
 * what the badge is actually for is letting the eye sort the rail by colour.
 */
const CLASS_BADGE = {
  [CARD_TYPES.PROJECTILE]: { code: 'KIN', slug: 'kinetic' },
  [CARD_TYPES.BEAM]: { code: 'BEM', slug: 'beam' },
  [CARD_TYPES.CHAIN_LIGHTNING]: { code: 'ARC', slug: 'arc' },
  [CARD_TYPES.ORBIT]: { code: 'ORB', slug: 'orbital' },
  [CARD_TYPES.AOE]: { code: 'ARE', slug: 'area' },
  [CARD_TYPES.SHIELD]: { code: 'SHD', slug: 'shield' },
  [CARD_TYPES.PASSIVE]: { code: 'PSV', slug: 'passive' },
  [CARD_TYPES.CONTROL]: { code: 'CTL', slug: 'control' },
};

/**
 * Banner tones. `routine` is the default and carries no modifier class, so the
 * common case — wave numbers, level-ups — costs no extra styling; the other two
 * escalate the plate to hazard amber and to a pulsing red.
 */
const TONE = {
  ROUTINE: 'routine',
  ALERT: 'alert',
  CRITICAL: 'critical',
};

/**
 * The card whose readiness drives the hull deck's shield tube.
 *
 * No longer the socket: the socket belongs to the active skill now, which is
 * equipped before the run rather than drafted during it.
 */
const SOCKET_CARD_ID = 'bloomshield';

/** Hull fraction below which the deck goes to hazard alert. */
const HULL_CRITICAL = 0.25;

/** @param {number} n @returns {string} */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Seconds as a console clock.
 * @param {number} seconds
 * @returns {string} e.g. "00:42"
 */
function formatClock(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${pad2(Math.floor(whole / 60))}:${pad2(whole % 60)}`;
}

export class Hud {
  /**
   * @param {HTMLElement} root - Container element (#ui-layer)
   * @param {import('../core/simulation.js').Simulation} simulation
   * @param {Object} handlers
   * @param {() => void} handlers.onStart
   * @param {() => void} [handlers.onPause] - The HUD's pause key was pressed
   */
  constructor(root, simulation, handlers = {}) {
    this.root = root;
    this.sim = simulation;
    this.handlers = handlers;
    this.bannerTimer = 0;
    /** Last rendered loadout signature, so the rail only rebuilds on a change. */
    this.loadoutKey = '';
    /** Previous frame's skill readiness, for the one-shot ready burst. */
    this.skillWasReady = true;

    this.build();
    this.bindEvents();
  }

  build() {
    this.root.innerHTML = `
      <div class="hud">
        <!--
          Telemetry band. Four separate bays rather than one strip of text: the
          numbers update at completely different rates, and a shared background
          makes a wave counter that changes once a minute look like it belongs
          with a clock that changes every frame.
        -->
        <div class="hud__telemetry">
          <div class="tbay tbay--wave">
            <span class="tbay__label">Wave</span>
            <span class="tbay__readout" data-hud="wave">01/${pad2(PHASE1.MAX_WAVES)}</span>
          </div>

          <div class="tbay tbay--time">
            <span class="tbay__label" data-hud="timeLabel">Time</span>
            <span class="tbay__readout" data-hud="time">00:45</span>
          </div>

          <div class="tbay tbay--level">
            <span class="tbay__label">Level</span>
            <span class="tbay__readout" data-hud="level">1</span>
            <span class="tbay__tube" aria-hidden="true"><i data-hud="xp-fill"></i></span>
          </div>

          <div class="tbay tbay--tally">
            <span class="tally"><span class="tally__label">Score</span><b data-hud="score">0</b></span>
            <span class="tally"><span class="tally__label">Kills</span><b data-hud="kills">0</b></span>
          </div>

          <!--
            The pause key, at the end of the telemetry band.

            In the band rather than floating in a corner because it is console
            hardware like every other readout, and on a phone there IS no
            Escape key — this is the only way into the pause screen and the
            settings behind it, so it cannot be a desktop afterthought.
          -->
          <button class="tbay tbay--pause" data-hud="pause" type="button"
                  aria-label="Pause" title="Pause (Esc)">
            <span class="tbay__pause-glyph" aria-hidden="true"></span>
          </button>
        </div>

        <!-- Left rail: one console chip per owned system. -->
        <div class="hud__loadout" data-hud="loadout"></div>

        <!--
          Hull deck. The shield tube is only in the DOM tree when the barrier is
          owned; an empty gauge reads as a broken system rather than as one the
          player has not bought yet.
        -->
        <div class="hud__hull-deck" data-hud="hull-deck">
          <div class="deck__tab">Hull Integrity</div>
          <div class="deck__body">
            <div class="tube tube--shield" data-hud="shield-tube" hidden>
              <i class="tube__fill" data-hud="shield-fill"></i>
              <span class="tube__text">Ion Shield</span>
            </div>
            <div class="tube tube--hull">
              <i class="tube__fill" data-hud="hp-fill"></i>
              <span class="tube__text" data-hud="hp-text">150 / 150 HP</span>
            </div>
          </div>
        </div>

        <!--
          Active-skill socket, bottom-right.

          A <button>, not a div: on a phone this IS the cast control, and a
          button is the element that already handles touch, focus and keyboard
          activation without any of it being reimplemented here.
        -->
        <button class="hud__skill-slot" data-hud="skill-slot" type="button"
          aria-label="Active skill">
          <span class="socket" data-hud="socket">
            <span class="socket__mask" data-hud="socket-mask" aria-hidden="true"></span>
            <span class="socket__mark" data-hud="socket-mark" aria-hidden="true"></span>
            <span class="socket__charges" data-hud="socket-charges" aria-hidden="true"></span>
          </span>
          <span class="socket__key" data-hud="socket-key">[ SPACE ]</span>
        </button>

        <!-- Fixed Top-Screen Boss Health Bar -->
        <div class="hud__boss" data-hud="boss-container">
          <div class="hud__boss-header">
            <span class="hud__boss-title" data-hud="boss-title">DREADNOUGHT STATION</span>
            <span class="hud__boss-phase" data-hud="boss-phase">PHASE 1</span>
          </div>
          <div class="hud__boss-track">
            <div class="hud__boss-ghost" data-hud="boss-ghost"></div>
            <div class="hud__boss-fill" data-hud="boss-fill"></div>
            <div class="hud__boss-text" data-hud="boss-text"></div>
          </div>
        </div>

        <div class="hud__banner" data-hud="banner"></div>
        <!--
          The clear-out alert. A persistent state readout, NOT a banner: it
          stays up for as long as the condition holds, because it is telling the
          player what they have to DO to advance, and a message that times out
          leaves them wondering why the wave has not ended.

          It carries its own count in one line rather than sitting above a
          second "Hostiles Remaining" box — the two used to fire together on
          spawn-close (a transient banner plus this persistent readout) and sat
          stacked on screen for the 2.2s the banner held, telling the player the
          same thing twice.
        -->
        <div class="hud__objective" data-hud="objective"></div>

        <div class="hud__draft" data-hud="draft">
          <div class="draft">
            <div class="draft__tab">[ SYSTEM UPGRADE // PROTOCOL DRAFT ]</div>
            <div class="draft__body">
              <div class="hud__draft-title" data-hud="draft-title">Level up</div>
              <div class="hud__draft-options" data-hud="draft-options"></div>
            </div>
          </div>
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

    /*
     * The socket is the mobile cast control.
     *
     * `pointerdown`, not `click`: a click fires on release, which on a phone
     * is a whole press-and-lift after the player decided to dodge. Casting on
     * contact is the difference between the skill landing and the skill
     * landing a beat late.
     *
     * preventDefault stops the browser turning the press into a synthesised
     * click and a 300ms tap-highlight, and stops a drag off the button from
     * being read as a swipe on the canvas underneath.
     */
    this.el['skill-slot'].addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.sim.triggerActiveSkill();
    });
    // Desktop keyboard focus lands here too; Enter/Space on a focused button
    // would otherwise do nothing, since the keyboard path goes through
    // KeyboardInput rather than through this element.
    this.el['skill-slot'].addEventListener('click', (event) => event.preventDefault());

    /*
     * The pause key stays on `click`, unlike the skill socket.
     *
     * The socket casts on `pointerdown` because a beat of latency costs the
     * player the dodge. Pausing has the opposite requirement: a thumb that
     * brushes the top of the screen while dodging must not freeze the run, and
     * click — which needs press and release on the same element — is what
     * makes a graze harmless.
     */
    this.el.pause.addEventListener('click', () => this.handlers.onPause?.());

    bus.on('wave:start', (data) => {
      if (data.wave > 1) this.showBanner(`[ WAVE ${pad2(data.wave)} // ENGAGE ]`);
    });

    bus.on('boss:spawned', (data) => {
      const wave = data?.wave || this.sim.state.wave;
      const title =
        wave >= 15
          ? '[ CRITICAL THREAT // DREADNOUGHT CLASS — FINAL TIER ]'
          : '[ CRITICAL THREAT // DREADNOUGHT CLASS INBOUND ]';
      this.showBanner(title, 2.5, TONE.CRITICAL);
    });

    bus.on('boss:phase', (data) => {
      // Phase 1 is the opening state, not a transition — announcing it would
      // fire a banner on the same frame as the spawn banner.
      if (data.phase > 1) {
        this.showBanner(`[ WARNING // THREAT ESCALATION — PHASE ${data.phase} ]`, 2.0, TONE.CRITICAL);
      }
    });

    /*
     * The armour coming off is the one transition a composite boss fight
     * cannot afford to leave unannounced. The player has just spent a minute
     * dismantling the modules and is, reasonably, looking at the turret they
     * killed rather than at the hull — so the fact that the hull is now
     * shootable AND fighting back has to arrive as text, not only as a colour
     * change on a sprite they are not watching.
     */
    bus.on('boss:enraged', () =>
      this.showBanner('[ CORE BREACHED // CHASSIS ENRAGED ]', 2.4, TONE.CRITICAL)
    );

    bus.on('boss:ray_telegraph', () =>
      this.showBanner('[ WARNING // DEATH RAY CHARGING ]', 1.4, TONE.CRITICAL)
    );

    // No transient banner for spawn-close: the persistent objective plate
    // below picks this state up itself, every frame, in update(). Firing a
    // 2.2s banner here as well used to stack a second box under the first for
    // as long as the banner held, both saying the swarm needed clearing.

    bus.on('wave:complete', (data) => {
      if (!data.isFinalWave) this.showBanner(`[ WAVE ${pad2(data.wave)} CLEARED ]`);
    });

    bus.on('player:level_up', (data) => this.showBanner(`[ LEVEL ${data.level} ]`));
    // game:over / game:victory are handled by MetaUi's Bloom Complete screen.

    bus.on('draft:offer', (data) => this.showDraft(data));
    bus.on('draft:choice', () => this.hideDraft());
    bus.on('card:selected', () => this.renderLoadout());
    bus.on('state:reset', () => {
      this.hideDraft();
      this.renderLoadout();
    });
  }

  /**
   * A segmented cell meter, as used on the loadout chips and the draft cards.
   *
   * The numbers reach assistive tech through the wrapper's label rather than
   * through the cells, which carry no text of their own.
   *
   * @param {number} filled
   * @param {number} max
   * @param {string} label - e.g. "Level 3 of 5"
   * @returns {string} HTML
   */
  renderMeter(filled, max, label) {
    const cells = Array.from(
      { length: max },
      (_, i) => `<i class="hud__cell${i < filled ? ' hud__cell--on' : ''}"></i>`
    ).join('');
    return `<span class="hud__meter" role="img" aria-label="${label}">${cells}</span>`;
  }

  /**
   * Render the level-up card draft.
   * @param {{cards: Array<string>, level: number}} data
   */
  showDraft(data) {
    const offers = data.cards.map((id) => describeOffer(id, this.sim.state.activeCards));

    this.el['draft-title'].textContent = `Level ${data.level} — Select a System Upgrade`;
    this.el['draft-options'].innerHTML = offers
      .map((offer, index) => {
        // maxLevel is not part of the draft's presentation payload, and adding
        // it would mean editing src/core/. The data table is right here.
        const maxLevel = getCardById(offer.id)?.maxLevel ?? 5;
        const rarity = offer.rarity.toLowerCase();

        return `
        <button class="hud__card hud__card--${rarity}" data-card="${offer.id}" type="button">
          <span class="hud__card-chip" style="background-image:url('${RARITY_BADGE[offer.rarity]}')">${offer.rarity}</span>
          <kbd class="hud__card-key">${index + 1}</kbd>
          <span class="hud__card-name">${offer.name}</span>
          <span class="hud__card-meta">${offer.type}</span>
          <span class="hud__card-level">${
            offer.isNew ? 'NEW SYSTEM' : `Lv ${offer.currentLevel} → ${offer.nextLevel}`
          }</span>
          <span class="hud__card-desc">${offer.description}</span>
          ${this.renderMeter(
            offer.nextLevel,
            maxLevel,
            `Level ${offer.nextLevel} of ${maxLevel}`
          )}
        </button>`;
      })
      .join('');

    for (const button of this.el['draft-options'].querySelectorAll('[data-card]')) {
      button.addEventListener('click', () => this.handlers.onChooseCard?.(button.dataset.card));
    }

    this.el.draft.classList.add('hud__draft--visible');
  }

  /**
   * The left rail: one console chip per owned system, each carrying its class
   * badge, its name and a segmented level meter.
   *
   * Rebuilt only when the set or the levels actually change. It is driven by
   * card:selected, but state:reset fires it too and a per-frame rebuild would
   * throw away the chips' own transitions.
   */
  renderLoadout() {
    const owned = [...this.sim.state.activeCards.entries()];
    const key = owned.map(([id, level]) => `${id}:${level}`).join('|');
    if (key === this.loadoutKey) return;
    this.loadoutKey = key;

    this.el.loadout.innerHTML = owned
      .map(([id, level]) => {
        const card = getCardById(id);
        const badge = CLASS_BADGE[card.type] ?? { code: 'SYS', slug: 'passive' };
        const maxLevel = card.maxLevel ?? 5;

        return `
        <div class="chip chip--${badge.slug}">
          <span class="chip__badge" aria-hidden="true">${badge.code}</span>
          <span class="chip__stack">
            <span class="chip__name">${card.name}</span>
            ${this.renderMeter(level, maxLevel, `${card.name}, level ${level} of ${maxLevel}`)}
          </span>
        </div>`;
      })
      .join('');
  }

  /**
   * Stamp a tactical alert across the upper third of the field.
   *
   * @param {string} text
   * @param {number} [duration] - Seconds visible before the fade
   * @param {string} [tone] - One of TONE; omitted for routine run chatter
   */
  showBanner(text, duration = 1.4, tone = TONE.ROUTINE) {
    this.el.banner.textContent = text;
    this.el.banner.classList.remove(
      'hud__banner--alert',
      'hud__banner--critical'
    );
    if (tone !== TONE.ROUTINE) this.el.banner.classList.add(`hud__banner--${tone}`);
    this.el.banner.classList.add('hud__banner--visible');
    this.bannerTimer = duration;
  }

  hideDraft() {
    this.el.draft.classList.remove('hud__draft--visible');
  }

  /**
   * Per-frame HUD sync.
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    const state = this.sim.state;
    const player = state.player;

    this.el.wave.textContent = `${pad2(state.wave)}/${pad2(PHASE1.MAX_WAVES)}`;
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
    this.el.time.textContent = clearing ? pad2(alive) : formatClock(state.waveTimeRemaining);
    this.el.timeLabel.textContent = clearing ? 'Hostiles' : 'Time';

    this.el.objective.classList.toggle('hud__objective--visible', clearing);
    if (clearing) {
      this.el.objective.textContent = `[ ALERT // SPAWN DEPLETED — PURGE HOSTILES: ${pad2(alive)} ]`;
    }

    const hpRatio = Math.max(0, player.hp / player.maxHp);
    this.el['hp-fill'].style.width = `${hpRatio * 100}%`;
    this.el['hp-text'].textContent = `${Math.ceil(player.hp)} / ${player.maxHp} HP`;
    this.el['hull-deck'].classList.toggle(
      'hud__hull-deck--critical',
      hpRatio < HULL_CRITICAL && state.currentState === GAME_STATES.RUNNING
    );

    this.syncModule();

    const xpRatio = Math.min(1, player.xp / player.xpToNextLevel) * 100;
    this.el['xp-fill'].style.width = `${xpRatio}%`;

    // Fixed Top-Screen Boss Health Bar sync. getActiveBossView() normalises
    // the legacy Dreadnought (one HP field) and a CompositeBoss (chassis plus
    // parts) into the same shape, so this bar shows up for either.
    const boss = this.sim.getActiveBossView();
    if (boss && boss.maxHp > 0) {
      const bossHpRatio = Math.max(0, (boss.hp / boss.maxHp) * 100);
      this.el['boss-container']?.classList.add('hud__boss--visible');
      if (this.el['boss-title']) {
        const tier = Math.floor(state.wave / 5);
        this.el['boss-title'].textContent =
          state.wave >= 15
            ? `${boss.name.toUpperCase()} // FINAL TIER`
            : `${boss.name.toUpperCase()} // TIER ${tier}`;
      }
      if (this.el['boss-phase']) {
        this.el['boss-phase'].textContent = `PHASE ${boss.phase}`;
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
      this.showBanner('[ PAUSED ]', 0.2);
    }
  }

  /**
   * Sync the barrier's two readouts: the shield tube on the hull deck and the
   * module socket bottom-right.
   *
   * Both are hidden outright until the card is owned, because the socket is a
   * physical slot — an empty one reads as a module that has failed, not as one
   * the player has yet to draft.
   *
   * `cards.shieldCharge` is 0..1 readiness, not an HP pool: the barrier either
   * eats the next hit or it does not, and the fraction is how close it is to
   * being able to again.
   */
  syncModule() {
    /*
     * The Hyperion Shield's tube is still gated on owning the card — it is a
     * draft pickup and an empty gauge would read as a broken system. The
     * SOCKET is not: the active skill is equipped before the run starts, so
     * it is always there to press.
     */
    const hasBarrier = this.sim.state.activeCards.has(SOCKET_CARD_ID);
    this.el['shield-tube'].hidden = !hasBarrier;
    if (hasBarrier) {
      this.el['shield-fill'].style.width = `${this.sim.cards.shieldCharge * 100}%`;
    }

    this.syncSkillSocket();
  }

  /**
   * Sync the active-skill socket.
   *
   * Reads one snapshot rather than six getters so every element in the socket
   * is describing the same instant — a mask drawn from a charge read before
   * the ready flag was read is the kind of one-frame disagreement that shows
   * up as a flicker exactly when the skill comes off cooldown.
   */
  syncSkillSocket() {
    const skill = this.sim.activeSkills.getSnapshot();
    const socket = this.el.socket;

    if (this.el['socket-mark'].textContent !== skill.mark) {
      this.el['socket-mark'].textContent = skill.mark;
      this.el['skill-slot'].setAttribute('aria-label', `${skill.name} — active skill`);
      this.el['skill-slot'].title = skill.name;
    }

    // One custom property drives the conic wipe, so a frame of cooldown costs
    // a variable write rather than a layout.
    this.el['socket-mask'].style.setProperty('--charge', `${skill.charge * 360}deg`);

    socket.classList.toggle('socket--ready', skill.ready);
    socket.classList.toggle('socket--active', skill.active);
    /*
     * The critical-threshold pulse, on for the last second of the refill.
     * Deliberately NOT tied to `charge` crossing a fraction: at a 15s cooldown
     * that would start pulsing over three seconds out, and at 8s under two —
     * the same visual cue would mean a different amount of time per skill.
     */
    socket.classList.toggle(
      'socket--imminent',
      !skill.ready && skill.cooldownTimer > 0 && skill.cooldownTimer <= 1
    );

    /*
     * READY BURST. A one-shot flash when the refill completes, not a state:
     * `socket--ready` is already the steady-state style, and an animation
     * bound to it would replay on every re-render for as long as it stayed up.
     * Retriggering needs the class off for a frame, hence the reflow read.
     */
    if (skill.ready && !this.skillWasReady) {
      socket.classList.remove('socket--burst');
      void socket.offsetWidth;
      socket.classList.add('socket--burst');
    }
    this.skillWasReady = skill.ready;

    // Charge pips only earn their space on a multi-charge loadout.
    const showCharges = skill.maxCharges > 1;
    this.el['socket-charges'].hidden = !showCharges;
    if (showCharges) {
      this.el['socket-charges'].textContent = `${skill.charges}`;
    }

    this.el['socket-key'].textContent = skill.active
      ? 'ACTIVE'
      : skill.ready
        ? '[ SPACE ]'
        : `${Math.ceil(skill.cooldownTimer)}s`;
  }
}
