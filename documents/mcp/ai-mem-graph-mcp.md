# Blueprint: WikiLLM + Graph Nexus MCP Server cho project co san

Muc tieu cua tai lieu nay la dua cho Codex mot ban chi tiet de build mot he thong **local memory + code graph + MCP server** co the gan vao project co san. Agent/editor nhu Codex, Cursor, Claude Code, Windsurf co the goi MCP tools de lay context dung hon, giam viec doc code lan man va giam token.

Nguyen tac chinh:

- Dung thu vien co san qua `pnpm`/`pnpx` khi co the.
- Khong viet tay nhung thu framework da lam tot: Next.js install, UI primitives, ORM migration, MCP protocol, queue, parser Markdown, vector DB.
- Chi code tay phan dac thu cua project: schema, ingestion pipeline, retrieval logic, graph expansion, MCP tool handlers.
- Bat dau local-first, tach khoi project chinh, khong lam anh huong runtime app hien tai.
- UI va MCP nen lam viec theo **active workspace**: moi thoi diem user chi dang thao tac voi mot workspace duoc chon. Doi workspace thi detail/query/graph doi sang index rieng cua workspace do.

---

## 1. Kien truc tong quat

He thong nen la mot monorepo rieng, chay canh project chinh:

```text
existing-project/
  src/
  docs/
  package.json

ai-memory-graph/
  apps/
    web/          # Next.js dashboard
    mcp/          # MCP server cho agent/editor
    worker/       # background jobs: ingest, embedding, graph build
  packages/
    db/           # Drizzle schema + DB client
    core/         # retrieval, graph expansion, token budget
    indexer/      # markdown/code parser, chunker
    config/       # config loader
  brain.config.ts # khai bao workspace can index
```

Luon coi project chinh la **input read-only** trong luc index. He thong memory/graph co DB rieng.

```text
Project files / docs / sessions
        |
        v
Indexer + Chunker
        |
        v
Postgres + pgvector + full-text + graph tables
        |
        v
Retriever: BM25/FTS + vector + graph expand + rerank
        |
        v
MCP tools
        |
        v
AI agent/editor
```

Active workspace la identity hien tai cua UI/MCP session:

```text
Workspace setup
  -> set active workspace
  -> index active workspace
  -> build graph for active workspace
  -> show details/query/graph for active workspace only
```

Khong co active workspace thi app chi hien workspace setup/list. Workspace chua index/build graph thi khong duoc xem graph/detail sau cua index; chi hien status va action tiep theo.

---

## 2. Stack de xuat cho fullstack TypeScript

Dung stack nay cho ban san pham nghiem tuc:

- Runtime/package manager: `pnpm`
- Monorepo: `pnpm workspace` + Turborepo
- Language: TypeScript strict
- Web UI: Next.js App Router
- UI components: shadcn/ui + Tailwind
- Database: PostgreSQL + pgvector
- ORM/migrations: Drizzle ORM + drizzle-kit
- Queue/background jobs: BullMQ + Redis
- MCP server: `@modelcontextprotocol/sdk`
- Markdown parsing: `unified`, `remark-parse`, `remark-gfm`, `github-slugger`
- Code parsing for TS/JS: `ts-morph`
- Optional AST parser later: Tree-sitter
- Embeddings:
  - easiest SaaS: OpenAI embeddings
  - code-focused: Voyage embeddings
  - local-first: Ollama
- Token counting: `gpt-tokenizer` or equivalent package
- Validation: `zod`
- Logging: `pino`
- CLI: `commander`
- File watching: `chokidar`

Ly do chon `ts-morph` cho MVP:

- De index TypeScript/JavaScript nhanh hon Tree-sitter.
- Lay import/export/function/class/interface/type de hon.
- Tree-sitter co the them sau cho multi-language va call graph sau hon.

---

## 3. Tao project bang pnpm/pnpx

Khong tao Next.js bang tay. Dung command:

```bash
pnpm create next-app@latest ai-memory-graph --ts --tailwind --eslint --app --src-dir --import-alias "@/*"
cd ai-memory-graph
```

Chuyen thanh monorepo:

```bash
pnpm add -D turbo typescript tsx prettier eslint
```

