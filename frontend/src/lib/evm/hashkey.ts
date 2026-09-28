/**
 * AssetFlow's EVM contracts on HashKey Chain mainnet (chain 177), the version
 * this project started as. Deployed 11 May 2026; recorded in
 * contracts/deployments/hashkey-mainnet.json.
 */
export const HASHKEY_MAINNET = {
  chainId: 177,
  deployedAt: "2026-05-11",
  explorer: "https://hsk.blockscout.com",
  contracts: [
    { key: "registry", address: "0xd06ea0b9AD8935df0e823555F0433604B880711D" },
    { key: "token", address: "0x59E0f69FF6d25b5ceE757c874adAdC42E9857f2A" },
    { key: "distribution", address: "0x93995825CA13fBbf74f6876480bf7565f33a8717" },
    { key: "redemption", address: "0x7495d785B5edA74E2c3ebc4B4c0909DeF86078bB" },
  ],
} as const;

export const hashkeyAddressUrl = (address: string) => `${HASHKEY_MAINNET.explorer}/address/${address}`;
