import { direct, renamed, viaStar } from "./barrel";
import { winner } from "./namedbar";

export function run(): void {
  direct();
  viaStar();
  renamed();
  winner();
}
