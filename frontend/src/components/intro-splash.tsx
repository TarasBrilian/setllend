import type { CSSProperties } from "react";

const WORD = "Setllend";
const CENTER = (WORD.length - 1) / 2;

/**
 * Runs in <head> before first paint (SOT/frontend.md#intro), serialized into INTRO_SCRIPT, so it
 * must not use anything from module scope. Turns the intro on only for the first page load of a
 * tab session (every load when `replay`), only on `/`, and never under reduced motion. Turns it
 * off once the timeline in globals.css has finished.
 */
function runIntro(replay: boolean) {
  const FLY_START = 3040; // ms into the intro, like the CSS timeline
  const FLY_DURATION = 1050;
  const STAGGER = 90;
  const STEPS = 48;
  const FALLBACK_END = 8000; // ends the intro even if the header badge never animates

  // Each pill flies on a cubic Bézier from its center to the matching header pill, shrinking to
  // the header size: the top pill rises and lands from above, the bottom one dips and lands from
  // below. Measured when the lockup settles (about 1 s before the flight), since the header logo
  // moves with the viewport.
  function fly(lockup: Animation) {
    const pills = document.querySelectorAll<HTMLElement>(".intro-pill-shape");
    const marks = document.querySelectorAll(".logo-mark rect");
    if (pills.length < 2 || marks.length < 2) return;

    pills.forEach((pill, i) => {
      const a = pill.getBoundingClientRect();
      const b = marks[i].getBoundingClientRect();
      const dx = b.left + b.width / 2 - (a.left + a.width / 2);
      const dy = b.top + b.height / 2 - (a.top + a.height / 2);
      const h = Math.abs(dy);
      // Keeps the curves open on narrow screens, where the header logo sits almost straight above.
      const w = Math.max(Math.abs(dx), 0.5 * h);
      const scale = b.width / a.width;
      const [c1x, c1y, c2x, c2y] =
        i === 0 ? [0, -0.75 * h, dx + 0.35 * w, dy - 0.2 * h] : [-0.2 * w, 0.35 * h, dx, dy + 0.65 * h];

      const frames: Keyframe[] = [];
      for (let s = 0; s <= STEPS; s++) {
        const t = s / STEPS;
        const u = 1 - t;
        const x = 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * dx;
        const y = 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * dy;
        frames.push({ transform: `translate(${x}px, ${y}px) scale(${1 + (scale - 1) * t})` });
      }
      const flight = pill.animate(frames, {
        duration: FLY_DURATION,
        delay: FLY_START + i * STAGGER,
        easing: "cubic-bezier(0.45, 0, 0.25, 1)",
        fill: "forwards",
      });
      // Starts the timeline where the CSS animations started, so the flight keeps their pace.
      flight.startTime = lockup.startTime;
    });
  }

  try {
    const d = document.documentElement;
    const seen = sessionStorage.getItem("setllend-intro");
    sessionStorage.setItem("setllend-intro", "1");
    if ((seen && !replay) || location.pathname !== "/") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    d.dataset.intro = "play";
    const end = () => delete d.dataset.intro;
    setTimeout(end, FALLBACK_END);

    // Driven by the CSS timeline rather than timers, which start before the first paint.
    document.addEventListener("animationend", (event) => {
      const target = event.target as Element;
      if (event.animationName === "intro-lockup") {
        const lockup = target.getAnimations().find((a) => (a as CSSAnimation).animationName === "intro-lockup");
        if (lockup) fly(lockup);
      } else if (target.classList.contains("logo-badge")) {
        end();
      }
    });

    // Skip fades the intro out and shows the page as it is after the intro. A delegated
    // listener, because this runs before the button exists and needs no hydration.
    document.addEventListener("click", (event) => {
      if (!(event.target as Element).closest?.(".intro-skip")) return;
      const intro = document.querySelector(".intro");
      const fade = intro?.animate({ opacity: [1, 0] }, { duration: 250, easing: "ease-out" });
      if (fade) fade.onfinish = end;
      else end();
    });
  } catch {}
}

// Dev builds replay the intro on every reload, so it can be watched without a new tab.
export const INTRO_SCRIPT = `(${runIntro.toString()})(${process.env.NODE_ENV === "development"})`;

/** The logo intro over the Market page. CSS, hidden unless <html data-intro="play">. */
export function IntroSplash() {
  return (
    <div className="intro">
      <div className="intro-backdrop" aria-hidden />
      <div className="intro-lockup" aria-hidden>
        <div className="intro-mark">
          <span className="intro-pill intro-pill-top">
            <span className="intro-pill-shape" />
          </span>
          <span className="intro-pill intro-pill-bottom">
            <span className="intro-pill-shape" />
          </span>
        </div>
        <div className="intro-word-clip">
          <span className="intro-word">
            {[...WORD].map((letter, i) => (
              <span
                key={i}
                className="intro-letter"
                // The spread keeps "S" in place; rank fades the center letters first.
                style={{ "--o": i, "--r": Math.abs(i - CENTER) - 0.5 } as CSSProperties}
              >
                {letter}
              </span>
            ))}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="intro-skip absolute right-6 bottom-6 z-10 cursor-pointer rounded-full border border-line bg-surface/60 px-4 py-2 text-sm font-medium text-muted backdrop-blur-sm transition-colors hover:border-accent/50 hover:text-white"
      >
        Skip
      </button>
    </div>
  );
}
