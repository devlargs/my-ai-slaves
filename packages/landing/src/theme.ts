import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "slaves-site.theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function resolved(pref: ThemePref): "light" | "dark" {
  return pref === "dark" || (pref === "system" && media().matches) ? "dark" : "light";
}

/** The site's theme: follows the OS until you pick one (kept in localStorage). */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(read);
  const [, rerender] = useState(0);
  useEffect(() => {
    const apply = () => {
      const t = resolved(pref);
      document.documentElement.dataset.theme = t;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#141210" : "#fbf9f7");
      rerender((n) => n + 1);
    };
    apply();
    const m = media();
    m.addEventListener("change", apply);
    return () => m.removeEventListener("change", apply);
  }, [pref]);
  const set = (next: ThemePref) => {
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {}
    setPref(next);
  };
  return { pref, theme: resolved(pref), set };
}