Tao workspace file:

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
```

Tao cau truc:

```bash
mkdir -p apps/mcp apps/worker packages/db packages/core packages/indexer packages/config
```

Neu `create-next-app` da tao web app o root, Codex nen di chuyen no vao:

```text
apps/web/
```

Khong can viet tay UI primitives neu dung shadcn:

```bash
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button input textarea card table tabs badge dialog dropdown-menu scroll-area separator sheet toast
```

---

## 4. Cai dependencies

Core dependencies:

```bash
pnpm add zod pino dotenv commander chokidar fast-glob
```

Database:

```bash
pnpm add drizzle-orm pg
pnpm add -D drizzle-kit @types/pg
```

Vector and search:

```bash
pnpm add openai gpt-tokenizer
```

Markdown:

```bash
pnpm add unified remark-parse remark-gfm unist-util-visit github-slugger
```

Code indexing:

```bash
pnpm add ts-morph
```

Queue:

```bash
pnpm add bullmq ioredis
```

MCP:

```bash
pnpm add @modelcontextprotocol/sdk
```

Optional graph/UI:

```bash
pnpm add reactflow lucide-react
```

Optional local embeddings via Ollama:

```bash
pnpm add ollama
```

---

## 5. Infrastructure local

Dung Docker Compose cho Postgres + pgvector + Redis.

File de tao:

```yaml
# docker-compose.yml
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: brain
      POSTGRES_PASSWORD: brain
      POSTGRES_DB: brain
    volumes:
      - brain_postgres:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  brain_postgres:
```

Start:

```bash
docker compose up -d
```

Env:

```bash
cp .env.example .env
```

`.env.example`:

```env
DATABASE_URL=postgres://brain:brain@localhost:5432/brain
REDIS_URL=redis://localhost:6379

# Chon mot trong cac provider
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Neu dung Ollama local
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

---

## 6. Config workspace can index

File:

```ts
// brain.config.ts
export default {
  workspaces: [
    {
      id: "main-project",
      name: "Main Project",
      root: "/absolute/path/to/existing-project",
      include: [
        "src/**/*.{ts,tsx,js,jsx}",
        "app/**/*.{ts,tsx}",
        "pages/**/*.{ts,tsx}",
        "docs/**/*.md",
        "*.md"
      ],
      exclude: [
        "node_modules/**",
        ".next/**",
        "dist/**",
        "build/**",
        "coverage/**",
        ".git/**"
      ]
    }
  ],
  chunking: {
    targetTokens: 700,
    overlapTokens: 100
  },
  retrieval: {
    vectorLimit: 20,
    textLimit: 20,
    graphHops: 1,
    finalLimit: 12,
    maxContextTokens: 8000
  }
};
```

Codex nen tao loader de read config bang `tsx` hoac dynamic import.

---

## 7. Database schema MVP

Dung Drizzle. Bang can co:

```text
workspaces
app_settings
documents
chunks
embeddings
graph_nodes
graph_edges
index_runs
graph_runs
query_logs
memories
```

### 7.1 workspaces

Luu tung project/repo.

```text
id              text primary key
name            text
root_path       text
include_globs   text[]
exclude_globs   text[]
status          text -- setup | ready | archived
indexing_status text -- not_indexed | queued | running | succeeded | failed
graph_status    text -- not_built | queued | running | succeeded | failed
last_indexed_at timestamp nullable
last_graphed_at timestamp nullable
created_at      timestamp
updated_at      timestamp
```

### 7.2 app_settings

Luu state local cua app, trong do co active workspace.

```text
key             text primary key
value           jsonb
updated_at      timestamp
```

Record can co:

```json
{
  "key": "active_workspace",
  "value": {
    "workspaceId": "main-project"
  }
}
```

Rule:

- App chi co mot `active_workspace` tai mot thoi diem.
- Doi workspace chi update setting nay, khong copy/mix data.
- Moi query/index/graph/detail van filter bang `workspace_id`.

### 7.3 documents

Moi file la mot document.

