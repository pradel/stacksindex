;; Prints only when `relay.clar` calls it: no transaction calls it directly, so
;; its address history lists none of the transactions that emit its events.

(define-public (log (amount uint))
  (begin
    (print { event: "relayed", amount: amount })
    (ok amount)))
