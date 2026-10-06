// Light or dark, chosen per device (a phone and a desktop may differ), so it
// lives in localStorage rather than the library's settings. "system" follows
// the OS. index.html applies the same choice before the app loads.
import { ref, watch } from "vue";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "kifu.theme";

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const theme = ref<ThemeChoice>(read());
const media = window.matchMedia?.("(prefers-color-scheme: light)");

function apply() {
  const light = theme.value === "light" || (theme.value === "system" && !!media?.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#f6f0e4" : "#17120d");
}

watch(theme, (v) => {
  try {
    if (v === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
  apply();
});
media?.addEventListener?.("change", apply);
apply();
