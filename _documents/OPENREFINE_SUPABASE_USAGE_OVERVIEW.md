# Supabase 利用全体像

本プロジェクトにおける Supabase の利用範囲と、テーブル・Storage・認証の仕組みを一元的にまとめる。

## 利用範囲

| 機能 | 用途 |
|------|------|
| **Auth** | ユーザー認証（JWT発行・検証） |
| **PostgREST** | テーブル CRUD（REST API 経由） |
| **Storage** | プロジェクトアーカイブ・サムネイル保存 |

Supabase クライアントライブラリは使用せず、すべて `fetch` による直接 REST 呼び出しで実装している。

---

## テーブル

### 1. `openrefine_runtime_projects`（実行時プロジェクト所有権管理）

OpenRefine バックエンド上で実行中のプロジェクトを追跡する。

| カラム | 型 | 説明 |
|--------|----|------|
| `project_id` | text PK | OpenRefine 内部のプロジェクトID（数値文字列） |
| `owner_id` | uuid FK→auth.users | 所有者 |
| `project_name` | text | プロジェクト名 |
| `created_at` | timestamptz | 作成日時 |
| `last_access_at` | timestamptz | 最終アクセス日時（クリーンアップ判定用） |

インデックス:
- `(owner_id, last_access_at DESC)` — ユーザー別のアクセス順取得
- `(last_access_at ASC)` — 古いプロジェクトの検索

**CRUD 操作**（`frontend/src/lib/project-registry.ts`）:

| 関数 | HTTP | 用途 | 認証キー |
|------|------|------|----------|
| `registerProject()` | POST（Upsert） | プロジェクト登録・更新 | User JWT |
| `projectBelongsTo()` | GET | 所有権チェック | User JWT |
| `touchProject()` | PATCH | `last_access_at` 更新 | User JWT |
| `listOwnedProjectIds()` | GET | 所有プロジェクトID一覧 | User JWT |
| `removeProject()` | DELETE | プロジェクト削除 | User JWT |
| `listStaleProjectIds()` | GET | 古いプロジェクト検索（全ユーザー横断） | Service Role |
| `removeProjectForCleanup()` | DELETE | クリーンアップ削除（全ユーザー横断） | Service Role |

### 2. `openrefine_projects`（保存済みプロジェクトメタデータ）

ユーザーがクラウド保存したプロジェクトのメタデータを管理する。

| カラム | 型 | 説明 |
|--------|----|------|
| `id` | uuid PK | 保存プロジェクトID |
| `user_id` | uuid FK→auth.users | 所有者 |
| `name` | text | プロジェクト名 |
| `archive_path` | text | Storage 上のアーカイブパス |
| `thumbnail_path` | text? | サムネイルパス |
| `openrefine_version` | text? | OpenRefine バージョン |
| `source_filename` | text? | 元ファイル名 |
| `size_bytes` | bigint? | アーカイブサイズ |
| `created_at` | timestamptz | 作成日時 |
| `updated_at` | timestamptz | 更新日時 |

インデックス:
- `(user_id, updated_at DESC)`

**CRUD 操作**（`frontend/src/lib/openrefine-storage.ts`）:

| 関数 | HTTP | 用途 |
|------|------|------|
| `listOpenRefineSavedProjects()` | GET | ユーザーの保存プロジェクト一覧 |
| `getOpenRefineSavedProject()` | GET | 個別プロジェクト取得 |
| `createOpenRefineSavedProject()` | POST | プロジェクトメタデータ登録 |
| `deleteOpenRefineSavedProject()` | DELETE | プロジェクト削除 |

すべて User JWT で認証。

---

## Storage バケット

### `openrefine-projects`（非公開バケット）

| 用途 | パス例 |
|------|--------|
| アーカイブ | `{user_id}/{saved_project_id}/project.tar.gz` |
| サムネイル | `{user_id}/{saved_project_id}/thumbnail.png` |

**操作関数**（`frontend/src/lib/openrefine-storage.ts`）:

| 関数 | HTTP | 用途 |
|------|------|------|
| `uploadOpenRefineArchive()` | POST | tar.gz アップロード |
| `uploadOpenRefineThumbnailFromDataUri()` | POST（upsert） | サムネイルアップロード |
| `downloadOpenRefineArchive()` | GET | tar.gz ダウンロード |
| `deleteOpenRefineStorageObject()` | DELETE | オブジェクト削除 |

バケット名は環境変数 `OPENREFINE_PROJECT_BUCKET` で変更可能（デフォルト: `openrefine-projects`）。

---

## RLS ポリシー

すべてのテーブル・Storage に Row Level Security を適用。

### `openrefine_runtime_projects`

| 操作 | 条件 |
|------|------|
| SELECT | `auth.uid() = owner_id` |
| INSERT | `auth.uid() = owner_id` |
| UPDATE | `auth.uid() = owner_id` |
| DELETE | `auth.uid() = owner_id` |

### `openrefine_projects`

| 操作 | 条件 |
|------|------|
| SELECT | `auth.uid() = user_id` |
| INSERT | `auth.uid() = user_id` |
| UPDATE | `auth.uid() = user_id` |
| DELETE | `auth.uid() = user_id` |

