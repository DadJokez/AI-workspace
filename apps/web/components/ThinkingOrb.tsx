"use client";

import { useEffect, useRef } from "react";

/**
 * ThinkingOrb — an organic, state-driven loading indicator and the product's
 * brand mark. A single monochrome SVG path morphs between two keyframes; the
 * amount of motion conveys state:
 *   thinking   — calm morph + gentle rotation ("working on it")
 *   responding — intense morph + faster rotation; each `energy` bump swells the
 *                shape, so it reads as if the orb is talking while tokens stream
 *
 * Faithful port of the handoff `thinking-orb` web component — the two keyframe
 * paths, the morph-by-interpolation math, rotation as a separate layer, and the
 * per-state amp/churn/rotSpd/scale tuning are preserved exactly (that tuning IS
 * the visual identity). Replaces the old bouncing-dots + blinking-caret
 * indicators. Honors prefers-reduced-motion by dropping rotation.
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

export type OrbState = "thinking" | "responding";

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
  className?: string;
  /** Accessible label; rendered as role="img". */
  label?: string;
}

export function ThinkingOrb({
  state = "thinking",
  size = 20,
  stroke = 15,
  energy = 0,
  className,
  label = "Thinking",
}: ThinkingOrbProps) {
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

    tick(); // paint one frame immediately so there's never an empty flash
    const loop = () => {
      tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label={label}
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