```text
id              uuid primary key
workspace_id    text references workspaces(id)
path            text
absolute_path   text
kind            text -- markdown | code | text | session
language        text nullable
content_hash    text
size_bytes      integer
mtime_ms        bigint
created_at      timestamp
updated_at      timestamp
```

Unique:

```text
(workspace_id, path)
```

### 7.4 chunks

Moi document duoc chia thanh chunk.

```text
id              uuid primary key
workspace_id    text
document_id     uuid references documents(id)
chunk_index     integer
heading         text nullable
content         text
token_count     integer
content_hash    text
metadata        jsonb
fts             tsvector generated
created_at      timestamp
updated_at      timestamp
```

Index:

```text
GIN(fts)
(workspace_id, document_id)
```

### 7.5 embeddings

Luu vector cho chunk.

```text
id              uuid primary key
workspace_id    text
chunk_id        uuid references chunks(id)
provider        text
model           text
dimensions      integer
embedding       vector(1536) -- neu dung text-embedding-3-small
created_at      timestamp
```

Neu model co dimensions khac, can migration hoac dung config co dinh ngay tu dau.

Index:

```sql
CREATE INDEX embeddings_vector_idx
ON embeddings
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

### 7.6 graph_nodes

Graph node co the dai dien cho file, chunk, symbol, entity, memory.

```text
id              uuid primary key
workspace_id    text
type            text -- file | chunk | symbol | entity | memory
label           text
ref_id          text nullable -- document_id/chunk_id/symbol key
metadata        jsonb
created_at      timestamp
updated_at      timestamp
```

Index:

```text
(workspace_id, type)
(workspace_id, label)
```

### 7.7 graph_edges

```text
id              uuid primary key
workspace_id    text
from_node_id    uuid references graph_nodes(id)
to_node_id      uuid references graph_nodes(id)
type            text -- contains | imports | exports | defines | calls | links_to | mentions | related_to | supersedes
weight          real default 1
metadata        jsonb
created_at      timestamp
```

Index:

```text
(workspace_id, from_node_id)
(workspace_id, to_node_id)
(workspace_id, type)
```

### 7.8 index_runs va graph_runs

Luu lifecycle tung lan index/build graph theo workspace.

```text
id              uuid primary key
workspace_id    text references workspaces(id)
status          text -- queued | running | succeeded | failed
started_at      timestamp nullable
finished_at     timestamp nullable
error_message   text nullable
stats           jsonb
created_at      timestamp
```

`index_runs.stats` nen co:

```json
{
  "documentsScanned": 120,
  "documentsChanged": 8,
  "chunksCreated": 340,
  "embeddingsQueued": 340
}
```

`graph_runs.stats` nen co:

```json
{
  "nodesCreated": 800,
  "edgesCreated": 1500,
  "filesLinked": 120
}
```

### 7.9 memories

Manual/agent-written memory.

```text
id              uuid primary key
workspace_id    text
title           text
content         text
tags            text[]
source          text -- user | agent | system
supersedes_id   uuid nullable
created_at      timestamp
updated_at      timestamp
```

---

## 8. Drizzle setup

Commands:

```bash
pnpm drizzle-kit generate
pnpm drizzle-kit migrate
```

Package scripts nen co:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  }
}
```

Codex can tao:

```text
packages/db/src/schema.ts
packages/db/src/client.ts
packages/db/src/index.ts
drizzle.config.ts
```

---

## 9. Ingestion pipeline

Command mong muon:

```bash
pnpm brain index --workspace main-project
pnpm brain reindex --workspace main-project
pnpm brain watch --workspace main-project
```

Nen tao CLI package:

```text
packages/cli hoac apps/worker/src/cli.ts
```

Dung package:

- `commander` cho CLI
- `fast-glob` de scan files
- `chokidar` de watch
- `crypto` built-in de hash

Flow index:

```text
resolve workspace by workspace_id or active_workspace
  -> require workspace exists
  -> resolve workspace root
  -> glob include/exclude
  -> for each file:
       read file
       hash content
       skip neu hash khong doi
       upsert documents
       delete old chunks/embeddings for changed document
       chunk file
       insert chunks
       enqueue embedding jobs
  -> update indexing_status
```

Indexing khong build graph truc tiep. Sau khi index succeeded, user/agent moi trigger `build_graph` cho active workspace hoac workspaceId cu the.

