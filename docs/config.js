/* CopyTrade configuration: network, contract, links. */
export const CONFIG = {
  networkName: "Stable Studionet",
  chainId: 61999,
  chainIdHex: "0xF223",
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: "0xee98fbF33B2619f4BaF56476B1D760Df51F7DB63",
  deployTxHash: "0x292fbfc9ca9941bd1dbc4b2e4d27c6a4234bfb83c3b2bbe7a5cd8b17bd2c2129",
  repoUrl: "https://github.com/xiaoyu7799/copytrade-social-genlayer",
  siteUrl: "https://xiaoyu7799.github.io/copytrade-social-genlayer/",
  evidenceUrl: "https://github.com/xiaoyu7799/copytrade-social-genlayer/blob/main/evidence.json",
  mechanismUrl: "https://github.com/xiaoyu7799/copytrade-social-genlayer/blob/main/docs/mechanism.md",
};

export const EXPLORER_TX = (hash) => `https://explorer-studio.genlayer.com/tx/${hash}`;
export const EXPLORER_ADDRESS = (addr) => `https://explorer-studio.genlayer.com/address/${addr}`;
