const m = require("./mod.cjs");
const { objFn, named } = require("./objmod.cjs");

function helper() {
  return 0;
}

function run() {
  helper();
  m.nsFn();
  m.prop();
  objFn();
  named();
  // `missing` is not an export of mod.cjs — must not resolve anywhere.
  m.missing();
}
