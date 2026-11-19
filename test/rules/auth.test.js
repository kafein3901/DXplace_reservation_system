// 試行の上限（rules.md 6.3）
import { describe, expect, test } from 'vitest';
import { checkAttemptLimit } from '../../src/rules/auth.js';

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
