# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""CopyTrade: people-centred social copy-trading on GenLayer.

A trader publishes a track record as JSON at a public URL. Validators
independently fetch that record and audit it: is the source valid,
does it match the registered trader identity, are the dates
consistent, do the claimed numbers recompute exactly, and is the
record fresh? The audit returns VERIFIED / SUSPECT / REJECTED, and
the verdict sets the copy weight (1.0x / 0.5x / 0x). Copying moves
simulated mGEN on an in-contract ledger only. There is no real
trading, no real GEN custody, and no exchange execution.

Consensus design (the part that matters)
----------------------------------------
* There are no scores and no tolerance bands in the audit path. The
  nondet function computes five binary checks in pure Python from
  the fetched record, and the verdict is a deterministic table over
  those checks. A validator accepts the leader result only if every
  field — verdict, all five checks, evidence end date, audit date,
  recomputed win rate and recomputed total return — is EXACTLY equal
  to its own independent recomputation, and the leader's verdict
  equals the table verdict for its own checks. Two different
  validator-compatible leader outputs cannot exist: any difference
  in any field fails validation and nothing is stored. The maximum
  spread between two passing leader outputs on every stored core
  value is zero. See docs/mechanism.md for the worst-case table.
* Numbers are exact integers. Win rate and total return must
  recompute to the claimed values with integer equality — a claim
  off by 1 basis point fails the numbers check. Settlement divides
  exactly by construction (allocation is a multiple of 100,
  pnl_bps a multiple of 100), so there is no rounding anywhere.
* Staleness is checked, not ignored: the audit date is the current
  UTC date fetched from a public time source by leader and
  validators alike, and a record older than 90 days can never be
  VERIFIED. If leader and validators fetch different dates (a
  midnight crossing), validation fails and the audit stays pending.
* A failed audit writes nothing. A FINALIZED verdict is immutable:
  a later audit that disagrees is kept as a witness, the standing
  verdict never changes.
* A challenge forces a second evaluation before finalisation. The
  challenge succeeds iff the second verdict differs from the first.
