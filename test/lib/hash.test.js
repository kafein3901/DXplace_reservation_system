// ハッシュとバイト列の比べ方（rules.md 6.3、auth.md 4）
import { describe, expect, test } from 'vitest';
import { PBKDF2_ITERATIONS, equalBytes, newSalt, newToken, pbkdf2, sha256 } from '../../src/lib/hash.js';
import { isTokenFormat } from '../../src/lib/cookie.js';

describe('SEC-4 ハッシュ', () => {
  test('SEC-4 sha256 は32バイトで、同じ入力なら同じ値', async () => {
    const a = await sha256('abc');
    expect(a.byteLength).toBe(32);
    expect(equalBytes(a, await sha256('abc'))).toBe(true);
    expect(equalBytes(a, await sha256('abd'))).toBe(false);
  });

  test('SEC-4 newSalt は16バイトで、2回呼ぶと違う値', () => {
    const a = newSalt();
    expect(a.byteLength).toBe(16);
    expect(equalBytes(a, newSalt())).toBe(false);
  });

  test('SEC-4 pbkdf2 は32バイトで、同じ入力なら同じ値、ソルトが違えば違う値', async () => {
    const salt = newSalt();
    const a = await pbkdf2('correct-horse-battery', salt, PBKDF2_ITERATIONS);
    expect(a.byteLength).toBe(32);
    expect(equalBytes(a, await pbkdf2('correct-horse-battery', salt, PBKDF2_ITERATIONS))).toBe(true);
    expect(equalBytes(a, await pbkdf2('correct-horse-battery', newSalt(), PBKDF2_ITERATIONS))).toBe(false);
  });

  test('SEC-4 equalBytes は長さが違えば偽', () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('ADM-3 新しい証明（newToken）', () => {
  test('ADM-3 value は43文字で isTokenFormat を通り、hash は value の SHA-256。2回呼ぶと違う値', async () => {
    const a = await newToken();
    expect(a.value).toHaveLength(43);
    expect(isTokenFormat(a.value)).toBe(true);
    expect(a.hash.byteLength).toBe(32);
    expect(equalBytes(a.hash, await sha256(a.value))).toBe(true);
    expect((await newToken()).value).not.toBe(a.value);
  });
});
