# OpenEZ Launch Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Remotion video module at `openez/video/` that produces a 90-second product launch video in 16:9 and 9:16, with English voiceover generated via the local OmniVoice Studio TTS API.

**Architecture:** Standalone `video/` directory at repo root (not part of pnpm monorepo). Two Remotion compositions share 7 scene components that accept an `aspect` prop. Voice pipeline scripts are adapted from `genvideopro/scripts/` and call `localhost:3900/generate`. Design tokens are ported from `landing/src/app/globals.css` and `landing/scripts/render-og-animated.mjs` as plain TS constants (no cross-package imports).

**Tech Stack:** Remotion 4.0.487, @remotion/three, three.js, @remotion/google-fonts (Syne + JetBrains Mono), @remotion/tailwind-v4, lucide-react, React 19, TypeScript 5.7, Node.js scripts for TTS + audio sync, ffprobe for duration probing.

## Global Constraints

- **Module location:** `openez/video/` — standalone, NOT added to `pnpm-workspace.yaml`
- **Voice API:** `http://localhost:3900/generate` (OmniVoice Studio). If unreachable, scripts MUST error clearly and MUST NOT fake audio files.
- **Ref audio:** Copy `genvideopro/public/audio/oh-my-openagent-en/scene_02_problem.wav` into `video/public/ref-audio/scene_02_problem.wav`
- **Ref text:** `If you use multiple agents, the hard part is no longer just which model is smartest. It is setup, hooks, tool access, command permissions, and making the agent actually finish the job cleanly.`
- **Language:** English only (`--language=en`)
- **FPS:** 30
- **Resolutions:** 1920×1080 (16:9) and 1080×1920 (9:16)
- **Color palette:** bg gradient `linear-gradient(150deg, #05050a 0%, #08081a 35%, #06060d 65%, #0a0a18 100%)`, primary `#00bfc8`, accent `#cc5dc3`, muted `rgba(255,255,255,0.5)`
- **Fonts:** Syne 800 (heading), JetBrains Mono 400/600 (mono) — loaded via `@remotion/google-fonts`
- **Voiceover rules:** No emoji, no URLs, no special chars (`→ & % $ # + =`) in `voiceover` field. Numbers as English words in voiceover. `on_screen_text` keeps display formatting.
- **Spec format:** genvideopro-compatible JSON (`project`, `source`, `scenes[]` with `id`, `duration_seconds`, `duration_frames`, `audio`, `sfx`, `on_screen_text`, `visual`, `voiceover`)
- **Output paths:** Rendered MP4 → `video/out/`. Audio → `video/public/audio/openez-launch-en/`. Never write videos elsewhere.
- **No new deps in monorepo root:** All deps installed inside `video/package.json` only.

---

## File Structure

```
video/
├── package.json
├── remotion.config.ts
├── tsconfig.json
├── .gitignore
├── README.md
├── src/
│   ├── Root.tsx                      # registers 2 compositions
│   ├── compositions/
│   │   ├── OpenEZLaunch16x9.tsx      # 1920x1080 composition
│   │   └── OpenEZLaunch9x16.tsx      # 1080x1920 composition
│   ├── scenes/
│   │   ├── SceneRouter.tsx           # maps scene.id → component, passes aspect
│   │   ├── Scene01Hook.tsx
│   │   ├── Scene02Problem.tsx
│   │   ├── Scene03Solution.tsx
│   │   ├── Scene04HowItWorks.tsx
│   │   ├── Scene05Features.tsx
│   │   ├── Scene06Demo.tsx
│   │   └── Scene07CTA.tsx
│   ├── components/
│   │   ├── Background.tsx            # gradient + dot grid + glow orbs
│   │   ├── OrbitGraph.tsx            # 3-ring orbit (2D, port from OG script)
│   │   ├── Terminal.tsx              # typing animation
│   │   ├── MCPSurface.tsx            # 7 tools check-in list
│   │   ├── LangBadges.tsx            # 9 language badges
│   │   ├── AgentLogos.tsx            # 5 agent integration names
│   │   ├── TokenCounter.tsx          # animated number counter
│   │   └── Timeline.tsx              # 3-step horizontal/vertical timeline
│   ├── lib/
│   │   ├── theme.ts                  # palette, fonts, spring configs
│   │   ├── spec.ts                   # typed spec loader + helpers
│   │   └── audio.ts                  # getAudioDuration helper
│   └── data/
│       └── openez-launch-en.json     # the spec
├── scripts/
│   ├── voice.mjs                     # adapted from genvideopro local-voice-api.mjs
│   ├── sync-audio.mjs                # adapted from genvideopro sync-audio-durations.mjs
│   └── validate-spec.mjs             # checks required fields + voiceover rules
└── public/
    ├── ref-audio/
    │   └── scene_02_problem.wav      # copied from genvideopro
    ├── sfx/                          # ding.wav, whoosh.wav, keyboard.wav (placeholders)
    └── audio/
        └── openez-launch-en/         # TTS output (gitignored)
```

---

### Task 1: Scaffold `video/` module + package.json + configs

**Files:**

- Create: `video/package.json`
- Create: `video/remotion.config.ts`
- Create: `video/tsconfig.json`
- Create: `video/.gitignore`
- Create: `video/README.md`

**Interfaces:**

- Produces: a runnable `npm install` + `npm run dev` (Remotion Studio) entrypoint. No compositions registered yet — Studio will show empty.

- [ ] **Step 1: Create `video/package.json`**

```json
{
  "name": "@openez-graph/video",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "remotion studio",
    "build": "remotion bundle",
    "render:16x9": "remotion render OpenEZLaunch16x9Video out/OpenEZLaunch16x9.mp4",
    "render:9x16": "remotion render OpenEZLaunch9x16Video out/OpenEZLaunch9x16.mp4",
    "voice": "node scripts/voice.mjs",
    "sync-audio": "node scripts/sync-audio.mjs",
    "validate-spec": "node scripts/validate-spec.mjs",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@remotion/cli": "4.0.487",
    "@remotion/google-fonts": "4.0.487",
    "@remotion/tailwind-v4": "4.0.487",
    "@remotion/three": "4.0.487",
    "lucide-react": "^0.511.0",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "remotion": "4.0.487",
    "tailwindcss": "^4.1.8",
    "three": "^0.184.0"
  },
  "devDependencies": {
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@types/three": "^0.184.1",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create `video/remotion.config.ts`**

```ts
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
```

- [ ] **Step 3: Create `video/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUnusedLocals": true
  },
  "include": ["src", "remotion.config.ts"]
}
```

- [ ] **Step 4: Create `video/.gitignore`**

```
node_modules/
out/
public/audio/
.DS_Store
*.log
```

- [ ] **Step 5: Create `video/README.md`**

````markdown
# OpenEZ Graph — Launch Video

Remotion-based product launch video. Outputs 16:9 (1920×1080) and 9:16 (1080×1920).

## Prerequisites

1. **Node.js 20+** and **ffmpeg/ffprobe** on PATH
2. **OmniVoice Studio** running locally at http://localhost:3900
   - Health check: `curl http://localhost:3900/health` → `{"status":"ok"}`
   - If unreachable, `npm run voice` will error. Do NOT fake audio files.

## Setup

```bash
cd video
npm install
```
````

## Pipeline

### 1. Generate voiceover

```bash
npm run voice -- \
  --spec=openez-launch-en \
  --ref-audio=public/ref-audio/scene_02_problem.wav \
  --ref-text="If you use multiple agents, the hard part is no longer just which model is smartest. It is setup, hooks, tool access, command permissions, and making the agent actually finish the job cleanly." \
  --language=en \
  --no-scene-duration \
  --overwrite
```

### 2. Sync audio durations into spec

```bash
npm run sync-audio -- --spec=openez-launch-en
```

### 3. Preview in Remotion Studio

```bash
npm run dev
```

### 4. Render

```bash
npm run render:16x9
npm run render:9x16
```

Output: `video/out/OpenEZLaunch16x9.mp4` and `video/out/OpenEZLaunch9x16.mp4`

## Validate spec

```bash
npm run validate-spec -- --spec=openez-launch-en
```

````

- [ ] **Step 6: Create a placeholder `src/Root.tsx` so Studio boots**

```tsx
import { Composition } from "remotion";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="OpenEZLaunch16x9Video"
        component={() => null}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="OpenEZLaunch9x16Video"
        component={() => null}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
````

- [ ] **Step 7: Install deps and verify Studio boots**

```bash
cd video && npm install
```

Then verify TypeScript compiles:

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/nus/projects/Asta/openez
git add video/package.json video/remotion.config.ts video/tsconfig.json video/.gitignore video/README.md video/src/Root.tsx
git commit -m "feat(video): scaffold Remotion module with package.json and configs"
```

