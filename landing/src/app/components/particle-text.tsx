"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

/* ── Sample text pixels → world positions (ported from kamehadb) ── */
function sampleText(
  text: string,
  gradientPart: string | undefined,
  count: number,
  fontSize: number,
  weight: number,
  maxWidth: number,
  fontFamily: string,
): {
  positions: Float32Array;
  isGradient: Uint8Array;
  canvasW: number;
  canvasH: number;
  bboxH: number;
  centerY: number;
} {
  if (typeof document === "undefined")
    return {
      positions: new Float32Array(count * 3),
      isGradient: new Uint8Array(count),
      canvasW: 0,
      canvasH: 0,
      bboxH: 0,
      centerY: 0,
    };

  const SCALE = 4;
  const canvasFont = fontSize * SCALE;
  const canvasMaxW = maxWidth * SCALE;
  const fontStack = `${weight} ${canvasFont}px ${fontFamily}, system-ui, sans-serif`;

  // Word wrap
  const measureCtx = document.createElement("canvas").getContext("2d")!;
  measureCtx.font = fontStack;

  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (measureCtx.measureText(testLine).width <= canvasMaxW) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  const lineHeight = canvasFont * 1.1;
  const totalHeight = lines.length * lineHeight;
  const W = Math.ceil(canvasMaxW);
  const H = Math.ceil(totalHeight + canvasFont * 0.3);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const cctx = canvas.getContext("2d")!;
  cctx.font = fontStack;
  cctx.textAlign = "center";
  cctx.textBaseline = "middle";
  const startY = H / 2 - totalHeight / 2 + lineHeight / 2;

  // Draw all text white first
  cctx.fillStyle = "white";
  lines.forEach((line, i) =>
    cctx.fillText(line, W / 2, startY + i * lineHeight),
  );

  // Draw gradient part in red to mark those pixels.
  // Handles substrings (e.g. "EZ" inside "OPENEZ"), not just whole words.
  if (gradientPart) {
    lines.forEach((line, i) => {
      const idx = line.indexOf(gradientPart);
      if (idx === -1) return;
      const lineWidth = cctx.measureText(line).width;
      const lineStartX = W / 2 - lineWidth / 2;
      const prefixWidth = cctx.measureText(line.slice(0, idx)).width;
      const gradX = lineStartX + prefixWidth;
      cctx.fillStyle = "red";
      cctx.textAlign = "left";
      cctx.fillText(gradientPart, gradX, startY + i * lineHeight);
      cctx.textAlign = "center";
      cctx.fillStyle = "white";
    });
  }

  // Sample pixels
  const { data } = cctx.getImageData(0, 0, W, H);
  const pts: [number, number, boolean][] = [];
  let minX = W,
    minY = H,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      if (data[idx + 3] > 128) {
        const r = data[idx];
        const b = data[idx + 2];
        const isGrad = r > 200 && b < 100;
        pts.push([x, y, isGrad]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bboxH = maxY - minY || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const pos = new Float32Array(count * 3);
  const isGrad = new Uint8Array(count);
  if (pts.length) {
    for (let i = 0; i < count; i++) {
      const [px, py, g] = pts[Math.floor(Math.random() * pts.length)];
      pos[i * 3] = px - cx;
      pos[i * 3 + 1] = -(py - cy);
      pos[i * 3 + 2] = 0;
      isGrad[i] = g ? 1 : 0;
    }
  }
  // Return the centered Y so the caller can shift for vertical alignment
  return {
    positions: pos,
    isGradient: isGrad,
    canvasW: W,
    canvasH: H,
    bboxH,
    centerY: cy,
  };
}

/* ── Shaders — clean push-repel hover (Codrops/sanprieto style) ── */
const VERT = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uProgress;
  uniform vec2  uCursor;
  uniform float uCursorStrength;
  uniform float uCursorRadius;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uCameraZ;
  uniform float uCanvasW;
  uniform int   uEntranceMode; // 0=staggered, 1=rise-up, 2=fall-down, 3=wave-right, 4=wave-left,
                               // 5=radial-bloom, 6=radial-implode, 7=explode-inward, 8=converge,
                               // 9=diverge, 10=typewriter, 11=back-out, 12=elastic-out,
                               // 13=bounce-out, 14=blur-in, 15=scale-up
  uniform int   uHoverMode; // 0=dissolve, 1=magnet+burst, 2=ripple, 3=fade-vanish, 4=vortex,
                            // 5=explode, 6=shake, 7=blackhole, 8=wave, 9=freeze,
                            // 10=shatter, 11=inflate, 12=gravity, 13=lightning, 14=liquid,
                            // 15=glitch, 16=bokeh, 17=pulse, 18=spiral, 19=echo,
                            // 20=tornado, 21=ember, 22=matrix, 23=constellation, 24=lens,
                            // 25=drain, 26=confetti, 27=assemble, 28=stretch, 29=breathing,
                            // 30=quantum, 31=magnetize, 32=orbit, 33=spiralout, 34=hueshift,
                            // 35=parallax, 36=bounce, 37=morph, 38=static, 39=cloak,
                            // 40=slice, 41=mirror, 42=sand, 43=bubbles, 44=pinch,
                            // 45=twist, 46=comet, 47=flatten, 48=ink, 49=wind

  attribute vec3 aTarget;
  attribute vec3 aOrigin;
  attribute float aPhase;
  attribute float aSpeed;
  attribute vec3 aColor;
  attribute float aAmbient;

  varying float vAlpha;
  varying vec3  vColor;
  varying float vGlow;
  varying float vHoverScale;

  void main() {
    // ── Entrance animations ──
    float distFromCenter = length(aTarget.xy);
    float maxRadius = uCanvasW * 0.55;
    float xNorm = (aTarget.x + uCanvasW * 0.5) / uCanvasW;
    float yNorm = (aTarget.y + maxRadius) / (maxRadius * 2.0);

    vec3 pos = aTarget;
    float entranceAlpha = 1.0;

    if (uEntranceMode == 0) {
      // Staggered center-out with power3.out
      float staggerDelay = (distFromCenter / maxRadius) * 0.5;
      float t = clamp((uProgress * 1.3 - staggerDelay) / 0.6, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      pos = mix(aOrigin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 1) {
      // Rise up — particles fly in from below
      float t = clamp(uProgress * 1.3, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = aTarget;
      origin.y -= maxRadius * 1.5;
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 2) {
      // Fall down — particles fall from above
      float t = clamp(uProgress * 1.3, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = aTarget;
      origin.y += maxRadius * 1.5;
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 3) {
      // Wave right — left-to-right reveal
      float delay = xNorm * 0.5;
      float t = clamp((uProgress * 1.3 - delay) / 0.5, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = aTarget;
      origin.x -= uCanvasW * 0.8;
      origin.y += (aPhase - 0.5) * maxRadius * 0.3;
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 4) {
      // Wave left — right-to-left reveal
      float delay = (1.0 - xNorm) * 0.5;
      float t = clamp((uProgress * 1.3 - delay) / 0.5, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = aTarget;
      origin.x += uCanvasW * 0.8;
      origin.y += (aPhase - 0.5) * maxRadius * 0.3;
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 5) {
      // Radial bloom — center-out Gaussian wave
      float delay = (distFromCenter / maxRadius) * 0.5;
      float t = clamp((uProgress * 1.3 - delay) / 0.5, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = vec3(0.0, 0.0, aTarget.z);
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 6) {
      // Radial implode — outside-in contraction
      float delay = (1.0 - distFromCenter / maxRadius) * 0.5;
      float t = clamp((uProgress * 1.3 - delay) / 0.5, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = aTarget * 2.0;
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 7) {
      // Explode inward — scattered origins implode to targets
      float t = clamp(uProgress * 1.2, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 4.0);
      pos = mix(aOrigin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 8) {
      // Converge — particles converge from screen edges
      float t = clamp(uProgress * 1.3, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = aTarget;
      float edgeX = aTarget.x > 0.0 ? uCanvasW * 0.6 : -uCanvasW * 0.6;
      float edgeY = aTarget.y > 0.0 ? maxRadius : -maxRadius;
      origin.x = edgeX;
      origin.y = edgeY;
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 9) {
      // Diverge — particles start at center, diverge outward
      float delay = (distFromCenter / maxRadius) * 0.4;
      float t = clamp((uProgress * 1.4 - delay) / 0.6, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = vec3(0.0, 0.0, aTarget.z);
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 10) {
      // Typewriter — letter-by-letter reveal (quantized x)
      float colWidth = uCanvasW / 6.0; // ~6 letters
      float letterIdx = floor((aTarget.x + uCanvasW * 0.5) / colWidth);
      float delay = letterIdx * 0.12;
      float t = clamp((uProgress * 1.5 - delay) / 0.4, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = aTarget;
      origin.y -= maxRadius * 0.5;
      origin.x += (aPhase - 0.5) * 40.0;
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 11) {
      // Back out — overshoot then settle
      float t = clamp(uProgress * 1.2, 0.0, 1.0);
      float c1 = 1.70158;
      float c3 = c1 + 1.0;
      float ease = 1.0 + c3 * pow(t - 1.0, 3.0) + c1 * pow(t - 1.0, 2.0);
      ease = clamp(ease, 0.0, 1.3);
      pos = mix(aOrigin, aTarget, ease);
      entranceAlpha = clamp(ease, 0.0, 1.0);
    }
    else if (uEntranceMode == 12) {
      // Elastic out — bouncy spring
      float t = clamp(uProgress * 1.3, 0.0, 1.0);
      float c4 = (2.0 * 3.14159265) / 3.0;
      float ease = t == 0.0 ? 0.0 : t >= 1.0 ? 1.0 :
        pow(2.0, -10.0 * t) * sin((t * 10.0 - 0.75) * c4) + 1.0;
      ease = clamp(ease, 0.0, 1.2);
      pos = mix(aOrigin, aTarget, ease);
      entranceAlpha = clamp(ease, 0.0, 1.0);
    }
    else if (uEntranceMode == 13) {
      // Bounce out — multiple bounces before settling
      float t = clamp(uProgress * 1.3, 0.0, 1.0);
      float n1 = 7.5625;
      float d1 = 2.75;
      float ease;
      if (t < 1.0 / d1) {
        ease = n1 * t * t;
      } else if (t < 2.0 / d1) {
        float t2 = t - 1.5 / d1;
        ease = n1 * t2 * t2 + 0.75;
      } else if (t < 2.5 / d1) {
        float t3 = t - 2.25 / d1;
        ease = n1 * t3 * t3 + 0.9375;
      } else {
        float t4 = t - 2.625 / d1;
        ease = n1 * t4 * t4 + 0.984375;
      }
      pos = mix(aOrigin, aTarget, ease);
      entranceAlpha = ease;
    }
    else if (uEntranceMode == 14) {
      // Blur in — large z-spread, focus to plane
      float t = clamp(uProgress * 1.2, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      vec3 origin = aTarget;
      origin.z += (aPhase - 0.5) * 600.0;
      pos = mix(origin, aTarget, ease);
      entranceAlpha = ease;
    }
    else {
      // Scale up — particles start tiny, grow to full size
      float t = clamp(uProgress * 1.3, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - t, 3.0);
      pos = aTarget;
      entranceAlpha = ease;
      // Scale handled via point size multiplier below
    }

    // Hover effect
    float hoverFade = 1.0;
    vGlow = 0.0;
    vHoverScale = 1.0;

    // Ambient drift
    if (aAmbient > 0.5) {
      float dx = sin(uTime * 0.6 + aPhase * 11.3) * cos(uTime * 0.4 + aSpeed * 7.7);
      float dy = cos(uTime * 0.5 + aPhase * 8.1) * sin(uTime * 0.7 + aSpeed * 5.3);
      float dz = sin(uTime * 0.3 + aPhase * 13.0) * cos(uTime * 0.5 + aSpeed * 9.1);
      pos.x += dx * uCursorRadius * 0.6;
      pos.y += dy * uCursorRadius * 0.6;
      pos.z += dz * uCursorRadius * 0.4;
    }

    // ── Hover: 5 selectable modes, all with Gaussian falloff ──
    vec2 toCursor = pos.xy - uCursor;
    float distSq  = dot(toCursor, toCursor);
    float dist    = sqrt(distSq);
    bool cursorOn = uCursor.x < 90000.0;

    float sigma = uCursorRadius * 0.45;
    float strength = cursorOn
      ? exp(-distSq / (2.0 * sigma * sigma)) * uCursorStrength
      : 0.0;

    if (strength > 0.001) {
      vec2 dir = dist < 0.01
        ? vec2(aPhase - 0.5, aSpeed - 0.5)
        : toCursor / dist;

      if (uHoverMode == 0) {
        // ── DISSOLVE: angular scatter + noise jitter ──
        float angle = atan(dir.y, dir.x) + (aPhase - 0.5) * 3.0;
        pos.xy += vec2(cos(angle), sin(angle)) * strength * uCursorRadius * 4.0;
        pos.z += strength * uCursorRadius * 1.0;
        float n1 = sin(uTime * 6.0 + aPhase * 43.7) * cos(uTime * 5.0 + aSpeed * 31.3);
        float n2 = cos(uTime * 5.0 + aPhase * 29.1) * sin(uTime * 7.0 + aSpeed * 37.7);
        pos.xy += vec2(n1, n2) * strength * uCursorRadius * 0.6;
        vGlow = strength;
      }
      else if (uHoverMode == 1) {
        // ── MAGNET + BURST: pull in, then explode outward ──
        float phase = sin(uTime * 3.0 + aPhase * 6.28);
        float magnetPull = -strength * uCursorRadius * 2.0 * (0.5 + 0.5 * phase);
        float burstPush = strength * uCursorRadius * 5.0 * (0.5 - 0.5 * phase);
        pos.xy += dir * (magnetPull + burstPush);
        pos.z += strength * uCursorRadius * 1.5 * phase;
        vGlow = strength * (0.5 + 0.5 * abs(phase));
      }
      else if (uHoverMode == 2) {
        // ── RIPPLE: concentric waves outward from cursor ──
        float wave = sin(dist * 0.15 - uTime * 5.0);
        float rippleStrength = strength * wave;
        pos.xy += dir * rippleStrength * uCursorRadius * 3.0;
        pos.z += rippleStrength * uCursorRadius * 1.0;
        vGlow = strength * (0.5 + 0.5 * abs(wave));
      }
      else if (uHoverMode == 3) {
        // ── FADE VANISH: particles near cursor disappear ──
        pos.z -= strength * uCursorRadius * 2.0;
        pos.xy += dir * strength * uCursorRadius * 1.5;
        hoverFade = 1.0 - strength * 0.95;
        vGlow = strength * 0.3;
      }
      else if (uHoverMode == 4) {
        // ── VORTEX: particles swirl around cursor ──
        float swirlAngle = atan(dir.y, dir.x) + uTime * 2.0 + dist * 0.02;
        float orbitR = dist + strength * uCursorRadius * 0.5;
        pos.x = uCursor.x + cos(swirlAngle) * orbitR;
        pos.y = uCursor.y + sin(swirlAngle) * orbitR;
        pos.z += strength * uCursorRadius * 0.8;
        vGlow = strength;
      }
      else if (uHoverMode == 5) {
        // ── EXPLODE: violent burst outward in all directions ──
        float burst = strength * uCursorRadius * 8.0;
        pos.xy += dir * burst;
        pos.z += strength * uCursorRadius * 3.0;
        // Extra random kick per particle
        pos.x += (aPhase - 0.5) * burst * 0.5;
        pos.y += (aSpeed - 0.5) * burst * 0.5;
        vGlow = strength;
      }
      else if (uHoverMode == 6) {
        // ── SHAKE: rapid vibration/trembling near cursor ──
        float shakeFreq = 30.0;
        float shakeAmp = strength * uCursorRadius * 1.5;
        pos.x += sin(uTime * shakeFreq + aPhase * 100.0) * shakeAmp;
        pos.y += cos(uTime * shakeFreq + aSpeed * 100.0) * shakeAmp;
        pos.z += sin(uTime * shakeFreq * 1.3 + aPhase * 50.0) * shakeAmp * 0.5;
        vGlow = strength * 0.7;
      }
      else if (uHoverMode == 7) {
        // ── BLACK HOLE: suck particles in and shrink them ──
        float pull = strength * uCursorRadius * 6.0;
        pos.xy -= dir * pull;
        pos.z -= strength * uCursorRadius * 2.0;
        // Spiral inward
        float spiralA = atan(dir.y, dir.x) - uTime * 4.0;
        float spiralR = dist * (1.0 - strength * 0.8);
        pos.x = uCursor.x + cos(spiralA) * spiralR;
        pos.y = uCursor.y + sin(spiralA) * spiralR;
        hoverFade = 1.0 - strength * 0.6;
        vGlow = strength;
      }
      else if (uHoverMode == 8) {
        // ── WAVE: perpendicular sine wave displacement ──
        float wavePhase = dist * 0.1 - uTime * 4.0;
        float waveAmp = strength * uCursorRadius * 2.5;
        // Push perpendicular to cursor direction
        vec2 perp = vec2(-dir.y, dir.x);
        pos.xy += perp * sin(wavePhase) * waveAmp;
        pos.z += cos(wavePhase) * strength * uCursorRadius * 1.0;
        vGlow = strength * (0.5 + 0.5 * abs(sin(wavePhase)));
      }
      else if (uHoverMode == 9) {
        // ── FREEZE: particles stop and lock near cursor ──
        float freezeRadius = uCursorRadius * 0.6;
        if (dist < freezeRadius) {
          pos.xy = aTarget.xy;
          pos.z = aTarget.z;
        }
        vGlow = strength;
      }
      else if (uHoverMode == 10) {
        // ── SHATTER: break into pieces with random velocities ──
        float shatterForce = strength * uCursorRadius * 6.0;
        // Each particle gets a unique random direction based on its phase
        float sx = sin(aPhase * 78.233) * cos(aSpeed * 43.123);
        float sy = cos(aPhase * 39.871) * sin(aSpeed * 67.456);
        pos.x += sx * shatterForce;
        pos.y += sy * shatterForce;
        pos.z += (aPhase - 0.5) * shatterForce * 2.0;
        vGlow = strength;
      }
      else if (uHoverMode == 11) {
        // ── INFLATE: grow outward like a balloon, uniform expansion ──
        float inflate = strength * uCursorRadius * 3.0;
        // Push outward from text center, amplified near cursor
        vec2 fromCenter = normalize(aTarget.xy + vec2(0.001));
        pos.xy += fromCenter * inflate;
        pos.z += inflate * 0.5;
        vGlow = strength;
      }
      else if (uHoverMode == 12) {
        // ── GRAVITY: particles fall down near cursor ──
        float gravity = strength * uCursorRadius * 4.0;
        pos.y -= gravity;
        // Slight horizontal drift
        pos.x += sin(uTime * 2.0 + aPhase * 10.0) * gravity * 0.3;
        pos.z += gravity * 0.2;
        vGlow = strength * 0.5;
      }
      else if (uHoverMode == 13) {
        // ── LIGHTNING: jagged electric displacement ──
        float electric = strength * uCursorRadius * 3.0;
        // Multiple high-frequency sine waves create jagged, electric motion
        float jx = sin(uTime * 40.0 + aPhase * 200.0)
                 * cos(uTime * 35.0 + aSpeed * 150.0)
                 * sin(uTime * 50.0 + aPhase * 80.0);
        float jy = cos(uTime * 45.0 + aSpeed * 200.0)
                 * sin(uTime * 38.0 + aPhase * 150.0)
                 * cos(uTime * 42.0 + aSpeed * 80.0);
        pos.x += jx * electric;
        pos.y += jy * electric;
        pos.z += abs(jx) * electric * 0.5;
        // Flickering glow
        vGlow = strength * (0.5 + 0.5 * abs(jx));
      }
      else if (uHoverMode == 14) {
        // ── LIQUID: fluid flow around cursor, like water parting ──
        float curve = strength * uCursorRadius * 3.0;
        vec2 tangent = vec2(-dir.y, dir.x);
        float side = sign(dir.x);
        pos.xy += tangent * curve * side;
        pos.z += strength * uCursorRadius * 0.5;
        vGlow = strength * 0.6;
      }
      else if (uHoverMode == 15) {
        // ── GLITCH: digital artifacts — random teleport chunks ──
        // Particles snap to quantized positions, creating blocky distortion
        float glitchSeed = floor(uTime * 8.0 + aPhase * 5.0);
        float gx = sin(glitchSeed * 13.37 + aPhase * 100.0) * uCursorRadius * 4.0;
        float gy = cos(glitchSeed * 7.77 + aSpeed * 80.0) * uCursorRadius * 2.0;
        // Only some particles glitch (based on phase threshold)
        float glitchMask = step(0.6, fract(glitchSeed * 0.3 + aPhase));
        pos.x += gx * strength * glitchMask;
        pos.y += gy * strength * glitchMask;
        // RGB-split style z offset
        pos.z += (aPhase - 0.5) * strength * uCursorRadius * 3.0 * glitchMask;
        vGlow = strength * glitchMask;
      }
      else if (uHoverMode == 16) {
        // ── BOKEH: defocus blur — push particles far in z, shrink them ──
        pos.z += strength * uCursorRadius * 8.0;
        // Spread outward slightly for blur feel
        pos.xy += dir * strength * uCursorRadius * 1.0;
        // Fade with distance (simulating blur)
        hoverFade = 1.0 - strength * 0.5;
        vGlow = strength * 0.3;
      }
      else if (uHoverMode == 17) {
        // ── PULSE: rhythmic heartbeat expansion/contraction ──
        float beat = sin(uTime * 4.0) * 0.5 + 0.5;
        float pulse = pow(beat, 3.0); // sharp heartbeat curve
        float expand = strength * uCursorRadius * 4.0 * pulse;
        pos.xy += dir * expand;
        pos.z += expand * 0.3;
        // Glow pulses with the beat
        vGlow = strength * pulse;
      }
      else if (uHoverMode == 18) {
        // ── SPIRAL: galactic spiral arms emanating from cursor ──
        float spiralT = dist / uCursorRadius;
        float armAngle = spiralT * 3.0 + uTime * 1.5 + aPhase * 0.5;
        // Two-arm spiral — particles choose arm based on phase
        float armOffset = step(0.5, aPhase) * 3.14159;
        float finalAngle = armAngle + armOffset;
        float spiralR = dist + strength * uCursorRadius * 2.0;
        pos.x = uCursor.x + cos(finalAngle) * spiralR;
        pos.y = uCursor.y + sin(finalAngle) * spiralR;
        pos.z += strength * uCursorRadius * 0.5;
        vGlow = strength;
      }
      else if (uHoverMode == 19) {
        // ── ECHO: offset ghost copies trail behind movement ──
        float echo1 = sin(uTime * 3.0 + aPhase * 6.28);
        float echo2 = cos(uTime * 2.0 + aSpeed * 6.28);
        pos.x += echo1 * strength * uCursorRadius * 2.0;
        pos.y += echo2 * strength * uCursorRadius * 1.5;
        pos.z += echo1 * strength * uCursorRadius * 1.0;
        hoverFade = 1.0 - strength * 0.3;
        vGlow = strength * (0.4 + 0.3 * abs(echo1));
      }
      else if (uHoverMode == 20) {
        // ── TORNADO: vertical twisting column around cursor ──
        float colHeight = strength * uCursorRadius * 5.0;
        float twistAngle = atan(dir.y, dir.x) + uTime * 3.0 + pos.y * 0.05;
        float twistR = dist * (1.0 - strength * 0.5);
        pos.x = uCursor.x + cos(twistAngle) * twistR;
        pos.y = uCursor.y + sin(twistAngle) * twistR;
        // Push up in a column
        pos.z += colHeight * (1.0 - dist / uCursorRadius);
        vGlow = strength;
      }
      else if (uHoverMode == 21) {
        // ── EMBER: particles glow and float upward like fire embers ──
        float rise = strength * uCursorRadius * 4.0;
        pos.y += rise;
        // Flickering horizontal drift
        pos.x += sin(uTime * 5.0 + aPhase * 20.0) * rise * 0.3;
        // z flicker
        pos.z += sin(uTime * 8.0 + aPhase * 30.0) * rise * 0.2;
        // Intense flickering glow — like hot embers
        float flicker = 0.5 + 0.5 * sin(uTime * 15.0 + aPhase * 50.0);
        vGlow = strength * flicker;
      }
      else if (uHoverMode == 22) {
        // ── MATRIX: digital rain — particles fall in columns ──
        // Quantize x into columns
        float colWidth = uCursorRadius * 0.3;
        float colX = floor(pos.x / colWidth) * colWidth;
        // Fall speed varies per column
        float fallSpeed = 2.0 + sin(colX * 0.1) * 1.0;
        float fall = mod(uTime * fallSpeed + aPhase * 5.0, uCursorRadius * 3.0);
        pos.y -= fall * strength;
        // Bright leading edge, dim trail
        float lead = 1.0 - fall / (uCursorRadius * 3.0);
        vGlow = strength * lead;
      }
      else if (uHoverMode == 23) {
        // ── CONSTELLATION: particles pulse and connect like stars ──
        // No displacement — just rhythmic glowing like twinkling stars
        float twinkle = sin(uTime * 2.0 + aPhase * 25.0) * 0.5 + 0.5;
        float twinkle2 = cos(uTime * 1.3 + aSpeed * 30.0) * 0.5 + 0.5;
        // Very slight drift toward cursor
        pos.xy += dir * strength * uCursorRadius * 0.3;
        pos.z += strength * uCursorRadius * 0.2;
        // Star-like glow pulsing
        vGlow = strength * twinkle * twinkle2;
      }
      else if (uHoverMode == 24) {
        // ── LENS: magnifying lens — push particles outward in a ring ──
        // Creates a magnification distortion around cursor
        float lensR = uCursorRadius * 0.7;
        float lensFactor = 1.0 + strength * 2.0;
        // Particles inside the lens are pushed outward (magnified)
        if (dist < lensR) {
          pos.xy = uCursor + dir * dist * lensFactor;
        }
        // Ring glow at lens edge
        float ringGlow = exp(-pow(dist - lensR, 2.0) / (uCursorRadius * 0.1));
        vGlow = strength * (0.3 + ringGlow * 0.7);
      }
      else if (uHoverMode == 25) {
        // ── DRAIN: swirl down like water going down a drain ──
        float drainAngle = atan(dir.y, dir.x) + uTime * 5.0;
        // Radius shrinks as particles spiral in
        float drainR = dist * (1.0 - strength * 0.7);
        pos.x = uCursor.x + cos(drainAngle) * drainR;
        pos.y = uCursor.y + sin(drainAngle) * drainR;
        // Fall down the drain
        pos.z -= strength * uCursorRadius * 3.0;
        hoverFade = 1.0 - strength * 0.4;
        vGlow = strength;
      }
      else if (uHoverMode == 26) {
        // ── CONFETTI: colorful celebration burst with rotation ──
        float burst = strength * uCursorRadius * 5.0;
        // Random scatter direction
        float cx = sin(aPhase * 95.31) * cos(aSpeed * 52.77);
        float cy = cos(aPhase * 48.13) * sin(aSpeed * 71.29);
        pos.x += cx * burst;
        pos.y += cy * burst;
        // Gravity pulls confetti down after burst
        pos.y -= strength * uCursorRadius * 2.0 * (1.0 - strength);
        pos.z += (aPhase - 0.5) * burst * 2.0;
        // Party glow — random brightness per particle
        vGlow = strength * (0.3 + aPhase * 0.7);
      }
      else if (uHoverMode == 27) {
        // ── ASSEMBLE: particles snap toward cursor from scattered positions ──
        // Reverse of scatter — particles converge to cursor
        float assemble = strength * uCursorRadius * 3.0;
        // Mix between current position and cursor position
        pos.xy = mix(pos.xy, uCursor, strength * 0.8);
        // Slight orbital offset so they don't all collapse to one point
        float orbitOff = aPhase * 6.28;
        pos.x += cos(orbitOff) * strength * uCursorRadius * 0.3;
        pos.y += sin(orbitOff) * strength * uCursorRadius * 0.3;
        pos.z += strength * uCursorRadius * 0.5;
        vGlow = strength;
      }
      else if (uHoverMode == 28) {
        // ── STRETCH: pull text like taffy in cursor direction ──
        // Particles stretch away from their home based on cursor proximity
        float stretch = strength * uCursorRadius * 6.0;
        // Stretch in the direction from home to cursor
        vec2 stretchDir = normalize(uCursor - aTarget.xy + vec2(0.001));
        pos.xy += stretchDir * stretch;
        // Slight thinning (z compression)
        pos.z -= strength * uCursorRadius * 0.5;
        vGlow = strength * 0.5;
      }
      else if (uHoverMode == 29) {
        // ── BREATHING: slow organic scale pulse ──
        float breath = sin(uTime * 1.5) * 0.5 + 0.5;
        float breathe = strength * breath * uCursorRadius * 2.0;
        vec2 fromHome = pos.xy - aTarget.xy;
        pos.xy += fromHome * breathe * 0.5;
        pos.z += breathe;
        vGlow = strength * breath * 0.7;
      }
      else if (uHoverMode == 30) {
        // ── QUANTUM: particles teleport between random positions ──
        // Discrete jumps — particles blink to new offsets
        float qSeed = floor(uTime * 3.0 + aPhase * 7.0);
        float qx = sin(qSeed * 12.9898 + aPhase * 78.233) * uCursorRadius * 4.0;
        float qy = cos(qSeed * 78.233 + aSpeed * 43.123) * uCursorRadius * 4.0;
        // Jump only on seed change (quantum leap)
        float jumpMask = step(0.5, fract(qSeed * 0.37 + aPhase));
        pos.x += qx * strength * jumpMask;
        pos.y += qy * strength * jumpMask;
        pos.z += (aPhase - 0.5) * strength * uCursorRadius * 2.0 * jumpMask;
        // Flicker — particles blink during teleport
        vGlow = strength * jumpMask * (0.5 + 0.5 * sin(uTime * 20.0));
      }
      else if (uHoverMode == 31) {
        // ── MAGNETIZE: snap particles to a grid near cursor ──
        float gridSize = uCursorRadius * 0.4;
        vec2 snapped = floor((pos.xy + uCursor) / gridSize) * gridSize - uCursor;
        // Pull toward nearest grid intersection
        pos.xy = mix(pos.xy, snapped + uCursor, strength * 0.9);
        pos.z += strength * uCursorRadius * 0.3;
        // Grid glow — brighter at intersections
        vec2 gridFrac = fract((pos.xy + uCursor) / gridSize);
        float gridGlow = (1.0 - min(gridFrac.x, 1.0 - gridFrac.x))
                       * (1.0 - min(gridFrac.y, 1.0 - gridFrac.y));
        vGlow = strength * (0.3 + gridGlow * 0.7);
      }
      else if (uHoverMode == 32) {
        // ── ORBIT: stable circular orbit at current distance ──
        // Particles circle around cursor without spiraling in or out
        float orbitSpeed = 1.5 + aSpeed * 1.0;
        float orbitAngle = atan(dir.y, dir.x) + uTime * orbitSpeed;
        pos.x = uCursor.x + cos(orbitAngle) * dist;
        pos.y = uCursor.y + sin(orbitAngle) * dist;
        pos.z += strength * uCursorRadius * 0.4;
        vGlow = strength * 0.6;
      }
      else if (uHoverMode == 33) {
        // ── SPIRAL OUT: particles spiral outward away from cursor ──
        float outAngle = atan(dir.y, dir.x) + uTime * 2.0;
        float outR = dist + strength * uCursorRadius * 3.0;
        pos.x = uCursor.x + cos(outAngle) * outR;
        pos.y = uCursor.y + sin(outAngle) * outR;
        pos.z += strength * uCursorRadius * 0.5;
        vGlow = strength;
      }
      else if (uHoverMode == 34) {
        // ── HUE SHIFT: no displacement — cycle particle colors near cursor ──
        // Rainbow color cycling based on distance and time
        float hue = dist * 0.02 - uTime * 0.5 + aPhase;
        // Shift color: red→green→blue sine cycle
        vColor = vec3(
          sin(hue * 6.28) * 0.5 + 0.5,
          sin(hue * 6.28 + 2.09) * 0.5 + 0.5,
          sin(hue * 6.28 + 4.19) * 0.5 + 0.5
        );
        // Mix with original color based on strength
        vColor = mix(aColor, vColor, strength);
        // Very slight drift
        pos.xy += dir * strength * uCursorRadius * 0.2;
        vGlow = strength * 0.5;
      }
      else if (uHoverMode == 35) {
        // ── PARALLAX: push particles into z-depth based on distance ──
        // Creates a 3D depth effect — closer particles move more
        float depth = strength * uCursorRadius * 6.0;
        pos.z += depth;
        // Slight xy shift for parallax offset
        pos.xy += dir * depth * 0.15;
        // Fade with depth
        hoverFade = 1.0 - strength * 0.3;
        vGlow = strength * 0.2;
      }
      else if (uHoverMode == 36) {
        // ── BOUNCE: elastic bounce off an invisible wall at cursor ──
        // Particles bounce back as if hitting a springy surface
        float bouncePhase = sin(uTime * 6.0 + aPhase * 10.0);
        float bounce = abs(bouncePhase) * strength * uCursorRadius * 4.0;
        pos.xy += dir * bounce;
        pos.z += bounce * 0.3;
        // Glow spikes at bounce peaks
        vGlow = strength * abs(bouncePhase);
      }
      else if (uHoverMode == 37) {
        // ── MORPH: morph text into a circle near cursor ──
        // Target position on a circle around cursor
        float circleR = uCursorRadius * 0.8;
        float circleAngle = aPhase * 6.28;
        vec2 circlePos = uCursor + vec2(cos(circleAngle), sin(circleAngle)) * circleR;
        // Morph between text position and circle position
        pos.xy = mix(pos.xy, circlePos, strength * 0.9);
        pos.z += strength * uCursorRadius * 0.5;
        vGlow = strength;
      }
      else if (uHoverMode == 38) {
        // ── STATIC: TV static noise — chaotic random jitter ──
        // Different from shake — fully random, not directional
        float staticSeed = uTime * 60.0 + aPhase * 1000.0;
        float sx = fract(sin(staticSeed) * 43758.5453) - 0.5;
        float sy = fract(cos(staticSeed * 1.3) * 43758.5453) - 0.5;
        float sz = fract(sin(staticSeed * 2.1) * 43758.5453) - 0.5;
        pos.x += sx * strength * uCursorRadius * 3.0;
        pos.y += sy * strength * uCursorRadius * 3.0;
        pos.z += sz * strength * uCursorRadius * 2.0;
        // Static flicker
        vGlow = strength * fract(staticSeed * 7.0);
      }
      else if (uHoverMode == 39) {
        // ── CLOAK: particles become invisible near cursor ──
        hoverFade = 1.0 - strength;
        pos.xy += dir * strength * uCursorRadius * 0.5;
        pos.z += strength * uCursorRadius * 0.3;
        vGlow = 0.0;
      }
      else if (uHoverMode == 40) {
        // ── SLICE: split text along a horizontal line through cursor ──
        // Top half slides left, bottom half slides right
        float sliceY = uCursor.y;
        float side = step(sliceY, pos.y); // 1 if above cursor, 0 if below
        float slideDir = side * 2.0 - 1.0; // +1 above, -1 below
        pos.x += slideDir * strength * uCursorRadius * 5.0;
        // Gap opens at the slice line
        float gapDist = abs(pos.y - sliceY);
        pos.y += side * strength * uCursorRadius * 1.5;
        pos.z += strength * uCursorRadius * 0.5;
        vGlow = strength * (1.0 - gapDist / uCursorRadius);
      }
      else if (uHoverMode == 41) {
        // ── MIRROR: particles mirror their position across cursor ──
        // Reflect position through the cursor point
        vec2 mirrored = uCursor - toCursor; // flip the offset
        pos.xy = mix(pos.xy, mirrored, strength * 0.9);
        pos.z += strength * uCursorRadius * 0.3;
        // Glow at the mirror axis
        float axisDist = abs(dot(toCursor, vec2(0.707, 0.707)));
        vGlow = strength * (0.3 + 0.7 * exp(-axisDist * axisDist / (uCursorRadius * 0.2)));
      }
      else if (uHoverMode == 42) {
        // ── SAND: particles fall and pile up at the bottom ──
        float fallDist = strength * uCursorRadius * 4.0;
        // Fall down with acceleration
        pos.y -= fallDist * (0.5 + strength * 0.5);
        // Pile up — particles near the bottom spread horizontally
        float pileY = aTarget.y - uCursorRadius * 2.0;
        if (pos.y < pileY) {
          pos.y = pileY + sin(aPhase * 31.0) * uCursorRadius * 0.3;
          pos.x += sin(aPhase * 78.0) * uCursorRadius * 0.5 * strength;
        }
        pos.z += strength * uCursorRadius * 0.3;
        vGlow = strength * 0.3;
      }
      else if (uHoverMode == 43) {
        // ── BUBBLES: particles rise upward with wobble ──
        float rise = strength * uCursorRadius * 4.0;
        pos.y += rise;
        // Wobble side to side like rising bubbles
        pos.x += sin(uTime * 3.0 + aPhase * 20.0) * rise * 0.4;
        // Size variation (handled via point size)
        pos.z += sin(uTime * 2.0 + aPhase * 15.0) * rise * 0.2;
        // Soft bubble glow
        vGlow = strength * (0.4 + 0.3 * sin(uTime * 2.0 + aPhase * 10.0));
      }
      else if (uHoverMode == 44) {
        // ── PINCH: squeeze particles toward a horizontal line through cursor ──
        float lineY = uCursor.y;
        // Pull y toward the line
        pos.y = mix(pos.y, lineY, strength * 0.85);
        // Squeeze x outward slightly (conservation of volume)
        pos.x += dir.x * strength * uCursorRadius * 1.5;
        pos.z += strength * uCursorRadius * 0.4;
        // Bright glow at the pinch line
        float lineDist = abs(pos.y - lineY);
        vGlow = strength * exp(-lineDist * lineDist / (uCursorRadius * 0.15));
      }
      else if (uHoverMode == 45) {
        // ── TWIST: rotate particles around vertical axis through cursor ──
        // Like wringing a towel — twist effect
        float twistAngle = strength * 3.14 * (pos.y - uCursor.y) / uCursorRadius;
        vec2 relPos = pos.xy - uCursor;
        float cosT = cos(twistAngle);
        float sinT = sin(twistAngle);
        pos.x = uCursor.x + relPos.x * cosT - relPos.y * sinT;
        pos.y = uCursor.y + relPos.x * sinT + relPos.y * cosT;
        pos.z += strength * uCursorRadius * 0.5;
        vGlow = strength;
      }
      else if (uHoverMode == 46) {
        // ── COMET: particles trail behind cursor direction ──
        // Offset particles opposite to cursor velocity (simulated with time)
        float trailX = sin(uTime * 0.5) * uCursorRadius * 3.0;
        float trailY = cos(uTime * 0.3) * uCursorRadius * 2.0;
        // Particles lag behind, stretched in trail direction
        float trailFactor = strength * (0.3 + aPhase * 0.7);
        pos.x += trailX * trailFactor;
        pos.y += trailY * trailFactor;
        pos.z += trailFactor * uCursorRadius * 0.5;
        // Brighter at the head (near cursor), dimmer in trail
        vGlow = strength * (1.0 - aPhase * 0.5);
      }
      else if (uHoverMode == 47) {
        // ── FLATTEN: squish particles flat against the ground plane ──
        // Compress y toward cursor's y, expand x outward
        pos.y = mix(pos.y, uCursor.y, strength * 0.9);
        pos.x += dir.x * strength * uCursorRadius * 3.0;
        // Push into z for flatness
        pos.z -= strength * uCursorRadius * 1.0;
        vGlow = strength * 0.4;
      }
      else if (uHoverMode == 48) {
        // ── INK: particles bleed outward like ink in water ──
        // Slow, organic diffusion with turbulent flow
        float inkSpeed = uTime * 0.8 + aPhase * 3.0;
        float inkX = sin(inkSpeed) * cos(inkSpeed * 1.3 + aSpeed * 5.0);
        float inkY = cos(inkSpeed * 0.9) * sin(inkSpeed * 1.1 + aPhase * 5.0);
        pos.x += inkX * strength * uCursorRadius * 4.0;
        pos.y += inkY * strength * uCursorRadius * 4.0;
        pos.z += strength * uCursorRadius * 0.6;
        // Dark ink glow — intense but slow
        vGlow = strength * (0.5 + 0.3 * sin(inkSpeed * 0.5));
      }
      else if (uHoverMode == 49) {
        // ── WIND: particles blow in a consistent direction, stronger near cursor ──
        float windAngle = sin(uTime * 0.3) * 0.5;
        vec2 windDir = vec2(cos(windAngle), sin(windAngle));
        float windForce = strength * uCursorRadius * 5.0;
        pos.xy += windDir * windForce;
        pos.x += sin(uTime * 2.0 + aPhase * 20.0) * windForce * 0.15;
        pos.y += cos(uTime * 2.0 + aSpeed * 20.0) * windForce * 0.15;
        pos.z += windForce * 0.2;
        vGlow = strength * 0.3;
      }
      else {
        // ── SCALE UP: particles grow larger near cursor, no displacement ──
        vHoverScale = 1.0 + strength * 4.0;
        vGlow = strength * 0.6;
      }
    }

    vAlpha = entranceAlpha * hoverFade * (1.0 - aAmbient * 0.6);
    vColor = aColor;

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPos;
    float scaleMul = 1.0;
    if (uEntranceMode == 15) {
      // Scale up entrance — grow from 0 to full size
      scaleMul = entranceAlpha;
    }
    gl_PointSize = uSize * (uCameraZ / -mvPos.z) * (1.0 - aAmbient * 0.4) * (1.0 + vGlow * 0.3) * scaleMul * vHoverScale;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uTexture;
  uniform vec3 uGlowColor;
  varying float vAlpha;
  varying vec3  vColor;
  varying float vGlow;
  void main() {
    vec4 tex = texture2D(uTexture, gl_PointCoord);
    if (tex.a < 0.01) discard;
    // Subtle glow color shift near cursor
    vec3 color = mix(vColor, uGlowColor, vGlow * 0.4);
    float alpha = tex.a * vAlpha * (1.0 + vGlow * 0.8);
    gl_FragColor = vec4(color, alpha);
  }
`;

/* ── Component (faithful port from kamehadb particle-text.tsx) ── */
export function ParticleText({
  text,
  gradientPart,
  particleCount = 40000,
  className,
  color = [1, 1, 1],
  gradientFrom,
  gradientTo,
  weight = 800,
  fontSize = 48,
  ambient = 0,
  fontFamily = "Syne",
  cursorRadiusScale = 0.45,
  fillContainer = false,
  verticalAlign = "center",
  hoverMode = 0,
  entranceMode = 0,
}: {
  text: string;
  gradientPart?: string;
  particleCount?: number;
  className?: string;
  color?: [number, number, number];
  gradientFrom?: [number, number, number];
  gradientTo?: [number, number, number];
  weight?: number;
  fontSize?: number;
  ambient?: number;
  fontFamily?: string;
  cursorRadiusScale?: number;
  fillContainer?: boolean;
  verticalAlign?: "top" | "center";
  hoverMode?: number;
  entranceMode?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number>(0);

  // Refs for mode values — updated without rebuilding the scene
  const hoverModeRef = useRef(hoverMode);
  const entranceModeRef = useRef(entranceMode);
  const replayEntranceRef = useRef(0);
  hoverModeRef.current = hoverMode;
  entranceModeRef.current = entranceMode;

  // Trigger entrance replay when entranceMode changes
  const prevEntrance = useRef(entranceMode);
  if (prevEntrance.current !== entranceMode) {
    prevEntrance.current = entranceMode;
    replayEntranceRef.current++;
  }

  const gradKey = gradientPart ?? "none";

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const setupScene = () => {
      const CW = container.clientWidth || 800;
      const { positions: targets, isGradient, canvasW, canvasH, bboxH } =
        sampleText(
          text,
          gradientPart,
          particleCount,
          fontSize,
          weight,
          CW,
          fontFamily,
        );

      const SCALE = 4;
      const textScreenH = Math.ceil(bboxH / SCALE);
      const padY = Math.ceil(fontSize * 0.25);
      const textScreenHFitted = textScreenH + padY * 2;
      // If fillContainer, use the container's full height so the canvas
      // covers the entire footer — no edge cropping on hover.
      const CH = fillContainer
        ? container.clientHeight || textScreenHFitted
        : textScreenHFitted;
      if (!fillContainer) setContainerHeight(textScreenHFitted);

      // Vertical alignment: shift text targets up when "top" so the wordmark
      // sits near the top of the full-footer canvas instead of centered.
      let yOffset = 0;
      if (fillContainer && verticalAlign === "top") {
        const worldH = CH * SCALE;
        const halfWorldH = worldH / 2;
        // Place at ~30% from the top rather than flush against the edge
        yOffset = halfWorldH - bboxH / 2 - padY * SCALE - worldH * 0.15;
      }
      if (yOffset !== 0) {
        for (let i = 0; i < targets.length / 3; i++) {
          targets[i * 3 + 1] += yOffset;
        }
      }

      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
      });
      renderer.setSize(CW, CH);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      container.appendChild(renderer.domElement);
      container.style.overflow = "visible";

      const scene = new THREE.Scene();

      const worldH = CH * SCALE;
      const z = worldH / 1.1547;
      const camera = new THREE.PerspectiveCamera(60, CW / CH, 0.1, 10000);
      camera.position.z = z;

      const getViewSize = () => {
        const halfH = z * Math.tan(THREE.MathUtils.degToRad(30));
        const halfW = halfH * (CW / CH);
        return { halfW, halfH };
      };

      const cursorRadius = fontSize * SCALE * cursorRadiusScale;

      // Soft round point sprite
      const tc = document.createElement("canvas");
      tc.width = 32;
      tc.height = 32;
      const tctx = tc.getContext("2d")!;
      const grad = tctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.5, "rgba(255,255,255,1)");
      grad.addColorStop(0.8, "rgba(255,255,255,0.4)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      tctx.fillStyle = grad;
      tctx.fillRect(0, 0, 32, 32);
      const texture = new THREE.CanvasTexture(tc);

      const count = particleCount + ambient;
      const textCount = particleCount;
      const origins = new Float32Array(count * 3);
      const phases = new Float32Array(count);
      const speeds = new Float32Array(count);
      const colors = new Float32Array(count * 3);
      const ambients = new Float32Array(count);

      const gFrom = gradientFrom ?? color;
      const gTo = gradientTo ?? color;
      const halfTextW = canvasW / 2;

      for (let i = 0; i < count; i++) {
        if (i < textCount) {
          origins[i * 3] = (Math.random() - 0.5) * canvasW * 1.5;
          origins[i * 3 + 1] = (Math.random() - 0.5) * canvasH * 1.5;
          origins[i * 3 + 2] = (Math.random() - 0.5) * 300 - 100;

          if (isGradient[i] && gradientFrom && gradientTo) {
            const xNorm = (targets[i * 3] + halfTextW) / canvasW;
            colors[i * 3] = gFrom[0] + (gTo[0] - gFrom[0]) * xNorm;
            colors[i * 3 + 1] = gFrom[1] + (gTo[1] - gFrom[1]) * xNorm;
            colors[i * 3 + 2] = gFrom[2] + (gTo[2] - gFrom[2]) * xNorm;
          } else {
            colors[i * 3] = color[0];
            colors[i * 3 + 1] = color[1];
            colors[i * 3 + 2] = color[2];
          }
        } else {
          // Ambient particles
          targets[i * 3] = (Math.random() - 0.5) * canvasW * 1.4;
          targets[i * 3 + 1] = (Math.random() - 0.5) * canvasH * 0.8;
          targets[i * 3 + 2] = (Math.random() - 0.5) * 120;
          origins[i * 3] = targets[i * 3];
          origins[i * 3 + 1] = targets[i * 3 + 1];
          origins[i * 3 + 2] = targets[i * 3 + 2];
          colors[i * 3] = color[0];
          colors[i * 3 + 1] = color[1];
          colors[i * 3 + 2] = color[2];
        }
        phases[i] = Math.random();
        speeds[i] = Math.random();
        ambients[i] = i < textCount ? 0.0 : 1.0;
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(count * 3), 3),
      );
      geom.setAttribute("aTarget", new THREE.BufferAttribute(targets, 3));
      geom.setAttribute("aOrigin", new THREE.BufferAttribute(origins, 3));
      geom.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
      geom.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));
      geom.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
      geom.setAttribute("aAmbient", new THREE.BufferAttribute(ambients, 1));

      const pixelRatio = Math.min(window.devicePixelRatio, 2);
      const pointSize = fontSize * 0.07 * pixelRatio;

      const uniforms = {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uCursor: { value: new THREE.Vector2(99999, 99999) },
        uCursorStrength: { value: 0 },
        uCursorRadius: { value: cursorRadius },
        uTexture: { value: texture },
        uSize: { value: pointSize },
        uPixelRatio: { value: pixelRatio },
        uCameraZ: { value: z },
        uCanvasW: { value: canvasW },
        uGlowColor: { value: new THREE.Color(0x4dbede) },
        uHoverMode: { value: hoverModeRef.current },
        uEntranceMode: { value: entranceModeRef.current },
      };

      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        blending: THREE.NormalBlending,
        depthWrite: false,
      });

      scene.add(new THREE.Points(geom, mat));

      let cursorPresent = false;
      let cursorStrength = 0;
      let lastT = 0;

      const onMouseMove = (e: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;
        const { halfW, halfH } = getViewSize();
        // Standard screen→world mapping. Text targets are already shifted
        // in world space, so no offset needed here.
        uniforms.uCursor.value.set(
          (nx - 0.5) * 2 * halfW,
          -(ny - 0.5) * 2 * halfH,
        );
        cursorPresent = true;
      };
      const onMouseLeave = () => {
        uniforms.uCursor.value.set(99999, 99999);
        cursorPresent = false;
      };
      container.addEventListener("pointermove", onMouseMove);
      container.addEventListener("pointerleave", onMouseLeave);

      const onResize = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener("resize", onResize);

      const clock = new THREE.Clock();
      let raf: number;
      const DURATION = 2.2;
      let entranceStarted = false;
      let entranceTime = 0;
      let lastReplay = replayEntranceRef.current;

      const tick = () => {
        raf = requestAnimationFrame(tick);
        const t = clock.getElapsedTime();
        const dt = Math.min(t - lastT, 0.05);
        lastT = t;
        uniforms.uTime.value = t;
        // Sync mode refs to uniforms without rebuilding scene
        uniforms.uHoverMode.value = hoverModeRef.current;
        uniforms.uEntranceMode.value = entranceModeRef.current;
        // Replay entrance when replay signal changes
        if (replayEntranceRef.current !== lastReplay) {
          lastReplay = replayEntranceRef.current;
          entranceTime = 0;
          uniforms.uProgress.value = 0;
          entranceStarted = true; // force start even if already past IO
        }
        // Only advance entrance progress after IntersectionObserver fires
        if (entranceStarted) {
          entranceTime += dt;
          uniforms.uProgress.value = Math.min(entranceTime / DURATION, 1);
        }
        const target = cursorPresent ? 1.0 : 0.0;
        const speed = cursorPresent ? 2.5 : 1.2;
        cursorStrength += (target - cursorStrength) * Math.min(dt * speed, 1.0);
        uniforms.uCursorStrength.value = cursorStrength;
        renderer.render(scene, camera);
      };
      tick();

      // IntersectionObserver — start entrance only when footer scrolls into view
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !entranceStarted) {
              entranceStarted = true;
            }
          });
        },
        { threshold: 0.2 },
      );
      io.observe(container);

      cleanup = () => {
        cancelAnimationFrame(raf);
        io.disconnect();
        container.removeEventListener("pointermove", onMouseMove);
        container.removeEventListener("pointerleave", onMouseLeave);
        window.removeEventListener("resize", onResize);
        geom.dispose();
        mat.dispose();
        texture.dispose();
        renderer.dispose();
        renderer.domElement.parentNode?.removeChild(renderer.domElement);
      };
    };

    // Wait for font to load so canvas text matches
    const init = async () => {
      if (document.fonts) {
        try {
          await document.fonts.load(`${weight} ${fontSize}px ${fontFamily}`);
        } catch {}
        try {
          await document.fonts.ready;
        } catch {}
      }
      if (cancelled) return;
      setupScene();
    };
    init();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    text,
    gradientPart,
    particleCount,
    fontSize,
    weight,
    color[0],
    color[1],
    color[2],
    ambient,
    gradKey,
    gradientFrom?.[0],
    gradientFrom?.[1],
    gradientFrom?.[2],
    gradientTo?.[0],
    gradientTo?.[1],
    gradientTo?.[2],
    fontFamily,
    cursorRadiusScale,
    fillContainer,
    verticalAlign,
  ]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height: fillContainer ? "100%" : containerHeight || undefined }}
    />
  );
}
