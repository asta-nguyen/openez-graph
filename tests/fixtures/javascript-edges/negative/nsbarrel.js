// `export * as ns` is a namespace export — NOT a wildcard. Expanding it as
// `export *` would wrongly expose `uniq` at the top level.
export * as only from "./amb.js";
