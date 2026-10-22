import { uniq } from "./amb.js";

export function caller() {
  // Same-block `const uniq` below shadows the import for the whole block
  // (TDZ) — this call must not resolve to amb.js#uniq.
  uniq();
  const uniq = 1;
}
