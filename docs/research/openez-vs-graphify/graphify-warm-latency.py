#!/usr/bin/env python3
"""Warm, in-process graphify query latency: load each graph.json once (as graphify's MCP server
does), then time `_query_graph_text` with the CLI's defaults (bfs, depth 2, budget 2000).
Run with graphify's own interpreter: ~/.local/share/uv/tools/graphifyy/bin/python."""
import json, os, re, statistics, time
from networkx.readwrite import json_graph
from graphify.paths import consumed_graph_rows, read_graph_json
from graphify.serve import _query_graph_text

ROOT = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(ROOT, "..", "..", "..", "tests", "fixtures")
GRAPHS = {
    **({"goko": (os.environ["GOKO_EVAL_ROOT"] + "/graphify-out/graph.json", os.path.join(ROOT, "eval", "goko"))} if os.environ.get("GOKO_EVAL_ROOT") else {}),
    "wy-ask-api": ("/Users/nus/projects/ons-mebarek/wy-ask-api/graphify-out/graph.json", os.path.join(ROOT, "eval", "wy-ask-api")),
    "wyask-fe": ("/Users/nus/projects/ons-mebarek/wyask-fe/graphify-out/graph.json", os.path.join(ROOT, "eval", "wyask-fe")),
    "openez": ("/Users/nus/projects/Asta/openez/graphify-out/graph.json", FIX),
}
OPENEZ_FILES = ["retrieval-eval.json", "retrieval-eval-identifiers.json", "retrieval-eval-relations.json", "retrieval-eval-docs.json"]
NODE_SRC = re.compile(r"^NODE .+ \[src=([^ \]]+)")
out = {}
for ws, (gp, d) in GRAPHS.items():
    if os.environ.get("EVAL_ONLY") and ws != os.environ["EVAL_ONLY"]:
        continue
    t = time.perf_counter()
    raw = read_graph_json(gp)
    if "links" not in raw and "edges" in raw:
        raw = dict(raw, links=raw["edges"])
    G = json_graph.node_link_graph(consumed_graph_rows(dict(raw, links=raw.get("links", []))), edges="links")
    load_ms = (time.perf_counter() - t) * 1000
    files = OPENEZ_FILES if ws == "openez" else [f for f in ("concept.json", "identifiers.json", "relations.json", "docs.json")]
    queries = [c["query"] for f in files if os.path.exists(os.path.join(d, f)) for c in json.load(open(os.path.join(d, f)))]
    for q in queries:
        _query_graph_text(G, q, mode="bfs", depth=2, token_budget=2000, graph_path=gp)  # warm
    lat = []
    for q in queries:
        t = time.perf_counter(); _query_graph_text(G, q, mode="bfs", depth=2, token_budget=2000, graph_path=gp); lat.append((time.perf_counter() - t) * 1000)
    lat.sort()
    out[ws] = {"graphLoadMs": round(load_ms), "queries": len(lat), "medianMs": round(statistics.median(lat), 1), "p95Ms": round(lat[int(0.95 * (len(lat) - 1))], 1)}
print(json.dumps(out, indent=1))
