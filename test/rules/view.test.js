// 予約状況（rules.md 6.9）
import { describe, expect, test } from 'vitest';
import { daySlots } from '../../src/rules/view.js';

const H = 3_600_000;
const DAY_START = Date.UTC(2026, 10, 19, 15, 0); // 2026-11-20T00:00（日本時間）
const DAY_END = DAY_START + 24 * H;

let nextId = 1;
const r = (startHour, endHour, status = 'reserved', id = nextId++) => ({
  id,
  start_at: DAY_START + startHour * H,
  end_at: DAY_START + endHour * H,
  status,
});
const ids = (list) => daySlots(list, DAY_START, DAY_END).map((x) => x.id);

describe('VIW-1 表示する状態（daySlots）', () => {
  test.each(['reserved', 'in_use', 'finished', 'admin_finished'])('VIW-1 %s は残す', (status) => {
    const x = r(10, 11, status);
    expect(ids([x])).toEqual([x.id]);
  });

  test.each(['cancelled', 'no_show', 'admin_cancelled'])('VIW-1 %s は残さない', (status) => {
    expect(ids([r(10, 11, status)])).toEqual([]);
  });
});

describe('VIW-1 その日にかかるか（daySlots。TIM-2）', () => {
  test.each([
    ['日の中に収まる', 10, 11],
    ['前の日の 23:00〜その日の 1:00', -1, 1],
    ['その日の 23:00〜次の日の 1:00', 23, 25],
    ['前の日から次の日まで', -2, 26],
    ['開始がちょうど日の始まり', 0, 1],
    ['長さ0で開始が日の始まりちょうど', 0, 0],
    ['長さ0で開始が 23:59', 23 + 59 / 60, 23 + 59 / 60],
  ])('VIW-1 %s は残す', (_, start, end) => {
    const x = r(start, end, 'finished');
    expect(ids([x])).toEqual([x.id]);
  });

  test.each([
    ['終了がちょうど日の始まり（長さが正）', -1, 0],
    ['開始がちょうど次の日の始まり', 24, 25],
    ['長さ0で開始が次の日の始まり', 24, 24],
  ])('VIW-1 %s は残さない', (_, start, end) => {
    expect(ids([r(start, end, 'finished')])).toEqual([]);
  });
});

describe('VIW-1 並び（daySlots）', () => {
  test('VIW-1 開始時刻の順。同じ開始時刻なら番号の順', () => {
    const a = r(12, 13, 'reserved', 30);
    const b = r(9, 10, 'finished', 20);
    const c = r(12, 12, 'finished', 10);
    expect(ids([a, b, c])).toEqual([20, 10, 30]);
  });

  test('VIW-1 引数を書き換えず、要素はそのまま返す', () => {
    const a = r(12, 13);
    const b = r(9, 10);
    const list = [a, b];
    const result = daySlots(list, DAY_START, DAY_END);
    expect(list).toEqual([a, b]);
    expect(result[0]).toBe(b);
  });
});
