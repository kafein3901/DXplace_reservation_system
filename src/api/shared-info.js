// 共有された情報の設定・変更（docs/design/detailed/api.md 8.9。ADM-3, SEC-3, SEC-4, LOG-4）
import { applyAutoTransitions } from './auto.js';
import { ok } from './respond.js';
import { newToken } from '../lib/hash.js';
import { insertSharedInfo } from '../store/shared-infos.js';
import { insertEvent } from '../store/events.js';

// API ごとの準備（api.md 8.9 の 1）。成功するかどうかにかかわらず、新しい値とその SHA-256 をここで作る
export async function prepareSharedInfo() {
  return { token: await newToken() };
}

// POST /api/admin/shared-info（api.md 8.9）。判定はなく、共3 を通れば必ず受け付ける。
// 予約・管理者の証明・利用を始めた証明には触れない（ADM-3）。値は応答の本文にだけ入れ、記録には版だけを書く（SEC-4）
export function setSharedInfo({ storage, auth, now, nowMin, routePrepared }) {
  const sql = storage.sql;
  const { token } = routePrepared;
  storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    const version = insertSharedInfo(sql, { hash: token.hash, createdAt: now });
    insertEvent(sql, {
      at: now,
      actor_kind: 'admin',
      actor_admin_id: auth.admin.id,
      kind: 'shared_info_set',
      detail: { version },
    });
  });
  return ok({ value: token.value });
}
