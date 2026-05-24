---
title: Wiki Schema
type: schema
status: active
created: 2026-05-24
updated: 2026-05-24
tags:
  - schema
  - operations
---

# Wiki Schema

This file defines the structural conventions for the wiki. Use these rules unless a user explicitly asks to change the schema.

## Page Types

- `source` — summary and analysis of one ingested source
- `entity` — canonical page for a person, organization, product, place, or named thing
- `concept` — canonical page for an idea, theme, framework, or recurring topic
- `output` — durable result of a query or lint pass
- `schema` — operating conventions and structure
- `index` — content catalog
- `log` — chronological record

## Frontmatter

All durable pages should use YAML frontmatter.

Recommended fields:

```yaml
title: Page Title
type: source | entity | concept | output | schema | index | log
status: active | draft | superseded
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - [[Some Source Page]]
tags:
  - topic
```

Notes:

- `sources` may be omitted on index/log pages.
- `status` defaults to `active`.
- `updated` should change when the page meaningfully changes.
- `tags` should stay sparse and useful.

## Linking Rules

- Use Obsidian wikilinks: `[[Page Name]]`.
- Prefer one canonical page per entity or concept.
- If a page mentions an existing concept or entity, add a wikilink instead of leaving plain text.
- If an important topic recurs and lacks a page, create one or note it in a lint report.

## Naming Rules

- `sources/` pages should use concise descriptive titles, not raw filenames, when possible.
- `entities/` pages should use the canonical proper name.
- `concepts/` pages should use the simplest stable term for the idea.
- `outputs/` pages should begin with a durable descriptive title, optionally date-prefixed when chronology matters.

## Source Lifecycle

1. A new source arrives in `raw/`.
2. The agent reads it and creates or updates a corresponding page in `sources/`.
3. The agent updates related `entities/` and `concepts/` pages.
4. The agent updates `index.md`.
5. The agent appends a summary entry to `log.md`.
6. The raw source moves to `raw/processed/` after successful ingest.

## index.md Rules

`index.md` is the navigation hub. Organize it by category:

- Sources
- Entities
- Concepts
- Outputs

Each entry should contain:

- a wikilink
- a one-line description
- optional compact metadata when it adds value

Do not turn `index.md` into a changelog.

## log.md Rules

`log.md` is append-only and chronological.

Entry format:

```md
## [YYYY-MM-DD] operation | Title

- Touched: [[Page A]], [[Page B]]
- Summary: One short paragraph describing what changed and why.
```

Allowed operations:

- `ingest`
- `query`
- `lint`

## Templates

Use the files in `templates/` as the default starting point for new pages.

## Output Policy

Not every answer belongs in the wiki. File a query result into `outputs/` when it is likely to be useful later:

- comparisons
- synthesis across multiple sources
- reusable analysis
- maintenance reports
- decks or presentation-ready summaries
