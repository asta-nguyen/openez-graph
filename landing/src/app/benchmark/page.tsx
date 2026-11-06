import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { Footer } from "../components/footer";
import { SiteHeader } from "../components/site-header";
import { REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Benchmark: OpenEZ and Graphify",
  description:
    "OpenEZ and Graphify measured on three codebases: retrieval quality, query speed, index time, and what the numbers do not prove.",
  alternates: { canonical: "/benchmark" },
};

// Dated snapshot of BENCHMARK.md in the repo root; update both together. Each score is
// [Recall@5, MRR]. Graphify's documentation suites are null because --code-only indexes none.
type Score = [number, number];
type Suite = { name: string; questions: number; openez: Score; graphify: Score | null };

const corpora: { name: string; files: string; note?: string; suites: Suite[] }[] = [
  {
    name: "Rust + TypeScript desktop app",
    files: "187 files",
    note: "Questions written before either tool ran. The concept row was never tuned against.",
    suites: [
      { name: "Concept", questions: 15, openez: [0.4, 0.37], graphify: [0.53, 0.27] },
      { name: "Identifiers", questions: 10, openez: [1, 1], graphify: [1, 1] },
      { name: "Relations", questions: 8, openez: [1, 0.94], graphify: [0.5, 0.16] },
      { name: "Documentation", questions: 7, openez: [0.86, 0.78], graphify: null },
    ],
  },
  {
    name: "Python FastAPI service",
    files: "1,876 files",
    note: "Optimistic for OpenEZ: its ranking was improved using these questions.",
    suites: [
      { name: "Concept", questions: 11, openez: [0.91, 0.71], graphify: [0.45, 0.31] },
      { name: "Identifiers", questions: 10, openez: [1, 1], graphify: [0.8, 0.8] },
      { name: "Relations", questions: 4, openez: [0.75, 0.75], graphify: [0.5, 0.28] },
      { name: "Documentation", questions: 6, openez: [0.5, 0.5], graphify: null },
    ],
  },
  {
    name: "TypeScript Next.js frontend",
    files: "933 files",
    note: "Optimistic for OpenEZ: its ranking was improved using these questions.",
    suites: [
      { name: "Concept", questions: 9, openez: [0.89, 0.69], graphify: [0.78, 0.37] },
      { name: "Identifiers", questions: 9, openez: [1, 1], graphify: [0.89, 0.89] },
      { name: "Relations", questions: 4, openez: [0.75, 0.75], graphify: [0.75, 0.25] },
      { name: "Documentation", questions: 5, openez: [0.8, 0.8], graphify: null },
    ],
  },
];

const latency = [
  { corpus: "Desktop app", openez: "7 / 13 ms", graphify: "6 / 27 ms" },
  { corpus: "Python service", openez: "66 / 122 ms", graphify: "41 / 486 ms" },
  { corpus: "Next.js frontend", openez: "11 / 17 ms", graphify: "11 / 51 ms" },
];

const indexing = [
  { corpus: "Desktop app", openez: "0.5 s", graphify: "3.9 s" },
  { corpus: "Python service", openez: "15.8 s · 262 MB", graphify: "81.2 s · 121 MB" },
  { corpus: "Next.js frontend", openez: "2.9 s · 31 MB", graphify: "8.2 s · 7.4 MB" },
];

const caveats = [
  "OpenEZ's authors wrote the questions. The answers were checked against the source with grep, but this is not an independent evaluation.",
  "Two of the three codebases and all question sets are private, so these runs cannot be reproduced publicly.",
  "The desktop app's identifier and relation suites exposed three OpenEZ defects that were then fixed, so those rows are after-the-fix numbers.",
  "Suites are small: one question moves a score by .07 to .25.",
  "Graphify ran with --code-only and no LLM. Its optional LLM pass, community clustering, and wider language coverage were not measured.",
];

const fmt = (value: number) => (value === 1 ? "1.00" : value.toFixed(2).replace(/^0/, ""));

function ScoreCell({ score, leads }: { score: Score | null; leads: boolean }) {
  if (!score) {
    return <td className="py-2.5 text-right text-muted-foreground">N/A</td>;
  }
  return (
    <td className={`py-2.5 text-right tabular-nums ${leads ? "font-semibold text-primary" : ""}`}>
      {fmt(score[0])} / {fmt(score[1])}
    </td>
  );
}

// A side leads a row only when it is at least as good on both metrics and better on one.
function leader(suite: Suite): "openez" | "graphify" | null {
  const { openez: a, graphify: b } = suite;
  if (!b) return null;
  if (a[0] >= b[0] && a[1] >= b[1] && (a[0] > b[0] || a[1] > b[1])) return "openez";
  if (b[0] >= a[0] && b[1] >= a[1] && (b[0] > a[0] || b[1] > a[1])) return "graphify";
  return null;
}

