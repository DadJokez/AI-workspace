import React from "react";

/**
 * StudioMark — the open working-frame companion to Comparative's Orb.
 *
 * The four softly irregular corners arrive once when mounted. A working mark
 * keeps a quiet, low-amplitude motion after settling; idle and reduced-motion
 * marks remain still. The mark always inherits `currentColor`.
 */

const STUDIO_STATES = Object.freeze(["idle", "working"]);
const FALSE_VALUES = new Set(["false", "0", "off", "no"]);

function normalizeState(value) {
  return STUDIO_STATES.includes(value) ? value : "idle";
}

function numberAttribute(element, name, fallback, min, max) {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const HTMLElementBase = globalThis.HTMLElement ?? class {};

class ComparativeStudioMarkElement extends HTMLElementBase {
  static get observedAttributes() {
    return ["state", "size", "animated", "label"];
  }

  constructor() {
    super();
    if (!this.attachShadow) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host {
          color: inherit;
          display: inline-block;
          line-height: 0;
          vertical-align: middle;
        }
        svg {
          display: block;
          height: 100%;
          overflow: visible;
          width: 100%;
        }
        .corner {
          fill: currentColor;
          opacity: 1;
          transform-box: fill-box;
          transform-origin: center;
        }
        .top-left {
          --arrival-delay: 0ms;
          --from-x: -14px;
          --from-y: -14px;
          --from-r: -4deg;
          --over-x: 1px;
          --over-y: 1px;
          --over-r: 0.6deg;
          --drift-x: 0.7px;
          --drift-y: 0.4px;
          --drift-r: -0.45deg;
        }
        .top-right {
          --arrival-delay: 55ms;
          --from-x: 14px;
          --from-y: -14px;
          --from-r: 3deg;
          --over-x: -1px;
          --over-y: 1px;
          --over-r: -0.5deg;
          --drift-x: -0.5px;
          --drift-y: 0.7px;
          --drift-r: 0.4deg;
        }
        .bottom-right {
          --arrival-delay: 105ms;
          --from-x: 14px;
          --from-y: 14px;
          --from-r: -3deg;
          --over-x: -1px;
          --over-y: -1px;
          --over-r: 0.5deg;
          --drift-x: -0.7px;
          --drift-y: -0.4px;
          --drift-r: -0.35deg;
        }
        .bottom-left {
          --arrival-delay: 150ms;
          --from-x: -14px;
          --from-y: 14px;
          --from-r: 4deg;
          --over-x: 1px;
          --over-y: -1px;
          --over-r: -0.6deg;
          --drift-x: 0.5px;
          --drift-y: -0.7px;
          --drift-r: 0.45deg;
        }
        :host(:not([animated="false"])) .corner {
          animation: studio-corner-arrive 520ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)) var(--arrival-delay) both;
        }
        :host([state="working"]:not([animated="false"])) .corner {
          animation:
            studio-corner-arrive 520ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)) var(--arrival-delay) both,
            studio-corner-work 3.8s ease-in-out calc(var(--arrival-delay) + 620ms) infinite alternate;
        }
        @keyframes studio-corner-arrive {
          0% {
            opacity: 0;
            transform: translate(var(--from-x), var(--from-y)) rotate(var(--from-r)) scale(0.92);
          }
          72% {
            opacity: 1;
            transform: translate(var(--over-x), var(--over-y)) rotate(var(--over-r)) scale(1.015);
          }
          100% {
            opacity: 1;
            transform: translate(0, 0) rotate(0) scale(1);
          }
        }
        @keyframes studio-corner-work {
          from { transform: translate(0, 0) rotate(0) scale(1); }
          to { transform: translate(var(--drift-x), var(--drift-y)) rotate(var(--drift-r)) scale(1.008); }
        }
        @media (prefers-reduced-motion: reduce) {
          .corner {
            animation: none !important;
            opacity: 1 !important;
            transform: none !important;
          }
        }
      </style>
      <svg viewBox="0 0 200 200" part="svg">
        <path class="corner top-left" part="corner top-left" d="M24 53C38 52 55 52.7 74 54C79 55 80 62 76 66C62 65 47 64.5 34 65.5C33.5 79 34 94 35.5 108C32.5 112.5 25 112 22.5 107.5C21.5 90 21.7 70 24 53Z"></path>
        <path class="corner top-right" part="corner top-right" d="M126 54C145 52.7 162 52 176 53C178.3 70 178.5 90 177.5 107.5C175 112 167.5 112.5 164.5 108C166 94 166.5 79 166 65.5C153 64.5 138 65 124 66C120 62 121 55 126 54Z"></path>
        <path class="corner bottom-right" part="corner bottom-right" d="M164.5 92C167.5 87.5 175 88 177.5 92.5C178.5 110 178.3 130 176 147C162 148 145 147.3 126 146C121 145 120 138 124 134C138 135 153 135.5 166 134.5C166.5 121 166 106 164.5 92Z"></path>
        <path class="corner bottom-left" part="corner bottom-left" d="M35.5 92C34 106 33.5 121 34 134.5C47 135.5 62 135 76 134C80 138 79 145 74 146C55 147.3 38 148 24 147C21.7 130 21.5 110 22.5 92.5C25 88 32.5 87.5 35.5 92Z"></path>
      </svg>`;
  }

  connectedCallback() {
    this._syncAppearance();
  }

  attributeChangedCallback(_name, previous, next) {
    if (previous === next || !this.isConnected) return;
    this._syncAppearance();
  }

  get state() {
    return normalizeState(this.getAttribute("state"));
  }

  set state(value) {
    this.setAttribute("state", normalizeState(value));
  }

  get size() {
    return numberAttribute(this, "size", 24, 1, 2048);
  }

  set size(value) {
    this.setAttribute("size", String(value));
  }

  get animated() {
    const value = this.getAttribute("animated");
    return value === null || !FALSE_VALUES.has(value.toLowerCase());
  }

  set animated(value) {
    if (value) this.removeAttribute("animated");
    else this.setAttribute("animated", "false");
  }

  get label() {
    return this.getAttribute("label") ?? "";
  }

  set label(value) {
    if (value) this.setAttribute("label", value);
    else this.removeAttribute("label");
  }

  _syncAppearance() {
    const size = `${this.size}px`;
    this.style.width = size;
    this.style.height = size;
    if (this.getAttribute("state") !== this.state) {
      this.setAttribute("state", this.state);
    }
    if (this.label) {
      this.setAttribute("role", "img");
      this.setAttribute("aria-label", this.label);
      this.removeAttribute("aria-hidden");
    } else {
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
      this.setAttribute("aria-hidden", "true");
    }
  }
}

function registerComparativeStudioMark(tagName = "comparative-studio-mark") {
  if (!globalThis.customElements || globalThis.customElements.get(tagName)) {
    return false;
  }
  globalThis.customElements.define(tagName, ComparativeStudioMarkElement);
  return true;
}

registerComparativeStudioMark();

/** StudioMark — React wrapper around the <comparative-studio-mark> mark. */
export function StudioMark({
  state = "idle",
  size = 24,
  animated = true,
  label,
  color,
  style,
  className,
  ...rest
}) {
  return React.createElement("comparative-studio-mark", {
    state,
    size,
    animated: animated ? undefined : "false",
    label,
    className,
    style: { color, ...style },
    ...rest,
  });
}
