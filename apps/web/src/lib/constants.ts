// ── API / Server ─────────────────────────────────────────────────────
export const API_PORT = 11368;
export const VITE_PORT = 3000;

// ── Query cache (TanStack Query defaults) ────────────────────────────
export const QUERY_STALE_TIME = 60_000; // 1 min
export const QUERY_GC_TIME = 5 * 60_000; // 5 min
export const QUERY_RETRY = 1;

// ── Pagination ───────────────────────────────────────────────────────
export const PAGE_SIZE = 10;

// ── Graph node types ─────────────────────────────────────────────────
export const NODE_TYPES = {
  FILE: "file",
  CHUNK: "chunk",
  SYMBOL: "symbol",
  ENTITY: "entity",
} as const;

export const SYMBOL_TYPES = [
  "function",
  "class",
  "interface",
  "variable",
  "method",
  "symbol",
] as const;

export const GRAPH_NODE_TYPES = [
  "file",
  "symbol",
  "entity",
  "class",
  "function",
  "method",
  "variable",
  "chunk",
] as const;

// ── Select sentinel value (Radix Select doesn't allow empty string) ──
export const ALL_VALUE = "__all__";

// ── Query log sort options ───────────────────────────────────────────
export const QUERY_SORT = {
  NEWEST: "newest",
  OLDEST: "oldest",
  LATENCY_DESC: "latency_desc",
  LATENCY_ASC: "latency_asc",
} as const;

export const QUERY_SORT_OPTIONS = [
  QUERY_SORT.NEWEST,
  QUERY_SORT.OLDEST,
  QUERY_SORT.LATENCY_DESC,
  QUERY_SORT.LATENCY_ASC,
] as const;

// ── Graph 3D rendering ───────────────────────────────────────────────
export const GRAPH = {
  BG_COLOR: 0x0a0f1a,
  CAMERA_FOV: 45,
  CAMERA_NEAR: 0.1,
  CAMERA_FAR: 1000,
  CAMERA_DEFAULT_POS: [60, 40, 80] as const,
  CONTROLS_MIN_DISTANCE: 10,
  CONTROLS_MAX_DISTANCE: 500,
  CONTROLS_DAMPING: 0.1,
  FALLBACK_WIDTH: 800,
  FALLBACK_HEIGHT: 600,
  MAX_PIXEL_RATIO: 2,
  // Fibonacci sphere layout
  SPHERE_RADIUS_MIN: 25,
  SPHERE_RADIUS_MAX: 100,
  SPHERE_RADIUS_FACTOR: 2.5,
  SPHERE_LIFT_FACTOR: 0.15,
  // Node sprite sizing
  NODE_BASE_SIZE: 5,
  NODE_SIZE_PER_DEGREE: 0.5,
  NODE_MAX_SIZE_BONUS: 15,
  NODE_SPRITE_SCALE: 0.7,
  NODE_SELECTED_SCALE: 1.4,
  NODE_HOVER_SCALE: 1.2,
  // Label
  LABEL_FONT_SIZE: 13,
  LABEL_PADDING_X: 8,
  LABEL_PADDING_Y: 4,
  LABEL_SCALE: 0.25,
  LABEL_RADIUS: 4,
  LABEL_HUB_DEGREE: 5,
  LABEL_OFFSET: 4,
  // Node canvas texture
  NODE_TEX_SIZE: 64,
  NODE_TEX_RADIUS: 28,
  // Edge
  EDGE_OPACITY: 0.35,
  // Zoom
  ZOOM_FIT_FACTOR: 1.8,
  ZOOM_FIT_PADDING: 20,
  ZOOM_IN_FACTOR: 0.7,
  ZOOM_OUT_FACTOR: 1.4,
  ZOOM_NEAR_FACTOR: 100,
  ZOOM_FAR_FACTOR: 100,
  // Zoom button styling
  ZOOM_BTN_SIZE: 32,
  ZOOM_BTN_RADIUS: 6,
  ZOOM_BTN_BORDER: "1px solid rgba(255,255,255,0.1)",
  ZOOM_BTN_BG: "rgba(0,0,0,0.5)",
  ZOOM_BTN_COLOR: "#fff",
  ZOOM_BTN_ICON_SIZE: 18,
  ZOOM_BTN_FIT_FONT: 11,
  ZOOM_BTN_POSITION: 12,
  ZOOM_BTN_GAP: 2,
} as const;
