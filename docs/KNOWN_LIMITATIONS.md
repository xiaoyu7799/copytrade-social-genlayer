# Known limitations

Neutral statements of scope. Nothing here contradicts the product
claim: the audit proves a published record is internally consistent,
matches the registered trader identity, and is fresh — under
exact-match validator consensus; copying stakes real testnet GEN
and settlement pays principal plus PnL on the live BTC price
movement.

- **Real testnet GEN, Studionet only.** All amounts are GEN on
  Stable Studionet (Chain 61999), free from the faucet, zero cash
  cost. A copy stakes exactly 5 GEN (5000000000000000000 wei); a
  challenge stakes exactly 2 GEN (2000000000000000000 wei). No
  trade is executed on any exchange.
- **The audit checks the published record, not the venue.** The
  five checks prove the record at the registered URL is
  well-formed, matches the trader's identity, is internally
  consistent (dates and arithmetic recompute exactly) and is fresh.
  They do not independently confirm that the listed trades were
  executed on an exchange. A record that is internally consistent
  but fabricated at the source would pass the checks; the source
  URL is stored on-chain so anyone can inspect it.
- **Settlement upside is capped by the house pool.** The return
  is `stake + PnL`, but the part above the stake is paid only from
  the house pool and only up to the pool balance; the copy is then
  marked `capped`. The pool is funded only by forfeited challenge
  stakes and by stakes retained from losing settlements. When the
  pool is empty, a winning copy is paid back at most its own
  stake.
- **Prices are $100 buckets, not exact cents.** Entry and exit
  BTC prices are bucketed to whole $100 (CoinDesk first,
  CoinGecko fallback). Validators agree on the bucket only. If
  the price crosses a bucket line mid-consensus, validation fails
  and the call writes nothing; it is retried. The PnL uses
  truncation toward zero on exact integers, never rounding.
- **Evidence must be content-stable during consensus.** If the
  record at the evidence URL changes between the leader's fetch
  and a validator's fetch, the audit fails validation and stays
  pending. It can be retried once the record is stable.
- **The audit needs a public time source.** The current UTC date
  comes from timeapi.io, with worldtimeapi.org as fallback. If
  both are unreachable, audits stay pending until a source
  answers. Nothing is stored from a failed time fetch.
- **Settlement needs a public price source.** The BTC price comes
  from CoinDesk, with CoinGecko as fallback. If both are
  unreachable, copies cannot open and open copies cannot settle
  until a source answers. Nothing is stored from a failed price
  fetch.
- **A failed payable call can still move GEN into the contract.**
  Measured on Studionet: a `copy_trader` call that fails validation
  (REJECTED trader) finalises with an error and writes nothing, but
  its attached 5 GEN still lands in the contract balance, with no
  credit and no counter entry. The counter invariant still holds
  exactly; the balance is 5 GEN above `total_received -
  total_paid_out`, and `get_totals` reports that through
  `balance_matches_wei`. Only successful calls update the counters.
- **A challenge stake stays locked until close.** A challenged
  audit holds the 2 GEN stake until somebody calls
  `finalize_audit`. Finalisation is permissionless, so anyone can
  release it; the stake is never spendable by the contract itself.
- **A CLOSED verdict is immutable.** A later audit that
  disagrees is recorded as a witness; the trader keeps the
  original verdict and copy weight. This is deliberate: a closed
  verdict is evidence, not a live score.
- **Writes from a browser use a temporary test account.** GenLayer
  writes need a wallet Snap that most wallets do not have, so the
  site writes through an in-browser generated test account that
  is clearly labelled and discarded when the tab closes. The
  wallet path is used for connecting, reading and network checks.
  The temporary account is funded from the Studionet faucet
  first (10,000 GEN, free).
