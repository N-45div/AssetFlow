import type { WalletName } from "@solana/wallet-adapter-base";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { Keypair } from "@solana/web3.js";

const STORAGE_KEY = "assetflow-dev-wallet";

/**
 * The burner wallet, but it keeps its key in this browser's storage so a
 * reload is not a new identity. Local validator only: the key sits in plain
 * text, which is exactly as unsafe as it sounds.
 */
export class DevWalletAdapter extends UnsafeBurnerWalletAdapter {
  constructor() {
    super();
    (this as unknown as { name: WalletName }).name = "Dev wallet (localnet)" as WalletName;
  }

  async connect() {
    let keypair: Keypair;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      keypair = saved ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))) : Keypair.generate();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keypair.secretKey)));
    } catch {
      keypair = Keypair.generate();
    }
    // The parent keeps its key in a private field; signing reads it from there.
    (this as unknown as { _keypair: Keypair })._keypair = keypair;
    this.emit("connect", keypair.publicKey);
  }
}
