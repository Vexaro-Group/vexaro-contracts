import { Contract, type ContractTransactionResponse, getAddress, parseUnits } from "ethers";

import { STAKING_POOLS, type StakingPoolParams } from "../../deploy/params/stakingPools";
import { ARTIFACT, type Deployment, roleHash } from "./context";
import { exportAbi } from "./record";
import { type ContractName, PROXY_CONTRACTS } from "./types";

/**
 * One unit of the deployment: a thing that exists or a value that is set. The same list drives the run (apply what
 * differs), the dry-run (print what would be applied) and the post-deploy check (compare with the chain).
 */
export interface Step {
  id: string;
  /** Contract / area shown in the check table. */
  group: string;
  title: string;
  /**
   * Initial-state step: once recorded as done it is never re-applied and the check only reports the live value
   * (funding balances, limits the OPERATOR tunes, the active round).
   */
  soft?: boolean;
  /** The chain's value as text; "absent" when the thing does not exist yet. Never sends. */
  read(): Promise<string>;
  /** The value the params ask for. */
  want(): string;
  /** `have` satisfies `want`; default is equality, funding uses ">=". */
  ok?(have: string, want: string): boolean;
  /** Sends the transactions; afterwards the step must be done. */
  apply(): Promise<void>;
  /** Set when the deployer cannot send the step; the reason is reported and the step stays pending. */
  manual?(): Promise<string | undefined>;
}

export const ABSENT = "absent";
export const atLeast = (have: string, want: string) => {
  try {
    return BigInt(have) >= BigInt(want);
  } catch {
    return false;
  }
};

/** The faucet token mints at most this per call (TestUSDT.MAX_MINT). */
const MINT_CHUNK = parseUnits("100000", 18);

type Ref = ContractName | string;
const text = (v: unknown): string => String(v);
const addrText = (v: string): string => getAddress(v);

export const poolKey = (p: StakingPoolParams): string =>
  [
    p.dailyBps,
    p.periodDays,
    p.maxProfitBps,
    p.payoutMode,
    p.returnMode,
    p.ncRule,
    p.l1Bps,
    p.jumpEligible,
    p.usdtMin,
    p.usdtMax,
    p.releaseDays.join(","),
  ]
    .map(text)
    .join("/");

/** The pool version as the chain returns it, in the same text form as `poolKey`. */
const poolKeyOf = (v: {
  dailyBps: bigint;
  periodDays: bigint;
  maxProfitBps: bigint;
  payoutMode: bigint;
  returnMode: bigint;
  ncRule: bigint;
  l1Bps: bigint;
  jumpEligible: boolean;
  usdtMin: bigint;
  usdtMax: bigint;
  releaseDays: bigint[];
}): string =>
  poolKey({
    dailyBps: Number(v.dailyBps),
    periodDays: Number(v.periodDays),
    maxProfitBps: Number(v.maxProfitBps),
    payoutMode: Number(v.payoutMode) as 0 | 1,
    returnMode: Number(v.returnMode) as 0 | 1,
    ncRule: Number(v.ncRule) as 0 | 1,
    l1Bps: Number(v.l1Bps),
    jumpEligible: v.jumpEligible,
    usdtMin: v.usdtMin,
    usdtMax: v.usdtMax,
    releaseDays: [Number(v.releaseDays[0]), Number(v.releaseDays[1]), Number(v.releaseDays[2])],
  });

/** `Staking.pool(id)` reverts `UnknownPool` before the pool is added: that is "not launched, no version". */
async function poolInfo(c: Contract, id: number): Promise<{ launched: boolean; versions: bigint }> {
  try {
    const [launched, , versions] = await c.pool(id);
    return { launched, versions };
  } catch {
    return { launched: false, versions: 0n };
  }
}

