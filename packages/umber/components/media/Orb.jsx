import React from "react";

/**
 * Orb — the Comparative brand mark: a state-aware, self-animating loop that
 * doubles as an AI-activity indicator. Ships the original web component inline
 * (no build step, no external deps) and exposes a thin React wrapper.
 *
 * States: "idle" (calm morph, no spin) · "thinking" (work underway) ·
 * "responding" (streaming; bump `energy` upward to make it react).
 * Inherits `currentColor` — set `color` (or a text-color style) to tint it.
 */

const PATH_A = "M100,40 C130,35 158,52 162,82 C166,112 148,152 118,158 C88,164 50,150 42,120 C34,90 70,45 100,40Z";
const PATH_B = "M100,42 C128,52 160,72 158,102 C156,132 132,160 102,158 C72,156 38,140 42,108 C46,78 72,32 100,42Z";
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;
const PATH_A_NUMBERS = (PATH_A.match(NUMBER_PATTERN) ?? []).map(Number);
const PATH_B_NUMBERS = (PATH_B.match(NUMBER_PATTERN) ?? []).map(Number);
const PATH_TEMPLATE = PATH_A.replace(NUMBER_PATTERN, "@");
const ORB_STATES = Object.freeze(["idle", "thinking", "responding"]);

function normalizeState(value) {
  return ORB_STATES.includes(value) ? value : "thinking";
}
function morphPath(amp, phase) {
  const wave = Math.sin(phase);
  let index = 0;
  return PATH_TEMPLATE.replace(/@/g, () => {
    const a = PATH_A_NUMBERS[index] ?? 0;
    const b = PATH_B_NUMBERS[index] ?? 0;
    index += 1;
    const midpoint = (a + b) / 2;
    const halfDistance = (b - a) / 2;
    return String(Math.round((midpoint + halfDistance * amp * wave) * 100) / 100);
  });
}

const HTMLElementBase = globalThis.HTMLElement ?? class {};
const FALSE_VALUES = new Set(["false", "0", "off", "no"]);

