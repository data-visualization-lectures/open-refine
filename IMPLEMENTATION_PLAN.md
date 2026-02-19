# OpenRefine Web デプロイ実装計画

## 参照レポジトリ

https://github.com/OpenRefine/OpenRefine.git

---

## Context（背景・目的）

- OpenRefine をサブスクリプション SaaS として提供する
- Tabula と同様の構成（Vercel + Railway）でデプロイ
- Supabase 認証・プロジェクト管理基盤は構築済み
- **Phase 1**：プロジェクト保存なし（エフェメラル）で動くものを先に出す
- **Phase 2**（後日）：Supabase Storage と連携してプロジェクト永続化

---

## 現在の反映状況（2026-02-19）

- フロントエンドは Vercel、OpenRefine 本体は Railway の分離構成で運用中。
- カスタムドメイン `https://open-refine.dataviz.jp/` はリダイレクトではなく、そのままエディタ UI（iframe）を表示。
- OpenRefine 互換 UI は `/openrefine/*` で配信し、OpenRefine が絶対パスで呼ぶ `/command/*` も Vercel 側で Railway へプロキシ。
- Railway 側は `OPENREFINE_SHARED_SECRET` ヘッダー必須。ヘッダーなし直アクセスは 403。
- 開発確認用に、`/api/refine/upload` のみ匿名作成モード（`ALLOW_ANON_PROJECT_CREATE=true`）をサポート。
- 初期言語は日本語を既定にするため、`load-language` 呼び出し時に `lang=ja` を補完する実装を追加済み。

---

## アーキテクチャ概要

```
Browser
  → Vercel (Next.js + Supabase Auth + OpenRefine UI proxy)
      → Next.js Route Handlers（認証済みプロキシ）
          → Railway (OpenRefine コンテナ)
```

**OpenRefine の特性（Tabula との違い）**
- Java 製・Jetty 内蔵サーバー（ポート 3333 固定）
- 公式 Docker サポートなし → プリビルドリリース(.tar.gz)を使う
- ステートフル（プロジェクトをディスクに保存）
- マルチユーザー非対応 → プロキシ層でユーザー分離

---

## ディレクトリ構成

```
openrefine/
├── backend/
│   ├── Dockerfile
│   ├── nginx.conf          # PORT ブリッジ用テンプレート
│   ├── entrypoint.sh       # Nginx + OpenRefine 起動スクリプト
│   └── healthcheck.sh
└── frontend/
    ├── package.json
    ├── next.config.mjs
    ├── vercel.json          # Cron 設定（cleanup-orphans）
    ├── .env.example
    └── src/
        ├── app/
        │   ├── layout.tsx
        │   ├── page.tsx                      # / で editor を表示（非リダイレクト）
        │   ├── app/
        │   │   ├── layout.tsx         # Auth guard
        │   │   └── editor/
        │   │       └── page.tsx       # メインエディタ
        │   ├── command/
        │   │   └── [[...path]]/
        │   │       └── route.ts       # /command/* プロキシ（絶対パス対策）
        │   ├── api/
        │   │   ├── refine/
        │   │   │   ├── [...path]/
        │   │   │   │   └── route.ts   # 認証プロキシ（最重要）
        │   │   │   ├── upload/
        │   │   │   │   └── route.ts   # ファイルアップロード
        │   │   │   └── cleanup/
        │   │   │       └── route.ts   # Beacon API 用
        │   │   └── cron/
        │   │       └── cleanup-orphans/
        │   │           └── route.ts
        │   └── openrefine/
        │       └── [[...path]]/
        │           └── route.ts       # 元OpenRefine UIプロキシ
        ├── components/
        │   ├── DataTable.tsx
        │   ├── TransformPanel.tsx
        │   └── ExportMenu.tsx
        └── lib/
            ├── auth.ts              # Supabase user 解決
            ├── proxy.ts             # OpenRefine proxy共通処理
            ├── project-registry.ts  # projectId 所有者管理（in-memory）
            ├── refine-client.ts     # ブラウザ側 API クライアント
            └── project-id.ts        # ユーザースコープ命名
```

---

## ホスティング分離の意図

- **Vercel** は Next.js UI・Supabase 認証・cron・multipart アップロード処理を担い、公開鍵や UI を直接触る場所として使う。
- **Railway** は OpenRefine コンテナと Nginx ポートブリッジに集中させ、Next.js を同じコンテナに押し込むと認証ガード・ファイルハンドリング・cron を自前で再実装する必要が出て、セキュリティ境界も曖昧になるので分離を維持。

## Phase 1: Railway / OpenRefine バックエンド

### 重要技術決定：Nginx PORT ブリッジ

Railway は動的に `$PORT` を注入するが OpenRefine は 3333 固定。
**解決策**: コンテナ内で Nginx を動かし `$PORT → 3333` にリバースプロキシ。

