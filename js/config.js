// 接続先の設定
//
// 本番（GitHub Pages）: 下の production に Supabase の URL と anon キーを書く。
//   anon キーはフロントエンドで公開される前提のキー（要件定義 8章）。service_role キーは絶対に書かない。
// ローカル: scripts/write-local-config.sh が生成する js/config.local.js（コミットしない）を優先する。

const production = {
  supabaseUrl: "",
  anonKey: "",
};

let cached = null;

export async function getConfig() {
  if (cached) return cached;
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (isLocal) {
    try {
      const local = await import("./config.local.js");
      cached = local.default;
      return cached;
    } catch {
      console.warn("js/config.local.js がありません。bash scripts/write-local-config.sh を実行してください。");
    }
  }
  cached = production;
  return cached;
}
