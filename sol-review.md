# RAG Architecture Full-Flow Review

**Date:** 2026-08-08  
**Branch reviewed:** `main` at `ab04c4e`  
**Comparison point:** `18a688d...HEAD` (74 commits, 89 files, +11,046 / -3,185)  
**Primary spec:** `docs/superpowers/specs/2026-08-08-rag-architecture-improvement-design.md`

## Verdict

**Chưa nên coi RAG flow hiện tại là hoàn tất hoặc production-ready.** Unit tests và build đều pass, nhưng full flow còn bốn lỗi correctness/architecture quan trọng:

1. FTS chỉ index 400 ký tự đầu của chunk, làm mất recall ở phần còn lại.
2. `code_query` không kích hoạt lazy graph build, nên graph expansion thường không chạy sau lần index đầu.
3. Incremental reindex không persist trạng thái graph thành `pending`, nên UI/MCP có thể tiếp tục dùng graph cũ.
4. Phase "ANN bằng sqlite-vec" hiện không thực sự hoạt động: extension không load được trong Bun hiện tại, và `sqlite-vec@0.1.9` vẫn là brute-force KNN thay vì ANN.

Ưu tiên sửa correctness của FTS và graph lifecycle trước. Sau đó cần quyết định rõ vector path: chấp nhận linear scan hay đổi runtime/build và thư viện để có ANN thật.

## Current Flow

```text
indexWorkspace
  -> scan/read files
  -> parse documents
  -> persist documents + chunks
  -> FTS index                    [chỉ 400 ký tự đầu]
  -> optional embeddings as BLOB
  -> parsed-document cache
  -> invalidate graph in memory   [không persist pending]

code_query
  -> wait for FTS
  -> FTS search
  -> vector search
       -> sqlite-vec if available [không reachable trên Bun hiện tại]
       -> JS BLOB linear scan
  -> RRF merge
  -> graph expansion              [không đảm bảo graph đã build]
  -> token-budgeted response

code_context / graph_neighbors
  -> explicit lazy graph build
  -> graph query

Web query
  -> codeQuery(skipGraphExpand=true)
  -> direct graphNeighbors
  -> repository graph_pending path [không có writer set pending]
```

## Findings

### Blocker 1: FTS làm mất nội dung sau ký tự thứ 400

**Evidence**

- `packages/db/src/sqlite/fts-repository.ts` tạo `search_text` từ `item.content.slice(0, 400)`.
- FTS triggers dùng `substr(new.content, 1, 400)`.
- Metadata `searchText` trước đây được dùng để tăng khả năng tìm theo path/symbol nhưng hiện bị bỏ qua.
- Runtime probe với token duy nhất nằm sau ký tự 500 trả về `0` kết quả.

**Impact**

- Đây là silent recall loss. Chunk vẫn tồn tại trong DB nhưng query không thể tìm thấy nội dung ở phần cuối.
- Embeddings là optional, vì vậy FTS phải là retrieval path đáng tin cậy chứ không thể chỉ là preview index.
- Thay đổi này vi phạm mục tiêu Phase 1 là tách repository mà không đổi behavior.

**Required update**

- Index toàn bộ nội dung chunk vào FTS.
- Ghép normalized metadata `searchText` với content thay vì bỏ metadata.
- Nếu cần giới hạn dung lượng, giới hạn ở bước chunking, không cắt âm thầm trong FTS repository.
- Rebuild/backfill FTS cho database đã index bằng logic 400 ký tự.

**Required tests**

- Tìm token ở đầu, giữa và cuối chunk dài.
- Tìm symbol/path chỉ xuất hiện trong metadata search text.
- Rebuild FTS giữ nguyên kết quả retrieval trước và sau repository split.

### Blocker 2: Default `code_query` không build graph

**Evidence**

- `packages/core/src/retrieval.ts` query graph tables trực tiếp khi graph expansion bật.
- `apps/mcp/src/mcp-core.ts` chỉ gọi `buildGraphForWorkspace` trước `code_context` và `graph_neighbors`; `code_query` không gọi.
- Runtime probe trên workspace mới: graph node count là `0` trước và sau `codeQuery`.
- Web query tắt graph expansion trong `codeQuery` rồi gọi repository traversal riêng, nhưng repository builder phụ thuộc `graph_pending` không được set ở đâu.

**Impact**

