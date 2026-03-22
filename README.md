# 🏛 遺跡解析ツール v2

レガシーコードを Gemini 2.5 Flash + Claude Haiku で解析・変換するツールです。

## セットアップ手順

### 1. Cloudflare Worker をデプロイ

```bash
npm install -g wrangler
wrangler login
wrangler kv:namespace create LEGACY_KEYS
# 表示されたIDをwrangler.tomlの YOUR_KV_NAMESPACE_ID に貼る

wrangler secret put GEMINI_API_KEY
wrangler secret put ANTHROPIC_API_KEY

wrangler deploy
```

### 2. index.html の WORKER_URL を更新

```javascript
// index.html 内のこの行を変更
const WORKER_URL = "https://legacy-analyzer.YOUR-SUBDOMAIN.workers.dev";
```

### 3. GitHub Pages で公開

```bash
git init
git add .
git commit -m "🏛 遺跡解析ツール v2 初回公開"
git branch -M main
git remote add origin https://github.com/furitsukatsuma/legacy-analyzer.git
git push -u origin main
```
GitHubリポジトリの Settings → Pages → Source: main / root で有効化。

### 4. 購入者へのAPIキー発行（手動）

```bash
# キーを発行する（Cloudflare KVに登録）
wrangler kv:key put --namespace-id=YOUR_ID "ft-key-購入者名123" '{"active":true,"plan":"basic"}'
```

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `index.html` | 購入者が使うUI（GitHub Pagesで公開） |
| `worker.js` | APIキー検証 + Gemini + Claude（Cloudflare Worker） |
| `wrangler.toml` | Workerの設定ファイル |
