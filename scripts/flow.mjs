/* End-to-end on-chain flow against an already-deployed CopyTrade contract.
 *
 * NOTE (2026-11-09): this script ran as phase 1 and STOPPED at the Dana
 * close — the evidence file was corrected 999 -> 300 and curl saw 300,
 * but every validator still fetched the stale 999 (evidence CDN cache),
 * so round2 closed SUSPECT and the challenge failed. The run then
 * continued in scripts/flow-resume.mjs (fresh accounts D/E/F, Dana
 * re-audit for the witness path, Eli as the challenge-success case
 * with an 11-minute cache wait plus a probe audit). Do not re-run this
 * file against the live contract expecting the same IDs; the resume
 * script is the record of what actually happened.
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... node scripts/flow.mjs
 *
 * Three ephemeral accounts (Studionet is gasless; each is funded with
 * 10000 GEN from the faucet interface sim_fundAccount): A registers /
 * audits / follows, B challenges, C follows then cancels. No key is
 * ever written to disk.
 *
 * Money flow (all real testnet GEN, 1 GEN = 10^18 wei):
 *   - copy stake is exactly 5 GEN per copy; challenge stake exactly
 *     2 GEN; successful-challenge reward 0.75 GEN from the house pool.
 *   - Ava (VERIFIED) -> register, audit, close; A copies 5 GEN, settles
 *     on the live BTC price bucket.
 *   - Ben (stale record -> SUSPECT) -> register, audit, challenged by B,
 *     second evaluation agrees: challenge fails, B's 2 GEN go to the
 *     house pool; A copies 5 GEN at 0.5x and settles; C copies 5 GEN
 *     and cancels for a full 5 GEN refund.
 *   - Dana (numbers wrong -> SUSPECT) -> register, audit, challenged by
 *     B; the evidence file is corrected in the repo between challenge
 *     and close, so the second evaluation returns VERIFIED: challenge
 *     succeeds, B is refunded 2 GEN + 0.75 GEN reward from the pool.
 *   - Cara (identity mismatch -> REJECTED) -> register, audit, close;
 *     a copy attempt against her is rejected on-chain (negative case:
 *     no copy is created, no GEN moves).
 * Every tx is waited to FINALIZED and every state change is read back.
 * Nondet calls (audit / copy / settle / challenged close) are retried
 * when consensus fails on a price-bucket or date boundary: a failed
 * attempt writes nothing, so retrying is safe.
 * Writes evidence.json (tx hashes, final status, read-backs, GEN
 * reconciliation).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address: set CONTRACT_ADDRESS or run deploy first");

const GEN = 10n ** 18n;
const FUND_GEN = 10000;
const accountA = createAccount(generatePrivateKey());
const accountB = createAccount(generatePrivateKey());
const accountC = createAccount(generatePrivateKey());
console.log("Flow account A (registrar/auditor/follower):", accountA.address);
console.log("Flow account B (challenger):", accountB.address);
console.log("Flow account C (follower, cancels):", accountC.address);
console.log("Contract:", address);

const clientA = createClient({ chain: studionet, account: accountA });
const clientB = createClient({ chain: studionet, account: accountB });
const clientC = createClient({ chain: studionet, account: accountC });

const STATUS_NAMES = { 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" };
const eoaBalance = async (client, addr) => (await client.getBalance({ address: addr })).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFinal(client, hash, label) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    retries: 240,
    interval: 5000,
  });
  const status = receipt.statusName ?? STATUS_NAMES[receipt.status] ?? String(receipt.status ?? "");
  console.log(`${label} tx: ${hash} -> ${status}`);
  if (status !== "FINALIZED") throw new Error(`${label} did not finalize: ${status}`);
  return { hash, status };
}

async function writeOnce(client, functionName, args, value, label) {
  const hash = await client.writeContract({ address, functionName, args, value, leaderOnly: false });
  return waitFinal(client, hash, label);
}

/* Write with consensus retries: a nondet attempt that fails validation
 * writes nothing, so it is safe to resubmit until the read-back check
 * passes. checkFn must return true only when the intended state is
 * visible on-chain. */
