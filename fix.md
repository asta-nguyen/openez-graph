# OpenEZ remediation plan

## Mục tiêu

Sửa các lỗi đã xác nhận trong đợt review MCP-first, theo thứ tự: bảo vệ dữ liệu và source code, khôi phục tính đúng của index/graph, sửa luồng web, sau đó tối ưu incremental indexing và dependency.

Không đổi kiến trúc SQLite-first, không thêm Postgres/Redis/job queue, không biến web UI thành runtime trung tâm.

## Baseline đã xác nhận

- MCP incremental index: 119 file scanned, 0 file changed, 116 ms.
- Workspace DB: 119 documents, 663 chunks, 663 FTS rows.
- FTS không thiếu/orphan row; graph không có dangling edge.
- Graph có 27 nhóm edge trùng, tổng cộng 59 row dư.
- Test hiện tại: 57/57 pass.
- `pnpm audit --prod`: 41 advisory (1 critical, 18 high, 20 moderate, 2 low).
- `pnpm lint` hiện không chạy task lint nào.
- Worktree hiện tại xóa `routes/jobs.tsx` nhưng chưa cập nhật `routeTree.gen.ts`; typecheck trực tiếp có thể fail trước khi Vite regenerate file.

## Thứ tự triển khai

1. Khóa web server vào loopback.
2. Ngăn full reindex xóa memory/history.
3. Giữ graph đúng sau incremental update.
4. Chống duplicate edge và dọn dữ liệu hiện có.
5. Làm endpoint web index chạy thật.
6. Giảm I/O của incremental/MCP catch-up.
7. Cập nhật dependency và xử lý advisory.
8. Sửa generated route/typecheck và quality gate.

Mỗi mục nên là một commit độc lập và pass test trước khi sang mục tiếp theo.

---

## FIX-01 — Web API có thể lắng nghe ngoài localhost

**Mức độ:** High — security

**Root cause**

`@hono/node-server` được gọi chỉ với `port`. Node sẽ listen trên unspecified address thay vì bảo đảm loopback, trong khi API không có authentication. CORS không phải access control: client HTTP trực tiếp vẫn có thể gọi API để liệt kê workspace, đọc graph/context hoặc thay đổi registry.

**File liên quan**

- `apps/cli/src/cli.ts`
- `apps/web/src/server/start.ts`
- `apps/web/src/server/index.ts`

**Cách sửa tối thiểu**

1. Truyền `hostname: "127.0.0.1"` vào cả hai lệnh `serve(...)`.
2. Log đúng URL đang bind, không chỉ in `localhost` khi host thực tế khác.
3. Không thêm authentication ở default local-only path.
4. Không thêm `--host 0.0.0.0` trong fix này. Nếu sau này cần remote access, làm feature riêng có token bắt buộc.

**Test hồi quy**

- Start server với port ngẫu nhiên và assert `server.address().address` là `127.0.0.1`.
- Smoke test `GET /api/workspaces` từ loopback vẫn hoạt động.
- Xác nhận CLI và standalone web server dùng cùng policy.

**Done khi**

- Không có listener `0.0.0.0`/`::` mặc định.
- API local vẫn hoạt động qua `127.0.0.1` và `localhost`.

**Commit đề xuất:** `fix(web): bind management API to loopback`

---

## FIX-02 — Full reindex xóa memory và lịch sử

**Mức độ:** High — data loss

**Root cause**

`indexWorkspace(..., mode: "full")` gọi `repo.resetAll()`. Hàm này xóa cả `memories`, `query_logs`, `index_runs` và `graph_runs`, dù chúng không phải artifact cần rebuild. Repro đã xác nhận memory count đổi từ 1 xuống 0.

**File liên quan**

- `packages/indexer/src/index-workspace.ts`
- `packages/db/src/sqlite/repository.ts`
- `packages/db/src/sqlite/types.ts`
- `tests/index-workspace.test.ts`

**Cách sửa tối thiểu**

