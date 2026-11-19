// テストの設定（docs/design/basic/testing-and-deploy.md 1）
// テストは Workers の実行環境の中で動き、台帳（Durable Object）も使える
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
