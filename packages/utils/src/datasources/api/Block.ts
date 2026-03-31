import { Schema } from "effect";

export interface Block {
  readonly hash: string;
  readonly height: number;
  readonly timestamp: number;
}

const RawBlockSchema = Schema.Struct({
  hash: Schema.String,
  height: Schema.Number,
  block_time: Schema.Number,
}).pipe(Schema.rename({ block_time: "timestamp" }));

export const BlockSchema = RawBlockSchema;
