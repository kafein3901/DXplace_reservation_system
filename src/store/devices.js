// 機器の表（docs/design/detailed/schema.md 2.2。MNG-1, MNG-2）
// 行は消さない。削除は deleted_at を書くだけで、名前は削除の時点のまま残す（LOG-2）

const COLUMNS = 'id, name, created_at, deleted_at';

// 削除していない機器を番号の順（作った順）に
export function listCurrentDevices(sql) {
  return sql.exec(`SELECT id, name FROM devices WHERE deleted_at IS NULL ORDER BY id`).toArray();
}

// 番号で引く。削除した行も含む。なければ null
export function findDevice(sql, id) {
  return sql.exec(`SELECT ${COLUMNS} FROM devices WHERE id = ?`, id).toArray()[0] ?? null;
}

// 削除していない機器から、名前が完全に一致する行を引く。なければ null。
// name は前後の空白を除いた値。全角・半角、大文字・小文字はそろえない（rules.md 6.7）
export function findCurrentDeviceByName(sql, name) {
  return sql.exec(`SELECT ${COLUMNS} FROM devices WHERE deleted_at IS NULL AND name = ?`, name).toArray()[0] ?? null;
}

// 1行足し、足した行を返す
export function insertDevice(sql, { name, createdAt }) {
  return sql
    .exec(`INSERT INTO devices (name, created_at, deleted_at) VALUES (?, ?, NULL) RETURNING ${COLUMNS}`, name, createdAt)
    .one();
}

// 名前を上書きする。前の名前は出来事の記録に残す（MNG-1）
export function updateDeviceName(sql, id, name) {
  sql.exec('UPDATE devices SET name = ? WHERE id = ?', name, id);
}

// 削除した時刻を書く（秒を切り捨てない。TIM-5）
export function markDeviceDeleted(sql, id, deletedAt) {
  sql.exec('UPDATE devices SET deleted_at = ? WHERE id = ?', deletedAt, id);
}
