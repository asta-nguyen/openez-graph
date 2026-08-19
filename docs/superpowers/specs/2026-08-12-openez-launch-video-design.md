# OpenEZ Launch Video — Design Spec

**Date**: 2026-08-12
**Status**: Approved
**Owner**: asta-nguyen

## Goal

Build a Remotion-based product launch video module for OpenEZ Graph. Output two formats: 16:9 (1920×1080) for YouTube/blog embed/landing hero, and 9:16 (1080×1920) for TikTok/Reels/Shorts. Voiceover generated via local TTS (OmniVoice Studio) with English voice cloning.

## Non-Goals

- Not building a general-purpose video framework. One video, two aspect ratios.
- Not replacing the existing Takumi-based OG animated script in `landing/scripts/`.
- Not adding Remotion to the monorepo workspace. The `video/` module is standalone.
- Not supporting Vietnamese voiceover in this iteration. English only.

## Context

### Existing assets

- **Landing page** (`landing/src/app/`) has rich visual components: `HeroGraph` (three.js 3D graph), `DashboardPreview`, `Typewriter`, `AnimatedCounter`, `particle-text`, `graph-loader`.
- **OG animated script** (`landing/scripts/render-og-animated.mjs`) uses Takumi (Rust/WASM) to render a 3-ring orbit graph with twinkle nodes, then stitches frames via ffmpeg into a GIF. This is the visual reference for Scene 3.
- **Landing design tokens** (`landing/src/app/globals.css`): background `#05050a`→`#08081a`, primary `#00bfc8` (cyan), accent `#cc5dc3` (magenta), font heading Syne 800, mono JetBrains Mono.

### Voice pipeline (reuse from genvideopro)

- **OmniVoice Studio** runs locally at `http://localhost:3900/generate` (Python, Apple Silicon MPS).
- **Script**: `genvideopro/scripts/local-voice-api.mjs` — reads spec JSON, extracts `voiceover` per scene, POSTs `FormData` (text + ref_audio + ref_text + language + speed + duration + seed) to API, writes WAV per scene.
- **Sync script**: `genvideopro/scripts/sync-audio-durations.mjs` — measures audio duration, updates `duration_seconds` + `duration_frames` in spec.
- **Ref audio**: `genvideopro/public/audio/oh-my-openagent-en/scene_02_problem.wav` — English male voice, clean recording. Will be copied into `video/public/ref-audio/` so the module is self-contained.
- **Doc**: `genvideopro/.agents/skills/remotion-best-practices/rules/voiceover.md` covers `calculateMetadata` pattern for dynamic duration sync.

## Architecture

### Module placement

```
openez/
└── video/                          # standalone, NOT part of pnpm monorepo workspace
    ├── package.json                # @openez-graph/video — private, own deps
    ├── remotion.config.ts
    ├── tsconfig.json
    ├── README.md                   # prerequisites, voice setup, render commands
    ├── src/
    │   ├── Root.tsx                # register 2 compositions
    │   ├── compositions/
    │   │   ├── OpenEZLaunch16x9.tsx
    │   │   ├── OpenEZLaunch9x16.tsx
    │   │   └── scenes/             # 7 scene components, shared logic, aspect prop
    │   │       ├── Scene01Hook.tsx
    │   │       ├── Scene02Problem.tsx
    │   │       ├── Scene03Solution.tsx
    │   │       ├── Scene04HowItWorks.tsx
    │   │       ├── Scene05Features.tsx
    │   │       ├── Scene06Demo.tsx
    │   │       └── Scene07CTA.tsx
    │   ├── components/             # ported from landing, rewritten as pure Remotion
    │   │   ├── OrbitGraph.tsx      # 3-ring orbit (2D, port from OG-animated logic)
    │   │   ├── Graph3D.tsx         # 3D graph via @remotion/three (port HeroGraph)
    │   │   ├── Terminal.tsx        # typing animation
    │   │   ├── MCPSurface.tsx      # 7 tools check-in
    │   │   ├── LangBadges.tsx      # 9 language badges
    │   │   ├── AgentLogos.tsx      # 5 agent integration
    │   │   ├── DashboardPreview.tsx
    │   │   └── TokenCounter.tsx    # animated number counter
    │   ├── lib/
    │   │   ├── theme.ts            # palette, font, spring config (synced with landing)
    │   │   └── spec.ts             # typed spec loader
    │   └── data/
    │       └── openez-launch-en.json   # spec (genvideopro-compatible format)
    ├── scripts/
    │   ├── voice.mjs               # adapted from genvideopro/scripts/local-voice-api.mjs
    │   └── sync-audio.mjs          # adapted from sync-audio-durations.mjs
    ├── public/
    │   ├── ref-audio/
    │   │   └── scene_02_problem.wav  # copied from genvideopro
    │   └── audio/
    │       └── openez-launch-en/   # TTS output per scene
    └── out/                        # rendered MP4 (gitignored)
```