### backend/Dockerfile

```dockerfile
FROM eclipse-temurin:17-jre-jammy

RUN apt-get update && apt-get install -y \
    nginx wget curl gettext-base \
    && rm -rf /var/lib/apt/lists/*

ARG OPENREFINE_VERSION=3.9.5
ENV OPENREFINE_VERSION=${OPENREFINE_VERSION}

RUN wget -q "https://github.com/OpenRefine/OpenRefine/releases/download/${OPENREFINE_VERSION}/openrefine-linux-${OPENREFINE_VERSION}.tar.gz" \
    -O /tmp/openrefine.tar.gz \
    && mkdir -p /opt/openrefine \
    && tar -xzf /tmp/openrefine.tar.gz --strip-components=1 -C /opt/openrefine \
    && rm /tmp/openrefine.tar.gz \
    && chmod +x /opt/openrefine/refine

RUN mkdir -p /data && chmod 777 /data

COPY nginx.conf /etc/nginx/nginx.conf.template
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.sh /healthcheck.sh
RUN chmod +x /entrypoint.sh /healthcheck.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD /healthcheck.sh

ENTRYPOINT ["/entrypoint.sh"]
```

### backend/nginx.conf（テンプレート）

```nginx
events { worker_connections 1024; }
http {
  server {
    listen ${PORT};
    client_max_body_size 500M;
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    location / {
      if ($http_x_openrefine_proxy_secret != "${OPENREFINE_SHARED_SECRET}") {
        return 403;
      }
      proxy_pass http://127.0.0.1:3333;
      proxy_http_version 1.1;
      proxy_set_header Host localhost;
      proxy_set_header X-OpenRefine-Proxy-Secret "";
      proxy_pass_request_headers on;
    }
  }
}
```

### backend/entrypoint.sh

```bash
#!/bin/bash
set -euo pipefail

if [ -z "${PORT:-}" ]; then
  echo "ERROR: PORT not set"
  exit 1
fi

if [ -z "${OPENREFINE_SHARED_SECRET:-}" ]; then
  echo "ERROR: OPENREFINE_SHARED_SECRET not set"
  exit 1
fi

envsubst '${PORT} ${OPENREFINE_SHARED_SECRET}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
nginx -g "daemon off;" &
NGINX_PID=$!

/opt/openrefine/refine \
  -i 127.0.0.1 -p 3333 \
  -m "${REFINE_MEMORY:-1400M}" \
  -x refine.headless=true -d /data &
REFINE_PID=$!

for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3333/ > /dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: OpenRefine failed to start"
    exit 1
  fi
  sleep 1
done
echo "OpenRefine ready"

wait -n "$NGINX_PID" "$REFINE_PID"
```

### backend/healthcheck.sh

```bash
#!/bin/bash
curl -sf "http://127.0.0.1:${PORT}/" > /dev/null 2>&1
```

### Railway 設定

Railway は `backend/` ディレクトリの Dockerfile を自動検出。`railway.toml` 不要。

**環境変数（Railway ダッシュボードで設定）:**

| 変数 | 値 | 備考 |
|---|---|---|
| `PORT` | 自動注入 | 手動設定不要 |
| `REFINE_MEMORY` | `1400M` | Railway プランに応じて調整 |
| `OPENREFINE_SHARED_SECRET` | `openssl rand -hex 32` | Vercel プロキシからのアクセスのみ許可 |

---

## Phase 2: Vercel / Next.js フロントエンド

### 認証プロキシ（セキュリティの核心）

`src/app/api/refine/[...path]/route.ts`

1. Supabase JWT でユーザー認証
2. プロジェクト操作コマンドは所有権チェック
3. 認証済みリクエストを Railway に転送

OpenRefine の `project` パラメータは numericId なので、`upload` 時にサーバー側で `projectName={userId}_{timestamp}_{random}` を生成し、返ってきた `projectId` を `project-registry`（in-memory）に `projectId→ownerId` として登録する。`get-rows` などの対象コマンドは毎回この所有者チェックを通し、未一致は 403 を返す。

所有権チェック対象コマンド:
`get-rows`, `get-columns`, `get-project-metadata`, `apply-operations`,
`export-rows`, `delete-project`, `get-models`, `compute-facets`

未列挙のコマンドは `assertAllowedCommand()` のホワイトリストで拒否する。

### Railway 直アクセス制御

Railway は Nginx で `x-openrefine-proxy-secret` を検証し、`OPENREFINE_SHARED_SECRET` 不一致時は 403 を返す。これにより Railway URL を直接叩いても Vercel プロキシを経由しないリクエストは拒否される。

### 元 OpenRefine UI の公開（プロキシ経由）

