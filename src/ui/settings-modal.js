/**
 * System settings modal.
 *
 * ---------------------------------------------------------------------------
 * VIEW LAYER, LIKE THE REST OF src/ui
 * ---------------------------------------------------------------------------
 * It renders whatever `getSettings()` hands back and reports changes through
 * `onChange(key, value)`. It never holds the settings itself, never writes to
 * storage, and never reaches for the audio manager or the renderer — so the
 * one place a preference can actually change is src/core/settings-manager.js,
 * and every consumer hears about it the same way.
 *
 * That also means `render()` is safe to call at any time: the controls are a
 * projection of the store, not a second copy of it.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE SAME HARDWARE AS EVERY OTHER SCREEN
 * ---------------------------------------------------------------------------
 * `.console`, `.console__tab`, `.console__body` and `.meta__btn` come from
 * meta-ui.css, so this is recognisably the machine the player was just looking
 * at. Only what is genuinely new — the slider track, the segmented selector and
 * the toggle — is declared in settings-modal.css.
 *
 * ---------------------------------------------------------------------------
 * CHANGES APPLY ON THE SPOT
 * ---------------------------------------------------------------------------
 * There is no Apply button and no Cancel. A volume slider that only takes
 * effect on Apply cannot be set by ear, which is the only way anybody sets one,
 * and a Cancel button on live audio would have to un-apply what the player has
 * spent the last ten seconds listening to. Restore Defaults is the escape
 * hatch, and it is the only thing here that changes more than one control.
 */

import './settings-modal.css';
import { SCREEN_SHAKE } from '../core/settings-manager.js';

/** The shake selector's three stops, in the order they are shown. */
const SHAKE_OPTIONS = [
  { value: SCREEN_SHAKE.FULL, label: 'Full' },
  { value: SCREEN_SHAKE.LIGHT, label: 'Light' },
  { value: SCREEN_SHAKE.OFF, label: 'Off' },
];

/** Volume rows, in mix order: the bus that contains the others goes first. */
const VOLUME_ROWS = [
  { key: 'masterVolume', label: 'Master Volume' },
  { key: 'sfxVolume', label: 'Effects' },
  { key: 'musicVolume', label: 'Music' },
];

/**
 * The switch rows.
 *
 * `hint` is not decoration. "Damage Flash" means nothing to the player who
 * needs it turned off — they are looking for the words that describe their
 * problem, and the second line is where those words are.
 */
const TOGGLE_ROWS = [
  {
    key: 'damageFlash',
    label: 'Damage Flash',
    hint: 'White impact flashes. Turn off for reduced motion.',
  },
  {
    key: 'showDamageNumbers',
    label: 'Damage Numbers',
    hint: 'Floating damage readouts over hostiles.',
  },
];

/** @param {number} v @returns {string} e.g. "80%" */
const asPercent = (v) => `${Math.round(v * 100)}%`;

