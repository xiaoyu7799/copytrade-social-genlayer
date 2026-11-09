/* CopyTrade configuration: network, contract, links. */
export const CONFIG = {
  networkName: "Stable Studionet",
  chainId: 61999,
  chainIdHex: "0xF223",
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: "0xF9FC6D2244b8032827EBea844Ce56D44233A69d6",
  deployTxHash: "0x42d468144904f0aaf1103a968284fd2e557235c06b5c843417f36d16dc9681e9",
  repoUrl: "https://github.com/xiaoyu7799/copytrade-social-genlayer",
  siteUrl: "https://xiaoyu7799.github.io/copytrade-social-genlayer/",
  evidenceUrl: "https://github.com/xiaoyu7799/copytrade-social-genlayer/blob/main/evidence.json",
  mechanismUrl: "https://github.com/xiaoyu7799/copytrade-social-genlayer/blob/main/docs/mechanism.md",
  demoFunds: 10000,
};

export const EXPLORER_TX = (hash) => `https://explorer-studio.genlayer.com/tx/${hash}`;
export const EXPLORER_ADDRESS = (addr) => `https://explorer-studio.genlayer.com/address/${addr}`;
