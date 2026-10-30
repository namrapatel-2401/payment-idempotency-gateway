# Failure Scenarios
Stale lock (>30s) -> reconciliation. Provider ambiguous -> REQUIRES_RECONCILIATION. DB tx outside HTTP call (Tx 1 acquire, provider call, Tx 2 save). Redis rate-limit deferred until Docker available.