1. Đổi `resetAll()` thành hàm có scope rõ, ví dụ `resetIndexArtifacts()`.
2. Chỉ xóa dữ liệu có thể tái tạo:
   - `graph_edges`
   - `graph_nodes`
   - `embeddings`
   - `chunks`
   - `documents`
3. Giữ nguyên:
   - `memories`
   - `query_logs`
   - `index_runs`
   - `graph_runs`
4. Giữ thứ tự delete phù hợp foreign key.
5. Full reindex tạo thêm một `index_runs` row mới thay vì xóa lịch sử cũ.

**Test hồi quy**

Một test duy nhất tạo workspace, index, ghi memory và query log, chạy full reindex, sau đó assert:

- memory còn nguyên;
- query log cũ còn nguyên;
- run history cũ còn nguyên và có thêm full run completed;
- documents/chunks/graph phản ánh source hiện tại, không duplicate.

**Done khi**

- `openez reindex` không xóa dữ liệu người dùng hoặc observability history.
- Không còn API tên `resetAll` dễ bị dùng sai scope.

**Commit đề xuất:** `fix(indexer): preserve memory and run history on full reindex`

---

## FIX-03 — Incremental index làm mất inbound call/import edge

**Mức độ:** High — index correctness

**Root cause**

Khi một document thay đổi, `resetDocumentArtifacts()` xóa file/symbol/chunk nodes. Foreign-key cascade xóa mọi edge đi vào các node đó. Indexer chỉ parse và dựng edge cho file thay đổi, nên caller/importer không thay đổi sẽ không tạo lại inbound edge.

Repro đã xác nhận:

1. `caller.ts` gọi `helper()` trong `helper.ts`.
2. Initial index cho `helper` có 1 caller.
3. Chỉ sửa implementation của `helper.ts`.
4. Incremental index xong, `helper` còn 0 caller.

**File liên quan**

- `packages/indexer/src/index-workspace.ts`
- `packages/db/src/sqlite/repository.ts`
- `packages/db/src/sqlite/types.ts`
- `tests/index-workspace.test.ts`

**Hướng sửa**

Giữ identity của logical graph nodes ổn định; chỉ thay artifact phụ thuộc content.

1. File node dùng identity `(type=file, label=relativePath)` và không bị xóa khi nội dung file thay đổi.
2. Symbol node dùng identity `(filePath, symbolName)`:
   - tìm và reuse symbol node cũ nếu symbol vẫn tồn tại;
   - cập nhật `ref_id` sang chunk mới;
   - xóa symbol node chỉ khi symbol thực sự biến mất hoặc đổi tên.
3. Trước khi rebuild file thay đổi, xóa các outgoing edge sẽ được tạo lại:
   - từ file: `contains`, `defines`, `imports`, `mentions`;
   - từ symbol thuộc file: `calls`, `represented_by`.
4. Không xóa inbound `imports`/`calls` trỏ tới file hoặc symbol vẫn tồn tại.
5. Sau khi parse, reconcile danh sách symbol cũ và mới; symbol cũ không còn xuất hiện mới bị delete, để cascade dọn inbound edge stale đúng lúc.
6. File bị xóa khỏi workspace vẫn xóa toàn bộ file node, symbol node và inbound edge như hiện tại.

**Repository API tối thiểu cần thêm**

- Lấy file node theo path.
- Lấy symbol nodes được file định nghĩa.
- Xóa edge theo `from_node_id` và nhóm type.
- Update symbol `ref_id`/metadata.
- Xóa tập symbol không còn tồn tại.

Không tạo graph service/factory mới; các helper này nằm trong SQLite repository hiện có.

**Test hồi quy**

- Sửa body của callee: caller edge vẫn còn đúng 1.
- Sửa file được import: inbound import edge vẫn còn đúng 1.
- Xóa/rename callee symbol: inbound call edge bị xóa.
- Xóa target file: inbound import/call edge bị xóa.
- Sửa caller: outgoing call edge được thay thế, không duplicate.
- Chạy incremental hai lần không đổi source: counts ổn định.

**Done khi**

