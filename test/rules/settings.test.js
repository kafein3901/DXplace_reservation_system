import { describe, expect, test } from 'vitest';
import { SETTING_KEYS, currentSettings, decideSettingChange, settingAt } from '../../src/rules/settings.js';

const T10 = Date.UTC(2026, 10, 20, 1, 0); // 2026-11-20T10:00（日本時間）
const MIN = 60_000;

const initial = [
  { id: 1, key: 'max_count', value: 3, effective_at: 0 },
  { id: 2, key: 'grace_minutes', value: 15, effective_at: 0 },
  { id: 3, key: 'max_length_minutes', value: 1440, effective_at: 0 },
];

describe('RSV-26 数値は、有効になる時刻がその時刻以下で最も新しい行の値を使う（settingAt）', () => {
  test('RSV-26 初期データだけなら初期値', () => {
    expect(settingAt(initial, 'grace_minutes', T10)).toBe(15);
    expect(settingAt(initial, 'max_count', T10)).toBe(3);
    expect(settingAt(initial, 'max_length_minutes', T10)).toBe(1440);
  });

  test('RSV-26 有効になる時刻がちょうどその時刻の行を使う（同じ時刻なら変更後）', () => {
    const settings = [...initial, { id: 4, key: 'grace_minutes', value: 30, effective_at: T10 }];
    expect(settingAt(settings, 'grace_minutes', T10)).toBe(30);
  });

  test('RSV-26 有効になる時刻が1分後の行は使わず、直前の行を使う', () => {
    const settings = [...initial, { id: 4, key: 'grace_minutes', value: 30, effective_at: T10 + MIN }];
    expect(settingAt(settings, 'grace_minutes', T10)).toBe(15);
  });

  test('RSV-26 有効になる時刻が同じ行が2つなら、番号の大きい行を使う', () => {
    const settings = [
      ...initial,
      { id: 5, key: 'grace_minutes', value: 20, effective_at: T10 },
      { id: 4, key: 'grace_minutes', value: 30, effective_at: T10 },
    ];
    expect(settingAt(settings, 'grace_minutes', T10)).toBe(20);
  });

  test('RSV-26 ほかの項目の行は使わない', () => {
    const settings = [...initial, { id: 4, key: 'max_count', value: 5, effective_at: T10 }];
    expect(settingAt(settings, 'grace_minutes', T10)).toBe(15);
  });

  test('RSV-26 値が見つからなければ例外（初期データがあるので起きないはずのバグ）', () => {
    expect(() => settingAt([], 'grace_minutes', T10)).toThrow();
  });
});

describe('RSV-25 数値の現在の値（currentSettings）', () => {
  test('RSV-25 初期データの3行だけなら 3・15・1440', () => {
    expect(currentSettings(initial, T10)).toEqual({ max_count: 3, grace_minutes: 15, max_length_minutes: 1440 });
  });

  test('RSV-25 変更の行があれば nowMin の時点の値（後に有効になる行は使わない）', () => {
    const settings = [
      ...initial,
      { id: 4, key: 'max_count', value: 5, effective_at: T10 },
      { id: 5, key: 'grace_minutes', value: 30, effective_at: T10 + MIN },
    ];
    expect(currentSettings(settings, T10)).toEqual({ max_count: 5, grace_minutes: 15, max_length_minutes: 1440 });
  });

  test('RSV-25 項目の一覧は3つ', () => {
    expect(SETTING_KEYS).toEqual(['max_count', 'grace_minutes', 'max_length_minutes']);
  });
});

describe('RSV-25 数値の変更（decideSettingChange）', () => {
  test('RSV-25 違う値は change で、before は今の値', () => {
    expect(decideSettingChange({ settings: initial, key: 'max_count', value: 5, nowMin: T10 })).toEqual({
      ok: true,
      action: 'change',
      before: 3,
    });
  });

  test('RSV-25 同じ値は unchanged（断らない）', () => {
    expect(decideSettingChange({ settings: initial, key: 'grace_minutes', value: 15, nowMin: T10 })).toEqual({
      ok: true,
      action: 'unchanged',
      before: 15,
    });
  });

  test('RSV-26 effective_at がちょうど nowMin の行があれば、その値を before にする', () => {
    const settings = [...initial, { id: 4, key: 'grace_minutes', value: 5, effective_at: T10 }];
    expect(decideSettingChange({ settings, key: 'grace_minutes', value: 20, nowMin: T10 })).toEqual({
      ok: true,
      action: 'change',
      before: 5,
    });
  });

  test('RSV-26 同じ effective_at の行が2つなら、番号の大きい行の値を before にする', () => {
    const settings = [
      ...initial,
      { id: 4, key: 'grace_minutes', value: 5, effective_at: T10 },
      { id: 5, key: 'grace_minutes', value: 20, effective_at: T10 },
    ];
    expect(decideSettingChange({ settings, key: 'grace_minutes', value: 20, nowMin: T10 })).toEqual({
      ok: true,
      action: 'unchanged',
      before: 20,
    });
  });
});
