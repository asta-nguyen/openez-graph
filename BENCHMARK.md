# Retrieval Benchmark

Ngày chạy: 2026-07-22

## Phạm vi

- Workspace: `openez`
- Index: 117 files, 632 chunks
- Tập đánh giá: 18 truy vấn trong `tests/fixtures/retrieval-eval.json`
- Số lần lặp: 3, tổng cộng 54 runs cho mỗi chế độ
- FTS: SQLite FTS5 BM25 trên path, heading, identifier search terms và content
- Graph: path-level expansion, tối đa 4 hops từ 5 lexical seeds
- Embedding: Ollama `nomic-embed-text`
- Retrieval: embedding chỉ làm semantic fallback khi FTS không có kết quả

`BENCHMARK.md` và fixture đánh giá được loại khỏi workspace index để tránh data leakage.

## Lệnh chạy

Không dùng embedding:

```bash
EMBEDDING_PROVIDER=none \
pnpm benchmark:retrieval --iterations 3 --fail-on-quality
```

Dùng Ollama embedding:

```bash
EMBEDDING_PROVIDER=ollama \
OLLAMA_EMBEDDING_MODEL=nomic-embed-text \
pnpm benchmark:retrieval --iterations 3 --fail-on-quality
```

Reindex embedding trước khi benchmark nếu model hoặc embedding format thay đổi:

```bash
EMBEDDING_PROVIDER=ollama \
OLLAMA_EMBEDDING_MODEL=nomic-embed-text \
pnpm reindex /path/to/workspace
```

## Kết quả

| Metric | Không embedding | Ollama embedding |
| --- | ---: | ---: |
| Recall@5 | 94.44% | 94.44% |
| Hit queries | 17/18 | 17/18 |
| MRR | 0.7009 | 0.7009 |
| Duplicate path rate | 0% | 0% |
| Latency trung bình | 17.85 ms | 112.88 ms |
| Latency p50 | 11.74 ms | 90.45 ms |
| Latency p95 | 51.22 ms | 272.30 ms |
| Context tokens trung bình | 2,938.2 | 2,938.2 |
| Sources trung bình | 12 | 12 |
| Quality gate | PASS | PASS |

Quality gate:

- Recall@5 >= 0.80
- MRR >= 0.60
- Duplicate path rate <= 0.20

So với baseline trước khi cải thiện retrieval:

- Recall@5: 83.33% -> 94.44%
- MRR: 0.6176 -> 0.7009
- Miss queries: 3 -> 1
- Duplicate path rate giữ ở 0%

## Query còn miss

`where are TypeScript symbols extracted?`

- Expected: `packages/indexer/src/code.ts`
- Rank hiện tại: 7
- Top result: `packages/indexer/src/languages.ts`
- Nguyên nhân: lexical và Ollama đều ưu tiên module generic symbol extraction; `code.ts` chỉ thể hiện quan hệ TypeScript qua `ts-morph` và graph sibling dependency.

## Kết luận

FTS + graph đạt quality tốt hơn baseline và sửa được hai query implementation phổ biến: workspace indexing lên rank 3, MCP server implementation lên rank 3. Tập eval còn một miss ở rank 7 nên chưa nên xem 94.44% là mức trần ổn định; cần mở rộng dataset trước khi tăng gate.

Ollama không tăng Recall hoặc MRR trên tập query hiện tại vì FTS có lexical match cho cả 18 query. Ollama làm latency trung bình tăng khoảng 6.3 lần và p95 tăng khoảng 5.3 lần. Mặc định nên dùng FTS-only; chỉ bật Ollama khi cần semantic fallback cho query không có lexical match.
