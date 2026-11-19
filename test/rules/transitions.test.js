import { describe, expect, test } from 'vitest';
import { dueTransitions } from '../../src/rules/transitions.js';

const T10 = Date.UTC(2026, 10, 20, 1, 0); // 2026-11-20T10:00（日本時間）
const MIN = 60_000;

const initial = [
  { id: 1, key: 'max_count', value: 3, effective_at: 0 },
  { id: 2, key: 'grace_minutes', value: 15, effective_at: 0 },
  { id: 3, key: 'max_length_minutes', value: 1440, effective_at: 0 },
];

function reservation(id, status, startAt, endAt) {
  return { id, device_id: 1, user_id: 1, start_at: startAt, end_at: endAt, status, cause: null, walk_in: 0 };
}

describe('RSV-13 予約済の予約は、開始時刻から猶予が過ぎたら無断不使用になる', () => {
  const r = reservation(1, 'reserved', T10, T10 + 60 * MIN);

  test('RSV-13 受け付ける：猶予の終わり（10:15）ちょうどの nowMin で無断不使用になる（RSV-22）', () => {
    expect(dueTransitions([r], initial, T10 + 15 * MIN)).toEqual([
      { reservationId: 1, to: 'no_show', at: T10 + 15 * MIN },
    ]);
  });

  test('RSV-13 変化なし：猶予の終わりの1分前（10:14）ではまだ予約済', () => {
    expect(dueTransitions([r], initial, T10 + 14 * MIN)).toEqual([]);
  });

  test('RSV-21 長い時間が過ぎてから反映しても、起きる時刻はルール上の時刻（10:15）', () => {
    expect(dueTransitions([r], initial, T10 + 30 * 24 * 60 * MIN)).toEqual([
      { reservationId: 1, to: 'no_show', at: T10 + 15 * MIN },
    ]);
  });
});

describe('RSV-16 猶予が予約の長さより長いときは、終了時刻で無断不使用になる', () => {
  const r = reservation(1, 'reserved', T10, T10 + 10 * MIN); // 10 分の予約、猶予 15 分

  test('RSV-16 終了時刻（10:10）で無断不使用になる', () => {
    expect(dueTransitions([r], initial, T10 + 10 * MIN)).toEqual([
      { reservationId: 1, to: 'no_show', at: T10 + 10 * MIN },
    ]);
  });

  test('RSV-16 終了時刻の1分前ではまだ予約済', () => {
    expect(dueTransitions([r], initial, T10 + 9 * MIN)).toEqual([]);
  });
});

describe('RSV-19 利用中の予約は、終了時刻で終了になる', () => {
  const r = reservation(1, 'in_use', T10, T10 + 60 * MIN);

  test('RSV-19 終了時刻（11:00）ちょうどの nowMin で終了になる（RSV-22）', () => {
    expect(dueTransitions([r], initial, T10 + 60 * MIN)).toEqual([
      { reservationId: 1, to: 'finished', at: T10 + 60 * MIN },
    ]);
  });

  test('RSV-19 終了時刻の1分前ではまだ利用中（猶予は関係しない）', () => {
    expect(dueTransitions([r], initial, T10 + 59 * MIN)).toEqual([]);
  });
});

describe('RSV-26 猶予は、その予約の開始時刻の時点の値を使う', () => {
  const r = reservation(1, 'reserved', T10, T10 + 60 * MIN);

  test('RSV-26 開始時刻より後に猶予を 30 分に変えても、15 分で無断不使用になる', () => {
    const settings = [...initial, { id: 4, key: 'grace_minutes', value: 30, effective_at: T10 + MIN }];
    expect(dueTransitions([r], settings, T10 + 15 * MIN)).toEqual([
      { reservationId: 1, to: 'no_show', at: T10 + 15 * MIN },
    ]);
  });

  test('RSV-26 開始時刻ちょうどに有効になった猶予 30 分を使う', () => {
    const settings = [...initial, { id: 4, key: 'grace_minutes', value: 30, effective_at: T10 }];
    expect(dueTransitions([r], settings, T10 + 15 * MIN)).toEqual([]);
    expect(dueTransitions([r], settings, T10 + 30 * MIN)).toEqual([
      { reservationId: 1, to: 'no_show', at: T10 + 30 * MIN },
    ]);
  });
});

describe('RSV-21 変化は起きる時刻の順に、同じ時刻なら予約の番号の順に並ぶ', () => {
  test('RSV-21 起きる時刻の順、同じ時刻なら番号の順', () => {
    const reservations = [
      reservation(4, 'in_use', T10 - 60 * MIN, T10 + 15 * MIN), // 10:15 終了
      reservation(3, 'reserved', T10, T10 + 60 * MIN), // 10:15 無断不使用
      reservation(2, 'in_use', T10 - 60 * MIN, T10 + 5 * MIN), // 10:05 終了
      reservation(1, 'reserved', T10 + 10 * MIN, T10 + 60 * MIN), // 10:25 無断不使用
    ];
    expect(dueTransitions(reservations, initial, T10 + 30 * MIN)).toEqual([
      { reservationId: 2, to: 'finished', at: T10 + 5 * MIN },
      { reservationId: 3, to: 'no_show', at: T10 + 15 * MIN },
      { reservationId: 4, to: 'finished', at: T10 + 15 * MIN },
      { reservationId: 1, to: 'no_show', at: T10 + 25 * MIN },
    ]);
  });

  test('RSV-21 時間帯を確保していない状態の予約には何も起きない', () => {
    const reservations = ['cancelled', 'no_show', 'admin_cancelled', 'finished', 'admin_finished'].map((status, i) =>
      reservation(i + 1, status, T10, T10 + 60 * MIN),
    );
    expect(dueTransitions(reservations, initial, T10 + 120 * MIN)).toEqual([]);
  });

  test('RSV-21 引数の一覧を書き換えない', () => {
    const reservations = [reservation(2, 'reserved', T10, T10 + 60 * MIN), reservation(1, 'reserved', T10, T10 + 60 * MIN)];
    const copy = structuredClone(reservations);
    dueTransitions(reservations, initial, T10 + 60 * MIN);
    expect(reservations).toEqual(copy);
  });
});