"""

import json

from genlayer import *

TIME_URLS = (
    "https://timeapi.io/api/time/current/zone?timeZone=UTC",
    "https://worldtimeapi.org/api/timezone/Etc/UTC",
)
MAX_EVIDENCE_AGE_DAYS = 90
MIN_TRADES = 5
MAX_TRADE_PNL_BPS = 5000
DEMO_FUNDS = 10000
REPUTATION_START = 100
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


class CopyTrade(gl.Contract):
    traders: TreeMap[str, str]
    trader_ids: DynArray[str]
    audits: TreeMap[str, str]
    audit_ids: DynArray[str]
    copies: TreeMap[str, str]
    copy_ids: DynArray[str]
    accounts: TreeMap[str, str]
    witnesses: TreeMap[str, str]
    witness_ids: DynArray[str]
    next_trader: u256
    next_audit: u256
    next_copy: u256
    next_witness: u256

    def __init__(self):
        self.next_trader = u256(0)
        self.next_audit = u256(0)
        self.next_copy = u256(0)
        self.next_witness = u256(0)

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

    def _ensure_account(self, address: str) -> dict:
        raw = self.accounts.get(address, "")
        if raw == "":
            account = {
                "address": address,
                "balance": 0,
                "claimed_demo": False,
                "reputation": REPUTATION_START,
            }
            self.accounts[address] = json.dumps(account)
            return account
        return json.loads(raw)

    def _save_account(self, account: dict) -> None:
        self.accounts[account["address"]] = json.dumps(account)

    def _adjust_trader_reputation(self, trader: dict, delta: int) -> None:
        trader["reputation"] = _clamp_reputation(trader["reputation"] + delta)

    # -- audit evaluation (nondet, shared by audit + finalize) ----------

    def _evaluate(self, trader: dict):
        """Fetch the evidence record + current UTC date and compute the
        audit result. Runs for the leader and for every validator."""
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
            # Current UTC date from a public time source. timeapi.io is
            # tried first, worldtimeapi.org second; the first source
            # that answers wins. Leader and validators run the same
            # order, and the exact-match rule rejects any disagreement
            # on the resulting date, so a source outage can only leave
            # the audit pending, never store a wrong date.
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

            # (1) source_valid: required fields, right shapes.
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

            # (2) identity_matches: exact string equality.
            if evidence["trader_code"] == trader_code and evidence["trader_name"] == name:
                checks["identity_matches"] = True

            # (3) dates_consistent + (4) numbers_consistent.
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

            # (5) evidence_fresh: age in whole days, 0..90.
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
                "evidence_ref": evidence_ref,
                "trader_code": trader_code,
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
            # Exact match on every field. No tolerance anywhere.
            for field in ("verdict", "evidence_end_date", "audit_date", "wins", "trade_count", "total_return_bps", "evidence_ref", "trader_code"):
                if leader.get(field) != own.get(field):
                    return False
            for key in ("check_source_valid", "check_identity_matches", "check_dates_consistent", "check_numbers_consistent", "check_evidence_fresh"):
                if leader.get(key) != own.get(key):
                    return False
            # The leader's verdict must equal the table verdict for its
            # own checks; a verdict that contradicts its checks is out.
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
        self._ensure_account(sender)
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
            "total_copied": 0,
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
        self._ensure_account(sender)
        result = self._evaluate(trader)
        audit_id = "a" + str(int(self.next_audit))
        self.next_audit = self.next_audit + u256(1)
        audit = {
            "id": audit_id,
            "trader_id": trader_id,
            "requester": sender,
            "status": "EVALUATING",
            "round1": result,
            "round2": None,
            "challenger": None,
            "challenge_reason": None,
            "challenge_outcome": None,
        }
        self.audits[audit_id] = json.dumps(audit)
        self.audit_ids.append(audit_id)
        return audit_id

    @gl.public.write
    def challenge_audit(self, audit_id: str, reason: str) -> str:
        audit = self._load_audit(audit_id)
        if audit["status"] != "EVALUATING":
            raise gl.vm.UserError("EXPECTED: audit_not_challengeable")
        if not isinstance(reason, str) or len(reason) < 1 or len(reason) > 200:
            raise gl.vm.UserError("EXPECTED: reason_must_be_1_to_200_chars")
        sender = self._sender()
        if sender == audit["requester"]:
            raise gl.vm.UserError("EXPECTED: requester_cannot_challenge_own_audit")
        self._ensure_account(sender)
        audit["status"] = "CHALLENGED"
        audit["challenger"] = sender
        audit["challenge_reason"] = reason
        self._save_audit(audit)
        return audit_id

    @gl.public.write
    def finalize_audit(self, audit_id: str) -> str:
        audit = self._load_audit(audit_id)
        if audit["status"] not in ("EVALUATING", "CHALLENGED"):
            raise gl.vm.UserError("EXPECTED: audit_already_finalized")
        trader = self._load_trader(audit["trader_id"])
        sender = self._sender()
        self._ensure_account(sender)
        if audit["status"] == "CHALLENGED":
            result2 = self._evaluate(trader)
            audit["round2"] = result2
            verdict = result2["verdict"]
            if verdict == audit["round1"]["verdict"]:
                audit["challenge_outcome"] = "CHALLENGE_FAILED"
                challenger = self._ensure_account(audit["challenger"])
                challenger["reputation"] = _clamp_reputation(challenger["reputation"] - 5)
                self._save_account(challenger)
            else:
                audit["challenge_outcome"] = "CHALLENGE_SUCCEEDED"
                challenger = self._ensure_account(audit["challenger"])
                challenger["reputation"] = _clamp_reputation(challenger["reputation"] + 5)
                self._save_account(challenger)
        else:
            verdict = audit["round1"]["verdict"]
        audit["status"] = "FINALIZED"
        self._save_audit(audit)
        if trader["verdict"] is None:
            trader["verdict"] = verdict
            trader["weight"] = _weight_for_verdict(verdict)
            trader["status"] = "AUDITED_" + verdict
            if verdict == "VERIFIED":
                self._adjust_trader_reputation(trader, 10)
            elif verdict == "REJECTED":
                self._adjust_trader_reputation(trader, -10)
            self._save_trader(trader)
        elif trader["verdict"] != verdict:
            witness_id = "w" + str(int(self.next_witness))
            self.next_witness = self.next_witness + u256(1)
            witness = {
                "id": witness_id,
                "trader_id": trader["id"],
                "audit_id": audit_id,
                "standing_verdict": trader["verdict"],
                "new_verdict": verdict,
                "evidence_end_date": audit["round2"]["evidence_end_date"] if audit["round2"] is not None else audit["round1"]["evidence_end_date"],
                "audit_date": audit["round2"]["audit_date"] if audit["round2"] is not None else audit["round1"]["audit_date"],
            }
            self.witnesses[witness_id] = json.dumps(witness)
            self.witness_ids.append(witness_id)
            trader["witness_count"] = trader["witness_count"] + 1
            self._save_trader(trader)
        return audit_id

    @gl.public.write
    def claim_demo_funds(self) -> str:
        sender = self._sender()
        account = self._ensure_account(sender)
        if account["claimed_demo"]:
            raise gl.vm.UserError("EXPECTED: demo_funds_already_claimed")
        account["balance"] = account["balance"] + DEMO_FUNDS
        account["claimed_demo"] = True
        self._save_account(account)
        return json.dumps(account)

    @gl.public.write
    def follow_trader(self, trader_id: str, allocation: u256) -> str:
        allocation = int(allocation)
        if allocation <= 0 or allocation % 100 != 0:
            raise gl.vm.UserError("EXPECTED: allocation_must_be_positive_multiple_of_100")
        trader = self._load_trader(trader_id)
        if trader["verdict"] is None:
            raise gl.vm.UserError("EXPECTED: trader_not_audited_yet")
        weight = trader["weight"]
        if weight <= 0:
            raise gl.vm.UserError("EXPECTED: rejected_trader_cannot_be_followed")
        sender = self._sender()
        account = self._ensure_account(sender)
        if account["balance"] < allocation:
            raise gl.vm.UserError("EXPECTED: insufficient_demo_balance")
        effective = allocation * weight // 100
        account["balance"] = account["balance"] - allocation
        self._save_account(account)
        copy_id = "c" + str(int(self.next_copy))
        self.next_copy = self.next_copy + u256(1)
        copy = {
            "id": copy_id,
            "follower": sender,
            "trader_id": trader_id,
            "allocation": allocation,
            "weight": weight,
            "effective": effective,
            "status": "OPEN",
            "pnl_bps": None,
            "pnl": None,
            "settled_value": None,
        }
        self.copies[copy_id] = json.dumps(copy)
        self.copy_ids.append(copy_id)
        trader["followers"] = trader["followers"] + 1
        trader["total_copied"] = trader["total_copied"] + effective
        self._save_trader(trader)
        return copy_id

    @gl.public.write
    def settle_copy(self, copy_id: str, pnl_bps: i256) -> str:
        pnl_bps = int(pnl_bps)
        if pnl_bps < -10000 or pnl_bps > 10000 or pnl_bps % 100 != 0:
            raise gl.vm.UserError("EXPECTED: pnl_bps_must_be_multiple_of_100_in_range")
        copy = self._load_copy(copy_id)
        if copy["status"] != "OPEN":
            raise gl.vm.UserError("EXPECTED: copy_already_settled")
        sender = self._sender()
        if sender != copy["follower"]:
            raise gl.vm.UserError("EXPECTED: only_copy_owner_can_settle")
        trader = self._load_trader(copy["trader_id"])
        if trader["verdict"] != "VERIFIED":
            raise gl.vm.UserError("EXPECTED: only_verified_trader_copies_settle")
        effective = copy["effective"]
        pnl = effective * pnl_bps // 10000
        account = self._ensure_account(sender)
        account["balance"] = account["balance"] + effective + pnl
        self._save_account(account)
        copy["status"] = "SETTLED"
        copy["pnl_bps"] = pnl_bps
        copy["pnl"] = pnl
        copy["settled_value"] = effective + pnl
        self._save_copy(copy)
        if pnl > 0:
            self._adjust_trader_reputation(trader, 1)
        elif pnl < 0:
            self._adjust_trader_reputation(trader, -1)
        trader["settled_copies"] = trader["settled_copies"] + 1
        self._save_trader(trader)
        return copy_id

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
    def get_account(self, address: str) -> str:
        raw = self.accounts.get(address, "")
        if raw == "":
            return json.dumps({"address": address, "balance": 0, "claimed_demo": False, "reputation": REPUTATION_START})
        return raw

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
