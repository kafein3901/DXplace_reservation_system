// 管理者の作成・パスワードの設定し直し・削除（rules.md 6.1）
import { describe, expect, test } from 'vitest';
import { checkAdminCreate, checkAdminDelete, checkAdminPasswordReset } from '../../src/rules/admins.js';

const active = { id: 1, login_id: 'tanaka', deleted_at: null };
const deleted = { id: 2, login_id: 'suzuki', deleted_at: 1000 };

describe('ADM-2 管理者の作成（checkAdminCreate）', () => {
  test('ADM-2 同じ ID の行がなければ受け付ける', () => {
    expect(checkAdminCreate(null)).toEqual({ ok: true });
  });

  test('ADM-2 同じ ID の行があれば RULE_ADMIN_ID_DUPLICATE', () => {
    expect(checkAdminCreate(active)).toEqual({ ok: false, code: 'RULE_ADMIN_ID_DUPLICATE' });
  });

  test('ADM-2 その行が削除済みでも RULE_ADMIN_ID_DUPLICATE', () => {
    expect(checkAdminCreate(deleted)).toEqual({ ok: false, code: 'RULE_ADMIN_ID_DUPLICATE' });
  });
});

describe('ADM-2 パスワードの設定し直し（checkAdminPasswordReset）', () => {
  test('ADM-2 削除していない管理者で、操作した管理者が別なら受け付ける', () => {
    expect(checkAdminPasswordReset(active, 9)).toEqual({ ok: true });
  });

  test('ADM-2 保守用（actorAdminId が null）なら受け付ける', () => {
    expect(checkAdminPasswordReset(active, null)).toEqual({ ok: true });
  });

  test('ADM-2 いなければ NOT_FOUND_ADMIN', () => {
    expect(checkAdminPasswordReset(null, null)).toEqual({ ok: false, code: 'NOT_FOUND_ADMIN' });
  });

  test('ADM-2 削除済みなら NOT_FOUND_ADMIN', () => {
    expect(checkAdminPasswordReset(deleted, null)).toEqual({ ok: false, code: 'NOT_FOUND_ADMIN' });
  });

  test('ADM-2 自分自身なら RULE_ADMIN_SELF_RESET', () => {
    expect(checkAdminPasswordReset(active, 1)).toEqual({ ok: false, code: 'RULE_ADMIN_SELF_RESET' });
  });

  test('ADM-2 削除済みで自分自身なら NOT_FOUND_ADMIN（段 2 が先）', () => {
    expect(checkAdminPasswordReset(deleted, 2)).toEqual({ ok: false, code: 'NOT_FOUND_ADMIN' });
  });
});

describe('ADM-2 管理者の削除（checkAdminDelete）', () => {
  const other = { id: 3, login_id: 'sato', deleted_at: null };

  test('ADM-2 activeAdmins が2件で対象がその1件なら受け付ける', () => {
    expect(checkAdminDelete(active, [active, other])).toEqual({ ok: true });
  });

  test('ADM-2 いなければ NOT_FOUND_ADMIN', () => {
    expect(checkAdminDelete(null, [active, other])).toEqual({ ok: false, code: 'NOT_FOUND_ADMIN' });
  });

  test('ADM-2 削除済みなら NOT_FOUND_ADMIN', () => {
    expect(checkAdminDelete(deleted, [active, other])).toEqual({ ok: false, code: 'NOT_FOUND_ADMIN' });
  });

  test('ADM-2 activeAdmins が対象の1件だけなら RULE_ADMIN_LAST', () => {
    expect(checkAdminDelete(active, [active])).toEqual({ ok: false, code: 'RULE_ADMIN_LAST' });
  });

  test('ADM-2 削除済みで activeAdmins が1件なら NOT_FOUND_ADMIN（段 2 が先）', () => {
    expect(checkAdminDelete(deleted, [active])).toEqual({ ok: false, code: 'NOT_FOUND_ADMIN' });
  });
});