`/openrefine/*` を Next.js Route Handler で Railway に透過し、`x-openrefine-proxy-secret` をサーバー側で付与して元 UI（`wirings.js` / `index-bundle.js` / `styles/*` など）をそのまま配信する。Railway 直リンクは使わず、ブラウザからは常に Vercel 経由でアクセスする。

OpenRefine 側の一部機能は絶対パスで `/command/*` を呼ぶため、`src/app/command/[[...path]]/route.ts` でも同様に Railway へプロキシする。これを入れないと `/command/core/get-version` が 404 になり、拡張機能画面で JSON パースエラーが発生する。

`load-language` の POST は `lang` 未指定だと英語フォールバックになるケースがあるため、`OPENREFINE_DEFAULT_UI_LANG`（未設定時は `OPENREFINE_DEFAULT_ACCEPT_LANGUAGE` から推定、最終既定 `ja`）を使って `lang` を補完する。

開発中に Supabase 接続前で UI を確認したい場合のみ `ALLOW_ANON_OPENREFINE_UI=true` を使い、`/openrefine/*` への未認証アクセスを許可する。本番では `false` に戻す。

### ファイルアップロード専用ルート

`src/app/api/refine/upload/route.ts`

- `multipart/form-data` をそのまま転送（バイナリ破損防止）
- サーバー側で `projectName={userId}_{timestamp}_{random}` を生成して OpenRefine に指定
- OpenRefine のリダイレクト先 URL から数値 projectId を取得して返す
- リダイレクトに projectId が含まれない場合は metadata/body からフォールバック抽出する

**開発用（Supabase 接続前の確認モード）:**
- 目的は「新規プロジェクト作成だけ」を先に動作確認すること。既存プロジェクトの open/save は対象外。
- `ALLOW_ANON_PROJECT_CREATE=true` のときのみ、`/api/refine/upload` で未認証リクエストを許可する。
- 匿名時の owner は `DEV_FALLBACK_USER_ID` を使って `projectName` を生成し、通常の作成フロー（upload → redirect から projectId 抽出）を通す。
- `/api/refine/upload` 以外の API は引き続き認証必須（匿名モード対象外）。
- 検証は `app/editor` のアップロード UI から行い、`projectId` が返ることを確認する。

### CSRF トークン対応

OpenRefine 3.5+ は POST に `X-Token` ヘッダーが必要。
`ensureCsrfHeader()` で `GET /command/core/get-csrf-token` を都度取得し、`X-Token` を付与して POST/PUT/PATCH/DELETE を転送する。CSRF 取得時の Cookie は許可リストに基づいて転送する。

### frontend/.env.example

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...

# OpenRefine backend on Railway
OPENREFINE_BACKEND_URL=https://openrefine-xxx.up.railway.app

# Required for Vercel -> Railway protection
OPENREFINE_SHARED_SECRET=replace-with-long-random-secret

# Vercel cron auth
CRON_SECRET=replace-with-random-secret

# Optional tuning
MAX_UPLOAD_SIZE_MB=100
MAX_PROJECT_AGE_HOURS=24

# Local-only: allow project creation without Supabase token on /api/refine/upload
ALLOW_ANON_PROJECT_CREATE=false
DEV_FALLBACK_USER_ID=local-dev-user

# Local-only: allow browsing built-in OpenRefine UI without Supabase token on /openrefine/*
ALLOW_ANON_OPENREFINE_UI=false