export class SettingsModal {
  /**
   * @param {HTMLElement} root - Container element (#ui-layer)
   * @param {Object} handlers
   * @param {() => Object} handlers.getSettings - The live settings
   * @param {(key: string, value: *) => void} handlers.onChange
   * @param {() => void} [handlers.onReset] - Restore Defaults pressed
   * @param {() => void} [handlers.onClose] - Modal dismissed
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;

    this.build();
    this.bind();
  }

  build() {
    this.layer = document.createElement('div');
    this.layer.className = 'settings';
    this.layer.setAttribute('role', 'dialog');
    this.layer.setAttribute('aria-modal', 'true');
    this.layer.setAttribute('aria-label', 'System settings');

    this.layer.innerHTML = `
      <div class="settings__scrim" data-settings="scrim"></div>

      <!--
        Three docked parts: a pinned tab, a scrolling middle, a pinned footer.

        The tab and the actions sit OUTSIDE the scroller on purpose. Before this
        the whole plate body scrolled, which meant the only two things a player
        needs unconditionally — the title telling them where they are, and the
        Close button getting them out — were the first and last things to leave
        the screen on a short viewport.
      -->
      <div class="console console--settings" data-settings="console">
        <div class="console__tab console__tab--blue">[ SYSTEM CONFIGURATION ]</div>
        <div class="console__body settings__body">
          <div class="settings__scroll" data-settings="scroll">

          <h3 class="meta__section-label">Audio</h3>
          <div class="settings__group">
            ${VOLUME_ROWS.map((row) => volumeRow(row)).join('')}

            <div class="settings__row settings__row--switch">
              <label class="settings__label" for="settings-muted">
                Mute All
                <span class="settings__hint">Silences every bus without losing your levels.</span>
              </label>
              ${toggleControl('muted', 'settings-muted')}
            </div>
          </div>

          <h3 class="meta__section-label">Display &amp; Accessibility</h3>
          <div class="settings__group">
            <div class="settings__row settings__row--segmented">
              <span class="settings__label" id="settings-shake-label">
                Screen Shake
                <span class="settings__hint">Camera impact on hits and explosions.</span>
              </span>
              <div class="segmented" role="radiogroup" aria-labelledby="settings-shake-label"
                   data-settings="shake">
                ${SHAKE_OPTIONS.map(
                  (opt) => `
                  <button type="button" class="segmented__key" role="radio" aria-checked="false"
                          data-shake="${opt.value}">${opt.label}</button>`
                ).join('')}
              </div>
            </div>

            ${TOGGLE_ROWS.map((row) => switchRow(row)).join('')}
          </div>

          </div>

          <div class="settings__footer">
            <div class="settings__actions">
              <button class="meta__btn meta__btn--primary" data-settings="close">Close</button>
              <button class="meta__btn" data-settings="reset">Restore Defaults</button>
            </div>

            <p class="settings__note" data-settings="note" hidden>
              Storage is unavailable, so these settings last only for this session.
            </p>
          </div>
        </div>
      </div>
    `;

    this.root.appendChild(this.layer);

    this.el = {};
    for (const node of this.layer.querySelectorAll('[data-settings]')) {
      this.el[node.dataset.settings] = node;
    }
  }

  bind() {
    /*
     * Sliders report on `input`, not on `change`.
     *
     * `change` fires when the drag ENDS, which means a player setting a volume
     * hears nothing until they let go and then has to drag again. `input`
     * fires continuously, so the level moves under the thumb — and because
     * SettingsManager.patch drops writes that change nothing, dragging across
     * a single step does not produce a storm of storage writes.
     */
    for (const { key } of VOLUME_ROWS) {
      const slider = this.layer.querySelector(`[data-volume="${key}"]`);
      slider.addEventListener('input', () => {
        this.handlers.onChange?.(key, Number(slider.value) / 100);
        // The percentage readout is updated here rather than waiting for the
        // store's change event, so the number tracks the thumb exactly even if
        // the store rejects the value as a no-op.
        this.syncVolumeLabel(key, Number(slider.value) / 100);
      });
    }

    for (const key of ['muted', ...TOGGLE_ROWS.map((r) => r.key)]) {
      const box = this.layer.querySelector(`[data-toggle="${key}"]`);
      box.addEventListener('change', () => this.handlers.onChange?.(key, box.checked));
    }

    this.el.shake.addEventListener('click', (event) => {
      const key = event.target.closest('[data-shake]');
      if (key) this.handlers.onChange?.('screenShake', Number(key.dataset.shake));
    });

    this.el.close.addEventListener('click', () => this.close());
    this.el.reset.addEventListener('click', () => this.handlers.onReset?.());
    this.el.scrim.addEventListener('click', () => this.close());

    /*
     * Escape closes this modal and nothing else.
     *
     * `stopPropagation` is what makes that true: the pause modal opens this
     * one and is listening for Escape itself, and without this the same key
     * press would close the settings AND resume the run out from under the
     * player. The listener is on the layer, so it only sees keys while the
     * modal has focus inside it.
     */
    this.layer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        this.close();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /** Show the modal and pull every control up to date. */
  open() {
    this.render();
    this.layer.classList.add('settings--active');
    // Focus lands inside the dialog so the Escape listener above is live and
    // Tab cycles the controls rather than whatever is behind the scrim.
    this.el.close.focus({ preventScroll: true });
  }