### 9.1 Chunk Markdown

Dung:

```bash
pnpm add unified remark-parse remark-gfm unist-util-visit
```

Logic:

- Tach theo heading truoc.
- Neu section qua dai thi tach tiep theo paragraph/code fence.
- Target khoang `700 tokens`, overlap `100 tokens`.
- Metadata chunk nen co:

```json
{
  "headingPath": ["Architecture", "Auth"],
  "startLine": 10,
  "endLine": 80,
  "kind": "markdown"
}
```

Extract wikilinks:

```text
[[Auth Design]]
[[docs/api.md]]
```

Tao edge:

```text
chunk -> mentions -> entity/note
document -> links_to -> document
```

### 9.2 Chunk code

Dung `ts-morph`.

MVP:

- Moi file code la document.
- Tao chunks theo top-level declarations:
  - function
  - class
  - interface
  - type alias
  - enum
  - exported const
- Neu khong parse duoc, fallback chunk theo line window.

Metadata chunk:

```json
{
  "kind": "code",
  "symbolName": "createSession",
  "symbolType": "function",
  "exported": true,
  "startLine": 20,
  "endLine": 65
}
```

Graph nodes:

```text
file node
symbol node
chunk node
```

Graph edges:

```text
file -> contains -> chunk
file -> defines -> symbol
symbol -> represented_by -> chunk
file -> imports -> file
```

Call graph co the la Phase 2. Dung heuristic truoc:

- Trong function body, tim identifiers giong ten symbol trong workspace.
- Tao edge `calls` voi confidence thap trong metadata.
- Sau nay thay bang Tree-sitter hoac TypeScript compiler analysis.

---

## 10. Embedding providers

Tao interface:

```ts
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
  model: string;
}
```

Implement:

```text
OpenAIEmbeddingProvider
OllamaEmbeddingProvider
```

OpenAI:

```bash
pnpm add openai
```

Ollama:

```bash
pnpm add ollama
```

Embedding job:

```text
find chunks without embeddings for current model
batch by 32/64 chunks
call provider
insert embeddings
```

Can luu provider/model/dimensions trong bang `embeddings` de sau nay doi model khong bi lan.

---

## 11. Retrieval pipeline

MCP tool `memory_query` nen di theo flow:

```text
input query
  -> full-text search top N
  -> vector search top N
  -> merge by RRF
  -> map chunks to graph nodes
  -> graph expand 1 hop
  -> add neighbor chunks/symbols/files
  -> rerank heuristic
  -> trim by token budget
  -> return context blocks + sources
```

### 11.1 Full-text search

Postgres:

```sql
SELECT id, content, ts_rank_cd(fts, plainto_tsquery($1)) AS score
FROM chunks
WHERE workspace_id = $2
  AND fts @@ plainto_tsquery($1)
ORDER BY score DESC
LIMIT $3;
```

### 11.2 Vector search

```sql
SELECT chunks.*, 1 - (embeddings.embedding <=> $1) AS score
FROM embeddings
JOIN chunks ON chunks.id = embeddings.chunk_id
WHERE embeddings.workspace_id = $2
ORDER BY embeddings.embedding <=> $1
LIMIT $3;
```

### 11.3 RRF merge

Reciprocal Rank Fusion:

```text
score = sum(1 / (k + rank))
k = 60
```

Neu result xuat hien o ca FTS va vector, diem se cao hon.

### 11.4 Graph expand

Tu top seed chunks:

```text
chunk node
  -> symbol node
  -> file node
  -> imports/dependents
  -> related chunks
```

MVP chi expand 1 hop. Khong expand qua nhieu vi se tang token.

Can co config:

```text
graphHops: 1
maxGraphNeighbors: 20
maxContextTokens: 8000
```

### 11.5 Final context format

Tra ve cho LLM dang co source ro rang:

```text
[source: src/auth/session.ts:20-65 | score: 0.82]
code/content here

[source: docs/auth.md:10-40 | score: 0.75]
markdown content here
```

Khong tra ve mot blob lon khong co source.

---

## 12. MCP server

Dung:

