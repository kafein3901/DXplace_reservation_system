// 管理者アカウントの作成（基本設計 4章「Edge Function admin-create-admin」）
//
// 1. 呼び出し元の JWT で admin_whoami を呼び、管理者であることを確かめる
// 2. service_role で Supabase Auth のユーザーを作る
//    （SUPABASE_SERVICE_ROLE_KEY は Supabase が自動で注入する。リポジトリには置かない）
// 3. 呼び出し元の JWT で admin_register_admin を呼び、管理者表に登録する（判定とログは DB 側）
//    失敗したら、作った Auth のユーザーを削除して元に戻す
//
// リクエスト: POST { "email": string, "password": string, "display_name": string }
// 応答:       200 { user_id, display_name, created_at }
//             4xx { error: エラーコード, details?: ... }

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function invalid(field: string): Response {
  return json({ error: "INVALID_INPUT", details: { field } }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "NOT_ADMIN" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 呼び出し元（管理者）の権限で RPC を呼ぶクライアント
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. 管理者であることを確かめる
  const { data: who, error: whoError } = await caller.rpc("admin_whoami");
  if (whoError || !who?.is_admin) {
    return json({ error: "NOT_ADMIN" }, 403);
  }

  // 入力の検査
  let body: { email?: unknown; password?: unknown; display_name?: unknown };
  try {
    body = await req.json();
  } catch {
    return invalid("body");
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return invalid("email");
  if (password.length < 8) return invalid("password");
  if (displayName.length < 1 || displayName.length > 50) return invalid("display_name");

  // 2. Auth のユーザーを作る（service_role はこの処理だけに使う）
  const service = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    const code = createError?.code === "email_exists" ? "EMAIL_EXISTS" : "AUTH_CREATE_FAILED";
    return json({ error: code, details: { message: createError?.message ?? null } }, 400);
  }

  // 3. 管理者表に登録する（呼び出し元の権限で。ログも DB 側に残る）
  const { data: registered, error: registerError } = await caller.rpc("admin_register_admin", {
    p_auth_user_id: created.user.id,
    p_display_name: displayName,
  });
  if (registerError) {
    await service.auth.admin.deleteUser(created.user.id);
    let details: unknown = null;
    try {
      details = registerError.details ? JSON.parse(registerError.details) : null;
    } catch {
      details = registerError.details;
    }
    return json({ error: registerError.message, details }, 400);
  }

  return json(registered);
});
