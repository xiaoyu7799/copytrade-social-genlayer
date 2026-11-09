# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""CopyTrade: people-centred social copy-trading on GenLayer, real GEN.

A trader publishes a track record as JSON at a public URL. Validators
independently fetch that record and audit it: is the source valid,
does it match the registered trader identity, are the dates
consistent, do the claimed numbers recompute exactly, and is the
record fresh? The audit returns VERIFIED / SUSPECT / REJECTED, and
the verdict sets the copy weight (1.0x / 0.5x / 0x).

Real GEN, no ledger money
-------------------------
Copying stakes real testnet GEN: copy_trader is payable and takes
exactly 5 GEN (5 * 10^18 wei). The stake is locked in the contract
until the copy settles or is cancelled. Settlement fetches the live
BTC price (CoinDesk first, CoinGecko fallback), buckets it to whole
$100, and pays principal plus PnL on the weighted exposure back as a
withdrawable credit: pull payment via withdraw_payout, credit zeroed
before the transfer. A challenge stakes exactly 2 GEN: it is
forfeited into the house pool when the challenge fails, and refunded
plus a 0.75 GEN reward (drawn from the house pool) when it succeeds.
The house pool is capitalised only by forfeited challenge stakes and
by stakes retained from losing settlements; it never mints GEN.
Settlement upside above a copy's own stake is paid from the pool and
capped by the pool balance, so the contract can never promise GEN it
does not hold.

Invariant (checked by get_totals):
  total_received == total_paid_out + locked_copies
                   + locked_challenges + credits_total + house_pool
and contract balance == total_received - total_paid_out.

Consensus design (the part that matters)
----------------------------------------
* Audit: no scores, no tolerance bands. The nondet function computes
  five binary checks in pure Python from the fetched record, and the
  verdict is a deterministic table over those checks. A validator
  accepts the leader result only if all 11 result fields are EXACTLY
  equal to its own independent recomputation, and the leader's verdict
  equals the table verdict for its own checks. Two different
  validator-compatible leader outputs cannot exist: any difference in
  any field fails validation and nothing is stored. Maximum spread on
  every stored core value is zero. See docs/mechanism.md.
* Settlement: the nondet function fetches the live BTC price, buckets
  it to $100, and computes 11 result fields with exact integer
  arithmetic (truncation toward zero, no rounding). A validator
  accepts only if all 11 fields equal its own recomputation. Prices
  are bucketed because a live price moves between the leader's fetch
  and a validator's fetch: agreeing on the $100 bucket (not the exact
  cents) is what makes consensus reachable at all, and a bucket
  boundary crossing fails validation instead of storing a mixed
  value, so settlement is retried, never half-stored.
* Numbers are exact integers. Win rate and total return must
  recompute to the claimed values with integer equality. Settlement
  divides with truncation toward zero and every division is
  documented in docs/mechanism.md.
* Staleness is checked, not ignored: the audit date is the current
  UTC date fetched from a public time source by leader and
  validators alike, and a record older than 90 days can never be
  VERIFIED. If leader and validators fetch different dates (a
  midnight crossing), validation fails and the audit stays pending.
* A failed audit or a failed price fetch writes nothing. A CLOSED
  audit verdict is immutable: a later audit that disagrees is kept
  as a witness, the standing verdict never changes.
* A challenge forces a second evaluation before closing. The
  challenge succeeds iff the second verdict differs from the first.
* SUSPECT copies settle at 0.5x like VERIFIED copies at 1.0x, and
  any OPEN copy can be cancelled before settlement for a full refund
  of the 5 GEN stake as credit.