---

### Task 2: Theme + spec loader + audio duration helper

**Files:**

- Create: `video/src/lib/theme.ts`
- Create: `video/src/lib/spec.ts`
- Create: `video/src/lib/audio.ts`
- Create: `video/src/data/openez-launch-en.json`

**Interfaces:**

- Produces: `theme` object with palette/fonts/springs, `loadSpec()` function returning typed `Spec`, `getAudioDurationInSeconds()` for `calculateMetadata`.

- [ ] **Step 1: Create `video/src/lib/theme.ts`**

```ts
export const theme = {
  bg: {
    gradient: "linear-gradient(150deg, #05050a 0%, #08081a 35%, #06060d 65%, #0a0a18 100%)",
  },
  color: {
    primary: "#00bfc8",
    accent: "#cc5dc3",
    white: "#ffffff",
    muted: "rgba(255,255,255,0.5)",
    faint: "rgba(255,255,255,0.12)",
    danger: "#ff4444",
    success: "#3dd0d0",
  },
  font: {
    heading: "Syne, system-ui, sans-serif",
    mono: "JetBrains Mono, ui-monospace, monospace",
    body: "Syne, system-ui, sans-serif",
  },
  spring: {
    slide: { damping: 200, stiffness: 100, mass: 1 },
    bounce: { damping: 12, stiffness: 100, mass: 1 },
    gentle: { damping: 16, stiffness: 120, mass: 1 },
  },
  fps: 30,
} as const;

export type Aspect = "16x9" | "9x16";
```

- [ ] **Step 2: Create `video/src/lib/spec.ts`**

```ts
import specData from "../data/openez-launch-en.json";

export interface SpecScene {
  id: string;
  scene: number;
  timecode?: string;
  duration_seconds: number;
  duration_frames: number;
  audio: string;
  sfx: string | null;
  on_screen_text: string;
  visual: string;
  voiceover: string;
}

export interface Spec {
  project: {
    title: string;
    language: string;
    format: string;
    target_platform: string;
    tone: string;
    duration_seconds?: number;
    duration_in_frames?: number;
  };
  source: {
    github: string;
    website: string;
    npm: string;
    key_claims: string[];
  };
  scenes: SpecScene[];
}

export const spec: Spec = specData as Spec;

export function loadSpec(): Spec {
  return spec;
}

export function sceneStartFrames(): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const s of spec.scenes) {
    starts.push(acc);
    acc += s.duration_frames;
  }
  return starts;
}

export function totalDurationFrames(): number {
  return spec.scenes.reduce((sum, s) => sum + s.duration_frames, 0);
}
```

- [ ] **Step 3: Create `video/src/lib/audio.ts`**

```ts
import { getAudioDurationInSeconds } from "@remotion/media-utils";

export async function getAudioDuration(path: string): Promise<number> {
  return getAudioDurationInSeconds(path);
}
```

Note: `@remotion/media-utils` is bundled with `remotion` peer — add it to deps if import fails. If `@remotion/media-utils` is not available, fall back to reading duration from spec (synced by `sync-audio.mjs`).

- [ ] **Step 4: Create `video/src/data/openez-launch-en.json` with all 7 scenes**

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
      "scene": 1,
      "duration_seconds": 8,
      "duration_frames": 240,
      "audio": "audio/openez-launch-en/scene_01_hook.wav",
      "sfx": "ding",
      "on_screen_text": "200K tokens. Every session.",
      "visual": "Terminal black, code scrolls fast, token counter 50K to 200K, context exhausted red flash",
      "voiceover": "Every time an AI coding agent starts, it reads your codebase from scratch. Two hundred thousand tokens burned before real work begins."
    },
    {
      "id": "scene_02_problem",
      "scene": 2,
      "duration_seconds": 12,
      "duration_frames": 360,
      "audio": "audio/openez-launch-en/scene_02_problem.wav",
      "sfx": null,
      "on_screen_text": "No memory. No graph. No privacy.",
      "visual": "3 cards stagger in: Wasted tokens, No persistent memory, Cloud dependency, plus fragmented graph",
      "voiceover": "No persistent memory. No code graph. And most tools send your source to cloud APIs. For proprietary code, that is a non-starter."
    },
    {
      "id": "scene_03_solution",
      "scene": 3,
      "duration_seconds": 10,
      "duration_frames": 300,
      "audio": "audio/openez-launch-en/scene_03_solution.wav",
      "sfx": "whoosh",
      "on_screen_text": "OpenEZ Graph",
      "visual": "Logo fade in center, 3-ring orbit graph rotates up, tagline gradient text",
      "voiceover": "OpenEZ Graph. Index code once into local SQLite. Retrieve ranked context, graph relationships, and durable memory through MCP."
    },
    {
      "id": "scene_04_how",
      "scene": 4,
      "duration_seconds": 20,
      "duration_frames": 600,
      "audio": "audio/openez-launch-en/scene_04_how.wav",
      "sfx": null,
      "on_screen_text": "Init. Query. Connect.",
      "visual": "Timeline 3 steps: file to SQLite, graph traversal, MCP CLI Web connect",
      "voiceover": "Run openez init. The indexer parses your codebase into documents, chunks, and graph nodes stored in SQLite. Query through full-text search fused with graph expansion. Connect through MCP, CLI, or the web dashboard, all pointing at the same local store."
    },
    {
      "id": "scene_05_features",
      "scene": 5,
      "duration_seconds": 20,
      "duration_frames": 600,
      "audio": "audio/openez-launch-en/scene_05_features.wav",
      "sfx": "ding",
      "on_screen_text": "7 tools, 9 languages, 5 agents",
      "visual": "MCP surface 7 tools check in sequentially, 9 lang badges, 5 agent logos Codex Claude OpenCode Windsurf Devin",
      "voiceover": "Seven MCP tools. Nine indexed languages. Five agent integrations with one setup command. Codex, Claude, OpenCode, Windsurf, or Devin, pick your agent."
    },
    {
      "id": "scene_06_demo",
      "scene": 6,
      "duration_seconds": 15,
      "duration_frames": 450,
      "audio": "audio/openez-launch-en/scene_06_demo.wav",
      "sfx": "keyboard",
      "on_screen_text": "npx @openez-graph/cli setup codex",
      "visual": "Terminal typing setup command, MCP tools list output, agent calls code_query, ranked result card",
      "voiceover": "One command. npx openez-graph cli setup codex. Your agent now retrieves ranked code, graph context, and project memory, without re-reading everything."
    },
    {
      "id": "scene_07_cta",
      "scene": 7,
      "duration_seconds": 5,
      "duration_frames": 150,
      "audio": "audio/openez-launch-en/scene_07_cta.wav",
      "sfx": null,
      "on_screen_text": "Open source. Local-first.",
      "visual": "Large npx command, GitHub URL, star count animated counter",
      "voiceover": "Open source. Local-first. No Postgres. Start at github dot com slash asta nguyen slash openez graph."
    }
  ]
}
```

Note: `duration_seconds` and `duration_frames` are placeholders. `sync-audio.mjs` (Task 7) overwrites them with measured values after TTS generation.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd video && npx tsc --noEmit
```

Expected: no errors. If `@remotion/media-utils` import fails, run `npm install @remotion/media-utils@4.0.487` and add to `package.json` deps.

- [ ] **Step 6: Commit**

```bash
cd /Users/nus/projects/Asta/openez
git add video/src/lib/theme.ts video/src/lib/spec.ts video/src/lib/audio.ts video/src/data/openez-launch-en.json video/package.json
git commit -m "feat(video): add theme, spec loader, audio helper, and launch spec JSON"
```

---

### Task 3: Voice + sync-audio + validate-spec scripts

**Files:**

- Create: `video/scripts/voice.mjs`
- Create: `video/scripts/sync-audio.mjs`
- Create: `video/scripts/validate-spec.mjs`
- Copy: `genvideopro/public/audio/oh-my-openagent-en/scene_02_problem.wav` → `video/public/ref-audio/scene_02_problem.wav`

**Interfaces:**

- Produces: `node scripts/voice.mjs --spec=openez-launch-en --ref-audio=... --ref-text=... --language=en --no-scene-duration --overwrite` generates WAV per scene into `public/audio/<slug>/`. `node scripts/sync-audio.mjs --spec=openez-launch-en` updates `duration_seconds`/`duration_frames` in spec using ffprobe. `node scripts/validate-spec.mjs --spec=openez-launch-en` checks required fields + voiceover rules.

- [ ] **Step 1: Copy ref audio**

