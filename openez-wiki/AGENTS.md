# AGENTS.md

This wiki is a human-curated, agent-maintained knowledge base. The human chooses sources, steers emphasis, and reviews important changes. The agent does the bookkeeping: summarization, cross-linking, filing, and consistency maintenance.

The wiki is file-first and Obsidian-friendly. Treat Markdown files in this directory as the source of truth.

## Purpose

Use this wiki to accumulate knowledge over time instead of leaving useful work in chat history. Durable outputs belong in files. Cross-links matter as much as summaries.

Primary operations:

1. `ingest` — process a new source from `raw/`
2. `query` — answer a question against the wiki with citations
3. `lint` — health-check the wiki for contradictions, gaps, and maintenance needs

## Operating Rules

- Preserve human-authored intent. Prefer incremental edits over rewrites.
- Do not delete substantive content unless the user asks for removal.
- Add cross-links whenever an existing entity or concept is mentioned.
- Distinguish source-backed claims from synthesis.
- Default to supervised, one-source-at-a-time ingest unless the user explicitly requests batching.
- When durable work is created, update `index.md` and append an entry to `log.md`.
- Use Obsidian wikilinks like `[[Page Name]]`.
- Prefer canonical pages over duplicate pages for the same entity or concept.

## Directory Map

- `raw/` — unprocessed source material
- `raw/assets/` — local images and attachments referenced by raw sources
- `raw/processed/` — raw sources that have already been ingested
- `sources/` — source summary pages created from ingested material
- `entities/` — pages for people, organizations, products, places, and named things
- `concepts/` — pages for ideas, themes, frameworks, and recurring topics
- `outputs/` — durable query results such as comparisons, analyses, decks, and charts
- `templates/` — reusable page templates
- `index.md` — content-oriented catalog of the wiki
- `log.md` — append-only chronological operation log
- `schema.md` — conventions for page types, metadata, and workflows

## Ingest Workflow

Default ingest mode is one source at a time.

1. Find one new source in `raw/`.
2. Read the source fully. If it references useful local images, inspect relevant files in `raw/assets/`.
3. Summarize the source and discuss key takeaways with the user before making broad interpretive updates when the session is interactive.
4. Create or update a source page in `sources/` using `templates/source.md`.
5. Update any affected pages in `entities/` and `concepts/`.
6. Add or update cross-links between related pages.
7. Update `index.md`:
   - add the source page
   - add new entity/concept/output pages if created
   - refresh one-line descriptions if they materially changed
8. Append one entry to `log.md` with the date, operation type, source title, and touched pages.
9. Move the raw source into `raw/processed/` after successful ingest, preserving the filename unless there is a naming collision.

Expected result: one source may legitimately update 10-15 pages.

## Query Workflow

1. Read `index.md` first to identify candidate pages.
2. Read only the relevant pages needed to answer the question.
3. Answer with citations to wiki pages, using explicit page references such as `[[Some Page]]`.
4. When the answer is durable, propose filing it into `outputs/`.
5. If the answer is filed:
   - create or update the output page using `templates/output.md`
   - update `index.md`
   - append a `query` entry to `log.md`

Possible output forms include:

- markdown analysis
- comparison table
- Marp deck
- chart specification or generated chart artifact
- other durable research notes

## Lint Workflow

Periodically inspect the wiki for:

- contradictions between pages
- stale claims superseded by newer sources
- orphan pages with weak or no inbound links
- important concepts or entities mentioned without their own page
- missing cross-references
- obvious data gaps or open questions worth researching

Lint procedure:

1. Read `index.md` and recent entries in `log.md`.
2. Sample relevant pages by topic cluster or recent activity.
3. Produce a concise maintenance report.
4. Only make broad cleanup edits immediately if the user explicitly asked for a lint pass that includes auto-fixes. Otherwise, present findings first.
5. If a durable lint report is saved, store it in `outputs/` and log it.

## Citation and Evidence Rules

- Cite wiki pages for all synthesized answers.
- Keep direct source claims attributable to the relevant page in `sources/`.
- If a conclusion is an inference across multiple pages, say so.
- Do not present speculation as fact.

## Editing Conventions

- Use YAML frontmatter on durable pages.
- Keep titles human-readable.
- Prefer one page per canonical entity or concept.
- If a page is superseded, update it in place and note the newer source rather than duplicating the topic.
- Keep `log.md` append-only.
- Keep `index.md` organized by category, not chronology.

## Session Start Checklist

At the start of a wiki session:

1. Read `AGENTS.md`.
2. Read `schema.md`.
3. Read `index.md`.
4. Skim the most recent relevant entries in `log.md`.
5. Then perform the requested ingest, query, or lint task.
