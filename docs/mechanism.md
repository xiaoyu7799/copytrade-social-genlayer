# CopyTrade mechanism

## Goal

Social copy-trading where the leaderboard is people, not tickers: a
trader publishes a track record at a public URL, GenLayer validators
independently fetch that record and audit it, and only an audited
trader can be copied — with a copy weight set by the audit verdict.
Copying moves simulated mGEN on an in-contract ledger only. There is
no real trading, no real GEN custody, and no real exchange execution.

## Opening four lines

- Category: Trading / social.
- Mechanism: consensus audits a trader's published track-record
  evidence and returns VERIFIED / SUSPECT / REJECTED; the verdict
  sets the copy weight (1.0x / 0.5x / 0x) and gates settlement.
  A challenge forces a second evaluation before finalisation.
- Interaction: a people-centred leaderboard (avatar, track record,
  followers) plus a copy cockpit — follow, copy, compare people.
- Evolving state: trader reputation, copy positions, PnL, follower
  counts, audit witnesses.

## State

All records are JSON strings in `TreeMap[str, str]`; order in
`DynArray[str]`. Amounts are integers; there are no floats anywhere.

- `traders`: trader id (`t0`, `t1`, …) → trader record.
- `audits`: audit id (`a0`, …) → audit record.
- `copies`: copy id (`c0`, …) → copy position.
- `accounts`: wallet address → ledger account
  (`{balance, claimed_demo, reputation}`).
- `witnesses`: witness id (`w0`, …) → contradiction witness.
- Counters: `next_trader`, `next_audit`, `next_copy`,
  `next_witness` (u256).

Trader record:

```json
{
  "id": "t0",
  "name": "Ava Chen",
  "trader_code": "AVA-001",
  "evidence_ref": "https://raw.githubusercontent.com/.../trader-ava.json",
  "registrar": "0x...",
  "status": "REGISTERED",
  "verdict": null,
  "weight": 0,
  "reputation": 100,
  "followers": 0,
  "total_copied": 0,
  "settled_copies": 0,
  "witness_count": 0
}
```

Audit record:

```json
{
  "id": "a0",
  "trader_id": "t0",
  "status": "EVALUATING",
  "round1": {"verdict": "VERIFIED", "check_source_valid": true, "check_identity_matches": true, "check_dates_consistent": true, "check_numbers_consistent": true, "check_evidence_fresh": true, "evidence_end_date": "2026-11-08", "audit_date": "2026-11-09", "wins": 7, "trade_count": 10, "total_return_bps": 1840},
  "round2": null,
  "challenger": null,
  "challenge_reason": null,
  "challenge_outcome": null
}
```

Copy record:

```json
{
  "id": "c0",
  "follower": "0x...",
  "trader_id": "t0",
  "allocation": 1000,
  "weight": 100,
  "effective": 1000,
  "status": "OPEN",
  "pnl_bps": null,
  "pnl": null,
  "settled_value": null
}
```

Ledger account:

```json
{"address": "0x...", "balance": 10000, "claimed_demo": true, "reputation": 100}
```

## The evidence record (what is audited)

The trader registers with an `evidence_ref`: a public HTTPS URL
serving a JSON track record with exactly these fields:

```json
{
  "trader_code": "AVA-001",
  "trader_name": "Ava Chen",
  "window_start": "2026-09-01",
  "window_end": "2026-11-08",
  "claimed_win_rate_bps": 7200,
  "claimed_total_return_bps": 1840,
  "trades": [
    {"id": "T-001", "date": "2026-09-02", "market": "mGEN/USDC", "pnl_bps": 320}
  ]
}
```

`pnl_bps` is integer basis points per trade. `win_rate_bps` is
in 0..10000. Dates are `YYYY-MM-DD`.

## Audit checks (deterministic, no scores, no LLM)

The nondet function fetches the evidence URL and the current UTC
date (timeapi.io first, worldtimeapi.org as fallback — the first
source that answers wins; see the contract), then
computes five binary checks in pure Python. There are no numeric
scores and no tolerance bands anywhere in the audit path.

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

1. The leader result is a dict with exactly the expected fields.
2. The validator's own independent fetch of the evidence URL and
   of the time source succeeds and yields a result.
3. Every field is exactly equal to the validator's own recomputation:
   `verdict`, all five check booleans, `evidence_end_date`
   (= `window_end`), `audit_date`, `wins` and `trade_count`
   (recomputed), `total_return_bps` (recomputed). String equality for strings,
   integer equality for integers. No `<=`, no `±`, no rounding.
4. The leader's verdict equals the verdict the deterministic table
   derives from the leader's own checks. A leader that reports
   checks saying SUSPECT but a verdict saying VERIFIED is rejected.

If the leader raised a UserError (fetch failed, bad JSON, bad date),
a validator agrees only if its own fetch also fails with a
UserError. A failed audit writes nothing; the audit stays
EVALUATING and can be retried.

## Worst-case spread table (computed before coding)

The stored core values are the verdict and the copy weight
(VERIFIED → 100, SUSPECT → 50, REJECTED → 0). The question is:
how far apart can two different, validator-compatible leader
outputs be on those stored values?

