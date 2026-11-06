#!/usr/bin/env python3
"""Run the same eval cases through `graphify query` and score identically to
packages/indexer/src/retrieval-eval.ts: hit@5 = any expected path in the first
5 returned paths, MRR = 1/rank of first relevant."""

import json
import os
import re
import subprocess
import sys
import time

EVAL_ROOT = os.path.dirname(os.path.abspath(__file__))
SUITES = ["concept", "identifiers", "relations", "docs"]

WORKSPACES = {
    "goko": {
        "graph": os.environ.get("GOKO_EVAL_ROOT", "") + "/graphify-out/graph.json",
        "eval_dir": os.path.join(EVAL_ROOT, "eval", "goko"),
    },
    "wy-ask-api": {
        "graph": "/Users/nus/projects/ons-mebarek/wy-ask-api/graphify-out/graph.json",
        "eval_dir": os.path.join(EVAL_ROOT, "eval", "wy-ask-api"),
    },
    "wyask-fe": {
        "graph": "/Users/nus/projects/ons-mebarek/wyask-fe/graphify-out/graph.json",
        "eval_dir": os.path.join(EVAL_ROOT, "eval", "wyask-fe"),
    },
    "openez": {
        "graph": "/Users/nus/projects/Asta/openez/graphify-out/graph.json",
        "eval_dir": os.path.join(
            EVAL_ROOT, "..", "..", "..", "tests", "fixtures"
        ),
        # openez benchmark fixture filenames differ
        "suite_files": {
            "concept": "retrieval-eval.json",
            "identifiers": "retrieval-eval-identifiers.json",
            "relations": "retrieval-eval-relations.json",
            "docs": "retrieval-eval-docs.json",
        },
    },
}

NODE_SRC_RE = re.compile(r"^NODE .+ \[src=([^ \]]+)")


def run_query(graph_path: str, query: str, budget: int = 2000) -> tuple[list[str], float]:
    started = time.perf_counter()
    proc = subprocess.run(
        ["graphify", "query", query, "--graph", graph_path, "--budget", str(budget)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    latency_ms = (time.perf_counter() - started) * 1000
    paths = []
    for line in proc.stdout.splitlines():
        m = NODE_SRC_RE.match(line)
        if m:
            paths.append(m.group(1))
    # Rank files, not graph nodes: one file contributes many NODE lines, and openez sources are
    # already one entry per file. Without this, graphify's "top 5" can be one file five times.
    return list(dict.fromkeys(paths)), latency_ms


def score(source_paths: list[str], expected: list[str]) -> dict:
    expected_set = set(expected or [])
    first = next(
        (i for i, p in enumerate(source_paths) if p in expected_set), None
    )
    return {
        "evaluated": bool(expected),
        "hitAt5": first is not None and first < 5,
        "reciprocalRank": 0.0 if first is None else 1.0 / (first + 1),
        "firstRelevantRank": None if first is None else first + 1,
    }


def summarize(qualities: list[dict]) -> dict:
    evaluated = [q for q in qualities if q["evaluated"]]
    n = max(len(evaluated), 1)
    return {
        "evaluatedRuns": len(evaluated),
        "recallAt5": sum(q["hitAt5"] for q in evaluated) / n,
        "mrr": sum(q["reciprocalRank"] for q in evaluated) / n,
    }


def main() -> None:
    report = {}
    only = os.environ.get("EVAL_ONLY")
    for ws_name, spec in WORKSPACES.items():
        if only and ws_name != only:
            continue
        ws_report = {}
        suite_files = spec.get("suite_files") or {s: f"{s}.json" for s in SUITES}
        for suite_name, filename in suite_files.items():
            fpath = os.path.join(spec["eval_dir"], filename)
            if not os.path.exists(fpath):
                continue
            cases = json.load(open(fpath))
            qualities = []
            details = []
            latencies = []
            for item in cases:
                run_query(spec["graph"], item["query"])  # warm the OS file cache
                paths, latency = run_query(spec["graph"], item["query"])
                q = score(paths, item.get("expectedPaths") or [])
                qualities.append(q)
                latencies.append(latency)
                details.append(
                    {
                        "query": item["query"],
                        "firstRelevantRank": q["firstRelevantRank"],
                        "top5": paths[:5],
                    }
                )
            ws_report[f"graphify/{suite_name}"] = {
                **summarize(qualities),
                "medianLatencyMs": sorted(latencies)[len(latencies) // 2] if latencies else 0,
                "details": details,
            }
        report[ws_name] = ws_report
    json.dump(report, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
