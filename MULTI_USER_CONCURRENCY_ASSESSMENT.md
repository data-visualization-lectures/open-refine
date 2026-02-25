# 同時利用耐性調査レポート（OpenRefine SaaS）

- 調査日: 2026-02-25
- 対象コミット: `3b3def490fd3211a5b2105fae21494242b436f32`
- 結論: **現状の実装は「複数アカウントの同時利用に耐える」とは判断できない**

## 1. 判定サマリ

- 判定: **NG（本番の同時利用耐性は不足）**
- 主要理由:
  - ランタイム所有権レジストリがプロセスローカル `Map`（非永続・非共有）
  - `/openrefine/*` および `/command/*` の主要プロキシで所有権強制がない
  - `get-all-project-metadata` がユーザーでフィルタされず、他ユーザーのプロジェクトID/名称露出リスクがある
  - 所有権未登録時にバックエンドmetadataが取得できれば登録してしまう経路があり、権限昇格を招きうる

## 2. 事実ベースの根拠（コード参照）

### 2.1 ランタイム所有権がメモリのみ（重大）

- `frontend/src/lib/project-registry.ts:17`
  - コメントで「本番は durable store に置き換えるべき」と明記。
- `frontend/src/lib/project-registry.ts:18-21`
  - `globalThis.__openRefineRegistry__ = { records: new Map() }`
- `frontend/src/lib/project-registry.ts:24-61`
  - `registerProject / projectBelongsTo / touchProject / listStaleProjectIds` すべてローカルMap依存。

影響:
- Vercel/Railwayの複数インスタンス構成で状態共有されない。
- あるインスタンスで登録した所有権を別インスタンスが認識できず、403や誤判定を誘発。
- cleanup対象判定もインスタンス局所化される。

### 2.2 `/openrefine/*` で所有権強制なし（重大）

- `frontend/src/app/openrefine/[[...path]]/route.ts:632-660`
  - `proxy` 関数内で `targetUrl` に対してそのまま `fetch` しており、`projectBelongsTo` チェックがない。
- `frontend/src/app/openrefine/[[...path]]/route.ts:357-373`
  - `get-all-project-metadata` を取得する処理が存在。
- `frontend/src/app/openrefine/[[...path]]/route.ts:684-704`
  - レスポンスをそのまま返却（ユーザーフィルタなし）。

補足: `export-project` 経路（`handleSupabaseProjectSaveFromExport`）のみは `projectBelongsTo` チェックが存在する（`route.ts:536`）。
ただしそのフォールバックが「2.5 後付け登録」そのものであり、問題の本質は変わらない。

影響:
- OpenRefine UI経由の主要操作に対して、ID指定アクセスの分離が成立しない可能性。
- metadata露出による他プロジェクトIDの探索コスト低下。

### 2.3 `/command/*` で所有権強制なし（重大）

- `frontend/src/app/command/[[...path]]/route.ts:280-304`
  - コマンドを受けてそのままバックエンドへ転送。
- `frontend/src/app/command/[[...path]]/route.ts:287-292`
  - `get-all-project-metadata` 呼び出し時にもユーザー別フィルタ処理なし。

影響:
- `/command` 直経路でも分離が崩れる。

### 2.4 `/api/refine/*` は所有権チェックあり（部分的に良い）

- `frontend/src/app/api/refine/[...path]/route.ts:25-37`
  - `assertAllowedCommand` + `requiresProjectOwnership` + `projectBelongsTo`。

ただし:
- 判定元が前述のプロセスローカルMapであり、分散環境では整合しない。
- `get-all-project-metadata` は `PROJECT_REQUIRED_COMMANDS` 外のため、所有権不要で通過。
  - 参照: `frontend/src/lib/proxy.ts:3-25,72-74`

### 2.5 所有権の「後付け登録」経路（重大）

- `frontend/src/app/openrefine/[[...path]]/route.ts:536-542`
  - `projectBelongsTo` が偽でも `get-project-metadata` 成功時に `registerProject(...)`。

影響:
- 未登録プロジェクトに対して現在ユーザーが所有権を後付けで確定させる余地がある。
- 本来必要な「作成イベント起点の所有権確定」が崩れる。

