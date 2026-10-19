;; Interleaves its own print events with events from `events.clar` in one
;; transaction, so a single tx emits events from two contracts.

(define-public (record (amount uint))
  (begin
    (print { event: "ledger-before", amount: amount })
    (unwrap-panic (contract-call? .events set-value amount))
    (print { event: "ledger-after", amount: amount })
    (ok amount)))
