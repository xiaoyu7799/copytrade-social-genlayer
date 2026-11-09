# CopyTrade mechanism

## Goal

Social copy-trading where the leaderboard is people, not tickers: a
trader publishes a track record at a public URL, GenLayer validators
independently fetch that record and audit it, and only an audited
trader can be copied — with a copy weight set by the audit verdict.
Copying stakes real testnet GEN (5 GEN per copy), settlement fetches
the live BTC price on-chain, and payouts are withdrawable GEN
credits. There is no exchange execution and no real trading venue
involved.

## Opening four lines

- Category: Trading / social.
- Mechanism: consensus audits a trader's published track-record
  evidence and returns VERIFIED / SUSPECT / REJECTED; the verdict
  sets the copy weight (1.0x / 0.5x / 0x). Copying stakes 5 GEN;
  settlement fetches the live BTC price and pays principal plus
  PnL on the weighted exposure back in GEN. A challenge stakes
  2 GEN: it is forfeited to the house pool when the second
  evaluation agrees, refunded plus a 0.75 GEN reward when it
  differs.
- Interaction: a people-centred leaderboard (avatar, track record,
  followers) plus a copy cockpit — copy, settle, cancel, withdraw.
- Evolving state: trader reputation (from 0, audit +10 / −10),
  open copy positions, GEN credits, the house pool, follower
  counts, audit witnesses.

## State

All records are JSON strings in `TreeMap[str, str]`; order in
`DynArray[str]`. Amounts are integer wei (1 GEN = 10^18 wei);
there are no floats anywhere. Reputation belongs to traders only;
followers have no reputation score.

- `traders`: trader id (`t0`, `t1`, …) → trader record.
- `audits`: audit id (`a0`, …) → audit record.
- `copies`: copy id (`c0`, …) → copy position.
- `credits`: wallet address → withdrawable GEN credit (wei).
- `witnesses`: witness id (`w0`, …) → contradiction witness.
- Counters: `next_trader`, `next_audit`, `next_copy`,
  `next_witness` (u256).
- Money counters (u256 wei): `total_received` (all payable
  inflows), `total_paid_out` (all withdrawals), `locked_copies`
  (stakes of OPEN copies), `locked_challenges` (challenge stakes
  awaiting close), `credits_total` (sum of all credits),
  `house_pool` (forfeited challenge stakes + stakes retained
  from losing settlements).

Trader record:

```json
{
  "id": "t0",
  "name": "Ava Chen",
  "trader_code": "AVA-001",
  "evidence_ref": "https://raw.githubusercontent.com/.../trader-ava.json",
  "registrar": "0x...",
  "status": "AUDITED_VERIFIED",
  "verdict": "VERIFIED",
  "weight": 100,
  "reputation": 10,
  "followers": 1,
  "open_copies": 0,
  "total_copied_wei": 5000000000000000000,
  "settled_copies": 1,
  "witness_count": 0
}
```

Audit record:

```json
{
  "id": "a0",
  "trader_id": "t0",
  "status": "CLOSED",
  "round1": {"verdict": "VERIFIED", "check_source_valid": true, "check_identity_matches": true, "check_dates_consistent": true, "check_numbers_consistent": true, "check_evidence_fresh": true, "evidence_end_date": "2026-11-08", "audit_date": "2026-11-09", "wins": 7, "trade_count": 10, "total_return_bps": 1390},
  "round2": null,
  "challenger": null,
  "challenge_reason": null,
  "challenge_outcome": null,
  "challenge_stake_wei": 0
}
```

Copy record:

```json
{
  "id": "c0",
  "follower": "0x...",
  "trader_id": "t0",
  "stake_wei": 5000000000000000000,
  "weight": 100,
  "effective_wei": 5000000000000000000,
  "entry_bucket_usd": 74000,
  "status": "SETTLED",
  "exit_bucket_usd": 74700,
  "pnl_bps": 94,
  "pnl_wei": 47000000000000000,
  "return_wei": 5047000000000000000,
  "capped": false
}
```

## Money invariant

Every wei is accounted for, at all times:

```
total_received == total_paid_out + locked_copies
                + locked_challenges + credits_total + house_pool
```

and `contract balance == total_received - total_paid_out`.
`get_totals` returns all six counters plus `invariant_ok` and
`balance_matches_wei`, computed on-chain from the same state.
The invariant is what makes the house pool honest: the pool is
capitalised only by forfeited challenge stakes (2 GEN each) and
by stakes retained from losing settlements. It never mints GEN,
and settlement upside above a copy's own stake is paid from the
pool and capped by the pool balance — the contract can never
promise GEN it does not hold.

