// 機器の追加・名前の変更・削除（rules.md 6.7）
import { describe, expect, test } from 'vitest';
import { checkDeviceActive, checkDeviceCreate, checkDeviceDelete, checkDeviceRename } from '../../src/rules/devices.js';

const pc1 = { id: 1, name: 'PC1', created_at: 0, deleted_at: null };
const pc2 = { id: 2, name: 'PC2', created_at: 0, deleted_at: null };
const deleted = { id: 3, name: '旧PC', created_at: 0, deleted_at: 100 };

const reservation = (id, status) => ({ id, device_id: 1, status });

describe('MNG-1 機器の追加（checkDeviceCreate）', () => {
  test('MNG-1 同じ名前の機器がなければ受け付ける', () => {
    expect(checkDeviceCreate(null)).toEqual({ ok: true });
  });

  test('MNG-1 同じ名前の機器があれば RULE_DEVICE_NAME_DUPLICATE', () => {
    expect(checkDeviceCreate(pc1)).toEqual({ ok: false, code: 'RULE_DEVICE_NAME_DUPLICATE' });
  });
});

describe('MNG-1 機器の名前の変更（checkDeviceRename）', () => {
  test('MNG-1 同じ名前の機器がなく名前が違えば rename', () => {
    expect(checkDeviceRename(pc1, null, 'PC-1')).toEqual({ ok: true, action: 'rename' });
  });

  test('MNG-1 同じ名前の機器が自分自身なら unchanged', () => {
    expect(checkDeviceRename(pc1, pc1, 'PC1')).toEqual({ ok: true, action: 'unchanged' });
  });

  test('MNG-1 大文字と小文字だけ違う名前は rename', () => {
    expect(checkDeviceRename(pc1, null, 'pc1')).toEqual({ ok: true, action: 'rename' });
  });

  test('MNG-1 機器がなければ NOT_FOUND_DEVICE', () => {
    expect(checkDeviceRename(null, null, 'PC-1')).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });

  test('MNG-1 削除した機器は NOT_FOUND_DEVICE', () => {
    expect(checkDeviceRename(deleted, null, 'PC-1')).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });

  test('MNG-1 同じ名前の機器が別の機器なら RULE_DEVICE_NAME_DUPLICATE', () => {
    expect(checkDeviceRename(pc1, pc2, 'PC2')).toEqual({ ok: false, code: 'RULE_DEVICE_NAME_DUPLICATE' });
  });

  test('MNG-1 削除済みで同じ名前の機器も別にあれば NOT_FOUND_DEVICE（段 2 が先）', () => {
    expect(checkDeviceRename(deleted, pc2, 'PC2')).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });
});

describe('MNG-2 機器の削除（checkDeviceDelete）', () => {
  test('MNG-2 予約済・利用中の予約がなければ受け付け、取り消す予約はない', () => {
    expect(checkDeviceDelete(pc1, [])).toEqual({ ok: true, cancel: [] });
  });

  test('MNG-2 予約済だけなら受け付け、その番号を番号の順に返す', () => {
    const active = [reservation(7, 'reserved'), reservation(3, 'reserved')];
    expect(checkDeviceDelete(pc1, active)).toEqual({ ok: true, cancel: [3, 7] });
  });

  test('MNG-1 機器がなければ NOT_FOUND_DEVICE', () => {
    expect(checkDeviceDelete(null, [])).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });

  test('MNG-1 削除した機器は NOT_FOUND_DEVICE', () => {
    expect(checkDeviceDelete(deleted, [])).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });

  test('MNG-2 予約済と利用中が混ざっていれば RULE_DEVICE_IN_USE', () => {
    const active = [reservation(1, 'reserved'), reservation(2, 'in_use')];
    expect(checkDeviceDelete(pc1, active)).toEqual({ ok: false, code: 'RULE_DEVICE_IN_USE' });
  });

  test('MNG-2 削除済みで利用中があっても NOT_FOUND_DEVICE（段 2 が先）', () => {
    expect(checkDeviceDelete(deleted, [reservation(2, 'in_use')])).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });
});

describe('VIW-1 機器があり削除されていないか（checkDeviceActive）', () => {
  test('VIW-1 削除していない機器は受け付ける', () => {
    expect(checkDeviceActive(pc1)).toEqual({ ok: true });
  });

  test('VIW-1 null は NOT_FOUND_DEVICE', () => {
    expect(checkDeviceActive(null)).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });

  test('VIW-1 削除した機器は NOT_FOUND_DEVICE', () => {
    expect(checkDeviceActive(deleted)).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });
});
