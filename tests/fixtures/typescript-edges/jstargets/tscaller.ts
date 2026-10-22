import { jsFn } from "./jsmod.js";
import { cjsFn } from "./cjsmod.cjs";
import { jsFn as viaBarrel } from "./tsbarrel";

export function run(): void {
  jsFn();
  cjsFn();
  viaBarrel();
}
