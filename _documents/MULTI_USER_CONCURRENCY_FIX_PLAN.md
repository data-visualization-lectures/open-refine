# マルチユーザー同時利用耐性 改修実装計画（改訂版）

本計画は [MULTI_USER_CONCURRENCY_ASSESSMENT.md](/Users/yuichiyazaki/Documents/GitHubRepository/Prj_App_SelfWorks/openrefine/MULTI_USER_CONCURRENCY_ASSESSMENT.md) の指摘を解消し、`3b3def...` 時点の「単一インスタンス依存・認可不足」状態を、本番の複数ユーザー同時利用に耐える構成へ移行するための実装仕様です。

> **実装ステータス（2026-02-25 更新）:** ステップ 1〜7 は完了済み。残存課題は §12 を参照。

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

## 1.1 新規テーブル ✅ 完了
`public.openrefine_runtime_projects` を追加した。

`project_name` はDisplay用途のみで所有権判定には使わない。OpenRefineでプロジェクト名が変更されると陳腐化するが、判定ロジックには影響しないため best-effort（変更追従なし）とする。

> **実装補足:** 302 redirect 経由や `get-importing-job-status` 経由でのプロジェクト登録時は、
> project name が取得不可なため `project_id` を仮名として登録している。
> `registerProject(projectId, user.id, projectId, accessToken)` の形。

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

## 1.2 RLSポリシー ✅ 完了
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

## 2. `project-registry.ts` の全面刷新 ✅ 完了

## 2.1 認可モデル（重要）
- **通常リクエスト**: ユーザーの `accessToken` を使ってRLS準拠で操作する。
- **cron cleanup**: `SUPABASE_SERVICE_ROLE_KEY` を使って全件横断操作する。

## 2.2 新しい関数仕様（実装済み）

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

## 2.3 実装ルール ✅ 完了
- in-memory `Map` 実装を削除した（フォールバックも廃止）。
- `on_conflict=project_id` upsert で登録を冪等化した。
  - 異なるオーナーが同じ `project_id` でupsertしようとした場合、RLSのUPDATEポリシー (`USING (auth.uid() = owner_id)`) により更新が阻止される。
- `touchProject` は `project_id + owner_id` 条件で更新し、RLSとSQLの両方でオーナー確認を二重化した。

## 3. 認可の共通化 ✅ 完了

## 3.1 方針
- 共通認可は **query/path ベース** で実施し、`request.body` を読まない。
- Body読取が必要な例外は、各route内で `clone()` 等を使って明示的に処理する。

## 3.2 `proxy.ts` に共通関数を追加（実装済み）
- `shouldEnforceProjectOwnership(command, requestUrl)` を実装。
- `importingJobID` のプレビューAPI（`get-models/get-rows/get-columns`）は `project` なしで許可する（現行互換）。

```ts
// frontend/src/lib/proxy.ts
export function shouldEnforceProjectOwnership(command: string, requestUrl: string): boolean {
  if (!requiresProjectOwnership(command)) return false;
  const url = new URL(requestUrl);
  const projectId = url.searchParams.get("project");
  if (projectId) return true;
  const importingJobID = url.searchParams.get("importingJobID");
  if (importingJobID && (command === "get-models" || command === "get-rows" || command === "get-columns")) {
    return false;
  }
  return true;
}
```

## 3.3 適用対象 ✅ 完了
- `app/api/refine/[...path]/route.ts` ✅
- `app/command/[[...path]]/route.ts` ✅
- `app/openrefine/[[...path]]/route.ts` ✅

## 4. `get-all-project-metadata` フィルタ実装 ⚠️ 部分完了

- `app/command/[[...path]]/route.ts:309-317` ✅ 実装済み
- `app/openrefine/[[...path]]/route.ts:781-784` ✅ 実装済み
- `app/api/refine/[...path]/route.ts` ⚠️ **未実装**（残存課題 §12.1 参照）

実装済みパターン（`filterProjectMetadata` in `proxy.ts`）:
```ts
const ownedIds = await listOwnedProjectIds(user.id, user.accessToken);
const filteredBody = filterProjectMetadata(upstreamBody, ownedIds);
return new Response(filteredBody, { ... });
```

## 5. 所有権登録経路の厳格化 ✅ 完了

## 5.1 廃止した処理 ✅
- `resolveOwnedProjectNameFromBackend` のような「metadataが読めたら所有者として登録」を全廃した。

## 5.2 登録を許可する経路（実装済み）

| 経路 | 実装箇所 | 備考 |
|------|----------|------|
| 302 redirect + `Location: ?project=<id>` | `openrefine/route.ts:697-710`, `command/route.ts:283-292` | 主に `import-project` |
| `get-importing-job-status` body の `projectID` | `openrefine/route.ts:765-778` | UI での新規作成（後述） |
| cloudSync `importArchiveToOpenRefine` 成功時 | `command/route.ts:232` | 復元・sync 由来 |

