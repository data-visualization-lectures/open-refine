# マルチユーザー同時利用耐性 改修実装計画（改訂版）

本計画は [MULTI_USER_CONCURRENCY_ASSESSMENT.md](/Users/yuichiyazaki/Documents/GitHubRepository/Prj_App_SelfWorks/openrefine/MULTI_USER_CONCURRENCY_ASSESSMENT.md) の指摘を解消し、`3b3def...` 時点の「単一インスタンス依存・認可不足」状態を、本番の複数ユーザー同時利用に耐える構成へ移行するための実装仕様です。

## 0. ゴールと非ゴール

### ゴール
- OpenRefine runtime project（数値ID）の所有権を **永続DBで一元管理** する。
- `/openrefine/*` `/command/*` `/api/refine/*` で **同一認可ルール** を強制する。
- `get-all-project-metadata` から他ユーザー情報を除去する。
- 「後付け所有権登録（metadataが読めたら登録）」を廃止する。
- cleanup を分散環境で正しく動作させる。

### 非ゴール
- OpenRefine本体をマルチテナント化すること（本計画はプロキシ層で分離を担保する）。

## 1. データモデル（Supabase）変更

## 1.1 新規テーブル
`public.openrefine_runtime_projects` を追加する。

`project_name` はDisplay用途のみで所有権判定には使わない。OpenRefineでプロジェクト名が変更されると陳腐化するが、判定ロジックには影響しないため best-effort（変更追従なし）とする。

```sql
create table if not exists public.openrefine_runtime_projects (
  project_id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_name text not null,
  created_at timestamptz not null default now(),
  last_access_at timestamptz not null default now()
);

create index if not exists openrefine_runtime_projects_owner_access_idx
  on public.openrefine_runtime_projects (owner_id, last_access_at desc);

create index if not exists openrefine_runtime_projects_last_access_idx
  on public.openrefine_runtime_projects (last_access_at asc);

alter table public.openrefine_runtime_projects enable row level security;
```

## 1.2 RLSポリシー
`FOR ALL` 1本ではなく操作別に定義する。

```sql
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'openrefine_runtime_projects'
      and policyname = 'openrefine_runtime_projects_select_own'
  ) then
    create policy openrefine_runtime_projects_select_own
      on public.openrefine_runtime_projects
      for select
      using (auth.uid() = owner_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'openrefine_runtime_projects'
      and policyname = 'openrefine_runtime_projects_insert_own'
  ) then
    create policy openrefine_runtime_projects_insert_own
      on public.openrefine_runtime_projects
      for insert
      with check (auth.uid() = owner_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'openrefine_runtime_projects'
      and policyname = 'openrefine_runtime_projects_update_own'
  ) then
    create policy openrefine_runtime_projects_update_own
      on public.openrefine_runtime_projects
      for update
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'openrefine_runtime_projects'
      and policyname = 'openrefine_runtime_projects_delete_own'
  ) then
    create policy openrefine_runtime_projects_delete_own
      on public.openrefine_runtime_projects
      for delete
      using (auth.uid() = owner_id);
  end if;
end$$;
```

## 2. `project-registry.ts` の全面刷新

## 2.1 認可モデル（重要）
- **通常リクエスト**: ユーザーの `accessToken` を使ってRLS準拠で操作する。
- **cron cleanup**: `SUPABASE_SERVICE_ROLE_KEY` を使って全件横断操作する。

## 2.2 新しい関数仕様

```ts
export async function registerProject(
  projectId: string,
  ownerId: string,
  projectName: string,
  accessToken?: string
): Promise<void>;

export async function touchProject(
  projectId: string,
  ownerId: string,
  accessToken?: string
): Promise<void>;

export async function projectBelongsTo(
  projectId: string,
  ownerId: string,
  accessToken?: string
): Promise<boolean>;

export async function listOwnedProjectIds(
  ownerId: string,
  accessToken?: string
): Promise<string[]>;

export async function removeProject(
  projectId: string,
  ownerId: string,
  accessToken?: string
): Promise<void>;

// cleanup専用（service role）
export async function listStaleProjectIds(maxAgeHours: number): Promise<string[]>;
export async function removeProjectForCleanup(projectId: string): Promise<void>;
```

## 2.3 実装ルール
- in-memory `Map` 実装を削除する（フォールバックも廃止）。
- `on_conflict=project_id` upsert で登録を冪等化する。
  - 異なるオーナーが同じ `project_id` でupsertしようとした場合、RLSのUPDATEポリシー (`USING (auth.uid() = owner_id)`) により更新が阻止される。`PGRST116`（ゼロ行更新）等のエラーを適切にハンドリングし、呼び出し側が 403 を返せるようにする。
- `touchProject` は `project_id + owner_id` 条件で更新し、RLSとSQLの両方でオーナー確認を二重化する。
- `registerProject` 呼び出しサイトでは必ず `user.id` を `ownerId` として渡すこと（RLSのINSERTポリシー `with check (auth.uid() = owner_id)` は `ownerId` がリクエストユーザーと一致する場合のみ許可する）。

## 3. 認可の共通化（Body消費を避ける）

## 3.1 方針
- 共通認可は **query/path ベース** で実施し、`request.body` を読まない。
- Body読取が必要な例外は、各route内で `clone()` 等を使って明示的に処理する。

## 3.2 `proxy.ts` に共通関数を追加
- `shouldEnforceProjectOwnership(command, requestUrl)` を導入。
- `importingJobID` のプレビューAPI（`get-models/get-rows/get-columns`）は `project` なしで許可する（現行互換）。

