;; Emits print events consumed by the stacksindex devnet e2e suite.

(define-constant BATCH_INDEXES (list
  u0 u1 u2 u3 u4 u5 u6 u7 u8 u9
  u10 u11 u12 u13 u14 u15 u16 u17 u18 u19
  u20 u21 u22 u23 u24 u25 u26 u27 u28 u29
  u30 u31 u32 u33 u34 u35 u36 u37 u38 u39
  u40 u41 u42 u43 u44 u45 u46 u47 u48 u49))

(define-constant ERR_ABORTED (err u500))

(define-data-var value uint u0)

(define-read-only (get-value)
  (var-get value))

;; One print per supported Clarity value type, nested in a single tuple.
(define-public (emit-all-types)
  (begin
    (print {
      event: "all-types",
      uint: u340282366920938463463374607431768211455,
      int: -170141183460469231731687303715884105728,
      bool: true,
      standard-principal: tx-sender,
      contract-principal: current-contract,
      buff: 0xdeadbeef,
      ascii: "hello devnet",
      utf8: u"caf\u{e9} \u{1F680}",
      some: (some u7),
      none: (if true none (some u0)),
      ok: (if true (ok u1) (err u2)),
      err: (if true (err u3) (ok u4)),
      list: (list u1 u2 u3),
      tuple: { nested: { depth: u2 } },
    })
    (ok true)))

(define-public (set-value (new-value uint))
  (begin
    (var-set value new-value)
    (print { event: "value-set", value: new-value, sender: tx-sender })
    (ok new-value)))

(define-private (emit-batch-item (index uint) (batch uint))
  (begin
    (print { event: "batch", batch: batch, index: index })
    batch))

;; Prints 50 events in one transaction.
(define-public (emit-batch (batch uint))
  (ok (fold emit-batch-item BATCH_INDEXES batch)))

;; Prints, then aborts: the chain discards the print event.
(define-public (emit-then-fail)
  (begin
    (print { event: "aborted" })
    (asserts! false ERR_ABORTED)
    (ok true)))
