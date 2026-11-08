// RPC の呼び出しとエラーコードの変換（基本設計 1章「エラーの形式」・5章）
import { getConfig } from "./config.js";

export class ApiError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details ?? {};
  }
}

// PostgREST の RPC を呼ぶ。accessToken を渡すと管理者として呼ぶ
export async function rpc(name, params = {}, accessToken = null) {
  const { supabaseUrl, anonKey } = await getConfig();
  if (!supabaseUrl) throw new ApiError("NOT_CONFIGURED");

  let res;
  try {
    res = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken ?? anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    });
  } catch {
    throw new ApiError("NETWORK");
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (res.ok) return body;

  // 業務エラーは errcode P0001、message にコード、details に JSON
  if (body && body.code === "P0001") {
    let details = {};
    try {
      details = body.details ? JSON.parse(body.details) : {};
    } catch {
      details = {};
    }
    throw new ApiError(body.message, details);
  }
  throw new ApiError("UNKNOWN", { status: res.status, message: body?.message });
}

const FIELD_NAMES = {
  name: "氏名",
  cohort: "期生",
  memo: "メモ",
  start_at: "開始時刻",
  end_at: "終了時刻",
  reason: "理由",
  title: "タイトル",
  importance: "重要度",
  publish_start_at: "公開の開始",
  publish_end_at: "公開の終了",
  display_name: "表示名",
  email: "メールアドレス",
  password: "パスワード",
};

const STATUS_NAMES = {
  reserved: "予約済み",
  in_use: "利用中",
  finished: "終了",
  cancelled: "キャンセル",
  no_show: "無断不参加",
  blocked: "封鎖",
  active: "有効",
  admin: "管理者",
};

export function statusName(status) {
  return STATUS_NAMES[status] ?? status;
}

// エラーを日本語の文にする
export function errorMessage(err, formatTime = (t) => t) {
  if (!(err instanceof ApiError)) return "予期しないエラーが起きました。再読み込みしてください。";
  const d = err.details ?? {};
  switch (err.code) {
    case "INVALID_TOKEN": return "入口URLが更新されました。新しいQRコードから開いてください。";
    case "USER_NOT_FOUND": return "アカウントが見つかりません。";
    case "USER_SUSPENDED": return "このアカウントは利用停止中です。管理者に問い合わせてください。";
    case "IDENTITY_CONFLICT": return "同じ氏名・期生の人がすでに登録されています。";
    case "INVALID_INPUT": return `${FIELD_NAMES[d.field] ?? "入力"}が正しくありません。`;
    case "RESOURCE_NOT_FOUND": return "そのリソースは見つかりません。";
    case "RESOURCE_PAUSED": return "そのリソースは一時停止中です。";
    case "RESERVATION_NOT_FOUND": return "その予約は見つかりません。";
    case "NOT_OWNER": return "自分の予約ではありません。";
    case "INVALID_STATE": return `今の状態（${statusName(d.status)}）ではその操作はできません。`;
    case "OVERLAP": return "他の予約と時間が重なっています。先に入った予約が優先されます。再読み込みして空きを確かめてください。";
    case "LIMIT_EXCEEDED": return `同時に持てる予約は${d.limit ?? 3}件までです。`;
    case "END_EXCEEDS_NEXT": return `次の予約があるので、${formatTime(d.next_start)}までしか使えません。`;
    case "NOT_FREE_NOW": return "今は空いていません。再読み込みしてください。";
    case "CHECKIN_WINDOW_CLOSED": return "開始15分後を過ぎたため、チェックインできません。";
    case "ADVANCE_REQUIRED": return "開始前のため、前倒しするか予約なしで使うかを選んでください。";
    case "PREVIOUS_SLOT_OCCUPIED": return "直前の時間帯が埋まっているため、前倒しできません。";
    case "NAME_CONFLICT": return "同じ名前のリソースがあります。";
    case "ANNOUNCEMENT_NOT_FOUND": return "そのお知らせは見つかりません。";
    case "NOT_ADMIN": return "管理者ではありません。";
    case "EMAIL_EXISTS": return "そのメールアドレスはすでに登録されています。";
    case "NETWORK": return "サーバーに接続できません。通信状態を確かめてください。";
    case "NOT_CONFIGURED": return "接続先が設定されていません（js/config.js）。";
    default: return "エラーが起きました。再読み込みしてください。";
  }
}