/** All deploy, wiring, configuration and funding steps, in the order of the README checklist. */
export function buildSteps(d: Deployment): Step[] {
  const { params, hre } = d;
  const { ethers, upgrades } = hre;
  const steps: Step[] = [];
  const isName = (r: Ref): r is ContractName => !r.startsWith("0x");
  const resolve = (r: Ref): string => (isName(r) ? d.addr(r) ?? `<${r}>` : addrText(r));
  const show = (r: Ref) => (isName(r) ? d.label(r) : r);
  const usdt = () => d.addr("USDT") ?? params.usdt ?? "<USDT>";

  // ---------------------------------------------------------------- deployments
  const record = async (name: ContractName, address: string, txHash: string, block: number, impl?: string) => {
    d.record.contracts[name] = {
      address,
      ...(impl ? { implementation: impl } : {}),
      abi: d.dir ? await exportAbi(hre, d.dir, name, ARTIFACT[name]) : undefined,
      deployBlock: block,
      txHash,
    };
  };
  const deployStep = (
    name: ContractName,
    args: () => unknown[],
    describe: string,
    opts: { libraries?: () => Record<string, string> } = {},
  ) => {
    const proxy = PROXY_CONTRACTS.includes(name);
    steps.push({
      id: `deploy:${name}`,
      group: name,
      title: `deploy ${name}${proxy ? " (UUPS proxy)" : ""} ${describe}`.trim(),
      async read() {
        const known = d.record.contracts[name];
        if (!known) return ABSENT;
        if ((await ethers.provider.getCode(known.address)) === "0x")
          throw new Error(`${name} is recorded at ${known.address} but there is no code there (wrong network?)`);
        return known.address;
      },
      want: () => d.addr(name) ?? "deployed",
      ok: (have) => have !== ABSENT,
      async apply() {
        const libraries = opts.libraries?.();
        const factory = await ethers.getContractFactory(ARTIFACT[name], { signer: d.signer, libraries });
        const instance = proxy
          ? await upgrades.deployProxy(factory, args(), {
              kind: "uups",
              unsafeAllow: libraries ? ["external-library-linking"] : [],
              timeout: 0,
            })
          : await factory.deploy(...args());
        await instance.waitForDeployment();
        const tx = instance.deploymentTransaction();
        const receipt = await tx?.wait();
        if (!tx || !receipt) throw new Error(`${name}: no deployment receipt`);
        d.sent += 1;
        d.txHashes.push(tx.hash);
        d.lastBlock = receipt.blockNumber;
        const address = await instance.getAddress();
        const impl = proxy ? await upgrades.erc1967.getImplementationAddress(address) : undefined;
        await record(name, address, tx.hash, receipt.blockNumber, impl);
        await d.settle();
      },
    });
  };
  /** An address that exists already (the real USDT, the Chainlink feed): registered in the record, not deployed. */
  const externalStep = (name: "USDT" | "BnbFeed", address: string) => {
    steps.push({
      id: `external:${name}`,
      group: name,
      title: `use the existing ${name} ${address}`,
      async read() {
        return d.record.contracts[name]?.address ?? ABSENT;
      },
      want: () => addrText(address),
      ok: (have) => have !== ABSENT && addrText(have) === addrText(address),
      async apply() {
        if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${name} ${address}: no contract here`);
        d.record.contracts[name] = { address: addrText(address), external: true };
      },
    });
  };

  const admin = d.deployer;
  deployStep("Vexaro", () => [admin, admin, 0], "(supply to the deployer, fee 0 until the end)");
  deployStep("License", () => [admin, params.licenseBaseUri], "");
  if (params.usdt === undefined) deployStep("USDT", () => [], "(TestUSDT, test networks only)");
  else externalStep("USDT", params.usdt);
  if (params.bnbFeed.address === undefined)
    deployStep("BnbFeed", () => [8, 600n * 10n ** 8n], "(mock BNB/USD 600, local only)");
  else externalStep("BnbFeed", params.bnbFeed.address);
  deployStep("StakingMath", () => [], "(external library of Staking)");
  deployStep("Treasury", () => [admin], "");
  deployStep("NetworkFreeze", () => [], "(external library of Network)");
  deployStep("Network", () => [admin], "", { libraries: () => ({ NetworkFreeze: d.addr("NetworkFreeze")! }) });
  deployStep("PriceFeed", () => [admin], "");
  const a = (n: ContractName) => d.addr(n);
  deployStep("TokenSale", () => [admin, a("Vexaro"), usdt(), a("Treasury"), a("Network"), a("PriceFeed")], "");
  // Rewards does not exist yet: the vault is the deployer until setRewardVault (README checklist 2)
  deployStep("Staking", () => [admin, a("Vexaro"), a("Network"), a("PriceFeed"), admin], "", {
    libraries: () => ({ StakingMath: a("StakingMath")! }),
  });
  deployStep(
    "LicenseSale",
    () => [admin, a("License"), usdt(), a("Treasury"), a("Network"), a("PriceFeed"), a("Staking")],
    "",
  );
  deployStep("Rewards", () => [admin, a("Vexaro"), a("Network"), a("Staking"), a("PriceFeed")], "");
  deployStep("Jump", () => [admin, a("Vexaro"), a("Network"), a("Staking"), a("PriceFeed")], "");

  // ---------------------------------------------------------------- helpers
  /** A value read from `contract` and set with `write` when it differs. */
  const setting = (
    id: string,
    title: string,
    contract: ContractName,
    read: (c: Contract) => Promise<unknown>,
    want: () => string,
    write: (c: Contract) => Promise<ContractTransactionResponse>,
    opts: { soft?: boolean; ok?: Step["ok"]; manual?: Step["manual"]; tolerant?: boolean } = {},
  ) => {
    steps.push({
      id,
      group: contract,
      title,
      soft: opts.soft,
      ok: opts.ok,
      manual: opts.manual,
      async read() {
        const c = await d.attach(contract);
        if (c === undefined) return ABSENT;
        // `tolerant`: a getter the deployed code does not have yet (before the core upgrade) reads as absent
        if (!opts.tolerant) return text(await read(c));
        try {
          return text(await read(c));
        } catch {
          return ABSENT;
        }
      },
      want,
      async apply() {
        await d.send(write((await d.attach(contract))!));
      },
    });
  };
  /** A wired address that cannot be repaired by a setter (a constructor / initializer argument). */
  const fixed = (contract: ContractName, getter: string, target: ContractName) => {
    steps.push({
      id: `wired:${contract}.${getter}`,
      group: contract,
      title: `${contract}.${getter}() = ${target}`,
      async read() {
        const c = await d.attach(contract);
        return c === undefined ? ABSENT : addrText(await c[getter]());
      },
      want: () => d.addr(target) ?? `<${target}>`,
      async apply() {
        throw new Error(`${contract}.${getter}() points to another contract than the record says: redeploy by hand`);
      },
    });
  };
  const wired = (contract: ContractName, getter: string, target: ContractName, setter: string, tolerant = false) =>
    setting(
      `wired:${contract}.${getter}`,
      `${contract}.${setter}(${show(target)})`,
      contract,
      async (c) => addrText(await c[getter]()),
      () => resolve(target),
      (c) => c[setter](resolve(target)),
      { tolerant },
    );
  const role = (contract: ContractName, roleName: string, holder: Ref, holderName?: string) => {
    const hash = roleHash(roleName);
    setting(
      `role:${contract}.${roleName}->${holderName ?? (isName(holder) ? holder : holder)}`,
      `${contract}.grantRole(${roleName}, ${holderName ?? show(holder)})`,
      contract,
      (c) => c.hasRole(hash, resolve(holder)),
      () => "true",
      (c) => c.grantRole(hash, resolve(holder)),
    );
  };

  // ---------------------------------------------------------------- wiring: addresses
  fixed("TokenSale", "vex", "Vexaro");
  fixed("TokenSale", "usdt", "USDT");
  wired("TokenSale", "treasury", "Treasury", "setTreasury");
  wired("TokenSale", "network", "Network", "setNetwork");
  wired("TokenSale", "priceFeed", "PriceFeed", "setPriceFeed");
  fixed("LicenseSale", "license", "License");
  fixed("LicenseSale", "usdt", "USDT");
  wired("LicenseSale", "treasury", "Treasury", "setTreasury");
  wired("LicenseSale", "network", "Network", "setNetwork");
  wired("LicenseSale", "priceFeed", "PriceFeed", "setPriceFeed");
  wired("LicenseSale", "staking", "Staking", "setStaking");
  fixed("Staking", "vex", "Vexaro");
  wired("Staking", "network", "Network", "setNetwork");
  wired("Staking", "priceFeed", "PriceFeed", "setPriceFeed");
  fixed("Rewards", "vex", "Vexaro");
  wired("Rewards", "network", "Network", "setNetwork");
  wired("Rewards", "staking", "Staking", "setStaking");
  wired("Rewards", "priceFeed", "PriceFeed", "setPriceFeed");
  fixed("Jump", "vex", "Vexaro");
  wired("Jump", "network", "Network", "setNetwork");
  wired("Jump", "staking", "Staking", "setStaking");
  wired("Jump", "priceFeed", "PriceFeed", "setPriceFeed");
  // checklist 3 / 6 / 4
  wired("Network", "priceFeed", "PriceFeed", "setPriceFeed");
  wired("Staking", "rewardVault", "Rewards", "setRewardVault");
  wired("Staking", "jump", "Jump", "setJump");
  // the sell credit of VEX claims and Jump grants goes to the TokenSale
  wired("Rewards", "tokenSale", "TokenSale", "setTokenSale", true);
  wired("Jump", "tokenSale", "TokenSale", "setTokenSale", true);

  // ---------------------------------------------------------------- wiring: roles (checklist 3, 4, 5, 7)
  for (const hook of ["TokenSale", "Staking", "LicenseSale"] as const) role("Network", "REGISTRAR_ROLE", hook);
  role("Network", "STAKING_HOOK_ROLE", "Staking");
  role("Network", "LICENSE_HOOK_ROLE", "LicenseSale");
  role("Network", "WITHDRAWAL_HOOK_ROLE", "Rewards");
  role("Network", "REWARDS_ROLE", "Rewards");
  role("Staking", "GRANTER_ROLE", "Jump");
  role("Staking", "REWARDS_ROLE", "Rewards");
  role("Vexaro", "AIRDROP_SPENDER_ROLE", "Staking");
  role("Jump", "HOOK_ROLE", "Staking");
  role("Treasury", "PAYER_ROLE", "TokenSale");
  role("Treasury", "PAYER_ROLE", "LicenseSale");
  role("Treasury", "RESERVE_SPENDER_ROLE", "TokenSale");
  role("License", "MINTER_ROLE", "LicenseSale");
  role("License", "BURNER_ROLE", "LicenseSale");
  // GUARDIAN: granted by the OPERATOR (its role admin), on every contract that has the role
  for (const c of ["Network", "Staking", "TokenSale", "LicenseSale", "Rewards", "Jump"] as const)
    role(c, "GUARDIAN_ROLE", params.guardian, "guardian");
  // Rewards and Jump credit the platform-paid VEX on the TokenSale
  role("TokenSale", "SELL_CREDITOR_ROLE", "Rewards");
  role("TokenSale", "SELL_CREDITOR_ROLE", "Jump");

  // ---------------------------------------------------------------- VEX airdrop wallet
  setting(
    "vex.airdropWallet",
    `Vexaro.setAirdropWallet(${params.airdropWallet})`,
    "Vexaro",
    async (c) => addrText(await c.airdropWallet()),
    () => addrText(params.airdropWallet),
    (c) => c.setAirdropWallet(params.airdropWallet),
  );

  // ---------------------------------------------------------------- VEX fee exemptions (checklist 9)
  const exempt: Ref[] = ["TokenSale", "Staking", "Rewards", "Jump", params.airdropWallet, ...params.exemptions];
  const seen = new Set<string>();
  for (const who of exempt) {
    const key = isName(who) ? who : addrText(who);
    if (seen.has(key)) continue;
    seen.add(key);
    setting(
      `exempt:${key}`,
      `Vexaro.setExempt(${show(who)}, true)`,
      "Vexaro",
      (c) => c.isExempt(resolve(who)),
      () => "true",
      (c) => c.setExempt(resolve(who), true),
    );
  }

  // platform contracts that receive VEX refuse airdrop-locked VEX (the lock is enforced on the platform only)
  for (const who of ["TokenSale", "Staking", "Rewards", "Jump"] as const)
    setting(
      `restricted:${who}`,
      `Vexaro.setPlatformRestricted(${who}, true)`,
      "Vexaro",
      (c) => c.isPlatformRestricted(resolve(who)),
      () => "true",
      (c) => c.setPlatformRestricted(resolve(who), true),
    );

  // ---------------------------------------------------------------- Treasury
  const walletsText = (list: { account: string; rateBps: number | bigint }[]) =>
    list.map((w) => `${addrText(w.account)}:${w.rateBps}`).join(",") || "none";
  setting(
    "treasury.wallets",
    `Treasury.setWallets([${params.treasury.wallets.map((w) => `${w.account} ${w.rateBps} bps`).join(", ")}])`,
    "Treasury",
    async (c) => walletsText(await c.wallets()),
    () => walletsText(params.treasury.wallets),
    (c) =>
      c.setWallets(
        params.treasury.wallets.map((w) => w.account),
        params.treasury.wallets.map((w) => w.rateBps),
      ),
  );

  // ---------------------------------------------------------------- PriceFeed (checklist 8)
  const feed = params.vexPrice;
  setting(
    "feed.roundSource",
    "PriceFeed.setRoundSource(TokenSale)",
    "PriceFeed",
    async (c) => addrText(await c.roundSource()),
    () => resolve("TokenSale"),
    (c) => c.setRoundSource(resolve("TokenSale")),
  );
  if (feed.adapter)
    setting(
      "feed.adapter",
      `PriceFeed.setAdapter(${feed.adapter})`,
      "PriceFeed",
      async (c) => addrText(await c.adapter()),
      () => addrText(feed.adapter!),
      (c) => c.setAdapter(feed.adapter),
    );
  if (feed.manual !== undefined)
    setting(
      "feed.manualPrice",
      `PriceFeed.setManualPrice(${feed.manual} wei)`,
      "PriceFeed",
      (c) => c.manualPrice(),
      () => text(feed.manual),
      (c) => c.setManualPrice(feed.manual),
      { soft: true },
    );
  setting(
    "feed.bnbFeed",
    `PriceFeed.setBnbFeed(${show("BnbFeed")}, ${params.bnbFeed.maxAge} s)`,
    "PriceFeed",
    async (c) => `${addrText(await c.bnbFeed())} max age ${await c.bnbMaxAge()} s`,
    () => `${resolve("BnbFeed")} max age ${params.bnbFeed.maxAge} s`,
    (c) => c.setBnbFeed(resolve("BnbFeed"), params.bnbFeed.maxAge),
  );
  const MODES = ["ROUND", "MANUAL", "ADAPTER"];
  setting(
    "feed.mode",
    `PriceFeed.setVexPriceMode(${feed.mode})`,
    "PriceFeed",
    async (c) => MODES[Number(await c.vexPriceMode())],
    () => feed.mode,
    (c) => c.setVexPriceMode(MODES.indexOf(feed.mode)),
  );

  // ---------------------------------------------------------------- Network tables and LicenseSale prices
  const net = params.network;
  setting(
    "network.ncRates",
    "Network.setNcRates(default table)",
    "Network",
    async (c) => (await c.ncRates()).join(","),
    () => net.ncRates.join(","),
    (c) => c.setNcRates(net.ncRates),
  );
  setting(
    "network.lrRates",
    "Network.setLrRates(default table)",
    "Network",
    async (c) => (await c.lrRates()).join(","),
    () => net.lrRates.join(","),
    (c) => c.setLrRates(net.lrRates),
  );
  setting(
    "network.backFlow",
    `Network.setBackFlow(${net.backFlow.bps} bps, ${net.backFlow.levels} levels)`,
    "Network",
    async (c) => {
      const [bps, levels] = await c.backFlow();
      return `${bps} bps x ${levels}`;
    },
    () => `${net.backFlow.bps} bps x ${net.backFlow.levels}`,
    (c) => c.setBackFlow(net.backFlow.bps, net.backFlow.levels),
  );
  setting(
    "network.tierLevels",
    "Network.setTierLevels(default table)",
    "Network",
    async (c) => {
      const [nc, lr] = await c.tierLevels();
      return `nc ${nc.join(",")} lr ${lr.join(",")}`;
    },
    () => `nc ${net.tierLevels.nc.join(",")} lr ${net.tierLevels.lr.join(",")}`,
    (c) => c.setTierLevels(net.tierLevels.nc, net.tierLevels.lr),
  );
  for (const p of params.licensePrices)
    setting(
      `license.price:${p.tier}/${p.term}`,
      `LicenseSale.setPrice(tier ${p.tier}, ${p.term} d, ${p.usdt} wei)`,
      "LicenseSale",
      async (c) => {
        const [price, onSale] = await c.priceOf(p.tier, p.term);
        return `${price} on sale ${onSale}`;
      },
      () => `${p.usdt} on sale true`,
      (c) => c.setPrice(p.tier, p.term, p.usdt, true),
    );

  // ---------------------------------------------------------------- Staking: pools and refund cap (checklist 10, 11)
  for (const pool of STAKING_POOLS) {
    setting(
      `pool:${pool.id}.version`,
      `Staking.addPoolVersion(${pool.id}, ${pool.code})`,
      "Staking",
      async (c) => {
        const { versions } = await poolInfo(c, pool.id);
        return versions === 0n ? ABSENT : poolKeyOf(await c.poolVersion(pool.id, 1));
      },
      () => poolKey(pool.params),
      async (c) => {
        const { versions } = await poolInfo(c, pool.id);
        if (versions !== 0n)
          throw new Error(`pool ${pool.code} (${pool.id}) exists with other parameters: add a new version by hand`);
        return c.addPoolVersion(pool.id, pool.params);
      },
    );
    if (params.launch === "all" || pool.launchAtGoLive)
      setting(
        `pool:${pool.id}.launch`,
        `Staking.launchPool(${pool.id}, ${pool.code})`,
        "Staking",
        async (c) => (await poolInfo(c, pool.id)).launched,
        () => "true",
        (c) => c.launchPool(pool.id),
      );
  }
  for (const pool of STAKING_POOLS)
    setting(
      `pool:${pool.id}.airdropAllowed`,
      `Staking.setPoolAirdropAllowed(${pool.id}, ${pool.airdropAllowed}) (${pool.code})`,
      "Staking",
      async (c) => (await c.pool(pool.id))[3],
      () => text(pool.airdropAllowed),
      (c) => c.setPoolAirdropAllowed(pool.id, pool.airdropAllowed),
    );
  for (const pool of STAKING_POOLS.filter((p) => p.halves))
    setting(
      `pool:${pool.id}.halves`,
      `Staking.enablePoolHalves(${pool.id}) (${pool.code})`,
      "Staking",
      (c) => c.poolHalves(pool.id),
      () => "true",
      (c) => c.enablePoolHalves(pool.id),
      { tolerant: true },
    );
  setting(
    "staking.refundCap",
    `Staking.setRefundCapUsdt(${params.caps.refundUsdt} wei)`,
    "Staking",
    (c) => c.refundCapUsdt(),
    () => text(params.caps.refundUsdt),
    (c) => c.setRefundCapUsdt(params.caps.refundUsdt),
    { soft: true },
  );

  // ---------------------------------------------------------------- Rewards: caps and the whole-balance switch
  // the USDT License limit is gone, the VEX limit is the only one
  setting(
    "rewards.cap.rewardVex",
    `Rewards.setDailyCap(Vexaro, ${params.caps.rewardVex} wei)`,
    "Rewards",
    async (c) => (await c.capsOf()).capUsdt,
    () => text(params.caps.rewardVex),
    (c) => c.setDailyCap(resolve("Vexaro"), params.caps.rewardVex),
    { soft: true },
  );
  // ---------------------------------------------------------------- TokenSale: sell at the current price
  setting(
    "tokenSale.currentSellFee",
    `TokenSale.setCurrentSellFee(${params.currentSell.feeBps} bps)`,
    "TokenSale",
    (c) => c.currentSellFeeBps(),
    () => text(params.currentSell.feeBps),
    (c) => c.setCurrentSellFee(params.currentSell.feeBps),
  );
  for (const [key, index, setter] of [
    ["accountCapUsdt", 0, "setCurrentSellAccountCap"],
    ["globalCapUsdt", 1, "setCurrentSellGlobalCap"],
  ] as const)
    setting(
      `tokenSale.currentSell.${key}`,
      `TokenSale.${setter}(${params.currentSell[key]} wei)`,
      "TokenSale",
      async (c) => (await c.currentSellCaps())[index],
      () => text(params.currentSell[key]),
      (c) => c[setter](params.currentSell[key]),
      { soft: true },
    );
  // the fixed part of the reserve floor; DEFAULT_ADMIN changes it
  setting(
    "tokenSale.reserveFloorFixed",
    `TokenSale.setReserveFloorFixed(${params.reserveFloorFixedUsdt ?? 0n} wei)`,
    "TokenSale",
    async (c) => (await c.reserveFloor())[2],
    () => text(params.reserveFloorFixedUsdt ?? 0n),
    (c) => c.setReserveFloorFixed(params.reserveFloorFixedUsdt ?? 0n),
    { soft: true, tolerant: true },
  );
  // GUARDIAN freezes per UTC day (the OPERATOR tunes it)
  setting(
    "network.guardianFreezeBudget",
    `Network.setGuardianFreezeBudget(${params.guardianFreezeBudget ?? 50})`,
    "Network",
    async (c) => (await c.guardianFreezeBudget())[0],
    () => text(params.guardianFreezeBudget ?? 50),
    (c) => c.setGuardianFreezeBudget(params.guardianFreezeBudget ?? 50),
    { soft: true, tolerant: true },
  );
  setting(
    "rewards.wholeBalance",
    `Rewards.setWholeBalanceWhenHalfBelowMin(${params.wholeBalanceWhenHalfBelowMin})`,
    "Rewards",
    (c) => c.wholeBalanceWhenHalfBelowMin(),
    () => text(params.wholeBalanceWhenHalfBelowMin),
    (c) => c.setWholeBalanceWhenHalfBelowMin(params.wholeBalanceWhenHalfBelowMin),
  );

  // ---------------------------------------------------------------- TokenSale rounds
  params.rounds.forEach((r, i) => {
    const n = i + 1;
    setting(
      `round:${n}.add`,
      `TokenSale.addRound(${r.price} wei, ${r.allocation} wei)`,
      "TokenSale",
      async (c) => {
        const list = await c.rounds();
        return list.length < n ? ABSENT : `${list[i].price} price, ${list[i].allocation} allocation`;
      },
      () => `${r.price} price, ${r.allocation} allocation`,
      async (c) => {
        if ((await c.rounds()).length !== i)
          throw new Error(`TokenSale has ${(await c.rounds()).length} rounds, round ${n} cannot be added in order`);
        return c.addRound(r.price, r.allocation);
      },
    );
  });

  // the OPERATOR opens the round afterwards (initial state only)
  if (params.activeRound > 0)
    setting(
      "round:active",
      `TokenSale.setActiveRound(${params.activeRound})`,
      "TokenSale",
      (c) => c.currentRound(),
      () => text(params.activeRound),
      (c) => c.setActiveRound(params.activeRound),
      { soft: true },
    );

  // ---------------------------------------------------------------- funding (initial state only)
  const operatorFund = (
    id: string,
    title: string,
    contract: ContractName,
    amount: bigint,
    balance: (c: Contract) => Promise<bigint>,
    fund: (c: Contract, need: bigint) => Promise<ContractTransactionResponse>,
  ) => {
    if (amount <= 0n) return;
    setting(
      id,
      title,
      contract,
      balance,
      () => text(amount),
      async (c) => {
        const vex = (await d.attach("Vexaro"))!;
        const need = amount - (await balance(c));
        if ((await vex.allowance(d.deployer, c.target)) < need) await d.send(vex.approve(c.target, need));
        return fund(c, need);
      },
      { soft: true, ok: atLeast },
    );
  };
  const vexBalance = async (c: Contract) => (await (await d.attach("Vexaro"))!.balanceOf(c.target)) as bigint;
  for (const f of params.roundFunding)
    operatorFund(
      `round:${f.round}.fund`,
      `TokenSale.fundRound(${f.round}, ${f.amount} wei VEX) from the deployer`,
      "TokenSale",
      f.amount,
      async (c) => (await c.roundOf(f.round)).funded,
      (c, need) => c.fundRound(f.round, need),
    );
  operatorFund(
    "fund.rewards",
    `Rewards.fund(${params.funding.rewardsVault} wei VEX)`,
    "Rewards",
    params.funding.rewardsVault,
    vexBalance,
    (c, need) => c.fund(need),
  );
  operatorFund(
    "fund.jump",
    `Jump.fund(${params.funding.jump} wei VEX)`,
    "Jump",
    params.funding.jump,
    vexBalance,
    (c, need) => c.fund(need),
  );

  // the airdrop wallet's share: an exact transfer from the supply holder (initial state: the wallet spends it later)
  if (params.airdropAmount > 0n)
    steps.push({
      id: "fund.airdrop",
      group: "Vexaro",
      title: `Vexaro.transfer(airdrop wallet ${params.airdropWallet}, ${params.airdropAmount} wei VEX) from the deployer`,
      soft: true,
      ok: atLeast,
      async read() {
        const vex = await d.attach("Vexaro");
        return vex ? text(await vex.balanceOf(params.airdropWallet)) : ABSENT;
      },
      want: () => text(params.airdropAmount),
      async apply() {
        const vex = (await d.attach("Vexaro"))!;
        const need = params.airdropAmount - ((await vex.balanceOf(params.airdropWallet)) as bigint);
        await d.send(vex.transfer(params.airdropWallet, need));
      },
    });

  // test token: faucet mints in chunks (the TestUSDT caps one call)
  const mintTo = async (to: string, amount: bigint) => {
    const token = new Contract(
      d.addr("USDT")!,
      (await hre.artifacts.readArtifact("TestUSDT")).abi,
      d.signer ?? ethers.provider,
    );
    for (let left = amount; left > 0n; ) {
      const chunk = left > MINT_CHUNK ? MINT_CHUNK : left;
      await d.send(token.mint(to, chunk));
      left -= chunk;
    }
  };
  const usdtToken = async () =>
    new Contract(d.addr("USDT")!, (await hre.artifacts.readArtifact("TestUSDT")).abi, d.signer ?? ethers.provider);
  for (const m of params.usdtMints)
    steps.push({
      id: `mint:USDT->${addrText(m.to)}`,
      group: "USDT",
      title: `TestUSDT.mint(${m.to}, ${m.amount} wei) in chunks`,
      soft: true,
      ok: atLeast,
      async read() {
        return d.addr("USDT") ? text(await (await usdtToken()).balanceOf(m.to)) : ABSENT;
      },
      want: () => text(m.amount),
      async apply() {
        await mintTo(m.to, m.amount - ((await (await usdtToken()).balanceOf(m.to)) as bigint));
      },
    });

  // Treasury reserve: the USDT the sell-back and the current-price sales are paid from
  steps.push({
    id: "treasury.reserve",
    group: "Treasury",
    title: `Treasury reserve: reserveOf(USDT) >= ${params.treasury.reserveUsdt} wei`,
    soft: true,
    ok: atLeast,
    async read() {
      const t = await d.attach("Treasury");
      return t && d.addr("USDT") ? text(await t.reserveOf(d.addr("USDT"))) : ABSENT;
    },
    want: () => text(params.treasury.reserveUsdt),
    async manual() {
      // only the real USDT needs a holder to send it; the TestUSDT is minted
      if (!d.record.contracts.USDT?.external) return undefined;
      const t = await d.attach("Treasury");
      if (!t) return undefined;
      const missing = await missingReserve(t);
      if (missing <= 0n) return undefined;
      const balance = (await (await usdtToken()).balanceOf(d.deployer)) as bigint;
      return balance >= missing
        ? undefined
        : `the deployer holds ${balance} wei USDT, the reserve needs ${missing} more: send it to ${d.deployer}`;
    },
    async apply() {
      const t = (await d.attach("Treasury"))!;
      const token = await usdtToken();
      const need: bigint = params.treasury.reserveUsdt - (await t.reserveOf(d.addr("USDT")));
      const missing = await missingReserve(t);
      if (missing > 0n) {
        if (d.record.contracts.USDT?.external) await d.send(token.transfer(d.addr("Treasury"), missing));
        else await mintTo(d.addr("Treasury")!, missing);
      }
      await d.send(t.fundReserve(d.addr("USDT"), need));
    },
  });
  async function missingReserve(t: Contract): Promise<bigint> {
    const need: bigint = params.treasury.reserveUsdt - (await t.reserveOf(d.addr("USDT")));
    return need - ((await t.excessOf(d.addr("USDT"))) as bigint);
  }

  // the rest of the VEX supply leaves the deployer once everything is funded
  if (addrText(params.vexRemainderTo) !== addrText(d.deployer))
    steps.push({
      id: "vex.remainder",
      group: "Vexaro",
      title: `Vexaro.transfer(${params.vexRemainderTo}, the deployer's remaining VEX)`,
      soft: true,
      async read() {
        const vex = await d.attach("Vexaro");
        return vex ? text(await vex.balanceOf(d.deployer)) : ABSENT;
      },
      want: () => "0",
      async apply() {
        const vex = (await d.attach("Vexaro"))!;
        await d.send(vex.transfer(params.vexRemainderTo, await vex.balanceOf(d.deployer)));
      },
    });

  // fee last: every exemption is in place before the first charged transfer
  setting(
    "vex.fee",
    `Vexaro.setFee(${params.vexFeeBps} bps)`,
    "Vexaro",
    (c) => c.feeBps(),
    () => text(params.vexFeeBps),
    (c) => c.setFee(params.vexFeeBps),
  );

  return steps;
}

/** The step title with the `<Contract>` placeholders of the build replaced by the addresses known by now. */
export const titleOf = (d: Deployment, step: Step): string =>
  step.title.replace(/<(\w+)>/g, (m, name: ContractName) => d.addr(name) ?? m);
