import { TaggedError } from "better-result";

export class StacksApiResponseError extends TaggedError("StacksApiResponseError")<{
  status: number;
  path: string;
  statusText: string;
  errorData: unknown;
}>() {}

export class StacksApiParseError extends TaggedError("StacksApiParseError")<{
  message: string;
  cause: unknown;
}>() {}

export type StacksApiError = StacksApiResponseError | StacksApiParseError;