function PairTable({
  caption,
  rows,
}: {
  caption: string;
  rows: { corpus: string; openez: string; graphify: string }[];
}) {
  return (
    <table className="w-full table-fixed text-left text-sm">
      <caption className="mb-3 text-left text-sm font-semibold">{caption}</caption>
      <thead className="text-xs text-muted-foreground">
        <tr className="border-b">
          <th className="w-[34%] py-2 pr-3 font-medium">Codebase</th>
          <th className="py-2 pr-3 text-right font-medium">OpenEZ</th>
          <th className="py-2 text-right font-medium">Graphify</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.corpus} className="border-b last:border-0">
            <td className="py-2.5 pr-3">{row.corpus}</td>
            <td className="py-2.5 pr-3 text-right tabular-nums">{row.openez}</td>
            <td className="py-2.5 text-right tabular-nums">{row.graphify}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function BenchmarkPage() {
  return (
    <div className="min-h-svh overflow-x-clip bg-background text-foreground dot-grid">
      <SiteHeader />

      <main className="mx-auto max-w-4xl px-6 pb-24 pt-28">
        <header className="mb-12 max-w-2xl">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-accent-foreground">
            Benchmark · November 6, 2026
          </p>
          <h1 className="text-balance text-4xl font-black tracking-tight sm:text-5xl">
            OpenEZ and Graphify, measured
          </h1>
          <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
            OpenEZ leads most code retrieval suites on three codebases, and answers documentation
            questions without an LLM. It is not a clean sweep: on the one question set never tuned
            against, Graphify has the better recall, and both tools miss most questions phrased
            differently from the code.
          </p>
        </header>

        <section className="mb-14 rounded-xl border bg-card p-6">
          <h2 className="text-sm font-semibold">How to read these numbers</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Across the nine code suites, OpenEZ leads Recall@5 in 6, Graphify in 1, and 2 tie.
            OpenEZ leads MRR in 8 and 1 ties. Two of the three codebases are optimistic for OpenEZ,
            because its ranking was improved using their questions. The fairest row is the desktop
            app&apos;s concept suite: Recall@5 .40 for OpenEZ and .53 for Graphify, a gap of two
            questions out of 15, and MRR .37 and .27.
          </p>
        </section>

        <section id="quality" className="mb-16">
          <h2 className="mb-2 text-2xl font-black tracking-tight">Retrieval quality</h2>
          <p className="mb-8 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Each cell is Recall@5 / MRR, with no embeddings. Recall@5: is an expected file in the
            top five? MRR: how high is the first one? Both tools get the same questions and answers,
            and results count per file. Highlighted cells lead on both metrics.
          </p>
          <div className="space-y-10">
            {corpora.map((corpus) => (
              <div key={corpus.name}>
                <table className="w-full table-fixed text-left text-sm">
                  <caption className="mb-3 text-left">
                    <span className="font-semibold">{corpus.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">· {corpus.files}</span>
                    {corpus.note && (
                      <span className="mt-1 block text-xs font-normal text-muted-foreground">
                        {corpus.note}
                      </span>
                    )}
                  </caption>
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-2 pr-3 font-medium">Questions</th>
                      <th className="w-24 py-2 pr-3 text-right font-medium sm:w-32">OpenEZ</th>
                      <th className="w-24 py-2 text-right font-medium sm:w-32">Graphify</th>
                    </tr>
                  </thead>
                  <tbody>
                    {corpus.suites.map((suite) => {
                      const lead = leader(suite);
                      return (
                        <tr key={suite.name} className="border-b last:border-0">
                          <td className="py-2.5 pr-3">
                            {suite.name}{" "}
                            <span className="text-xs text-muted-foreground">
                              ({suite.questions})
                            </span>
                          </td>
                          <ScoreCell score={suite.openez} leads={lead === "openez"} />
                          <ScoreCell score={suite.graphify} leads={lead === "graphify"} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            N/A: Graphify 0.9.103 ran with --code-only, which indexes no documentation.
          </p>
        </section>

        <section id="speed" className="mb-16">
          <h2 className="mb-2 text-2xl font-black tracking-tight">Speed and size</h2>
          <p className="mb-8 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Query speed is comparable. OpenEZ indexes faster but excludes its call graph, built on
            the first graph query, and it uses more disk on the larger codebases. Graphify&apos;s
            times include its graph and community detection.
          </p>
          <div className="grid gap-10 sm:grid-cols-2 sm:gap-8">
            <PairTable caption="Query, median / p95 (warm, in-process)" rows={latency} />
            <PairTable caption="Index time · disk" rows={indexing} />
          </div>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            Through its CLI, Graphify costs about 290 ms to 2.2 s per query, because each call
            starts Python and reloads the graph.
          </p>
        </section>

        <section id="beyond" className="mb-16">
          <h2 className="mb-3 text-2xl font-black tracking-tight">What the numbers leave out</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The tools return different things. OpenEZ returns code an agent can use directly.
            Graphify returns graph nodes and edges, and the agent then reads the files. Graphify
            also covers more languages and adds community clustering, reports, and LLM-based
            extraction from documents, PDFs, and images.
          </p>
        </section>

        <section id="limits" className="mb-16">
          <h2 className="mb-3 text-2xl font-black tracking-tight">Limits of this benchmark</h2>
          <ul className="max-w-2xl list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-primary">
            {caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </section>

        <p className="text-sm text-muted-foreground">
          Full method in{" "}
          <a
            className="text-primary hover:underline"
            href={`${REPO_URL}/blob/main/BENCHMARK.md`}
            target="_blank"
            rel="noopener noreferrer"
          >
            BENCHMARK.md
          </a>
          .{" "}
          <a className="inline-flex items-center gap-1 text-primary hover:underline" href="/">
            Back to the overview <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </p>
      </main>

      <Footer />
    </div>
  );
}
