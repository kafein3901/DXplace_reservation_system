// 数値の変更（docs/design/detailed/api.md 8.41・8.42。RSV-25, RSV-26, RSV-22, RSV-23, LOG-4）
// 共2・共3・共4（本文を読めたか）は ledger.js が確かめ、期限の延長も ledger.js が付ける（api.md 8.5）。
// 共3 から書き込みの終わりまで await がないので、ほぼ同時の要求も1つずつ処理される（RSV-23）
import { adminEvent } from './admin-event.js';
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { validateSettingValue } from '../lib/validate.js';
import { SETTING_KEYS, currentSettings, decideSettingChange } from '../rules/settings.js';
import { insertEvent } from '../store/events.js';
import { insertSetting, listSettings } from '../store/settings.js';

// GET /api/admin/settings（api.md 8.41）。履歴・有効になった時刻は返さない
export function getSettings({ storage, nowMin }) {
  const sql = storage.sql;
  const values = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    return currentSettings(listSettings(sql), nowMin);
  });
  return ok(values);
}

// POST /api/admin/settings（api.md 8.42）。1回に1つの数値だけを変える
export function changeSetting({ storage, body, auth, now, nowMin }) {
  // 共4：key は画面が固定の値を送るので、誤りは INPUT_BODY。value が数値でないときも INPUT_BODY
  if (typeof body.key !== 'string' || !SETTING_KEYS.includes(body.key) || typeof body.value !== 'number') {
    return refuse('INPUT_BODY');
  }
  const key = body.key;
  // 段 1。断ったら何も書かず、自動の変化も反映しない
  const value = validateSettingValue(key, body.value);
  if (!value.ok) return refuse(value.code);

  const sql = storage.sql;
  const values = storage.transactionSync(() => {
    // 自動の変化が先（RSV-22）。nowMin 以下に起きる変化は前の値で確定する
    applyAutoTransitions(sql, nowMin);
    const decided = decideSettingChange({ settings: listSettings(sql), key, value: value.value, nowMin });
    if (decided.action === 'change') {
      // 変更は nowMin から有効（RSV-26）。確保済みの予約には触れない（RSV-25）
      insertSetting(sql, key, value.value, nowMin);
      insertEvent(
        sql,
        adminEvent(now, auth, {
          kind: 'setting_changed',
          detail: { key, before: decided.before, after: value.value, effective_at: nowMin },
        }),
      );
    }
    return currentSettings(listSettings(sql), nowMin);
  });
  return ok(values);
}
