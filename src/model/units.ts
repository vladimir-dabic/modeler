import type { Unit } from './types';

export const UNIT_TO_MM: Record<Unit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
};

const UNIT_ALIASES: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  '"': 25.4,
  inch: 25.4,
  ft: 304.8,
  "'": 304.8,
};

const DECIMALS: Record<Unit, number> = { mm: 2, cm: 3, m: 4, in: 3 };

/** Format a length in mm for display in the given unit, trimming trailing zeros. */
export function formatLength(mm: number, unit: Unit, withUnit = true): string {
  const value = mm / UNIT_TO_MM[unit];
  const text = trimNumber(value, DECIMALS[unit]);
  return withUnit ? `${text} ${unit}` : text;
}

export function formatAngle(deg: number): string {
  return `${trimNumber(deg, 2)}°`;
}

export function trimNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}

/**
 * Parse a length typed by the user. Bare numbers use `defaultUnit`.
 * Accepts things like `600`, `60cm`, `1.2 m`, `12in`, `3/4"`, `2' 6"`, `5 1/2in`, `-18`.
 * Returns millimetres, or null when the text is not a length.
 */
export function parseLength(text: string, defaultUnit: Unit): number | null {
  let s = text.trim().toLowerCase().replace(/,/g, '.');
  if (!s) return null;
  let sign = 1;
  if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  // A term is: whole number, optional fraction ("1/2" or "5 1/2"), optional unit.
  const term = /^(\d+(?:\.\d*)?|\.\d+)(?:\s+(\d+)\/(\d+)|\/(\d+))?\s*(mm|cm|m|inch|in|ft|"|')?\s*/;
  let total = 0;
  let matched = false;
  let previousHadUnit = true;
  while (s.length) {
    const m = term.exec(s);
    // Compound values (2' 6") are only allowed when each earlier part has an explicit unit.
    if (!m || !previousHadUnit) return null;
    previousHadUnit = m[5] !== undefined;
    let value = parseFloat(m[1]);
    if (m[2] !== undefined) {
      const den = parseFloat(m[3]);
      if (!den) return null;
      value += parseFloat(m[2]) / den;
    } else if (m[4] !== undefined) {
      const den = parseFloat(m[4]);
      if (!den) return null;
      value /= den;
    }
    const factor = m[5] ? UNIT_ALIASES[m[5]] : UNIT_TO_MM[defaultUnit];
    total += value * factor;
    matched = true;
    s = s.slice(m[0].length);
  }
  return matched && Number.isFinite(total) ? sign * total : null;
}

/**
 * Parse a list of lengths such as `600, 400` or `600;400` or `600x400`.
 * Empty entries are returned as null so a user can type `,400` to keep the first value.
 */
export function parseLengthList(text: string, defaultUnit: Unit): (number | null)[] | null {
  // Decimal commas are ambiguous with separators, so a comma is always a separator here.
  const parts = text.split(/\s*[;,xX*]\s*/);
  const result: (number | null)[] = [];
  for (const part of parts) {
    if (part.trim() === '') {
      result.push(null);
      continue;
    }
    const value = parseLength(part, defaultUnit);
    if (value === null) return null;
    result.push(value);
  }
  return result.length ? result : null;
}

export function parseAngle(text: string): number | null {
  const s = text.trim().replace(/°|deg$/i, '').replace(/,/g, '.');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return parseFloat(s);
}
