// Applies the saved theme before the first paint (no flash). Same logic as src/theme.ts.
(() => {
  let pref = "system";
  try {
    pref = localStorage.getItem("slaves-site.theme") || "system";
  } catch {}
  const dark = pref === "dark" || (pref !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
