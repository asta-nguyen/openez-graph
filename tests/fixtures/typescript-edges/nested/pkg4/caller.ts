// `paths: {}` in this package's tsconfig REPLACES the inherited `@root/*`
// mapping — `@root/helper` must not resolve, so no edges and no file import.
import { rootFn } from "@root/helper";

export function run(): void {
  rootFn();
}