- `code_context` trả caller/import relationships giống nhau trước và sau khi chỉ sửa implementation.
- Không cần full reindex để sửa graph sau mỗi edit.

**Commit đề xuất:** `fix(indexer): preserve inbound graph edges across incremental updates`

---

## FIX-04 — Duplicate graph edges

**Mức độ:** Medium — correctness/performance

**Root cause**

- Symbol chunk bị split vẫn push nhiều edge `file -> symbol (defines)` giống nhau.
- `importPaths` có thể chứa nhiều import cùng trỏ tới một target.
- DB không có unique constraint cho logical edge `(from_node_id, to_node_id, type)`.

Live DB hiện có 24 nhóm `defines` trùng và 3 nhóm `imports` trùng.

**File liên quan**

- `packages/indexer/src/index-workspace.ts`
- `packages/db/src/sqlite/workspace-db.ts`
- `packages/db/src/sqlite/repository.ts`
- `tests/index-workspace.test.ts`

**Cách sửa**

1. Trong indexer, dedupe edge theo key `from:to:type` trước khi gọi `insertEdges`.
2. Dedupe `importPaths` bằng `Set` trước vòng resolve.
3. `defines` chỉ thêm một lần cho mỗi file-symbol; `represented_by` vẫn giữ một edge cho mỗi chunk biểu diễn symbol.
4. Thêm unique index SQLite cho `(from_node_id, to_node_id, type)` làm safety net.
5. Trước khi tạo unique index trên DB cũ, xóa duplicate và giữ một row canonical.
6. Đổi insert thành `ON CONFLICT DO NOTHING` hoặc upsert metadata/weight nếu semantics yêu cầu cập nhật. Ưu tiên `DO NOTHING` nếu payload giống nhau.

**Test hồi quy**

- Symbol lớn bị split nhiều chunk: một `defines`, nhiều `represented_by`.
- Hai import statement cùng target: một `imports` edge.
- Reindex lặp lại không tăng edge count.
- Migration chạy được trên DB đang có duplicate.

**Done khi**

- Query duplicate-edge trên live fixture trả 0.
- Graph expansion không bị tăng degree/ranking giả do duplicate.

**Commit đề xuất:** `fix(graph): enforce unique logical edges`

---

## FIX-05 — Endpoint web báo indexing nhưng không chạy index

**Mức độ:** Medium — functional correctness

**Root cause**

`POST /api/workspaces/:id/index` chỉ set registry status thành `running` và trả random job ID. Không có lời gọi `indexWorkspace`, nên trạng thái có thể treo vĩnh viễn.

**File liên quan**

- `apps/web/src/server/index.ts`
- `apps/web/src/lib/api.ts`
- route workspace gọi `startIndexRun`

**Cách sửa tối thiểu**

1. Validate `mode` chỉ nhận `incremental` hoặc `full`.
2. Gọi `indexWorkspace({ workspaceId: id, mode })` thật.
3. Với local management UI, chạy request đồng bộ trước để tránh thêm job abstraction giả:
   - success: trả summary và `status: "completed"`;
   - failure: trả HTTP 500 cùng error an toàn;
   - registry/index run status do `indexWorkspace` quản lý.
4. Xóa random `jobId` nếu không có job store/cancel semantics thật.
5. Cập nhật API type và UI mutation theo response thực tế.

Nếu thời gian index thực tế làm HTTP timeout, khi đó mới thêm in-memory per-workspace promise map; không thêm queue/worker trong fix đầu tiên.

**Test hồi quy**

- POST incremental làm thay đổi document/chunk khi fixture source đổi.
- POST full chạy đúng nhưng vẫn giữ memory theo FIX-02.
- Invalid mode trả 400.
- Unknown workspace trả 404.
- Index failure trả error và registry status `failed`, không treo `running`.

**Done khi**

- UI bấm index tạo một `index_runs` completed/failed thật.
- Không còn fake job ID hoặc fake cancel endpoint.

**Commit đề xuất:** `fix(web): run indexing from workspace endpoint`

---

## FIX-06 — Incremental/MCP catch-up đọc lại toàn workspace

**Mức độ:** Medium — performance

