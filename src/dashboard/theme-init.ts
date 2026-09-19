// Loaded first in <head> as a classic script (not a module, so it runs before the first paint): sets the
// theme on the root element so the page never flashes the wrong one. Same rule as theme-choice.ts, which
// a classic script cannot import: the stored choice in localStorage "tollwise.theme" wins, otherwise the
// system's prefers-color-scheme decides.
(() => {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem('tollwise.theme');
  } catch {
    // Storage can be unavailable (disabled by the browser); the system preference applies.
  }
  const theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.dataset.theme = theme;
})();