```ts
if (!projectId && importingJobID && (command === "get-models" || ...)) return false;
```

## 3.3 適用対象
- `app/api/refine/[...path]/route.ts`
- `app/command/[[...path]]/route.ts`
- `app/openrefine/[[...path]]/route.ts`

上記すべてで、所有権対象コマンドは以下を実施:
1. `project` query の取得
2. `await projectBelongsTo(..., user.accessToken)` 判定
3. 不一致なら `403`
4. 一致なら `touchProject(..., user.accessToken)`

## 4. `get-all-project-metadata` フィルタ実装

対象ルート:
- `app/openrefine/[[...path]]/route.ts`
- `app/command/[[...path]]/route.ts`
- `app/api/refine/[...path]/route.ts`

仕様:
1. upstream JSON を読み込む
2. `ownedProjectIds = await listOwnedProjectIds(user.id, user.accessToken)`
3. `projects` を `ownedProjectIds` でフィルタ
4. filtered body を返却（`content-length` は削除）

## 5. 所有権登録経路の厳格化

## 5.1 廃止する処理
- `resolveOwnedProjectNameFromBackend` のような「metadataが読めたら所有者として登録」を全廃する。

## 5.2 登録を許可する唯一の経路
- `create-project*` 成功時（location/url/body から projectId 抽出）
- `import-project` 成功時（restore/sync含む）
  - `syncCloudProjectsToOpenRefineIfNeeded`（`/openrefine/*` および `/command/*` の両経路）でのimport成功時も必ずここで登録すること。cloudSync経由の登録を保証しないと、後付け登録を廃止した後に cloudSync由来プロジェクトへの操作がすべて403になる。

補足:
- projectId 抽出ロジックは `lib/openrefine-project-id.ts`（新規）に集約する。

## 6. cleanup 改修（分散対応）

`/api/cron/cleanup-orphans` は以下に変更:
1. `listStaleProjectIds(maxAgeHours)` でDBから候補取得（service role）
2. OpenRefine `delete-project` 実行
   - バックエンド認証は `OPENREFINE_SHARED_SECRET`（`x-openrefine-proxy-secret` ヘッダ）で行うため、cronリクエストにユーザーcookieがなくても認証可能であることを前提とする。現在の `buildBackendHeaders(request)` の実装がこれを満たしていることを確認する。
3. 成功時 `removeProjectForCleanup(projectId)` でレジストリ削除
4. 失敗は `failed[]` に集約し再試行可能にする

## 7. 環境変数・運用ガード

必須:
- `SUPABASE_SERVICE_ROLE_KEY`（cleanupと運用操作）
- `OPENREFINE_SHARED_SECRET`
- `OPENREFINE_BACKEND_URL`
- `CRON_SECRET`

本番固定:
- `ALLOW_ANON_OPENREFINE_UI=false`
- `ALLOW_ANON_PROJECT_CREATE=false`

## 8. 実装ステップ（順序固定）

1. **DB migration**
   - `openrefine_runtime_projects` + index + RLS policy 適用
2. **Registry layer差し替え**
   - `project-registry.ts` をSupabase永続版へ置換
   - `touchProject` シグネチャを `(projectId, ownerId, accessToken?)` に変更（`/api/refine/*` 側も合わせて更新）
3. **ID抽出ユーティリティ導入**
   - `parseProjectIdFromLocation / parseProjectIdFromBody` を `lib/openrefine-project-id.ts` に集約
4. **認可共通化適用**
   - `/api/refine` `/command` `/openrefine` に統一導入
5. **metadataフィルタ適用**
   - `get-all-project-metadata` で所有分のみ返却
6. **後付け登録削除・cloudSync登録保証**
   - `resolveOwnedProjectNameFromBackend` を含む metadataベース自動登録を削除
   - `syncCloudProjectsToOpenRefineIfNeeded` 内の import 成功時 `registerProject` が正しく動作することを確認
7. **cleanup改修**
   - DB起点のstale cleanupへ切替
   - `buildBackendHeaders` の動作（`OPENREFINE_SHARED_SECRET` のみで認証できること）を確認
8. **本番env固定**
   - `ALLOW_ANON_*` を `false` に設定

## 9. 検証計画（必須）

### 9.1 機能検証
- ユーザーA/B同時ログインで project作成
- AがBのproject IDで `get-rows/get-models/apply-operations/export-rows/delete-project` を叩いてすべて `403`
- `get-all-project-metadata` のレスポンスに他ユーザーprojectが含まれない

### 9.2 分散耐性検証
- 連続リクエストでインスタンスが切り替わる条件でも所有権判定が安定
- 作成直後のprojectが別リクエスト経路でも即時アクセス可能

### 9.3 回帰検証
- import preview（`importingJobID`）で `400/403` が出ない
- restore/save/cleanup が従来どおり機能

## 10. ロールバック方針

- アプリ側は feature branch で段階反映。
- 問題発生時は `main` を直前コミットへ戻す。
- DBテーブルは残しても既存動作に影響しないため、アプリ側ロールバックを優先。

## 11. 完了条件（Definition of Done）

- 同時利用での相互アクセス不可をE2Eで証明（403）
- metadata漏えいが解消
- cloudSync由来プロジェクトが正常にアクセスできる（400/403が出ない）
- cleanup がDB基準で稼働
- 本番 `ALLOW_ANON_*` が `false`
- `touchProject` が `ownerId` を検証した上でlast_access_atを更新できている
- 監視ログに認可失敗理由（projectId, command, userId）が記録される