**Root cause**

Mỗi incremental run scan rồi đọc/hash toàn bộ file trước khi xác định file unchanged. MCP gọi catch-up trước read tools sau mỗi cửa sổ 5 giây, nên workspace lớn chịu I/O lặp lại dù không có thay đổi.

**File liên quan**

- `packages/indexer/src/index-workspace.ts`
- `packages/indexer/src/scanner.ts`
- `packages/db/src/sqlite/repository.ts`
- `apps/mcp/src/mcp-core.ts`

**Cách sửa theo thứ tự**

1. Dùng `repo.listDocuments()` một lần và tạo `Map<path, document>`; bỏ N query `getDocumentByPath` trong vòng lặp.
2. Dựa trên `mtime_ms + size_bytes` để chọn candidate trước khi đọc content.
3. Chỉ đọc/hash/parse file mới hoặc candidate thay đổi.
4. Chỉ load chunks của unchanged files khi embedding provider đang bật và thật sự cần backfill embedding.
5. Nếu không có file thêm/sửa/xóa:
   - kết thúc no-op sớm;
   - không drop/recreate FTS triggers;
   - không bật optimized write mode;
   - cân nhắc không tạo run history spam, hoặc ghi một no-op run nếu observability yêu cầu.
6. Giữ `catchupState.inFlight` hiện tại để dedupe các MCP read đồng thời.
7. Chưa đổi interval 5 giây; đo lại sau tối ưu rồi mới quyết định.

**Giới hạn đã biết**

`mtime + size` có thể bỏ sót filesystem/tool cố tình giữ nguyên cả hai. Nếu cần correctness tuyệt đối cho use case đó, thêm explicit `reindex --full`; không hash lại toàn repo ở mỗi MCP query.

**Benchmark/check**

Đo trên workspace nhỏ hiện tại và ít nhất một workspace >1.000 file:

- cold full index;
- incremental no-op;
- incremental đổi một file;
- MCP `memory_query` ngay sau catch-up interval.

Ghi lại elapsed time, file read count, files updated, DB write count. Test nên spy `fs.readFile` và assert no-op không đọc content file.

**Done khi**

- No-op incremental không đọc/hash 100% source files.
- Thay một file chỉ đọc/parse file đó.
- FTS/graph counts và retrieval tests không đổi ngoài duplicate được dọn.

**Commit đề xuất:** `perf(indexer): skip unchanged file reads during catch-up`

---

## FIX-07 — Dependency advisories

**Mức độ:** High tổng hợp — cần triage theo khả năng khai thác

**Direct dependency cần ưu tiên**

- `drizzle-orm`: nâng tối thiểu lên bản đã vá advisory identifier escaping.
- `hono`: nâng lên bản đã vá toàn bộ advisory hiện có, không chỉ advisory CORS.
- `js-yaml`: nâng lên bản vá quadratic merge-key processing.
- `concurrently`/`shell-quote`: chuyển root `concurrently` sang `devDependencies` vì chỉ dùng script dev; nâng dependency để kéo `shell-quote` đã vá.
- `@modelcontextprotocol/sdk`, `next`, `sharp` và transitive packages: nâng theo workspace sở hữu, sau đó audit lại.

**Cách làm**

1. Lưu output `pnpm audit --prod` trước fix để làm baseline.
2. Update từng nhóm runtime độc lập; không chạy blind `pnpm update --latest` cho toàn monorepo.
3. Với mỗi nhóm, đọc changelog/migration notes và chạy typecheck/test/build của package liên quan.
4. Chạy lại `pnpm audit --prod`.
5. Advisory còn lại phải được ghi rõ một trong ba trạng thái:
   - fixed;
   - not reachable, kèm lý do;
   - accepted temporarily, kèm owner và điều kiện nâng cấp.

**Verification**

- `pnpm test`
- `pnpm typecheck`
- `pnpm build:web`
- `pnpm build:cli`
- MCP smoke test: list, query, context, incremental index.
- `pnpm audit --prod` không còn critical/high reachable advisory.

**Done khi**