### Storage `openrefine-projects` バケット

パスの先頭セグメント（`user_id`）で制御:

```sql
split_part(name, '/', 1) = auth.uid()::text
```

SELECT / INSERT / UPDATE / DELETE すべてに適用。

---

## 認証キーの使い分け

### Anon Key + ユーザー JWT（通常操作）

```
apikey: NEXT_PUBLIC_SUPABASE_ANON_KEY
authorization: Bearer {user_access_token}
```

- ほぼすべてのCRUD操作で使用
- RLS により自分のデータのみアクセス可能
- 実装: `buildUserHeaders()` (project-registry.ts), `buildSupabaseHeaders()` (openrefine-storage.ts)

### Service Role Key（管理操作）

```
apikey: SUPABASE_SERVICE_ROLE_KEY
authorization: Bearer {SUPABASE_SERVICE_ROLE_KEY}
```

- **Cron クリーンアップのみ**で使用（`/api/cron/cleanup-orphans`）
- RLS をバイパスし、全ユーザーのデータにアクセス可能
- 実装: `buildServiceHeaders()` (project-registry.ts)
- 対象関数: `listStaleProjectIds()`, `removeProjectForCleanup()`

---

## 認証フロー

実装: `frontend/src/lib/auth.ts`

### トークン取得順序

1. `Authorization: Bearer {token}` ヘッダー
2. Cookie `sb-access-token`（プレーン JWT）
3. Cookie `sb-{project}-auth-token`（JSON/Base64 エンコード、チャンク分割対応）

### JWT 検証順序

1. **メモリキャッシュ**（TTL 60秒）— ヒットすればそのまま返す
2. **ローカル検証**（`SUPABASE_JWT_SECRET` で HMAC-SHA256 署名検証）
3. **リモート検証**（Supabase `/auth/v1/user` API 呼び出し）

戻り値: `AuthenticatedUser { id, accessToken, email? }`

---

## データフロー

### ファイルアップロード → 実行時プロジェクト登録

```
ブラウザ → /api/refine/upload
  → OpenRefine Backend (create-project-from-upload)
  → projectId を取得
  → registerProject() → openrefine_runtime_projects に Upsert
```

### プロジェクト操作時

```
ブラウザ → /api/refine/[...path] or /openrefine/[[...path]]
  → projectBelongsTo() → openrefine_runtime_projects を SELECT
  → touchProject() → last_access_at を PATCH
  → OpenRefine Backend へプロキシ
```

### クラウド保存

```
ブラウザ → /openrefine/[[...path]] (export-project 検出)
  → OpenRefine Backend から tar.gz 取得
  → uploadOpenRefineArchive() → Storage にアップロード
  → createOpenRefineSavedProject() → openrefine_projects に INSERT
```

### クラウド復元

```
ブラウザ → /api/openrefine/projects/{id}/restore
  → downloadOpenRefineArchive() → Storage から tar.gz 取得
  → OpenRefine Backend へ import-project
  → registerProject() → openrefine_runtime_projects に Upsert
```

### Cron クリーンアップ（毎時）

```
Vercel Cron → /api/cron/cleanup-orphans
  → listStaleProjectIds() → Service Role で全ユーザー横断検索
  → OpenRefine Backend で delete-project
  → removeProjectForCleanup() → Service Role で DB 削除
```

---

## 環境変数

| 変数名 | 用途 | 必須 |
|--------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase プロジェクト URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon Key | Yes |
| `SUPABASE_JWT_SECRET` | JWT ローカル検証用 | No（なければリモート検証） |
| `SUPABASE_SERVICE_ROLE_KEY` | Cron クリーンアップ用 | Yes |
| `OPENREFINE_PROJECT_BUCKET` | Storage バケット名 | No（デフォルト: `openrefine-projects`） |

---

## ストレージの役割分担

プロジェクトデータは2箇所に保存される。

| | Railway Volume (`/data`) | Supabase Storage |
|---|---|---|
| 役割 | 作業中プロジェクトの永続化（プライマリ） | 長期バックアップ |
| 内容 | OpenRefine ワークスペース全体 | tar.gz アーカイブ |
| ライフサイクル | Cron で `MAX_PROJECT_AGE_HOURS` 後に削除 | ユーザーが明示的に保存/削除 |
| 容量 | 1GB（Railway Hobby 無料枠） | 1GB（Supabase Free） |
| 消失条件 | Railway サービス削除時のみ | Supabase プロジェクト削除時のみ |

Railway Volume は `/data` にマウントされ、OpenRefine が `-d /data` で起動してプロジェクトデータを保存する。コンテナ再起動後もデータが保持される。Cron クリーンアップは OpenRefine の `delete-project` API を呼んでディスク上のプロジェクトを削除し、Volume 容量を解放する。

---

## 関連ドキュメント

- `_documents/OPENREFINE_SUPABASE_PROJECT_STORAGE_PLAN.md` — 保存/復元基盤の設計
- `_documents/MULTI_USER_CONCURRENCY_FIX_PLAN.md` — マルチユーザー対応の改修計画
