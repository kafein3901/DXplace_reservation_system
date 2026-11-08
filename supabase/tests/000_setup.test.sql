-- pgTAP が動くことを確かめる疎通テスト
begin;

create extension if not exists pgtap with schema extensions;

select plan(3);

select has_extension('pgtap', 'pgTAP 拡張が有効になっている');

-- 要件定義 8章: タイムゾーンは Asia/Tokyo、保存は timestamptz
select isa_ok(now(), 'timestamp with time zone', 'now() は timestamptz を返す');

select ok(
  (now() at time zone 'Asia/Tokyo') is not null,
  'Asia/Tokyo のタイムゾーンが使える'
);

select * from finish();
rollback;
