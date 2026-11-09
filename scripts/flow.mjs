/* End-to-end on-chain flow against an already-deployed CopyTrade contract.
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... node scripts/flow.mjs
 *
 * Two ephemeral accounts are used (Studionet is gasless, 0 GEN, and the
 * contract is permissionless): account A runs the main flow, account B
 * is the challenger (a challenger must differ from the audit requester).
 * No key is ever written to disk.
 *
 * Steps:
 *   Ava (fresh, consistent record) -> register, audit, finalize
 *     (VERIFIED), claim demo funds, follow 1000, settle +500 bps.
 *   Ben (stale record, 91 days old) -> register, audit (SUSPECT),
 *     challenge by B, finalize (second evaluation agrees: challenge
 *     fails, B -5 reputation), follow 1000 at weight 50.
 *   Cara (identity mismatch) -> register, audit, finalize (REJECTED).
 * Every tx is waited to FINALIZED and every state change is read back.
 * Writes evidence.json (tx hashes, final status, read-backs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address: set CONTRACT_ADDRESS or run deploy first");

const accountA = createAccount(generatePrivateKey());
const accountB = createAccount(generatePrivateKey());
console.log("Flow account A (auditor/follower):", accountA.address);
console.log("Flow account B (challenger):", accountB.address);
console.log("Contract:", address);

const clientA = createClient({ chain: studionet, account: accountA });
const clientB = createClient({ chain: studionet, account: accountB });

const STATUS_NAMES = { 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" };

async function waitFinal(client, hash, label) {
  console.log(`${label} tx:`, hash);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    retries: 240,
    interval: 5000,
  });
  const status = receipt.statusName ?? STATUS_NAMES[receipt.status] ?? String(receipt.status ?? "");
  console.log(`${label} final:`, status);
  if (status !== "FINALIZED") throw new Error(`${label} did not finalize: ${status}`);
  return { hash, status };
}

async function write(client, functionName, args, label) {
  const hash = await client.writeContract({ address, functionName, args, value: 0n, leaderOnly: false });
  return waitFinal(client, hash, label);
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

// --- Ava: fresh, consistent record -> VERIFIED ---------------------------
txs.registerAva = await write(clientA, "register_trader", ["Ava Chen", "AVA-001", `${REPO}/trader-ava.json`], "register Ava");
txs.auditAva = await write(clientA, "audit_trader", ["t0"], "audit Ava");
let auditAva = await read(clientA, "get_audit", ["a0"]);
assertEq("audit a0 status", auditAva.status, "EVALUATING");
assertEq("audit a0 round1 verdict", auditAva.round1.verdict, "VERIFIED");
assertEq("audit a0 round1 wins", auditAva.round1.wins, 7);
assertEq("audit a0 round1 trade_count", auditAva.round1.trade_count, 10);
assertEq("audit a0 round1 total_return_bps", auditAva.round1.total_return_bps, 1390);
txs.finalizeAva = await write(clientA, "finalize_audit", ["a0"], "finalize Ava");
let traderAva = await read(clientA, "get_trader", ["t0"]);
assertEq("trader t0 verdict", traderAva.verdict, "VERIFIED");
assertEq("trader t0 weight", traderAva.weight, 100);
assertEq("trader t0 reputation", traderAva.reputation, 110);

txs.claimA = await write(clientA, "claim_demo_funds", [], "claim demo funds A");
let accountAState = await read(clientA, "get_account", [accountA.address]);
assertEq("account A balance after claim", accountAState.balance, 10000);

txs.followAva = await write(clientA, "follow_trader", ["t0", 1000n], "follow Ava 1000");
let copy0 = await read(clientA, "get_copy", ["c0"]);
assertEq("copy c0 status", copy0.status, "OPEN");
assertEq("copy c0 weight", copy0.weight, 100);
assertEq("copy c0 effective", copy0.effective, 1000);
accountAState = await read(clientA, "get_account", [accountA.address]);
assertEq("account A balance after follow", accountAState.balance, 9000);

txs.settleAva = await write(clientA, "settle_copy", ["c0", 500n], "settle copy c0 +500bps");
copy0 = await read(clientA, "get_copy", ["c0"]);
assertEq("copy c0 status after settle", copy0.status, "SETTLED");
assertEq("copy c0 pnl", copy0.pnl, 50);
assertEq("copy c0 settled_value", copy0.settled_value, 1050);
accountAState = await read(clientA, "get_account", [accountA.address]);
assertEq("account A balance after settle", accountAState.balance, 10050);
traderAva = await read(clientA, "get_trader", ["t0"]);
assertEq("trader t0 reputation after settle", traderAva.reputation, 111);
assertEq("trader t0 settled_copies", traderAva.settled_copies, 1);

// --- Ben: stale record (91 days) -> SUSPECT, challenged, challenge fails -
txs.registerBen = await write(clientA, "register_trader", ["Ben Okafor", "BEN-002", `${REPO}/trader-ben.json`], "register Ben");
txs.auditBen = await write(clientA, "audit_trader", ["t1"], "audit Ben");
let auditBen = await read(clientA, "get_audit", ["a1"]);
assertEq("audit a1 status", auditBen.status, "EVALUATING");
assertEq("audit a1 round1 verdict", auditBen.round1.verdict, "SUSPECT");
assertEq("audit a1 round1 fresh check", auditBen.round1.check_evidence_fresh, false);
txs.challengeBen = await write(clientB, "challenge_audit", ["a1", "Record is stale: last trade 2026-08-10, over 90 days old."], "challenge Ben audit");
auditBen = await read(clientA, "get_audit", ["a1"]);
assertEq("audit a1 status after challenge", auditBen.status, "CHALLENGED");
txs.finalizeBen = await write(clientA, "finalize_audit", ["a1"], "finalize Ben (challenged)");
auditBen = await read(clientA, "get_audit", ["a1"]);
assertEq("audit a1 status final", auditBen.status, "FINALIZED");
assertEq("audit a1 round2 verdict", auditBen.round2.verdict, "SUSPECT");
assertEq("audit a1 challenge outcome", auditBen.challenge_outcome, "CHALLENGE_FAILED");
let traderBen = await read(clientA, "get_trader", ["t1"]);
assertEq("trader t1 verdict", traderBen.verdict, "SUSPECT");
assertEq("trader t1 weight", traderBen.weight, 50);
assertEq("trader t1 reputation", traderBen.reputation, 100);
let accountBState = await read(clientA, "get_account", [accountB.address]);
assertEq("account B reputation after failed challenge", accountBState.reputation, 95);

txs.followBen = await write(clientA, "follow_trader", ["t1", 1000n], "follow Ben 1000 (weight 50)");
let copy1 = await read(clientA, "get_copy", ["c1"]);
assertEq("copy c1 status", copy1.status, "OPEN");
assertEq("copy c1 weight", copy1.weight, 50);
assertEq("copy c1 effective", copy1.effective, 500);
accountAState = await read(clientA, "get_account", [accountA.address]);
assertEq("account A balance after Ben follow", accountAState.balance, 9050);

// --- Cara: identity mismatch -> REJECTED ----------------------------------
txs.registerCara = await write(clientA, "register_trader", ["Cara Diaz", "CAR-003", `${REPO}/trader-cara.json`], "register Cara");
txs.auditCara = await write(clientA, "audit_trader", ["t2"], "audit Cara");
let auditCara = await read(clientA, "get_audit", ["a2"]);
assertEq("audit a2 status", auditCara.status, "EVALUATING");
assertEq("audit a2 round1 verdict", auditCara.round1.verdict, "REJECTED");
assertEq("audit a2 round1 identity check", auditCara.round1.check_identity_matches, false);
txs.finalizeCara = await write(clientA, "finalize_audit", ["a2"], "finalize Cara");
let traderCara = await read(clientA, "get_trader", ["t2"]);
assertEq("trader t2 verdict", traderCara.verdict, "REJECTED");
assertEq("trader t2 weight", traderCara.weight, 0);
assertEq("trader t2 reputation", traderCara.reputation, 90);

// --- final read-back -------------------------------------------------------
const counts = await read(clientA, "get_counts", []);
assertEq("counts traders", counts.traders, 3);
assertEq("counts audits", counts.audits, 3);
assertEq("counts copies", counts.copies, 2);
assertEq("counts witnesses", counts.witnesses, 0);
const traders = await read(clientA, "list_traders", [0n, 20n]);
const audits = await read(clientA, "list_audits", [0n, 20n]);
const copies = await read(clientA, "list_copies", [0n, 20n]);
const witnesses = await read(clientA, "list_witnesses", [0n, 20n]);

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  flowAccountA: accountA.address,
  flowAccountB: accountB.address,
  txs,
  readBack: { counts, traders, audits, copies, witnesses, accountA: accountAState, accountB: accountBState },
  checkedAt: new Date().toISOString(),
};
writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log("Wrote evidence.json");
console.log("FLOW COMPLETE: all assertions passed");