> **⚠️ 計画との乖離：`create-project` フローが 302 でなかった**
>
> 計画策定時は「create-project → 302 redirect → projectId 取得」を想定していたが、
> 実際には `importing-controller?subCommand=create-project` は HTTP 200 を返し、
> リダイレクトは発生しない。代わりに以下の非同期フローを用いる:
>
> 1. `importing-controller?subCommand=create-project` → 200（jobId を返す）
> 2. `get-importing-job-status?jobID=<id>` を JS がポーリング
> 3. ジョブ完了時のレスポンス body に `"projectID": <数値>` が含まれる
> 4. プロキシがこの body を regex マッチして `registerProject` を呼ぶ
>
> この挙動は OpenRefine のバージョン 3.9.5 で確認済み。

## 6. cleanup 改修（分散対応） ✅ 完了

`/api/cron/cleanup-orphans` の実装:
1. `listStaleProjectIds(maxAgeHours)` でDBから候補取得（service role）
2. OpenRefine `delete-project` を `OPENREFINE_SHARED_SECRET` ヘッダー付きで実行
   - `buildBackendHeaders(request)` が `x-openrefine-proxy-secret` を付与するため cron コンテキストでも認証可能
3. 成功時 `removeProjectForCleanup(projectId)` でレジストリ削除
4. 失敗は `failed[]` に集約してレスポンスに返却

## 7. 環境変数・運用ガード ✅ 完了

必須:
- `SUPABASE_SERVICE_ROLE_KEY`（cleanup と運用操作）
- `OPENREFINE_SHARED_SECRET`
- `OPENREFINE_BACKEND_URL`
- `CRON_SECRET`

本番固定:
- `ALLOW_ANON_OPENREFINE_UI=false`（デフォルト値）
- `ALLOW_ANON_PROJECT_CREATE=false`（デフォルト値）

## 8. 実装ステップ（完了状況）

| ステップ | 内容 | 状況 |
|---------|------|------|
| 1 | DB migration（`openrefine_runtime_projects` + RLS） | ✅ 完了 |
| 2 | Registry layer 差し替え（Supabase 永続版）| ✅ 完了 |
| 3 | ID抽出ユーティリティ（`lib/openrefine-project-id.ts`） | ✅ 完了 |
| 4 | 認可共通化（`shouldEnforceProjectOwnership`）適用 | ✅ 完了 |
| 5 | `get-all-project-metadata` フィルタ | ⚠️ `/api/refine` 未実装 |
| 6 | 後付け登録削除・cloudSync 登録保証 | ✅ 完了 |
| 7 | cleanup 改修（DB 基準） | ✅ 完了 |
| 8 | 本番 `ALLOW_ANON_*` を `false` に設定 | ✅ デフォルト false |

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

- 同時利用での相互アクセス不可をE2Eで証明（403） ← **未達**
- metadata漏えいが解消 ← **`/api/refine` 経路は未達**
- cloudSync由来プロジェクトが正常にアクセスできる（400/403が出ない） ← ✅ 動作確認済み
- cleanup がDB基準で稼働 ← ✅ 完了
- 本番 `ALLOW_ANON_*` が `false` ← ✅ 完了
- `touchProject` が `ownerId` を検証した上で `last_access_at` を更新できている ← ✅ 完了
- 監視ログに認可失敗理由（projectId, command, userId）が記録される ← ✅ `console.warn` で記録済み

## 12. 残存課題

### 12.1 `/api/refine` の `get-all-project-metadata` フィルタ未実装（中優先度）

`GET /api/refine/command/core/get-all-project-metadata` を直接呼ばれると、
他ユーザーのプロジェクト metadata が返る可能性がある。
通常の OpenRefine UI フローはこの経路を使わないが、API 直叩きによるリスクは残存。

**対処方針（未実装）:**
`app/api/refine/[...path]/route.ts` の `get-all-project-metadata` レスポンス処理に
`filterProjectMetadata(body, await listOwnedProjectIds(...))` を追加する。

### 12.2 CloudSyncThrottle のプロセスローカル Map（低優先度）

`globalThis.__openRefineCloudSyncThrottle__` が各ルートに存在し、分散環境でスロットルが機能せず cloudSync が重複する可能性がある。セキュリティ問題ではなく、OpenRefine のメモリ消費増大リスクのみ。

**対処方針（未実装）:**
Vercel KV（Redis）や Supabase テーブルへ移行する。

### 12.3 E2E テスト未実施（低優先度）

2ユーザー同時ログインでの相互アクセス禁止、インスタンス跨ぎ認可の自動化テストが未実施。
