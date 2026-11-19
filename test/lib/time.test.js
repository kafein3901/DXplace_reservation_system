import { describe, expect, test } from 'vitest';
import { floorMinute } from '../../src/lib/time.js';

describe('TIM-4 現在時刻は秒以下を切り捨てて使う（floorMinute）', () => {
  test('TIM-4 10:00:59.999 は 10:00', () => {
    expect(floorMinute(Date.UTC(2026, 10, 20, 1, 0, 59, 999))).toBe(Date.UTC(2026, 10, 20, 1, 0));
  });

  test('TIM-4 10:01:00.000 は 10:01', () => {
    expect(floorMinute(Date.UTC(2026, 10, 20, 1, 1, 0, 0))).toBe(Date.UTC(2026, 10, 20, 1, 1));
  });
});