"""

import json

from genlayer import *

TIME_URLS = (
    "https://timeapi.io/api/time/current/zone?timeZone=UTC",
    "https://worldtimeapi.org/api/timezone/Etc/UTC",
)
PRICE_SOURCES = (
    "https://api.coindesk.com/v1/bpi/currentprice/USD.json",
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
)
MAX_EVIDENCE_AGE_DAYS = 90
MIN_TRADES = 5
MAX_TRADE_PNL_BPS = 5000
STAKE_WEI = 5000000000000000000
CHALLENGE_WEI = 2000000000000000000
CHALLENGE_REWARD_WEI = 750000000000000000
PRICE_BUCKET_USD = 100
REPUTATION_START = 0
REPUTATION_CAP = 200


# -- pure deterministic helpers -----------------------------------------

def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
        return 29 if leap else 28
    if month in (4, 6, 9, 11):
        return 30
    return 31


def _parse_date(text):
    """Parse YYYY-MM-DD to (year, month, day), or None if malformed."""
    if not isinstance(text, str) or len(text) != 10:
        return None
    if text[4] != "-" or text[7] != "-":
        return None
    for i in (0, 1, 2, 3, 5, 6, 8, 9):
        ch = text[i]
        if ch < "0" or ch > "9":
            return None
    year = int(text[0:4])
    month = int(text[5:7])
    day = int(text[8:10])
    if year < 2000 or year > 2100:
        return None
    if month < 1 or month > 12:
        return None
    if day < 1 or day > _days_in_month(year, month):
        return None
    return (year, month, day)


def _days_from_civil(year: int, month: int, day: int) -> int:
    # Howard Hinnant's days-from-civil algorithm, integer only.
    y = year
    if month <= 2:
        y -= 1
    era = y // 400
    yoe = y - era * 400
    mp = (month + 9) % 12
    doy = (153 * mp + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _date_diff_days(later: str, earlier: str):
    a = _parse_date(later)
    b = _parse_date(earlier)
    if a is None or b is None:
        return None
    return _days_from_civil(a[0], a[1], a[2]) - _days_from_civil(b[0], b[1], b[2])


def _derive_verdict(checks: dict) -> str:
    if checks.get("source_valid") and checks.get("identity_matches") and checks.get("dates_consistent") and checks.get("numbers_consistent") and checks.get("evidence_fresh"):
        return "VERIFIED"
    if not checks.get("source_valid") or not checks.get("identity_matches"):
        return "REJECTED"
    return "SUSPECT"


def _weight_for_verdict(verdict: str) -> int:
    if verdict == "VERIFIED":
        return 100
    if verdict == "SUSPECT":
        return 50
    return 0


def _clamp_reputation(value: int) -> int:
    if value < 0:
        return 0
    if value > REPUTATION_CAP:
        return REPUTATION_CAP
    return value


def _trunc_div(a: int, b: int) -> int:
    """Integer division truncated toward zero (b > 0). No rounding up,
    no floor surprises on negatives: -15001 // 10000 is -1, not -2."""
    if b <= 0:
        raise ValueError("divisor must be positive")
    q = abs(a) // b
    return q if a >= 0 else -q


def _to_int_dollars(value) -> int:
    """Convert a JSON price (int, float, or formatted string) to whole
    dollars. Floats are truncated, never returned: no float ever
    reaches GenVM calldata."""
    if isinstance(value, bool):
        raise ValueError("not a price")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if "." in text:
            text = text.split(".")[0]
        text = text.strip()
        if text == "" or text == "-":
            raise ValueError("not a price")
        return int(text)
    raise ValueError("not a price")


