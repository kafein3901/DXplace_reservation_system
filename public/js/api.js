// API の呼び方（screens.md 2.1）。例外を投げず、{ ok: true, data } か { ok: false, code } を返す。
// code が null なのは、500・JSON として読めない応答・通信の失敗のとき
export async function callApi(method, path, body) {
  const init = { method };
  if (method !== 'GET') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  try {
    const response = await fetch(path, init);
    const payload = await response.json();
    if (payload.ok === true) return { ok: true, data: payload.data };
    return { ok: false, code: payload.error?.code ?? null };
  } catch {
    return { ok: false, code: null };
  }
}
