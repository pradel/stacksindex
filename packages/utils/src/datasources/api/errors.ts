import { TaggedError } from "better-result";

export class StacksApiResponseError extends TaggedError("StacksApiResponseError")<{
  status: number;
  path: string;
  statusText?: string;
}>() {}

export class StacksApiParseError extends TaggedError("StacksApiParseError")<{
  message: string;
}>() {}

export type StacksApiError = StacksApiResponseError | StacksApiParseError;
