# Tree-sitter Upgrade Guide

Tai lieu nay mo ta cach nang cap he thong code graph tu MVP dung `ts-morph` sang `Tree-sitter` khi can parse nhieu ngon ngu hon hoac can graph sau hon.

Muc tieu:

- Giu `ts-morph` lam baseline tot cho TypeScript/JavaScript.
- Them `Tree-sitter` nhu mot parser layer co the mo rong.
- Khong rewrite toan bo indexing pipeline.
- Khong pha schema/retrieval/MCP tools dang co.

---

## 1. Khi nao can upgrade sang Tree-sitter

Khong can dung Tree-sitter ngay tu dau neu project cua ban chi tap trung TypeScript/Next.js.

Nen upgrade khi co mot trong cac nhu cau sau:

- Can index nhieu ngon ngu:
  - Python
  - Go
  - Rust
  - Java
  - Ruby
  - PHP
  - Swift/Kotlin
- Can mot parser API dong nhat cho nhieu language.
- Can symbol ranges chinh xac hon tren cac file khong phai TS/JS.
- Can build graph cho repo polyglot.
- Can query AST patterns ve sau.
- Can recover tot hon khi code bi loi syntax nhe.
- Can tach code graph khoi TypeScript compiler/toolchain.

Khong nen upgrade chi vi “Tree-sitter nghe chuyen nghiep hon”. Neu `ts-morph` dang du dung, tiep tuc dung no cho TS/JS.

---

## 2. Vai tro cua ts-morph va Tree-sitter

Khuyen nghi khong thay `ts-morph` 100% ngay lap tuc.

Dung ca hai theo vai tro:

```text
ts-morph
  -> TypeScript/JavaScript semantic-ish indexing
  -> imports/exports
  -> exported declarations
  -> type/interface/component/function/class
  -> line ranges

Tree-sitter
  -> language-agnostic syntax indexing
  -> multi-language parsing
  -> robust syntax tree
  -> AST pattern matching
  -> symbol extraction for non-TS languages
```

Rule:

- Neu file la `.ts`, `.tsx`, `.js`, `.jsx`: dung `ts-morph` o MVP/Phase 1.
- Neu file la ngon ngu khac: dung `Tree-sitter`.
- Sau nay neu Tree-sitter implementation du tot, co the cho TS/JS chay Tree-sitter song song de bo sung call-ish edges.

---

## 3. Thu vien can cai

Bat dau voi package Node Tree-sitter.

```bash
pnpm add tree-sitter
pnpm add tree-sitter-typescript tree-sitter-javascript
```

Neu can them ngon ngu:

```bash
pnpm add tree-sitter-python
pnpm add tree-sitter-go
pnpm add tree-sitter-rust
```

Tuy ecosystem Tree-sitter tren Node co the co version/native binding issue. Khi install fail, can xem version compatibility cua `tree-sitter` va grammar package.

Alternative sau nay neu muon wasm/browser:

```bash
pnpm add web-tree-sitter
```

Khuyen nghi cho backend indexer:

- Bat dau voi `tree-sitter` native package.
- Chi dung `web-tree-sitter` neu can browser-side parsing hoac native binding qua phuc tap.

---

## 4. Kien truc parser moi

Them mot abstraction parser chung trong `packages/indexer`.

```ts
export type SourceLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "go"
  | "rust"
  | "unknown";

export type ParsedSymbol = {
  id: string;
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "variable" | "method" | "component";
  exported?: boolean;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  text?: string;
  metadata?: Record<string, unknown>;
};

export type ParsedImport = {
  source: string;
  specifiers: string[];
  startLine: number;
  endLine: number;
  metadata?: Record<string, unknown>;
};

export type ParsedCall = {
  callerSymbolId?: string;
  calleeName: string;
  startLine: number;
  endLine: number;
  confidence: "low" | "medium" | "high";
  metadata?: Record<string, unknown>;
};

export type ParsedFile = {
  language: SourceLanguage;
  path: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  calls: ParsedCall[];
  diagnostics?: Array<{
    message: string;
    severity: "info" | "warning" | "error";
  }>;
};

export interface CodeParser {
  canParse(path: string): boolean;
  parse(input: {
    path: string;
    content: string;
    workspaceRoot: string;
  }): Promise<ParsedFile>;
}
```

Sau do co implementations:

```text
packages/indexer/src/parsers/ts-morph-parser.ts
packages/indexer/src/parsers/tree-sitter-parser.ts
packages/indexer/src/parsers/parser-registry.ts
```

`parser-registry` chon parser theo extension/language.

---

## 5. Parser registry

Logic de xuat:

```text
.ts/.tsx/.js/.jsx
  -> TsMorphParser by default

.py/.go/.rs
  -> TreeSitterParser

unknown extension
  -> fallback line chunker, no symbol graph
```

Pseudo-code:

```ts
export function getParserForPath(path: string): CodeParser | null {
  if (tsMorphParser.canParse(path)) return tsMorphParser;
  if (treeSitterParser.canParse(path)) return treeSitterParser;
  return null;
}
```

