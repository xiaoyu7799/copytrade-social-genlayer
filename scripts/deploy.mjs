/* Deploy CopyTrade to Stable Studionet (chain 61999) only.
 *
 * Usage:
 *   node scripts/deploy.mjs
 *
 * An ephemeral deployer key is generated for this run only; the key
 * is NEVER written to disk or to deployment.json. The contract is
 * permissionless, so losing that key loses nothing.
 *
 * After FINALIZED, the deployed code is read back with
 * gen_getContractCode (base64), decoded, and SHA-256-compared with
 * the repo source file byte for byte. A mismatch aborts the deploy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codePath = path.join(root, "contracts", "copytrade.py");
const code = readFileSync(codePath, "utf-8");
const codeSha = createHash("sha256").update(code).digest("hex");
console.log("Source SHA-256:", codeSha);

const account = createAccount(generatePrivateKey());
console.log("Deployer (ephemeral):", account.address);
console.log("Network: Stable Studionet, chain 61999, https://studio.genlayer.com/api");

const client = createClient({ chain: studionet, account });
const txHash = await client.deployContract({ code, args: [], leaderOnly: false });
console.log("Deploy tx:", txHash);

const receipt = await client.waitForTransactionReceipt({
  hash: txHash,
  status: TransactionStatus.FINALIZED,
  retries: 240,
  interval: 5000,
});
const STATUS = { 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" };
const receiptStatus = receipt.statusName ?? STATUS[receipt.status] ?? String(receipt.status ?? "");
console.log("Receipt status:", receiptStatus);
if (receiptStatus !== "FINALIZED") throw new Error(`deploy did not finalize: ${receiptStatus}`);

const address =
  receipt?.data?.contract_address ??
  receipt?.txDataDecoded?.contractAddress ??
  receipt?.contractAddress ??
  null;
if (!address) throw new Error("Could not find contract address in deploy receipt");
console.log("Contract address:", address);

// Verify deployed code byte-for-byte via gen_getContractCode (base64).
const cc = await client.request({ method: "gen_getContractCode", params: [address] });
if (typeof cc !== "string" || cc.length === 0) throw new Error("gen_getContractCode returned nothing");
const decoded = Buffer.from(cc, "base64").toString("utf-8");
const deployedSha = createHash("sha256").update(decoded).digest("hex");
console.log("Deployed code SHA-256:", deployedSha, "| match:", deployedSha === codeSha, "| byte-identical:", decoded === code);
if (decoded !== code) throw new Error("deployed code differs from repo source");

const deployment = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  studio: `https://studio.genlayer.com/?import-contract=${address}`,
  contractAddress: address,
  deployTxHash: txHash,
  deployer: account.address,
  contractFile: "contracts/copytrade.py",
  contractSha256: codeSha,
  deployedCodeSha256: deployedSha,
  deployedAt: new Date().toISOString(),
  receiptStatus,
};
writeFileSync(path.join(root, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");
console.log("Wrote deployment.json");
