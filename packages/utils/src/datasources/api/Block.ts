import Schema from "effect/Schema";

export interface Block {
  readonly hash: string;
  readonly height: number;
  readonly timestamp: number;
}

export const BlockSchema = Schema.Struct({
  hash: Schema.String,
  height: Schema.Number,
  timestamp: Schema.Number,
});

export const Blockfields = BlockSchema.fields;
