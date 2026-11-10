import { describe, expect, it } from 'vitest';
import { formatLength, parseAngle, parseLength, parseLengthList } from '../src/model/units';

describe('parseLength', () => {
  it('uses the default unit for bare numbers', () => {
    expect(parseLength('600', 'mm')).toBe(600);
    expect(parseLength('60', 'cm')).toBe(600);
    expect(parseLength('2', 'in')).toBeCloseTo(50.8);
  });

  it('understands explicit units', () => {
    expect(parseLength('60cm', 'mm')).toBe(600);
    expect(parseLength('1.2 m', 'mm')).toBe(1200);
    expect(parseLength('12in', 'mm')).toBeCloseTo(304.8);
    expect(parseLength('3/4"', 'mm')).toBeCloseTo(19.05);
    expect(parseLength("2' 6\"", 'mm')).toBeCloseTo(762);
    expect(parseLength('5 1/2in', 'mm')).toBeCloseTo(139.7);
  });

  it('handles signs and decimal commas', () => {
    expect(parseLength('-18', 'mm')).toBe(-18);
    expect(parseLength('1,5', 'mm')).toBe(1.5);
    expect(parseLength('.5', 'mm')).toBe(0.5);
  });

  it('rejects garbage and ambiguous input', () => {
    expect(parseLength('', 'mm')).toBeNull();
    expect(parseLength('abc', 'mm')).toBeNull();
    expect(parseLength('600 400', 'mm')).toBeNull();
    expect(parseLength('1/0', 'mm')).toBeNull();
  });
});

describe('parseLengthList', () => {
  it('splits on comma, semicolon and x', () => {
    expect(parseLengthList('600,400', 'mm')).toEqual([600, 400]);
    expect(parseLengthList('600; 400; 18', 'mm')).toEqual([600, 400, 18]);
    expect(parseLengthList('60cm x 40cm', 'mm')).toEqual([600, 400]);
  });

  it('keeps empty entries as null', () => {
    expect(parseLengthList(',400', 'mm')).toEqual([null, 400]);
  });

  it('rejects invalid parts', () => {
    expect(parseLengthList('600,abc', 'mm')).toBeNull();
  });
});

describe('formatLength', () => {
  it('trims trailing zeros', () => {
    expect(formatLength(600, 'mm')).toBe('600 mm');
    expect(formatLength(12.5, 'cm')).toBe('1.25 cm');
    expect(formatLength(25.4, 'in', false)).toBe('1');
    expect(formatLength(-0.0001, 'mm', false)).toBe('0');
  });
});

describe('parseAngle', () => {
  it('parses degrees', () => {
    expect(parseAngle('90')).toBe(90);
    expect(parseAngle('-45°')).toBe(-45);
    expect(parseAngle('x')).toBeNull();
  });
});
