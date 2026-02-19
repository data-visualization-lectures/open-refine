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

## アーキテクチャ概要

```
Browser
  → Vercel (Next.js カスタム UI + Supabase Auth)
      → Next.js API Routes（認証済みプロキシ）
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
    ├── next.config.ts
    ├── vercel.json          # Cron 設定
    ├── .env.example
    └── src/
        ├── app/
        │   ├── layout.tsx
        │   ├── page.tsx
        │   ├── app/
        │   │   ├── layout.tsx         # Auth guard
        │   │   └── editor/
        │   │       └── page.tsx       # メインエディタ
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
            ├── refine-client.ts    # ブラウザ側 API クライアント
            └── project-id.ts      # ユーザースコープ命名
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
      proxy_pass http://127.0.0.1:3333;
      proxy_http_version 1.1;
      proxy_set_header Host localhost;
      proxy_pass_request_headers on;
    }
  }
}
```

### backend/entrypoint.sh

```bash
#!/bin/bash
set -e

if [ -z "${PORT}" ]; then
  echo "ERROR: PORT not set"
  exit 1
fi

envsubst '${PORT}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
nginx -g "daemon off;" &

/opt/openrefine/refine \
    -i 127.0.0.1 -p 3333 \
    -m "${REFINE_MEMORY:-1400M}" \
    -x refine.headless=true -d /data &

for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:3333/ > /dev/null 2>&1 && break
  [ $i -eq 60 ] && echo "ERROR: OpenRefine failed to start" && exit 1
  sleep 1
done
echo "OpenRefine ready"

wait -n
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

OpenRefine の `project` パラメータは numericId なので、`x-project-name` を受けた Upload 経路で `numericId→userId` のマッピング（Supabase のテーブルや in-memory registry）を保持し、すべてのルートで `project` の所有者チェックを通す。これをやらずにプレフィックスだけ見ると numericId を知った攻撃者に横断アクセスされるため、`project` から映る ownerId を公開しないアクセス制御レイヤーが必要。

**マルチユーザー分離ロジック:**
プロジェクト名を `{supabaseUserId}_{timestamp}_{random}` で命名し、プロキシ側でプレフィックスを確認。他人のプロジェクトへのアクセスは 403 を返す。

所有権チェック対象コマンド:
`get-rows`, `get-columns`, `get-project-metadata`, `apply-operations`,
`export-rows`, `delete-project`, `get-models`, `compute-facets`

```typescript
function userOwnsProject(userId: string, projectName: string): boolean {
  return projectName.startsWith(`${userId}_`)
}
```

上記のプレフィックスチェックは補助的な知識であり、必ず `project` numericId → ownerId のレコードと照合する。乗っ取られたリクエストでも、プロキシがそのマッピングを参照して異なる owner のプロジェクトにアクセスしないようにする。

未列挙のコマンドはプロキシ経由で発生しないよう、Next.js 側で API ルートを最小化したホワイトリスト方式とし、`[...]` キャッチオールの代わりに実際に使う `command` のみを許可。API ルートで `path` を解析してホワイトリストにない endpoint を 400/403 で弾く。これにより今後追加される OpenRefine コマンドでも即座にレビューでき、ブラックリストの漏れを防げる。

### Railway 直アクセス制御

Railway のバックエンド URL はデプロイ完了後に外部へ公開されるので、そのまま OpenRefine を叩かれると Supabase 認証／プロキシ／所有権ロジックが効かなくなる。Railway 側で Vercel からのリクエストしか受け付けない共有シークレットヘッダーや IP 制限を追加するか、Vercel が HMAC シグネチャを付与して携帯情報を検証できる仕組みを併用し、直接アクセスを拒否することを想定する。

### 元 OpenRefine UI の公開（プロキシ経由）

`/openrefine/*` を Next.js Route Handler で Railway に透過し、`x-openrefine-proxy-secret` をサーバー側で付与して元 UI（`wirings.js` / `index-bundle.js` / `styles/*` など）をそのまま配信する。Railway 直リンクは使わず、ブラウザからは常に Vercel 経由でアクセスする。

開発中に Supabase 接続前で UI を確認したい場合のみ `ALLOW_ANON_OPENREFINE_UI=true` を使い、`/openrefine/*` への未認証アクセスを許可する。本番では `false` に戻す。

### ファイルアップロード専用ルート

`src/app/api/refine/upload/route.ts`

- `multipart/form-data` をそのまま転送（バイナリ破損防止）
- `x-project-name: {userId}_{ts}_{rand}` ヘッダーでプロジェクト名を指定
- OpenRefine のリダイレクト先 URL から数値 projectId を取得して返す

**開発用（Supabase 接続前の確認モード）:**
- 目的は「新規プロジェクト作成だけ」を先に動作確認すること。既存プロジェクトの open/save は対象外。
- `ALLOW_ANON_PROJECT_CREATE=true` のときのみ、`/api/refine/upload` で未認証リクエストを許可する。
- 匿名時の owner は `DEV_FALLBACK_USER_ID` を使って `projectName` を生成し、通常の作成フロー（upload → redirect から projectId 抽出）を通す。
- `/api/refine/upload` 以外の API は引き続き認証必須（匿名モード対象外）。
- 検証は `app/editor` のアップロード UI から行い、`projectId` が返ることを確認する。

### CSRF トークン対応

OpenRefine 3.5+ は POST に `X-Token` ヘッダーが必要。
`GET /command/core/get-csrf-token` で取得・キャッシュ。プロキシはそのまま転送。

トークン取得時に返る `Set-Cookie`/`Cookie` ヘッダーはブラウザとのセッションを維持するために透過し、キャッシュも `userId`＋`project` でキーを持たせる。ユーザー共有環境でトークンを共通化すると他人のセッションに使われかねないため、都度トークンとクッキーが一致するかを確認してから POST を転送すること。

### frontend/.env.example

```bash
# Supabase（既存の値を使用）
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...

# Railway OpenRefine バックエンド（サーバー専用・ブラウザには非公開）
OPENREFINE_BACKEND_URL=https://openrefine-xxx.up.railway.app

# Railway 直アクセス防止（Railway 側と同じ値）
OPENREFINE_SHARED_SECRET=your-shared-secret-here

# Cron 認証（openssl rand -hex 32 で生成）
CRON_SECRET=your-secret-here

# オプション
MAX_UPLOAD_SIZE_MB=100
MAX_PROJECT_AGE_HOURS=24
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

---

## Phase 3: OpenRefine API 統合

### データフロー（エフェメラルモード）

```
1.  ユーザーが CSV を選択
2.  POST /api/refine/upload  (x-project-name: {userId}_{ts}_{rand})
3.  Railway: POST /command/core/create-project-from-upload?projectName=...
4.  OpenRefine がプロジェクト作成 → /project?project={numericId} にリダイレクト
5.  numericId を抽出して返却
6.  ブラウザが projectId を state に保持
7.  DataTable: GET /api/refine/get-rows?project={numericId}
8.  変換: POST /api/refine/apply-operations?project={numericId}
9.  エクスポート: GET /api/refine/export-rows?project={numericId}&format=csv
10. ページ離脱: sendBeacon('/api/refine/cleanup', {projectId}) → DELETE
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
4. 環境変数 `REFINE_MEMORY=1400M` を設定
5. 生成された URL をメモ（例: `https://openrefine-xxx.up.railway.app`）

### Step 2: Vercel へフロントエンドをデプロイ

1. GitHub リポジトリを Vercel に接続
2. プロジェクトのルートを `frontend/` に指定
3. 環境変数を設定（上記表参照）
4. `OPENREFINE_BACKEND_URL` = Step 1 で取得した Railway URL

### Step 3: 動作確認

```bash
# Railway バックエンドの疎通確認
curl https://openrefine-xxx.up.railway.app/command/core/get-all-project-metadata

# 未認証アクセスが 401 になることを確認
curl https://your-app.vercel.app/api/refine/get-all-project-metadata
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
