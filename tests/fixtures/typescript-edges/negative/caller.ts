import { dup } from "./amb";
import { cyc } from "./cyca";
import { map } from "lodash";
import { missing } from "./missing";

export function run(): void {
  dup();
  cyc();
  map();
  missing();
}
