import main, { helper as h, other } from "./lib";
import * as lib from "./lib";
import { render } from "./widget";

export function run(): void {
  h();
  main();
  lib.other();
  render();
}
