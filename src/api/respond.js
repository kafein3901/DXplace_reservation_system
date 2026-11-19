// 応答の形（docs/design/detailed/api.md 1、error-codes.md 1）

// コードの頭から HTTP の番号を決める。コードごとには変えない
const STATUS_BY_PREFIX = {
  INPUT_: 400,
  AUTH_: 401,
  LIMIT_: 429,
  NOT_FOUND_: 404,
  STATE_: 409,
  RULE_: 409,
};

export function statusForCode(code) {
  for (const [prefix, status] of Object.entries(STATUS_BY_PREFIX)) {
    if (code.startsWith(prefix)) return status;
  }
  throw new Error(`理由のコードの頭が決まりにない：${code}`);
}

// すべての応答に付けるヘッダ。extraHeaders は Set-Cookie などを足すときに使う
function jsonResponse(status, payload, extraHeaders = []) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  for (const [name, value] of extraHeaders) headers.append(name, value);
  return new Response(JSON.stringify(payload), { status, headers });
}

// 成功。作成でも 200 にする
export function ok(data, extraHeaders) {
  return jsonResponse(200, { ok: true, data }, extraHeaders);
}

// 断る。理由のコードは1つだけ返す（RSV-27）
export function refuse(code, extraHeaders) {
  return jsonResponse(statusForCode(code), { ok: false, error: { code } }, extraHeaders);
}

// 想定していない例外。コードを付けない
export function serverError() {
  return jsonResponse(500, { ok: false });
}