## The evidence record (what is audited)

The trader registers with an `evidence_ref`: a public HTTPS URL
serving a JSON track record with exactly these fields:

```json
{
  "trader_code": "AVA-001",
  "trader_name": "Ava Chen",
  "window_start": "2026-09-01",
  "window_end": "2026-11-08",
  "claimed_win_rate_bps": 7000,
  "claimed_total_return_bps": 1390,
  "trades": [
    {"id": "T-001", "date": "2026-09-02", "market": "BTC/USD", "pnl_bps": 320}
  ]
}
```

`pnl_bps` is integer basis points per trade. `win_rate_bps` is
in 0..10000. Dates are `YYYY-MM-DD`.

## Audit checks (deterministic, no scores, no LLM)

The nondet function fetches the evidence URL and the current UTC
date (timeapi.io first, worldtimeapi.org as fallback — the first
source that answers wins; see the contract), then computes five
binary checks in pure Python. There are no numeric scores and no
tolerance bands anywhere in the audit path.

1. `source_valid`: the evidence URL returns 200, parses as JSON,
   and contains every required field with the right shapes.
2. `identity_matches`: `evidence.trader_code` equals the registered
   `trader_code` AND `evidence.trader_name` equals the registered
   name, exact string equality.
3. `dates_consistent`: every trade date lies inside
   `[window_start, window_end]`, `window_start <= window_end`, and
   the last trade date equals `window_end`.
4. `numbers_consistent`: all of these hold with exact integer
   equality — no tolerance:
   - `wins * 10000 == claimed_win_rate_bps * n_trades`
     (win rate recomputed from the trades);
   - `sum(pnl_bps) == claimed_total_return_bps`;
   - every trade has a unique `id`;
   - `n_trades >= 5`;
   - every `|pnl_bps| <= 5000` (no single trade over 50%);
   - `0 <= claimed_win_rate_bps <= 10000`.
5. `evidence_fresh`: `days(audit_date - window_end) <= 90`, where
   `audit_date` is the current UTC date fetched from the time
   source, and the caller-supplied date is never trusted.

The verdict is a deterministic table over the five checks — the
table, not any score, decides:

| checks | verdict |
|---|---|
| all five pass | VERIFIED |
| `identity_matches` fails, or `source_valid` fails | REJECTED |
| any other check fails (dates / numbers / freshness) | SUSPECT |

Staleness therefore can never produce VERIFIED: an outdated record
is at best SUSPECT. A fabricated identity or an unreachable record
is REJECTED, never SUSPECT.

## Equivalence: exact match, zero tolerance

A validator accepts the leader result only if ALL of these hold:

1. The leader result is a dict with exactly the expected fields
   (11 for the audit, 11 for settlement).
2. The validator's own independent fetch succeeds and yields a
   result.
3. Every field is exactly equal to the validator's own
   recomputation. String equality for strings, integer equality
   for integers. No `<=`, no `±`, no rounding.
4. The leader's verdict equals the verdict the deterministic
   table derives from the leader's own checks. A leader that
   reports checks saying SUSPECT but a verdict saying VERIFIED
   is rejected.

If the leader raised a UserError (fetch failed, bad JSON, bad date,
price sources unavailable), a validator agrees only if its own
fetch also fails with a UserError. A failed audit or a failed
price fetch writes nothing; the audit stays PENDING (or the copy
stays unopened) and can be retried.

## Worst-case spread table (computed before coding)

The stored core values are the verdict, the copy weight, and the
settlement return in wei. The question is: how far apart can two
different, validator-compatible leader outputs be on those stored
values?

