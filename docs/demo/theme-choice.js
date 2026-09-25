// Which theme the dashboard uses. The stored choice (localStorage "tollwise.theme") wins; without one,
// the system's prefers-color-scheme decides. Pure: no DOM access. theme-init.ts applies the same rule
// before first paint; it is a classic script and cannot import this module, so it repeats the entry name.
/** The localStorage entry holding the theme the user picked with the header toggle. */
export const THEME_ENTRY = 'tollwise.theme';
export function isTheme(value) {
    return value === 'light' || value === 'dark';
}
/** The theme to show: the stored one when valid, otherwise the system preference. */
export function resolveTheme(stored, systemPrefersDark) {
    if (isTheme(stored))
        return stored;
    return systemPrefersDark ? 'dark' : 'light';
}
export function otherTheme(theme) {
    return theme === 'dark' ? 'light' : 'dark';
}
/** The toggle's visible text and accessible name: it names the theme it switches to. */
export function toggleLabels(current) {
    return current === 'dark'
        ? { text: 'Light', name: 'Switch to light theme' }
        : { text: 'Dark', name: 'Switch to dark theme' };
}