# Default UI locale for proxied OpenRefine pages
OPENREFINE_DEFAULT_ACCEPT_LANGUAGE=ja-JP,ja;q=0.9,en;q=0.7
# OPENREFINE_DEFAULT_UI_LANG=ja
```

### Vercel 環境変数

| 変数 | 設定 | 内容 |
|---|---|---|
| `OPENREFINE_BACKEND_URL` | サーバー専用（NEXT_PUBLIC_ 不要） | Railway URL |
| `OPENREFINE_SHARED_SECRET` | サーバー専用 | Railway 側と一致させる共有シークレット |
| `NEXT_PUBLIC_SUPABASE_URL` | 既存 | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 既存 | |
| `CRON_SECRET` | `openssl rand -hex 32` | Cron 認証 |
| `MAX_UPLOAD_SIZE_MB` | `100` | |
| `MAX_PROJECT_AGE_HOURS` | `24` | |
| `ALLOW_ANON_PROJECT_CREATE` | `false`（本番） | upload ルート限定の匿名作成モード |
| `DEV_FALLBACK_USER_ID` | `local-dev-user`（開発のみ） | 匿名作成時の owner 文字列 |
| `ALLOW_ANON_OPENREFINE_UI` | `false`（本番） | `/openrefine/*` 未認証閲覧許可 |
| `OPENREFINE_DEFAULT_ACCEPT_LANGUAGE` | `ja-JP,ja;q=0.9,en;q=0.7` | OpenRefine UI の既定言語優先度 |
| `OPENREFINE_DEFAULT_UI_LANG` | `ja`（任意） | `load-language` の `lang` 強制指定 |

---

## Phase 3: OpenRefine API 統合

### データフロー（エフェメラルモード）

```
1.  ユーザーが CSV を選択
2.  POST /api/refine/upload
3.  サーバー側で `projectName={userId}_{ts}_{rand}` を生成
4.  Railway: POST /command/core/create-project-from-upload?projectName=...
5.  OpenRefine がプロジェクト作成 → /project?project={numericId} にリダイレクト
6.  numericId を抽出して返却（失敗時は metadata/body からフォールバック）
7.  ブラウザが projectId を state に保持
8.  DataTable: GET /api/refine/get-rows?project={numericId}
9.  変換: POST /api/refine/apply-operations?project={numericId}
10. エクスポート: GET /api/refine/export-rows?project={numericId}&format=csv
11. ページ離脱: sendBeacon('/api/refine/cleanup', {projectId}) → DELETE
```

### 孤立プロジェクト定期クリーンアップ

```json
// vercel.json
{
  "crons": [
    { "path": "/api/cron/cleanup-orphans", "schedule": "0 * * * *" }
  ]
}
```

`MAX_PROJECT_AGE_HOURS` を過ぎたプロジェクトを毎時削除。

この cron は `projectId` の作成時に記録した `ownerId`, `createdAt`, `lastAccessAt` を参照し、単に古い順ではなく所有者が存在しない or 一定期間アクセスされていないプロジェクトを優先して削除する想定。これにより想定外の削除や取りこぼしが減り、トラブルの追跡が容易になる。

---

## デプロイ手順

### Step 1: Railway へバックエンドをデプロイ

1. GitHub リポジトリを Railway に接続
2. サービスのルートディレクトリを `backend/` に指定
3. Railway が Dockerfile を自動検出してビルド（初回 5〜10 分）
4. 環境変数 `REFINE_MEMORY=1400M` と `OPENREFINE_SHARED_SECRET=<64文字ランダム文字列>` を設定
5. 生成された URL をメモ（例: `https://openrefine-xxx.up.railway.app`）

### Step 2: Vercel へフロントエンドをデプロイ

1. GitHub リポジトリを Vercel に接続
2. プロジェクトのルートを `frontend/` に指定
3. 環境変数を設定（上記表参照）
4. `OPENREFINE_BACKEND_URL` = Step 1 で取得した Railway URL

### Step 3: 動作確認

```bash
# Railway バックエンド: ヘッダーなしは 403（想定）
curl -i https://openrefine-xxx.up.railway.app/command/core/get-all-project-metadata

# Railway バックエンド: 共有シークレット付きで 200
curl -H "x-openrefine-proxy-secret: <OPENREFINE_SHARED_SECRET>" \
  https://openrefine-xxx.up.railway.app/command/core/get-all-project-metadata

# Vercel API: 未認証アクセスが 401 になることを確認
curl https://your-app.vercel.app/api/refine/get-all-project-metadata

# 匿名作成モード有効時の新規作成テスト（upload のみ）
curl -i -F "project-file=@/absolute/path/to/sample.csv" \
  https://your-app.vercel.app/api/refine/upload
```

---

## 将来の永続化（Phase 2）

OpenRefine プロジェクトを Supabase Storage に保存・復元する。

**保存フロー:**
1. `GET /command/core/export-project` → `.tar.gz` を取得
2. Supabase Storage へアップロード
3. Supabase DB の `projects` テーブルにメタデータ記録

**復元フロー:**
1. Supabase Storage から `.tar.gz` をダウンロード
2. `POST /command/core/import-project` で OpenRefine に読み込み
3. 新しい numericId を取得してセッション開始

**DB スキーマ（後日 migration）:**

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  openrefine_project_name TEXT NOT NULL,
  storage_path TEXT,
  row_count INTEGER,
  source_filename TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their projects" ON projects
  FOR ALL USING (auth.uid() = user_id);
```

> **注意**: Railway の `/data` はリデプロイで消える。
> 永続化には Railway Volume か Supabase Storage 方式を使う（後者を推奨）。

---

## 検証チェックリスト

### バックエンド
- [ ] Railway で OpenRefine が起動する（ヘルスチェック通過）
- [ ] Nginx の PORT ブリッジが機能する

### セキュリティ
- [ ] 未認証リクエスト → 401
- [ ] 他ユーザーのプロジェクトへのアクセス → 403

### 機能
- [ ] CSV アップロード → テーブル表示
- [ ] GREL 変換の適用（例: `value.trim()`）
- [ ] CSV/Excel/JSON エクスポート
- [ ] ページ離脱時のプロジェクト削除

### 運用
- [ ] Cron クリーンアップの動作
- [ ] 孤立プロジェクトが定期削除される