```bash
mkdir -p video/public/ref-audio
cp /Users/nus/projects/Asta/genvideopro/public/audio/oh-my-openagent-en/scene_02_problem.wav video/public/ref-audio/scene_02_problem.wav
```

Verify:

```bash
ls -la video/public/ref-audio/scene_02_problem.wav
```

Expected: file exists, non-zero size.

- [ ] **Step 2: Create `video/scripts/voice.mjs`**

Adapt from `genvideopro/scripts/local-voice-api.mjs`. Key changes:

- `projectRoot` resolves to `video/` (script is in `video/scripts/`)
- Spec lookup: `src/data/<spec>.json` (not `generated/specs/`)
- Audio output: `public/audio/<spec>/`
- Same API contract: POST `FormData` to `http://localhost:3900/generate`

```js
#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "http://localhost:3900/generate";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_EXTENSION = "wav";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));

const config = {
  apiUrl: stringArg("api-url") || process.env.LOCAL_VOICE_API_URL || DEFAULT_API_URL,
  refAudio: stringArg("ref-audio"),
  refText: stringArg("ref-text"),
  specName: stringArg("spec"),
  language: stringArg("language") || DEFAULT_LANGUAGE,
  speed: stringArg("speed"),
  duration: stringArg("duration"),
  seed: stringArg("seed"),
  timeoutMs: Number(stringArg("timeout-ms") || 120000),
  overwrite: booleanArg("overwrite"),
  dryRun: booleanArg("dry-run"),
  useSceneDuration: !booleanArg("no-scene-duration"),
};

if (!config.specName) {
  fail("Provide --spec=<name>.");
}

if (config.refAudio && !existsSync(resolve(projectRoot, config.refAudio))) {
  fail(`Ref audio not found: ${resolve(projectRoot, config.refAudio)}`);
}

try {
  await main();
} catch (error) {
  fail(error?.message || String(error));
}

async function main() {
  const specPath = resolve(projectRoot, "src/data", `${config.specName}.json`);
  if (!existsSync(specPath)) {
    fail(`Spec not found: ${specPath}`);
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const scenes = extractVoiceoverScenes(spec);

  if (scenes.length === 0) {
    fail(`No voiceover text found in ${specPath}. Expected scenes[].voiceover.`);
  }

  const outputDir = resolve(projectRoot, "public/audio", config.specName);
  mkdirSync(outputDir, { recursive: true });

  console.log("Local voice API generator");
  console.log(`API:      ${config.apiUrl}`);
  console.log(`Ref:      ${config.refAudio || "none"}`);
  console.log(`Language: ${config.language}`);
  console.log(`Spec:     ${specPath}`);
  console.log(`Output:   ${outputDir}`);
  console.log("");

  if (config.dryRun) {
    for (const scene of scenes) {
      console.log(`dry-run ${scene.id}: ${scene.text.slice(0, 80)}...`);
    }
    return;
  }

  for (const scene of scenes) {
    const outputPath = join(outputDir, `${scene.id}.${DEFAULT_EXTENSION}`);
    if (!config.overwrite && existsSync(outputPath)) {
      console.log(`skip ${scene.id} (exists)`);
      continue;
    }
    await generateOne(scene, outputPath);
  }
}

async function generateOne(scene, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  process.stdout.write(`generate ${scene.id}... `);
  const audio = await requestAudio(scene.text, resolveDuration(scene));
  writeFileSync(outputPath, audio.buffer);
  console.log(`${(audio.buffer.length / 1024).toFixed(1)} KB -> ${outputPath}`);
}

async function requestAudio(text, duration) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body = new FormData();
    body.set("text", text);
    if (config.refAudio) {
      const refPath = resolve(projectRoot, config.refAudio);
      body.set("ref_audio", new Blob([readFileSync(refPath)]), basename(refPath));
    }
    if (config.refText) body.set("ref_text", config.refText);
    if (config.language) body.set("language", config.language);
    if (config.speed) body.set("speed", config.speed);
    if (duration) body.set("duration", duration);
    if (config.seed) body.set("seed", config.seed);

    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: { Accept: "audio/*, application/json" },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await safeReadText(response);
      throw new Error(
        `API ${response.status} ${response.statusText}${errBody ? `: ${errBody}` : ""}`,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.startsWith("audio/") || contentType.includes("octet-stream")) {
      return { buffer: Buffer.from(await response.arrayBuffer()) };
    }
    const data = await response.json();
    return await audioFromJson(data);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `API request timed out after ${config.timeoutMs}ms. Is OmniVoice Studio running at ${config.apiUrl}?`,
      );
    }
    if (error?.cause?.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot reach OmniVoice Studio at ${config.apiUrl}. Start it first. Health check: curl http://localhost:3900/health`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function audioFromJson(data) {
  const base64 = findFirstString(data, ["audio_base64", "audioBase64", "audio", "base64"]);
  if (base64) return { buffer: Buffer.from(stripDataUrlPrefix(base64), "base64") };
  const url = findFirstString(data, ["audio_url", "audioUrl", "url", "output"]);
  if (url) {
    const abs = new URL(url, config.apiUrl).toString();
    const res = await fetch(abs, { headers: { Accept: "audio/*" } });
    if (!res.ok) throw new Error(`Failed to download audio ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()) };
  }
  throw new Error(`API returned JSON without audio: ${JSON.stringify(data)}`);
}

function extractVoiceoverScenes(spec) {
  if (!Array.isArray(spec.scenes)) return [];
  return spec.scenes
    .filter((s) => s?.id && s?.voiceover)
    .map((s) => ({
      id: cleanFileId(s.id),
      text: String(s.voiceover),
      duration: normalizeDuration(s),
    }));
}

function resolveDuration(scene) {
  if (config.duration) return config.duration;
  return config.useSceneDuration ? scene.duration : undefined;
}

function normalizeDuration(scene) {
  if (Number.isFinite(scene?.duration_seconds)) return String(scene.duration_seconds);
  if (Number.isFinite(scene?.duration_frames)) return String(Number(scene.duration_frames) / 30);
  return undefined;
}

function findFirstString(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findFirstString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function stripDataUrlPrefix(value) {
  const marker = ";base64,";
  const idx = value.indexOf(marker);
  return idx >= 0 ? value.slice(idx + marker.length) : value;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseArgs(rawArgs) {
  const parsed = new Map();
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) parsed.set(key, inline);
    else if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith("--")) {
      parsed.set(key, rawArgs[i + 1]);
      i++;
    } else parsed.set(key, true);
  }
  return parsed;
}

function stringArg(name) {
  const v = args.get(name);
  return typeof v === "string" ? v : undefined;
}
function booleanArg(name) {
  return args.get(name) === true || args.get(name) === "true";
}
function cleanFileId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}
function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
```

- [ ] **Step 3: Create `video/scripts/sync-audio.mjs`**

Adapt from `genvideopro/scripts/sync-audio-durations.mjs`. Key change: spec at `src/data/<spec>.json`.

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FPS = 30;
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const specName = parseArg("spec");

if (!specName) fail("Provide --spec=<name>.");

const specPath = resolve(projectRoot, "src/data", `${specName}.json`);
if (!existsSync(specPath)) fail(`Spec not found: ${specPath}`);

const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (!Array.isArray(spec.scenes)) fail(`Spec has no scenes[]: ${specPath}`);

let totalFrames = 0;
let elapsed = 0;

for (const scene of spec.scenes) {
  if (!scene.audio) continue;
  const audioPath = resolveAudioPath(scene.audio);
  if (!existsSync(audioPath)) fail(`Audio not found for ${scene.id}: ${audioPath}`);
  const seconds = probeDuration(audioPath);
  const frames = Math.ceil(seconds * FPS);
  scene.duration_seconds = roundSeconds(seconds);
  scene.duration_frames = frames;
  scene.timecode = formatTimecode(elapsed, elapsed + frames);
  totalFrames += frames;
  elapsed += frames;
  console.log(`${scene.id}: ${seconds.toFixed(3)}s -> ${frames} frames`);
}

if (spec.project) {
  spec.project.duration_seconds = roundSeconds(totalFrames / FPS);
  spec.project.duration_in_frames = totalFrames;
}

writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
console.log(
  `Updated ${basename(specPath)} total=${totalFrames} frames (${(totalFrames / FPS).toFixed(3)}s)`,
);

function resolveAudioPath(audio) {
  const cleaned = String(audio).replace(/^\/?public\//, "");
  return resolve(projectRoot, "public", cleaned);
}
function probeDuration(path) {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { encoding: "utf8" },
  ).trim();
  const s = Number(out);
  if (!Number.isFinite(s) || s <= 0) fail(`Could not read duration from ${path}`);
  return s;
}
function roundSeconds(v) {
  return Number(v.toFixed(3));
}
function formatTimecode(start, end) {
  return `${formatClock(start)}-${formatClock(end)}`;
}
function formatClock(frames) {
  const total = Math.floor(frames / FPS);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function parseArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}
function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
```

- [ ] **Step 4: Create `video/scripts/validate-spec.mjs`**

```js
#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const specName = parseArg("spec");
if (!specName) fail("Provide --spec=<name>.");

const specPath = resolve(projectRoot, "src/data", `${specName}.json`);
if (!existsSync(specPath)) fail(`Spec not found: ${specPath}`);

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const errors = [];

if (!spec.project?.title) errors.push("project.title missing");
if (!spec.project?.language) errors.push("project.language missing");
if (!Array.isArray(spec.scenes) || spec.scenes.length === 0)
  errors.push("scenes[] empty or missing");

const forbiddenChars = /[→&%$#+=]/;
const urlPattern = /https?:\/\//;
for (const scene of spec.scenes || []) {
  if (!scene.id) errors.push(`scene missing id`);
  if (!scene.voiceover) errors.push(`${scene.id}: voiceover missing`);
  if (scene.voiceover) {
    if (/[^\x00-\x7F]/.test(scene.voiceover) && /[·•‣]/.test(scene.voiceover))
      errors.push(`${scene.id}: voiceover has special bullet chars`);
    if (forbiddenChars.test(scene.voiceover))
      errors.push(`${scene.id}: voiceover has forbidden chars (→ & % $ # + =)`);
    if (urlPattern.test(scene.voiceover))
      errors.push(`${scene.id}: voiceover contains URL — write it as words`);
  }
  if (!scene.on_screen_text) errors.push(`${scene.id}: on_screen_text missing`);
  if (!scene.audio) errors.push(`${scene.id}: audio path missing`);
}

if (errors.length > 0) {
  console.error("Spec validation FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Spec OK: ${spec.scenes.length} scenes, ${spec.project.title}`);

function parseArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}
function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
```

- [ ] **Step 5: Verify scripts run**

```bash
cd video
node scripts/validate-spec.mjs --spec=openez-launch-en
```

Expected: `Spec OK: 7 scenes, OpenEZ Graph: Durable Context for Coding Agents`

- [ ] **Step 6: Commit**

```bash
cd /Users/nus/projects/Asta/openez
git add video/scripts/voice.mjs video/scripts/sync-audio.mjs video/scripts/validate-spec.mjs video/public/ref-audio/scene_02_problem.wav
git commit -m "feat(video): add voice TTS, audio sync, and spec validation scripts"
```

---

### Task 4: Generate voiceover audio

**Files:**

- Output: `video/public/audio/openez-launch-en/scene_01_hook.wav` ... `scene_07_cta.wav`
- Modified: `video/src/data/openez-launch-en.json` (durations updated by sync)

**Interfaces:**

- Produces: 7 WAV files + spec with measured `duration_seconds`/`duration_frames` per scene. All later tasks depend on these durations for `Sequence` timing.

**Prerequisite:** OmniVoice Studio running at `http://localhost:3900`. Verify: `curl http://localhost:3900/health` → `{"status":"ok"}`.

- [ ] **Step 1: Verify OmniVoice Studio is running**

```bash
curl -s http://localhost:3900/health
```

Expected: `{"status":"ok","device":"mps"}`. If unreachable, STOP and tell the user to start OmniVoice Studio.

- [ ] **Step 2: Generate voice for all 7 scenes**

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

Expected: 7 lines `generate scene_XX_... NN KB -> .../scene_XX_....wav`.

- [ ] **Step 3: Sync durations into spec**

```bash
node scripts/sync-audio.mjs --spec=openez-launch-en
```

Expected: 7 lines `scene_XX_...: N.NNNs -> NNN frames`, then `Updated openez-launch-en.json total=NNNN frames (NN.NNNs)`.

- [ ] **Step 4: Verify spec was updated**

```bash
node scripts/validate-spec.mjs --spec=openez-launch-en
```

Expected: `Spec OK: 7 scenes, ...`

- [ ] **Step 5: Verify audio files exist**

```bash
ls -la video/public/audio/openez-launch-en/
```

Expected: 7 `.wav` files, all non-zero size.

- [ ] **Step 6: Commit (spec only — audio is gitignored)**

```bash
cd /Users/nus/projects/Asta/openez
git add video/src/data/openez-launch-en.json
git commit -m "feat(video): sync spec durations from generated TTS audio"
```

---

### Task 5: Shared visual components (Background, OrbitGraph, Terminal, TokenCounter)

**Files:**

- Create: `video/src/components/Background.tsx`
- Create: `video/src/components/OrbitGraph.tsx`
- Create: `video/src/components/Terminal.tsx`
- Create: `video/src/components/TokenCounter.tsx`

**Interfaces:**

- Produces: `<Background aspect={aspect} />`, `<OrbitGraph frame={frame} cx={n} cy={n} scale={n} />`, `<Terminal lines={string[]} typingSpeed={n} aspect={aspect} />`, `<TokenCounter from={n} to={n} frame={n} />`.

- [ ] **Step 1: Create `video/src/components/Background.tsx`**

```tsx
import React from "react";
import { theme, Aspect } from "../lib/theme";

export const Background: React.FC<{ aspect: Aspect }> = () => {
  return (
    <>
      <div style={{ position: "absolute", inset: 0, background: theme.bg.gradient }} />
      {/* dot grid */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />
      {/* glow orbs */}
      <div
        style={{
          position: "absolute",
          top: "20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: 600,
          height: 600,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(0,191,200,0.12) 0%, rgba(0,191,200,0.04) 30%, transparent 60%)",
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
          background: "radial-gradient(circle, rgba(204,93,195,0.06) 0%, transparent 55%)",
        }}
      />
    </>
  );
};
```

- [ ] **Step 2: Create `video/src/components/OrbitGraph.tsx`**

Port the 3-ring orbit logic from `landing/scripts/render-og-animated.mjs` lines 25-154 into a React component. The component takes `frame` (current frame) and renders nodes + edges as absolutely-positioned divs.

```tsx
import React from "react";
import { theme } from "../lib/theme";

const RING_RADII = [80, 150, 220];
const RING_SPEEDS = [360, -240, 180]; // deg per second

const ORBIT_NODES = [
  { ring: 0, angle: 0, r: 16, hub: true },
  { ring: 0, angle: 120, r: 10, hub: false },
  { ring: 0, angle: 240, r: 10, hub: false },
  { ring: 1, angle: 36, r: 12, hub: false },
  { ring: 1, angle: 108, r: 14, hub: true },
  { ring: 1, angle: 180, r: 9, hub: false },
  { ring: 1, angle: 252, r: 11, hub: false },
  { ring: 1, angle: 324, r: 10, hub: false },
  { ring: 2, angle: 0, r: 8, hub: false },
  { ring: 2, angle: 51, r: 9, hub: false },
  { ring: 2, angle: 103, r: 11, hub: false },
  { ring: 2, angle: 154, r: 8, hub: false },
  { ring: 2, angle: 206, r: 10, hub: false },
  { ring: 2, angle: 257, r: 9, hub: false },
  { ring: 2, angle: 309, r: 8, hub: false },
];

const ORBIT_EDGES = [
  [0, 3],
  [0, 4],
  [1, 4],
  [1, 5],
  [2, 5],
  [2, 3],
  [3, 8],
  [4, 9],
  [4, 10],
  [5, 11],
  [6, 12],
  [7, 13],
  [0, 1],
  [1, 2],
  [2, 0],
];

function ringRotation(t: number, ring: number) {
  return t * RING_SPEEDS[ring];
}

function nodeDepth(angle: number) {
  const rad = (angle * Math.PI) / 180;
  const z = Math.cos(rad);
  return {
    scale: 0.5 + 0.5 * ((z + 1) / 2),
    opacity: 0.3 + 0.7 * ((z + 1) / 2),
  };
}

function nodePosition(ring: number, baseAngle: number, rotation: number, cx: number, cy: number) {
  const radius = RING_RADII[ring];
  const angleDeg = baseAngle + rotation;
  const rad = (angleDeg * Math.PI) / 180;
  const x = cx + radius * Math.cos(rad);
  const y = cy + (ring - 1) * 20 + radius * Math.sin(rad) * 0.3;
  const depthAngle = ((angleDeg % 360) + 360) % 360;
  return { x, y, depthAngle };
}

function twinkle(t: number, phase: number) {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.6 + 0.4 * (v * 0.5 + 0.5);
}

function edgePulse(t: number, phase: number) {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.08 + 0.12 * (v * 0.5 + 0.5);
}

function hubGlow(t: number, phase: number) {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.18 + 0.17 * (v * 0.5 + 0.5);
}

export const OrbitGraph: React.FC<{
  frame: number;
  cx: number;
  cy: number;
  scale?: number;
}> = ({ frame, cx, cy, scale = 1 }) => {
  const t = frame / 30; // seconds
  const rotations = [ringRotation(t, 0), ringRotation(t, 1), ringRotation(t, 2)];

  const nodeData = ORBIT_NODES.map((n, i) => {
    const pos = nodePosition(n.ring, n.angle, rotations[n.ring], cx, cy);
    const depth = nodeDepth(pos.depthAngle);
    return { ...n, ...pos, ...depth, idx: i };
  });

  const sortedNodes = [...nodeData].sort((a, b) => a.scale - b.scale);

  const edges = ORBIT_EDGES.map(([fi, ti], i) => {
    const f = nodeData[fi];
    const td = nodeData[ti];
    const avgScale = (f.scale + td.scale) / 2;
    const phase = i / ORBIT_EDGES.length;
    const pulse = edgePulse(t, phase);
    const opacity = Math.max(0.01, pulse * avgScale);
    const dx = (td.x - f.x) * scale;
    const dy = (td.y - f.y) * scale;
    const len = Math.sqrt(dx * dx + dy * dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const sw = Math.max(0.5, 1.5 * avgScale);
    return (
      <div
        key={`edge-${i}`}
        style={{
          position: "absolute",
          left: f.x * scale,
          top: f.y * scale - sw / 2,
          width: len,
          height: sw,
          background: `rgba(0,191,200,${opacity})`,
          transform: `rotate(${angle}deg)`,
          transformOrigin: `0 ${sw / 2}px`,
        }}
      />
    );
  });

  const nodes = sortedNodes.map((n) => {
    const phase = n.idx / ORBIT_NODES.length;
    const twinkleVal = n.hub ? hubGlow(t, phase) : twinkle(t, phase);
    const opacity = Math.max(0.01, twinkleVal * n.opacity);
    const radius = Math.max(1, n.r * n.scale * scale);
    const d = radius * 2;
    const baseColor = n.hub ? "0,191,200" : n.ring === 2 ? "204,93,195" : "0,191,200";
    const border = n.hub ? "1px solid rgba(0,191,200,0.3)" : "1px solid rgba(255,255,255,0.05)";
    return (
      <div
        key={`node-${n.idx}`}
        style={{
          position: "absolute",
          left: n.x * scale - radius,
          top: n.y * scale - radius,
          width: d,
          height: d,
          borderRadius: "50%",
          background: `rgba(${baseColor},${opacity})`,
          border,
        }}
      />
    );
  });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {edges}
      {nodes}
    </div>
  );
};
```

- [ ] **Step 3: Create `video/src/components/Terminal.tsx`**

```tsx
import React from "react";
import { theme, Aspect } from "../lib/theme";

export const Terminal: React.FC<{
  lines: string[];
  typingFrame?: number; // frame at which typing starts
  typeSpeed?: number; // chars per frame
  aspect: Aspect;
  height?: number;
}> = ({ lines, typingFrame = 0, typeSpeed = 1, aspect, height }) => {
  const frame = useCurrentFrameProxy();
  const elapsed = Math.max(0, frame - typingFrame);
  const totalChars = Math.floor(elapsed * typeSpeed);

  let charsUsed = 0;
  const visibleLines: string[] = [];
  for (const line of lines) {
    if (charsUsed + line.length <= totalChars) {
      visibleLines.push(line);
      charsUsed += line.length + 1; // +1 for newline
    } else {
      const remaining = totalChars - charsUsed;
      if (remaining > 0) visibleLines.push(line.slice(0, remaining));
      break;
    }
  }

  const w = aspect === "16x9" ? 800 : 900;
  const h = height ?? (aspect === "16x9" ? 400 : 500);

  return (
    <div
      style={{
        width: w,
        height: h,
        background: "rgba(5,5,10,0.92)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: 24,
        fontFamily: theme.font.mono,
        fontSize: 16,
        color: theme.color.white,
        overflow: "hidden",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f56" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ffbd2e" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#27c93f" }} />
      </div>
      {visibleLines.map((line, i) => (
        <div key={i} style={{ lineHeight: 1.6, whiteSpace: "pre", opacity: 0.9 }}>
          {line}
        </div>
      ))}
    </div>
  );
};

// Wrapper to avoid importing useCurrentFrame in this file's top scope
import { useCurrentFrame } from "remotion";
function useCurrentFrameProxy() {
  return useCurrentFrame();
}
```

- [ ] **Step 4: Create `video/src/components/TokenCounter.tsx`**

```tsx
import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { theme } from "../lib/theme";

export const TokenCounter: React.FC<{
  from: number;
  to: number;
  startFrame?: number;
  durationFrames?: number;
}> = ({ from, to, startFrame = 0, durationFrames = 60 }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [startFrame, startFrame + durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const value = Math.round(from + (to - from) * progress);
  const formatted = value >= 1000 ? `${(value / 1000).toFixed(0)}K` : String(value);

  return (
    <div
      style={{
        fontFamily: theme.font.mono,
        fontSize: 64,
        fontWeight: 700,
        color: frame > startFrame + durationFrames ? theme.color.danger : theme.color.primary,
        textShadow: `0 0 30px ${theme.color.primary}40`,
      }}
    >
      {formatted}
    </div>
  );
};
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd video && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/nus/projects/Asta/openez
git add video/src/components/Background.tsx video/src/components/OrbitGraph.tsx video/src/components/Terminal.tsx video/src/components/TokenCounter.tsx
git commit -m "feat(video): add Background, OrbitGraph, Terminal, TokenCounter components"
```

---

### Task 6: Feature components (MCPSurface, LangBadges, AgentLogos, Timeline)

**Files:**

- Create: `video/src/components/MCPSurface.tsx`
- Create: `video/src/components/LangBadges.tsx`
- Create: `video/src/components/AgentLogos.tsx`
- Create: `video/src/components/Timeline.tsx`

**Interfaces:**

- Produces: `<MCPSurface aspect={aspect} startFrame={n} />`, `<LangBadges aspect={aspect} />`, `<AgentLogos aspect={aspect} />`, `<Timeline aspect={aspect} />`.

- [ ] **Step 1: Create `video/src/components/MCPSurface.tsx`**

```tsx
import React from "react";
import { spring, useCurrentFrame } from "remotion";
import { Check } from "lucide-react";
import { theme, Aspect } from "../lib/theme";

const MCP_TOOLS = [
  "code_query",
  "code_context",
  "graph_neighbors",
  "list_workspaces",
  "memory_recall",
  "memory_write",
  "index_workspace",
];

export const MCPSurface: React.FC<{ aspect: Aspect; startFrame?: number }> = ({
  aspect,
  startFrame = 0,
}) => {
  const frame = useCurrentFrame();
  const w = aspect === "16x9" ? 520 : 900;

  return (
    <div
      style={{
        width: w,
        background: "rgba(10,10,24,0.85)",
        border: `1px solid ${theme.color.primary}30`,
        borderRadius: 12,
        padding: 24,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <p
            style={{
              fontFamily: theme.font.mono,
              fontSize: 10,
              color: theme.color.primary,
              textTransform: "uppercase",
              letterSpacing: 2,
            }}
          >
            MCP server
          </p>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: theme.color.white, marginTop: 4 }}>
            Tools exposed to your agent
          </h3>
        </div>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: theme.font.mono,
            fontSize: 10,
            color: theme.color.primary,
          }}
        >
          <span
            style={{ width: 6, height: 6, borderRadius: "50%", background: theme.color.primary }}
          />
          ready
        </span>
      </div>
      {MCP_TOOLS.map((tool, i) => {
        const delay = startFrame + i * 8;
        const enter = spring({
          frame: Math.max(0, frame - delay),
          fps: 30,
          config: theme.spring.gentle,
        });
        return (
          <div
            key={tool}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 0",
              borderBottom: i < MCP_TOOLS.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
              opacity: enter,
              transform: `translateX(${(1 - enter) * 20}px)`,
            }}
          >
            <span style={{ fontFamily: theme.font.mono, fontSize: 10, color: theme.color.muted }}>
              0{i + 1}
            </span>
            <code style={{ fontFamily: theme.font.mono, fontSize: 14, color: theme.color.white }}>
              {tool}
            </code>
            <Check
              style={{ marginLeft: "auto", width: 14, height: 14, color: theme.color.primary }}
            />
          </div>
        );
      })}
    </div>
  );
};
```

- [ ] **Step 2: Create `video/src/components/LangBadges.tsx`**

```tsx
import React from "react";
import { spring, useCurrentFrame } from "remotion";
import { FileCode2 } from "lucide-react";
import { theme, Aspect } from "../lib/theme";

const LANGUAGES = [
  { name: "TypeScript", color: "#60a5fa" },
  { name: "JavaScript", color: "#facc15" },
  { name: "Python", color: "#4ade80" },
  { name: "Go", color: "#22d3ee" },
  { name: "Rust", color: "#fb923c" },
  { name: "YAML", color: "#f87171" },
  { name: "JSON", color: "#34d399" },
  { name: "TOML", color: "#c084fc" },
  { name: "Markdown", color: "#38bdf8" },
];

export const LangBadges: React.FC<{ aspect: Aspect; startFrame?: number }> = ({
  aspect,
  startFrame = 0,
}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        justifyContent: "center",
        maxWidth: aspect === "16x9" ? 600 : 900,
      }}
    >
      {LANGUAGES.map((lang, i) => {
        const enter = spring({
          frame: Math.max(0, frame - startFrame - i * 4),
          fps: 30,
          config: theme.spring.gentle,
        });
        return (
          <span
            key={lang.name}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              borderRadius: 20,
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.08)",
              fontFamily: theme.font.mono,
              fontSize: 13,
              color: theme.color.white,
              opacity: enter,
              transform: `scale(${0.8 + enter * 0.2})`,
            }}
          >
            <FileCode2 style={{ width: 12, height: 12, color: lang.color }} />
            {lang.name}
          </span>
        );
      })}
    </div>
  );
};
```

- [ ] **Step 3: Create `video/src/components/AgentLogos.tsx`**

```tsx
import React from "react";
import { spring, useCurrentFrame } from "remotion";
import { theme, Aspect } from "../lib/theme";

const AGENTS = ["Codex", "Claude", "OpenCode", "Windsurf", "Devin"];

export const AgentLogos: React.FC<{ aspect: Aspect; startFrame?: number }> = ({
  aspect,
  startFrame = 0,
}) => {
  const frame = useCurrentFrame();
  const cols = aspect === "16x9" ? 5 : 3;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: 12,
        maxWidth: aspect === "16x9" ? 700 : 900,
      }}
    >
      {AGENTS.map((agent, i) => {
        const enter = spring({
          frame: Math.max(0, frame - startFrame - i * 6),
          fps: 30,
          config: theme.spring.bounce,
        });
        return (
          <div
            key={agent}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "12px 20px",
              borderRadius: 10,
              background: "rgba(0,191,200,0.08)",
              border: `1px solid ${theme.color.primary}30`,
              fontFamily: theme.font.heading,
              fontSize: 16,
              fontWeight: 700,
              color: theme.color.white,
              opacity: enter,
              transform: `translateY(${(1 - enter) * 30}px)`,
            }}
          >
            {agent}
          </div>
        );
      })}
    </div>
  );
};
```

- [ ] **Step 4: Create `video/src/components/Timeline.tsx`**

```tsx
import React from "react";
import { spring, useCurrentFrame } from "remotion";
import { theme, Aspect } from "../lib/theme";

const STEPS = [
  {
    num: "01",
    title: "Init & Index",
    desc: "openez init parses codebase into documents, chunks, graph nodes in SQLite",
  },
  {
    num: "02",
    title: "Query & Explore",
    desc: "Full-text search fused with graph expansion. Inspect relationships.",
  },
  {
    num: "03",
    title: "Connect & Automate",
    desc: "MCP for agents, CLI for scripts, web dashboard. Same SQLite store.",
  },
];

export const Timeline: React.FC<{ aspect: Aspect; startFrame?: number }> = ({
  aspect,
  startFrame = 0,
}) => {
  const frame = useCurrentFrame();
  const vertical = aspect === "9x16";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        gap: vertical ? 40 : 60,
        alignItems: vertical ? "flex-start" : "center",
        maxWidth: vertical ? 900 : 1600,
      }}
    >
      {STEPS.map((step, i) => {
        const enter = spring({
          frame: Math.max(0, frame - startFrame - i * 20),
          fps: 30,
          config: theme.spring.gentle,
        });
        return (
          <div
            key={step.num}
            style={{
              flex: vertical ? "none" : 1,
              opacity: enter,
              transform: vertical
                ? `translateY(${(1 - enter) * 40}px)`
                : `translateX(${(1 - enter) * 40}px)`,
            }}
          >
            <div
              style={{
                fontFamily: theme.font.mono,
                fontSize: 12,
                color: theme.color.primary,
                marginBottom: 8,
              }}
            >
              {step.num}
            </div>
            <h3
              style={{
                fontFamily: theme.font.heading,
                fontSize: 22,
                fontWeight: 700,
                color: theme.color.white,
                marginBottom: 8,
              }}
            >
              {step.title}
            </h3>
            <p style={{ fontSize: 14, color: theme.color.muted, lineHeight: 1.5 }}>{step.desc}</p>
          </div>
        );
      })}
    </div>
  );
};
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd video && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/nus/projects/Asta/openez
git add video/src/components/MCPSurface.tsx video/src/components/LangBadges.tsx video/src/components/AgentLogos.tsx video/src/components/Timeline.tsx
git commit -m "feat(video): add MCPSurface, LangBadges, AgentLogos, Timeline components"
```

---

### Task 7: Scene components (7 scenes)

**Files:**

- Create: `video/src/scenes/SceneRouter.tsx`
- Create: `video/src/scenes/Scene01Hook.tsx`
- Create: `video/src/scenes/Scene02Problem.tsx`
- Create: `video/src/scenes/Scene03Solution.tsx`
- Create: `video/src/scenes/Scene04HowItWorks.tsx`
- Create: `video/src/scenes/Scene05Features.tsx`
- Create: `video/src/scenes/Scene06Demo.tsx`
- Create: `video/src/scenes/Scene07CTA.tsx`

**Interfaces:**

- Consumes: `Background`, `OrbitGraph`, `Terminal`, `TokenCounter`, `MCPSurface`, `LangBadges`, `AgentLogos`, `Timeline` from Task 5+6. `SpecScene` type from `lib/spec.ts`.
- Produces: `<SceneRouter scene={scene} aspect={aspect} />` dispatches to the correct scene component by `scene.id`.

- [ ] **Step 1: Create `video/src/scenes/SceneRouter.tsx`**

```tsx
import React from "react";
import { SpecScene } from "../lib/spec";
import { Aspect } from "../lib/theme";
import { Scene01Hook } from "./Scene01Hook";
import { Scene02Problem } from "./Scene02Problem";
import { Scene03Solution } from "./Scene03Solution";
import { Scene04HowItWorks } from "./Scene04HowItWorks";
import { Scene05Features } from "./Scene05Features";
import { Scene06Demo } from "./Scene06Demo";
import { Scene07CTA } from "./Scene07CTA";

const SCENE_MAP: Record<string, React.FC<{ scene: SpecScene; aspect: Aspect }>> = {
  scene_01_hook: Scene01Hook,
  scene_02_problem: Scene02Problem,
  scene_03_solution: Scene03Solution,
  scene_04_how: Scene04HowItWorks,
  scene_05_features: Scene05Features,
  scene_06_demo: Scene06Demo,
  scene_07_cta: Scene07CTA,
};

export const SceneRouter: React.FC<{ scene: SpecScene; aspect: Aspect }> = ({ scene, aspect }) => {
  const Comp = SCENE_MAP[scene.id];
  if (!Comp) return null;
  return <Comp scene={scene} aspect={aspect} />;
};
```

- [ ] **Step 2: Create `video/src/scenes/Scene01Hook.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { Background, Terminal, TokenCounter } from "../components";
import { theme, Aspect } from "../lib/theme";
import { SpecScene } from "../lib/spec";

const CODE_LINES = [
  "$ agent read src/index.ts",
  "reading 247 files...",
  "tokens: 50K 100K 150K 200K",
  "context window: exhausted",
  "re-reading src/index.ts...",
];

export const Scene01Hook: React.FC<{ scene: SpecScene; aspect: Aspect }> = ({ aspect }) => {
  const frame = useCurrentFrame();
  const flashRed = interpolate(frame, [180, 200, 220], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <Background aspect={aspect} />
      <div
        style={{
          display: "flex",
          flexDirection: aspect === "9x16" ? "column" : "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 60,
          height: "100%",
          padding: 80,
        }}
      >
        <Terminal lines={CODE_LINES} typingFrame={10} typeSpeed={1.5} aspect={aspect} />
        <div style={{ textAlign: "center" }}>
          <TokenCounter from={50000} to={200000} startFrame={30} durationFrames={150} />
          <div
            style={{
              fontFamily: theme.font.mono,
              fontSize: 14,
              color: theme.color.muted,
              marginTop: 8,
            }}
          >
            tokens per session
          </div>
        </div>
      </div>
      {flashRed > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: theme.color.danger,
            opacity: flashRed * 0.15,
          }}
        />
      )}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Create `video/src/scenes/Scene02Problem.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, spring, useCurrentFrame } from "remotion";
import { Background } from "../components";
import { theme, Aspect } from "../lib/theme";
import { SpecScene } from "../lib/spec";

const PROBLEMS = [
  {
    title: "Wasted token budget",
    desc: "200K tokens per session re-parsing files the agent already saw.",
  },
  {
    title: "No persistent memory",
    desc: "Agent memory resets every conversation. No durable code index.",
  },
  {
    title: "Cloud dependency risk",
    desc: "Most tools send your source code to cloud APIs. Non-starter for proprietary code.",
  },
];

export const Scene02Problem: React.FC<{ scene: SpecScene; aspect: Aspect }> = ({ aspect }) => {
  const frame = useCurrentFrame();
  const vertical = aspect === "9x16";

  return (
    <AbsoluteFill>
      <Background aspect={aspect} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          padding: 80,
          gap: 40,
        }}
      >
        <h2
          style={{
            fontFamily: theme.font.heading,
            fontSize: 48,
            fontWeight: 800,
            color: theme.color.white,
            textAlign: "center",
          }}
        >
          {aspect === "9x16"
            ? "No memory.\nNo graph.\nNo privacy."
            : "No memory. No graph. No privacy."}
        </h2>
        <div
          style={{
            display: "flex",
            flexDirection: vertical ? "column" : "row",
            gap: 24,
            maxWidth: vertical ? 900 : 1600,
          }}
        >
          {PROBLEMS.map((p, i) => {
            const enter = spring({
              frame: Math.max(0, frame - 20 - i * 15),
              fps: 30,
              config: theme.spring.gentle,
            });
            return (
              <div
                key={p.title}
                style={{
                  flex: vertical ? "none" : 1,
                  padding: 28,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  opacity: enter,
                  transform: `translateY(${(1 - enter) * 40}px)`,
                }}
              >
                <h3
                  style={{
                    fontFamily: theme.font.heading,
                    fontSize: 20,
                    fontWeight: 700,
                    color: theme.color.danger,
                    marginBottom: 12,
                  }}
                >
                  {p.title}
                </h3>
                <p style={{ fontSize: 15, color: theme.color.muted, lineHeight: 1.5 }}>{p.desc}</p>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: Create `video/src/scenes/Scene03Solution.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, interpolate } from "remotion";
import { Background, OrbitGraph } from "../components";
import { theme, Aspect } from "../lib/theme";
import { SpecScene } from "../lib/spec";

export const Scene03Solution: React.FC<{ scene: SpecScene; aspect: Aspect }> = ({ aspect }) => {
  const frame = useCurrentFrame();
  const logoEnter = spring({ frame, fps: 30, config: theme.spring.bounce });
  const taglineOpacity = interpolate(frame, [30, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const vertical = aspect === "9x16";

  const cx = vertical ? 540 : 1920 / 2;
  const cy = vertical ? 700 : 540;

  return (
    <AbsoluteFill>
      <Background aspect={aspect} />
      <OrbitGraph frame={frame} cx={cx} cy={cy} scale={vertical ? 1.2 : 1.5} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: vertical ? "flex-end" : "center",
          paddingBottom: vertical ? 200 : 0,
          gap: 24,
        }}
      >
        <div style={{ opacity: logoEnter, transform: `scale(${0.5 + logoEnter * 0.5})` }}>
          <h1
            style={{
              fontFamily: theme.font.heading,
              fontSize: 72,
              fontWeight: 800,
              color: theme.color.white,
              textAlign: "center",
            }}
          >
            OPEN<span style={{ color: theme.color.primary }}>EZ</span>
          </h1>
        </div>
        <div
          style={{
            opacity: taglineOpacity,
            fontFamily: theme.font.heading,
            fontSize: 28,
            fontWeight: 700,
            textAlign: "center",
          }}
        >
          <span
            style={{
              background: `linear-gradient(135deg, #ffffff, ${theme.color.primary})`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            Durable context for coding agents
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 5: Create `video/src/scenes/Scene04HowItWorks.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background, Timeline } from "../components";
import { theme, Aspect } from "../lib/theme";
import { SpecScene } from "../lib/spec";

export const Scene04HowItWorks: React.FC<{ scene: SpecScene; aspect: Aspect }> = ({ aspect }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <Background aspect={aspect} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          padding: 80,
          gap: 60,
        }}
      >
        <h2
          style={{
            fontFamily: theme.font.heading,
            fontSize: 44,
            fontWeight: 800,
            color: theme.color.white,
            textAlign: "center",
          }}
        >
          Init. Query. Connect.
        </h2>
        <Timeline aspect={aspect} startFrame={15} />
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 6: Create `video/src/scenes/Scene05Features.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background, MCPSurface, LangBadges, AgentLogos } from "../components";
import { theme, Aspect } from "../lib/theme";
import { SpecScene } from "../lib/spec";

export const Scene05Features: React.FC<{ scene: SpecScene; aspect: Aspect }> = ({ aspect }) => {
  const frame = useCurrentFrame();
  const vertical = aspect === "9x16";

  return (
    <AbsoluteFill>
      <Background aspect={aspect} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          padding: 60,
          gap: 40,
        }}
      >
        <h2
          style={{
            fontFamily: theme.font.heading,
            fontSize: 40,
            fontWeight: 800,
            color: theme.color.white,
            textAlign: "center",
          }}
        >
          7 tools · 9 languages · 5 agents
        </h2>
        <div
          style={{
            display: "flex",
            flexDirection: vertical ? "column" : "row",
            gap: 40,
            alignItems: "center",
          }}
        >
          <MCPSurface aspect={aspect} startFrame={10} />
          <div style={{ display: "flex", flexDirection: "column", gap: 30, alignItems: "center" }}>
            <LangBadges aspect={aspect} startFrame={60} />
            <AgentLogos aspect={aspect} startFrame={100} />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 7: Create `video/src/scenes/Scene06Demo.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { Background, Terminal } from "../components";
import { theme, Aspect } from "../lib/theme";
import { SpecScene } from "../lib/spec";

const DEMO_LINES = [
  "$ npx @openez-graph/cli setup codex",
  "configuring MCP server for codex...",
  "done. 7 tools exposed:",
  "  code_query  code_context  graph_neighbors",
  "  list_workspaces  memory_recall  memory_write",
  "  index_workspace",
  "",
  "> agent: code_query('how does indexing work?')",
  "  ranked result: src/indexer/parse.ts",
  "  tokens returned: 1,240 (saved 48K)",
];

export const Scene06Demo: React.FC<{ scene: SpecScene; aspect: Aspect }> = ({ aspect }) => {
  const frame = useCurrentFrame();
  const vertical = aspect === "9x16";

  return (
    <AbsoluteFill>
      <Background aspect={aspect} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          padding: 80,
          gap: 40,
        }}
      >
        <Terminal
          lines={DEMO_LINES}
          typingFrame={15}
          typeSpeed={1.2}
          aspect={aspect}
          height={vertical ? 600 : 450}
        />
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 8: Create `video/src/scenes/Scene07CTA.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, spring, useCurrentFrame } from "remotion";
import { Background, TokenCounter } from "../components";
import { theme, Aspect } from "../lib/theme";
import { SpecScene } from "../lib/spec";

export const Scene07CTA: React.FC<{ scene: SpecScene; aspect: Aspect }> = ({ aspect }) => {
  const frame = useCurrentFrame();
  const enter = spring({ frame, fps: 30, config: theme.spring.bounce });

  return (
    <AbsoluteFill>
      <Background aspect={aspect} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 32,
          opacity: enter,
          transform: `scale(${0.9 + enter * 0.1})`,
        }}
      >
        <h2
          style={{
            fontFamily: theme.font.heading,
            fontSize: 56,
            fontWeight: 800,
            color: theme.color.white,
            textAlign: "center",
          }}
        >
          Open source. Local-first.
        </h2>
        <code
          style={{
            fontFamily: theme.font.mono,
            fontSize: 28,
            color: theme.color.primary,
            padding: "16px 32px",
            background: "rgba(0,191,200,0.08)",
            border: `1px solid ${theme.color.primary}40`,
            borderRadius: 10,
          }}
        >
          npx @openez-graph/cli setup codex
        </code>
        <div style={{ fontFamily: theme.font.mono, fontSize: 18, color: theme.color.muted }}>
          github.com/asta-nguyen/openez-graph
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 9: Create barrel export `video/src/components/index.ts`**

```ts
export { Background } from "./Background";
export { OrbitGraph } from "./OrbitGraph";
export { Terminal } from "./Terminal";
export { TokenCounter } from "./TokenCounter";
export { MCPSurface } from "./MCPSurface";
export { LangBadges } from "./LangBadges";
export { AgentLogos } from "./AgentLogos";
export { Timeline } from "./Timeline";
```

- [ ] **Step 10: Verify TypeScript compiles**

```bash
cd video && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
cd /Users/nus/projects/Asta/openez
git add video/src/scenes/ video/src/components/index.ts
git commit -m "feat(video): add 7 scene components and SceneRouter"
```

---

### Task 8: Compositions + Root registration

**Files:**

- Modify: `video/src/Root.tsx`
- Create: `video/src/compositions/OpenEZLaunch16x9.tsx`
- Create: `video/src/compositions/OpenEZLaunch9x16.tsx`

**Interfaces:**

- Produces: Two registered compositions `OpenEZLaunch16x9Video` (1920×1080) and `OpenEZLaunch9x16Video` (1080×1920), each with `calculateMetadata` that sums audio durations.

- [ ] **Step 1: Create `video/src/compositions/OpenEZLaunch16x9.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { loadSpec, sceneStartFrames, Spec } from "../lib/spec";
import { SceneRouter } from "../scenes/SceneRouter";
import { Aspect } from "../lib/theme";

const spec = loadSpec();
const starts = sceneStartFrames();

export const OpenEZLaunch16x9: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#05050a" }}>
      {spec.scenes.map((scene, i) => (
        <Sequence key={scene.id} from={starts[i]} durationInFrames={scene.duration_frames}>
          <SceneRouter scene={scene} aspect="16x9" />
          <Audio src={staticFile(scene.audio)} />
          {scene.sfx && <Audio src={staticFile(`sfx/${scene.sfx}.wav`)} volume={0.22} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const calculateMetadata16x9 = async () => {
  const s = loadSpec();
  const total = s.scenes.reduce((sum, sc) => sum + sc.duration_frames, 0);
  return {
    durationInFrames: total,
    fps: 30,
    width: 1920,
    height: 1080,
  };
};
```

- [ ] **Step 2: Create `video/src/compositions/OpenEZLaunch9x16.tsx`**

```tsx
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { loadSpec, sceneStartFrames } from "../lib/spec";
import { SceneRouter } from "../scenes/SceneRouter";

const spec = loadSpec();
const starts = sceneStartFrames();

export const OpenEZLaunch9x16: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#05050a" }}>
      {spec.scenes.map((scene, i) => (
        <Sequence key={scene.id} from={starts[i]} durationInFrames={scene.duration_frames}>
          <SceneRouter scene={scene} aspect="9x16" />
          <Audio src={staticFile(scene.audio)} />
          {scene.sfx && <Audio src={staticFile(`sfx/${scene.sfx}.wav`)} volume={0.22} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const calculateMetadata9x16 = async () => {
  const s = loadSpec();
  const total = s.scenes.reduce((sum, sc) => sum + sc.duration_frames, 0);
  return {
    durationInFrames: total,
    fps: 30,
    width: 1080,
    height: 1920,
  };
};
```

- [ ] **Step 3: Rewrite `video/src/Root.tsx`**

```tsx
import { Composition } from "remotion";
import { OpenEZLaunch16x9, calculateMetadata16x9 } from "./compositions/OpenEZLaunch16x9";
import { OpenEZLaunch9x16, calculateMetadata9x16 } from "./compositions/OpenEZLaunch9x16";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="OpenEZLaunch16x9Video"
        component={OpenEZLaunch16x9}
        calculateMetadata={calculateMetadata16x9}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="OpenEZLaunch9x16Video"
        component={OpenEZLaunch9x16}
        calculateMetadata={calculateMetadata9x16}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd video && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Boot Remotion Studio to verify compositions load**

```bash
cd video && timeout 15 npx remotion studio --port 3123
```

Expected: Studio starts, both compositions appear in the left sidebar. If it times out that's fine — the key is no crash on startup.

- [ ] **Step 6: Commit**

```bash
cd /Users/nus/projects/Asta/openez
git add video/src/Root.tsx video/src/compositions/
git commit -m "feat(video): register 16x9 and 9x16 compositions with audio sequences"
```

---

### Task 9: SFX placeholders + still frame verification

**Files:**

- Create: `video/public/sfx/ding.wav` (silent 1s placeholder)
- Create: `video/public/sfx/whoosh.wav` (silent 1s placeholder)
- Create: `video/public/sfx/keyboard.wav` (silent 1s placeholder)

**Interfaces:**

- Produces: SFX files so `<Audio src={staticFile('sfx/ding.wav')}>` doesn't crash. Replace with real SFX later.

- [ ] **Step 1: Generate silent SFX placeholders with ffmpeg**

```bash
cd video
mkdir -p public/sfx
ffmpeg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t 1 -y public/sfx/ding.wav
ffmpeg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t 1 -y public/sfx/whoosh.wav
ffmpeg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t 1 -y public/sfx/keyboard.wav
```

- [ ] **Step 2: Render still frames for 16:9 (opening, middle, ending)**

```bash
cd video
npx remotion still OpenEZLaunch16x9Video /tmp/openez-16x9-opening.png --frame=15
npx remotion still OpenEZLaunch16x9Video /tmp/openez-16x9-middle.png --frame=900
npx remotion still OpenEZLaunch16x9Video /tmp/openez-16x9-ending.png --frame=2600
```

Expected: 3 PNG files created. Open them to verify visual layout. If a scene looks broken, note which scene and fix in the scene component.

- [ ] **Step 3: Render still frames for 9:16**

```bash
cd video
npx remotion still OpenEZLaunch9x16Video /tmp/openez-9x16-opening.png --frame=15
npx remotion still OpenEZLaunch9x16Video /tmp/openez-9x16-middle.png --frame=900
npx remotion still OpenEZLaunch9x16Video /tmp/openez-9x16-ending.png --frame=2600
```

Expected: 3 PNG files created. Verify vertical layout.

- [ ] **Step 4: Commit SFX placeholders**

```bash
cd /Users/nus/projects/Asta/openez
git add video/public/sfx/
git commit -m "feat(video): add silent SFX placeholders for ding, whoosh, keyboard"
```

---

### Task 10: Full render + verification

**Files:**

- Output: `video/out/OpenEZLaunch16x9.mp4`
- Output: `video/out/OpenEZLaunch9x16.mp4`

- [ ] **Step 1: Render 16:9 video**

```bash
cd video
npx remotion render OpenEZLaunch16x9Video out/OpenEZLaunch16x9.mp4
```

Expected: MP4 file created in `out/`. No errors. Duration should match spec total (~90s).

- [ ] **Step 2: Render 9:16 video**

```bash
cd video
npx remotion render OpenEZLaunch9x16Video out/OpenEZLaunch9x16.mp4
```

Expected: MP4 file created in `out/`.

- [ ] **Step 3: Verify output files**

```bash
ls -la video/out/
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 video/out/OpenEZLaunch16x9.mp4
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 video/out/OpenEZLaunch9x16.mp4
```

Expected: both files exist, durations ~90s, within 2s of each other.

- [ ] **Step 4: Final commit (gitignore out/ so just confirm .gitignore covers it)**

```bash
cd /Users/nus/projects/Asta/openez
grep -q "^out/" video/.gitignore && echo "OK: out/ is gitignored" || echo "WARN: add out/ to .gitignore"
```

If WARN, add `out/` to `video/.gitignore` and commit that.

---

## Self-Review Notes

**Spec coverage:**

- Module at `video/` standalone ✓ (Task 1)
- Theme/spec/audio helper ✓ (Task 2)
- Voice pipeline (voice.mjs, sync-audio.mjs, validate-spec.mjs) ✓ (Task 3)
- Ref audio copied ✓ (Task 3 Step 1)
- TTS generation ✓ (Task 4)
- 7 scene components ✓ (Task 7)
- 2 compositions (16:9 + 9:16) ✓ (Task 8)
- OrbitGraph port from OG script ✓ (Task 5 Step 2)
- All shared components ✓ (Tasks 5+6)
- SFX ✓ (Task 9)
- Render + verify ✓ (Task 10)
- README with prerequisites ✓ (Task 1 Step 5)

**Placeholder scan:** No TBDs. All code blocks are complete.

**Type consistency:** `SpecScene` used consistently. `Aspect = "16x9" | "9x16"` used in all scene components. `theme` object shape consistent across all components.