- Flow được mô tả là FTS + graph expansion thực tế thường chỉ là FTS/vector sau initial index.
- Chất lượng query phụ thuộc việc người dùng có vô tình gọi graph endpoint trước đó hay không.
- Kết quả không deterministic giữa workspace mới và workspace đã từng mở graph view.

**Required update**

- Tạo một orchestration duy nhất, ví dụ `ensureGraphReady(workspaceId)`.
- Gọi orchestration này từ `code_query`, `code_context`, `graph_neighbors`, web query và graph API khi operation cần graph.
- Không truyền đồng thời `workspaceId` và `rootPath`; resolve root từ canonical workspace registry để tránh pair không khớp.
- Xóa hoặc route repository `ensureGraphBuilt` cũ qua cùng orchestration, không giữ hai graph builders/lifecycles.

**Required tests**

- Workspace mới: gọi duy nhất `code_query`, sau đó graph có nodes và expansion có thể chạy.
- Hai request đồng thời chỉ tạo một graph build.
- Hai workspace cùng basename không dùng chung graph state.

### Blocker 3: Incremental reindex để lại graph cũ ở trạng thái `completed`

**Evidence**

- `invalidateGraphForWorkspace` chỉ cập nhật process-local maps.
- Registry `graphStatus` không được chuyển sang `pending` sau source changes.
- Web graph endpoint chỉ rebuild khi node count bằng `0` hoặc registry status là `pending`.
- Runtime probe: đổi symbol `oldName` thành `newName`, chạy incremental index; registry vẫn `completed`, node count vẫn `2`, graph vẫn chứa `oldName`.

**Impact**

- UI và retrieval có thể trả symbol/edge đã bị xóa.
- Restart process làm mất invalidation state trong memory, khiến stale graph tồn tại lâu dài.

**Required update**

- Persist graph lifecycle trong registry: `pending`, `building`, `completed`, `failed`.
- Khi parsed source ảnh hưởng graph thay đổi, set `pending` trong cùng indexing flow.
- Graph build thành công mới set `completed`; failure phải lưu `failed` cùng error/updated timestamp.
- Dùng generation/content fingerprint để tránh build cũ ghi đè trạng thái của index mới hơn.

**Required tests**

- Rename/delete symbol rồi incremental index phải loại node/edge cũ sau lazy rebuild.
- Restart process sau invalidation vẫn nhận ra graph cần rebuild.
- Index và graph build chạy cạnh nhau không publish graph của generation cũ.

### Blocker 4: sqlite-vec path không cung cấp ANN như spec

**Evidence**

- `packages/db/src/sqlite/database-loader.ts` ghi nhận Bun không load được extension và fallback về `false`.
- Probe trên Bun 1.3.14: `db.loadExtension` tồn tại nhưng trả lỗi `This build of sqlite3 does not support dynamic extension loading`.
- Retrieval vì vậy luôn rơi xuống JavaScript BLOB linear scan.
- Project đang dùng `sqlite-vec@0.1.9`. Bản stable này cung cấp exact/brute-force KNN; ANN mới xuất hiện ở nhánh `0.1.10` alpha, nên kể cả load được extension thì thiết kế hiện tại vẫn chưa đạt complexity goal của ANN.