### Dependencies (standalone, not in monorepo)

| Package                  | Version  | Purpose                     |
| ------------------------ | -------- | --------------------------- |
| `remotion`               | 4.0.487  | Core                        |
| `@remotion/cli`          | 4.0.487  | Studio + render             |
| `@remotion/three`        | 4.0.487  | 3D graph scene              |
| `@remotion/google-fonts` | 4.0.487  | Syne + JetBrains Mono       |
| `@remotion/tailwind-v4`  | 4.0.487  | Tailwind in Remotion        |
| `three`                  | ^0.184.0 | 3D graph                    |
| `lucide-react`           | ^0.511.0 | Icons (match landing)       |
| `react`                  | 19.2.7   | Match Remotion 4.0.487 peer |
| `react-dom`              | 19.2.7   | Match                       |
| `tailwindcss`            | ^4.1.8   | Styling                     |
| `typescript`             | ^5.7.0   | Types                       |

### Composition structure

Two compositions share the same 7 scene components. Each scene accepts an `aspect: "16x9" | "9x16"` prop and adjusts layout accordingly.

```tsx
// OpenEZLaunch16x9.tsx
export const OpenEZLaunch16x9: React.FC = () => {
  const spec = loadSpec();
  return (
    <>
      {spec.scenes.map((scene, i) => {
        const from = cumulativeStartFrame(spec.scenes, i);
        return (
          <Sequence key={scene.id} from={from} durationInFrames={scene.duration_frames}>
            <SceneRouter scene={scene} aspect="16x9" />
            <Audio src={staticFile(`audio/openez-launch-en/${scene.id}.wav`)} />
            {scene.sfx && <Audio src={staticFile(`sfx/${scene.sfx}.wav`)} volume={0.22} />}
          </Sequence>
        );
      })}
    </>
  );
};

export const calculateMetadata = async () => {
  const spec = loadSpec();
  const durations = await Promise.all(
    spec.scenes.map((s) => getAudioDuration(staticFile(`audio/openez-launch-en/${s.id}.wav`))),
  );
  return {
    durationInFrames: Math.ceil(durations.reduce((sum, d) => sum + d * 30, 0)),
  };
};
```

### Design tokens (ported from landing, not imported)

| Token           | Value                                                                         | Source              |
| --------------- | ----------------------------------------------------------------------------- | ------------------- |
| `bg.gradient`   | `linear-gradient(150deg, #05050a 0%, #08081a 35%, #06060d 65%, #0a0a18 100%)` | OG script           |
| `color.primary` | `#00bfc8` (cyan)                                                              | landing globals.css |
| `color.accent`  | `#cc5dc3` (magenta)                                                           | OG script           |
| `color.muted`   | `rgba(255,255,255,0.5)`                                                       | landing             |
| `font.heading`  | Syne 800                                                                      | landing fonts.ts    |
| `font.mono`     | JetBrains Mono 400/600                                                        | OG script           |
| `spring.slide`  | `spring({ damping: 200, stiffness: 100 })`                                    | —                   |
| `spring.bounce` | `spring({ damping: 12, stiffness: 100 })`                                     | —                   |
| `fps`           | 30                                                                            | —                   |

### Voice pipeline

**Prerequisites** (documented in `video/README.md`):

1. OmniVoice Studio running at `http://localhost:3900` (health check: `curl http://localhost:3900/health` → `{"status":"ok"}`)
2. Ref audio copied to `video/public/ref-audio/scene_02_problem.wav`

**Generate voice**:

```bash
cd video
node scripts/voice.mjs -- \
  --spec=openez-launch-en \
  --ref-audio=public/ref-audio/scene_02_problem.wav \
  --ref-text="If you use multiple agents, the hard part is no longer just which model is smartest. It is setup, hooks, tool access, command permissions, and making the agent actually finish the job cleanly." \
  --language=en \
  --no-scene-duration \
  --overwrite
```

**Sync durations**:

```bash
node scripts/sync-audio.mjs --spec=openez-launch-en
```

This updates `duration_seconds` and `duration_frames` in the spec JSON based on actual audio length. The composition uses `calculateMetadata` to size itself dynamically.

**Adaptation from genvideopro**: `scripts/voice.mjs` is a copy of `local-voice-api.mjs` with path adjustments (project root resolution). `scripts/sync-audio.mjs` is a copy of `sync-audio-durations.mjs`. Both scripts read `src/data/<spec>.json` instead of `generated/specs/<spec>.json`.

## Narrative — 7 Scenes (90s total)

| #   | Scene        | Dur | Visual                                                                                                                      | On-screen text                      | Voiceover                                                                                                                                                                                                                                                       |
| --- | ------------ | --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hook         | 8s  | Terminal black, code scrolls fast, token counter 50K→200K, "context exhausted" red flash                                    | "200K tokens. Every session."       | "Every time an AI coding agent starts, it reads your codebase from scratch. Two hundred thousand tokens burned before real work begins."                                                                                                                        |
| 2   | Problem      | 12s | 3 cards stagger in: "Wasted tokens" / "No persistent memory" / "Cloud dependency" + fragmented graph                        | "No memory. No graph. No privacy."  | "No persistent memory. No code graph. And most tools send your source to cloud APIs. For proprietary code, that is a non-starter."                                                                                                                              |
| 3   | Solution     | 10s | Logo fade-in center, 3-ring orbit graph (port from OG-animated) rotates up, tagline gradient text                           | "OpenEZ Graph"                      | "OpenEZ Graph. Index code once into local SQLite. Retrieve ranked context, graph relationships, and durable memory through MCP."                                                                                                                                |
| 4   | How it works | 20s | Timeline 3 steps: file→SQLite (init) → graph traversal (query) → MCP/CLI/Web (connect)                                      | "Init. Query. Connect."             | "Run openez init. The indexer parses your codebase into documents, chunks, and graph nodes stored in SQLite. Query through full-text search fused with graph expansion. Connect through MCP, CLI, or the web dashboard — all pointing at the same local store." |
| 5   | Features     | 20s | MCP surface 7 tools check-in sequentially + 9 lang badges + 5 agent logos (Codex/Claude/OpenCode/Windsurf/Devin)            | "7 tools · 9 languages · 5 agents"  | "Seven MCP tools. Nine indexed languages. Five agent integrations with one setup command. Codex, Claude, OpenCode, Windsurf, or Devin — pick your agent."                                                                                                       |
| 6   | Demo         | 15s | Terminal typing `npx @openez-graph/cli setup codex` → MCP tools list output → agent calls `code_query` → ranked result card | "npx @openez-graph/cli setup codex" | "One command. npx openez-graph cli setup codex. Your agent now retrieves ranked code, graph context, and project memory — without re-reading everything."                                                                                                       |
| 7   | CTA          | 5s  | Large `npx` command + GitHub URL + star count animated counter                                                              | "Open source. Local-first."         | "Open source. Local-first. No Postgres. Start at github.com/asta-nguyen/openez-graph."                                                                                                                                                                          |

### 9:16 vertical layout differences

Same scene components, `aspect="9x16"` prop changes layout:

| Scene | 16:9                              | 9:16                                   |
| ----- | --------------------------------- | -------------------------------------- |
| 1     | Terminal 60% width, counter right | Terminal full-width, counter below     |
| 2     | 3 cards grid 2x2                  | 3 cards stacked vertical               |
| 3     | Orbit left, tagline right         | Orbit center, tagline below            |
| 4     | Horizontal timeline               | Vertical stepper                       |
| 5     | MCP surface + badges side-by-side | Stacked vertical, agent logos grid 2x3 |
| 6     | Terminal 60%, result card right   | Terminal full-width, result card below |
| 7     | Text left-aligned                 | Text center, command large             |

## Spec format

