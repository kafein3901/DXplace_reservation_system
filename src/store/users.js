// 利用者の表（docs/design/detailed/schema.md 2.1。USR-3〜USR-7）
// 行は消さない。名前・期生を置き換えるときは上書きし、前の値は出来事の記録に残す（USR-7, LOG-1）

const COLUMNS = 'id, role, student_id, name, cohort, created_at';

// 識別の組（生徒か教員か、そろえた学籍番号）で引く。なければ null。
// 利用者の入力（api.md 8.15）と、利用者の操作の API（8.16）で使う
export function findUserByIdentity(sql, role, studentId) {
  return (
    sql.exec(`SELECT ${COLUMNS} FROM users WHERE role = ? AND student_id = ?`, role, studentId).toArray()[0] ?? null
  );
}

// 1行足し、足した行を返す
export function insertUser(sql, { role, studentId, name, cohort, createdAt }) {
  return sql
    .exec(
      `INSERT INTO users (role, student_id, name, cohort, created_at) VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
      role,
      studentId,
      name,
      cohort,
      createdAt,
    )
    .one();
}

// 名前と期生を上書きする
export function updateUserProfile(sql, id, { name, cohort }) {
  sql.exec('UPDATE users SET name = ?, cohort = ? WHERE id = ?', name, cohort, id);
}
