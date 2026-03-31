export function fn() {
  return "Hello, tsdown!";
}

import { Effect, Console } from "effect";

const program = Console.log("Hello, World!");

Effect.runSync(program);