Can co config de override:

```ts
export default {
  codeParsing: {
    tsStrategy: "ts-morph",
    treeSitterLanguages: ["python", "go", "rust"]
  }
};
```

Sau nay co the doi:

```ts
tsStrategy: "tree-sitter"
```

hoac:

```ts
tsStrategy: "both"
```

---

## 6. Schema changes

Neu schema hien tai da co `graph_nodes`, `graph_edges`, `chunks`, `documents`, thi khong can thay doi lon.

Nen them metadata/parser info de debug:

### documents

Them/can co:

```text
language          text nullable
parser            text nullable -- ts-morph | tree-sitter | fallback
parser_version    text nullable
parse_status      text -- pending | success | failed | partial
parse_error       text nullable
```

### graph_nodes

Metadata symbol nen co:

```json
{
  "language": "python",
  "parser": "tree-sitter",
  "symbolKind": "function",
  "startLine": 12,
  "endLine": 44,
  "startColumn": 0,
  "endColumn": 1
}
```

### graph_edges

Call/import edge metadata nen co confidence:

```json
{
  "parser": "tree-sitter",
  "confidence": "medium",
  "reason": "callee identifier matched workspace symbol name"
}
```

Important:

- Tree-sitter gives syntax, not full type resolution.
- `calls` edges tu Tree-sitter thuong nen de `confidence: low | medium`, tru khi co resolution ro rang.

---

## 7. Node va edge nao nen build voi Tree-sitter

Minimum useful graph:

### Nodes

```text
file
chunk
symbol
```

Optional later:

```text
import
route
test
entity
```

### Edges

Minimum:

```text
file -> contains -> chunk
file -> defines -> symbol
symbol -> represented_by -> chunk
file -> imports -> file
```

Later:

```text
symbol -> calls -> symbol
symbol -> extends -> symbol
symbol -> implements -> symbol
test -> covers -> symbol
route -> handled_by -> symbol
```

Khuyen nghi:

- Phase Tree-sitter 1: chi implement `defines` va `imports`.
- Phase Tree-sitter 2: them `calls` heuristic.
- Phase Tree-sitter 3: language-specific relationship nhu class inheritance, route handlers, test coverage.

---

## 8. Language extraction rules

Bat dau voi mot so rules don gian.

### TypeScript/JavaScript via Tree-sitter

Symbols:

```text
function_declaration -> function
class_declaration -> class
interface_declaration -> interface
type_alias_declaration -> type
enum_declaration -> enum
method_definition -> method
lexical_declaration with arrow_function -> function/component candidate
```

Imports:

```text
import_statement
export_statement
call_expression require(...)
```

Calls:

```text
call_expression function: identifier
call_expression function: member_expression
```

### Python

Symbols:

```text
function_definition -> function
class_definition -> class
```

Imports:

```text
import_statement
import_from_statement
```

Calls:

```text
call function: identifier
call function: attribute
```

### Go

Symbols:

```text
function_declaration -> function
method_declaration -> method
type_declaration -> type
```

Imports:

```text
import_declaration
```

### Rust

Symbols:

```text
function_item -> function
struct_item -> type
enum_item -> enum
trait_item -> interface-ish
impl_item -> implementation
```

Imports:

```text
use_declaration
```

---

## 9. Chunking voi Tree-sitter

Dung Tree-sitter de chunk theo symbol range.

Flow:

```text
parse file
  -> extract top-level symbols
  -> for each symbol:
       create chunk from startLine to endLine
       attach symbol metadata
  -> if file has remaining important imports/header:
       create file-header chunk
  -> if no symbol found:
       fallback line-window chunking
```

Chunk metadata:

```json
{
  "kind": "code",
  "language": "python",
  "parser": "tree-sitter",
  "symbolName": "create_session",
  "symbolType": "function",
  "startLine": 20,
  "endLine": 65
}
```

Important:

- Do not create one chunk per tiny method if it makes retrieval noisy.
- For nested symbols, prefer top-level symbol chunks first.
- Can store nested symbols as graph nodes, but retrieval should not always include every nested node.

---

## 10. Import resolution

Tree-sitter extracts import strings, but resolving import to file path is language-specific.

Implement resolver layer:

```ts
export interface ImportResolver {
  canResolve(language: SourceLanguage): boolean;
  resolve(input: {
    importSource: string;
    fromPath: string;
    workspaceRoot: string;
  }): Promise<{ path: string; confidence: "low" | "medium" | "high" } | null>;
}
```

Resolvers:

```text
TypeScriptImportResolver
PythonImportResolver
GoImportResolver
RustImportResolver
```

MVP:

- TS/JS import resolution can reuse existing ts-morph/tsconfig logic.
- Python/Go/Rust can start with best-effort local path matching.

Neu khong resolve duoc:

- Still store import as metadata.
- Do not create `file -> imports -> file` edge unless target file is known.

---

## 11. Call graph caveat

Tree-sitter does not know types by default. It parses syntax.

Vi vay:

```text
foo()
service.create()
this.repo.save()
```

