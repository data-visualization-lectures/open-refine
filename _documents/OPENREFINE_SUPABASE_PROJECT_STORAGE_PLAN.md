# OpenRefine Supabase 保存基盤設計メモ

## 目的

- 既存の Supabase 認証基盤（ログイン状態・サブスク判定）はそのまま再利用する。
- OpenRefine のプロジェクト保存/復元（`tar.gz`）を、既存ツールの JSON 保存仕様と分離して実装する。
- 既存の `projects` API/テーブル（JSON + thumbnail）への影響を最小化する。

## 結論

- **OpenRefine 専用テーブルを新設する方針を採用する。**
- 既存の汎用 `projects` に混在させない。

理由:
- 既存 API は「JSON本体を返す」契約で、OpenRefine は「アーカイブファイル（`tar.gz`）」契約。
- 既存ツールへの回帰リスクを避けられる。
- OpenRefine 側の運用要件（サイズ、復元時間、バージョン互換）を独立管理できる。

## 対象範囲

- 本計画は「保存/復元基盤」の設計のみ。
- 既存の匿名作成モード（`/api/refine/upload`）は開発確認用途として維持。
- この段階ではコード変更は行わない。

## データモデル案

### 1) DBテーブル（新設）

テーブル名（案）: `public.openrefine_projects`

主要カラム:
- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null references auth.users(id) on delete cascade`
- `name text not null`
- `archive_path text not null`  (Supabase Storage 上の `tar.gz` パス)
- `thumbnail_path text null`  (任意)
- `openrefine_version text null`
- `source_filename text null`
- `size_bytes bigint null`
- `created_at timestamptz default now()`
- `updated_at timestamptz default now()`

推奨インデックス:
- `(user_id, updated_at desc)`

RLS方針:
- `auth.uid() = user_id` のみ許可（select/insert/update/delete）

### 2) Storage（新設）

バケット名（案）: `openrefine-projects`

パス規約:
- `{user_id}/{project_id}/project.tar.gz`
- 任意サムネイル: `{user_id}/{project_id}/thumbnail.png`

運用項目:
- 最大サイズ制限（例: 200MB など）
- MIME/拡張子チェック
- 将来のライフサイクルルール（長期未使用のアーカイブ整理）

## API設計（新規名前空間）

既存 `api/projects` とは分離し、OpenRefine 専用 API を用意する。

エンドポイント案:
- `GET /api/openrefine/projects`
- `POST /api/openrefine/projects`
- `GET /api/openrefine/projects/:id`
- `GET /api/openrefine/projects/:id/download`
- `POST /api/openrefine/projects/:id/restore`
- `DELETE /api/openrefine/projects/:id`

認証:
- 既存と同じ Supabase セッション/Bearer 方式を使用

## 連携フロー

### A. 保存フロー

1. 現在開いている OpenRefine プロジェクトを `export-project` で取得（`tar.gz`）。
2. `openrefine-projects` バケットへアップロード。
3. `openrefine_projects` にメタデータを登録。
4. クライアントへ `project_id`（UUID）を返す。

### B. 復元フロー

1. `openrefine_projects` から対象レコードを取得。
2. `archive_path` の `tar.gz` をダウンロード。
3. OpenRefine の `import-project` へ投入。
4. OpenRefine 側の新しい `numeric projectId` を受け取り、現セッションへ接続。

## 互換性・移行方針

- 既存 `projects` テーブル/API は変更しない。
- 既存ツール（JSON前提）には影響を与えない。
- OpenRefine のみ段階導入し、安定後に共通抽象化を検討する。

## リスクと対策

- 大容量ファイルで失敗しやすい:
  - サイズ上限、タイムアウト、再試行、進捗表示を導入する。
- 復元互換性（OpenRefine バージョン差）:
  - `openrefine_version` を保存し、警告表示に利用する。
- コスト増（Storage/帯域）:
  - 使用量監視と不要ファイル掃除ポリシーを運用する。

## 実装ステップ（次フェーズ）

1. Supabase migration 作成（`openrefine_projects` + RLS）。
2. Storage バケット作成とポリシー整備。
3. OpenRefine 専用 API の追加。
4. フロントエンドに Save/Restore UI 追加。
5. E2E 検証（保存→復元→再編集）。
6. 監視項目（失敗率、復元時間、容量）を可視化。

