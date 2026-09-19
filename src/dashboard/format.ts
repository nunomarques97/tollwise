// Number, money and time formatting for the dashboard. Pure functions with no DOM access, so they run
// unchanged under Node's test runner. Locale: en-US everywhere, to match the rest of the product.

const LOCALE = 'en-US';
const MICROS_PER_DOLLAR = 1_000_000;

/** A money amount as the metrics API sends it: a decimal string with at most 6 places, or 'unknown'. */
export type UsdAmount = string;

/** How a money amount is shown: the text on screen and, when that text is rounded, the exact value. */
export interface FormattedUsd {
  /** What the page shows: "$0.0226", "$1,204.50", "Unknown". */
  readonly text: string;
  /** The exact six-decimal value ("$0.022560") when `text` is rounded; undefined when `text` is exact. */
  readonly exact: string | undefined;
  /** True when the amount is 'unknown' (or not a decimal the API could have sent). */
  readonly unknown: boolean;
}

/** Parses "0.022560" or "-1.5" to whole micro-dollars; null when it is not a decimal of at most 6 places. */
export function parseMicros(amount: string): number | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (match === null) return null;
  const micros = Number(match[2]) * MICROS_PER_DOLLAR + Number((match[3] ?? '').padEnd(6, '0'));
  if (!Number.isSafeInteger(micros)) return null;
  return match[1] === '-' && micros !== 0 ? -micros : micros;
}

/** Whole dollars with thousands separators. */
function groupDollars(dollars: number): string {
  return dollars.toLocaleString(LOCALE, { maximumFractionDigits: 0 });
}

/** Non-negative micro-dollars as a whole number of 10^-decimals dollar units, rounded half up. */
function roundToUnits(micros: number, decimals: number): number {
  const factor = 10 ** (6 - decimals);
  return factor === 1 ? micros : Math.floor((micros + factor / 2) / factor);
}

/** The exact amount with its six decimals: "$0.022560", "-$1.500000". */
function exactText(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  const dollars = Math.floor(abs / MICROS_PER_DOLLAR);
  const fraction = String(abs % MICROS_PER_DOLLAR).padStart(6, '0');
  return `${sign}$${groupDollars(dollars)}.${fraction}`;
}

/**
 * Formats a USD amount for display. At or above $1: two decimals with thousands separators. Below $1:
 * enough decimals for three significant digits, between 2 and 6. Exactly zero is "$0.00". 'unknown' is
 * the word "Unknown", never a number.
 */
export function formatUsd(amount: UsdAmount): FormattedUsd {
  const micros = parseMicros(amount);
  if (micros === null) return { text: 'Unknown', exact: undefined, unknown: true };
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  const exact = exactText(micros);

  let text: string;
  if (abs === 0) {
    text = '$0.00';
  } else {
    let decimals = 2;
    if (abs < MICROS_PER_DOLLAR) {
      // Three significant digits: the first one is at 10^(floor(log10(micros)) - 6) dollars.
      const firstDigit = Math.floor(Math.log10(abs)) - 6;
      decimals = Math.min(6, Math.max(2, 2 - firstDigit));
    }
    let units = roundToUnits(abs, decimals);
    if (decimals > 2 && units >= 10 ** decimals) {
      // Rounding carried the amount up to $1: show it the way amounts of $1 or more are shown.
      decimals = 2;
      units = roundToUnits(abs, decimals);
    }
    const scale = 10 ** decimals;
    const fraction = String(units % scale).padStart(decimals, '0');
    text = `${sign}$${groupDollars(Math.floor(units / scale))}.${fraction}`;
  }
  return { text, exact: text === exact ? undefined : exact, unknown: false };
}

/** A percentage with up to two decimals and trailing zeros dropped: 0.84 -> "0.84%", 12.5 -> "12.5%". */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString(LOCALE, { maximumFractionDigits: 2, useGrouping: false })}%`;
}

/** A count with thousands separators: 12480 -> "12,480". */
export function formatCount(value: number): string {
  return value.toLocaleString(LOCALE, { maximumFractionDigits: 0 });
}

/** "1 error", "3 errors", "12,480 requests". */
export function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/**
 * A duration in milliseconds: "< 1 ms" for 0, otherwise whole milliseconds with thousands separators
 * ("1,204 ms"); "—" for null (no sample yet).
 */
export function formatMs(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '< 1 ms';
  return `${formatCount(Math.round(value))} ms`;
}

/** The local time of `date` as 24-hour HH:MM:SS. */
export function formatClock(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
