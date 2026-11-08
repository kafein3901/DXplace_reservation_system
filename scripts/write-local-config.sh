#!/usr/bin/env bash
# ローカルの Supabase の接続先を js/config.local.js に書き出す（このファイルはコミットしない）
# 使い方: supabase start の後に  bash scripts/write-local-config.sh
set -euo pipefail
cd "$(dirname "$0")/.."

env_out="$(supabase status -o env 2>/dev/null)"
api_url="$(printf '%s\n' "$env_out" | sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
anon_key="$(printf '%s\n' "$env_out" | sed -n 's/^ANON_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"

if [ -z "$api_url" ] || [ -z "$anon_key" ]; then
  echo "supabase status から接続先を読めませんでした。supabase start を実行してください。" >&2
  exit 1
fi

cat > js/config.local.js <<EOF
// scripts/write-local-config.sh が生成したファイル（コミットしない）
export default {
  supabaseUrl: "${api_url}",
  anonKey: "${anon_key}",
};
EOF
echo "js/config.local.js を書き出しました（接続先: ${api_url}）"
