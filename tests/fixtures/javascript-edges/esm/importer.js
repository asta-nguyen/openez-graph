import defaultFn from "./lib.js";
import { real as alias, named, targetScoped } from "./lib.js";
import * as NS from "./lib.js";
import anonFn from "./anodef.js";
import anonArr from "./arrdef.js";

function helper() {
  return 0;
}

export function run() {
  helper();
  alias();
  defaultFn();
  named();
  NS.nsMember();
  anonFn();
  anonArr();
  // decoyFn is not imported — a same-name global lookup must not resolve it.
  decoyFn();
}

export function runScope() {
  // `targetScoped` in the sibling block below does NOT enclose this call —
  // the import binding still applies.
  targetScoped();
  {
    const targetScoped = 1;
  }
}
