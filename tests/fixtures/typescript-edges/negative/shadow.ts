import { uniq } from "./lib";

export function shadowParam(uniq: () => void): void {
  uniq();
}
export function shadowVar(): void {
  const helper = () => 1;
  helper();
}
