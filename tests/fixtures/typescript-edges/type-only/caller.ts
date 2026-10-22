import type { Shape } from "./shapes";
import { type OnlyT, mixedFn } from "./mixed";
import { realFn } from "./shapes";
import { Shape as BarrelShape } from "./typebarrel";

export function run(): void {
  Shape();
  realFn();
  mixedFn();
  BarrelShape();
}
