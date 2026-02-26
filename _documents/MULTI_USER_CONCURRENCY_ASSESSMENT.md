# 同時利用耐性調査レポート（OpenRefine SaaS）

- 調査日: 2026-02-25
- 対象コミット（調査時点）: `3b3def490fd3211a5b2105fae21494242b436f32`
- 改修完了コミット（主要対応）: `0d65f85` 〜 `0f4b23d`（2026-02-25 セッション）
- 結論（調査時点）: **現状の実装は「複数アカウントの同時利用に耐える」とは判断できない**
- 結論（改修後）: **主要課題は解消済み。残存課題は低優先度のみ（後述）**

## 1. 判定サマリ

| 項目 | 調査時点 | 改修後 |
|------|----------|--------|
| ランタイム所有権レジストリがプロセスローカル | NG | ✅ 解消 |
| `/openrefine/*` 所有権強制なし | NG | ✅ 解消 |
| `/command/*` 所有権強制なし | NG | ✅ 解消 |
| `get-all-project-metadata` 他ユーザー情報露出 | NG | ⚠️ 部分解消（後述） |
| 後付け所有権登録経路 | NG | ✅ 解消 |
| `touchProject` ownerId 引数不足 | 軽微 | ✅ 解消 |
| CloudSyncThrottle プロセスローカル | 低優先 | ⚠️ 未解消（低優先） |
| E2E テスト | 未実施 | 未実施 |

## 2. 事実ベースの根拠（コード参照）

### 2.1 ランタイム所有権がメモリのみ ✅ 解消済み

**調査時点の問題:**
- `frontend/src/lib/project-registry.ts` が `globalThis.__openRefineRegistry__` の in-memory Map で所有権管理
- Vercel 複数インスタンス間で状態共有されず、403や誤判定を誘発

**改修内容:**
- `project-registry.ts` を Supabase `openrefine_runtime_projects` テーブルへの永続 DB 実装に全面置換
- `registerProject / touchProject / projectBelongsTo / listOwnedProjectIds / removeProject` すべてが REST API 経由の Supabase 操作に変更
- cleanup 専用関数（`listStaleProjectIds / removeProjectForCleanup`）は service role key を使用し RLS をバイパス

### 2.2 `/openrefine/*` で所有権強制なし ✅ 解消済み

**調査時点の問題:**
- `proxy` 関数が `projectBelongsTo` チェックなしでバックエンドへ転送

**改修内容（`frontend/src/app/openrefine/[[...path]]/route.ts`）:**
```ts
// line 651-669
if (user && shouldEnforceProjectOwnership(command, request.url)) {
  const projectId = parseProjectId(request.url);
  if (!projectId) throw new ApiError(400, ...);
  if (!(await projectBelongsTo(projectId, user.id, user.accessToken))) {
    throw new ApiError(403, "Project does not belong to the authenticated user");
  }
  await touchProject(projectId, user.id, user.accessToken);
}
```

### 2.3 `/command/*` で所有権強制なし ✅ 解消済み

**改修内容（`frontend/src/app/command/[[...path]]/route.ts`）:**
```ts
// line 250-259
if (user && shouldEnforceProjectOwnership(command, request.url)) {
  const projectId = parseProjectId(request.url);
  if (!projectId) throw new ApiError(400, ...);
  if (!(await projectBelongsTo(projectId, user.id, user.accessToken))) {
    throw new ApiError(403, ...);
  }
  await touchProject(projectId, user.id, user.accessToken);
}
```

### 2.4 `/api/refine/*` は所有権チェックあり（変更なし）

- `frontend/src/app/api/refine/[...path]/route.ts:26-36` に `assertAllowedCommand` + `projectBelongsTo` + `touchProject` が引き続き存在
- 改修で `touchProject` の引数が `(projectId)` → `(projectId, ownerId, accessToken)` に変更された

### 2.5 所有権の「後付け登録」経路 ✅ 解消済み

**調査時点の問題:**
- `get-project-metadata` 成功時に `registerProject` を呼ぶ経路が存在（誰でも ownership を取れる）

**改修内容:**
- metadata 取得成功による登録経路を全廃
- 登録を許可する唯一の経路:
  1. `302 redirect` + `Location` ヘッダーの `?project=<id>` から抽出（`/openrefine/*` および `/command/*`）
  2. `get-importing-job-status` レスポンス body の `projectID` フィールドから抽出（後述 §3.1）
  3. `syncCloudProjectsToOpenRefineIfNeeded` の `importArchiveToOpenRefine` 成功時（`/command/*`）

### 2.6 CloudSyncThrottle もプロセスローカル Map ⚠️ 未解消（低優先度）

