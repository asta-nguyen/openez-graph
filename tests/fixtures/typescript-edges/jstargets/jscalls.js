// A JS caller reaching a TS module: the JS-only target guard must drop it.
import { tsFn } from "./tsmodule.ts";

export function runJs() {
  tsFn();
}
