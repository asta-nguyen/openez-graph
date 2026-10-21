import { pkgFn } from "@pkg/util";
import { rootFn } from "@root/helper";

export function run(): void {
  pkgFn();
  rootFn();
}
