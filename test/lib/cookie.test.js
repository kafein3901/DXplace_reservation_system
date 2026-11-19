// Cookie の読み取りと Set-Cookie の値（rules.md 6.3、auth.md 3）
import { describe, expect, test } from 'vitest';
import { adminCookie, clearAdminCookie, isTokenFormat, readCookie } from '../../src/lib/cookie.js';

const TOKEN = 'A'.repeat(20) + 'z09-_' + 'b'.repeat(18); // 43文字

describe('ADM-2 readCookie', () => {
  test('ADM-2 ほかの Cookie と並んでいても名前の値を取り出せる', () => {
    expect(readCookie(`a=1; __Host-dxp_admin=${TOKEN}; b=2`, '__Host-dxp_admin')).toBe(TOKEN);
    expect(readCookie(`__Host-dxp_admin=${TOKEN}`, '__Host-dxp_admin')).toBe(TOKEN);
  });

  test('ADM-2 ヘッダがない、名前がないときは null', () => {
    expect(readCookie(null, '__Host-dxp_admin')).toBeNull();
    expect(readCookie('a=1; x__Host-dxp_admin=2', '__Host-dxp_admin')).toBeNull();
  });
});

describe('ADM-2 isTokenFormat', () => {
  test('ADM-2 43文字の base64url を通す', () => {
    expect(TOKEN).toHaveLength(43);
    expect(isTokenFormat(TOKEN)).toBe(true);
  });

  test.each([
    ['42文字', TOKEN.slice(1)],
    ['44文字', `${TOKEN}a`],
    ['= を含む', `${TOKEN.slice(1)}=`],
    ['+ を含む', `${TOKEN.slice(1)}+`],
    ['null', null],
  ])('ADM-2 %s は通さない', (_, value) => {
    expect(isTokenFormat(value)).toBe(false);
  });
});

describe('ADM-2 Set-Cookie の値', () => {
  test('ADM-2 adminCookie は __Host- の名前と属性を付ける（400日）', () => {
    expect(adminCookie(TOKEN)).toBe(
      `__Host-dxp_admin=${TOKEN}; Max-Age=34560000; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
  });

  test('ADM-2 clearAdminCookie は値を空にして Max-Age=0', () => {
    expect(clearAdminCookie()).toBe('__Host-dxp_admin=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict');
  });
});
