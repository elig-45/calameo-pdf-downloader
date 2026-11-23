(() => {
  const toggle = document.getElementById("theme-toggle");
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const darkPreference = window.matchMedia("(prefers-color-scheme: dark)");
  const storageKey = "calameo-theme";
  let preference = "system";
  const themeNames = root.lang === "fr"
    ? { system: "système", light: "clair", dark: "sombre" }
    : { system: "system", light: "light", dark: "dark" };
  const nextThemeNames = root.lang === "fr"
    ? { system: "clair", light: "sombre", dark: "système" }
    : { system: "light", light: "dark", dark: "system" };

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "dark" || saved === "light") preference = saved;
  } catch {}

  function updateThemeColor() {
    const dark = preference === "dark" || (preference === "system" && darkPreference.matches);
    if (themeColor) themeColor.content = dark ? "#111922" : "#ffffff";
  }

  function applyPreference(value) {
    preference = value;
    if (value === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = value;
    if (toggle) {
      const label = root.lang === "fr"
        ? `Thème ${themeNames[value]}. Activer pour passer au thème ${nextThemeNames[value]}.`
        : `Theme: ${themeNames[value]}. Activate to switch to ${nextThemeNames[value]}.`;
      toggle.dataset.themeChoice = value;
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
    }
    updateThemeColor();
  }

  applyPreference(preference);

  if (toggle) {
    toggle.addEventListener("click", () => {
      const value = { system: "light", light: "dark", dark: "system" }[preference] || "system";
      applyPreference(value);
      try {
        if (value === "system") localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, value);
      } catch {}
    });
  }

  darkPreference.addEventListener("change", () => {
    if (preference === "system") updateThemeColor();
  });
})();