async function writeChecked(client, functionName, args, value, label, checkFn, maxAttempts = 5) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await writeOnce(client, functionName, args, value, `${label} (attempt ${attempt})`);
      if (await checkFn()) return res;
      console.log(`  ${label}: read-back check not met after attempt ${attempt}, retrying...`);
    } catch (e) {
      lastErr = e;
      console.log(`  ${label}: attempt ${attempt} failed: ${String(e).slice(0, 300)}`);
    }
    await sleep(5000);
  }
  throw new Error(`${label}: did not reach expected state after ${maxAttempts} attempts: ${String(lastErr).slice(0, 500)}`);
}

async function read(client, functionName, args) {
  const raw = await client.readContract({ address, functionName, args });
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  check ${label}: ${JSON.stringify(actual)}`);
}

const txs = {};
const REPO = "https://raw.githubusercontent.com/xiaoyu7799/copytrade-social-genlayer/main/evidence";

// --- fund all three accounts with 10000 GEN each --------------------------
const funded = {};
for (const [name, client, account] of [["A", clientA, accountA], ["B", clientB, accountB], ["C", clientC, accountC]]) {
  const fundTx = await client.request({ method: "sim_fundAccount", params: [account.address, FUND_GEN * 10 ** 18] });
  funded[name] = { fundTx: String(fundTx), balanceWei: await eoaBalance(client, account.address) };
  console.log(`Funded ${name}:`, funded[name].balanceWei, "wei");
  assertEq(`account ${name} funded 10000 GEN`, funded[name].balanceWei, (BigInt(FUND_GEN) * GEN).toString());
}

// --- Ava: fresh, consistent record -> VERIFIED ------------------------------
txs.registerAva = await writeOnce(clientA, "register_trader", ["Ava Chen", "AVA-001", `${REPO}/trader-ava.json`], 0n, "register Ava");
txs.auditAva = await writeChecked(clientA, "audit_trader", ["t0"], 0n, "audit Ava",
  async () => (await read(clientA, "get_audit", ["a0"]))?.round1?.verdict === "VERIFIED");
let auditAva = await read(clientA, "get_audit", ["a0"]);
assertEq("audit a0 status", auditAva.status, "PENDING");
assertEq("audit a0 round1 verdict", auditAva.round1.verdict, "VERIFIED");
assertEq("audit a0 round1 wins", auditAva.round1.wins, 7);
assertEq("audit a0 round1 trade_count", auditAva.round1.trade_count, 10);
assertEq("audit a0 round1 total_return_bps", auditAva.round1.total_return_bps, 1390);
assertEq("audit a0 result fields", Object.keys(auditAva.round1).length, 11);
txs.finalizeAva = await writeChecked(clientA, "finalize_audit", ["a0"], 0n, "close Ava audit",
  async () => (await read(clientA, "get_audit", ["a0"]))?.status === "CLOSED");
let traderAva = await read(clientA, "get_trader", ["t0"]);
assertEq("trader t0 verdict", traderAva.verdict, "VERIFIED");
assertEq("trader t0 status", traderAva.status, "AUDITED_VERIFIED");
assertEq("trader t0 weight", traderAva.weight, 100);
assertEq("trader t0 reputation", traderAva.reputation, 10);

// --- Ben: stale record (91 days) -> SUSPECT, challenged, challenge fails ---
txs.registerBen = await writeOnce(clientA, "register_trader", ["Ben Okafor", "BEN-002", `${REPO}/trader-ben.json`], 0n, "register Ben");
txs.auditBen = await writeChecked(clientA, "audit_trader", ["t1"], 0n, "audit Ben",
  async () => (await read(clientA, "get_audit", ["a1"]))?.round1?.verdict === "SUSPECT");
let auditBen = await read(clientA, "get_audit", ["a1"]);
assertEq("audit a1 round1 verdict", auditBen.round1.verdict, "SUSPECT");
assertEq("audit a1 round1 fresh check", auditBen.round1.check_evidence_fresh, false);
assertEq("audit a1 round1 numbers check", auditBen.round1.check_numbers_consistent, true);
txs.challengeBen = await writeChecked(clientB, "challenge_audit", ["a1", "Record is stale: last trade 2026-08-10, over 90 days old."], 2n * GEN, "challenge Ben audit",
  async () => (await read(clientA, "get_audit", ["a1"]))?.status === "CHALLENGED");
auditBen = await read(clientA, "get_audit", ["a1"]);
assertEq("audit a1 challenge stake wei", auditBen.challenge_stake_wei, 2000000000000000000);
let totals = await read(clientA, "get_totals", []);
assertEq("locked challenges after Ben challenge", totals.locked_challenges_wei, 2000000000000000000);
txs.finalizeBen = await writeChecked(clientA, "finalize_audit", ["a1"], 0n, "close Ben audit (challenged)",
  async () => (await read(clientA, "get_audit", ["a1"]))?.status === "CLOSED");
auditBen = await read(clientA, "get_audit", ["a1"]);
assertEq("audit a1 round2 verdict", auditBen.round2.verdict, "SUSPECT");
assertEq("audit a1 challenge outcome", auditBen.challenge_outcome, "CHALLENGE_FAILED");
let traderBen = await read(clientA, "get_trader", ["t1"]);
assertEq("trader t1 verdict", traderBen.verdict, "SUSPECT");
assertEq("trader t1 status", traderBen.status, "AUDITED_SUSPECT");
assertEq("trader t1 weight", traderBen.weight, 50);
assertEq("trader t1 reputation", traderBen.reputation, 0);
totals = await read(clientA, "get_totals", []);
assertEq("house pool after failed challenge (2 GEN forfeited)", totals.house_pool_wei, 2000000000000000000);
assertEq("totals invariant after Ben", totals.invariant_ok, true);

// --- Dana: numbers wrong -> SUSPECT; challenge; fix evidence; close --------
txs.registerDana = await writeOnce(clientA, "register_trader", ["Dana Kim", "DAN-004", `${REPO}/trader-dana.json`], 0n, "register Dana");
txs.auditDana = await writeChecked(clientA, "audit_trader", ["t2"], 0n, "audit Dana",
  async () => (await read(clientA, "get_audit", ["a2"]))?.round1?.verdict === "SUSPECT");
let auditDana = await read(clientA, "get_audit", ["a2"]);
assertEq("audit a2 round1 verdict", auditDana.round1.verdict, "SUSPECT");
assertEq("audit a2 round1 numbers check", auditDana.round1.check_numbers_consistent, false);
txs.challengeDana = await writeChecked(clientB, "challenge_audit", ["a2", "Claimed total return 999 bps does not recompute from the trades."], 2n * GEN, "challenge Dana audit",
  async () => (await read(clientA, "get_audit", ["a2"]))?.status === "CHALLENGED");
// Correct the evidence file in the repo: claimed_total_return_bps 999 -> 300
// (the trades sum to 300). Push, then wait until the raw URL serves it.
{
  const danaPath = path.join(root, "evidence", "trader-dana.json");
  const dana = JSON.parse(readFileSync(danaPath, "utf-8"));
  dana.claimed_total_return_bps = 300;
  writeFileSync(danaPath, JSON.stringify(dana) + "\n");
  execSync(`git add evidence/trader-dana.json && git commit -m "Correct Dana track record: claimed total return 999 -> 300 (trades sum to 300)" && git push`, { cwd: root, stdio: "inherit" });
  let served = null;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${REPO}/trader-dana.json`);
      const j = await res.json();
      served = j.claimed_total_return_bps;
      console.log(`raw trader-dana.json claimed_total_return_bps: ${served} (poll ${i + 1})`);
      if (served === 300) break;
    } catch (e) { console.log("raw poll failed:", String(e).slice(0, 120)); }
    await sleep(15000);
  }
  if (served !== 300) throw new Error("corrected Dana evidence was not served by raw.githubusercontent before closing the audit");
}
txs.finalizeDana = await writeChecked(clientA, "finalize_audit", ["a2"], 0n, "close Dana audit (challenged, evidence corrected)",
  async () => (await read(clientA, "get_audit", ["a2"]))?.status === "CLOSED");
