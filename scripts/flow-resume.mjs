/* Phase-2 resume flow for the already-deployed CopyTrade contract.
 *
 * Phase 1 (scripts/flow.mjs) stopped at the Dana close: the evidence
 * file was corrected 999 -> 300 and the raw URL served 300 to curl,
 * but every validator still fetched the stale 999 (evidence CDN
 * cache), so round2 closed SUSPECT and the challenge failed. That is
 * recorded honestly in evidence.json. Phase 1 accounts (A/B/C) are
 * gone with their process keys; the contract is permissionless, so
 * phase 2 uses fresh accounts D/E/F. Phase-1 state is re-read and
 * asserted here before anything new happens.
 *
 * Phase 2:
 *   - Re-audit Dana (a3): the corrected file is now long past the
 *     CDN cache window, so round1 should be VERIFIED; closing it
 *     records a contradiction witness (standing SUSPECT vs new
 *     VERIFIED) and proves the witness path live.
 *   - Cara (REJECTED) as planned.
 *   - Eli: new trader, v1 numbers wrong -> SUSPECT, challenged by E;
 *     evidence corrected in the repo, then an 11-minute wait (past
 *     the 300s CDN cache) PLUS a probe audit that must read VERIFIED
 *     before the challenged audit is closed. Only then finalize ->
 *     CHALLENGE_SUCCEEDED, E refunded 2 GEN + 0.75 GEN reward.
 *   - Copies / cancel / negative cases / settles / withdraws as in
 *     the phase-1 plan, with D/E/F.
 * Writes evidence.json (phase 1 + phase 2, tx hashes, read-backs,
 * GEN reconciliation).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address");

const GEN = 10n ** 18n;
const FUND_GEN = 10000;
const accountD = createAccount(generatePrivateKey());
const accountE = createAccount(generatePrivateKey());
const accountF = createAccount(generatePrivateKey());
console.log("Phase-2 account D (registrar/auditor/follower):", accountD.address);
console.log("Phase-2 account E (challenger):", accountE.address);
console.log("Phase-2 account F (follower, cancels):", accountF.address);
console.log("Contract:", address);

const clientD = createClient({ chain: studionet, account: accountD });
const clientE = createClient({ chain: studionet, account: accountE });
const clientF = createClient({ chain: studionet, account: accountF });

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

const REPO = "https://raw.githubusercontent.com/xiaoyu7799/copytrade-social-genlayer/main/evidence";

// Phase-1 record (from the phase-1 run; every claim below is re-read
// and asserted from chain state before phase 2 proceeds).
const phase1 = {
  note: "Phase 1 ran scripts/flow.mjs and stopped at the Dana close: the evidence file was corrected 999 -> 300, curl saw 300, but all validators still fetched the stale 999 (CDN cache), so round2 closed SUSPECT and the challenge failed. Phase-1 accounts A/B/C keys were lost with the phase-1 process; no funds need recovering from them (B's two 2 GEN challenge stakes were forfeited into the house pool by design).",
  accounts: {
    A: "0x1Ca0137b9e33Aa9435eB057ef62053eB7D7f8364",
    B: "0x550eA0f1b60a9449e4F0A15De90542F43b8DC084",
    C: "0xFD0f6D913AEefa3FdBb12Ca611523f3bA5256E63",
  },
  fundedWeiPerAccount: (BigInt(FUND_GEN) * GEN).toString(),
  txs: {
    registerAva: { hash: "0x87075048e4e03a8400c0cd7bcbf3bd199c86f8c27c0f6cc8b954084236833f69", status: "FINALIZED" },
    auditAva: { hash: "0x6bf32256f2b7b5b59c5b1068f13cb29a0d87274d259c8eaaa3ebc35e9d2506c2", status: "FINALIZED" },
    finalizeAva: { hash: "0x0d622ce07cf351281bc1db859f5acc8aba2d31c1a8da044ffe0ceed5fa0084ed", status: "FINALIZED" },
    registerBen: { hash: "0x2b282aaf056fa3ad8afc9649acf5f01fbbcbd8a657a828514fb0f8231c14e52f", status: "FINALIZED" },
    auditBen: { hash: "0xf9ac6af3cbcdd875863a4c843a06d7836b0ce1ad82d84132488e53fd2b3cdd9a", status: "FINALIZED" },
    challengeBen: { hash: "0x00b3eceda5cb904eef4b6cdaadb6d214b2b18c35a44923dc1abd9fcdafc7c6b7", status: "FINALIZED" },
    finalizeBen: { hash: "0xedceae93cf05b54b6dc58ef25eef39d6357f5c59b6f2f9d422220030299e95ea", status: "FINALIZED" },
    registerDana: { hash: "0x5046dbf5b7ea12b7966d2c8a1aaa60a82e04fd275851ac03429cd5227b376202", status: "FINALIZED" },
    auditDana: { hash: "0xca3ded4e17a609386d4bcc3eaadf6f8b0da57b8167a555409b60c5aa6a99c759", status: "FINALIZED" },
    challengeDana: { hash: "0x7de7be84cd2ec52b1d2b89a08b174ff2ffd8d9475276f9633f1090b223b58fea", status: "FINALIZED" },
    finalizeDana: { hash: "0x02aa99ddb2cb6568ef9368001f01ed7386d58344b05d84e15959858a6fb0b8bc", status: "FINALIZED" },
  },
};

const txs = {};

// --- verify phase-1 state by re-reading ------------------------------------
{
  const t0 = await read(clientD, "get_trader", ["t0"]);
  assertEq("phase1 t0 Ava VERIFIED", t0.verdict, "VERIFIED");
  assertEq("phase1 t0 reputation", t0.reputation, 10);
  const t1 = await read(clientD, "get_trader", ["t1"]);
  assertEq("phase1 t1 Ben SUSPECT", t1.verdict, "SUSPECT");
  const a1 = await read(clientD, "get_audit", ["a1"]);
  assertEq("phase1 a1 challenge outcome", a1.challenge_outcome, "CHALLENGE_FAILED");
  const a2 = await read(clientD, "get_audit", ["a2"]);
  assertEq("phase1 a2 round2 verdict (stale cache)", a2.round2.verdict, "SUSPECT");
  assertEq("phase1 a2 round2 numbers check (saw 999)", a2.round2.check_numbers_consistent, false);
  assertEq("phase1 a2 challenge outcome", a2.challenge_outcome, "CHALLENGE_FAILED");
  const t2 = await read(clientD, "get_trader", ["t2"]);
  assertEq("phase1 t2 Dana SUSPECT", t2.verdict, "SUSPECT");
  const totals = await read(clientD, "get_totals", []);
  assertEq("phase1 house pool (2 failed challenges)", totals.house_pool_wei, 4000000000000000000);
  assertEq("phase1 total received (4 GEN challenges)", totals.total_received_wei, 4000000000000000000);
  assertEq("phase1 invariant", totals.invariant_ok, true);
  const counts = await read(clientD, "get_counts", []);
  assertEq("phase1 counts traders", counts.traders, 3);
  assertEq("phase1 counts audits", counts.audits, 3);
}

// --- fund phase-2 accounts --------------------------------------------------
const funded = {};
for (const [name, client, account] of [["D", clientD, accountD], ["E", clientE, accountE], ["F", clientF, accountF]]) {
  const fundTx = await client.request({ method: "sim_fundAccount", params: [account.address, FUND_GEN * 10 ** 18] });
  funded[name] = { fundTx: String(fundTx), balanceWei: await eoaBalance(client, account.address) };
  console.log(`Funded ${name}:`, funded[name].balanceWei, "wei");
  assertEq(`account ${name} funded 10000 GEN`, funded[name].balanceWei, (BigInt(FUND_GEN) * GEN).toString());
}

// --- Dana re-audit: corrected file is long past the cache window ----------
// Expect round1 VERIFIED now; closing records a witness (standing
// SUSPECT vs new VERIFIED) and leaves the trader SUSPECT.
txs.reauditDana = await writeChecked(clientD, "audit_trader", ["t2"], 0n, "re-audit Dana",
  async () => (await read(clientD, "get_audit", ["a3"]))?.round1?.verdict === "VERIFIED");
let auditDana2 = await read(clientD, "get_audit", ["a3"]);
assertEq("re-audit a3 round1 verdict", auditDana2.round1.verdict, "VERIFIED");
assertEq("re-audit a3 round1 numbers check", auditDana2.round1.check_numbers_consistent, true);
txs.finalizeReauditDana = await writeChecked(clientD, "finalize_audit", ["a3"], 0n, "close Dana re-audit",
  async () => (await read(clientD, "get_audit", ["a3"]))?.status === "CLOSED");
let traderDana = await read(clientD, "get_trader", ["t2"]);
assertEq("trader t2 still SUSPECT after re-audit", traderDana.verdict, "SUSPECT");
assertEq("trader t2 witness_count", traderDana.witness_count, 1);
const witnesses = await read(clientD, "list_witnesses", [0n, 20n]);
assertEq("witnesses count", witnesses.length, 1);
assertEq("witness w0 standing", witnesses[0].standing_verdict, "SUSPECT");
assertEq("witness w0 new", witnesses[0].new_verdict, "VERIFIED");

// --- Cara: identity mismatch -> REJECTED -----------------------------------
txs.registerCara = await writeOnce(clientD, "register_trader", ["Cara Diaz", "CAR-003", `${REPO}/trader-cara.json`], 0n, "register Cara");
txs.auditCara = await writeChecked(clientD, "audit_trader", ["t3"], 0n, "audit Cara",
  async () => (await read(clientD, "get_audit", ["a4"]))?.round1?.verdict === "REJECTED");
let auditCara = await read(clientD, "get_audit", ["a4"]);
assertEq("audit a4 round1 verdict", auditCara.round1.verdict, "REJECTED");
assertEq("audit a4 round1 identity check", auditCara.round1.check_identity_matches, false);
txs.finalizeCara = await writeChecked(clientD, "finalize_audit", ["a4"], 0n, "close Cara audit",
  async () => (await read(clientD, "get_audit", ["a4"]))?.status === "CLOSED");
let traderCara = await read(clientD, "get_trader", ["t3"]);
assertEq("trader t3 verdict", traderCara.verdict, "REJECTED");
assertEq("trader t3 status", traderCara.status, "AUDITED_REJECTED");
assertEq("trader t3 weight", traderCara.weight, 0);
assertEq("trader t3 reputation (0 - 10 clamped to 0)", traderCara.reputation, 0);

// --- Eli: numbers wrong -> SUSPECT, challenged, evidence corrected --------
txs.registerEli = await writeOnce(clientD, "register_trader", ["Eli Park", "ELI-005", `${REPO}/trader-eli.json`], 0n, "register Eli");
txs.auditEli = await writeChecked(clientD, "audit_trader", ["t4"], 0n, "audit Eli",
  async () => (await read(clientD, "get_audit", ["a5"]))?.round1?.verdict === "SUSPECT");
let auditEli = await read(clientD, "get_audit", ["a5"]);
assertEq("audit a5 round1 verdict", auditEli.round1.verdict, "SUSPECT");
assertEq("audit a5 round1 numbers check", auditEli.round1.check_numbers_consistent, false);
txs.challengeEli = await writeChecked(clientE, "challenge_audit", ["a5", "Claimed total return 999 bps does not recompute from the trades."], 2n * GEN, "challenge Eli audit",
  async () => (await read(clientD, "get_audit", ["a5"]))?.status === "CHALLENGED");
let totals = await read(clientD, "get_totals", []);
assertEq("locked challenges after Eli challenge", totals.locked_challenges_wei, 2000000000000000000);
assertEq("total received after Eli challenge (6 GEN)", totals.total_received_wei, 6000000000000000000);
// Correct the evidence file in the repo: claimed_total_return_bps 999 -> 500.
const pushTime = Date.now();
{
  const eliPath = path.join(root, "evidence", "trader-eli.json");
  const eli = JSON.parse(readFileSync(eliPath, "utf-8"));
  eli.claimed_total_return_bps = 500;
  writeFileSync(eliPath, JSON.stringify(eli) + "\n");
  execSync(`git add evidence/trader-eli.json && git commit -m "Correct Eli track record: claimed total return 999 -> 500 (trades sum to 500)" && git push`, { cwd: root, stdio: "inherit" });
}
// Wait out the evidence CDN cache (300s): do not close the challenged
// audit until at least 11 minutes after the push, and only after a
// probe audit reads VERIFIED from the validators' point of view.
let probeOk = false;
let probeAuditId = null;
let probeCount = 0;
let unclosedProbeAudits = [];
for (let probe = 6; probe <= 8 && !probeOk; probe++) {
  const elapsed = Date.now() - pushTime;
  const waitMs = Math.max(0, 660000 - elapsed);
  console.log(`Waiting ${Math.round(waitMs / 1000)}s for the evidence cache to clear before probe audit a${probe}...`);
  await sleep(waitMs);
  let served = null;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${REPO}/trader-eli.json`);
      served = (await res.json()).claimed_total_return_bps;
      if (served === 500) break;
    } catch (e) { console.log("raw poll failed:", String(e).slice(0, 120)); }
    await sleep(10000);
  }
  console.log(`raw trader-eli.json claimed_total_return_bps: ${served}`);
  if (served !== 500) throw new Error("corrected Eli evidence was not served before the probe audit");
  const probeTx = await writeChecked(clientD, "audit_trader", ["t4"], 0n, `probe audit Eli (a${probe})`,
    async () => {
      const a = await read(clientD, "get_audit", [`a${probe}`]);
      return a && a.round1 && (a.round1.verdict === "VERIFIED" || a.round1.verdict === "SUSPECT");
    });
  txs[`probeEli${probe}`] = probeTx;
  probeCount++;
  if (probeAuditId) unclosedProbeAudits.push(probeAuditId);
  probeAuditId = `a${probe}`;
  const probeAudit = await read(clientD, "get_audit", [probeAuditId]);
  console.log(`Probe audit ${probeAuditId} round1 verdict:`, probeAudit.round1.verdict, "| numbers check:", probeAudit.round1.check_numbers_consistent);
  probeOk = probeAudit.round1.verdict === "VERIFIED";
  if (!probeOk) console.log(`Probe still sees stale evidence; waiting another 10 minutes before the next probe.`);
  if (!probeOk) await sleep(600000);
}
if (!probeOk) throw new Error("validators still see stale Eli evidence after probes; refusing to close the challenged audit on a stale read");
txs.finalizeEli = await writeChecked(clientD, "finalize_audit", ["a5"], 0n, "close Eli audit (challenged, evidence corrected)",
  async () => (await read(clientD, "get_audit", ["a5"]))?.status === "CLOSED");
auditEli = await read(clientD, "get_audit", ["a5"]);
assertEq("audit a5 round2 verdict", auditEli.round2.verdict, "VERIFIED");
assertEq("audit a5 challenge outcome", auditEli.challenge_outcome, "CHALLENGE_SUCCEEDED");
let traderEli = await read(clientD, "get_trader", ["t4"]);
assertEq("trader t4 verdict", traderEli.verdict, "VERIFIED");
assertEq("trader t4 status", traderEli.status, "AUDITED_VERIFIED");
assertEq("trader t4 reputation", traderEli.reputation, 10);
let creditE = await read(clientD, "get_credit", [accountE.address]);
assertEq("challenger E credit after success (2 GEN refund + 0.75 GEN reward)", String(creditE), "2750000000000000000");
totals = await read(clientD, "get_totals", []);
assertEq("house pool after Eli reward (4 + 2 - 0.75 - 2 = 3.25 GEN)", totals.house_pool_wei, 3250000000000000000);
assertEq("totals invariant after Eli", totals.invariant_ok, true);
// Close the probe audit too (same VERIFIED verdict, no new witness).
txs.finalizeProbeEli = await writeChecked(clientD, "finalize_audit", [probeAuditId], 0n, "close Eli probe audit",
  async () => (await read(clientD, "get_audit", [probeAuditId]))?.status === "CLOSED");
traderEli = await read(clientD, "get_trader", ["t4"]);
assertEq("trader t4 still VERIFIED after probe close", traderEli.verdict, "VERIFIED");
const witnessesAfter = await read(clientD, "list_witnesses", [0n, 20n]);
assertEq("witnesses still 1 (no new witness)", witnessesAfter.length, 1);

// --- Copies: D copies Ava (VERIFIED, 1.0x) and Ben (SUSPECT, 0.5x) ---------
txs.copyAva = await writeChecked(clientD, "copy_trader", ["t0"], 5n * GEN, "copy Ava 5 GEN",
  async () => (await read(clientD, "get_copy", ["c0"]))?.status === "OPEN");
let copy0 = await read(clientD, "get_copy", ["c0"]);
assertEq("copy c0 stake wei", copy0.stake_wei, 5000000000000000000);
assertEq("copy c0 weight", copy0.weight, 100);
assertEq("copy c0 effective wei", copy0.effective_wei, 5000000000000000000);
console.log("  copy c0 entry BTC bucket USD:", copy0.entry_bucket_usd);
txs.copyBenD = await writeChecked(clientD, "copy_trader", ["t1"], 5n * GEN, "copy Ben 5 GEN (D)",
  async () => (await read(clientD, "get_copy", ["c1"]))?.status === "OPEN");
let copy1 = await read(clientD, "get_copy", ["c1"]);
assertEq("copy c1 stake wei", copy1.stake_wei, 5000000000000000000);
assertEq("copy c1 weight", copy1.weight, 50);
assertEq("copy c1 effective wei", copy1.effective_wei, 2500000000000000000);
console.log("  copy c1 entry BTC bucket USD:", copy1.entry_bucket_usd);
txs.copyBenF = await writeChecked(clientF, "copy_trader", ["t1"], 5n * GEN, "copy Ben 5 GEN (F)",
  async () => (await read(clientD, "get_copy", ["c2"]))?.status === "OPEN");
let copy2 = await read(clientD, "get_copy", ["c2"]);
assertEq("copy c2 weight", copy2.weight, 50);
assertEq("copy c2 effective wei", copy2.effective_wei, 2500000000000000000);
totals = await read(clientD, "get_totals", []);
assertEq("locked copies after 3 copies (15 GEN)", totals.locked_copies_wei, 15000000000000000000);
assertEq("total received (6 GEN + 15 GEN copies)", totals.total_received_wei, 21000000000000000000);
assertEq("totals invariant after copies", totals.invariant_ok, true);

// --- Negative case 1: copying a REJECTED trader must fail on-chain --------
const countsBeforeNeg = await read(clientD, "get_counts", []);
const totalsBeforeNeg = await read(clientD, "get_totals", []);
let negativeCopy = { attempted: true, outcome: null, hash: null, error: null };
try {
  const hash = await clientD.writeContract({ address, functionName: "copy_trader", args: ["t3"], value: 5n * GEN, leaderOnly: false });
  negativeCopy.hash = hash;
  try {
    const receipt = await clientD.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 24, interval: 5000 });
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
const countsAfterNeg = await read(clientD, "get_counts", []);
const totalsAfterNeg = await read(clientD, "get_totals", []);
assertEq("copies count unchanged after rejected copy", countsAfterNeg.copies, countsBeforeNeg.copies);
assertEq("total received unchanged after rejected copy (no GEN taken)", totalsAfterNeg.total_received_wei, totalsBeforeNeg.total_received_wei);
txs.negativeCopyRejected = negativeCopy;

// --- Cancel: F cancels the SUSPECT copy c2, full 5 GEN refund as credit ---
txs.cancelBenF = await writeChecked(clientF, "cancel_copy", ["c2"], 0n, "cancel copy c2 (F)",
  async () => (await read(clientD, "get_copy", ["c2"]))?.status === "CANCELLED");
copy2 = await read(clientD, "get_copy", ["c2"]);
assertEq("copy c2 status", copy2.status, "CANCELLED");
assertEq("copy c2 return wei (full stake)", copy2.return_wei, 5000000000000000000);
let creditF = await read(clientD, "get_credit", [accountF.address]);
assertEq("F credit after cancel (5 GEN)", String(creditF), "5000000000000000000");
totals = await read(clientD, "get_totals", []);
assertEq("locked copies after cancel (10 GEN)", totals.locked_copies_wei, 10000000000000000000);
assertEq("totals invariant after cancel", totals.invariant_ok, true);

// --- Negative case 2: settling an already-cancelled copy must fail --------
let negativeSettle = { attempted: true, outcome: null, hash: null, error: null };
try {
  const hash = await clientD.writeContract({ address, functionName: "settle_copy", args: ["c2"], value: 0n, leaderOnly: false });
  negativeSettle.hash = hash;
  try {
    const receipt = await clientD.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 24, interval: 5000 });
    negativeSettle.outcome = `tx submitted, receipt status ${receipt.statusName ?? STATUS_NAMES[receipt.status] ?? receipt.status}`;
  } catch (e) {
    negativeSettle.outcome = `tx submitted but receipt wait failed: ${String(e).slice(0, 300)}`;
  }
} catch (e) {
  negativeSettle.outcome = "client rejected the call before submission";
  negativeSettle.error = String(e).slice(0, 500);
}
console.log("Negative settle cancelled copy:", JSON.stringify(negativeSettle));
copy2 = await read(clientD, "get_copy", ["c2"]);
assertEq("copy c2 still CANCELLED after settle attempt", copy2.status, "CANCELLED");
txs.negativeSettleCancelled = negativeSettle;

// --- Settle c0 (Ava, VERIFIED) and c1 (Ben, SUSPECT) on the live BTC price -
txs.settleAva = await writeChecked(clientD, "settle_copy", ["c0"], 0n, "settle copy c0 (Ava)",
  async () => (await read(clientD, "get_copy", ["c0"]))?.status === "SETTLED");
copy0 = await read(clientD, "get_copy", ["c0"]);
console.log("  copy c0 settled:", JSON.stringify({ entry: copy0.entry_bucket_usd, exit: copy0.exit_bucket_usd, pnl_bps: copy0.pnl_bps, pnl_wei: copy0.pnl_wei, return_wei: copy0.return_wei, capped: copy0.capped }));
{
  const trunc = (a, b) => { const q = (a < 0n ? -a : a) / b; return a < 0n ? -q : q; };
  const pnlBps = Number(trunc(BigInt((copy0.exit_bucket_usd - copy0.entry_bucket_usd) * 10000), BigInt(copy0.entry_bucket_usd)));
  assertEq("copy c0 pnl_bps recomputed off-chain", copy0.pnl_bps, pnlBps);
  const pnlWei = trunc(BigInt(copy0.effective_wei) * BigInt(pnlBps), 10000n);
  assertEq("copy c0 pnl_wei recomputed off-chain", String(copy0.pnl_wei), pnlWei.toString());
}
txs.settleBen = await writeChecked(clientD, "settle_copy", ["c1"], 0n, "settle copy c1 (Ben)",
  async () => (await read(clientD, "get_copy", ["c1"]))?.status === "SETTLED");
copy1 = await read(clientD, "get_copy", ["c1"]);
console.log("  copy c1 settled:", JSON.stringify({ entry: copy1.entry_bucket_usd, exit: copy1.exit_bucket_usd, pnl_bps: copy1.pnl_bps, pnl_wei: copy1.pnl_wei, return_wei: copy1.return_wei, capped: copy1.capped }));
{
  const trunc = (a, b) => { const q = (a < 0n ? -a : a) / b; return a < 0n ? -q : q; };
  const pnlBps = Number(trunc(BigInt((copy1.exit_bucket_usd - copy1.entry_bucket_usd) * 10000), BigInt(copy1.entry_bucket_usd)));
  assertEq("copy c1 pnl_bps recomputed off-chain", copy1.pnl_bps, pnlBps);
}
totals = await read(clientD, "get_totals", []);
assertEq("locked copies after settles (0)", totals.locked_copies_wei, 0);
assertEq("totals invariant after settles", totals.invariant_ok, true);
assertEq("totals balance matches", totals.balance_matches_wei, true);
console.log("Totals after settles:", JSON.stringify(totals));

// --- Withdraw: D (two settlements), E (challenge refund + reward), F (cancel)
const eoaBefore = {
  D: await eoaBalance(clientD, accountD.address),
  E: await eoaBalance(clientE, accountE.address),
  F: await eoaBalance(clientF, accountF.address),
};
console.log("EOA balances before withdraw:", JSON.stringify(eoaBefore));
const creditsBefore = {
  D: String(await read(clientD, "get_credit", [accountD.address])),
  E: String(await read(clientD, "get_credit", [accountE.address])),
  F: String(await read(clientD, "get_credit", [accountF.address])),
};
console.log("Credits before withdraw:", JSON.stringify(creditsBefore));
txs.withdrawD = await writeChecked(clientD, "withdraw_payout", [], 0n, "withdraw D",
  async () => String(await read(clientD, "get_credit", [accountD.address])) === "0");
txs.withdrawE = await writeChecked(clientE, "withdraw_payout", [], 0n, "withdraw E",
  async () => String(await read(clientD, "get_credit", [accountE.address])) === "0");
txs.withdrawF = await writeChecked(clientF, "withdraw_payout", [], 0n, "withdraw F",
  async () => String(await read(clientD, "get_credit", [accountF.address])) === "0");
await sleep(8000);
const eoaAfter = {
  D: await eoaBalance(clientD, accountD.address),
  E: await eoaBalance(clientE, accountE.address),
  F: await eoaBalance(clientF, accountF.address),
};
console.log("EOA balances after withdraw (+8s):", JSON.stringify(eoaAfter));
const expectEoa = {
  D: (BigInt(eoaBefore.D) + BigInt(creditsBefore.D)).toString(),
  E: (BigInt(eoaBefore.E) + BigInt(creditsBefore.E)).toString(),
  F: (BigInt(eoaBefore.F) + BigInt(creditsBefore.F)).toString(),
};
assertEq("EOA D after withdraw = before + credit", eoaAfter.D, expectEoa.D);
assertEq("EOA E after withdraw = before + credit", eoaAfter.E, expectEoa.E);
assertEq("EOA F after withdraw = before + credit", eoaAfter.F, expectEoa.F);

// --- final read-back -------------------------------------------------------
const counts = await read(clientD, "get_counts", []);
assertEq("counts traders", counts.traders, 5);
assertEq("counts audits (6 + probes)", counts.audits, 6 + probeCount);
assertEq("counts copies", counts.copies, 3);
assertEq("counts witnesses", counts.witnesses, 1);
const traders = await read(clientD, "list_traders", [0n, 20n]);
const audits = await read(clientD, "list_audits", [0n, 20n]);
const copies = await read(clientD, "list_copies", [0n, 20n]);
const witnessesFinal = await read(clientD, "list_witnesses", [0n, 20n]);
const finalTotals = await read(clientD, "get_totals", []);
assertEq("final invariant ok", finalTotals.invariant_ok, true);
assertEq("final balance matches", finalTotals.balance_matches_wei, true);
assertEq("final credits total 0", finalTotals.credits_total_wei, 0);
assertEq("final locked copies 0", finalTotals.locked_copies_wei, 0);
assertEq("final locked challenges 0", finalTotals.locked_challenges_wei, 0);
assertEq("final total received 21 GEN", finalTotals.total_received_wei, 21000000000000000000);
assertEq("final paid out + pool == received", finalTotals.total_paid_out_wei + finalTotals.house_pool_wei, 21000000000000000000);
assertEq("final contract balance == pool (only house pool remains)", finalTotals.contract_balance_wei, finalTotals.house_pool_wei);
const finalCredits = {
  D: String(await read(clientD, "get_credit", [accountD.address])),
  E: String(await read(clientD, "get_credit", [accountE.address])),
  F: String(await read(clientD, "get_credit", [accountF.address])),
};

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  deployment,
  phase1,
  phase2: {
    accounts: { D: accountD.address, E: accountE.address, F: accountF.address },
    funded,
    txs,
    probeAuditsRun: probeCount,
    unclosedProbeAudits,
    unclosedProbeNote: unclosedProbeAudits.length > 0 ? "Earlier probe audits that read the stale evidence were left PENDING on purpose: closing one would record a witness for a verdict the validators computed from a stale CDN read, not from a real disagreement." : "Only one probe audit ran.",
  },
  readBack: { counts, traders, audits, copies, witnesses: witnessesFinal, finalTotals, finalCredits },
  reconciliation: {
    fundedWeiPerAccount: (BigInt(FUND_GEN) * GEN).toString(),
    phase2EoaBeforeWithdrawWei: eoaBefore,
    phase2CreditsBeforeWithdrawWei: creditsBefore,
    phase2EoaAfterWithdrawWei: eoaAfter,
    phase2ExpectedEoaAfterWithdrawWei: expectEoa,
    note: "Phase-1 accounts A/B/C: A paid 0 GEN (no copies ran in phase 1); B paid 4 GEN in two failed challenge stakes, both forfeited into the house pool; C paid 0 GEN. Phase-2 accounts D/E/F each started at 10000 GEN. D paid 10 GEN in copy stakes (2 x 5 GEN) and withdrew its two settlement credits; E paid 2 GEN in one challenge stake and withdrew 2.75 GEN (2 GEN refund + 0.75 GEN reward); F paid 5 GEN in one copy stake and withdrew the full 5 GEN cancel refund. Contract balance at the end equals the house pool only.",
  },
  checkedAt: new Date().toISOString(),
};
writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log("Wrote evidence.json");
console.log("PHASE-2 FLOW COMPLETE: all assertions passed");