```bash
pnpm add @modelcontextprotocol/sdk
```

App:

```text
apps/mcp/src/server.ts
```

Tools MVP:

### 12.1 `workspace_list`

Input:

```ts
{}
```

Output:

```ts
{
  activeWorkspaceId?: string;
  workspaces: Array<{
    id: string;
    name: string;
    rootPath: string;
    indexingStatus: string;
    graphStatus: string;
    lastIndexedAt?: string;
    lastGraphedAt?: string;
  }>;
}
```

### 12.2 `workspace_register`

Input:

```ts
{
  name: string;
  rootPath: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  setActive?: boolean;
}
```

Output:

```ts
{
  workspaceId: string;
  activeWorkspaceId?: string;
}
```

### 12.3 `workspace_select`

Input:

```ts
{
  workspaceId: string;
}
```

Output:

```ts
{
  activeWorkspaceId: string;
}
```

Rule:

- `workspace_select` chi doi active workspace.
- No khong index, khong build graph, khong mutate data cua workspace khac.

### 12.4 `memory_query`

Input:

```ts
{
  workspaceId?: string;
  query: string;
  limit?: number;
  maxTokens?: number;
}
```

Output:

```ts
{
  answerContext: string;
  sources: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    score: number;
    reason: string;
  }>;
}
```

Tool nay khong bat buoc goi LLM. No chi retrieve context cho agent.

Rule:

- Neu `workspaceId` khong duoc truyen, server dung `activeWorkspaceId`.
- Neu khong co active workspace, tra loi loi co cau truc: `NO_ACTIVE_WORKSPACE`.
- Neu workspace chua index thanh cong, tra loi loi: `WORKSPACE_NOT_INDEXED`.
- Neu workspace chua build graph, van co the FTS/vector search neu da index, nhung phai bao `graphStatus`.

### 12.5 `code_context`

Input:

```ts
{
  workspaceId?: string;
  symbolOrPath: string;
  hops?: number;
}
```

Output:

```ts
{
  symbol?: object;
  files: object[];
  callers: object[];
  callees: object[];
  relatedChunks: object[];
}
```

MVP co the support file path va symbol name.

### 12.6 `graph_neighbors`

Input:

```ts
{
  workspaceId?: string;
  nodeId?: string;
  label?: string;
  edgeTypes?: string[];
  depth?: number;
}
```

Output:

```ts
{
  nodes: object[];
  edges: object[];
}
```

Rule:

- Graph tool chi chay khi workspace co `graphStatus = succeeded`.
- Neu user doi active workspace, graph result phai doi theo workspace moi.

### 12.7 `memory_write`

Input:

```ts
{
  workspaceId?: string;
  title: string;
  content: string;
  tags?: string[];
  supersedesId?: string;
}
```

Dung de agent luu quyet dinh ky thuat sau khi code xong.

### 12.8 `index_workspace`

Input:

```ts
{
  workspaceId?: string;
  mode?: "incremental" | "full";
}
```

Output:

```ts
{
  jobId: string;
  status: "queued";
}
```

Rule:

- Neu `workspaceId` khong co, dung active workspace.
- Index job chi duoc enqueue cho workspace do.
- Khi index thanh cong, update `workspaces.indexing_status = succeeded` va `last_indexed_at`.

### 12.9 `build_graph`

Input:

```ts
{
  workspaceId?: string;
  mode?: "incremental" | "full";
}
```

Output:

```ts
{
  jobId: string;
  status: "queued";
}
```

Rule:

- `build_graph` chi chay sau khi workspace co it nhat mot index run `succeeded`.
- Graph build chi dung documents/chunks cua workspace do.
- Khi graph build thanh cong, update `workspaces.graph_status = succeeded` va `last_graphed_at`.

---

## 13. Connect MCP vao editor/agent

Local stdio config mau:

```json
{
  "mcpServers": {
    "ai-memory-graph": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/ai-memory-graph", "mcp"]
    }
  }
}
```

Package script:

```json
{
  "scripts": {
    "mcp": "tsx apps/mcp/src/server.ts"
  }
}
```

Neu muon HTTP/SSE MCP sau nay thi lam Phase 3, ban dau stdio la du.

