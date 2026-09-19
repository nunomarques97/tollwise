// <tw-theme-toggle>: the header button that switches between the light and dark themes and remembers
// the choice in localStorage. Until the user picks one, the page follows the system setting, live.

import { h } from '../dom.ts';
import { otherTheme, resolveTheme, THEME_ENTRY, type Theme, toggleLabels } from '../theme-choice.ts';

function storedTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_ENTRY);
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  const applied = document.documentElement.dataset.theme;
  return applied === 'dark' || applied === 'light'
    ? applied
    : resolveTheme(storedTheme(), window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export class ThemeToggle extends HTMLElement {
  private readonly button = h('button', { type: 'button', class: 'pill-button' });
  private readonly system = window.matchMedia('(prefers-color-scheme: dark)');

  private readonly onSystemChange = (event: MediaQueryListEvent): void => {
    if (storedTheme() !== null) return;
    applyTheme(event.matches ? 'dark' : 'light');
    this.refresh();
  };

  connectedCallback(): void {
    if (!this.button.isConnected) {
      this.button.addEventListener('click', () => {
        const next = otherTheme(currentTheme());
        applyTheme(next);
        try {
          window.localStorage.setItem(THEME_ENTRY, next);
        } catch {
          // Not stored: the choice lasts until the page is reloaded.
        }
        this.refresh();
      });
      this.append(this.button);
    }
    applyTheme(currentTheme());
    this.refresh();
    this.system.addEventListener('change', this.onSystemChange);
  }

  disconnectedCallback(): void {
    this.system.removeEventListener('change', this.onSystemChange);
  }

  private refresh(): void {
    const labels = toggleLabels(currentTheme());
    this.button.textContent = labels.text;
    this.button.setAttribute('aria-label', labels.name);
  }
}
