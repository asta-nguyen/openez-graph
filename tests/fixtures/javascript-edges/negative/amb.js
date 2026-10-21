// `dup` is re-exported through two wildcard barrels — ambiguous, must drop.
export * from "./dupa.js";
export * from "./dupb.js";

export function uniq() {
  return "uniq";
}
