/**
 * In-run pause modal: Resume, Settings, Abandon Run.
 *
 * ---------------------------------------------------------------------------
 * PAUSING IS NOT THIS MODAL'S JOB
 * ---------------------------------------------------------------------------
 * It does not touch the simulation. `open()` shows a panel; whoever opened it
 * is responsible for having paused the run, and `onResume` is responsible for
 * un-pausing it. Keeping the two separate is what lets the tab-blur handler
 * pause without a modal appearing, and lets this modal be opened over an
 * already-paused game without double-pausing anything.
 *
 * The portal's gameplayStart/gameplayStop telemetry follows the same rule and
 * for the same reason: it is reported by whoever actually pauses and resumes
 * the simulation (openPause/resumeRun in src/main.js), not from here. Every
 * route into and out of this panel — the HUD button, Escape, the scrim, a lost
 * window focus, Abandon — already funnels through those two functions, so
 * reporting there covers the pauses this modal is not involved in, and cannot
 * double-report the ones it is.
 *
 * ---------------------------------------------------------------------------
 * ABANDONING ASKS TWICE, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * Abandon is the only irreversible button in the game: it ends a run that may
 * be twenty minutes deep, and there is no undo. It also sits directly under
 * Resume, which is the button a player mashes Escape-then-Enter to reach. So
 * the first press ARMS it and the second press commits, with the label and the
 * colour both changing in between.
 *
 * The arming resets whenever the modal closes or the player touches anything
 * else, so a half-pressed Abandon cannot lie in wait until the next pause.
 *
 * PAST THE FIRST BOSS WAVE, THE EARNINGS ARE SAFE.
 * Abandoning routes through the ordinary end-of-run path, so the crate, the
 * Scrap and the debrief happen exactly as they would have on a death. The
 * confirmation exists because the RUN is unrecoverable, not the rewards.
 *
 * Short of that wave there is nothing to protect — a run abandoned that early
 * cost nothing to start and would mint free salvage on demand if it paid out,
 * so it does not (see forfeitsRunRewards in core/meta-progression.js). The
 * warning below says so explicitly rather than repeating the "still banked"
 * promise for a run about to bank nothing; the caller tells this modal which
 * warning applies via `open()`'s `belowRewardThreshold`, since only it knows
 * where the reward threshold sits.
 */

import './pause-modal.css';

/** Abandon's two states. The second is one press from ending the run. */
const ABANDON_IDLE = 'Abandon Run';
const ABANDON_ARMED = 'Confirm // End Run';

/** The warning shown once Abandon is armed, keyed by whether it will pay out. */
const ABANDON_WARNING = {
  earned: 'This ends the run. Everything earned so far is still banked.',
  forfeit: 'This ends the run BEFORE the first boss. No crate, no Scrap — nothing banks.',
};

export class PauseModal {
  /**
   * @param {HTMLElement} root - Container element (#ui-layer)
   * @param {Object} handlers
   * @param {() => void} handlers.onResume
   * @param {() => void} [handlers.onOpenSettings]
   * @param {() => void} [handlers.onAbandon] - Confirmed; end the run
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    /** Whether Abandon is one press from committing. */
    this.armed = false;