auditDana = await read(clientA, "get_audit", ["a2"]);
assertEq("audit a2 round2 verdict", auditDana.round2.verdict, "VERIFIED");
assertEq("audit a2 challenge outcome", auditDana.challenge_outcome, "CHALLENGE_SUCCEEDED");
let traderDana = await read(clientA, "get_trader", ["t2"]);
assertEq("trader t2 verdict", traderDana.verdict, "VERIFIED");
assertEq("trader t2 status", traderDana.status, "AUDITED_VERIFIED");
assertEq("trader t2 reputation", traderDana.reputation, 10);
let creditB = await read(clientA, "get_credit", [accountB.address]);
assertEq("challenger B credit after success (2 GEN refund + 0.75 GEN reward)", String(creditB), "2750000000000000000");
totals = await read(clientA, "get_totals", []);
assertEq("house pool after Dana reward (2 - 0.75 GEN)", totals.house_pool_wei, 1250000000000000000);
assertEq("totals invariant after Dana", totals.invariant_ok, true);

// --- Cara: identity mismatch -> REJECTED -----------------------------------
txs.registerCara = await writeOnce(clientA, "register_trader", ["Cara Diaz", "CAR-003", `${REPO}/trader-cara.json`], 0n, "register Cara");
txs.auditCara = await writeChecked(clientA, "audit_trader", ["t3"], 0n, "audit Cara",
  async () => (await read(clientA, "get_audit", ["a3"]))?.round1?.verdict === "REJECTED");
