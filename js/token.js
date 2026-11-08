// 入口トークンと Cookie（要件定義 2章「入口トークンとCookie」）
const COOKIE_NAME = "dx_token";
const MAX_AGE = 400 * 24 * 60 * 60; // 約400日（ブラウザの上限付近）

// URL のフラグメント（#t=...）にトークンがあれば Cookie に保存し、アドレスバーから消す
export function captureEntryToken() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("t");
  if (!token) return false;

  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${MAX_AGE}; Path=${cookiePath()}; SameSite=Lax${secure}`;
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

// Cookie はこのページのあるディレクトリに限る
// （GitHub Pages のプロジェクトサイトでは、同じドメインの他のリポジトリに送らないため）
function cookiePath() {
  return location.pathname.replace(/[^/]*$/, "") || "/";
}

export function getToken() {
  const hit = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE_NAME.length + 1)) : null;
}