- Không còn critical advisory trong production dependency tree.
- Mọi high advisory còn lại có documented reachability decision.

**Commit đề xuất:** tách theo package, ví dụ `chore(db): update drizzle orm security patch`.

---

## FIX-08 — Generated route và quality gate

**Mức độ:** Medium — CI/release reliability

### Generated route

Worktree đang xóa `apps/web/src/routes/jobs.tsx` nhưng generated route tree vẫn import file đó cho đến khi Vite regenerate.

**Fix**

1. Regenerate `apps/web/src/routeTree.gen.ts` bằng tool hiện có.
2. Commit generated diff cùng commit xóa Jobs route.
3. Chạy typecheck từ clean worktree, không dựa vào side effect của `vite build`.

**Check**

- `rg "jobs|Jobs" apps/web/src/routeTree.gen.ts` không còn match.
- `pnpm typecheck` pass ngay trên clean checkout.

### Lint no-op

Root `pnpm lint` hiện thành công dù không chạy task nào.

**Fix tối thiểu**

- Không thêm lint stack mới trong security/index PR.
- Xóa hoặc đổi tên script no-op để CI không tạo false confidence.
- Chỉ thêm ESLint/Biome ở task riêng khi project quyết định rule set.

**Done khi**

- CI không báo “lint passed” khi thực tế chạy 0 task.

**Commit đề xuất:** `fix(web): update generated routes after jobs removal`

---

## Ma trận verification cuối

| Gate | Lệnh/check | Kết quả yêu cầu |
|---|---|---|
| Unit/integration | `pnpm test` | Tất cả pass, có regression tests FIX-02/03/04/05 |
| Type safety | `pnpm typecheck` | Pass từ clean checkout |
| Web build | `pnpm build:web` | Pass |
| CLI build | `pnpm build:cli` | Pass |
| Dependency | `pnpm audit --prod` | 0 critical; high còn lại có triage |
| MCP workflow | `list_workspaces`, `memory_query`, `code_context`, `graph_neighbors` | Resolve đúng workspace và trả context |
| Incremental index | `index_workspace` mode incremental | Đổi một file chỉ update file đó |
| Full index | `index_workspace` mode full | Rebuild artifact nhưng giữ memory/history |
| SQLite integrity | FTS missing/orphan, dangling edge, duplicate edge queries | Tất cả bằng 0 |
| Web security | inspect listener address | Chỉ `127.0.0.1` mặc định |

## Query kiểm tra SQLite

```sql
SELECT count(*) AS missing_fts
FROM chunks c
LEFT JOIN chunks_fts f ON f.chunk_id = c.id
WHERE f.chunk_id IS NULL;

SELECT count(*) AS orphan_fts
FROM chunks_fts f
LEFT JOIN chunks c ON c.id = f.chunk_id
WHERE c.id IS NULL;

SELECT count(*) AS dangling_edges
FROM graph_edges e
LEFT JOIN graph_nodes source ON source.id = e.from_node_id
LEFT JOIN graph_nodes target ON target.id = e.to_node_id
WHERE source.id IS NULL OR target.id IS NULL;

SELECT count(*) AS duplicate_edge_groups
FROM (
  SELECT from_node_id, to_node_id, type
  FROM graph_edges
  GROUP BY from_node_id, to_node_id, type
  HAVING count(*) > 1
);
```

## Non-goals

- Không thêm Postgres, Redis, BullMQ hoặc external queue.
- Không thêm authentication system khi server chỉ bind loopback.
- Không rewrite parser/indexer hoặc chuyển sang tree-sitter trong remediation này.
- Không thêm embedding requirement; FTS + graph vẫn là default.
- Không tối ưu UI bundle trước khi đo ảnh hưởng thực tế.

## Điều kiện kết thúc toàn bộ remediation

Remediation hoàn tất khi FIX-01 đến FIX-08 đều có commit riêng, regression check pass, live workspace được incremental reindex, SQLite integrity queries đều trả 0, và MCP query trong session mới trả graph relationships đúng sau khi sửa một callee file.
