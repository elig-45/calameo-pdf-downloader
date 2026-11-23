(() => {
  const select = document.getElementById("theme-choice");
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const darkPreference = window.matchMedia("(prefers-color-scheme: dark)");
  const storageKey = "calameo-theme";
  let preference = "system";

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "dark" || saved === "light") preference = saved;
  } catch {}

  function updateThemeColor() {
    const dark = preference === "dark" || (preference === "system" && darkPreference.matches);
    if (themeColor) themeColor.content = dark ? "#0d1117" : "#ffffff";
  }

  function applyPreference(value) {
    preference = value;
    if (value === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = value;
    if (select) select.value = value;
    updateThemeColor();
  }

  applyPreference(preference);

  if (select) {
    select.addEventListener("change", () => {
      const value = select.value;
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