let auditCara = await read(clientA, "get_audit", ["a3"]);
assertEq("audit a3 round1 verdict", auditCara.round1.verdict, "REJECTED");
assertEq("audit a3 round1 identity check", auditCara.round1.check_identity_matches, false);
txs.finalizeCara = await writeChecked(clientA, "finalize_audit", ["a3"], 0n, "close Cara audit",
  async () => (await read(clientA, "get_audit", ["a3"]))?.status === "CLOSED");
let traderCara = await read(clientA, "get_trader", ["t3"]);
assertEq("trader t3 verdict", traderCara.verdict, "REJECTED");
assertEq("trader t3 status", traderCara.status, "AUDITED_REJECTED");
assertEq("trader t3 weight", traderCara.weight, 0);
assertEq("trader t3 reputation (0 - 10 clamped to 0)", traderCara.reputation, 0);

// --- Copies: A copies Ava (VERIFIED, 1.0x) and Ben (SUSPECT, 0.5x) ---------
txs.copyAva = await writeChecked(clientA, "copy_trader", ["t0"], 5n * GEN, "copy Ava 5 GEN",
  async () => (await read(clientA, "get_copy", ["c0"]))?.status === "OPEN");
let copy0 = await read(clientA, "get_copy", ["c0"]);
assertEq("copy c0 stake wei", copy0.stake_wei, 5000000000000000000);
assertEq("copy c0 weight", copy0.weight, 100);
assertEq("copy c0 effective wei", copy0.effective_wei, 5000000000000000000);
console.log("  copy c0 entry BTC bucket USD:", copy0.entry_bucket_usd);
txs.copyBenA = await writeChecked(clientA, "copy_trader", ["t1"], 5n * GEN, "copy Ben 5 GEN (A)",
  async () => (await read(clientA, "get_copy", ["c1"]))?.status === "OPEN");
let copy1 = await read(clientA, "get_copy", ["c1"]);
assertEq("copy c1 stake wei", copy1.stake_wei, 5000000000000000000);
assertEq("copy c1 weight", copy1.weight, 50);
assertEq("copy c1 effective wei", copy1.effective_wei, 2500000000000000000);
console.log("  copy c1 entry BTC bucket USD:", copy1.entry_bucket_usd);
// C copies Ben (SUSPECT) too, then cancels for a full refund.
txs.copyBenC = await writeChecked(clientC, "copy_trader", ["t1"], 5n * GEN, "copy Ben 5 GEN (C)",
  async () => (await read(clientA, "get_copy", ["c2"]))?.status === "OPEN");