function numberAttribute(element, name, fallback, min, max) {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function supportsReducedMotion(element) {
  const view = element.ownerDocument?.defaultView;
  return view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

class ComparativeOrbElement extends HTMLElementBase {
  static get observedAttributes() { return ["state", "size", "stroke", "energy", "animated", "label"]; }
  constructor() {
    super();
    this._phase = Math.random() * 6; this._rotation = 0; this._seed = Math.random() * 6;
    this._envelope = 0; this._lastEnergy = 0; this._lastTime = 0; this._frame = 0;
    this._visible = true; this._running = false; this._observer = null;
    if (!this.attachShadow) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: inline-block; color: inherit; line-height: 0; vertical-align: middle; }
        svg { display: block; height: 100%; overflow: visible; width: 100%; }
      </style>
      <svg viewBox="0 0 200 200" part="svg"><g><path d="${PATH_A}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path></g></svg>`;
    this._group = root.querySelector("g");
    this._path = root.querySelector("path");
  }
  connectedCallback() { this._lastEnergy = this.energy; this._syncAppearance(); this._observeVisibility(); }
  disconnectedCallback() { this._stop(); this._observer?.disconnect(); this._observer = null; }
  attributeChangedCallback(name, previous, next) {
    if (previous === next) return;
    if (name === "energy") {
      const energy = this.energy;
      if (energy > this._lastEnergy) this._envelope = Math.min(1, this._envelope + 0.66);
      this._lastEnergy = energy;
    }
    if (this.isConnected) this._syncAppearance();
  }
  get state() { return normalizeState(this.getAttribute("state")); }
  set state(v) { this.setAttribute("state", normalizeState(v)); }
  get size() { return numberAttribute(this, "size", 20, 1, 2048); }
  set size(v) { this.setAttribute("size", String(v)); }
  get stroke() { return numberAttribute(this, "stroke", 15, 0.1, 200); }
  set stroke(v) { this.setAttribute("stroke", String(v)); }
  get energy() { return numberAttribute(this, "energy", 0, 0, Number.MAX_SAFE_INTEGER); }
  set energy(v) { this.setAttribute("energy", String(v)); }
  get animated() { const v = this.getAttribute("animated"); return v === null || !FALSE_VALUES.has(v.toLowerCase()); }
  set animated(v) { if (v) this.removeAttribute("animated"); else this.setAttribute("animated", "false"); }
  get label() { return this.getAttribute("label") ?? ""; }
  set label(v) { if (v) this.setAttribute("label", v); else this.removeAttribute("label"); }
  _syncAppearance() {
    if (!this._path || !this._group) return;
    const size = `${this.size}px`;
    this.style.width = size; this.style.height = size;
    this._path.setAttribute("stroke-width", String(this.stroke));
    if (this.label) { this.setAttribute("role", "img"); this.setAttribute("aria-label", this.label); this.removeAttribute("aria-hidden"); }
    else { this.removeAttribute("role"); this.removeAttribute("aria-label"); this.setAttribute("aria-hidden", "true"); }
    if (!this.animated || supportsReducedMotion(this)) {
      this._stop(); this._path.setAttribute("d", PATH_A); this._group.removeAttribute("transform"); return;
    }
    if (this._visible) this._start();
  }
  _observeVisibility() {
    const view = this.ownerDocument?.defaultView;
    if (!view?.IntersectionObserver) { this._visible = true; this._start(); return; }
    this._observer?.disconnect();
    this._observer = new view.IntersectionObserver((entries) => {
      for (const entry of entries) {
        this._visible = entry.isIntersecting;
        if (this._visible) this._syncAppearance(); else this._stop();
      }
    }, { rootMargin: "120px" });
    this._observer.observe(this);
  }
  _start() {
    if (this._running || !this.isConnected || !this.animated) return;
    const view = this.ownerDocument?.defaultView;
    if (!view?.requestAnimationFrame) return;
    this._running = true; this._lastTime = view.performance.now() / 1000; this._tick();
    this._frame = view.requestAnimationFrame(() => this._loop());
  }
  _stop() {
    const view = this.ownerDocument?.defaultView;
    if (view?.cancelAnimationFrame && this._frame) view.cancelAnimationFrame(this._frame);
    this._frame = 0; this._running = false;
  }
  _loop() {
    if (!this._running) return;
    this._tick();
    const view = this.ownerDocument?.defaultView;
    this._frame = view?.requestAnimationFrame?.(() => this._loop()) ?? 0;
  }
  _tick() {
    if (!this._path || !this._group) return;
    const view = this.ownerDocument?.defaultView;
    if (!view?.performance) return;
    const time = view.performance.now() / 1000;
    let delta = time - this._lastTime; this._lastTime = time;
    if (delta > 0.05) delta = 0.05;
    let amplitude, churn, scale = 1, rotationSpeed;
    if (this.state === "responding") {
      this._envelope -= this._envelope * Math.min(1, 6 * delta);
      const energy = this._envelope;
      amplitude = 0.7 + 1.7 * energy; churn = 2 + 5.5 * energy; scale = 1 + 0.05 * energy; rotationSpeed = 18 + 34 * energy;
    } else if (this.state === "idle") {
      amplitude = 1; churn = 1.571; rotationSpeed = 0;
    } else {
      amplitude = 0.85 + 0.18 * Math.sin(time * 1.3 + this._seed); churn = 1.7; rotationSpeed = 16;
    }
    this._phase += churn * delta; this._rotation += rotationSpeed * delta;
    this._path.setAttribute("d", morphPath(amplitude, this._phase));
    this._group.setAttribute("transform", `translate(100 100) rotate(${this._rotation.toFixed(2)}) scale(${scale.toFixed(3)}) translate(-100 -100)`);
  }
}

function registerComparativeOrb(tagName = "comparative-orb") {
  if (!globalThis.customElements || globalThis.customElements.get(tagName)) return false;
  globalThis.customElements.define(tagName, ComparativeOrbElement);
  return true;
}
registerComparativeOrb();

/** Orb — React wrapper around the <comparative-orb> mark. */
export function Orb({ state = "idle", size = 24, stroke = 15, energy, animated = true, label, color, style, className, ...rest }) {
  return React.createElement("comparative-orb", {
    state,
    size,
    stroke,
    energy: energy != null ? energy : undefined,
    animated: animated ? undefined : "false",
    label,
    className,
    style: { color, ...style },
    ...rest,
  });
}
