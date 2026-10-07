const STORAGE_KEY = "sillyapps-theme";
const LIGHT_THEME_COLOR = "#F3E6D4";
const DARK_THEME_COLOR = "#1A1511";

function readPreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    // Private mode or blocked storage.
  }
  return "system";
}

function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") {
    return pref;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function syncThemeColor(resolved) {
  const color = resolved === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  let meta = document.querySelector('meta[name="theme-color"][data-resolved]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.dataset.resolved = "true";
    document.head.appendChild(meta);
  }
  meta.content = color;
}

function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = pref;
  document.documentElement.style.colorScheme = resolved;
  syncThemeColor(resolved);
  for (const input of document.querySelectorAll("[data-theme-toggle] input")) {
    input.checked = input.value === pref;
  }
}

function savePreference(pref) {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Private mode or blocked storage.
  }
  applyTheme(pref);
}

applyTheme(readPreference());

document.querySelectorAll("[data-theme-toggle]").forEach((root) => {
  root.addEventListener("change", (event) => {
    const value = event.target?.value;
    if (value === "light" || value === "dark" || value === "system") {
      savePreference(value);
    }
  });
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (readPreference() === "system") {
    applyTheme("system");
  }
});
