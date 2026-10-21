import { aliasFn } from "@lib/util";
import { exactFn } from "@exact";
import { deepFn } from "@first/deep";
import { appFn } from "@app/plain";
import { specialFn } from "@app/special/sp";
import { baseFn } from "src/base/base";
import { ghost } from "@lib/ghost";
import { map } from "lodash";

export function run(): void {
  aliasFn();
  exactFn();
  deepFn();
  appFn();
  specialFn();
  baseFn();
  ghost();
  map();
}
