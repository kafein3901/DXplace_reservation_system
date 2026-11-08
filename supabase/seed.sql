-- ローカル開発用の初期データ（supabase db reset のときに流れる）
-- ここの値はすべてローカル専用のテスト値。本番では使わない。
--
--   入口URL:   http://<フロントの場所>/#t=local-dev-token
--   管理者:    admin@example.test / dxplace-local-admin

-- 入口トークン
insert into private.entry_tokens (token) values ('local-dev-token');

-- リソース
insert into private.resources (name, memo_md, sort_order) values
  ('3Dプリンタ', '**使い方**は講習を受けてから。', 1),
  ('PC1', '高性能PC。', 2),
  ('PC2', '高性能PC。', 3);

-- 管理者（Supabase Auth のユーザー）
-- サインアップは閉じているので、初期の管理者だけは SQL で作る
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new)
values (
  '00000000-0000-0000-0000-000000000000', 'adadadad-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'admin@example.test',
  extensions.crypt('dxplace-local-admin', extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}', '{}', now(), now(),
  '', '', '', '');

insert into auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values (
  'adadadad-0000-0000-0000-000000000001', 'adadadad-0000-0000-0000-000000000001',
  '{"sub": "adadadad-0000-0000-0000-000000000001", "email": "admin@example.test", "email_verified": true}',
  'email', now(), now(), now());

insert into private.admins (user_id, display_name)
values ('adadadad-0000-0000-0000-000000000001', 'ローカル管理者');