### 2.6 CloudSyncThrottleもプロセスローカルMap（運用上の懸念）

- `frontend/src/app/openrefine/[[...path]]/route.ts:30-64`
  - `globalThis.__openRefineCloudSyncThrottle__` は `Map<string, number>` でスロットル状態を保持。
- `frontend/src/app/command/[[...path]]/route.ts:22-52`
  - 同様の `__openRefineCloudSyncThrottle__` がもう1か所存在。

影響:
- セキュリティ問題ではないが、同一ユーザーが複数インスタンスに振られた場合、
  各インスタンスで独立してスロットルが管理されるため30秒スロットルが機能せず重複syncが走る可能性がある。
- 過剰なimport-project呼び出しによりOpenRefineのメモリ消費が増大する。

### 2.7 OpenRefine本体は単一 `/data` を共有（設計前提）

- `backend/entrypoint.sh:19-23`
  - `refine ... -d /data` で共通データディレクトリ。
- `IMPLEMENTATION_PLAN.md:39-44`
  - OpenRefineはマルチユーザー非対応、プロキシで分離する設計方針。

評価:
- つまり分離の成否はプロキシ実装に依存するが、現状その実装が不足。

### 2.8 保存領域（Supabase）は比較的健全（良い）

- `OPENREFINE_SUPABASE_SCHEMA.sql:4-20,30-71`
  - `openrefine_projects` にRLS。
- `OPENREFINE_SUPABASE_SCHEMA.sql:74-145`
  - Storageにもユーザーフォルダ単位のRLSポリシー。

評価:
- 永続保存機能のデータ面はユーザー分離が効いている。
- 問題は「ランタイムOpenRefineプロジェクトIDの分離」側。

### 2.9 `/api/refine/*` の `touchProject` 引数不足（軽微）

- `frontend/src/app/api/refine/[...path]/route.ts:36`
  - `touchProject(projectId)` に `ownerId` を渡していない。
  - 現状のメモリMap実装では問題ないが、DB版（`UPDATE WHERE project_id = ? AND owner_id = ?`）へ移行する際に引数追加が必要になる。

## 3. 同時利用シナリオ評価

### シナリオA: 同時に複数ユーザーが編集

- 判定: **不十分**
- 理由:
  - ランタイム所有権が永続・共有されないため、インスタンス跨ぎで認可判定が不整合。
  - `/openrefine`/`/command` 経路はそもそも所有権チェック未実装。

### シナリオB: ユーザーAがユーザーBのproject IDを知った場合

- 判定: **リスク高**
- 理由:
  - metadata露出経路があり、ID取得が容易になる可能性。
  - 経路によっては所有権未強制で操作が到達しうる。

### シナリオC: cleanup運用

- 判定: **限定的**
- 理由:
  - stale判定がローカルMap依存で、分散環境全体の実態を見ない。
  - `frontend/vercel.json:1-8` でcronは動くが、入力データが局所的。

## 4. 優先度付き改善提案

1. `openrefine_runtime_projects` のような永続レジストリを導入し、所有権をDBで一元化する（最優先）
2. 所有権チェックを `/openrefine/*` と `/command/*` にも共通適用し、`/api/refine/*` と同一基準へ統一
3. `get-all-project-metadata` はユーザー所有分のみ返すフィルタを必須化
4. 「metadata取得できたら所有権登録する」経路を削除し、作成/復元成功イベントのみ登録許可に変更
5. `touchProject` に `ownerId` 引数を追加し、DB版移行時に `WHERE project_id = ? AND owner_id = ?` で更新できるようにする
6. CloudSyncThrottle をDB（または共有KVS）に移行し、分散環境でのスロットル重複を防ぐ（優先度は低）
7. 本番で `ALLOW_ANON_OPENREFINE_UI` / `ALLOW_ANON_PROJECT_CREATE` を必ず `false` に固定
8. E2E追加（2ユーザー同時ログイン、相互project IDアクセス禁止、インスタンス跨ぎ認可）

## 5. 最終結論

このコミット時点（`3b3def...`）では、  
**単一ユーザーまたは検証用途なら動作するが、複数ユーザー同時利用を安全に支える設計・実装としては未達**です。