- `frontend/src/app/openrefine/[[...path]]/route.ts:38-73` の `__openRefineCloudSyncThrottle__`
- `frontend/src/app/command/[[...path]]/route.ts:28-60` の同様の `__openRefineCloudSyncThrottle__`
- セキュリティ問題ではなく、複数インスタンスで30秒スロットルが機能せず重複 cloudSync が走る可能性がある程度

### 2.7 OpenRefine本体は単一 `/data` を共有（設計前提・変更なし）

- `backend/entrypoint.sh` の `refine ... -d /data` は変更なし
- 分離はプロキシ層で担保する設計方針を維持

### 2.8 保存領域（Supabase）は比較的健全（変更なし）

- `openrefine_projects` と Storage バケットの RLS は有効
- `openrefine_runtime_projects` も RLS 付きで追加済み（`OPENREFINE_SUPABASE_SCHEMA.sql` 参照）

### 2.9 `/api/refine/*` の `touchProject` 引数不足 ✅ 解消済み

- `touchProject(projectId)` → `touchProject(projectId, user.id, user.accessToken)` に変更済み

### 2.10 `get-all-project-metadata` フィルタ ⚠️ 部分解消

**改修内容:**
- `/command/[[...path]]/route.ts:309-317` に `filterProjectMetadata` による owned フィルタ実装済み
- `/openrefine/[[...path]]/route.ts:781-784` に同様の実装済み

**残存課題:**
- `/api/refine/[...path]/route.ts` には `get-all-project-metadata` フィルタが未実装
  - ただし `assertAllowedCommand` は `get-all-project-metadata` を `ALLOWED_COMMANDS` に含むため通過可能
  - ユーザーが `/api/refine/command/core/get-all-project-metadata` を直接呼んだ場合、他ユーザーの metadata が返りうる

## 3. 改修で判明した実装上の発見

### 3.1 `create-project` フローが HTTP 302 でなく HTTP 200 だった（重要）

**計画での想定:**
- `create-project` 成功 → 302 redirect + `Location: ?project=<id>` → projectId 抽出 → 登録

**実際の挙動:**
- `importing-controller?subCommand=create-project` → HTTP 200（リダイレクトなし）
- 非同期の job status ポーリング: `get-importing-job-status` レスポンス body に `"projectID": <id>` が含まれる
- これを `/openrefine/[[...path]]/route.ts:765-778` で body regex マッチして登録するよう実装した

**実装:**
```ts
if (resolvedCmd === "get-importing-job-status") {
  const match = bodyText.match(/"project(?:ID|Id)"\s*:\s*(\d+)/);
  if (match) {
    await registerProject(match[1], user.id, match[1], user.accessToken);
  }
}
```

### 3.2 登録時の `project_name` は仮名（projectId と同値）

- 302 redirect や `get-importing-job-status` 経由では project name が取得不可
- `registerProject(projectId, user.id, projectId, ...)` と projectId を仮名として登録
- `openrefine_runtime_projects.project_name` は Display 用途のみ、所有権判定には使わないため実害なし
- cloudSync 経由（`importArchiveToOpenRefine` 後）のみ正式な `syncName` が使用される

## 4. 優先度付き改善提案（改訂版）

| 優先度 | 内容 | 状況 |
|--------|------|------|
| 最優先 | `openrefine_runtime_projects` 永続レジストリ | ✅ 完了 |
| 高 | `/openrefine/*`, `/command/*` 所有権チェック統一 | ✅ 完了 |
| 高 | `get-all-project-metadata` owned フィルタ | ⚠️ `/api/refine` 未実装 |
| 中 | 後付け metadata 登録廃止 | ✅ 完了 |
| 中 | `touchProject` に `ownerId` 引数追加 | ✅ 完了 |
| 低 | CloudSyncThrottle を共有 KVS へ移行 | 未着手 |
| 低 | 本番で `ALLOW_ANON_*` を `false` に固定 | ✅ デフォルト false |
| 低 | E2E テスト追加 | 未実施 |

## 5. 最終結論

調査時点（`3b3def...`）では単一ユーザー・検証用途のみ安全な状態でしたが、
`0d65f85` 〜 `0f4b23d` の改修により **主要なマルチユーザー同時利用リスクは解消されました**。

残存課題は:
1. `/api/refine` 経由の `get-all-project-metadata` に他ユーザー情報が含まれる可能性（中優先）
2. CloudSyncThrottle が分散環境でスロットル重複しうる（低優先・セキュリティ問題なし）
3. E2E テスト未実施（信頼性担保のため実施推奨）
