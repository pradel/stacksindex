import { Schema } from "effect";

export const BlockSchema = Schema.Struct({
  hash: Schema.String,
  height: Schema.Number,
  block_time: Schema.Number,
});

export type Block = Schema.Schema.Type<typeof BlockSchema>;
