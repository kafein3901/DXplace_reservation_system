// 機器の追加・名前の変更・削除（docs/design/detailed/rules.md 6.7。MNG-1, MNG-2）
//
// device：store が番号で引いた devices の行（削除した行も含む。なければ null）
// sameName：store が、削除していない機器から、前後の空白を除いた名前と完全に一致するものを引いた行（なければ null）。
//   全角と半角、大文字と小文字はそろえずに比べる

// 段 2：機器があり、削除されていないか（rules.md 6.9）。予約状況・確保・予約なしの利用と、名前の変更・削除で使う
export function checkDeviceActive(device) {
  if (device === null || device.deleted_at !== null) return { ok: false, code: 'NOT_FOUND_DEVICE' };
  return { ok: true };
}

// 追加。同じ名前の機器があれば断る（MNG-1「名前は重複しない」）
export function checkDeviceCreate(sameName) {
  if (sameName !== null) return { ok: false, code: 'RULE_DEVICE_NAME_DUPLICATE' };
  return { ok: true };
}

// 名前の変更。name は検証を通った後の新しい名前。
// 自分と同じ名前への変更は重複にせず unchanged にする
export function checkDeviceRename(device, sameName, name) {
  const active = checkDeviceActive(device);
  if (!active.ok) return active;
  if (sameName !== null && sameName.id !== device.id) return { ok: false, code: 'RULE_DEVICE_NAME_DUPLICATE' };
  return { ok: true, action: device.name === name ? 'unchanged' : 'rename' };
}

// 削除。active：その機器の予約済・利用中の予約の全件（自動の変化を反映した後）。
// 利用中が1件でもあれば断り（MNG-2）、受け付けるなら予約済をすべて取り消す（番号の順）
export function checkDeviceDelete(device, active) {
  const found = checkDeviceActive(device);
  if (!found.ok) return found;
  if (active.some((reservation) => reservation.status === 'in_use')) return { ok: false, code: 'RULE_DEVICE_IN_USE' };
  const cancel = active
    .filter((reservation) => reservation.status === 'reserved')
    .map((reservation) => reservation.id)
    .sort((a, b) => a - b);
  return { ok: true, cancel };
}
