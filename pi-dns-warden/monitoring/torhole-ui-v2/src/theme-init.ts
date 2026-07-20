/* Apply the persisted theme before React and CSS paint to avoid a bright/dark
 * flash. Deliberately dependency-free and safe when storage is unavailable. */
try {
  const stored = localStorage.getItem("torhole.v2.theme");
  const preference = stored === "light" || stored === "dark" ? stored : "system";
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
} catch {
  document.documentElement.dataset.theme = "dark";
}
