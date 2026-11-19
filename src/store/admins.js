// 管理者の表（docs/design/detailed/schema.md 2.5。ADM-2）
// 行は消さない。削除は deleted_at を入れる形（LOG-2）

const COLUMNS = `id, login_id, display_name, password_hash, password_salt, password_iterations,
  password_version, created_at, deleted_at`;

// そろえた後の ID で引く。削除した行も含む。なければ null
export function findAdminByLoginId(sql, loginId) {
  return sql.exec(`SELECT ${COLUMNS} FROM admins WHERE login_id = ?`, loginId).toArray()[0] ?? null;
}

// 番号で引く。削除した行も含む。なければ null
export function findAdminById(sql, id) {
  return sql.exec(`SELECT ${COLUMNS} FROM admins WHERE id = ?`, id).toArray()[0] ?? null;
}

// 1行足し、番号を返す。版は 1 から
export function insertAdmin(sql, { loginId, displayName, passwordHash, passwordSalt, passwordIterations, createdAt }) {
  return sql
    .exec(
      `INSERT INTO admins
         (login_id, display_name, password_hash, password_salt, password_iterations, password_version, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       RETURNING id`,
      loginId,
      displayName,
      passwordHash,
      passwordSalt,
      passwordIterations,
      createdAt,
    )
    .one().id;
}

// パスワードを上書きし、版を1増やす。前の版の証明はすべて止まる（auth.md 3）
export function updateAdminPassword(sql, id, { passwordHash, passwordSalt, passwordIterations }) {
  sql.exec(
    `UPDATE admins
     SET password_hash = ?, password_salt = ?, password_iterations = ?, password_version = password_version + 1
     WHERE id = ?`,
    passwordHash,
    passwordSalt,
    passwordIterations,
    id,
  );
}
