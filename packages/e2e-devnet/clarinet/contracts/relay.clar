;; Forwards to `relayed.clar`, the only way its events are emitted.

(define-public (relay (amount uint))
  (contract-call? .relayed log amount))
