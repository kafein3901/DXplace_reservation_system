import { describe, expect, test } from 'vitest';
import { floorMinute, formatDate, formatDateTime, parseDate, parseDateTime, windowStart } from '../../src/lib/time.js';

describe('TIM-4 現在時刻は秒以下を切り捨てて使う（floorMinute）', () => {
  test('TIM-4 10:00:59.999 は 10:00', () => {
    expect(floorMinute(Date.UTC(2026, 10, 20, 1, 0, 59, 999))).toBe(Date.UTC(2026, 10, 20, 1, 0));
  });

  test('TIM-4 10:01:00.000 は 10:01', () => {
    expect(floorMinute(Date.UTC(2026, 10, 20, 1, 1, 0, 0))).toBe(Date.UTC(2026, 10, 20, 1, 1));
  });
});

describe('SEC-3 試行を数える10分の区切り（windowStart）', () => {
  const t1000 = Date.UTC(2026, 10, 20, 1, 0);

  test('SEC-3 10:09:59.999 と 10:00 は同じ区切り', () => {
    expect(windowStart(Date.UTC(2026, 10, 20, 1, 9, 59, 999))).toBe(t1000);
    expect(windowStart(t1000)).toBe(t1000);
  });

  test('SEC-3 10:10 は次の区切り', () => {
    expect(windowStart(Date.UTC(2026, 10, 20, 1, 10))).toBe(Date.UTC(2026, 10, 20, 1, 10));
  });
});

describe('TIM-1 日本時間の時刻の形式（formatDateTime）', () => {
  test('TIM-1 UTC の 2026-11-20 01:00 は 2026-11-20T10:00', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 20, 1, 0))).toBe('2026-11-20T10:00');
  });

  test('TIM-1 UTC の 14:59 と 15:00 で日本時間の日付が変わる', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 20, 14, 59))).toBe('2026-11-20T23:59');
    expect(formatDateTime(Date.UTC(2026, 10, 20, 15, 0))).toBe('2026-11-21T00:00');
  });

  test('TIM-1 秒のある時刻を渡しても秒は出ない', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 20, 1, 0, 59, 999))).toBe('2026-11-20T10:00');
  });
});

describe('TIM-3 境界の時刻の形式（parseDateTime）', () => {
  test('TIM-3 2026-11-20T10:00 は UTC の 2026-11-20 01:00', () => {
    expect(parseDateTime('2026-11-20T10:00')).toEqual({ ok: true, value: Date.UTC(2026, 10, 20, 1, 0) });
  });

  test('TIM-3 2026-11-20T00:00 は前の日の 15:00 UTC', () => {
    expect(parseDateTime('2026-11-20T00:00')).toEqual({ ok: true, value: Date.UTC(2026, 10, 19, 15, 0) });
  });

  test('TIM-3 うるう年の 2028-02-29T23:59 と 9999-12-31T23:59 を受け付ける', () => {
    expect(parseDateTime('2028-02-29T23:59')).toEqual({ ok: true, value: Date.UTC(2028, 1, 29, 14, 59) });
    expect(parseDateTime('9999-12-31T23:59')).toEqual({ ok: true, value: Date.UTC(9999, 11, 31, 14, 59) });
  });

  test.each([
    '2026-11-20T10:00:00',
    '2026-11-20 10:00',
    '2026-11-20T10:00+09:00',
    '2026-11-20T10:00Z',
    '2026-02-30T10:00',
    '2027-02-29T10:00',
    '2026-11-20T24:00',
    '2026-11-20T10:60',
    '2026-1-2T3:04',
    '２０２６-11-20T10:00',
    '0099-01-01T00:00',
    '',
  ])('TIM-3 %j は INPUT_TIME', (value) => {
    expect(parseDateTime(value)).toEqual({ ok: false, code: 'INPUT_TIME' });
  });
});

describe('VIW-1 予約状況の日の形式（parseDate）', () => {
  test('VIW-1 2026-11-20 はその日の 0:00（日本時間）', () => {
    expect(parseDate('2026-11-20')).toEqual({ ok: true, value: Date.UTC(2026, 10, 19, 15, 0) });
  });

  test.each([null, '2026-11-31', '2026-11-20T00:00', '20261120', ''])('VIW-1 %j は INPUT_DATE', (value) => {
    expect(parseDate(value)).toEqual({ ok: false, code: 'INPUT_DATE' });
  });
});

describe('TIM-1 直した値を戻すと元の文字列になる（formatDateTime・formatDate）', () => {
  test('TIM-1 parseDateTime と formatDateTime', () => {
    expect(formatDateTime(parseDateTime('2026-11-20T23:59').value)).toBe('2026-11-20T23:59');
  });

  test('TIM-1 parseDate と formatDate', () => {
    expect(formatDate(parseDate('2026-01-01').value)).toBe('2026-01-01');
  });

  test('TIM-1 UTC の 14:59 と 15:00 で日本時間の日付が変わる', () => {
    expect(formatDate(Date.UTC(2026, 10, 20, 14, 59))).toBe('2026-11-20');
    expect(formatDate(Date.UTC(2026, 10, 20, 15, 0))).toBe('2026-11-21');
  });
});
