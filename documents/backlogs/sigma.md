Implement a workspace-scoped graph explorer using Sigma.js for this multi-workspace MCP project.

Context:
This product manages many local projects as isolated workspaces.
Each workspace has its own indexed documents, chunks, symbols, graph nodes, graph edges, memories, and retrieval state.
The graph explorer must visualize only one workspace at a time.
Do not build a cross-workspace graph.
Do not assume a single repo.

Goal:
Add a graph visualization page for a workspace so the user can inspect the graph built for that workspace after indexing/graph generation.

Use:
- Next.js
- TypeScript
- Sigma.js
- Graphology
- Existing app styling/components
- Current database/backend architecture
- Existing workspace detail flow

Install and use existing libraries via pnpm:
- sigma
- graphology
- graphology-layout-forceatlas2

User flow:
- User opens `/workspaces/[workspaceId]`
- There is a clear action to open the graph explorer
- Graph explorer page is `/workspaces/[workspaceId]/graph`
- If the workspace has no graph data yet, show a clear empty state and a button to trigger graph build
- If graph data exists, render the workspace graph with pan/zoom and node interaction

Functional requirements:
- Fetch graph data scoped by workspaceId only
- Render node and edge data from the backend using Graphology + Sigma.js
- Support at least these node types:
  - file
  - chunk
  - symbol
  - memory
- Support at least these edge types:
  - contains
  - defines
  - imports
  - represented_by
  - links_to
  - related_to
- Color nodes by type
- Vary node size by importance or degree if available, otherwise use sensible defaults
- Show node label on hover or selection
- Clicking a node opens a side panel with:
  - node label
  - node type
  - metadata
  - related source path
  - line range if available
  - direct neighbors summary
- Allow filtering by node type
- Allow filtering by edge type
- Allow search by node label
- Allow focusing/highlighting neighbors of the selected node

Data/API requirements:
- Add a backend endpoint or server action that returns graph data for a workspace
- Response shape should be explicit and UI-friendly, for example:
  - nodes: id, label, type, degree, metadata, path, startLine, endLine
  - edges: id, source, target, type, weight
- All graph queries must require workspaceId
- Never mix nodes or edges from different workspaces

Behavior rules:
- The graph page must be disabled or show an empty state if the workspace has not been indexed or graph-built yet
- If graph build is in progress, show current status
- If graph build failed, show failure state and error summary if available
- If the graph is very dense, default to showing a manageable subset or visually de-emphasize low-importance edges
- Keep the page usable on laptop-sized screens

Design guidance:
- This is an internal developer tool, not a marketing page
- The graph should be the primary surface, with a side inspector panel
- Use compact controls and clear filters
- Use a clean operations-oriented layout
- The graph canvas should have strong visual presence, not be buried in a small card
- Keep labels readable and avoid overwhelming the view with all labels at once
- Use existing design system/components where possible

Implementation requirements:
- Use Sigma.js directly with Graphology
- Create a reusable graph component
- Keep graph rendering logic separate from data fetching logic
- Add clear types for graph nodes and graph edges
- Keep the code organized so future edge/node types can be added safely
- Avoid hardcoding assumptions that every workspace has the same graph density or shape

Suggested implementation breakdown:
1. Install Sigma.js + Graphology dependencies
2. Add workspace graph API/backend loader
3. Create graph data mappers from backend response to Graphology graph
4. Build reusable Sigma graph component
5. Build `/workspaces/[workspaceId]/graph` page
6. Add filters, search, and selection state
7. Add node inspector side panel
8. Add empty/loading/error states
9. Link graph page from workspace detail page

Definition of done:
- I can open `/workspaces/[workspaceId]/graph`
- The page only shows graph data for that workspace
- I can pan, zoom, search, filter, and click nodes
- Clicking a node shows useful metadata and source references
- Empty and not-indexed states are handled cleanly
- The graph explorer is usable for debugging workspace graph structure
