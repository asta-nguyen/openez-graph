import { ra, bFn, helper } from "./barrel.js";

function local() {
  return 0;
}

export function use() {
  local();
  ra();
  bFn();
  helper();
}
