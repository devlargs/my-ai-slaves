// Light / dark before the first paint, so a dark pick never flashes white (kept in sync by src/lib/theme.ts).
// A file, not an inline script, so the page's Content-Security-Policy can forbid inline scripts.
(function () {
  var t = null;
  try { t = localStorage.getItem("slaves.theme"); } catch (e) {}
  var dark = t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