Tree-sitter co the thay call expression, nhung khong chac no map den symbol nao.

Rule:

- Chi tao `symbol -> calls -> symbol` khi callee resolve duoc hop ly.
- Neu chi match theo ten, set `confidence: low`.
- Neu match trong cung file ro rang, set `confidence: medium`.
- Neu co type/compiler resolution, moi set `confidence: high`.

MCP/retriever nen uu tien:

```text
high confidence calls > medium confidence calls > low confidence calls
```

Khong de low-confidence call edges lam no context.

---

## 12. Retrieval changes

Khi co Tree-sitter graph, retrieval pipeline van nhu cu:

```text
FTS search
  -> vector search
  -> RRF merge
  -> seed graph nodes
  -> graph expand
  -> rerank
  -> token trim
```

Chi them scoring:

```text
+ same file symbol
+ import edge target/source
+ high-confidence call edge
+ language-specific symbol exact match
- low-confidence call edge
- generated/vendor files
```

Graph expansion config nen co:

```ts
graphExpansion: {
  maxHops: 1,
  maxNeighbors: 25,
  includeLowConfidenceCalls: false
}
```

---

## 13. MCP compatibility

Khong doi contract cua tools chinh.

Tools van la:

```text
memory_query
code_context
graph_neighbors
index_workspace
```

Chi bo sung output metadata:

```json
{
  "parser": "tree-sitter",
  "language": "python",
  "confidence": "medium"
}
```

`code_context` nen support ngon ngu moi tu dong neu graph da co symbol/file nodes.

---

## 14. Testing strategy

Them fixtures:

```text
packages/indexer/test/fixtures/typescript/
packages/indexer/test/fixtures/python/
packages/indexer/test/fixtures/go/
packages/indexer/test/fixtures/rust/
```

Test cases:

- Extract functions/classes correctly.
- Extract imports correctly.
- Line ranges are correct.
- Fallback works on syntax error.
- Graph nodes are stable across repeated indexing.
- Reindex does not duplicate nodes/edges.
- Low-confidence call edges do not dominate retrieval.

Suggested tests:

```text
tree-sitter-parser.test.ts
parser-registry.test.ts
build-graph-tree-sitter.test.ts
import-resolver.test.ts
retrieval-confidence.test.ts
```

---

## 15. Rollout plan

### Phase A: Parser abstraction

Goal:

- Introduce `CodeParser` interface.
- Wrap current `ts-morph` parser behind interface.
- No behavior change.

Done when:

- Existing TS indexing still passes.
- Graph output unchanged except optional parser metadata.

### Phase B: Tree-sitter for one language

Goal:

- Add Tree-sitter parser.
- Enable only Python first or JavaScript first in a fixture workspace.

Done when:

- Python or JS fixture indexes symbols/imports.
- Graph nodes/edges created with parser metadata.

### Phase C: Multi-language support

Goal:

- Add 2-3 language grammars.
- Add file extension detection.
- Add import resolver best-effort.

Done when:

- Polyglot fixture workspace indexes without crashing.

### Phase D: Graph-aware retrieval tuning

Goal:

- Use parser confidence metadata in graph expansion.
- Avoid noisy low-confidence call edges.

Done when:

- Retrieval remains compact and source-grounded.

### Phase E: Optional TS Tree-sitter supplement

Goal:

- Keep `ts-morph` as source of truth for TS/JS.
- Use Tree-sitter to add syntax-level call-ish edges if useful.

Done when:

- Duplicate symbols are deduped.
- Edge confidence is clear.

---

## 16. Common mistakes to avoid

- Do not index `dist`, `.next`, `build`, `coverage`, `node_modules`.
- Do not trust Tree-sitter call edges as exact semantic truth.
- Do not replace `ts-morph` before parser abstraction exists.
- Do not create unbounded graph expansion from low-confidence edges.
- Do not make every AST node a graph node.
- Do not build graph UI assumptions around one language only.
- Do not store parser-specific details outside metadata unless they are core product fields.

---

## 17. Recommended prompt for future Codex upgrade

Use this prompt later:

```text
Upgrade the existing multi-workspace MCP memory/graph project from TypeScript-only code indexing to a parser abstraction that can support Tree-sitter.

Follow TREE_SITTER_UPGRADE_GUIDE.md.

Constraints:
- Do not remove the existing ts-morph TypeScript parser.
- Introduce a CodeParser interface and parser registry first.
- Keep current MCP tool contracts compatible.
- Keep all data scoped by workspaceId.
- Add Tree-sitter support incrementally, starting with one language.
- Store parser/language/confidence metadata on documents, graph nodes, graph edges, and chunks where relevant.
- Do not index generated directories like dist, build, .next, coverage, or node_modules.
- Do not create low-confidence call edges without marking them as low confidence.
- Add tests for parser output, graph building, and retrieval behavior.

Definition of done:
- Existing TypeScript indexing still works.
- Tree-sitter can parse at least one non-TypeScript language fixture.
- Graph nodes and edges are created for that language.
- Retrieval can include Tree-sitter-generated symbols without changing MCP client usage.
```