    this.build();
    this.bind();
  }

  build() {
    this.layer = document.createElement('div');
    this.layer.className = 'pause';
    this.layer.setAttribute('role', 'dialog');
    this.layer.setAttribute('aria-modal', 'true');
    this.layer.setAttribute('aria-label', 'Paused');

    this.layer.innerHTML = `
      <div class="pause__scrim" data-pause="scrim"></div>

      <div class="console console--pause">
        <div class="console__tab console__tab--amber">[ SYSTEMS HOLD // STANDBY ]</div>
        <div class="console__body pause__body">

          <h2 class="pause__title">Paused</h2>
          <p class="pause__status" data-pause="status">Wave 01 // Hostiles holding position</p>

          <div class="pause__actions">
            <button class="meta__btn meta__btn--primary" data-pause="resume">Resume</button>
            <button class="meta__btn" data-pause="settings">Settings</button>
            <button class="meta__btn meta__btn--abandon" data-pause="abandon">
              ${ABANDON_IDLE}
            </button>
          </div>

          <p class="pause__warning" data-pause="warning" hidden></p>

          <p class="pause__hint">[ ESC ] resumes</p>
        </div>
      </div>
    `;

    this.root.appendChild(this.layer);

    this.el = {};
    for (const node of this.layer.querySelectorAll('[data-pause]')) {
      this.el[node.dataset.pause] = node;
    }
  }

  bind() {
    this.el.resume.addEventListener('click', () => this.resume());
    this.el.scrim.addEventListener('click', () => this.resume());

    this.el.settings.addEventListener('click', () => {
      // Disarm first: the player has demonstrably moved on to something else,
      // and a primed Abandon waiting behind the settings modal is a trap.
      this.disarm();
      this.handlers.onOpenSettings?.();
    });

    this.el.abandon.addEventListener('click', () => {
      if (!this.armed) {
        this.arm();
        return;
      }
      this.close();
      this.handlers.onAbandon?.();
    });

    /*
     * Escape resumes. The listener is on the layer rather than the document so
     * the settings modal — which opens on top of this one and stops the event
     * there — can own the key while it is up.
     */
    this.layer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        this.resume();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Show the panel. The caller has already paused the simulation.
   *
   * @param {{wave?: number, hp?: number, maxHp?: number,
   *   belowRewardThreshold?: boolean}} [status] - `belowRewardThreshold` says
   *   whether Abandon would forfeit the run's salvage right now. The modal
   *   has no notion of what the threshold wave is — that lives in
   *   core/meta-progression.js — so the caller resolves it and passes the
   *   verdict rather than this UI layer importing reward logic to recompute it.
   */
  open(status = {}) {
    this.disarm();
    this.el.status.textContent = describeStatus(status);
    /** Which Abandon warning applies to THIS pause, decided once up front. */
    this.abandonWarning = status.belowRewardThreshold
      ? ABANDON_WARNING.forfeit
      : ABANDON_WARNING.earned;
    this.layer.classList.add('pause--active');
    // Focus into the dialog so Escape reaches the handler above and Tab cycles
    // these three buttons rather than the HUD behind the scrim.
    this.el.resume.focus({ preventScroll: true });
  }

  /** Hide the panel without resuming — used when the run is ending anyway. */
  close() {
    this.disarm();
    this.layer.classList.remove('pause--active');
  }

  /** Hide the panel and hand control back to the run. */
  resume() {
    if (!this.isOpen) return;
    this.close();
    this.handlers.onResume?.();
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.layer.classList.contains('pause--active');
  }

  /** Return focus to the panel — used when the settings modal closes. */
  refocus() {
    if (this.isOpen) this.el.resume.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ */
  /* Abandon arming                                                      */
  /* ------------------------------------------------------------------ */

  /** First press: change the label and show what is about to happen. */
  arm() {
    this.armed = true;
    this.el.abandon.textContent = ABANDON_ARMED;
    this.el.abandon.classList.add('meta__btn--abandon-armed');
    this.el.warning.textContent = this.abandonWarning ?? ABANDON_WARNING.earned;
    this.el.warning.hidden = false;
  }

  /** Back to safe. */
  disarm() {
    this.armed = false;
    this.el.abandon.textContent = ABANDON_IDLE;
    this.el.abandon.classList.remove('meta__btn--abandon-armed');
    this.el.warning.hidden = true;
  }

  /** Remove from the DOM. Used by tests and hot reload. */
  destroy() {
    this.layer.remove();
  }
}

/**
 * The one line of context on the panel.
 *
 * A pause screen that says only "Paused" makes the player click Resume to find
 * out where they were. Wave and hull are the two numbers that answer "should I
 * keep going", which is the actual question somebody opening this is asking.
 *
 * @param {{wave?: number, hp?: number, maxHp?: number}} status
 * @returns {string}
 */
function describeStatus({ wave, hp, maxHp }) {
  const parts = [];
  if (Number.isFinite(wave)) parts.push(`Wave ${String(wave).padStart(2, '0')}`);
  if (Number.isFinite(hp) && Number.isFinite(maxHp) && maxHp > 0) {
    parts.push(`Hull ${Math.max(0, Math.round(hp))} / ${Math.round(maxHp)}`);
  }
  return parts.length > 0 ? parts.join(' // ') : 'Simulation held';
}
