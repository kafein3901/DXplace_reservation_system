// ハッシュとバイト列の比べ方（docs/design/detailed/rules.md 6.3、docs/design/basic/auth.md 4。SEC-4）

// 管理者のパスワードの PBKDF2 の反復回数（design-values.md。workerd の上限）
export const PBKDF2_ITERATIONS = 100_000;

const encoder = new TextEncoder();

// 文字列の UTF-8 のバイト列の SHA-256（32バイト）
export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

// 同じ長さのバイト列を、比べる時間から値がわからないように比べる。長さが違えば偽
export function equalBytes(a, b) {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// 新しいソルト（ランダムな16バイト）。同期の関数で、判定が通った後に作る（api.md 3.3 の 2）
export function newSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// PBKDF2-HMAC-SHA256。入力はパスワードの UTF-8 のバイト列、結果は32バイト
export async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}