---

## 14. Next.js dashboard

Dashboard khong phai uu tien dau tien, nhung nen co de debug.

Routes:

```text
/                  redirect to active workspace or /workspaces/setup
/workspaces         list workspace + active selector
/workspaces/setup   create/select workspace
/workspaces/[id]    active workspace detail/status
/workspaces/[id]/documents
/workspaces/[id]/query
/workspaces/[id]/graph
/workspaces/[id]/jobs
/settings           provider/config
```

Dung shadcn components, khong tu viet UI primitive.

Active workspace UI rules:

- App chi hien full detail cho workspace dang active.
- Vao `/workspaces/[id]` ma `id` khong phai active workspace thi hien confirm/action `Set active workspace`.
- Workspace moi tao xong duoc set active neu user chon.
- Workspace chua index thi detail page chi hien metadata, include/exclude globs, status, va nut `Index workspace`.
- Workspace da index nhung chua build graph thi hien documents/chunks stats va nut `Build graph`; graph page hien empty state.
- Workspace da build graph moi xem duoc graph explorer.
- Query page chi enable khi indexingStatus = `succeeded`.
- Graph expansion trong query chi enable khi graphStatus = `succeeded`.

Graph explorer:

```bash
pnpm add reactflow
```

Can hien:

- Node type: file/chunk/symbol/memory/entity
- Edge type: imports/defines/contains/mentions/calls
- Click node -> show metadata + source snippet

---

## 15. Worker jobs

Dung BullMQ:

Queues:

```text
index-workspace
embed-chunks
build-graph
cleanup-stale
```

Scripts:

```json
{
  "scripts": {
    "worker": "tsx apps/worker/src/index.ts",
    "index": "tsx apps/worker/src/cli.ts index",
    "watch": "tsx apps/worker/src/cli.ts watch"
  }
}
```

Job flow:

```text
index-workspace
  -> scan files
  -> upsert documents/chunks
  -> enqueue embed-chunks
  -> update workspace indexing_status

build-graph
  -> require workspace indexing_status = succeeded
  -> delete/rebuild stale graph nodes/edges for workspace
  -> build file/chunk/symbol/import/link graph
  -> update workspace graph_status

embed-chunks
  -> batch chunks
  -> call embedding provider
  -> insert vectors
```

Neu MVP muon don gian hon, co the chua dung BullMQ. CLI chay sync truoc. Them BullMQ khi indexing bat dau cham.

---

## 16. Flow khi LLM code feature/bugfix

Agent nen dung MCP theo flow:

```text
User request
  -> workspace_list / workspace_select neu can
  -> memory_query de lay docs/notes/code lien quan
  -> code_context neu can symbol/file cu the
  -> edit code trong project chinh
  -> run tests/typecheck
  -> index_workspace incremental
  -> build_graph incremental neu graph bi stale
  -> memory_write tom tat quyet dinh moi
```

Vi du:

```text
User: sua bug login khong tao session

Agent:
1. workspace_select("active project neu chua active")
2. memory_query("login session bug auth")
3. code_context("createSession")
4. doc cac file lien quan
5. sua code
6. run test auth
7. index_workspace("incremental")
8. build_graph("incremental")
9. memory_write("Fixed login session creation", ...)
```

Nguyen tac:

- Memory/graph dung de **chon context**, khong thay the viec doc code that.
- Neu context thieu, agent query tiep thay vi mo ca repo.
- Sau khi sua, phai update memory va reindex de graph khong cu.

---

## 17. Token budget rules

Can co logic cat context:

```text
maxContextTokens = 8000
reserveForAnswer = 2000
availableForSources = 6000
```

Ranking uu tien:

1. Exact file/symbol match
2. FTS + vector cung match
3. Chunk gan seed node trong graph
4. Important file co nhieu dependents
5. Recent memory/manual note

Khong nen dua vao context:

- File generated
- Lock files
- Large snapshots
- Minified code
- Test fixtures qua lon
- Node_modules

---

## 18. Phases de Codex thuc hien

### Phase 0: Scaffold

Muc tieu:

- Tao monorepo.
- Cai dependencies.
- Tao Docker Compose.
- Tao env/config.

