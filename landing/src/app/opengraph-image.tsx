import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const alt = "OpenEZ Graph — Understand Your Codebase";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

async function loadFont(
  family: string,
  weight: number,
): Promise<ArrayBuffer | null> {
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}&display=swap`;
    const cssRes = await fetch(cssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!cssRes.ok) return null;
    const css = await cssRes.text();
    const match = css.match(/src:\s*url\(([^)]+)\)/);
    if (!match) return null;
    const fontRes = await fetch(match[1]);
    if (!fontRes.ok) return null;
    return await fontRes.arrayBuffer();
  } catch {
    return null;
  }
}

function faviconDataUri(): string {
  const png = readFileSync(join(process.cwd(), "src/app/icon.png"));
  const b64 = Buffer.from(png).toString("base64");
  return `data:image/png;base64,${b64}`;
}

/* ── Graph network layout ── */
/* Nodes positioned to complement text on left half */
const NODES: Array<{ x: number; y: number; r: number; hub: boolean }> = [
  { x: 830, y: 130, r: 20, hub: true },    // 0 — right hub (cyan)
  { x: 1020, y: 210, r: 12, hub: false },   // 1
  { x: 920, y: 360, r: 15, hub: false },    // 2
  { x: 1090, y: 420, r: 10, hub: false },   // 3
  { x: 780, y: 500, r: 18, hub: true },     // 4 — bottom-right hub
  { x: 960, y: 550, r: 11, hub: false },    // 5
  { x: 660, y: 390, r: 11, hub: false },    // 6
  { x: 500, y: 500, r: 9, hub: false },     // 7
  { x: 310, y: 170, r: 11, hub: false },    // 8 — top-left (amethyst)
  { x: 170, y: 430, r: 8, hub: false },     // 9
];

const EDGES: Array<[number, number]> = [
  [0, 1], [0, 2], [0, 5],
  [1, 3], [2, 3],
  [2, 4], [2, 6],
  [4, 5], [4, 6], [4, 7],
  [6, 7], [6, 8],
  [7, 9], [8, 9],
];

export default async function OGImage() {
  const [syne700, syne800, jbMono400, jbMono600] =
    await Promise.all([
      loadFont("Syne", 700),
      loadFont("Syne", 800),
      loadFont("JetBrains Mono", 400),
      loadFont("JetBrains Mono", 600),
    ]);

  const displayFont = syne700 ? "Syne, system-ui, sans-serif" : "system-ui, sans-serif";
  const monoFont = jbMono400 ? "JetBrains Mono, monospace" : "ui-monospace, monospace";
  const logoUri = faviconDataUri();

  let starCount: number | null = null;
  try {
    const res = await fetch(
      "https://api.github.com/repos/asta-nguyen/openez-graph",
      { next: { revalidate: 3600 }, signal: AbortSignal.timeout(5000) },
    );
    if (res.ok) {
      const data = await res.json();
      if (typeof data.stargazers_count === "number") {
        starCount = data.stargazers_count;
      }
    }
  } catch {}

  const fonts: Array<{
    name: string;
    data: ArrayBuffer;
    weight: 400 | 600 | 700 | 800;
    style: "normal";
  }> = [];
  if (syne700) fonts.push({ name: "Syne", data: syne700, weight: 700, style: "normal" as const });
  if (syne800) fonts.push({ name: "Syne", data: syne800, weight: 800, style: "normal" as const });
  if (jbMono400) fonts.push({ name: "JetBrains Mono", data: jbMono400, weight: 400, style: "normal" as const });
  if (jbMono600) fonts.push({ name: "JetBrains Mono", data: jbMono600, weight: 600, style: "normal" as const });

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          background:
            "linear-gradient(150deg, #05050a 0%, #08081a 35%, #06060d 65%, #0a0a18 100%)",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* ── Ambient glows ── */}
        <div
          style={{
            position: "absolute",
            top: -120,
            right: -100,
            width: 850,
            height: 850,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(0,191,200,0.1) 0%, rgba(0,191,200,0.03) 35%, transparent 65%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -120,
            left: -80,
            width: 550,
            height: 550,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(204,93,195,0.06) 0%, transparent 55%)",
          }}
        />

        {/* ── Dot grid — matching landing page exactly ── */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px)",
            backgroundSize: "72px 72px",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)",
            backgroundSize: "72px 72px",
          }}
        />

        {/* ── Scanline grain ── */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.006) 2px, rgba(255,255,255,0.006) 4px)",
          }}
        />

        {/* ── Network graph SVG ── */}
        <svg
          viewBox="0 0 1200 630"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
        >
          {/* Edges — bezier curves */}
          {EDGES.map(([fi, ti], i) => {
            const f = NODES[fi];
            const t = NODES[ti];
            const mx = (f.x + t.x) / 2;
            const my = (f.y + t.y) / 2;
            const dx = (t.x - f.x) * 0.25;
            const dy = (t.y - f.y) * 0.25;
            return (
              <path
                key={i}
                d={`M${f.x},${f.y} Q${mx + dy},${my - dx} ${t.x},${t.y}`}
                stroke="rgba(0,191,200,0.08)"
                strokeWidth="1.5"
                fill="none"
              />
            );
          })}
          {/* Nodes */}
          {NODES.map((n, i) => {
            const color = n.hub
              ? "rgba(0,191,200,0.18)"
              : n.x > 500
                ? "rgba(0,191,200,0.07)"
                : "rgba(204,93,195,0.07)";
            const stroke = n.hub
              ? "rgba(0,191,200,0.3)"
              : "rgba(255,255,255,0.05)";
            return (
              <g key={i}>
                {n.hub && (
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={n.r * 2.5}
                    fill="none"
                    stroke="rgba(0,191,200,0.04)"
                    strokeWidth="0.5"
                  />
                )}
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r}
                  fill={color}
                  stroke={stroke}
                  strokeWidth={1}
                />
              </g>
            );
          })}
        </svg>

        {/* ── Top accent line ── */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background:
              "linear-gradient(90deg, transparent 10%, rgba(0,191,200,0.25) 50%, transparent 90%)",
          }}
        />

        {/* ── Content ── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            position: "relative",
            zIndex: 10,
            padding: "0 72px",
          }}
        >
          {/* Brand bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              paddingTop: 28,
            }}
          >
            <img
              src={logoUri}
              alt=""
              width={28}
              height={28}
              style={{ borderRadius: 5 }}
            />
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#ffffff",
                fontFamily: displayFont,
                letterSpacing: "-0.02em",
                textShadow: "0 0 20px rgba(255,255,255,0.3)",
              }}
            >
              OpenEZ Graph
            </span>
            <span
              style={{
                fontSize: 8,
                fontWeight: 600,
                  color: "rgba(0,191,200,0.7)",
                fontFamily: monoFont,
                letterSpacing: "0.3em",
                textTransform: "uppercase",
              }}
            >
              v0.2.0
            </span>
          </div>

          {/* Center hero — left-aligned, editorial */}
          <div
            style={{
              display: "flex",
              flex: 1,
              alignItems: "center",
              paddingBottom: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                maxWidth: 760,
              }}
            >
              {/* Hero — matches landing page gradient-text exactly */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  fontSize: 76,
                  fontFamily: displayFont,
                  fontWeight: 800,
                  letterSpacing: "-0.03em",
                  lineHeight: 1.02,
                }}
              >
                <span
                  style={{
                    background:
                      "linear-gradient(135deg, #ffffff, #3dd0d0)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                    color: "transparent",
                  }}
                >
                  Understand
                </span>
                <span
                  style={{
                    background:
                      "linear-gradient(135deg, #ffffff, #3dd0d0)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                    color: "transparent",
                  }}
                >
                  Your Codebase
                </span>
              </div>

              {/* Signal divider + tagline */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 14,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 1.5,
                    background: "rgba(0,191,200,0.2)",
                    borderRadius: 1,
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    fontFamily: monoFont,
                    color: "#ffffff",
                    letterSpacing: "0.06em",
                    textShadow: "0 0 12px rgba(255,255,255,0.25)",
                  }}
                >
                  Local-first · MCP-native · No Postgres
                </span>
              </div>
            </div>
          </div>

          {/* Bottom metadata bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              borderTop: "1px solid rgba(255,255,255,0.07)",
              paddingTop: 14,
              paddingBottom: 24,
            }}
          >
            {starCount !== null && (
              <div
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                {/* GitHub logo mark */}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
                    fill="#ffffff"
                  />
                </svg>
                <span
                  style={{
                    fontSize: 10,
                    color: "#ffffff",
                    fontFamily: monoFont,
                    fontWeight: 600,
                    textShadow: "0 0 10px rgba(255,255,255,0.2)",
                  }}
                >
                  GitHub
                </span>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 1l1.55 5.02h5.02l-4.07 2.95 1.56 5.02L8 11.04l-4.06 2.95 1.56-5.02L1.43 6.02h5.02L8 1z"
                    fill="#ffffff"
                  />
                </svg>
                <span
                  style={{
                    fontSize: 11,
                    color: "rgba(0,191,200,0.7)",
                    fontFamily: monoFont,
                    fontWeight: 700,
                  }}
                >
                  {formatStars(starCount)}
                </span>
              </div>
            )}
            <span
              style={{
                fontSize: 3,
                color: "rgba(255,255,255,0.12)",
              }}
            >
              ●
            </span>
            <span
              style={{
                fontSize: 9,
                color: "#ffffff",
                fontFamily: monoFont,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                textShadow: "0 0 10px rgba(255,255,255,0.2)",
              }}
            >
              Code Intelligence Engine
            </span>
            <span
              style={{
                fontSize: 3,
                color: "rgba(255,255,255,0.15)",
              }}
            >
              ●
            </span>
            <span
              style={{
                fontSize: 9,
                color: "#ffffff",
                fontFamily: monoFont,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                textShadow: "0 0 10px rgba(255,255,255,0.2)",
              }}
            >
              Open Source · MIT
            </span>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: fonts.length > 0 ? fonts : undefined,
    },
  );
}
