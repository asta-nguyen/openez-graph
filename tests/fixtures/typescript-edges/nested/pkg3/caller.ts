import { localFn } from "./local";
import { rootFn } from "@root/helper";

export function run(): void {
  localFn();
  rootFn();
}
