import { TaggedError } from "better-result";

export class HandlerExecutionError extends TaggedError("HandlerExecutionError")<{
  contractId: string;
  cause: unknown;
}>() {}