let copy2 = await read(clientA, "get_copy", ["c2"]);
assertEq("copy c2 weight", copy2.weight, 50);
assertEq("copy c2 effective wei", copy2.effective_wei, 2500000000000000000);
totals = await read(clientA, "get_totals", []);
assertEq("locked copies after 3 copies (15 GEN)", totals.locked_copies_wei, 15000000000000000000);
assertEq("total received (4 GEN challenges + 15 GEN copies)", totals.total_received_wei, 19000000000000000000);
assertEq("totals invariant after copies", totals.invariant_ok, true);

// --- Negative case 1: copying a REJECTED trader must fail on-chain --------
const countsBeforeNeg = await read(clientA, "get_counts", []);
const totalsBeforeNeg = await read(clientA, "get_totals", []);
let negativeCopy = { attempted: true, outcome: null, hash: null, error: null };
try {
  const hash = await clientA.writeContract({ address, functionName: "copy_trader", args: ["t3"], value: 5n * GEN, leaderOnly: false });
  negativeCopy.hash = hash;
  try {
    const receipt = await clientA.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 24, interval: 5000 });
    const status = receipt.statusName ?? STATUS_NAMES[receipt.status] ?? String(receipt.status ?? "");
    negativeCopy.outcome = `tx submitted, receipt status ${status}`;
  } catch (e) {
    negativeCopy.outcome = `tx submitted but receipt wait failed: ${String(e).slice(0, 300)}`;
  }
} catch (e) {
  negativeCopy.outcome = "client rejected the call before submission";
  negativeCopy.error = String(e).slice(0, 500);
}
console.log("Negative copy REJECTED trader:", JSON.stringify(negativeCopy));
const countsAfterNeg = await read(clientA, "get_counts", []);
const totalsAfterNeg = await read(clientA, "get_totals", []);
assertEq("copies count unchanged after rejected copy", countsAfterNeg.copies, countsBeforeNeg.copies);
assertEq("total received unchanged after rejected copy (no GEN taken)", totalsAfterNeg.total_received_wei, totalsBeforeNeg.total_received_wei);
txs.negativeCopyRejected = negativeCopy;

// --- Cancel: C cancels the SUSPECT copy c2, full 5 GEN refund as credit ---
txs.cancelBenC = await writeChecked(clientC, "cancel_copy", ["c2"], 0n, "cancel copy c2 (C)",
  async () => (await read(clientA, "get_copy", ["c2"]))?.status === "CANCELLED");
copy2 = await read(clientA, "get_copy", ["c2"]);
assertEq("copy c2 status", copy2.status, "CANCELLED");
assertEq("copy c2 return wei (full stake)", copy2.return_wei, 5000000000000000000);
let creditC = await read(clientA, "get_credit", [accountC.address]);
assertEq("C credit after cancel (5 GEN)", String(creditC), "5000000000000000000");
totals = await read(clientA, "get_totals", []);
assertEq("locked copies after cancel (10 GEN)", totals.locked_copies_wei, 10000000000000000000);
assertEq("totals invariant after cancel", totals.invariant_ok, true);

// --- Negative case 2: settling an already-cancelled copy must fail --------
let negativeSettle = { attempted: true, outcome: null, hash: null, error: null };
try {
  const hash = await clientA.writeContract({ address, functionName: "settle_copy", args: ["c2"], value: 0n, leaderOnly: false });
  negativeSettle.hash = hash;
  try {
    const receipt = await clientA.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 24, interval: 5000 });
    negativeSettle.outcome = `tx submitted, receipt status ${receipt.statusName ?? STATUS_NAMES[receipt.status] ?? receipt.status}`;
  } catch (e) {
    negativeSettle.outcome = `tx submitted but receipt wait failed: ${String(e).slice(0, 300)}`;
  }
} catch (e) {
  negativeSettle.outcome = "client rejected the call before submission";
  negativeSettle.error = String(e).slice(0, 500);
}
console.log("Negative settle cancelled copy:", JSON.stringify(negativeSettle));
copy2 = await read(clientA, "get_copy", ["c2"]);
assertEq("copy c2 still CANCELLED after settle attempt", copy2.status, "CANCELLED");
txs.negativeSettleCancelled = negativeSettle;

