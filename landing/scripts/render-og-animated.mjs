import { Renderer, initSync } from '@takumi-rs/wasm';
import { fromHtml } from '@takumi-rs/helpers/html';
import { readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import ffmpegStatic from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const ffmpegBin = ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const landingRoot = join(__dirname, '..');
const repoRoot = join(landingRoot, '..');
const outPath = join(landingRoot, 'public', 'og-animated.gif');

const cliVersion = JSON.parse(readFileSync(join(repoRoot, 'apps/cli/package.json'), 'utf-8')).version;

const GLOBE_CX = 850;
const GLOBE_CY = 315;

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

const RING_RADII = [80, 150, 220];

const ORBIT_EDGES = [
  [0, 3], [0, 4], [1, 4], [1, 5], [2, 5], [2, 3],
  [3, 8], [4, 9], [4, 10], [5, 11], [6, 12], [7, 13],
  [0, 1], [1, 2], [2, 0],
];

async function loadFont(family, weight) {
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@${weight}&display=swap`;
    const cssRes = await fetch(cssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      cache: 'force-cache',
    });
    if (!cssRes.ok) return null;
    const css = await cssRes.text();
    const match = css.match(/src:\s*url\(([^)]+)\)/);
    if (!match) return null;
    const fontRes = await fetch(match[1], { cache: 'force-cache' });
    if (!fontRes.ok) return null;
    return await fontRes.arrayBuffer();
  } catch {
    return null;
  }
}

function faviconDataUri() {
  const png = readFileSync(join(landingRoot, 'src/app/icon.png'));
  const b64 = Buffer.from(png).toString('base64');
  return `data:image/png;base64,${b64}`;
}

function ringRotation(t, ring) {
  const speeds = [360, -240, 180];
  return t * speeds[ring];
}

function nodeDepth(angle) {
  const rad = (angle * Math.PI) / 180;
  const z = Math.cos(rad);
  return {
    scale: 0.5 + 0.5 * ((z + 1) / 2),
    opacity: 0.3 + 0.7 * ((z + 1) / 2),
  };
}

function nodePosition(ring, baseAngle, rotation) {
  const radius = RING_RADII[ring];
  const angleDeg = baseAngle + rotation;
  const rad = (angleDeg * Math.PI) / 180;
  const x = GLOBE_CX + radius * Math.cos(rad);
  const y = GLOBE_CY + (ring - 1) * 20 + radius * Math.sin(rad) * 0.3;
  const depthAngle = ((angleDeg % 360) + 360) % 360;
  return { x, y, depthAngle };
}

function twinkle(t, phase) {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.6 + 0.4 * (v * 0.5 + 0.5);
}

function edgePulse(t, phase) {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.08 + 0.12 * (v * 0.5 + 0.5);
}

function hubGlow(t, phase) {
  const v = Math.sin((t + phase) * Math.PI * 2);
  return 0.18 + 0.17 * (v * 0.5 + 0.5);
}

function buildFrameHtml(t, ctx) {
  const { displayFont, monoFont, logoUri, starCount, formatStars } = ctx;
  const rotations = [ringRotation(t, 0), ringRotation(t, 1), ringRotation(t, 2)];

  const nodeData = ORBIT_NODES.map((n, i) => {
    const pos = nodePosition(n.ring, n.angle, rotations[n.ring]);
    const depth = nodeDepth(pos.depthAngle);
    return { ...n, ...pos, ...depth, idx: i };
  });

  const sortedNodes = [...nodeData].sort((a, b) => a.scale - b.scale);

  // Edges — thin rotated div lines between nodes
  const edges = ORBIT_EDGES.map(([fi, ti], i) => {
    const f = nodeData[fi];
    const td = nodeData[ti];
    const avgScale = (f.scale + td.scale) / 2;
    const phase = i / ORBIT_EDGES.length;
    const pulse = edgePulse(t, phase);
    const opacity = Math.max(0.01, pulse * avgScale);
    const dx = td.x - f.x;
    const dy = td.y - f.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const sw = Math.max(0.5, 1.5 * avgScale);
    return `<div style="position:absolute;left:${f.x}px;top:${f.y - sw / 2}px;width:${len}px;height:${sw}px;background:rgba(0,191,200,${opacity});transform:rotate(${angle}deg);transform-origin:0 ${sw / 2}px"></div>`;
  }).join('');

  // Nodes — div circles
  const nodes = sortedNodes.map((n) => {
    const phase = n.idx / ORBIT_NODES.length;
    const twinkleVal = n.hub ? hubGlow(t, phase) : twinkle(t, phase);
    const opacity = Math.max(0.01, twinkleVal * n.opacity);
    const radius = Math.max(1, n.r * n.scale);
    const d = radius * 2;
    const baseColor = n.hub ? '0,191,200' : n.ring === 2 ? '204,93,195' : '0,191,200';
    const border = n.hub ? '1px solid rgba(0,191,200,0.3)' : '1px solid rgba(255,255,255,0.05)';
    const hubRing = n.hub ? `<div style="position:absolute;left:${n.x - radius * 2.5}px;top:${n.y - radius * 2.5}px;width:${radius * 5}px;height:${radius * 5}px;border-radius:50%;border:0.5px solid rgba(0,191,200,0.04)"></div>` : '';
    return `${hubRing}<div style="position:absolute;left:${n.x - radius}px;top:${n.y - radius}px;width:${d}px;height:${d}px;border-radius:50%;background:rgba(${baseColor},${opacity});border:${border}"></div>`;
  }).join('');

  const starSection = `<div style="display:flex;align-items:center;gap:6px"><span style="font-size:10px;color:#ffffff;font-family:${monoFont};font-weight:600">GitHub</span>${starCount !== null ? `<span style="font-size:11px;color:rgba(0,191,200,0.7);font-family:${monoFont};font-weight:700">${formatStars(starCount)}</span>` : ''}</div><span style="font-size:3px;color:rgba(255,255,255,0.12)">\u25cf</span>`;

  return `<div style="width:1200px;height:630px;background:linear-gradient(150deg, #05050a 0%, #08081a 35%, #06060d 65%, #0a0a18 100%);display:flex;flex-direction:column;position:relative;overflow:hidden">
  <div style="position:absolute;top:${GLOBE_CY - 300}px;left:${GLOBE_CX - 300}px;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle, rgba(0,191,200,0.12) 0%, rgba(0,191,200,0.04) 30%, transparent 60%)"></div>
  <div style="position:absolute;bottom:-120px;left:-80px;width:550px;height:550px;border-radius:50%;background:radial-gradient(circle, rgba(204,93,195,0.06) 0%, transparent 55%)"></div>
  <div style="position:absolute;inset:0;left:0;top:0">${edges}${nodes}</div>
  <div style="position:absolute;inset:0;background:linear-gradient(90deg, rgba(5,5,10,0.92) 0%, rgba(5,5,10,0.7) 35%, rgba(5,5,10,0.2) 60%, transparent 80%)"></div>
  <div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg, transparent 10%, rgba(0,191,200,0.25) 50%, transparent 90%)"></div>
  <div style="display:flex;flex-direction:column;flex:1;position:relative;padding:0 72px">
    <div style="display:flex;align-items:center;gap:10px;padding-top:28px">
      <img src="${logoUri}" alt="" width="28" height="28" style="border-radius:5px"/>
      <span style="font-size:14px;font-weight:700;color:#ffffff;font-family:${displayFont};letter-spacing:-0.02em">OpenEZ Graph</span>
      <span style="font-size:8px;font-weight:600;color:rgba(0,191,200,0.7);font-family:${monoFont};letter-spacing:0.3em;text-transform:uppercase">v${cliVersion}</span>
    </div>
    <div style="display:flex;flex:1;align-items:center;padding-bottom:16px">
      <div style="display:flex;flex-direction:column;max-width:760px">
        <div style="display:flex;flex-direction:column;font-size:76px;font-family:${displayFont};font-weight:800;letter-spacing:-0.03em;line-height:1.02">
          <span style="background:linear-gradient(135deg, #ffffff, #3dd0d0);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent">Understand</span>
          <span style="background:linear-gradient(135deg, #ffffff, #3dd0d0);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent">Your Codebase</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:14px">
          <div style="width:28px;height:1.5px;background:rgba(0,191,200,0.2);border-radius:1px"></div>
          <span style="font-size:12px;font-family:${monoFont};color:#ffffff;letter-spacing:0.06em">Local-first \u00b7 MCP-native \u00b7 No Postgres</span>
        </div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:14px;border-top:1px solid rgba(255,255,255,0.07);padding-top:14px;padding-bottom:24px">
      ${starSection}
      <span style="font-size:9px;color:#ffffff;font-family:${monoFont};letter-spacing:0.08em;text-transform:uppercase">Code Intelligence Engine</span>
      <span style="font-size:3px;color:rgba(255,255,255,0.15)">\u25cf</span>
      <span style="font-size:9px;color:#ffffff;font-family:${monoFont};letter-spacing:0.08em;text-transform:uppercase">Open Source</span>
    </div>
  </div>
</div>`;
}

async function main() {
  const [syne700, syne800, jbMono400, jbMono600] = await Promise.all([
    loadFont('Syne', 700),
    loadFont('Syne', 800),
    loadFont('JetBrains Mono', 400),
    loadFont('JetBrains Mono', 600),
  ]);

  const displayFont = (syne700 || syne800) ? 'Syne, system-ui, sans-serif' : 'system-ui, sans-serif';
  const monoFont = (jbMono400 || jbMono600) ? 'JetBrains Mono, monospace' : 'ui-monospace, monospace';
  const logoUri = faviconDataUri();

  let starCount = null;
  try {
    const res = await fetch('https://api.github.com/repos/asta-nguyen/openez-graph', { cache: 'force-cache', signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.stargazers_count === 'number') starCount = data.stargazers_count;
    }
  } catch {}

  const formatStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  const fonts = [];
  if (syne700) fonts.push({ name: 'Syne', data: syne700, weight: 700, style: 'normal' });
  if (syne800) fonts.push({ name: 'Syne', data: syne800, weight: 800, style: 'normal' });
  if (jbMono400) fonts.push({ name: 'JetBrains Mono', data: jbMono400, weight: 400, style: 'normal' });
  if (jbMono600) fonts.push({ name: 'JetBrains Mono', data: jbMono600, weight: 600, style: 'normal' });

  const wasmPath = new URL('../node_modules/@takumi-rs/wasm/pkg/takumi_wasm_bg.wasm', import.meta.url);
  const wasmModule = await readFile(wasmPath);
  initSync(wasmModule);

  const renderer = new Renderer({
    fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })),
    loadDefaultFonts: !(syne700 && syne800 && jbMono400 && jbMono600),
  });

  const ctx = { displayFont, monoFont, logoUri, starCount, formatStars };

  const fps = 24;
  const forwardMs = 2000;
  const forwardFrames = Math.floor((forwardMs / 1000) * fps);

  const { stylesheets } = fromHtml(buildFrameHtml(0, ctx));

  const tmpDir = await mkdtemp(join(tmpdir(), 'openez-og-'));
  try {
    let frameIdx = 0;
    for (let i = 0; i < forwardFrames; i++) {
      const t = i / (forwardFrames - 1);
      const { node } = fromHtml(buildFrameHtml(t, ctx));
      const pngBuffer = renderer.render(node, { width: 1200, height: 630, format: 'png', stylesheets });
      await writeFile(join(tmpDir, `frame_${String(frameIdx).padStart(5, '0')}.png`), pngBuffer);
      frameIdx++;
    }
    for (let i = forwardFrames - 2; i >= 1; i--) {
      const t = i / (forwardFrames - 1);
      const { node } = fromHtml(buildFrameHtml(t, ctx));
      const pngBuffer = renderer.render(node, { width: 1200, height: 630, format: 'png', stylesheets });
      await writeFile(join(tmpDir, `frame_${String(frameIdx).padStart(5, '0')}.png`), pngBuffer);
      frameIdx++;
    }

    if (frameIdx % 10 === 0) console.log(`frame ${frameIdx}`);

    const palettePath = join(tmpDir, 'palette.png');
    const framePattern = join(tmpDir, 'frame_%05d.png');

    await execFileAsync(
      ffmpegBin,
      ['-framerate', String(fps), '-i', framePattern, '-vf', 'palettegen=stats_mode=full', '-y', palettePath],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
    );

    await execFileAsync(
      ffmpegBin,
      ['-framerate', String(fps), '-i', framePattern, '-i', palettePath, '-lavfi', 'paletteuse=dither=bayer:bayer_scale=5', '-y', outPath],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
    );

    console.log(`Wrote ${outPath} (${frameIdx} frames)`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
