// 試行の上限（rules.md 6.3）
import { describe, expect, test } from 'vitest';
import {
  checkAdminLogin,
  checkAdminSession,
  checkAttemptLimit,
  checkSharedInfo,
  checkUserSession,
} from '../../src/rules/auth.js';

describe('SEC-3 試行の上限（checkAttemptLimit）', () => {
  test('SEC-3 行がなければ受け付ける', () => {
    expect(checkAttemptLimit(null, 5)).toEqual({ ok: true });
  });

  test('SEC-3 失敗が上限 − 1 なら受け付ける', () => {
    expect(checkAttemptLimit({ failures: 4 }, 5)).toEqual({ ok: true });
  });

  test('SEC-3 失敗が上限ちょうどなら LIMIT_ATTEMPTS', () => {
    expect(checkAttemptLimit({ failures: 5 }, 5)).toEqual({ ok: false, code: 'LIMIT_ATTEMPTS' });
  });
});

const ADMIN = { id: 1, deleted_at: null, password_version: 2 };

describe('ADM-2 管理者の認証（checkAdminLogin）', () => {
  test('ADM-2 削除していない管理者でパスワードが等しければ受け付ける', () => {
    expect(checkAdminLogin(ADMIN, true)).toEqual({ ok: true });
  });

  test('ADM-2 管理者がいなければ AUTH_ADMIN_FAILED（unknown_id）', () => {
    expect(checkAdminLogin(null, false)).toEqual({ ok: false, code: 'AUTH_ADMIN_FAILED', failure: 'unknown_id' });
  });

  test('ADM-2 削除した管理者はパスワードが等しくても AUTH_ADMIN_FAILED（unknown_id）', () => {
    expect(checkAdminLogin({ ...ADMIN, deleted_at: 5 }, true)).toEqual({
      ok: false,
      code: 'AUTH_ADMIN_FAILED',
      failure: 'unknown_id',
    });
  });

  test('ADM-2 パスワードが違えば AUTH_ADMIN_FAILED（wrong_password）', () => {
    expect(checkAdminLogin(ADMIN, false)).toEqual({ ok: false, code: 'AUTH_ADMIN_FAILED', failure: 'wrong_password' });
  });
});

describe('ADM-2 管理者の証明（checkAdminSession）', () => {
  const SESSION = { id: 1, admin_id: 1, password_version: 2, ended_at: null };

  test('ADM-2 解いていない・削除されていない・版が同じなら受け付ける', () => {
    expect(checkAdminSession(SESSION, ADMIN)).toEqual({ ok: true });
  });

  test('ADM-2 証明の行がなければ AUTH_REQUIRED', () => {
    expect(checkAdminSession(null, null)).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
  });

  test.each([
    ['ended_at がある', { ...SESSION, ended_at: 5 }, ADMIN],
    ['管理者が削除されている', SESSION, { ...ADMIN, deleted_at: 5 }],
    ['版が違う', { ...SESSION, password_version: 1 }, ADMIN],
  ])('ADM-2 %s なら AUTH_REVOKED', (_, session, admin) => {
    expect(checkAdminSession(session, admin)).toEqual({ ok: false, code: 'AUTH_REVOKED' });
  });

  test('ADM-2 証明の行があるのに管理者が null なら例外（バグ）', () => {
    expect(() => checkAdminSession(SESSION, null)).toThrow();
  });
});

describe('USR-2 利用の開始（checkSharedInfo）', () => {
  const CURRENT = { id: 3, hash: new Uint8Array(32) };

  test('USR-2 現在の行があり、値が一致すれば受け付ける', () => {
    expect(checkSharedInfo(CURRENT, true)).toEqual({ ok: true });
  });

  test('USR-2 未設定なら AUTH_SHARED_INFO_UNSET で、failure を付けない（数えない）', () => {
    expect(checkSharedInfo(null, false)).toEqual({ ok: false, code: 'AUTH_SHARED_INFO_UNSET' });
  });

  test('USR-2 値が一致しなければ AUTH_SHARED_INFO_WRONG（failure: wrong）', () => {
    expect(checkSharedInfo(CURRENT, false)).toEqual({ ok: false, code: 'AUTH_SHARED_INFO_WRONG', failure: 'wrong' });
  });
});

describe('ADM-3 利用者の証明（checkUserSession）', () => {
  const SESSION = { id: 1, shared_info_id: 3 };

  test('ADM-3 始めた版が現在の版と同じなら受け付ける', () => {
    expect(checkUserSession(SESSION, 3)).toEqual({ ok: true });
  });

  test('USR-2 証明の行がなければ AUTH_REQUIRED', () => {
    expect(checkUserSession(null, 3)).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(checkUserSession(null, null)).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
  });

  test('ADM-3 始めた版が現在の版より小さければ AUTH_REVOKED', () => {
    expect(checkUserSession(SESSION, 4)).toEqual({ ok: false, code: 'AUTH_REVOKED' });
  });

  test('ADM-3 証明の行があるのに現在の版が null なら例外（バグ）', () => {
    expect(() => checkUserSession(SESSION, null)).toThrow();
  });
});