// --- Settle c0 (Ava, VERIFIED) and c1 (Ben, SUSPECT) on the live BTC price -
txs.settleAva = await writeChecked(clientA, "settle_copy", ["c0"], 0n, "settle copy c0 (Ava)",
  async () => (await read(clientA, "get_copy", ["c0"]))?.status === "SETTLED");
copy0 = await read(clientA, "get_copy", ["c0"]);
console.log("  copy c0 settled:", JSON.stringify({ entry: copy0.entry_bucket_usd, exit: copy0.exit_bucket_usd, pnl_bps: copy0.pnl_bps, pnl_wei: copy0.pnl_wei, return_wei: copy0.return_wei, capped: copy0.capped }));
// Recompute the settlement off-chain from the stored buckets and check it.
{
  const trunc = (a, b) => { const q = (a < 0n ? -a : a) / b; return a < 0n ? -q : q; };
  const pnlBps = Number(trunc(BigInt((copy0.exit_bucket_usd - copy0.entry_bucket_usd) * 10000), BigInt(copy0.entry_bucket_usd)));
  assertEq("copy c0 pnl_bps recomputed off-chain", copy0.pnl_bps, pnlBps);
  const pnlWei = trunc(BigInt(copy0.effective_wei) * BigInt(pnlBps), 10000n);
  assertEq("copy c0 pnl_wei recomputed off-chain", String(copy0.pnl_wei), pnlWei.toString());
}
txs.settleBen = await writeChecked(clientA, "settle_copy", ["c1"], 0n, "settle copy c1 (Ben)",
  async () => (await read(clientA, "get_copy", ["c1"]))?.status === "SETTLED");
copy1 = await read(clientA, "get_copy", ["c1"]);
console.log("  copy c1 settled:", JSON.stringify({ entry: copy1.entry_bucket_usd, exit: copy1.exit_bucket_usd, pnl_bps: copy1.pnl_bps, pnl_wei: copy1.pnl_wei, return_wei: copy1.return_wei, capped: copy1.capped }));
{
  const trunc = (a, b) => { const q = (a < 0n ? -a : a) / b; return a < 0n ? -q : q; };
  const pnlBps = Number(trunc(BigInt((copy1.exit_bucket_usd - copy1.entry_bucket_usd) * 10000), BigInt(copy1.entry_bucket_usd)));
  assertEq("copy c1 pnl_bps recomputed off-chain", copy1.pnl_bps, pnlBps);
}
totals = await read(clientA, "get_totals", []);
assertEq("locked copies after settles (0)", totals.locked_copies_wei, 0);
assertEq("totals invariant after settles", totals.invariant_ok, true);
assertEq("totals balance matches", totals.balance_matches_wei, true);
console.log("Totals after settles:", JSON.stringify(totals));

// --- Withdraw: A (two settlements), B (challenge refund + reward), C (cancel)
const eoaBefore = {
  A: await eoaBalance(clientA, accountA.address),
  B: await eoaBalance(clientB, accountB.address),
  C: await eoaBalance(clientC, accountC.address),
};
console.log("EOA balances before withdraw:", JSON.stringify(eoaBefore));
const creditsBefore = {
  A: String(await read(clientA, "get_credit", [accountA.address])),
  B: String(await read(clientA, "get_credit", [accountB.address])),
  C: String(await read(clientA, "get_credit", [accountC.address])),
};
console.log("Credits before withdraw:", JSON.stringify(creditsBefore));
txs.withdrawA = await writeChecked(clientA, "withdraw_payout", [], 0n, "withdraw A",
  async () => String(await read(clientA, "get_credit", [accountA.address])) === "0");