| # | quantity | rule | edge values that both pass validation | max spread of the stored core value | changes the business outcome? |
|---|---|---|---|---|---|
| 1 | verdict | exact string equality, leader verdict must equal the table verdict for its own checks, validator recomputes every check | none: any difference in verdict, any check, `evidence_end_date`, `audit_date`, or either recomputed number fails validation | **0** — two passing leader outputs have identical verdicts | No |
| 2 | copy weight | deterministic function of the FINALIZED verdict: 100 / 50 / 0 | none: weight is not an input, it is derived from the verdict after finalisation | **0** | No |
| 3 | win rate / total return | stored values are the recomputed integers (`wins`, `trade_count`, `total_return_bps`), required exactly equal to the validator's recomputation; claimed values must match them exactly (integer equality, no band) | none: claimed 7200 vs recomputed 7 wins of 10 trades (7000) fails `numbers_consistent`; a leader claiming different `wins` is rejected outright because the validator recomputes the same trades | **0 bps** | No |
| 4 | staleness | `days(audit_date - window_end) <= 90`, integer day count; `audit_date` must equal the validator's independently fetched UTC date exactly | leader on 2026-11-09, validator on 2026-11-10 (midnight crossing): the dates differ, validation fails, nothing is stored — the audit stays pending and is retried, it never stores a verdict from mixed dates. A record ending 2026-08-10 audited 2026-11-09: age 91 days → fails `evidence_fresh` → SUSPECT at best, never VERIFIED | **0 days of ambiguity in any stored verdict** | No |
| 5 | challenge outcome | second verdict equals first verdict (exact string equality) → challenge fails, challenger −5 reputation; differs → second verdict finalises, challenger +5 | none: verdict equality is exact | **0** | No |
| 6 | settlement PnL | allocation must be a positive multiple of 100; `pnl_bps` a multiple of 100 in [-10000, 10000]; `pnl = effective * pnl_bps // 10000`. For a VERIFIED trader `effective == allocation`, so `allocation % 100 == 0` and `pnl_bps % 100 == 0` make the product divisible by 10000 — the division is exact, there is no remainder to round | allocation 1000, pnl +500 bps → pnl exactly +50; allocation 1000, pnl +501 bps → rejected (not a multiple of 100), no settlement is written | **0 mGEN of rounding** | No |

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
  audit stays EVALUATING. Evidence must be content-stable during
  consensus; a changed record is retried, never half-stored.

Conclusion: the maximum spread between two validator-compatible
leader outputs on every stored core value is **zero**. There is no
tolerance band to widen a verdict, a weight, or a settlement.

## Lifecycle

1. `register_trader(name, trader_code, evidence_ref)` — anyone.
   Name non-empty (≤ 80 chars), `trader_code` 1–24 chars
   `[A-Z0-9-]`, `evidence_ref` an `https://` URL ≤ 500 chars.
   Reputation starts at 100. Status REGISTERED, no verdict.
2. `audit_trader(trader_id)` — anyone. Runs the nondet audit
   above; stores the pending verdict; status EVALUATING.
   Re-auditing a trader with a FINALIZED verdict is allowed; see
   witnesses.
3. `challenge_audit(audit_id, reason)` — anyone except the audit's
   requester; only while EVALUATING; reason 1–200 chars. Records
   the challenger and sets status CHALLENGED.
4. `finalize_audit(audit_id)` — anyone (permissionless).
   - Unchallenged: the pending verdict finalises. The trader's
     verdict, weight and reputation update (VERIFIED +10,
     SUSPECT +0, REJECTED −10; reputation floored at 0, capped
     at 200). Status FINALIZED.
   - Challenged: a second nondet evaluation runs under the same
     exact-match rules. Its verdict finalises. Challenge succeeds
     iff the second verdict differs from the first (challenger
     +5), otherwise it fails (challenger −5). Both rounds are kept
     in the audit record.
   A FINALIZED verdict is immutable: later audits never overwrite
   it on the trader record.
5. `claim_demo_funds()` — credits 10000 simulated mGEN once per
   address. Creates the ledger account (reputation 100) on first
   participation.
6. `follow_trader(trader_id, allocation)` — allocation must be a
   positive multiple of 100 (hence even) and `<=` the caller's
   balance. The trader must have a FINALIZED verdict of VERIFIED
   (weight 100) or SUSPECT (weight 50); REJECTED (weight 0) or
   unaudited traders cannot be followed. The allocation is deducted
   and a copy position opens with
   `effective = allocation * weight // 100` (exact: 100 → ×1,
   50 → ÷2). Follower count +1, `total_copied` += effective.
7. `settle_copy(copy_id, pnl_bps)` — only the copy's follower may
   call it; only while the trader's standing verdict is VERIFIED;
   `pnl_bps` must be a multiple of 100 in [-10000, 10000].
   `pnl = effective * pnl_bps // 10000` (exact, see table row 6).
   The follower is credited `effective + pnl`. The copy becomes
   SETTLED and keeps its `pnl_bps` and `pnl`. Trader reputation
   +1 on a profitable settlement, −1 on a losing one (floored
   at 0).

## Contradictions are witnesses, never overwrites

If a re-audit finalises with a verdict different from the trader's
standing FINALIZED verdict, the trader record keeps the original
verdict and weight, `witness_count` increases by 1, and a witness
record is appended:

```json
{
  "id": "w0", "trader_id": "t0", "audit_id": "a3",
  "standing_verdict": "VERIFIED", "new_verdict": "SUSPECT",
  "evidence_end_date": "2026-08-10", "audit_date": "2026-11-09"
}
```

## What this contract does not do

- It does not execute trades on any exchange and does not move
  real GEN. Copying is a simulated-ledger allocation; settlement
  applies the trader's reported period result in basis points.
- It does not prove that the trades in a published record were
  executed on a venue. It proves the published record is
  internally consistent, matches the registered trader identity,
  and is fresh — under exact-match validator consensus.
- It does not authenticate the evidence host beyond its public
  HTTPS endpoint. If the host serves a different record, the
  audit fails or the record is judged as served; a changed record
  mid-consensus leaves the audit pending.
- Settlement trusts the follower-submitted period figure
  (`pnl_bps`) as the trader's reported result; the contract
  checks its format and bounds, not its provenance.