| # | quantity | rule | edge values that both pass validation | max spread of the stored core value | changes the business outcome? |
|---|---|---|---|---|---|
| 1 | verdict | exact string equality on all 11 audit fields, leader verdict must equal the table verdict for its own checks, validator recomputes every check | none: any difference in verdict, any check, `evidence_end_date`, `audit_date`, or either recomputed number fails validation | **0** — two passing leader outputs have identical verdicts | No |
| 2 | copy weight | deterministic function of the CLOSED verdict: 100 / 50 / 0 | none: weight is not an input, it is derived from the verdict at close time | **0** | No |
| 3 | win rate / total return | stored values are the recomputed integers (`wins`, `trade_count`, `total_return_bps`), required exactly equal to the validator's recomputation; claimed values must match them exactly (integer equality, no band) | none: claimed 7000 vs recomputed 7 wins of 10 trades (7000) passes; claimed 7200 vs recomputed 7000 fails `numbers_consistent`; a leader claiming different `wins` is rejected outright because the validator recomputes the same trades | **0 bps** | No |
| 4 | staleness | `days(audit_date - window_end) <= 90`, integer day count; `audit_date` must equal the validator's independently fetched UTC date exactly | leader on 2026-11-09, validator on 2026-11-10 (midnight crossing): the dates differ, validation fails, nothing is stored — the audit stays pending and is retried, it never stores a verdict from mixed dates. A record ending 2026-08-10 audited 2026-11-09: age 91 days → fails `evidence_fresh` → SUSPECT at best, never VERIFIED | **0 days of ambiguity in any stored verdict** | No |
| 5 | challenge outcome | second verdict equals first verdict (exact string equality) → challenge fails, 2 GEN forfeited to the house pool; differs → second verdict closes, challenger refunded 2 GEN + 0.75 GEN reward from the pool | none: verdict equality is exact; the reward is `min(0.75 GEN, pool)`, a deterministic function of on-chain state | **0** | No |
| 6 | entry BTC price | fetched live at copy time (CoinDesk first, CoinGecko fallback), bucketed to whole $100; validators agree on the bucket only, never on the exact price or the source | leader bucket $74,000, validator bucket $74,100 (price crossed the $100 line mid-consensus): validation fails, no copy is opened, the 5 GEN stake is not taken, the call is retried. Two passing outputs share one bucket by definition | **0 USD of ambiguity in any stored entry price** | No |
| 7 | exit BTC price + PnL | same bucket rule at settle time; `pnl_bps = trunc((exit - entry) * 10000 / entry)`, `pnl_wei = trunc(effective_wei * pnl_bps / 10000)` — truncation toward zero, documented, no rounding | entry $74,000, exit $74,700 → `pnl_bps = trunc(700*10000/74000) = 94` (94.59… truncated, never rounded up); exit $73,900 → `pnl_bps = trunc(-100*10000/74000) = -13` (toward zero, not floor −14). A leader reporting 95 or −14 for the same buckets is rejected because the validator recomputes the same integers | **0 bps, 0 wei** — all 11 settlement fields must match exactly, including `pool_before_wei` and `pool_after_wei` | No |
| 8 | settlement return + pool | `return_wei = stake_wei + pnl_wei`, capped: upside above the stake is paid from the house pool only up to the pool balance (`paid_upside_wei = min(upside, pool_before)`); `pool_after_wei = pool_before + stake - return` | entry $74,000, exit $148,000 (price doubles), pool 0 GEN: raw return 10 GEN, paid return exactly 5 GEN, `capped = true`, pool stays 0. Same move with pool 1 GEN: return exactly 6 GEN, pool exactly 0. The cap is a deterministic function of on-chain state, so two passing outputs agree on it exactly | **0 wei** | No — the cap is the solvency rule, not a disagreement: a winner is never promised GEN the contract does not hold |

Worked edge cases (not happy path):

- Leader A reports checks all-pass / VERIFIED; leader B reports
  `numbers_consistent = false` / SUSPECT for the same evidence.
  They cannot both pass: the validator recomputes the numbers
  exactly, so at most one of the two checklists matches the
  validator's own, and the other is rejected.
- Leader reports `wins = 7` (recomputed) while the
  trades recompute to 6 wins: the validator recomputes 6, exact
  equality fails, the leader is rejected.
- Evidence ends 2026-08-10, audit runs 2026-11-09: age is 91 days,
  `evidence_fresh` fails, verdict is SUSPECT, copy weight 50.
  A leader claiming VERIFIED for this record is rejected because
  its verdict contradicts the table for its own checks.
- The evidence file is edited between the leader's fetch and a
  validator's fetch: checklists differ, validation fails, the
  audit stays PENDING. Evidence must be content-stable during
  consensus; a changed record is retried, never half-stored.
- BTC sits at $74,099 when a copy is opened and crosses $74,100
  before a validator fetches: buckets differ, validation fails,
  no copy is opened and no GEN moves. The copy is retried.
- BTC doubles between copy and settle while the house pool holds
  0 GEN: the return is capped at the 5 GEN stake and the copy is
  marked `capped = true`. The winner is not paid GEN the contract
  does not hold; the shortfall is visible on the copy record.
- A challenge is closed after the evidence file was corrected:
  round2 VERIFIED differs from round1 SUSPECT, so the challenge
  succeeds and the challenger is refunded 2 GEN + 0.75 GEN from
  the pool. Had the file not changed, round2 would equal round1
  and the 2 GEN would be forfeited to the pool instead.

