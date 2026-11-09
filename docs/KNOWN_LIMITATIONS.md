# Known limitations

Neutral statements of scope. Nothing here contradicts the product
claim: the audit proves a published record is internally consistent,
matches the registered trader identity, and is fresh — under
exact-match validator consensus.

- **Simulated money only.** All amounts are simulated mGEN on an
  in-contract ledger. Claiming demo funds, following, copying and
  settlement move ledger balances. No real GEN is custodied, no
  trade is executed on any exchange, and no real market price is
  involved.
- **The audit checks the published record, not the venue.** The
  five checks prove the record at the registered URL is
  well-formed, matches the trader's identity, is internally
  consistent (dates and arithmetic recompute exactly) and is fresh.
  They do not independently confirm that the listed trades were
  executed on an exchange. A record that is internally consistent
  but fabricated at the source would pass the checks; the source
  URL is stored on-chain so anyone can inspect it.
- **Settlement uses the reported period result.** `settle_copy`
  takes the trader's reported period result in basis points from
  the copy owner and applies it to the copy. The contract checks
  the format (multiple of 100, within ±10000 bps) and that the
  trader's standing verdict is VERIFIED; it does not verify the
  provenance of the reported figure.
- **Evidence must be content-stable during consensus.** If the
  record at the evidence URL changes between the leader's fetch
  and a validator's fetch, the audit fails validation and stays
  pending. It can be retried once the record is stable.
- **The audit needs a public time source.** The current UTC date
  comes from timeapi.io, with worldtimeapi.org as fallback. If
  both are unreachable, audits stay pending until a source
  answers. Nothing is stored from a failed time fetch.
- **Copy settlement is VERIFIED-only.** Copies of SUSPECT traders
  open at 0.5x weight and stay open: they record the allocation
  and the capped effective copy, but they do not settle, because
  settlement applies the trader's reported result and is gated on
  a VERIFIED standing verdict. A SUSPECT copy is therefore a
  capped, unsettled position — the allocation stays in the copy.
- **A FINALIZED verdict is immutable.** A later audit that
  disagrees is recorded as a witness; the trader keeps the
  original verdict and copy weight. This is deliberate: a
  finalised verdict is evidence, not a live score.
- **Writes from a browser use a temporary test account.** GenLayer
  writes need a wallet Snap that most wallets do not have, so the
  site writes through an in-browser generated test account that
  is clearly labelled and discarded when the tab closes. The
  wallet path is used for connecting, reading and network checks.
- **No real exchange data is fetched.** Track records are
  publisher-supplied JSON at public URLs. There is no live market
  feed in this version.