Done khi:

- `pnpm install` chay duoc.
- `docker compose up -d` chay duoc.
- `pnpm typecheck` chay duoc.

### Phase 1: DB + CLI index Markdown/code files

Muc tieu:

- Drizzle schema.
- Migrations.
- Workspace registry va active workspace setting.
- Workspace setup/list/detail UI co ban.
- CLI scan workspace.
- Upsert documents/chunks.
- Full-text search co ban.

Done khi:

```bash
pnpm db:migrate
pnpm brain workspace:create --name main-project --root /absolute/path/to/project --active
pnpm index --workspace main-project
pnpm brain search "auth session"
```

Tra ve chunks co source path.

### Phase 2: Embeddings + vector search

Muc tieu:

- Embedding provider interface.
- OpenAI/Ollama provider.
- Store vectors in pgvector.
- `memory_query` ket hop FTS + vector bang RRF.

Done khi:

```bash
pnpm brain query "where is login session created?"
```

Tra ve context dung source.

### Phase 3: Graph Nexus MVP

Muc tieu:

- Tao graph nodes/edges:
  - file contains chunk
  - file imports file
  - file defines symbol
  - symbol represented_by chunk
  - markdown links_to note
- Graph expand 1 hop trong retriever.

Done khi:

```bash
pnpm brain build-graph --workspace main-project
pnpm brain graph --workspace main-project "src/auth/session.ts"
pnpm brain context --workspace main-project "createSession"
```

Tra ve related files/chunks/symbols.

### Phase 4: MCP server

Muc tieu:

- Stdio MCP server.
- Tools:
  - `workspace_list`
  - `workspace_register`
  - `workspace_select`
  - `memory_query`
  - `code_context`
  - `graph_neighbors`
  - `memory_write`
  - `index_workspace`
  - `build_graph`

Done khi:

- Editor/agent connect duoc MCP.
- Agent select active workspace, goi `memory_query`, va nhan context dung workspace.

### Phase 5: Dashboard

Muc tieu:

- Workspace setup/select UI.
- Active workspace detail.
- Explicit index/build graph actions.
- Query UI theo workspace.
- Documents list theo workspace.
- Graph explorer theo workspace.
- Jobs/status theo workspace.

Done khi:

```bash
pnpm dev
```

Mo dashboard va debug duoc retrieval.

### Phase 6: Quality loop

Muc tieu:

- Tests cho chunking, RRF, graph expansion, MCP handlers.
- Query logs.
- Evaluation set.

Done khi:

- Co 20 cau hoi test tren project that.
- Do duoc:
  - source accuracy
  - context token count
  - missing context cases

---

## 19. Acceptance criteria MVP

MVP duoc coi la dat khi:

- Tao duoc nhieu workspace nhung chi co mot active workspace tai mot thoi diem.
- Doi active workspace thi UI/detail/query/graph doi sang data cua workspace moi.
- Workspace chua index khong xem duoc query/detail sau cua index.
- Workspace chua build graph khong xem duoc graph explorer.
- Index duoc mot project TypeScript co san.
- Search keyword va semantic deu hoat dong.
- Query tra ve source path + line range.
- Graph biet file nao import file nao.
- Graph biet file nao define symbol nao.
- MCP client goi duoc `memory_query`.
- Agent dung context tu MCP de sua mot bug nho ma khong can doc ca repo.
- Sau khi sua code, chay reindex incremental thanh cong.

---

## 20. Nhung thu khong nen lam o MVP

Tam thoi khong lam:

- Neo4j
- Multi-tenant SaaS
- Auth phuc tap
- Realtime collaboration
- LLM auto-extract entity cho moi chunk
- Deep call graph cho moi ngon ngu
- Agent tu dong sua code khong can human review
- Query planner qua phuc tap

Ly do: cac thu nay de lam project phinh ra truoc khi retrieval co ban du tot.

---

## 21. File structure mong muon

