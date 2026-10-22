import lodash from "lodash";
import { dup, uniq } from "./amb.js";
import { ghost } from "./missing.js";

const computed = require(process.env.MOD_NAME);

export function run() {
  uniq();
  dup();
  lodash();
  ghost();
  computed();
}

export function shadow(uniq) {
  uniq();
}
