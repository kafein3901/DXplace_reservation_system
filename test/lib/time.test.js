import { describe, expect, test } from 'vitest';
import { floorMinute, windowStart } from '../../src/lib/time.js';

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
