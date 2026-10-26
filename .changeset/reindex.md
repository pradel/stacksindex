---
"stacksindex": minor
---

Add `reindex(clearTables?)` (`indexer.reindex` in the Effect API): the next `run` or `live` replays every stored event through the handlers without fetching it again, e.g. after changing a handler or adding a contract. `clearTables` empties your tables in the same transaction. Contracts added or whose block range changed are fetched again over their new range.
