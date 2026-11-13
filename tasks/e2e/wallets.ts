import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { dirname, isAbsolute, relative, resolve } from "path";

export interface WalletKey {
  name: string;
  address: string;
  privateKey: string;
}

/** The keys file must be outside the repository and new (an existing file may hold keys of funded wallets). */
export function assertWalletsPath(hre: HardhatRuntimeEnvironment, path: string): string {
  const target = resolve(path);
  const rel = relative(hre.config.paths.root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`--wallets-out ${target} is inside the repository: choose a path outside it`);
  }
  if (existsSync(target))
    throw new Error(`--wallets-out ${target} exists: it may hold the keys of funded wallets, choose a new file`);
  return target;
}

/** The generated wallets' keys go to a file outside the repo, mode 600, before any transaction funds them. */
export function writeWallets(hre: HardhatRuntimeEnvironment, path: string, wallets: WalletKey[]): void {
  const target = assertWalletsPath(hre, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify({ note: "throwaway BSC testnet wallets of task:e2e", wallets }, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );
  chmodSync(target, 0o600);
}