  /** Dismiss. */
  close() {
    if (!this.isOpen) return;
    this.layer.classList.remove('settings--active');
    this.handlers.onClose?.();
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.layer.classList.contains('settings--active');
  }

  /**
   * Note that preferences will not survive a reload.
   *
   * Shown only when storage is genuinely unavailable — a player in a private
   * window deserves to know their choices are temporary before they spend a
   * minute making them.
   *
   * @param {boolean} persists
   */
  setPersistence(persists) {
    this.el.note.hidden = persists;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  /** Project the current settings onto every control. */
  render() {
    const settings = this.handlers.getSettings?.() ?? {};

    for (const { key } of VOLUME_ROWS) {
      const slider = this.layer.querySelector(`[data-volume="${key}"]`);
      slider.value = String(Math.round((settings[key] ?? 0) * 100));
      this.syncVolumeLabel(key, settings[key] ?? 0);
    }

    for (const key of ['muted', ...TOGGLE_ROWS.map((r) => r.key)]) {
      this.layer.querySelector(`[data-toggle="${key}"]`).checked = Boolean(settings[key]);
    }

    /*
     * Muting does not move the volume sliders — the levels are still what the
     * player set — but it does disable them, because a slider that visibly
     * moves while nothing can be heard reads as broken hardware.
     */
    const muted = Boolean(settings.muted);
    this.el.console.classList.toggle('settings--muted', muted);
    for (const { key } of VOLUME_ROWS) {
      this.layer.querySelector(`[data-volume="${key}"]`).disabled = muted;
    }

    for (const key of this.el.shake.querySelectorAll('[data-shake]')) {
      const active = Number(key.dataset.shake) === settings.screenShake;
      key.classList.toggle('segmented__key--on', active);
      key.setAttribute('aria-checked', String(active));
    }
  }

  /**
   * @param {string} key
   * @param {number} value
   */
  syncVolumeLabel(key, value) {
    const readout = this.layer.querySelector(`[data-volume-readout="${key}"]`);
    if (readout) readout.textContent = asPercent(value);
  }

  /** Remove the modal from the DOM. Used by tests and hot reload. */
  destroy() {
    this.layer.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Markup helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {{key: string, label: string}} row
 * @returns {string}
 */
function volumeRow({ key, label }) {
  const id = `settings-${key}`;
  return `
    <div class="settings__row">
      <label class="settings__label" for="${id}">
        ${label}
        <span class="settings__readout" data-volume-readout="${key}">80%</span>
      </label>
      <input class="slider" type="range" id="${id}" data-volume="${key}"
             min="0" max="100" step="1" value="80" aria-label="${label}">
    </div>
  `;
}

/**
 * @param {{key: string, label: string, hint: string}} row
 * @returns {string}
 */
function switchRow({ key, label, hint }) {
  const id = `settings-${key}`;
  return `
    <div class="settings__row settings__row--switch">
      <label class="settings__label" for="${id}">
        ${label}
        <span class="settings__hint">${hint}</span>
      </label>
      ${toggleControl(key, id)}
    </div>
  `;
}

/**
 * A real checkbox behind a drawn switch.
 *
 * The input is the control — it carries the state, the focus ring, the
 * keyboard activation and the accessibility tree. The visible switch is a
 * sibling span the CSS paints from `:checked`, so none of that has to be
 * reimplemented on a div.
 *
 * @param {string} key
 * @param {string} id
 * @returns {string}
 */
function toggleControl(key, id) {
  return `
    <span class="toggle">
      <input class="toggle__input" type="checkbox" id="${id}" data-toggle="${key}">
      <span class="toggle__track" aria-hidden="true"><span class="toggle__knob"></span></span>
    </span>
  `;
}
