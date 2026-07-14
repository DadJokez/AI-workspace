"use client";

import { useEffect, useRef } from "react";

/**
 * ThinkingOrb — an organic, state-driven loading indicator and the product's
 * brand mark. A single monochrome SVG path morphs between two keyframes; the
 * amount of motion conveys state:
 *   idle       — a calm continuous morph, no rotation (the resting brand mark)
 *   thinking   — calm morph + gentle rotation ("working on it")
 *   responding — intense morph + faster rotation; each `energy` bump swells the
 *                shape, so it reads as if the orb is talking while tokens stream
 *
 * Faithful port of the handoff `thinking-orb` web component — the two keyframe
 * paths, the morph-by-interpolation math, rotation as a separate layer, and the
 * per-state amp/churn/rotSpd/scale tuning are preserved exactly (that tuning IS
 * the visual identity). Replaces the old bouncing-dots + blinking-caret
 * indicators. Under prefers-reduced-motion it renders a single static frame —
 * no morph, swell, or rotation.
 *
 * The canonical mark lives in packages/umber/components/media/Orb.jsx; this
 * port exists for app-specific perf work (IntersectionObserver pausing,
 * per-message static frames). Exactness is enforced by
 * __tests__/brand-orb-parity.test.ts — if that fails after a re-vendor,
 * re-derive this port from the vendored Orb.
 */

const PA =
  "M100,40 C130,35 158,52 162,82 C166,112 148,152 118,158 C88,164 50,150 42,120 C34,90 70,45 100,40Z";
const PB =
  "M100,42 C128,52 160,72 158,102 C156,132 132,160 102,158 C72,156 38,140 42,108 C46,78 72,32 100,42Z";
const NUM = /-?\d+(?:\.\d+)?/g;
const AN = (PA.match(NUM) ?? []).map(Number);
const BN = (PB.match(NUM) ?? []).map(Number);
const TPL = PA.replace(NUM, "@");

/** amp = 1 reproduces the original A↔B swing; <1 calmer, >1 more intense. */
function morphPath(amp: number, phase: number): string {
  const s = Math.sin(phase);
  let i = 0;
  return TPL.replace(/@/g, () => {
    const a = AN[i] ?? 0;
    const b = BN[i] ?? 0;
    i += 1;
    const mid = (a + b) / 2;
    const half = (b - a) / 2;
    return String(Math.round((mid + half * amp * s) * 100) / 100);
  });
}

export type OrbState = "idle" | "thinking" | "responding";

export interface ThinkingOrbProps {
  state?: OrbState;
  /** px size (square). Default 20. */
  size?: number;
  /** Stroke weight in the 0–200 viewBox; raise it at small sizes. Default 15. */
  stroke?: number;
  /**
   * Monotonic counter — each increase delivers one pump of "vocal energy" so the
   * orb swells per streamed chunk while responding. Pass the streamed content
   * length (or a token count). Ignored while `thinking`.
   */
  energy?: number;
  /**
   * When false, the orb renders a single settled frame and never starts an
   * animation loop — a calm static brand mark (used for completed messages so
   * only the in-progress turn moves). Default true.
   */
  animated?: boolean;
  className?: string;
  /** Accessible label → role="img". Omit for a decorative orb (aria-hidden). */
  label?: string;
}

export function ThinkingOrb({
  state = "thinking",
  size = 20,
  stroke = 15,
  energy = 0,
  animated = true,
  className,
  label,
}: ThinkingOrbProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const pRef = useRef<SVGPathElement>(null);
  const stateRef = useRef<OrbState>(state);
  const envRef = useRef(0);
  const lastEnergyRef = useRef(energy);

  // Track the latest state/energy without restarting the animation loop.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (energy > lastEnergyRef.current) {
      // pump(0.7): env = min(1, env + 0.7*0.8 + 0.1)
      envRef.current = Math.min(1, envRef.current + 0.66);
    }
    lastEnergyRef.current = energy;
  }, [energy]);

  useEffect(() => {
    const g = gRef.current;
    const p = pRef.current;
    if (!g || !p) return;

    const reduced =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Static mode — animation off, or the user prefers reduced motion. Settle
    // on one clean frame and never start a loop. Reduced-motion suppresses the
    // morph and swell too, not just rotation.
    if (!animated || reduced) {
      p.setAttribute("d", PA);
      g.setAttribute("transform", "");
      return;
    }
    let phase = Math.random() * 6;
    let rot = 0;
    const seed = Math.random() * 6;
    let last = performance.now() / 1000;
    let raf = 0;

    const tick = () => {
      const t = performance.now() / 1000;
      let dt = t - last;
      last = t;
      if (dt > 0.05) dt = 0.05;

      let amp: number;
      let churn: number;
      let scale = 1;
      let rotSpd: number;

      if (stateRef.current === "responding") {
        envRef.current -= envRef.current * Math.min(1, 6 * dt); // decay between chunks
        const e = envRef.current;
        amp = 0.7 + 1.7 * e;
        churn = 2.0 + 5.5 * e;
        scale = 1 + 0.05 * e;
        rotSpd = reduced ? 0 : 18 + 34 * e;
      } else if (stateRef.current === "idle") {
        amp = 1.0;
        churn = 1.571; // ≈ 4s morph period
        rotSpd = 0; // the resting logo never spins
      } else {
        amp = 0.85 + 0.18 * Math.sin(t * 1.3 + seed);
        churn = 1.7;
        rotSpd = reduced ? 0 : 16;
      }

      phase += churn * dt;
      rot += rotSpd * dt;
      p.setAttribute("d", morphPath(amp, phase));
      g.setAttribute(
        "transform",
        `translate(100 100) rotate(${rot.toFixed(2)}) scale(${scale.toFixed(
          3,
        )}) translate(-100 -100)`,
      );
    };

    let running = false;
    const loop = () => {
      tick();
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running) return;
      running = true;
      last = performance.now() / 1000; // avoid a dt jump after a pause
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    tick(); // paint one frame immediately so there's never an empty flash

    // Animate only while on-screen. A long thread can hold dozens of orbs; the
    // off-screen ones cost nothing (rAF paused, frozen on their last frame).
    let observer: IntersectionObserver | null = null;
    const svg = svgRef.current;
    if (typeof IntersectionObserver !== "undefined" && svg) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) start();
            else stop();
          }
        },
        { rootMargin: "120px" },
      );
      observer.observe(svg);
    } else {
      start();
    }

    return () => {
      stop();
      observer?.disconnect();
    };
  }, [animated]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        overflow: "visible",
      }}
    >
      <g ref={gRef}>
        <path
          ref={pRef}
          d={PA}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