def _bucket_usd(price_usd: int) -> int:
    return (price_usd // PRICE_BUCKET_USD) * PRICE_BUCKET_USD


def _settle_math(entry_bucket_usd: int, exit_bucket_usd: int, effective_wei: int, stake_wei: int, pool_before_wei: int) -> dict:
    """Pure settlement arithmetic. Returns exactly the 11 fields the
    consensus validation compares. No state is read or written here,
    so local tests can check every branch against these numbers.
    """
    pnl_bps = _trunc_div((exit_bucket_usd - entry_bucket_usd) * 10000, entry_bucket_usd)
    pnl_wei = _trunc_div(effective_wei * pnl_bps, 10000)
    raw_return_wei = stake_wei + pnl_wei
    if raw_return_wei <= 0:
        return_wei = 0
        paid_upside_wei = 0
        capped = raw_return_wei < 0
    elif raw_return_wei <= stake_wei:
        return_wei = raw_return_wei
        paid_upside_wei = 0
        capped = False
    else:
        upside_wei = raw_return_wei - stake_wei
        paid_upside_wei = upside_wei if upside_wei <= pool_before_wei else pool_before_wei
        return_wei = stake_wei + paid_upside_wei
        capped = paid_upside_wei < upside_wei
    pool_after_wei = pool_before_wei + stake_wei - return_wei
    return {
        "entry_bucket_usd": entry_bucket_usd,
        "exit_bucket_usd": exit_bucket_usd,
        "pnl_bps": pnl_bps,
        "pnl_wei": pnl_wei,
        "return_wei": return_wei,
        "paid_upside_wei": paid_upside_wei,
        "pool_before_wei": pool_before_wei,
        "pool_after_wei": pool_after_wei,
        "effective_wei": effective_wei,
        "stake_wei": stake_wei,
        "capped": capped,
    }


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class CopyTrade(gl.Contract):
    traders: TreeMap[str, str]
    trader_ids: DynArray[str]
    audits: TreeMap[str, str]
    audit_ids: DynArray[str]
    copies: TreeMap[str, str]
    copy_ids: DynArray[str]
    credits: TreeMap[str, u256]
    witnesses: TreeMap[str, str]
    witness_ids: DynArray[str]
    next_trader: u256
    next_audit: u256
    next_copy: u256
    next_witness: u256
    total_received: u256
    total_paid_out: u256
    locked_copies: u256
    locked_challenges: u256
    credits_total: u256
    house_pool: u256

    def __init__(self):
        self.next_trader = u256(0)
        self.next_audit = u256(0)
        self.next_copy = u256(0)
        self.next_witness = u256(0)
        self.total_received = u256(0)
        self.total_paid_out = u256(0)
        self.locked_copies = u256(0)
        self.locked_challenges = u256(0)
        self.credits_total = u256(0)
        self.house_pool = u256(0)

    # -- deterministic helpers -------------------------------------------

    def _sender(self) -> str:
        return str(gl.message.sender_address)

    def _load_trader(self, trader_id: str) -> dict:
        raw = self.traders.get(trader_id, "")
        if raw == "":
            raise gl.vm.UserError("EXPECTED: trader_not_found")
        return json.loads(raw)

    def _save_trader(self, trader: dict) -> None:
        self.traders[trader["id"]] = json.dumps(trader)

    def _load_audit(self, audit_id: str) -> dict:
        raw = self.audits.get(audit_id, "")
        if raw == "":
            raise gl.vm.UserError("EXPECTED: audit_not_found")
        return json.loads(raw)

    def _save_audit(self, audit: dict) -> None:
        self.audits[audit["id"]] = json.dumps(audit)

    def _load_copy(self, copy_id: str) -> dict:
        raw = self.copies.get(copy_id, "")
        if raw == "":
            raise gl.vm.UserError("EXPECTED: copy_not_found")
        return json.loads(raw)

    def _save_copy(self, copy: dict) -> None:
        self.copies[copy["id"]] = json.dumps(copy)

    def _credit(self, address: str, amount_wei: int) -> None:
        prev = int(self.credits[address]) if address in self.credits else 0
        self.credits[address] = u256(prev + amount_wei)
        self.credits_total = u256(int(self.credits_total) + amount_wei)

    def _apply_trader_verdict(self, trader: dict, verdict: str) -> None:
        """First finalised verdict sets the trader record; a later
        different verdict is kept as a witness instead."""
        if trader["verdict"] is None:
            trader["verdict"] = verdict
            trader["weight"] = _weight_for_verdict(verdict)
            trader["status"] = "AUDITED_" + verdict
            if verdict == "VERIFIED":
                trader["reputation"] = _clamp_reputation(trader["reputation"] + 10)
            elif verdict == "REJECTED":
                trader["reputation"] = _clamp_reputation(trader["reputation"] - 10)
            self._save_trader(trader)
        elif trader["verdict"] != verdict:
            witness_id = "w" + str(int(self.next_witness))
            self.next_witness = self.next_witness + u256(1)
            witness = {
                "id": witness_id,
                "trader_id": trader["id"],
                "standing_verdict": trader["verdict"],
                "new_verdict": verdict,
            }
            self.witnesses[witness_id] = json.dumps(witness)
            self.witness_ids.append(witness_id)
            trader["witness_count"] = trader["witness_count"] + 1
            self._save_trader(trader)

    # -- price fetch (plain helper; only called inside a nondet
    # evaluate closure, never as its own run_nondet_unsafe, so the
    # settlement evaluate can fetch a price and compute its 11
    # fields in one nondet call without nesting) --------------------

    def _fetch_price(self) -> int:
        """Fetch live BTC/USD from CoinDesk first, CoinGecko second,
        and return the $100 bucket. Raises UserError if every source
        fails. The bucket -- never the exact price, never the source
        -- is what validators agree on."""

        def _fetch_one(url: str):
            try:
                response = gl.nondet.web.get(url)
            except Exception:
                return None
            if getattr(response, "status", 200) != 200:
                return None
            body = response.body
            if isinstance(body, bytes):
                text = body.decode("utf-8")
            else:
                text = str(body)
            try:
                data = json.loads(text)
            except Exception:
                return None
            if not isinstance(data, dict):
                return None
            try:
                if "coindesk" in url:
                    raw = data["bpi"]["USD"]["rate"]
                else:
                    raw = data["bitcoin"]["usd"]
                price = _to_int_dollars(raw)
            except Exception:
                return None
            if price <= 0:
                return None
            return _bucket_usd(price)

        for url in PRICE_SOURCES:
            bucket = _fetch_one(url)
            if bucket is not None:
                return bucket
        raise gl.vm.UserError("EXTERNAL: price_sources_unavailable")

    def _fetch_price_bucket(self):
        """Nondet price fetch for copy_trader: validators agree on
        the $100 bucket only."""

        def evaluate() -> dict:
            return {"bucket_usd": self._fetch_price()}

        def validate(leader_result) -> bool:
            if isinstance(leader_result, gl.vm.UserError):
                try:
                    evaluate()
                except gl.vm.UserError:
                    return True
                except Exception:
                    return False
                return False
            if not isinstance(leader_result, gl.vm.Return):
                return False
            leader = leader_result.calldata
            if not isinstance(leader, dict):
                return False
            try:
                own = evaluate()
            except Exception:
                return False
            return leader.get("bucket_usd") == own.get("bucket_usd")

        return gl.vm.run_nondet_unsafe(evaluate, validate)

    # -- audit evaluation (nondet) ----------------------------------------

    def _evaluate(self, trader: dict):
        """Fetch the evidence record + current UTC date and compute the
        audit result: exactly 11 fields, all validated exactly. Runs
        for the leader and for every validator."""
        evidence_ref = trader["evidence_ref"]
        trader_code = trader["trader_code"]
        name = trader["name"]

        def _fetch_json(url: str, label: str) -> dict:
            try:
                response = gl.nondet.web.get(url)
            except Exception:
                raise gl.vm.UserError(f"EXTERNAL: {label}_fetch_failed")
            if getattr(response, "status", 200) != 200:
                raise gl.vm.UserError(f"EXTERNAL: {label}_status_{getattr(response, 'status', '?')}")
            body = response.body
            if isinstance(body, bytes):
                text = body.decode("utf-8")
            else:
                text = str(body)
            try:
                data = json.loads(text)
            except Exception:
                raise gl.vm.UserError(f"EXTERNAL: {label}_bad_json")
            if not isinstance(data, dict):
                raise gl.vm.UserError(f"EXTERNAL: {label}_not_an_object")
            return data

        def _fetch_json_or_none(url: str):
            try:
                response = gl.nondet.web.get(url)
            except Exception:
                return None
            if getattr(response, "status", 200) != 200:
                return None
            body = response.body
            if isinstance(body, bytes):
                text = body.decode("utf-8")
            else:
                text = str(body)
            try:
                data = json.loads(text)
            except Exception:
                return None
            if not isinstance(data, dict):
                return None
            return data

        def _fetch_audit_date() -> str:
            for url in TIME_URLS:
                data = _fetch_json_or_none(url)
                if data is None:
                    continue
                if "timeapi.io" in url:
                    year = data.get("year")
                    month = data.get("month")
                    day = data.get("day")
                    if not _is_int(year) or not _is_int(month) or not _is_int(day):
                        continue
                    candidate = f"{year:04d}-{month:02d}-{day:02d}"
                else:
                    raw = data.get("datetime")
                    if not isinstance(raw, str) or len(raw) < 10:
                        continue
                    candidate = raw[0:10]
                if _parse_date(candidate) is not None:
                    return candidate
            raise gl.vm.UserError("EXTERNAL: time_fetch_failed")

        def evaluate() -> dict:
            evidence = _fetch_json(evidence_ref, "evidence")
            audit_date = _fetch_audit_date()

            checks = {
                "source_valid": False,
                "identity_matches": False,
                "dates_consistent": False,
                "numbers_consistent": False,
                "evidence_fresh": False,
            }
            window_end = ""
            wins = 0
            total = 0

            required = ("trader_code", "trader_name", "window_start", "window_end", "claimed_win_rate_bps", "claimed_total_return_bps", "trades")
            shape_ok = True
            for field in required:
                if field not in evidence:
                    shape_ok = False
            if shape_ok:
                if not isinstance(evidence["trader_code"], str):
                    shape_ok = False
                if not isinstance(evidence["trader_name"], str):
                    shape_ok = False
                if _parse_date(evidence["window_start"]) is None:
                    shape_ok = False
                if _parse_date(evidence["window_end"]) is None:
                    shape_ok = False
                if not _is_int(evidence["claimed_win_rate_bps"]):
                    shape_ok = False
                if not _is_int(evidence["claimed_total_return_bps"]):
                    shape_ok = False
                if not isinstance(evidence["trades"], list):
                    shape_ok = False
            if not shape_ok:
                raise gl.vm.UserError("EXTERNAL: evidence_bad_shape")
            checks["source_valid"] = True
            window_end = evidence["window_end"]

            if evidence["trader_code"] == trader_code and evidence["trader_name"] == name:
                checks["identity_matches"] = True

            trades = evidence["trades"]
            dates_ok = True
            numbers_ok = True
            start_days = _date_diff_days(evidence["window_end"], evidence["window_start"])
            if start_days is None or start_days < 0:
                dates_ok = False
            if len(trades) < MIN_TRADES:
                numbers_ok = False
            wins = 0
            total = 0
            seen_ids = []
            max_date = ""
            for trade in trades:
                if not isinstance(trade, dict):
                    dates_ok = False
                    numbers_ok = False
                    continue
                trade_id = trade.get("id")
                trade_date = trade.get("date")
                pnl = trade.get("pnl_bps")
                if not isinstance(trade_id, str) or trade_id == "":
                    numbers_ok = False
                elif trade_id in seen_ids:
                    numbers_ok = False
                else:
                    seen_ids.append(trade_id)
                if _parse_date(trade_date) is None:
                    dates_ok = False
                else:
                    if trade_date < evidence["window_start"] or trade_date > evidence["window_end"]:
                        dates_ok = False
                    if trade_date > max_date:
                        max_date = trade_date
                if not _is_int(pnl):
                    numbers_ok = False
                else:
                    if pnl < -MAX_TRADE_PNL_BPS or pnl > MAX_TRADE_PNL_BPS:
                        numbers_ok = False
                    total += pnl
                    if pnl > 0:
                        wins += 1
            if max_date != window_end:
                dates_ok = False
            claimed_win = evidence["claimed_win_rate_bps"]
            claimed_total = evidence["claimed_total_return_bps"]
            if claimed_win < 0 or claimed_win > 10000:
                numbers_ok = False
            elif wins * 10000 != claimed_win * len(trades):
                numbers_ok = False
            if total != claimed_total:
                numbers_ok = False
            checks["dates_consistent"] = dates_ok
            checks["numbers_consistent"] = numbers_ok

            age = _date_diff_days(audit_date, window_end)
            if age is not None and 0 <= age <= MAX_EVIDENCE_AGE_DAYS:
                checks["evidence_fresh"] = True

            verdict = _derive_verdict(checks)
            return {
                "verdict": verdict,
                "check_source_valid": checks["source_valid"],
                "check_identity_matches": checks["identity_matches"],
                "check_dates_consistent": checks["dates_consistent"],
                "check_numbers_consistent": checks["numbers_consistent"],
                "check_evidence_fresh": checks["evidence_fresh"],
                "evidence_end_date": window_end,
                "audit_date": audit_date,
                "wins": wins,
                "trade_count": len(trades),
                "total_return_bps": total,
            }

        def validate(leader_result) -> bool:
            if isinstance(leader_result, gl.vm.UserError):
                try:
                    evaluate()
                except gl.vm.UserError:
                    return True
                except Exception:
                    return False
                return False
            if not isinstance(leader_result, gl.vm.Return):
                return False
            leader = leader_result.calldata
            if not isinstance(leader, dict):
                return False
            try:
                own = evaluate()
            except Exception:
                return False
            for field in ("verdict", "evidence_end_date", "audit_date", "wins", "trade_count", "total_return_bps"):
                if leader.get(field) != own.get(field):
                    return False
            for key in ("check_source_valid", "check_identity_matches", "check_dates_consistent", "check_numbers_consistent", "check_evidence_fresh"):
                if leader.get(key) != own.get(key):
                    return False
            leader_checks = {
                "source_valid": leader.get("check_source_valid"),
                "identity_matches": leader.get("check_identity_matches"),
                "dates_consistent": leader.get("check_dates_consistent"),
                "numbers_consistent": leader.get("check_numbers_consistent"),
                "evidence_fresh": leader.get("check_evidence_fresh"),
            }
            if leader.get("verdict") != _derive_verdict(leader_checks):
                return False
            return True

        return gl.vm.run_nondet_unsafe(evaluate, validate)

    # -- writes ------------------------------------------------------------

    @gl.public.write
    def register_trader(self, name: str, trader_code: str, evidence_ref: str) -> str:
        if not isinstance(name, str) or len(name) == 0 or len(name) > 80:
            raise gl.vm.UserError("EXPECTED: name_must_be_1_to_80_chars")
        if not isinstance(trader_code, str) or len(trader_code) < 1 or len(trader_code) > 24:
            raise gl.vm.UserError("EXPECTED: trader_code_must_be_1_to_24_chars")
        for ch in trader_code:
            if not ((ch >= "A" and ch <= "Z") or (ch >= "0" and ch <= "9") or ch == "-"):
                raise gl.vm.UserError("EXPECTED: trader_code_must_be_AZ09_dash")
        if not isinstance(evidence_ref, str) or len(evidence_ref) > 500:
            raise gl.vm.UserError("EXPECTED: evidence_ref_too_long")
        if not evidence_ref.startswith("https://"):
            raise gl.vm.UserError("EXPECTED: evidence_ref_must_be_https")
        sender = self._sender()
        trader_id = "t" + str(int(self.next_trader))
        self.next_trader = self.next_trader + u256(1)
        trader = {
            "id": trader_id,
            "name": name,
            "trader_code": trader_code,
            "evidence_ref": evidence_ref,
            "registrar": sender,
            "status": "REGISTERED",
            "verdict": None,
            "weight": 0,
            "reputation": REPUTATION_START,
            "followers": 0,
            "open_copies": 0,
            "total_copied_wei": 0,
            "settled_copies": 0,
            "witness_count": 0,
        }
        self.traders[trader_id] = json.dumps(trader)
        self.trader_ids.append(trader_id)
        return trader_id

    @gl.public.write
    def audit_trader(self, trader_id: str) -> str:
        trader = self._load_trader(trader_id)
        sender = self._sender()
        result = self._evaluate(trader)
        audit_id = "a" + str(int(self.next_audit))
        self.next_audit = self.next_audit + u256(1)
        audit = {
            "id": audit_id,
            "trader_id": trader_id,
            "requester": sender,
            "status": "PENDING",
            "round1": result,
            "round2": None,
            "challenger": None,
            "challenge_reason": None,
            "challenge_outcome": None,
            "challenge_stake_wei": 0,
        }
        self.audits[audit_id] = json.dumps(audit)
        self.audit_ids.append(audit_id)
        return audit_id

    @gl.public.write.payable
    def challenge_audit(self, audit_id: str, reason: str) -> str:
        v = gl.message.value
        if v != u256(CHALLENGE_WEI):
            raise gl.vm.UserError("EXPECTED: challenge_stake_must_be_2_gen")
        audit = self._load_audit(audit_id)
        if audit["status"] != "PENDING":
            raise gl.vm.UserError("EXPECTED: audit_not_challengeable")
        if not isinstance(reason, str) or len(reason) < 1 or len(reason) > 200:
            raise gl.vm.UserError("EXPECTED: reason_must_be_1_to_200_chars")
        sender = self._sender()
        if sender == audit["requester"]:
            raise gl.vm.UserError("EXPECTED: requester_cannot_challenge_own_audit")
        self.total_received = u256(int(self.total_received) + int(v))
        self.locked_challenges = u256(int(self.locked_challenges) + int(v))
        audit["status"] = "CHALLENGED"
        audit["challenger"] = sender
        audit["challenge_reason"] = reason
        audit["challenge_stake_wei"] = int(v)
        self._save_audit(audit)
        return audit_id

    @gl.public.write
    def finalize_audit(self, audit_id: str) -> str:
        audit = self._load_audit(audit_id)
        if audit["status"] not in ("PENDING", "CHALLENGED"):
            raise gl.vm.UserError("EXPECTED: audit_already_closed")
        trader = self._load_trader(audit["trader_id"])
        if audit["status"] == "CHALLENGED":
            result2 = self._evaluate(trader)
            audit["round2"] = result2
            verdict = result2["verdict"]
            stake = int(audit["challenge_stake_wei"])
            self.locked_challenges = u256(int(self.locked_challenges) - stake)
            if verdict == audit["round1"]["verdict"]:
                audit["challenge_outcome"] = "CHALLENGE_FAILED"
                self.house_pool = u256(int(self.house_pool) + stake)
            else:
                audit["challenge_outcome"] = "CHALLENGE_SUCCEEDED"
                reward = CHALLENGE_REWARD_WEI if int(self.house_pool) >= CHALLENGE_REWARD_WEI else int(self.house_pool)
                self.house_pool = u256(int(self.house_pool) - reward)
                self._credit(audit["challenger"], stake + reward)
        else:
            verdict = audit["round1"]["verdict"]
        audit["status"] = "CLOSED"
        self._save_audit(audit)
        self._apply_trader_verdict(trader, verdict)
        return audit_id

    @gl.public.write.payable
    def copy_trader(self, trader_id: str) -> str:
        v = gl.message.value
        if v != u256(STAKE_WEI):
            raise gl.vm.UserError("EXPECTED: copy_stake_must_be_5_gen")
        trader = self._load_trader(trader_id)
        if trader["verdict"] is None:
            raise gl.vm.UserError("EXPECTED: trader_not_audited_yet")
        weight = trader["weight"]
        if weight <= 0:
            raise gl.vm.UserError("EXPECTED: rejected_trader_cannot_be_copied")
        sender = self._sender()
        price = self._fetch_price_bucket()
        entry_bucket = int(price["bucket_usd"])
        stake = int(v)
        effective = stake * weight // 100
        self.total_received = u256(int(self.total_received) + stake)
        self.locked_copies = u256(int(self.locked_copies) + stake)
        copy_id = "c" + str(int(self.next_copy))
        self.next_copy = self.next_copy + u256(1)
        copy = {
            "id": copy_id,
            "follower": sender,
            "trader_id": trader_id,
            "stake_wei": stake,
            "weight": weight,
            "effective_wei": effective,
            "entry_bucket_usd": entry_bucket,
            "status": "OPEN",
            "exit_bucket_usd": None,
            "pnl_bps": None,
            "pnl_wei": None,
            "return_wei": None,
            "capped": None,
        }
        self.copies[copy_id] = json.dumps(copy)
        self.copy_ids.append(copy_id)
        trader["followers"] = trader["followers"] + 1
        trader["open_copies"] = trader["open_copies"] + 1
        trader["total_copied_wei"] = trader["total_copied_wei"] + effective
        self._save_trader(trader)
        return copy_id

    @gl.public.write
    def settle_copy(self, copy_id: str) -> str:
        copy = self._load_copy(copy_id)
        if copy["status"] != "OPEN":
            raise gl.vm.UserError("EXPECTED: copy_not_open")
        sender = self._sender()
        if sender != copy["follower"]:
            raise gl.vm.UserError("EXPECTED: only_copy_owner_can_settle")
        entry_bucket = int(copy["entry_bucket_usd"])
        effective = int(copy["effective_wei"])
        stake = int(copy["stake_wei"])
        pool_before = int(self.house_pool)

        def evaluate() -> dict:
            exit_bucket = self._fetch_price()
            return _settle_math(entry_bucket, exit_bucket, effective, stake, pool_before)

        def validate(leader_result) -> bool:
            if isinstance(leader_result, gl.vm.UserError):
                try:
                    evaluate()
                except gl.vm.UserError:
                    return True
                except Exception:
                    return False
                return False
            if not isinstance(leader_result, gl.vm.Return):
                return False
            leader = leader_result.calldata
            if not isinstance(leader, dict):
                return False
            try:
                own = evaluate()
            except Exception:
                return False
            for field in ("entry_bucket_usd", "exit_bucket_usd", "pnl_bps", "pnl_wei", "return_wei", "paid_upside_wei", "pool_before_wei", "pool_after_wei", "effective_wei", "stake_wei", "capped"):
                if leader.get(field) != own.get(field):
                    return False
            return True

        result = gl.vm.run_nondet_unsafe(evaluate, validate)
        copy["status"] = "SETTLED"
        copy["exit_bucket_usd"] = result["exit_bucket_usd"]
        copy["pnl_bps"] = result["pnl_bps"]
        copy["pnl_wei"] = result["pnl_wei"]
        copy["return_wei"] = result["return_wei"]
        copy["capped"] = result["capped"]
        self._save_copy(copy)
        self.locked_copies = u256(int(self.locked_copies) - stake)
        self.house_pool = u256(int(result["pool_after_wei"]))
        if int(result["return_wei"]) > 0:
            self._credit(sender, int(result["return_wei"]))
        trader = self._load_trader(copy["trader_id"])
        trader["open_copies"] = trader["open_copies"] - 1
        trader["settled_copies"] = trader["settled_copies"] + 1
        self._save_trader(trader)
        return copy_id

    @gl.public.write
    def cancel_copy(self, copy_id: str) -> str:
        copy = self._load_copy(copy_id)
        if copy["status"] != "OPEN":
            raise gl.vm.UserError("EXPECTED: copy_not_open")
        sender = self._sender()
        if sender != copy["follower"]:
            raise gl.vm.UserError("EXPECTED: only_copy_owner_can_cancel")
        stake = int(copy["stake_wei"])
        copy["status"] = "CANCELLED"
        copy["return_wei"] = stake
        self._save_copy(copy)
        self.locked_copies = u256(int(self.locked_copies) - stake)
        self._credit(sender, stake)
        trader = self._load_trader(copy["trader_id"])
        trader["open_copies"] = trader["open_copies"] - 1
        self._save_trader(trader)
        return copy_id

    @gl.public.write
    def withdraw_payout(self) -> str:
        sender = self._sender()
        amount = int(self.credits[sender]) if sender in self.credits else 0
        if amount == 0:
            raise gl.vm.UserError("EXPECTED: no_credit")
        self.credits[sender] = u256(0)
        self.credits_total = u256(int(self.credits_total) - amount)
        self.total_paid_out = u256(int(self.total_paid_out) + amount)
        _Recipient(Address(sender)).emit_transfer(value=u256(amount))
        return json.dumps({"sender": sender, "withdrawn_wei": amount, "total_paid_out_wei": int(self.total_paid_out)})

    # -- views -------------------------------------------------------------

    @gl.public.view
    def get_trader(self, trader_id: str) -> str:
        return json.dumps(self._load_trader(trader_id))

    @gl.public.view
    def get_audit(self, audit_id: str) -> str:
        return json.dumps(self._load_audit(audit_id))

    @gl.public.view
    def get_copy(self, copy_id: str) -> str:
        return json.dumps(self._load_copy(copy_id))

    @gl.public.view
    def get_credit(self, addr: str) -> u256:
        if addr in self.credits:
            return self.credits[addr]
        return u256(0)

    @gl.public.view
    def get_totals(self) -> str:
        total_in = int(self.total_received)
        accounted = int(self.total_paid_out) + int(self.locked_copies) + int(self.locked_challenges) + int(self.credits_total) + int(self.house_pool)
        return json.dumps({
            "total_received_wei": total_in,
            "total_paid_out_wei": int(self.total_paid_out),
            "contract_balance_wei": int(self.balance),
            "locked_copies_wei": int(self.locked_copies),
            "locked_challenges_wei": int(self.locked_challenges),
            "credits_total_wei": int(self.credits_total),
            "house_pool_wei": int(self.house_pool),
            "accounted_wei": accounted,
            "invariant_ok": total_in == accounted,
            "balance_matches_wei": int(self.balance) == total_in - int(self.total_paid_out),
        })

    @gl.public.view
    def get_counts(self) -> str:
        return json.dumps({
            "traders": len(self.trader_ids),
            "audits": len(self.audit_ids),
            "copies": len(self.copy_ids),
            "witnesses": len(self.witness_ids),
        })

    @gl.public.view
    def list_traders(self, offset: u256, limit: u256) -> str:
        if limit < 1 or limit > 20:
            raise gl.vm.UserError("EXPECTED: limit_must_be_1_to_20")
        total = len(self.trader_ids)
        start = int(offset)
        if start >= total:
            return json.dumps([])
        end = start + int(limit)
        if end > total:
            end = total
        out = []
        index = start
        while index < end:
            out.append(json.loads(self.traders[self.trader_ids[index]]))
            index += 1
        return json.dumps(out)

    @gl.public.view
    def list_audits(self, offset: u256, limit: u256) -> str:
        if limit < 1 or limit > 20:
            raise gl.vm.UserError("EXPECTED: limit_must_be_1_to_20")
        total = len(self.audit_ids)
        start = int(offset)
        if start >= total:
            return json.dumps([])
        end = start + int(limit)
        if end > total:
            end = total
        out = []
        index = start
        while index < end:
            out.append(json.loads(self.audits[self.audit_ids[index]]))
            index += 1
        return json.dumps(out)

    @gl.public.view
    def list_copies(self, offset: u256, limit: u256) -> str:
        if limit < 1 or limit > 20:
            raise gl.vm.UserError("EXPECTED: limit_must_be_1_to_20")
        total = len(self.copy_ids)
        start = int(offset)
        if start >= total:
            return json.dumps([])
        end = start + int(limit)
        if end > total:
            end = total
        out = []
        index = start
        while index < end:
            out.append(json.loads(self.copies[self.copy_ids[index]]))
            index += 1
        return json.dumps(out)

    @gl.public.view
    def list_witnesses(self, offset: u256, limit: u256) -> str:
        if limit < 1 or limit > 20:
            raise gl.vm.UserError("EXPECTED: limit_must_be_1_to_20")
        total = len(self.witness_ids)
        start = int(offset)
        if start >= total:
            return json.dumps([])
        end = start + int(limit)
        if end > total:
            end = total
        out = []
        index = start
        while index < end:
            out.append(json.loads(self.witnesses[self.witness_ids[index]]))
            index += 1
        return json.dumps(out)