txs.withdrawB = await writeChecked(clientB, "withdraw_payout", [], 0n, "withdraw B",
  async () => String(await read(clientA, "get_credit", [accountB.address])) === "0");
txs.withdrawC = await writeChecked(clientC, "withdraw_payout", [], 0n, "withdraw C",
  async () => String(await read(clientA, "get_credit", [accountC.address])) === "0");
await sleep(8000);
const eoaAfter = {
  A: await eoaBalance(clientA, accountA.address),
  B: await eoaBalance(clientB, accountB.address),
  C: await eoaBalance(clientC, accountC.address),
};
console.log("EOA balances after withdraw (+8s):", JSON.stringify(eoaAfter));
const expectEoa = {
  A: (BigInt(eoaBefore.A) + BigInt(creditsBefore.A)).toString(),
  B: (BigInt(eoaBefore.B) + BigInt(creditsBefore.B)).toString(),
  C: (BigInt(eoaBefore.C) + BigInt(creditsBefore.C)).toString(),
};
assertEq("EOA A after withdraw = before + credit", eoaAfter.A, expectEoa.A);
assertEq("EOA B after withdraw = before + credit", eoaAfter.B, expectEoa.B);
assertEq("EOA C after withdraw = before + credit", eoaAfter.C, expectEoa.C);

// --- final read-back -------------------------------------------------------
const counts = await read(clientA, "get_counts", []);
assertEq("counts traders", counts.traders, 4);
assertEq("counts audits", counts.audits, 4);
assertEq("counts copies", counts.copies, 3);
assertEq("counts witnesses", counts.witnesses, 0);
const traders = await read(clientA, "list_traders", [0n, 20n]);
const audits = await read(clientA, "list_audits", [0n, 20n]);
const copies = await read(clientA, "list_copies", [0n, 20n]);
const witnesses = await read(clientA, "list_witnesses", [0n, 20n]);
const finalTotals = await read(clientA, "get_totals", []);
assertEq("final invariant ok", finalTotals.invariant_ok, true);
assertEq("final balance matches", finalTotals.balance_matches_wei, true);
assertEq("final credits total 0", finalTotals.credits_total_wei, 0);
assertEq("final locked copies 0", finalTotals.locked_copies_wei, 0);
assertEq("final locked challenges 0", finalTotals.locked_challenges_wei, 0);
assertEq("final total received 19 GEN", finalTotals.total_received_wei, 19000000000000000000);
assertEq("final paid out + pool == received", finalTotals.total_paid_out_wei + finalTotals.house_pool_wei, 19000000000000000000);
assertEq("final contract balance == pool (only house pool remains)", finalTotals.contract_balance_wei, finalTotals.house_pool_wei);
const finalCredits = {
  A: String(await read(clientA, "get_credit", [accountA.address])),
  B: String(await read(clientA, "get_credit", [accountB.address])),
  C: String(await read(clientA, "get_credit", [accountC.address])),
};

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  flowAccounts: { A: accountA.address, B: accountB.address, C: accountC.address },
  funded,
  txs,
  readBack: { counts, traders, audits, copies, witnesses, finalTotals, finalCredits },
  reconciliation: {
    fundedWeiPerAccount: (BigInt(FUND_GEN) * GEN).toString(),
    eoaBeforeWithdrawWei: eoaBefore,
    creditsBeforeWithdrawWei: creditsBefore,
    eoaAfterWithdrawWei: eoaAfter,
    expectedEoaAfterWithdrawWei: expectEoa,
    note: "Each account started at 10000 GEN. A paid 15 GEN in copy stakes (3 x 5 GEN) and withdrew its settlement credits; B paid 4 GEN in challenge stakes (2 x 2 GEN) and withdrew 2.75 GEN (2 GEN refund + 0.75 GEN reward); C paid 5 GEN in one copy stake and withdrew the full 5 GEN cancel refund. Contract balance at the end equals the house pool only.",
  },
  checkedAt: new Date().toISOString(),
};
writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log("Wrote evidence.json");
console.log("FLOW COMPLETE: all assertions passed");