```text
ai-memory-graph/
  apps/
    web/
      src/app/
      src/components/
    mcp/
      src/server.ts
      src/tools/memory-query.ts
      src/tools/code-context.ts
      src/tools/graph-neighbors.ts
      src/tools/memory-write.ts
      src/tools/index-workspace.ts
      src/tools/build-graph.ts
      src/tools/workspace-list.ts
      src/tools/workspace-register.ts
      src/tools/workspace-select.ts
    worker/
      src/index.ts
      src/cli.ts
      src/jobs/index-workspace.ts
      src/jobs/embed-chunks.ts
      src/jobs/build-graph.ts
  packages/
    config/
      src/load-config.ts
      src/types.ts
    db/
      src/client.ts
      src/schema.ts
      src/queries/
    indexer/
      src/scan.ts
      src/hash.ts
      src/chunk-markdown.ts
      src/chunk-code.ts
      src/extract-imports.ts
      src/build-graph.ts
    core/
      src/embeddings/
      src/retrieval/full-text.ts
      src/retrieval/vector.ts
      src/retrieval/rrf.ts
      src/retrieval/graph-expand.ts
      src/retrieval/token-budget.ts
      src/memory/write-memory.ts
  drizzle/
  brain.config.ts
  docker-compose.yml
  drizzle.config.ts
  package.json
  pnpm-workspace.yaml
  turbo.json
```

---

## 22. Commands nen co trong package.json root

```json
{
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "typecheck": "turbo typecheck",
    "lint": "turbo lint",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "worker": "tsx apps/worker/src/index.ts",
    "brain": "tsx apps/worker/src/cli.ts",
    "index": "tsx apps/worker/src/cli.ts index",
    "watch": "tsx apps/worker/src/cli.ts watch",
    "mcp": "tsx apps/mcp/src/server.ts"
  }
}
```

---

## 23. Prompt de dua cho Codex build

Co the dua doan nay cho Codex:

```text
Build this repository following AI_MEMORY_GRAPH_MCP_BLUEPRINT.md.

Important constraints:
- Use pnpm/pnpx packages instead of hand-writing framework scaffolding.
- Use TypeScript end-to-end.
- Start with Postgres + pgvector + Drizzle.
- Build the MVP in phases 0-4 first.
- Keep the existing target project read-only during indexing.
- Implement active-workspace behavior: one active workspace at a time, with every tool scoped to that workspace unless workspaceId is explicitly passed.
- Implement MCP stdio tools: workspace_list, workspace_register, workspace_select, memory_query, code_context, graph_neighbors, memory_write, index_workspace, build_graph.
- Enforce flow: setup/select workspace -> index workspace -> build graph -> view query/detail/graph.
- Return source paths and line ranges in every retrieval result.
- Add tests for chunking, RRF merge, graph expansion, and MCP tool handlers.
```

---

## 24. Thiet ke toi thieu cua `memory_query`

Pseudo-flow:

```text
function memoryQuery(query, workspaceId):
  queryEmbedding = embed(query)

  textResults = fullTextSearch(query, workspaceId, textLimit)
  vectorResults = vectorSearch(queryEmbedding, workspaceId, vectorLimit)

  seeds = rrfMerge(textResults, vectorResults)
  graphNeighbors = graphExpand(seeds, hops=1)

  candidates = merge(seeds, graphNeighbors)
  ranked = heuristicRerank(candidates)
  trimmed = trimToTokenBudget(ranked, maxContextTokens)

  return formatContext(trimmed)
```

Heuristic rerank:

```text
+ exact path/symbol match
+ appears in both FTS and vector
+ graph distance 0 or 1 from seed
+ recent manual memory
- generated file
- low confidence call edge
- too large chunk
```

---

## 25. Ghi chu quan trong

Day la he thong retrieval/context router, khong phai thay the LLM.

Vai tro tung phan:

```text
WikiLLM / memory store = nho noi dung va quyet dinh
Graph Nexus = biet quan he giua file/symbol/chunk
Retriever = chon lat cat context nho nhung dung
MCP = cho agent goi context do
LLM = doc context, suy luan, sua code
```

Neu lam dung, loi ich chinh la:

- It query code lan man hon.
- It token hon.
- Agent biet file/symbol lien quan nhanh hon.
- Sau moi lan dev, tri thuc project duoc luu lai.
- Project cu ngay cang de lam viec voi AI hon.