Conclusion: the maximum spread between two validator-compatible
leader outputs on every stored core value is **zero**. There is no
tolerance band to widen a verdict, a weight, a price bucket, or a
settlement. The only number that is ever truncated is the PnL
itself, and its truncation rule (toward zero) is deterministic and
validated exactly, so it cannot differ between two passing
outputs either.

## Lifecycle

1. `register_trader(name, trader_code, evidence_ref)` — anyone.
   Name non-empty (≤ 80 chars), `trader_code` 1–24 chars
   `[A-Z0-9-]`, `evidence_ref` an `https://` URL ≤ 500 chars.
   Reputation starts at 0. Status REGISTERED, no verdict.
2. `audit_trader(trader_id)` — anyone. Runs the nondet audit
   above; stores the pending verdict (all 11 fields); status
   PENDING.
3. `challenge_audit(audit_id, reason)` — payable, exactly
   2 GEN (2000000000000000000 wei); anyone except the audit's
   requester; only while PENDING; reason 1–200 chars. The 2 GEN
   is locked (`locked_challenges`) until the audit closes.
4. `finalize_audit(audit_id)` — anyone (permissionless).
   - Unchallenged: the pending verdict closes. The trader's
     verdict, weight and reputation update (VERIFIED +10,
     SUSPECT +0, REJECTED −10; reputation floored at 0, capped
     at 200). Status CLOSED.
   - Challenged: a second nondet evaluation runs under the same
     exact-match rules. Its verdict closes. Challenge succeeds
     iff the second verdict differs from the first: the
     challenger is credited 2 GEN + a 0.75 GEN reward drawn from
     the house pool (`min(0.75 GEN, pool)`). Otherwise it fails
     and the 2 GEN is forfeited into the house pool. Both rounds
     are kept in the audit record.
   A CLOSED verdict is immutable: later audits never overwrite
   it on the trader record.
5. `copy_trader(trader_id)` — payable, exactly 5 GEN
   (5000000000000000000 wei). The trader must have a CLOSED
   verdict of VERIFIED (weight 100) or SUSPECT (weight 50);
   REJECTED (weight 0) or unaudited traders cannot be copied.
   The live BTC price is fetched and bucketed to $100 as the
   entry price. The stake is locked and a copy position opens
   with `effective_wei = stake_wei * weight // 100` (exact:
   100 → 5 GEN, 50 → 2.5 GEN). Follower count +1,
   `total_copied_wei` += effective.
6. `settle_copy(copy_id)` — only the copy's follower may call
   it; only while OPEN. Fetches the live BTC price, buckets it
   to $100, and computes the 11 settlement fields with exact
   integer arithmetic (see row 7–8 of the spread table). The
   return is credited to the follower (withdrawable via
   `withdraw_payout`), the stake is unlocked, and the house
   pool moves to `pool_after_wei`. Settlement does not change
   trader reputation.
7. `cancel_copy(copy_id)` — only the copy's follower may call
   it; only while OPEN. The full 5 GEN stake is credited back
   to the follower. Status CANCELLED. A SUSPECT copy therefore
   always has an exit: settle at 0.5x, or cancel for a full
   refund.
8. `withdraw_payout()` — anyone with a credit. The credit is
   zeroed first, then the GEN is transferred to the caller's
   address. Pull payment: settlement, cancellation and
   challenge refunds only ever create credits; no GEN is
   pushed at close time.

## Contradictions are witnesses, never overwrites

If a re-audit closes with a verdict different from the trader's
standing CLOSED verdict, the trader record keeps the original
verdict and weight, `witness_count` increases by 1, and a witness
record is appended:

```json
{
  "id": "w0", "trader_id": "t0",
  "standing_verdict": "VERIFIED", "new_verdict": "SUSPECT"
}
```

## What this contract does not do

- It does not execute trades on any exchange. Copying stakes
  GEN in the contract; settlement applies the live BTC price
  movement to the weighted exposure. No trade is executed on
  any venue.
- It does not prove that the trades in a published record were
  executed on a venue. It proves the published record is
  internally consistent, matches the registered trader identity,
  and is fresh — under exact-match validator consensus.
- It does not authenticate the evidence host beyond its public
  HTTPS endpoint. If the host serves a different record, the
  audit fails or the record is judged as served; a changed record
  mid-consensus leaves the audit pending.
- Settlement upside above a copy's own stake is paid only from
  the house pool and capped by it. When the pool is empty, a
  winning copy is paid back at most its own stake and the copy
  is marked `capped`. The pool is funded only by forfeited
  challenge stakes and by stakes retained from losing
  settlements; it is never topped up by any other means.
- A challenge stake stays locked until somebody calls
  `finalize_audit` on that audit. Finalisation is
  permissionless, so anyone can release it.
