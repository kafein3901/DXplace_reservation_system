// 予約の管理のルール（docs/design/detailed/rules.md 6.16。MNG-3, TIM-4, TIM-7）
// 時刻はミリ秒。nowMin は秒を切り捨てた現在時刻。データは自動の変化を反映した後のもの（rules.md 5.3）。
// 管理者はどの利用者の予約も扱えるので、本人のものかは確かめない（MNG-3）
import { checkDeviceActive } from './devices.js';

// 機器ごとの予約の一覧。device：番号で引いた機器の行（削除した行も含む。なければ null）。
// deviceActive：その機器の予約済・利用中の全件（利用者の role・student_id・name を付けたもの）。
// 予約済・利用中を開始時刻の順（同じなら番号の順）に返す。項目は選ばない
export function checkDeviceReservations({ device, deviceActive }) {
  const active = checkDeviceActive(device);
  if (!active.ok) return active;
  const reservations = deviceActive
    .filter((reservation) => reservation.status === 'reserved' || reservation.status === 'in_use')
    .sort((a, b) => a.start_at - b.start_at || a.id - b.id);
  return { ok: true, reservations };
}

// 管理者による取消。猶予の中の予約済は開始時刻を過ぎていても取り消せる。
// 猶予を過ぎた予約は反映した後には無断不使用なので STATE_NOT_RESERVED（RSV-22）
export function checkAdminCancel({ reservation }) {
  if (reservation === null) return { ok: false, code: 'NOT_FOUND_RESERVATION' };
  if (reservation.status !== 'reserved') return { ok: false, code: 'STATE_NOT_RESERVED' };
  return { ok: true };
}

// 管理者による終了。終了時刻は nowMin（MNG-3, TIM-4）。同じ分に始めた利用中なら長さ0になり、それを認める（TIM-7）
export function checkAdminFinish({ reservation, nowMin }) {
  if (reservation === null) return { ok: false, code: 'NOT_FOUND_RESERVATION' };
  if (reservation.status !== 'in_use') return { ok: false, code: 'STATE_NOT_IN_USE' };
  return { ok: true, end: nowMin };
}
