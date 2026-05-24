-- Recreate database with new schema
-- This drops existing tables and recreates with the updated multi-workspace schema

BEGIN;

-- Drop existing tables in reverse dependency order
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS query_logs CASCADE;
DROP TABLE IF EXISTS graph_edges CASCADE;
DROP TABLE IF EXISTS graph_nodes CASCADE;
DROP TABLE IF EXISTS embeddings CASCADE;
DROP TABLE IF EXISTS chunks CASCADE;
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS index_runs CASCADE;
DROP TABLE IF EXISTS graph_runs CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;

-- Drop existing enums
DROP TYPE IF EXISTS graph_status;
DROP TYPE IF EXISTS indexing_status;
DROP TYPE IF EXISTS run_status;
DROP TYPE IF EXISTS workspace_status;

COMMIT;

-- Create new schema (mimics drizzle migration output)

CREATE TYPE "workspace_status" AS ENUM('pending', 'indexing', 'indexed', 'error');
CREATE TYPE "indexing_status" AS ENUM('pending', 'running', 'completed', 'failed');
CREATE TYPE "graph_status" AS ENUM('pending', 'running', 'completed', 'failed');
CREATE TYPE "run_status" AS ENUM('pending', 'running', 'completed', 'failed');

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  root_path text NOT NULL,
  include_globs text[] NOT NULL DEFAULT ARRAY[]::text[],
  exclude_globs text[] NOT NULL DEFAULT ARRAY[]::text[],
  status workspace_status NOT NULL DEFAULT 'pending',
  indexing_status indexing_status NOT NULL DEFAULT 'pending',
  graph_status graph_status NOT NULL DEFAULT 'pending',
  last_indexed_at timestamp,
  last_graph_built_at timestamp,
  document_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  node_count integer NOT NULL DEFAULT 0,
  edge_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path text NOT NULL,
  absolute_path text NOT NULL,
  kind text NOT NULL,
  language text,
  content_hash text NOT NULL,
  size_bytes integer NOT NULL,
  mtime_ms bigint NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, path)
);

CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  heading text,
  content text NOT NULL,
  token_count integer NOT NULL,
  content_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX chunks_workspace_document_idx ON chunks (workspace_id, document_id);

CREATE TABLE embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL,
  embedding vector NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX embeddings_workspace_chunk_idx ON embeddings (workspace_id, chunk_id);

CREATE TABLE graph_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  label text NOT NULL,
  ref_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX graph_nodes_workspace_type_idx ON graph_nodes (workspace_id, type);
CREATE INDEX graph_nodes_workspace_label_idx ON graph_nodes (workspace_id, label);

CREATE TABLE graph_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_node_id uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  to_node_id uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  type text NOT NULL,
  weight real NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX graph_edges_from_idx ON graph_edges (workspace_id, from_node_id);
CREATE INDEX graph_edges_to_idx ON graph_edges (workspace_id, to_node_id);
CREATE INDEX graph_edges_type_idx ON graph_edges (workspace_id, type);

CREATE TABLE index_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode text NOT NULL,
  status run_status NOT NULL DEFAULT 'pending',
  files_scanned integer NOT NULL DEFAULT 0,
  files_updated integer NOT NULL DEFAULT 0,
  chunks_written integer NOT NULL DEFAULT 0,
  embeddings_written integer NOT NULL DEFAULT 0,
  error_message text,
  stats jsonb DEFAULT '{}'::jsonb,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp
);

CREATE INDEX index_runs_workspace_idx ON index_runs (workspace_id);

CREATE TABLE graph_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'incremental',
  status run_status NOT NULL DEFAULT 'pending',
  nodes_created integer NOT NULL DEFAULT 0,
  edges_created integer NOT NULL DEFAULT 0,
  error_message text,
  stats jsonb DEFAULT '{}'::jsonb,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp
);

CREATE INDEX graph_runs_workspace_idx ON graph_runs (workspace_id);

CREATE TABLE query_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  query text NOT NULL,
  mode text NOT NULL,
  result_count integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text NOT NULL,
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  source text NOT NULL,
  supersedes_id uuid REFERENCES memories(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
