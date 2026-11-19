// 出来事の記録の表（docs/design/detailed/schema.md 2.9。LOG-1〜LOG-5）
// 行を足すだけで、書き換えも削除もしない（LOG-2, LOG-5）

// event：{ at, actor_kind, kind, detail, actor_admin_id?, reservation_id?, device_id?, user_id?, admin_id? }
// detail は kind ごとに決めた形のオブジェクト。JSON の文字列にして書く
export function insertEvent(sql, event) {
  sql.exec(
    `INSERT INTO events
       (at, actor_kind, actor_admin_id, kind, reservation_id, device_id, user_id, admin_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.at,
    event.actor_kind,
    event.actor_admin_id ?? null,
    event.kind,
    event.reservation_id ?? null,
    event.device_id ?? null,
    event.user_id ?? null,
    event.admin_id ?? null,
    JSON.stringify(event.detail),
  );
}
