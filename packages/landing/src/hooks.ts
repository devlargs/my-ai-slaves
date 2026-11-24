import { type RefObject, useEffect, useRef, useState } from "react";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** True while the element is on screen (used to run animations only when someone can see them). */
export function useInView<T extends Element>(ref: RefObject<T | null>, margin = "0px"): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return inView;
}

/** True while the tab is visible: looping work stops in a background tab. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const on = () => {
      setVisible(!document.hidden);
      document.documentElement.classList.toggle("window-hidden", document.hidden);
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/** Adds `.in-view` to every `.reveal` element once it scrolls into view (one shared observer). */
export function useRevealAll(): void {
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>(".reveal")];
    if (prefersReducedMotion()) {
      for (const el of els) el.classList.add("in-view");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in-view");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);
}

/** The page's scroll offset, read at most once per frame. */
export function useScrollY(): number {
  const [y, setY] = useState(0);
  const frame = useRef(0);
  useEffect(() => {
    const on = () => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setY(window.scrollY);
      });
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      window.removeEventListener("scroll", on);
      cancelAnimationFrame(frame.current);
    };
  }, []);
  return y;
}
