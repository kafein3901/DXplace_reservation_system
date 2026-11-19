// Cookie の読み取りと Set-Cookie の値（docs/design/detailed/rules.md 6.3、docs/design/basic/auth.md 3。ADM-2）

export const ADMIN_COOKIE = '__Host-dxp_admin';

// 400日（auth.md 3）。使うたびに同じ値で送り直して延ばす
const MAX_AGE = 34_560_000;
const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';

// Cookie ヘッダから名前の値を取り出す。ヘッダがない、名前がないときは null
export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// 証明の値の形（32バイトを base64url にした43文字）。形が違う値はハッシュを求めず、Cookie がないものとする
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isTokenFormat(s) {
  return typeof s === 'string' && TOKEN_PATTERN.test(s);
}

export function adminCookie(value) {
  return `${ADMIN_COOKIE}=${value}; Max-Age=${MAX_AGE}; ${ATTRIBUTES}`;
}

// 認証を解いた端末の Cookie を消す
export function clearAdminCookie() {
  return `${ADMIN_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
}
