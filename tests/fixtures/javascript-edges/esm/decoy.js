// Defines same-named symbols as lib.js. Alphabetical ordering means this file
// is parsed before importer.js and lib.js, so a first-match global symbol map
// resolves `real`/`decoyFn` calls here even when the importer bound ./lib.js.
export function real() {
  return "decoy";
}

export function decoyFn() {
  return "decoy";
}