Official references: [sqlite-vec releases](https://github.com/asg017/sqlite-vec/releases), [sqlite-vec stable release notes](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html), [KNN documentation](https://alexgarcia.xyz/sqlite-vec/features/knn.html).

**Impact**

- Phase 3 hiện chủ yếu thêm schema, loader và fallback complexity nhưng production query vẫn là `O(n)` JS scan.
- Tests có thể pass mà không chạy sqlite-vec path thật.
- Tên/claim ANN tạo kỳ vọng performance sai.

**Required decision**

Chọn một trong hai hướng, không giữ trạng thái nửa vời:

1. **Bun-first, đơn giản:** giữ BLOB linear scan, bỏ claim ANN và bỏ/defer unreachable vec path cho đến khi runtime hỗ trợ đáng tin cậy.
2. **ANN bắt buộc:** chọn runtime/build SQLite có extension loading, dùng implementation có ANN thật, đóng pin version và thêm integration benchmark/test chứng minh ANN path được dùng.

### High 5: Vector schema không theo provider dimension và metric

**Evidence**

- `workspace-db.ts` tạo vec table mặc định dimension `768` và không nhận dimension từ embedding provider.
- `CREATE VIRTUAL TABLE IF NOT EXISTS` không rebuild table khi provider đổi sang `1536` dimensions.
- Insert errors vào vec table bị catch và bỏ qua trong embedding repository.
- Table không khai báo `distance_metric=cosine`, trong khi retrieval dùng `1 - distance` và cosine threshold. sqlite-vec mặc định dùng L2 nếu không cấu hình metric.
- `_vecExtensionLoaded` là global boolean theo DB mở gần nhất, không phải capability theo connection/workspace.

**Impact**

- Provider dimension khác 768 có thể âm thầm rơi xuống fallback.
- Nếu vec path hoạt động, score/threshold có thể sai do L2 bị diễn giải như cosine distance.
- Mở workspace thứ hai có thể làm thay đổi behavior workspace thứ nhất.

**Required update**

- Persist embedding model, dimensions và metric trong workspace metadata.
- Tạo/rebuild vec table theo dimension thực tế.
- Cấu hình cosine metric rõ ràng hoặc sửa score semantics cho L2.
- Không swallow schema/dimension errors; expose trạng thái degraded rõ ràng.
- Track extension capability per DB connection, không dùng module-global boolean.

### High 6: Auto migration xóa embeddings trái spec

**Evidence**

- `workspace-db.ts` tự động xóa embeddings cũ và drop table khi phát hiện TEXT embedding schema.
- Spec yêu cầu full reindex và ghi rõ không auto-migrate dữ liệu vector cũ.

**Impact**

- Mở DB có thể gây data loss ngoài ý muốn.
- Lần index tiếp theo có thể phát sinh chi phí remote embedding lớn.

**Required update**

- Dừng destructive migration khi open DB.
- Fail với thông báo/action rõ ràng, hoặc cung cấp command reindex/migrate explicit.
- Nếu BLOB cũ có thể decode an toàn, migration phải transactional và được test recovery.

### High 7: Typecheck gate đang đỏ

**Evidence**

- `pnpm typecheck` thất bại với 62 errors trong 28 files.
- Nhóm lỗi chính: thiếu types cho `bun:test`, `bun:sqlite`, global `Bun`, `ImportMeta.dir`; web có `unknown`/implicit `any`; một số parser tests gọi sai signature.

**Impact**

- Build pass không chứng minh source/test code type-safe.
- Các runtime-specific assumptions chưa được biểu diễn đúng trong tsconfig/types.

**Required update**

- Chuẩn hóa Bun types trong package test/runtime tsconfig.
- Sửa web unknown/implicit-any thay vì nới compiler.
- Sửa parser test signatures.
- Đưa `pnpm typecheck` thành merge gate bắt buộc.

### Medium 8: Oxc extraction chưa tạo graph đầy đủ cho nested functions và methods

**Evidence**

- Oxc parser discover nested callables và emit call expressions theo caller name.
- Nested callables không được thêm vào public `definedSymbols`.
- Graph builder chỉ tạo symbol nodes từ `definedSymbols`, nên không resolve được nested caller node để tạo edge.
- Class methods cũng chưa có symbol/call-graph coverage tương đương rich TS path.

**Impact**

- Parser test có thể thấy `callExpressions`, nhưng graph thực tế vẫn thiếu edge.
- Retrieval graph expansion bỏ qua nhiều quan hệ phổ biến trong TS/JS.

**Required update**

- Quyết định nested functions/methods là first-class symbols hay map call về enclosing symbol.
- Thêm graph integration tests, không chỉ parser unit tests.
- Nếu Oxc là quyết định chính thức, cập nhật `AGENTS.md` đang còn ghi TS/JS dùng `ts-morph`.

### Medium 9: Fast token mode là global mutable state

**Evidence**

- `setFastTokenCount` thay đổi module-global `_fastMode`.
- MCP catch-up index nhiều workspaces bằng `Promise.all`.
- Một index kết thúc có thể reset fast mode trong lúc index khác còn chạy; retrieval cùng process cũng có thể nhận approximate counting.

**Impact**

- Token budgeting phụ thuộc timing giữa requests/workspaces.
- `try/finally` xử lý leak khi exception nhưng không xử lý concurrency.

**Required update**

- Truyền token-count strategy theo call/context thay vì global state.
- Nếu cần patch nhỏ trước mắt, dùng reference count; giải pháp đúng vẫn là scoped dependency.

### Medium 10: Native fallback parse cache không hit

**Evidence**

- Graph build chỉ accept cache entry có parser version `native-v1`.
- Khi native parser không available, fallback lưu `fallback-v1`, nhưng lần sau lại bị reject.

**Impact**

- Workspace không có native binary bị reparse Python/Go/Rust ở mỗi graph build.

**Required update**

- Cache key phải bao gồm parser identity/version thực tế và chấp nhận entry tương ứng với parser sẽ dùng.
- Test graph rebuild hai lần khi native loader fail; lần hai không parse lại file unchanged.

### Low 11: Hai graph builders và lifecycle không thống nhất

**Evidence**

- Rich graph builder nằm trong `packages/indexer/src/index-workspace.ts`.
- `packages/db/src/sqlite/graph-traversal-ops.ts` có `ensureGraphBuilt` riêng dựa vào `graph_pending`.
- Không tìm thấy writer set `graph_pending=1`; path này hiện gần như dormant.

**Impact**

- Dễ sửa một path nhưng web/MCP chạy path khác.
- Đây là nguyên nhân trực tiếp làm lifecycle lazy graph khó kiểm chứng.

**Required update**

- Một graph service sở hữu build, invalidation, locking và state transitions.
- DB repositories chỉ làm persistence/query, không tự quyết định orchestration.

### Low 12: Scope và maintainability

- `index-workspace.ts` đã khoảng 1,600 dòng và chứa scanning, parsing, cache, FTS, embeddings, graph và profiling logs.
- Có nhiều timing logs ghi thẳng `stderr` trên normal path.
- Native loader logic bị lặp ở scanner/indexing paths.
- Repository split thêm nhiều submodules ngoài spec; hai repository hơi vượt target 300 dòng.

Không nên block correctness fixes để refactor lớn. Sau khi ổn định flow, tách orchestration theo responsibility và gate profiling logs bằng debug flag.

## Standards Review

### Hard violations

1. Global `_vecExtensionLoaded` không an toàn cho multi-workspace/multi-connection.
2. `buildGraphForWorkspace(workspaceId, rootPath)` cho phép identity/path không khớp; `workspaceId` phải là canonical key và root phải resolve từ registry.
3. Implementation dùng Oxc nhưng `AGENTS.md` vẫn quy định TS/JS richest path qua `ts-morph`.
4. Tests chuyển sang `bun:test` trong khi `CONTRIBUTING.md` vẫn yêu cầu focused Vitest tests.
5. Diff 74 commits/89 files trộn RAG refactor, parser replacement, native scanner và test-runtime migration, trái nguyên tắc focused change.

### Design smells

1. Native loader bị duplicate.
2. Graph construction/lifecycle bị duplicate.
3. Tên `PARSER_VERSION_TS_MORPH` gây hiểu nhầm khi cache chứa Oxc/Markdown/config parsing.
4. `GraphOpsDeps`/`FtsOpsDeps` và `graph_pending` tạo abstraction/lifecycle chưa được sử dụng đầy đủ.

**Standards summary:** 5 hard violations, 4 design smells. Nghiêm trọng nhất là global per-process capability/state trong hệ multi-workspace và graph orchestration không có canonical owner.

## Implementation Plan

Remediation plan theo chuẩn Superpowers: [`docs/superpowers/plans/2026-08-09-rag-flow-correctness-remediation.md`](docs/superpowers/plans/2026-08-09-rag-flow-correctness-remediation.md).

Plan ưu tiên correctness theo dependency: FTS lossless, persisted graph lifecycle, canonical graph service, Bun-first embedding path, scoped tokenizer/parser cache, Oxc graph coverage, rồi mới đóng toàn bộ verification gates.

## Spec Review

### Missing or partial

1. **P0:** ANN path không reachable trong supported Bun runtime, và dependency hiện tại chưa cung cấp ANN stable.
2. **P1:** Vector dimensions cố định 768, không match provider hoặc rebuild khi đổi model.
3. **P1:** Old embedding schema bị auto-delete trái yêu cầu explicit full reindex.
4. **P1:** Lazy graph lifecycle làm default query thiếu graph và incremental index để lại stale graph.
5. **P2:** Native fallback cache không reuse `fallback-v1` entries.

### Scope creep

1. Oxc thay ts-morph.
2. Rust native scanner và Cargo project.
3. Graph repository bị chia thêm nhiều lớp ngoài thiết kế.
4. Chunk repository tách riêng dù spec đặt chunks cùng document repository.
5. Parsed cache thêm `called_identifiers` và `parser_version` ngoài schema mô tả.
6. Indexer tokenizer và migration sang Bun test runner không thuộc bốn phases.

**Spec summary:** 5 missing/partial findings và 6 scope-creep items. Nghiêm trọng nhất là Phase 3 không đạt mục tiêu ANN trong runtime thực tế.

## Recommended Update Plan

### Phase 1: Restore retrieval correctness

1. Bỏ FTS 400-character truncation; restore metadata search text.
2. Thêm FTS rebuild/backfill command hoặc automatic safe rebuild theo schema/index version.
3. Tạo `ensureGraphReady(workspaceId)` làm canonical graph orchestration.
4. Persist graph lifecycle và generation; invalidate khi source graph inputs thay đổi.
5. Gọi graph orchestration từ mọi entry point cần graph, bao gồm `code_query` và web query.

**Exit gate:** fresh index + chỉ gọi `code_query` phải có graph expansion; rename/delete symbol không trả graph cũ; long-chunk token được tìm thấy.

### Phase 2: Make the vector design truthful

1. Chọn linear BLOB hoặc ANN thật.
2. Nếu giữ linear BLOB, bỏ/defer sqlite-vec complexity và cập nhật spec/performance claims.
3. Nếu giữ sqlite-vec, chứng minh extension load trong production runtime, cấu hình cosine metric, hỗ trợ dynamic dimensions và dùng per-connection capability.
4. Không swallow vec errors; expose fallback reason và telemetry.

**Exit gate:** integration test xác nhận path thực tế được dùng; 768/1536 dimensions; score ordering đúng; benchmark thể hiện complexity/performance claim.

### Phase 3: Safe migration and concurrency

1. Thay destructive auto migration bằng explicit migration/reindex workflow.
2. Scope token-count mode theo operation, bỏ module-global boolean.
3. Dùng workspace registry làm nguồn duy nhất cho root path và graph status.

**Exit gate:** mở old DB không tự xóa embeddings; concurrent multi-workspace index/query có deterministic token and graph behavior.

### Phase 4: Parser and cache completeness

1. Chốt Oxc là canonical TS/JS parser và cập nhật docs, hoặc restore ts-morph contract.
2. Hoàn thiện nested function/class method graph semantics.
3. Sửa fallback parser cache identity/version.
4. Thêm end-to-end graph tests thay vì chỉ parser unit tests.

### Phase 5: Restore engineering gates

1. Sửa toàn bộ `pnpm typecheck` errors.
2. Giữ targeted RAG Prettier check; exclude generated/hidden artifacts khỏi root format scan.
3. Gate timing logs bằng debug flag.
4. Sau correctness fixes mới tách `index-workspace.ts` và xóa duplicate graph/native orchestration.

## Verification Performed

| Check                                            | Result                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `bun test`                                       | Pass: 144 passed, 1 skipped, 0 failed                            |
| `pnpm build:web`                                 | Pass; Vite cảnh báo bundle khoảng 630 KB                         |
| `pnpm build:cli`                                 | Pass; CLI bundle khoảng 3.24 MB                                  |
| `pnpm typecheck`                                 | **Fail:** 62 errors trong 28 files                               |
| Targeted Prettier trên DB/core/indexer RAG files | Pass                                                             |
| Root `pnpm format:check`                         | Fail; scan 239 generated/hidden files ngoài focused source scope |
| Fresh workspace `codeQuery` graph probe          | **Fail:** node count vẫn 0                                       |
| Incremental rename graph probe                   | **Fail:** graph vẫn giữ `oldName`, status `completed`            |
| Long chunk FTS probe                             | **Fail:** token sau ký tự 500 trả 0 hits                         |
| Bun sqlite extension probe                       | **Fail:** dynamic extension loading unsupported                  |

## Release Gate

### Must fix before next release

- FTS full-content recall.
- Canonical lazy graph build/invalidation, bao gồm `code_query` và web flow.
- Quyết định vector architecture và sửa claim/spec cho đúng runtime.
- `pnpm typecheck` xanh.

### Should fix immediately after

- Safe embedding migration.
- Vector dimension/metric/per-connection state.
- Scoped fast-token behavior.
- Oxc nested/method graph integration coverage.

### Can defer

- Chia nhỏ `index-workspace.ts`.
- Gom native loader.
- Dọn timing logs và các repository vượt target vài dòng.
