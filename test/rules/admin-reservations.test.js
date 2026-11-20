// 予約の管理（rules.md 6.16。MNG-3, TIM-4, TIM-7）。時刻は nowMin = 10:00
import { describe, expect, test } from 'vitest';
import { checkAdminCancel, checkAdminFinish, checkDeviceReservations } from '../../src/rules/admin-reservations.js';

const T = (hour, minute = 0) => Date.UTC(2026, 10, 20, hour - 9, minute); // 2026-11-20 の日本時間
const NOW = T(10);
const PAST_STATES = ['cancelled', 'no_show', 'finished', 'admin_cancelled', 'admin_finished'];
const DEVICE = { id: 1, name: '3Dプリンタ1', created_at: 0, deleted_at: null };

let nextId = 100;
const r = ({ start = T(10), end = T(11), status = 'reserved', walkIn = 0, id = nextId++, userId = 1 } = {}) => ({
  id,
  device_id: 1,
  user_id: userId,
  start_at: start,
  end_at: end,
  status,
  walk_in: walkIn,
  role: 'student',
  student_id: '12345678',
  name: '山田',
});

describe('MNG-3 checkDeviceReservations', () => {
  test('MNG-3 予約済・利用中（予約なしの利用を含む）を開始時刻の順に返し、異なる利用者のものも合わせて返す', () => {
    const late = r({ start: T(13), end: T(14), userId: 2 });
    const walkIn = r({ start: T(9), end: T(11), status: 'in_use', walkIn: 1 });
    const middle = r({ start: T(11), end: T(12) });
    const result = checkDeviceReservations({ device: DEVICE, deviceActive: [late, walkIn, middle] });
    expect(result).toEqual({ ok: true, reservations: [walkIn, middle, late] });
  });

  test('MNG-3 同じ開始時刻なら番号の順', () => {
    const second = r({ id: 2, start: T(11), end: T(11) });
    const first = r({ id: 1, start: T(11), end: T(12) });
    expect(checkDeviceReservations({ device: DEVICE, deviceActive: [second, first] }).reservations).toEqual([first, second]);
  });

  test('MNG-3 予約がなければ空の配列', () => {
    expect(checkDeviceReservations({ device: DEVICE, deviceActive: [] })).toEqual({ ok: true, reservations: [] });
  });

  test('MNG-3 取消・無断不使用・終了などが混ざっていても落とす', () => {
    const kept = r();
    const others = PAST_STATES.map((status) => r({ status }));
    expect(checkDeviceReservations({ device: DEVICE, deviceActive: [...others, kept] }).reservations).toEqual([kept]);
  });

  test('MNG-3 機器がない・削除した機器は NOT_FOUND_DEVICE', () => {
    expect(checkDeviceReservations({ device: null, deviceActive: [] })).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
    expect(checkDeviceReservations({ device: { ...DEVICE, deleted_at: T(9) }, deviceActive: [] })).toEqual({
      ok: false,
      code: 'NOT_FOUND_DEVICE',
    });
  });
});

describe('MNG-3 checkAdminCancel', () => {
  test('MNG-3 予約済はどの利用者のものでも取り消せる', () => {
    expect(checkAdminCancel({ reservation: r({ userId: 1 }) })).toEqual({ ok: true });
    expect(checkAdminCancel({ reservation: r({ userId: 2 }) })).toEqual({ ok: true });
  });

  test('MNG-3 開始時刻を過ぎた予約済（猶予の中）も取り消せる', () => {
    expect(checkAdminCancel({ reservation: r({ start: T(9, 50) }) })).toEqual({ ok: true });
  });

  test('MNG-3 予約がなければ NOT_FOUND_RESERVATION', () => {
    expect(checkAdminCancel({ reservation: null })).toEqual({ ok: false, code: 'NOT_FOUND_RESERVATION' });
  });

  test.each(['in_use', ...PAST_STATES])('MNG-3 %s は STATE_NOT_RESERVED', (status) => {
    expect(checkAdminCancel({ reservation: r({ status }) })).toEqual({ ok: false, code: 'STATE_NOT_RESERVED' });
  });
});

describe('MNG-3 checkAdminFinish', () => {
  test('MNG-3 TIM-4 利用中 [9:00, 11:00) は終了でき、end は nowMin', () => {
    expect(checkAdminFinish({ reservation: r({ start: T(9), status: 'in_use' }), nowMin: NOW })).toEqual({ ok: true, end: NOW });
  });

  test('MNG-3 予約なしの利用で始めたものも同じ', () => {
    const reservation = r({ start: T(9), status: 'in_use', walkIn: 1 });
    expect(checkAdminFinish({ reservation, nowMin: NOW })).toEqual({ ok: true, end: NOW });
  });

  test('TIM-7 同じ分に始めた利用中 [10:00, 11:00) は end が 10:00（長さ0）', () => {
    expect(checkAdminFinish({ reservation: r({ status: 'in_use' }), nowMin: NOW })).toEqual({ ok: true, end: NOW });
  });

  test('MNG-3 予約がなければ NOT_FOUND_RESERVATION', () => {
    expect(checkAdminFinish({ reservation: null, nowMin: NOW })).toEqual({ ok: false, code: 'NOT_FOUND_RESERVATION' });
  });

  test.each(['reserved', ...PAST_STATES])('MNG-3 %s は STATE_NOT_IN_USE', (status) => {
    expect(checkAdminFinish({ reservation: r({ status }), nowMin: NOW })).toEqual({ ok: false, code: 'STATE_NOT_IN_USE' });
  });
});
