---
"stacksindex": patch
---

`decodeClarityWithSchema` from `stacksindex/clarity` now fails with a typed error. Malformed hex fails with the new `ClarityDecodeError` (carrying `hex` and the codec's `cause`) instead of the raw codec error, and the Effect's error and requirements types are `ClarityDecodeError | SchemaError` and the schema's decoding services instead of `unknown`.