`video/src/data/openez-launch-en.json` — genvideopro-compatible so `voice.mjs` and `sync-audio.mjs` work without modification:

```json
{
  "project": {
    "title": "OpenEZ Graph: Durable Context for Coding Agents",
    "language": "en",
    "format": "both_16x9_and_9x16",
    "target_platform": "YouTube, blog embed, LinkedIn, TikTok",
    "tone": "direct, technical, confident"
  },
  "source": {
    "github": "https://github.com/asta-nguyen/openez-graph",
    "website": "https://openez.astalife.co",
    "npm": "@openez-graph/cli",
    "key_claims": [
      "Local-first SQLite WAL, no Postgres/Redis",
      "oxc-parser 13x faster than Babel for TS/JS",
      "7 MCP tools, 9 languages, 5 agent integrations",
      "95.65% recall@5 hybrid RAG"
    ]
  },
  "scenes": [
    {
      "id": "scene_01_hook",
      "duration_seconds": 8,
      "duration_frames": 240,
      "audio": "audio/openez-launch-en/scene_01_hook.wav",
      "sfx": "ding",
      "on_screen_text": "200K tokens. Every session.",
      "visual": "Terminal black, code scrolls fast, token counter 50K to 200K, context exhausted red flash",
      "voiceover": "Every time an AI coding agent starts, it reads your codebase from scratch. Two hundred thousand tokens burned before real work begins."
    }
  ]
}
```

(Full 7-scene spec written in implementation. `duration_seconds` and `duration_frames` are placeholders — `sync-audio.mjs` overwrites them with actual measured values after TTS generation.)

## Voiceover rules (English)

- No emoji, URLs, or special characters (`→ & % $ # + =`) in `voiceover` field
- Numbers written as English words in voiceover ("two hundred thousand" not "200K")
- `on_screen_text` keeps display formatting ("200K", "95.65%", "v4.13.0")
- Pace: ~3 English words per second
- One idea per scene
- Tone: direct, technical, confident — not hype

## Render commands

```bash
# Studio preview
cd video && npm run dev

# Render 16:9
npx remotion render OpenEZLaunch16x9Video out/OpenEZLaunch16x9.mp4

# Render 9:16
npx remotion render OpenEZLaunch9x16Video out/OpenEZLaunch9x16.mp4

# Still frame verification
npx remotion still OpenEZLaunch16x9Video /tmp/openez-opening.png --frame=15
npx remotion still OpenEZLaunch16x9Video /tmp/openez-middle.png --frame=1350
npx remotion still OpenEZLaunch16x9Video /tmp/openez-ending.png --frame=2685
```

## Error handling

- **Voice API not running**: `voice.mjs` prints clear error: "OmniVoice Studio not running at http://localhost:3900. Start it first. Health check: curl http://localhost:3900/health". Does NOT fake audio files.
- **Ref audio missing**: `voice.mjs` checks `public/ref-audio/scene_02_problem.wav` exists before calling API.
- **Audio sync mismatch**: `sync-audio.mjs` overwrites spec durations; `calculateMetadata` in composition reads actual audio duration at render time as safety net.
- **Scene component missing audio file**: Composition renders scene with silent fallback + console warning.

## Testing

- **Spec validation**: `node scripts/validate-spec.mjs --spec=openez-launch-en` (adapt from genvideopro) checks required fields, scene count, voiceover rules.
- **Still frame verification**: Render 3 stills per composition (opening, middle, ending) before full render.
- **Audio sync check**: After `sync-audio.mjs`, verify `duration_frames` sum matches `calculateMetadata` output.
- **Visual parity**: Compare Scene 3 orbit graph against existing `og-animated.gif` for visual consistency.

## File outputs

| Artifact      | Path                                              |
| ------------- | ------------------------------------------------- |
| Spec JSON     | `video/src/data/openez-launch-en.json`            |
| Voice audio   | `video/public/audio/openez-launch-en/scene_*.wav` |
| Ref audio     | `video/public/ref-audio/scene_02_problem.wav`     |
| Rendered 16:9 | `video/out/OpenEZLaunch16x9.mp4`                  |
| Rendered 9:16 | `video/out/OpenEZLaunch9x16.mp4`                  |
| README        | `video/README.md`                                 |
