# Vexaro Contracts [![Hardhat][hardhat-badge]][hardhat] [![License: MIT][license-badge]][license]

[hardhat]: https://hardhat.org/
[hardhat-badge]: https://img.shields.io/badge/Built%20with-Hardhat-FFDB1C.svg
[license]: https://opensource.org/licenses/MIT
[license-badge]: https://img.shields.io/badge/License-MIT-blue.svg

Smart contracts for the Vexaro ecosystem: the VEX token, license NFTs, the token and license sales with on-chain rounds
and prices, staking with its pools and exit rules, the partner network (bonus accounting), the reward vault and claims,
VEX Jump (grants) and a treasury that splits sale payments. No backend key signs a transaction: the rules live in the
contracts. Live on BSC mainnet (chain 56, `deployments/bsc.json`, evm `cancun`) and on BSC testnet (chain 97). The
contracts were first deployed from commit `5595fb3` and have been upgraded in place since (UUPS, see "Upgrades").

- [Hardhat](https://github.com/nomiclabs/hardhat): compile, run and test smart contracts
- [TypeChain](https://github.com/ethereum-ts/TypeChain): generate TypeScript bindings for smart contracts
- [Ethers](https://github.com/ethers-io/ethers.js/): renowned Ethereum library and wallet implementation
- [Solhint](https://github.com/protofire/solhint): code linter
- [Solcover](https://github.com/sc-forks/solidity-coverage): code coverage
- [Slither](https://github.com/crytic/slither): static analysis (see `docs/slither.md`)
- [Prettier Plugin Solidity](https://github.com/prettier-solidity/prettier-plugin-solidity): code formatter

## Contracts

| Contract    | Type             | Role                                                                                                                                                                                                                     |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vexaro      | Plain ERC20      | VEX: 1B fixed supply, burnable, votes/permit, up to 1 % burn fee between non-exempt accounts; VEX airdropped by the one airdrop wallet is locked (only `stakeAirdrop` or back to the wallet)                             |
| License     | Plain ERC1155    | License NFTs, id = tier x 1000 + days; minted by LicenseSale, burned on activation                                                                                                                                       |
| Treasury    | UUPS upgradeable | Collects sale payments (USDT / BNB), sends each wallet its share with the payment and keeps the rest as a reserve (payouts); DEFAULT_ADMIN can take the BNB reserve out (`withdrawBnbReserve`)                           |
| TokenSale   | UUPS upgradeable | on-chain rounds and prices, buy with USDT / BNB, lots per round, FIFO sell-back (`ITokenSale`)                                                                                                                           |
| LicenseSale | UUPS upgradeable | on-chain price table (tier x term), any tier in any order, buy with USDT / BNB, free Lite, activation; License Rewards on purchases                                                                                      |
| Staking     | UUPS upgradeable | pools with versions, stakes, lazy accrual, maturity / vesting, early close, income, sums (`IStaking`)                                                                                                                    |
| Rewards     | UUPS upgradeable | the reward-VEX vault and the two claims (staking / cashback VEX; there is no USDT License claim) with every withdrawal rule, 90 / 5 / 5 split, BackFlow trigger, daily caps                                              |
| Jump        | UUPS upgradeable | VEX Jump - 7-day cycles from the first on-chain transaction, 4 slots per cycle filled by the sponsor's invitees' first P1-P5 stakes, a grant (JUMP stake) after a 72 h review in which GUARDIAN / OPERATOR can reject it |
| PriceFeed   | UUPS upgradeable | `vexPrice()` (ROUND / MANUAL / ADAPTER mode) and `bnbPrice()` (Chainlink BNB/USD, max age), conversions                                                                                                                  |
| Network     | UUPS upgradeable | membership and sponsor tree, freeze registry, sell block, license mirror and bonus-cap state, NC / LR / BF distribution, claimable bonus balances (accounting only)                                                      |

Shared code: `libraries/SalePayment.sol` (the payment of the sales: pricing in USDT / BNB, transfer-then-notify into the
Treasury and the BNB refund, as internal functions, no state), `libraries/StakingMath.sol` (Staking's validation,
accrual and vesting maths, linked) and `libraries/NetworkFreeze.sol` (the freeze registry of Network, linked). All
upgradeable state lives in ERC-7201 namespaced slots, so children append storage freely.

**Base (`abstracts/Managed.sol`).** The upgradeable contracts (business logic on-chain) share one UUPS base: no backend
signature, no EIP-712, no id bitmap. It holds the roles, three independent pause flags, the transient reentrancy guard
and the upgrade authorisation (state in the ERC-7201 slot `vexaro.storage.Managed`). `PriceFeed`, `Network`,
`TokenSale`, `Staking`, `LicenseSale`, `Rewards` and `Jump` are on it; `Treasury` has its own roles (`DEFAULT_ADMIN`,
`UPGRADER`, `PAYER`, `RESERVE_SPENDER`).

| Role                        | Held by                  | Can                                                                                                                                                                                                               |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_ADMIN`, `UPGRADER` | Timelock, 24 h (mainnet) | upgrades, wiring, rule parameters (PriceFeed: price mode, sources, BNB feed, max age)                                                                                                                             |
| `OPERATOR`                  | Safe, at once            | daily limits, launches, funding; pause and unpause `ENTRIES` / `REWARDS`; PriceFeed: `setManualPrice`                                                                                                             |
| `GUARDIAN`                  | main backend key         | pause `ENTRIES` / `REWARDS` only: never unpause, never touch `EXITS`; never granted by the initializer; its role admin is `OPERATOR` (not `DEFAULT_ADMIN`), so the Safe revokes and replaces a leaked key at once |
| `EXIT_PAUSER`               | Safe only                | pause and unpause `EXITS` (the only account that can)                                                                                                                                                             |

**Governance on BSC mainnet: a 24-hour timelock over the governance roles.** `DEFAULT_ADMIN` and `UPGRADER` of every
contract (the admin roles of the VEX token and the license included) and the VEX token's `FEE_MANAGER` and
`EXEMPT_MANAGER` are held by one OpenZeppelin `TimelockController` with a delay of exactly 24 hours (86 400 s) and no
admin (it administers itself, so the delay changes only through the timelock). The 2-of-3 Safe is its only proposer,
canceller and executor. A governance change is therefore: the Safe schedules it (`scheduleBatch`), 24 hours pass, the
Safe executes it (`executeBatch`); the Safe can cancel it in between, and nobody can act on a governance role directly,
the Safe included. `OPERATOR`, `EXIT_PAUSER`, `AIRDROP_RELEASER` and the License `MINTER` / `PAUSER` stay with the Safe
and act at once; `GUARDIAN` stays with the guardian key. The roles went to the Safe first (`handoverMode: "safe"`),
`task:governance:timelock` moved the governance roles to the timelock, and the deployer then gave up everything it held,
`DEFAULT_ADMIN` last (`--renounce-admin`), so **no account administers anything outside the timelock and the deployer
has no backup** ([docs/deploy.md](docs/deploy.md#17-governance-through-a-24-hour-timelock)). The BSC testnet runs in
`timelock` mode, with its own timelock between the multisig and the contracts.

Pause flags (`pause(flags)` / `unpause(flags)`, a bit set, `pausedFlags()`, `paused(flag)`, events `Paused(flags, by)` /
`Unpaused(flags, by)` carrying the flags that changed): `ENTRIES` = 1 (new stakes, buys, license purchases), `REWARDS` =
2 (reward claims), `EXITS` = 4 (matured closes and vested claims, kept open while the others are paused). A mixed set
needs the authority for every part; an empty or unknown set reverts `InvalidFlags`, a call that changes nothing reverts
`NoChange`. Entry points use `whenNotPaused(FLAG)` (`EnforcedPause(flag)`).

**PriceFeed prices** (USDT wei per whole unit, 18 decimals; USDT counted as 1 USD):

- `vexPrice()` by mode, chosen by `DEFAULT_ADMIN` (`setVexPriceMode`, only once the mode's source is set): `ROUND` = the
  active sale round (`IRoundPriceSource.currentRoundPrice()`, implemented by TokenSale), `MANUAL` = the price the
  `OPERATOR` stored (`setManualPrice`, > 0), `ADAPTER` = `IVexPriceAdapter.vexPrice()` (the exchange-rate / TWAP
  adapter). No valid price (no active round, 0, a failing source) reverts `PriceUnavailable`.
- `bnbPrice()` reads the Chainlink feed set by `setBnbFeed(feed, maxAge)`: `InvalidPrice` for an answer <= 0 (or one
  that scales to 0), `PriceUnavailable` for a failing feed, an incomplete round or a timestamp in the future,
  `StalePrice` for an answer older than `maxAge` seconds (exactly `maxAge` is accepted) or from an older round than the
  latest. The feed's decimals are scaled to 18 (up or down, rounding towards zero, no overflow).
- `usdtToVex(usdt)` = floor(usdt x 1e18 / price), `usdtToVexCeil(usdt)` = the ceiling (payments), `vexToUsdt(vex)` =
  floor(vex x price / 1e18), all at the current `vexPrice()`.

Every UUPS contract above (including PriceFeed) must be deployed via `upgrades.deployProxy`, never via a plain `deploy`;
`Vexaro` and `License` are deployed directly. VEX burns up to 1 % (`feeBps`, cap `MAX_FEE_BPS` = 100, set by
`FEE_MANAGER_ROLE`) of every transfer between non-exempt accounts (`EXEMPT_MANAGER_ROLE` manages `isExempt`; the supply
recipient is exempt); mint and burn are never charged; no ERC1363.

**Network (`Network.sol`)** is the accounting of the partner structure; it holds no tokens. It keeps the tree, the
freezes and the cap state and runs the NC / LR / BF distribution. Other contracts use it through
`interfaces/INetwork.sol`.

- **Membership and sponsor tree.** A contract holding `REGISTRAR_ROLE` (TokenSale / Staking / LicenseSale, granted by
  `DEFAULT_ADMIN`) calls `register(account, sponsor)` in the account's first buy / stake / license transaction. The
  first call registers the account (sponsor `0` = none) and returns `true`; every later call is a no-op returning
  `false`, so callers always pass it. The sponsor is final, must differ from the account (`SelfSponsor`) and may be any
  address, also one that has not joined yet (it keeps its invitees and gets its own sponsor in its own first
  transaction). Depth: the chain from the sponsor up to the top has at most 255 accounts for every join (`TreeTooDeep`).
  The number of accounts above a member is stored once it cannot change any more, that is when the whole chain above it
  is registered (`depths`, one slot), so a join under such a chain costs the same at any depth (about 85 k gas incl. 21
  k intrinsic). A chain that ends in an account that has not joined yet is walked (at most 255 steps, about 4.2 k gas
  per level) because that account may still get a sponsor, and so are the members registered before `depths` existed;
  the first walk stores the sponsor's entry. Cycle check: only an account that was already named as a sponsor
  (`directCount != 0`) can be on a chain, so only its join walks to the top whatever is stored: the account on it
  reverts `SponsorCycle`. Event `Joined(account, sponsor, at)`. Views `isMember`, `isActive` (= registered and not
  frozen), `sponsorOf`, `joinedAt`, `directCount`, `ancestors(account, maxDepth <= 15)` (nearest first), `memberOf`.
- **Freeze.** `freeze(account, reason)` by `GUARDIAN` or `OPERATOR`, `unfreeze(account)` by `OPERATOR` only. Every
  freeze is an interval `(from, until, reason)` (`until = 0`: still frozen), at most 32 per account (`FreezeLimit`);
  freezing a frozen or unfreezing a free account reverts `NoChange`. `isFrozen`, `freezeCount`, `freezeIntervals`, and
  `isFrozenAt(account, t)` (`from <= t < until`; Staking skips reward moments inside an interval). Events `Frozen` /
  `Unfrozen`.
- **Voiding a freeze.** A freeze by a leaked or mistaken GUARDIAN must not cost the account its income. OPERATOR
  `voidFreeze(account, index)` makes interval `index` empty (`until = from`); StakingMath reads an empty interval as
  "nothing frozen", so Staking pays every moment of it again (accrual is recomputed from the intervals; Staking and
  StakingMath did not change). Voiding the open interval also unfreezes (`FreezeVoided(account, index, wasOpen, by)`,
  then `Unfrozen`). `unfreezeMany(accounts, voidOpenInterval)` (OPERATOR, 1..`MAX_BATCH` = 100 accounts, accounts that
  are not frozen are skipped) lifts or voids in one transaction with the same per-account events. A voided (empty)
  interval does not count against `MAX_FREEZES`: when an account has 32 intervals, `freeze` first drops the empty ones,
  keeping the order of the others (the indexes of later intervals move down: read `freezeIntervals` again; `FreezeLimit`
  only when 32 non-empty ones remain). **What a void restores:** the STAKING accrual of the voided moments (claimable
  like any income) and the partner credits (NC / LR / BF) that were skipped while the account was frozen (`SKIP_FROZEN`)
  in the open interval. Each skip that would have been credited without the freeze (running license, level paid, cap
  base set) adds its share to a per-program sum, `missedBonus[account]` (2 slots). A void of the open interval
  (`voidFreeze` or `unfreezeMany` with `voidOpenInterval`) credits the sums within the cap room the account has at that
  moment: license running, `credit = min(sum, room)` per program in the order NC, LR, BF, the credit raises the counters
  and the used counter like any credit, `CapReached` is sent when it fills the cap, and what does not fit is dropped;
  one `MissedBonusRestored(beneficiary, program, wanted, credit)` per program that had a sum (`credit` 0 when there was
  no room). An ordinary `unfreeze`, `unfreezeMany` without `voidOpenInterval` and any void of an interval that is
  already closed restore nothing: the sums of a closed interval were discarded when it ended. Intervals that were open
  before this record existed have no sums. Income an account already claimed during the freeze is final. `isFrozenAt` is
  kept as an off-chain view.
- **GUARDIAN freeze budget.** A GUARDIAN key may freeze at most `guardianFreezeBudget` accounts per UTC day (default 50;
  OPERATOR `setGuardianFreezeBudget(n)`, event `GuardianFreezeBudgetSet`, 0 stops GUARDIAN freezes; the view returns
  `(budget, usedToday, left)`); beyond it `FreezeBudgetExceeded(used, budget)`. OPERATOR freezes are not counted nor
  limited. A leaked key can therefore freeze 50 accounts a day, and the Safe undoes it with `unfreezeMany(..., true)`
  without loss of income.
- **License Rewards owed.** `licenseOwed()` = the legacy (USDT) License Rewards that an earlier Network version credited
  and that were not claimed (USDT wei). License Rewards are VEX and nothing raises or lowers it any more; it is 0 on
  mainnet, where no license was bought while they were still paid in USDT, and nothing reads it.
- **Sell block.** `blockSell(account, reason)` (`GUARDIAN` or `OPERATOR`), `unblockSell(account)` (`OPERATOR` only),
  `isSellBlocked`; events `SellBlocked` / `SellUnblocked`.
- **License mirror and cap.** Hooks `onActivated(account, tier 0..4, expiresAt)` (LICENSE_HOOK_ROLE: tier, expiry,
  activation counter + 1, cap counter reset) and `setCapBase(account, base)` (STAKING_HOOK_ROLE: the principal of the
  account's LARGEST open own stake, USER or AIRDROP, never JUMP, VEX wei). `licenseOf` (active while `expiresAt > now`,
  to the second), `capOf` = `(base, limit, used, room)` with limit 200 % of the base (Lite 100 %), 0 without an active
  license. The used counter is raised by the distribution (below) and reset by every `onActivated`, except by a Lite
  that replaces a Lite which is still running (it keeps the counter and the cap notice); a Lite activated after the
  previous one ended, the 30-day renewal, resets it.
- **Hook roles.** One role per caller instead of the single `HOOK_ROLE` (the constant stays for the ABI, nothing checks
  it): `REGISTRAR_ROLE` for `register` (TokenSale, Staking, LicenseSale), `LICENSE_HOOK_ROLE` for `onActivated` and
  `onLicenseBought` (LicenseSale), `STAKING_HOOK_ROLE` for `setCapBase`, `markDeducted` and `onStakeOpened` (Staking and
  its StakingMath library, which runs in Staking's context), `WITHDRAWAL_HOOK_ROLE` for `onWithdrawal` (Rewards).
  `initializeV3(tokenSale, staking, licenseSale, rewards)` (reinitializer 3, DEFAULT_ADMIN) is the upgrade step of a
  live Network: it revokes `HOOK_ROLE` from the four addresses (each must hold it) and grants the roles above.
- **Storage** (ERC-7201 `vexaro.storage.Network`): one packed slot per account for each of Member (sponsor, joinedAt,
  registered / frozen / sellBlocked, directCount), License (tier, expiresAt, activationSeq) and Cap (base, used as
  uint128 VEX wei: the supply is 1e27); License also holds the `capReached` flag; the freeze intervals are an array of
  one packed slot each; the bonus counters (below) in three slots per account; then the rate tables and the PriceFeed
  address (appended after the initial layout).
- **Bonus counters.** Per account `vexCum` (every partner credit ever made, VEX wei, raised in the credit transaction)
  and the mark `vexDeducted`. `bonusTotals(account)` returns `(vexCum, usdtCum, vexDeducted, usdtDeducted)`: the USDT
  halves are always 0 (an earlier Network version credited License Rewards in USDT, testnet only; the storage fields
  stay for the layout, nothing reads them, `bonusBalances(...)[1]` is 0 too and `consumeBonus` refuses kind 1). The
  STAKING_HOOK_ROLE-only `markDeducted(account, vexCum, usdtCum)` moves the mark up (never down) to `vexCum`, which may
  not exceed the credits made (`MarkAboveTotal`), ignores `usdtCum`, and emits `BonusDeducted(account, mark, 0)`.
  Staking uses them for the early-close deduction.
- **Distribution.** Three HOOK-only triggers, each in the transaction of the event:
  `onStakeOpened(account, principal, ncRule, l1Bps)` (Network Cashback, called by Staking for USER stakes after the
  stake is recorded and `setCapBase` ran; ncRule 0 = by license levels, 1 = level 1 only at the pool's `l1Bps` for any
  active license), `onLicenseBought(account, usdtValue)` (License Rewards, LicenseSale) and
  `onWithdrawal(account, gross)` (BackFlow, Rewards). The walk goes up the sponsor chain, nearest first, to the
  program's depth (NC 15, LR 10, BF 10, fewer if the tier table says so). An ancestor is skipped (event
  `BonusSkipped(beneficiary, source, program, depth, reason)`; reasons `SKIP_FROZEN` 1, `NO_LICENSE` 2 (to the second),
  `LEVEL` 3 (not paid by its tier), `NO_BASE` 4 (no open own stake), `CAP_FULL` 5, `DUST` 6, `NO_PRICE` 7) or credited:
  `wanted = floor(A * rate / 10 000)`, `credit = min(wanted, cap room)`; the credit raises the cashback VEX balance (NC,
  LR, BF), the cap `used` counter (VEX) and the bonus counters (`vexCum`), and emits
  `BonusCredited(beneficiary, source, program, depth, rateBps, wanted, credit)`. **License Rewards are VEX:** the share
  of the purchase's USDT value is floored in USDT, converted at the PriceFeed price of the purchase,
  `wanted = floor(usdtShare * 1e18 / price)` (that VEX is also what counts against the cap), and a trimmed credit is the
  room itself; for LR `wanted` and `credit` of `BonusCredited` are VEX wei (events of earlier Network versions carry
  USDT: read the block of the network upgrade from `deployments/<network>.json`, `upgrades`); without a PriceFeed price
  the whole LR event credits nothing (one `BonusSkipped` with reason 7, beneficiary 0; the purchase is never reverted).
  The credit that uses up the cap emits `CapReached(account, activationSeq)` once per activation (also when the base
  shrank below `used` and the next event finds no room); `onActivated` re-arms it. Rates, all state: NC L1 10 %, L2 5 %,
  L3-L5 1 %, L6-L15 0.5 %; LR L1 20 %, L2 8 %, L3 3 %, L4-L10 1 %; BF 0.5 % on 10 levels; levels per tier (Lite..Ultra)
  NC 2 / 4 / 6 / 9 / 15, LR 2 / 3 / 4 / 5 / 10. `DEFAULT_ADMIN` changes them: `setNcRates(uint16[15])`,
  `setLrRates(uint16[10])` (sums at most 100 %), `setBackFlow(bps, levels <= 10)` (`bps * levels` at most
  `MAX_BF_TOTAL_BPS` = 500 = 5 %: the share of each VEX claim that Rewards keeps for BackFlow),
  `setTierLevels(nc[5], lr[5])` (non-decreasing with the tier, at most 15 / 10; `InvalidRates` / `InvalidLevels`),
  `setPriceFeed` (a contract); views `ncRates`, `lrRates`, `backFlow`, `tierLevels`, `priceFeed`.
- **Bonus balances.** `bonusBalances(account)` = `(cashbackVex, licenseUsdt)`, the credits made minus what was consumed.
  The cashback balance holds Network Cashback, License Rewards and BackFlow; `licenseUsdt` is only what an earlier
  Network version credited in USDT (always 0 on mainnet); nothing claims it any more.
  `consumeBonus(account, kind, amount)` (kind 0 cashback, 1 license) is for `REWARDS_ROLE` (the Rewards contract,
  REWARDS pause) and reverts above the balance (`BonusExceeded`); consuming does not change the counters the early close
  reads.

**TokenSale (`TokenSale.sol`)** is the VEX sale; no backend key signs a quote. Other contracts use it through
`interfaces/ITokenSale.sol` (which includes `IRoundPriceSource`).

- **Rounds** (ids 1..8, 0 = none open). `DEFAULT_ADMIN` `addRound(price, allocation)`, `setRoundPrice` (refused once the
  round sold anything: lots are bought back at their round's price) and `setRoundAllocation` (not below what is funded).
  `OPERATOR` `fundRound(round, amount)` in parts (pulls VEX, credits what was received, funded may not exceed the
  allocation), `allocateExcess(round, amount)` (sold-back or donated VEX back into a round) and the manual switch
  `setActiveRound(round)` (0 closes sales). `currentRoundPrice()` is what PriceFeed reads in ROUND mode.
- **Buy** (`ENTRIES` pause): `buy(payToken, payAmount, minVexOut, sponsor)` delivers `floor(usdt * 1e18 / price)`;
  `buyExact(payToken, vexAmount, maxPay, sponsor)` charges `ceil(vex * price / 1e18)`. `payToken` = USDT or `address(0)`
  = BNB (`msg.value`, which must equal `payAmount`; for `buyExact` it must equal `maxPay` and the part above the price
  is refunded). BNB is valued at `PriceFeed.bnbPrice()` (rounded down; `buyExact` rounds the USDT and the BNB up; a
  stale Chainlink answer reverts). The payment moves once, buyer to Treasury, then `notifyPayment`. The first purchase
  registers the sponsor in Network (later calls ignore the argument) and a frozen account is refused (`NotActive`).
  Lots: `lots[account][round] += vex`. Event `Bought(account, round, payToken, payAmount, usdtValue, vexAmount)`.
- **Sell-back** (`ENTRIES` pause): `sell(vexAmount, minUsdtOut)` takes the VEX from the lots, lowest round first, each
  part at its round's price, `usdt = sum(floor(take * price / 1e18))`, paid from the Treasury reserve; the VEX goes to
  the sell sink (this contract by default). Refused when Network says sell-blocked (`SellBlocked`) or not active; BNB
  takings are never used. Events `Sold(account, vexAmount, usdtAmount)` and one
  `LotSold(account, round, vexAmount, usdtAmount)` per part. There is no fee and no holding period, but the USDT paid
  out is limited per UTC day: 2 000 USDT per account and 20 000 USDT in total (`setSellAccountCap` / `setSellGlobalCap`:
  OPERATOR any value, GUARDIAN only lower, a cap of 0 turns the sell-back off, at most uint96; event
  `SellCapSet(global, oldCap, newCap, by)`). Above the room left the call reverts
  `SellLimitExceeded(global, requested, room)`. A lot paid in BNB is bought back in USDT and counts the same.
  `sellLimits(account)` returns `(accountCap, accountUsed, accountRoom, globalCap, globalUsed, globalRoom)` for the
  current day. A new deployment starts with the two default caps; a live sale gets them from
  `initializeV3(accountCapUsdt, globalCapUsdt)`, called by DEFAULT_ADMIN inside `upgradeToAndCall`
  (`initializeV3(2000e18, 20000e18)`). Without that call the caps of a live sale are 0 and the sell-back is off until
  OPERATOR sets them.
- **Views**: `rounds()`, `roundOf`, `currentRound`, `remaining`, `lotsOf(account)` (one entry per round), `sellable`,
  `quoteBuy`, `quoteBuyExact`, `quoteSell`, `sellLimits`, `inventory`, `vexExcess`. Admin: `setSellSink`, `sweep` (VEX
  above the inventories, any other token and BNB for `token == address(0)`, never inventory; the sale keeps no BNB of
  its own, a payment goes straight to the Treasury), `setTreasury` / `setNetwork` / `setPriceFeed`.
- **Wiring**: PAYER and RESERVE_SPENDER on the Treasury, REGISTRAR_ROLE on Network, fee-exempt on VEX, PriceFeed
  `roundSource`.
- **Storage** (ERC-7201 `vexaro.storage.TokenSale`): five wiring addresses, `sellSink | roundCount | activeRound` in one
  slot, Round = price | allocation + funded | sold (uint128 each), lots per (account, round) as uint256. The
  current-price sale settings, the credit per account, the fixed reserve floor, the `sell` caps and counters and the
  maturing purchases are appended after that.

**LicenseSale (`LicenseSale.sol`)** is the license shop; it holds nothing. It mints and burns `License` units (ERC1155,
id = tier x 1000 + days) and tells Network who holds which license.

- **Prices.** A USDT price and an on-sale flag per (tier 1..4, term 30 / 180 / 360): Basic 20 / 60 / 100, Prime 30 / 100
  / 180, Elite 100 / 400 / 700, Ultra 200 / 900 / 1 500 USDT at the start (`initialize`). `DEFAULT_ADMIN`
  `setPrice(tier, term, usdtPrice, onSale)`; a combination `License` does not know reverts `InvalidLicenseId`, tier 0
  (Lite, never sold) `LiteNotForSale`, a zero price `InvalidPrice`. `priceOf(tier, term)`.
- **Buy** (`ENTRIES` pause): `buyLicense(tier, term, payToken, maxPay, sponsor)` sells any tier and term at any time, in
  any order, also while another license runs and after it ended (no ladder). USDT, or BNB (`address(0)`, `msg.value`
  must equal `maxPay`, the part above the price is refunded) at `PriceFeed.bnbPrice()` rounded up for the buyer,
  `Slippage` above `maxPay`. The payment moves once, buyer to Treasury, then `notifyPayment` (`SalePayment`). The first
  purchase registers the sponsor in Network, a frozen account is refused (`NotActive`). The buyer gets one unit (MINTER
  on License), then `Network.onLicenseBought(buyer, usdtListPrice)` pays License Rewards to the upline on the USDT list
  price (so a BNB purchase credits the same as a USDT one), as VEX on the cashback balance. Event
  `LicenseBought(account, licenseId, tier, term, payToken, payAmount, usdtValue)`. `quoteLicense(tier, term, payToken)`.
- **Lite** (`ENTRIES` pause): `claimLite()` mints a free Lite unit (id 30) to a registered, active account with an open
  own P1-P5 stake now (`Staking.openP15Now`) that holds no unused Lite unit and whose active license is not a Lite that
  is still running (`LiteRunning`; the next Lite can be claimed from the exact second the running one expires). A
  running paid license does not block it, and a unit moved to another wallet counts as not held. No License Rewards.
  `liteStatusOf(account)`: 0 can claim, 1 not active, 2 no own P1-P5 stake, 3 unit held, 4 Lite running.
- **One Lite activation per 30 days.** Lite units stay transferable, so the limit is on `activate(30)`: an account
  activates a Lite at most once every `LITE_ACTIVATION_PERIOD` (30 days). `activate` reverts
  `LiteActivationTooSoon(account, availableAt)` before that moment (`availableAt` is a timestamp, available from that
  second). `liteAvailableAt(account)` is the later of the account's last Lite activation through this contract plus 30
  days (`liteActivatedAt`, one appended slot mapping) and, while the account's current license is a Lite, that Lite's
  end; the second part covers a Lite activated before the rule existed. A Lite that a paid license replaced before the
  upgrade leaves no trace, so that account may activate one Lite at once. Only the account's own 30-day renewal
  refreshes the partner-bonus limit (Network keeps the counter for a Lite that replaces a running Lite).
- **Activate** (`ENTRIES` pause): `activate(licenseId)` burns one unit of the caller (BURNER on License, no approval;
  bought, claimed, received or gifted alike) and calls `Network.onActivated(account, tier, expiresAt)`: the new license
  replaces the active one (remaining days lost), `expiresAt = now + term days` to the second, the bonus-cap counter
  restarts. The mirror is Network's; `activeLicenseOf(account)` forwards `Network.licenseOf`.
- **Views**: `licenseOptions(account)` (the 12 rows with id, price, flag, and the Lite status), `quoteLicense`,
  `priceOf`, `liteStatusOf`, `activeLicenseOf`, the wiring getters. Admin: `setTreasury` / `setNetwork` / `setPriceFeed`
  / `setStaking` (DEFAULT_ADMIN, to contracts only).
- **Recovery.** `sweep(token, to, amount)` (DEFAULT_ADMIN) sends out an ERC-20 or BNB (`token == address(0)`) that was
  sent here by mistake; the shop keeps no balance of its own, so nothing it needs is reachable. Event
  `Swept(token, to, amount)`.
- **Gifts.** Admin gifts stay a plain `License.mint` by the Safe (MINTER on License): nothing in LicenseSale, so no
  License Rewards; the receiver activates the unit like any other.
- **Wiring**: PAYER on the Treasury, REGISTRAR_ROLE and LICENSE_HOOK_ROLE on Network, MINTER and BURNER on License.
- **Storage** (ERC-7201 `vexaro.storage.LicenseSale`): six wiring addresses (license, usdt, treasury, network,
  priceFeed, staking) and `prices[tier][term]` = usdt (uint128) | onSale in one slot.

**Rewards (`Rewards.sol`)** is the claim contract and the vault of the reward VEX: every withdrawal rule runs here, no
backend key moves money, and no staked principal is ever held (Staking keeps it).

- **Vault.** The reward VEX sits in the contract. `fund(amount)` (OPERATOR) pulls VEX whole (`FeeNotExempt` when VEX
  charged a fee). Staking's early-close fee and deductions arrive by plain transfer: `Staking.setRewardVault(rewards)`.
  `withdraw(token, to, amount)` is DEFAULT_ADMIN only (the timelock), event `Withdrawn`; for VEX it is the only exit
  besides claims. `vaultBalance()`. The liabilities (unclaimed staking income, cashback with the License Rewards) are
  per account in Staking and Network and are not summed on chain.
- **Claim** (`claim(kind, gross)`, REWARDS pause, `Network.isActive(msg.sender)`): kinds `KIND_STAKING` 0 (VEX,
  `Staking.incomeOf` / `consumeIncome`), `KIND_CASHBACK` 1 (VEX, Network bonus 0 by `consumeBonus`: Network Cashback,
  License Rewards and BackFlow). There is no USDT kind: `claim(2, ...)` reverts `InvalidKind(2)`, there is no USDT
  minimum / maximum / daily limit or payout path, and Rewards and Network hold no USDT. Checked in this order:
  `now >= lastClaim[account][kind] + 24 h` (to the second, one clock per kind; `TooSoon(nextAllowedAt)`),
  `gross <= balance` (`InsufficientBalance`; a STAKING claim consumes first and Staking refuses it with
  `IncomeExceeded(amount, income)`, the rest of the rules then revert the whole claim), `gross >= 5 USDT` (VEX kinds:
  the VEX value at `PriceFeed.vexPrice()`, no price reverts `PriceUnavailable`; `BelowMinimum`), `gross <= maximum`
  (`AboveMaximum`), the daily cap (`DailyCapExceeded(requested, room)`) and the account's share of it
  (`AccountDailyCapExceeded(requested, room)`).
- **Maximum.** 50 % of the PRINCIPAL IN VEX of the account's LARGEST open own stake (`Staking.largestOpenOf`: a USER or
  AIRDROP stake by principal in VEX, never JUMP; no price conversion, so the maximum does not move with the VEX price).
  With NO open own stake (a JUMP stake does not count, an AIRDROP stake does): 50 % of the kind's balance, and the WHOLE
  balance when that half is below the 5 USDT minimum while the balance reaches it (DEFAULT_ADMIN can switch this with
  `setWholeBalanceWhenHalfBelowMin(bool)` without an upgrade, default on). A STAKING claim may also reach the staking
  income that stakes of two-halves pools (Smart) released and that is not claimed yet (`Staking.halvesIncomeOf`): the
  maximum is the larger of the 50 % rule and that amount. The claim reads it from `Staking.consumeIncomeSplit` before
  the consumption, and a claim is taken to spend the Smart part of the income first, so the income of the other pools
  never gets past the rule: with 1 150 VEX of released Smart income and 130 VEX of other income, a claim of 1 200 is
  above the maximum (1 150) and one of 1 150 is not; afterwards the rule binds the 130 again. CASHBACK is not affected.
- **Daily cap.** Per UTC day across all accounts: the two kinds together (STAKING + CASHBACK), stored in USDT (default 2
  000 USDT) and converted to VEX at the price of the claim; the counter counts `gross` in VEX, like Staking's refund
  cap. `setDailyCap(token, capUsdt)` (token = VEX; any other token, USDT included, reverts `UnknownToken`): OPERATOR
  sets any value, GUARDIAN may only LOWER it (`CapNotLowered`), 0 switches claims off. `capsOf()` returns the one VEX
  limit. The second limit slot (`licenseLimit`) is deprecated and never read.
- **Share of one account.** One account may use at most `accountShareBps` of the cap in force per UTC day (counted in
  VEX like the cap, both kinds together, reset at 00:00 UTC): 25 % (2 500 basis points, 500 of the 2 000 USDT) while
  nothing was set, so a few accounts can not take the whole day's cap. `setAccountShareBps(bps)`: OPERATOR any value
  from `MIN_ACCOUNT_SHARE_BPS` (100 = 1 %) to 10 000 (`InvalidValue` outside), GUARDIAN only lower (`CapNotLowered`),
  event `AccountShareSet(oldShareBps, newShareBps, by)`. The share is a fraction of the cap in force, so it follows a
  changed cap and the price. A claim above what is left of the account's share reverts
  `AccountDailyCapExceeded(requested, room)`; the global cap is checked first (`DailyCapExceeded`). Views:
  `accountShareBps()`, `accountCapOf(account)` = `(shareBps, cap, used, room)` in VEX wei (cap and room are 0 without a
  VEX price). On the live proxy the share needs no initializer: the stored value 0 means the default, and the usage per
  account starts empty, so what was claimed earlier on the day of the upgrade is not counted against the account.
- **Payout.** 90 % to the account (checked to arrive whole), 5 % burned from the vault, the rest (5 % plus rounding
  dust) stays; `Network.onWithdrawal(account, gross)` credits BackFlow (0.5 % x 10 levels) to the uplines out of what
  stays, what is not credited simply stays in the vault. All parts are floored. Rewards pays no USDT, so it holds no
  role on the Treasury. Event `Claimed(account, kind, gross, net, burned, backflowBase)`; `VaultShort` when the vault
  cannot cover payout + burn.
- **Views.** `claimsOf(account)` returns for each of the two kinds (index = kind, in VEX wei): `balance`, `minimum`,
  `maximum` (the 50 % rule, or the released Smart income when that is larger; the balance and `capRoom` bind too),
  `nextAllowedAt` (0 = never claimed), `capRoom` (the smaller of the global room and the account's own room),
  `windowOpen`, `priced` (false without a VEX price: minimum / maximum / capRoom are then 0); it never reverts.
  `capsOf()`, `lastClaimOf(account, kind)`, `vaultBalance()`, the wiring getters.
- **Wiring for the deploy.** REWARDS_ROLE on Staking (`consumeIncomeSplit`) and on Network (`consumeBonus`),
  WITHDRAWAL_HOOK_ROLE on Network (`onWithdrawal`), VEX fee exemption, `Staking.setRewardVault(rewards)` (no role on the
  Treasury); `initialize(admin, vex, network, staking, priceFeed)`. Setters (DEFAULT_ADMIN): `setNetwork`, `setStaking`,
  `setPriceFeed`, `setTokenSale`.
- **Storage** (ERC-7201 `vexaro.storage.Rewards`): six wiring addresses (`usdt` and `treasury` are deprecated and never
  read) and the whole-balance flag, the VEX limit (cap | used | day in one slot, 96 / 96 / 64 bits; the second slot is
  deprecated) and the last claim times (three uint40 in one slot per account); appended: the TokenSale, the account
  share in basis points (next to it) and the usage per account and day (used | day).

**Staking (`Staking.sol`)** is the VEX staking: the pools, the stakes, the income and every exit rule are in the
contract, no backend key signs anything. Other contracts use it through `interfaces/IStaking.sol`. It holds the staked
principal only: rewards are paid from the reward vault by the Rewards contract, which asks this contract for the income.

- **Layout of the code.** `Staking.sol` (UUPS on `Managed`) is the state-changing part and the cheap views;
  `libraries/StakingMath.sol` is an external library (the `Staking` contract would be 28.8 KB in one piece, the limit is
  24 KB) with the pool validation, the accrual schedule, the income of an account, vesting and the early-close quote. It
  runs by `DELEGATECALL` on `Staking`'s own storage, holds no state and is deployed once and linked into the `Staking`
  implementation (`getContractFactory("Staking", { libraries: { StakingMath } })`; `deployProxy` / `validateUpgrade`
  need `unsafeAllow: ["external-library-linking"]`). The storage structs are in `abstracts/StakingStore.sol`, which both
  use. Sizes: see "Static analysis" below.
- **Pools.** `DEFAULT_ADMIN` `addPoolVersion(poolId, params)` adds pool `poolId` (the next free id, 1..255) or a new
  immutable version of an existing pool; a stake keeps the version it opened with, new stakes use the newest. A version
  is
  `(dailyBps, periodDays, maxProfitBps, payoutMode daily | three parts, returnMode VEST | FULL, ncRule levels | level 1 only, l1Bps, jumpEligible, usdtMin, usdtMax, releaseDays[3])`;
  a malformed one reverts `InvalidPoolParams(reason)`. `OPERATOR` `launchPool(poolId)` (once; also enables) and
  `setPoolEnabled`: a pool takes stakes while it is launched and enabled. The catalogue of the 14 pools (Smart = id 1,
  P1-P5 = 2-6, P6-P13 = 7-14) with the three-part totals is `deploy/params/stakingPools.ts`, which the deploy reuses.
  Views `poolCount`, `pool(id)` = `(launched, enabled, versionCount, airdropAllowed)`, `poolVersion(id, version)`,
  `poolHalves(id)`. `DEFAULT_ADMIN` `enablePoolHalves(poolId)` (one-way, event `PoolHalvesEnabled`) puts a pool on the
  two-halves schedule below: the flag belongs to the pool, so every version of it and every stake of it, open ones
  included, follow it; the deploy sets it for Smart (`halves` in `deploy/params/stakingPools.ts`).
- **Stakes.** `stake(poolId, vexAmount, minUsdtValue, sponsor)` (ENTRIES pause) registers the sponsor in Network (first
  transaction), needs an active account, takes the VEX (fee-exempt check, `FeeNotExempt`), and requires the USDT value
  at the PriceFeed price to be inside the pool's inclusive range (`OutOfRange`; no price reverts `PriceUnavailable`;
  `minUsdtValue` is a slippage limit, 0 = none). At most 50 open stakes per wallet, all sources (`TooManyStakes`). A
  GRANTER (Jump) opens JUMP / AIRDROP stakes with `createGrantStake(account, poolId, vexAmount, source)`: the VEX is
  pulled from the caller, the pool only has to exist (launched or not, enabled or not: a promised grant does not lapse),
  the newest version applies, no range, no sponsor, the recipient need not be registered; such a stake accrues and
  matures like any other but can not be closed early and is in no checkpoint or cap base (ENTRIES pause).
- **Time and accrual** (all UTC). Reward moment k of a stake opened at t0 is 06:00 on the UTC date of t0 plus k days, k
  = 1..P. Daily pools pay `floor(principal * dailyBps / 10 000)` per paid moment with the running total trimmed to
  `floor(principal * maxProfitBps / 10 000)`; three-part pools pay
  `floor(principal * min(dailyBps * P, maxProfitBps) / 10 000)` in parts `floor(total / 3)`, `floor(total / 3)` and the
  rest on the three release days. Two-halves pools (Smart) pay the same total in two parts, `floor(total / 2)` at 00:00
  UTC of the opening date + ceil(P / 2) days (day 8 of 16) and the rest at 00:00 UTC of the opening date + P days (day
  16), and nothing before day 8: a Smart stake opened on 1 Nov at any time of day releases its first half at 00:00 on 9
  Nov and the second at 00:00 on 17 Nov; its total is 23 % of the principal (`min(144 x 16, 2 300)` basis points). A
  moment inside a freeze interval of the owner (Network) pays 0 (for the two-halves moments, at 00:00 UTC); the schedule
  and the cap do not move (frozen days are forfeited). Views `accruedOf(id)`, `accruedAt(id, timestamp)` (a projection;
  `type(uint256).max` = the whole schedule), `stakeView(id)` (`nextMomentAt` = the next release, 0 once the schedule is
  complete; the amount that comes with it is `accruedAt(id, nextMomentAt) - accruedOf(id)`).
- **Maturity.** 00:00 UTC of the opening date plus P days for VEST pools (P1-P5) and plus P + 1 days for FULL pools
  (Smart, P6-P13): the two-halves schedule does not move it, so a Smart stake matures on day 17, a day after its second
  half (opened on 1 Nov: halves on 9 and 17 Nov at 00:00, maturity 18 Nov at 00:00). `closeMatured(id)` (EXITS pause,
  owner not frozen) settles the WHOLE schedule (for P1-P5 that includes the last moment, 6 h after the maturity), burns
  5 % of the principal and either starts the vesting of the other 95 % (VEST: `floor(95 % / P)` per whole UTC day after
  the close day, the remainder on the last day, `claimVested(id)`, EXITS pause) or pays it at once (FULL).
- **Early close.** `closeEarly(id)` (ENTRIES pause, USER stakes, from `openedAt + 48 h` to before maturity, owner
  active): fee 30 % of the principal (5 % burned, 25 % to the reward vault); deduction = the stake's accrual up to the
  close + the partner bonuses credited since the stake opened and not deducted yet (Network counters:
  `vexCum - max(stake.vexMark, account.vexDeducted)`; the legacy USDT credits (`usdtCum`, `usdtMark`, `usdtDeducted`)
  are neither converted nor deducted and `usdtMark` is no longer written, so the `usdtMark` argument of `StakeOpened` is
  always 0 (kept so that the event signature does not change); the VEX mark then moves up, so each credit is deducted at
  most once); refund = principal - fee - deduction, which must be > 0 and within the UTC-day refund cap
  (`setRefundCapUsdt`, OPERATOR, USDT, converted to VEX at the current price at each close; 0 turns early closes off).
  The cap is for all accounts together: there is no per-account share of it, because a stake closes as a whole. The
  deduction goes to the reward vault; the accrual stays claimable. `previewEarlyClose(id)` returns the numbers and a
  `status` (0 = possible, else `EARLY_*`: `EARLY_CAP` 6 = above what is left of the cap); `closeEarly` reverts
  `EarlyCloseRefused(status)`. `refundUsedToday()` is what the day's early closes have used of the cap. For a Smart
  stake nothing is accrued before its first half (day 8), so until then the deduction is the partner credits alone
  (refund = principal - fee - credits); from day 8 the released first half is part of it, from day 16 the whole reward
  (23 % of the principal: refund = 47 % of the principal - credits), and what was released stays claimable income. From
  day 17, the maturity, the early close is refused (`EARLY_MATURED`) and `closeMatured` takes over.
- **Income and checkpoints.** `incomeOf(account)` = settled (accrual of closed stakes) + accrued (open stakes) -
  claimed; `consumeIncome(account, amount)` is for REWARDS_ROLE (the Rewards contract, REWARDS pause), reverts above the
  income and returns the income it computed before the consumption (so a claim reads the stakes once);
  `consumeIncomeSplit(account, amount)` is the same call that also returns the part of that income from two-halves
  pools, `halvesIncomeOf(account)` = what those stakes released (open ones) or settled (closed ones, `settledHalves` per
  account) less what was claimed, never above the income; a claim is taken to spend that part first, which is how
  Rewards lifts its 50 % maximum for it and for it alone. The cap base and the withdrawal maximum come from
  `largestOpenOf` (below); `openP15At(account, timestamp)` is the number of open USER stakes of jump-eligible pools
  (P1-P5) after every change at or before the timestamp (checkpoints, for Jump). `openStakesOf(account)`. The
  per-account sums of the open principal and entry value (`openPrincipalOf`, `openEntryUsdtOf`) are no longer written
  and the views are gone; the two fields stay in the storage.
- **Jump hook.** After the Network Cashback, a USER stake of a jump-eligible pool (P1-P5) calls
  `Jump.onStakeOpened(account, poolId, entryUsdt)` on the address set by `setJump` (DEFAULT_ADMIN; zero = off) inside a
  `try`: a failing Jump never blocks the stake (event `JumpHookFailed`). Smart, P6-P13, JUMP and AIRDROP stakes never
  call it. `jump()`.
- **Roles.** DEFAULT_ADMIN (pool versions, `enablePoolHalves`, wiring, `setRewardVault`, `setJump`, `rescue`), OPERATOR
  (launch, enable, refund cap), GRANTER (grant stakes), REWARDS_ROLE (consume income), GUARDIAN / EXIT_PAUSER as in
  `Managed`; Staking itself needs HOOK_ROLE on Network and VEX fee exemption. `rescue` sends out VEX above the principal
  obligations (open stakes plus the unclaimed vesting) and any other token.
- **Storage** (ERC-7201 `vexaro.storage.Staking`): wiring, `poolCount`, pool registry (PoolParams: 3 slots), stakes (4
  slots: owner and pool fields | principal and entry USDT | bonus marks | close fields), per account 2 slots of income
  (and the 2 deprecated slots of sums), the open list, the P1-P5 checkpoints (`Checkpoints.Trace208`); appended: the
  hold marks, the largest-stake record, the pool's two-halves flag (a fifth member of the pool record, in its slot) and
  the account's `settledHalves` (a third slot of income).

**Jump (`Jump.sol`)** is VEX Jump: the first four direct invitees of an account that open an own P1-P5 stake in a cycle
earn the account a free JUMP stake after a review period. It holds the Jump VEX allocation and nothing else.

- **Cycles (UTC).** Cycle c (from 1) of an account U is the 7 UTC days `[d + 7 (c - 1), d + 7 c)` where `d` is the UTC
  day of `Network.joinedAt(U)` (U's first on-chain transaction). The join day itself belongs to cycle 1 (a join at
  23:59:59 has one second of day one in cycle 1) and a cycle ends at 00:00 UTC. `currentCycle(U)` =
  `(cycleNo, start, end)` (0 = not joined), `cycle(U, c)` = a `CycleView`: bounds, `slots`, the smallest slot (`poolId`,
  `usdt`), `claimableAt`, `rejected` / `rejectReason`, `claimed` / `stakeId` and a `status` code (`STATUS_NONE` 0,
  `RUNNING` 1, `NOT_ELIGIBLE` 2, `REVIEW` 3, `CLAIMABLE` 4, `REJECTED` 5, `CLAIMED` 6, `STAKES_UNRECORDED` 7,
  `INVITEE_CLOSED` 8, `INVITEE_YOUNG` 9; the last three are what a grant is in after its review while the invitee stakes
  behind it stop the claim). `claimability(U, c)` returns `(claimableNow, availableAt, status)`: the first second the
  claim can work, 0 when it is open now or can not work any more.
- **Slots (hook).** `onStakeOpened(account, poolId, entryUsdt)` (HOOK_ROLE = Staking, called in the stake's own
  transaction, never paused by Jump) gives the sponsor U of `account` a slot of U's current cycle c when the entry value
  is at least 10 USDT (inclusive), U has joined, the invitee joined on a UTC day inside cycle c, it was not counted
  before and the cycle has fewer than 4 slots. Slots fill in the order of the stake openings; per (U, c) the contract
  keeps the count and the smallest slot (the earlier one on a tie). A stake made before the sponsor's own first
  transaction counts for nothing. Events `SlotFilled`, and `CycleFull` on the fourth. The hook also keeps the id of the
  stake that filled each slot (`slotStakesOf(U, c)`, read from `Staking.openStakesOf(account)`, where the new stake is
  the last one).
- **Grant.** `claimJump(c)` by U (ENTRIES pause): U active (registered, not frozen) -> the cycle has 4 slots -> not
  claimed -> not rejected -> `now >= end + reviewPeriod` (72 h, `setReviewPeriod` by DEFAULT_ADMIN, 1 second .. 30 days,
  to the second) -> `Staking.openP15At(U, end) > 0` (an own open P1-P5 stake at the cycle's end second; a stake closed
  at the end second or before does not count, one closed a second later does, one opened at the end second does) -> each
  of the four stakes that filled the slots is still open (`InviteeStakeClosed(c, stakeId)`: a closed stake can not be
  undone) and at least 3 days old (`MIN_INVITEE_STAKE_AGE`, a constant; `InviteeStakeTooYoung(c, availableAt)`, the
  moment the youngest reaches it). With the default 72 h review every stake opened inside the cycle is old enough by the
  end of the review, so the age rule bites only when the review period is shortened. Then a JUMP stake opens in the
  smallest slot's pool for its USDT amount (clamped to at most 5 000 USDT; slots are at least 10 USDT, so the lower
  clamp of 10 is automatic) converted at the PriceFeed price (floor, no price = `PriceUnavailable`), VEX from this
  contract through `Staking.createGrantStake` (GRANTER_ROLE). `claimJump(c, minVexOut)` is the same call with a minimum:
  it reverts `Slippage(vexAmount, minVexOut)` when the grant converts to fewer VEX. Grants do not expire. A JUMP stake
  accrues and matures like any other, can not be closed early and pays no Network Cashback. Cycles that were full before
  the stakes were recorded on the slot have no stake ids: their claim reverts `InviteeStakesUnrecorded(c)` until
  OPERATOR calls `recordSlotStakes(U, c, [four stake ids])`, which checks each stake (a USER stake of at least 10 USDT
  opened inside the cycle by a different, counted invitee of U) and can not overwrite a recorded cycle. Such cycles
  follow the same rules afterwards.
- **Sell credit of a grant.** The principal of a grant stake is new platform VEX that Staking pays back at maturity (95
  %, 5 % is burned). It becomes sellable at the current price as it is paid back, not when the stake opens: the claim
  only records the amount (`grantCreditOf(U, c)` returns `(total, credited, releasable)`), and anyone calls
  `releaseGrantCredit(U, c)` once the stake is closed (a FULL pool pays at the close; a VEST pool credits what
  `claimVested` has paid so far). The credit goes to U through `TokenSale.creditCurrentSell`, emits
  `GrantCreditReleased(U, c, amount)`, never twice, and reverts `NothingToRelease(c)` when nothing new was paid back or
  no TokenSale is set (the amount stays due). Grants claimed before this rule were credited at the claim and show
  `total == 0`.
- **Review.** GUARDIAN or OPERATOR `rejectGrant(U, c, reason)` (deny-only, until it is claimed, also while the cycle
  runs), OPERATOR `restoreGrant(U, c)`.
- **Four grants at most.** An account earns grants only for its first FOUR ELIGIBLE full cycles, in cycle order. A full
  cycle is eligible when the account had an open own P1-P5 stake at its end (the test `claimJump` runs); a full cycle
  without one earns nothing and does not use a place. The hook settles lazily: before it counts a slot for U it walks
  `fullCycles[U]` from `settled[U]`, evaluates every full cycle that ended before this second once (`earned[U]++` if
  eligible) and moves `settled[U]` on, so each full cycle is evaluated once over the account's life (about 12 k gas per
  settled cycle on a stake, 29 k for the first). No slot is counted while `earned + pending >= 4`; `pending` is a full
  cycle that is not settled yet, which can only be the one ending in this very second (its last checkpoint is not final
  until the second is over, so it counts as eligible and the invitee just stakes again a second later). Cycles are
  sequential, so eligible cycles can never exceed four. A rejected grant keeps its place (`restoreGrant` makes it
  claimable again) and the four can be claimed in any order. `grantsOf(U)` lists every full cycle (eligible or not);
  `jumpStatus(U).grantsEarned` is the settled eligible count and `grantsLeft = 4 - grantsEarned`.
- **Allocation.** `fund(amount)` (OPERATOR, `FeeNotExempt` when VEX charged a fee), `withdraw(token, to, amount)`
  (DEFAULT_ADMIN, not limited by grants still to be claimed: they are not known on chain), `allocation()`.
- **Views for the cabinet.** `jumpStatus(U)` (current cycle, its smallest slot, grants claimed / left, number of full
  cycles, whether U has an open P1-P5 stake now, the allocation), `grantsOf(U)` (the cycle numbers with 4 slots, oldest
  first), `isCounted(invitee)`.
- **Wiring for the deploy.** `initialize(admin, vex, network, staking, priceFeed)`; GRANTER_ROLE on Staking for Jump;
  HOOK_ROLE on Jump for Staking and `Staking.setJump(jump)`; VEX fee exemption for Jump (`fund` checks it; Staking is
  exempt itself, so the stake pull is never charged); an OPERATOR `fund` of the Jump VEX.
- **Storage** (ERC-7201 `vexaro.storage.Jump`): wiring and the review period; per (account, cycle) one slot (slots 1 B |
  smallest pool 1 B | smallest USDT 16 B | rejected, reason, claimed | stake id 8 B); a counted flag per invitee; per
  account the grants claimed, the settlement cursor and the eligible count, and the list of its full cycles; appended
  later: the TokenSale, the four slot stake ids per (account, cycle) and the sell credit due per (account, cycle).

**Airdrop lock (`Vexaro.sol` + `Staking.stakeAirdrop`)** replaces the Grants contract (Merkle batches are gone). 1.5 %
of the supply (15 M VEX) is sent at deploy to ONE airdrop wallet (mainnet a Ledger); it airdrops with plain VEX
transfers, so every send is visible on BscScan.

- **The lock.** `airdropWallet()` is set by DEFAULT_ADMIN (`setAirdropWallet`, not zero, the new wallet must hold no
  lock; changing it never unlocks or moves an existing lock). A transfer out of the airdrop wallet to a normal account
  (not zero, not the wallet, not fee-exempt) adds the amount the receiver gets to `airdropLockedOf(receiver)`
  (`AirdropLockAdded`); a send to an exempt address (DEX pair / router, platform contracts) locks nothing, so the
  company can swap or fund from the wallet. The airdrop wallet itself is unrestricted and fee-exempt (the deploy sets
  both).
- **The lock travels, and is enforced on the platform only.** Wallet-to-wallet transfers are free. A move out of an
  account with a lock spends its free balance (`freeBalanceOf` = balance - lock) first; only the part of `value` above
  it carries the lock to the receiver (`AirdropLockMoved(from, to, amount, moved, fromLocked, toLocked)`). The fee burn
  takes its proportional share of the carried part (`moved = carried * received / value`, rounded down), so
  `lock <= balance` holds on both sides. A receiver that is fee-exempt (DEX pair / router, CEX) or the zero address
  keeps no lock: the carried part is simply released there, so locked VEX can be swapped on an external DEX (accepted).
  A burn by the holder spends free VEX first, then the lock. A send to the airdrop wallet (mistakes) lowers the lock by
  min(lock, value) (`AirdropLockReturned`).
- **Platform restriction.** `Vexaro.setPlatformRestricted(account, bool)` (DEFAULT_ADMIN, `PlatformRestrictedSet`;
  independent of the fee exemption) marks the contracts that receive VEX: the deploy restricts TokenSale, Staking,
  Rewards and Jump (Treasury and LicenseSale never receive VEX). A transfer to a restricted address must stay within the
  sender's free balance, otherwise it reverts `AirdropLocked(account, free, value)`: locked VEX cannot be sold to
  TokenSale (sell-back or current price), nor staked with the normal `stake`. `spendAirdrop(account, amount)`
  (AIRDROP_SPENDER_ROLE, held by Staking) releases `amount` of the lock and moves that VEX to the caller
  (`AirdropLockSpent`; `ExceedsAirdropLock` above the lock): `Staking.stakeAirdrop` is the only way locked VEX enters
  the platform. Free VEX is never blocked; locked VEX still votes (ERC20Votes follows balances). There is no blacklist
  and no pause. A send from the airdrop wallet to an exempt address creates no lock (the deployer, a DEX, a platform
  contract).
- **Which pools take airdrop VEX.** A per-pool flag `Pool.airdropAllowed` (same slot as `launched` / `enabled`; read
  with `pool(poolId)`, 4th return value). `setPoolAirdropAllowed(poolId, bool)` is DEFAULT_ADMIN (not OPERATOR or
  GUARDIAN), idempotent, event `PoolAirdropAllowed`; a new pool starts with it off, and it belongs to the pool, so a new
  version keeps it. `stakeAirdrop` into a pool without it reverts `AirdropPoolNotAllowed(poolId)` (the tokens do not
  move). The deploy turns it on for P1-P5 (ids 2-6) only (`airdropAllowed` in `deploy/params/stakingPools.ts`); Smart
  and P6-P13 refuse. Normal stakes and `createGrantStake` ignore it.
- **`Staking.stakeAirdrop(poolId, vexAmount, sponsor)`** (ENTRIES pause) has the entry rules of `stake` (registers the
  sponsor on the first transaction, active and not frozen, pool launched and enabled, the USDT value in the pool's
  range, 50 open stakes) and pulls the VEX with `spendAirdrop`. The SOURCE_AIRDROP stake accrues the daily income like
  any stake, can not be closed early (`EarlyCloseRefused(EARLY_NOT_USER)`), pays no Network Cashback to its uplines, is
  not in the P1-P5 checkpoints or Jump (it IS an own stake for the cap base, the withdrawal maximum and License Lite,
  see "Upgrades"), and pays its principal at maturity as free VEX (same 5 % burn and vesting as every stake). **It is on
  hold until an admin releases it** (below: income and principal can not be claimed). `createGrantStake` now only
  accepts SOURCE_JUMP.
- **Wiring for the deploy.** `setAirdropWallet`, `setExempt(wallet, true)`, `transfer(wallet, airdropAmount)` from the
  supply holder (before the hand-over), AIRDROP_SPENDER_ROLE on the token for Staking; the token's DEFAULT_ADMIN goes to
  the Safe like the other roles. Params `airdropWallet` and `airdropAmount` per network.

**Sell at the current price (`TokenSale.sellAtCurrentPrice`).** A second sell path next to the purchase-price sell-back:
FREE VEX that the account is **entitled** to (below) sells at `PriceFeed.vexPrice()` (reverts while it is unavailable;
the token refuses locked VEX because TokenSale is platform-restricted). `gross = floor(vex * price / 1e18)`,
`fee = ceil(gross * feeBps / 10_000)` (`currentSellFeeBps`, 0 by default, at most 1 000, DEFAULT_ADMIN
`setCurrentSellFee`), `net = gross - fee`; the USDT comes from the Treasury reserve (`payFromReserve`), the VEX goes to
the sell sink. Same checks as `sell` (active, not sell-blocked) and the same ENTRIES pause flag (GUARDIAN can pause it).
Limits: a 5 USDT minimum `gross` (`BelowMinimum`), `minUsdtOut` on the net, and per-account and global daily caps on the
net payout (UTC day, `setCurrentSellAccountCap` / `setCurrentSellGlobalCap`: OPERATOR any value, GUARDIAN only lower,
**a cap of 0 blocks the path, it is not "no cap"**, uint96; `CurrentSellCapExceeded(global, requested, room)`). Views:
`quoteSellAtCurrentPrice`, `currentSellFeeBps`, `currentSellCaps`, `currentSellRoom(account)`; event
`SoldAtCurrentPrice(account, vex, price, usdtGross, fee, usdtNet, lotsConsumed)`. Both sells pull the VEX into TokenSale
first (and revert `FeeNotExempt` when fewer VEX arrive than were sent, i.e. when TokenSale lost its fee exemption), then
forward it to the sink, so a sink that is not restricted cannot receive locked VEX.

- **Entitlement.** An account may sell at the current price only (a) its remaining purchase lots that are older than 24
  hours and (b) its `currentSellCredit`, which the platform raises by the NET VEX it pays out: the Rewards contract
  after every VEX claim (`creditCurrentSell(account, net)`: staking income, Network Cashback, BackFlow, and the income
  of AIRDROP and JUMP stakes, all claimed through Rewards) and the Jump contract by the principal of a grant stake as
  the stake pays it back (95 %; see the Jump section). The credit is a quota of VEX, not a claim on particular tokens:
  it limits the amount an account may sell at the current price, not the origin of the VEX it holds. The sale consumes
  the matured lots first (`LotConsumed`), then the credit (`CurrentSellCreditUsed(account, amount, left)`), and reverts
  `NotEntitled(account, requested, entitled)` above lots plus credit. `currentSellEntitlement(account)` returns
  `(entitled, lotVex, creditVex)` with the lots that count now; `CurrentSellCredited(account, amount, credit)` mirrors
  every credit. The role is `SELL_CREDITOR_ROLE` (granted to Rewards and Jump only); the credit call is not paused,
  ignores a zero amount and costs one SSTORE and one event, so it cannot stop a claim. The purchase-price `sell` is not
  affected. Residual risk (accepted): the amount is bounded by what the platform paid out and what was bought, but VEX
  from elsewhere can fill it, and such VEX can still be staked, where Network Cashback is paid on it. VEX an account
  claimed before the credit existed has no credit (the upgrade cannot know it).
- **Purchases count after 24 hours.** A purchase raises the entitlement only 24 hours after it
  (`CURRENT_SELL_MATURITY`), so a buy just before a round switch cannot be sold at the new price right after it. A sale
  that would fit only with younger lots reverts `LotsNotMatured(requested, matured, availableAt)`, `availableAt` being
  the first second at which enough has matured; one that does not fit even with every lot reverts `NotEntitled`. The
  purchases of the last 24 hours are kept in four tranches per account (two storage slots): a fifth purchase within the
  day joins the newest tranche, which then matures 24 hours after that purchase. The young amount is capped by the lots
  that remain, so a purchase-price `sell` reduces the matured part first, and a current-price sale takes matured lots
  only. `currentSellMaturity(account)` returns `(matured, maturing, nextMaturityAt)`: what is usable now (matured lots
  plus credit), the young lots and the second the oldest tranche matures. Lots bought before this rule have no tranche
  and count at once.
- **Reserve floor.** `sellAtCurrentPrice` may not take the Treasury USDT reserve below `reserveFloorFixed`
  (DEFAULT_ADMIN `setReserveFloorFixed`, 0 by default); `ReserveFloor(reserve, payout, floor)` when the payout would
  leave less (with no floor a short reserve is still the Treasury's `InsufficientReserve`). `sell` may use the whole
  reserve. The view returns `(floor, licenseOwed, fixedPart)`; nothing is owed in USDT any more, so `licenseOwed` is
  always 0 and `floor == fixedPart`.
- **Effects of the path.** Three things happen in one `sellAtCurrentPrice` that the entitlement and the floor now bound:
  (1) the seller's lots are consumed before the credit, so a later purchase-price `sell` can never be used for more VEX
  than was bought and not yet sold; (2) the USDT leaves the Treasury reserve, but never below the floor; (3) the VEX
  lands in the sell sink (unallocated excess of TokenSale by default, `allocateExcess` moves it back into a round). The
  daily caps count the net.
- The storage is appended at the end of the TokenSale namespace (credit per account, fixed floor, `sell` caps and
  counters, maturing purchases).

### Roles

| Contract    | Role                                                                                | Held by                                                |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Vexaro      | `DEFAULT_ADMIN` (also `setAirdropWallet`), `FEE_MANAGER`, `EXEMPT_MANAGER`          | admin                                                  |
| Vexaro      | `AIRDROP_SPENDER` (`spendAirdrop`)                                                  | Staking                                                |
| License     | `DEFAULT_ADMIN`, `PAUSER`                                                           | admin                                                  |
| License     | `MINTER`, `BURNER`                                                                  | LicenseSale (`MINTER` also admin, for gifts)           |
| Treasury    | `DEFAULT_ADMIN`, `UPGRADER`                                                         | admin                                                  |
| Treasury    | `PAYER` (reports a payment)                                                         | TokenSale, LicenseSale                                 |
| Treasury    | `RESERVE_SPENDER` (pays from the reserve)                                           | TokenSale (sell payouts) only                          |
| Treasury    | `DEFAULT_ADMIN` (`withdrawBnbReserve`, the BNB reserve only)                        | Timelock, 24 h                                         |
| TokenSale   | `SELL_CREDITOR` (`creditCurrentSell`)                                               | Rewards, Jump                                          |
| TokenSale   | `DEFAULT_ADMIN` (`setReserveFloorFixed`)                                            | Timelock, 24 h                                         |
| Network     | `OPERATOR` (`voidFreeze`, `unfreezeMany`, `setGuardianFreezeBudget`)                | the Safe                                               |
| TokenSale   | `DEFAULT_ADMIN` (rounds, price, allocation, wiring, sweep)                          | Timelock, 24 h                                         |
| TokenSale   | `OPERATOR` (`fundRound`, `allocateExcess`, `setActiveRound`, the sell caps)         | Safe (GUARDIAN: lower the caps only)                   |
| Staking     | `DEFAULT_ADMIN` (pool versions, wiring, vault, rescue)                              | Timelock, 24 h                                         |
| Staking     | `OPERATOR` (`launchPool`, `setPoolEnabled`, `setRefundCapUsdt`)                     | Safe                                                   |
| Staking     | `GRANTER` (`createGrantStake`), `REWARDS` (`consumeIncome`)                         | Jump, Rewards                                          |
| Staking     | `AIRDROP_RELEASER` (`releaseAirdropHold`)                                           | the admin console wallet (the Safe)                    |
| Jump        | `HOOK` (`onStakeOpened`)                                                            | Staking                                                |
| Jump        | `DEFAULT_ADMIN` (`withdraw`, review period, wiring)                                 | Timelock, 24 h                                         |
| Jump        | `OPERATOR` (`fund`, `restoreGrant`, `recordSlotStakes`), `GUARDIAN` (`rejectGrant`) | Safe; backend key                                      |
| Rewards     | `DEFAULT_ADMIN` (`withdraw`, whole-balance switch, wiring)                          | Timelock, 24 h                                         |
| Rewards     | `OPERATOR` (`fund`, `setDailyCap`, `setAccountShareBps`), `GUARDIAN` (pause, lower) | Safe; backend key                                      |
| Network     | `REWARDS` (`consumeBonus`)                                                          | Rewards                                                |
| LicenseSale | `DEFAULT_ADMIN` (price table, wiring, `sweep`)                                      | Timelock, 24 h                                         |
| LicenseSale | `OPERATOR`, `GUARDIAN` (pause `ENTRIES`; only OPERATOR unpauses)                    | Safe; backend key                                      |
| Network     | `REGISTRAR` (`register`), `LICENSE_HOOK`, `STAKING_HOOK`                            | TokenSale, Staking, LicenseSale (granted by the admin) |
| Network     | `WITHDRAWAL_HOOK` (`onWithdrawal`, BackFlow)                                        | Rewards                                                |
| Network     | `GUARDIAN` (freeze, blockSell), `OPERATOR` (also unfreeze, unblockSell)             | backend key; the Safe                                  |

### Wallets and fee exemptions

- **Treasury wallets** (`setWallets`, up to 16, rates in bps): each payment credits their buckets and the same
  `notifyPayment` sends every wallet its share, together with anything older left in its bucket (one send per wallet;
  BNB with at most `WALLET_SEND_GAS` = 50 000 gas). A wallet that cannot receive keeps its bucket (`ReleaseSkipped`) and
  never blocks the purchase; it, or anyone for the registered wallets, pulls it with `release` / `releaseAll`.
- **VEX fee-exempt**: TokenSale (buyers receive exactly `vexAmount`), Treasury, Staking (principal moves 1:1), Rewards
  (the vault; payouts and funding move 1:1), Jump (its allocation; `fund` checks it) and the airdrop wallet; the
  contracts check this on every transfer and revert `FeeNotExempt` otherwise.

### Deployment wiring checklist

Every line was checked against the code (the error or the call that needs it is named); `test/system/System.fixture.ts`
performs exactly this wiring on a local chain and the system test and `test/system/Gas.ts` run on top of it. Proxies are
deployed with `upgrades.deployProxy(..., { kind: "uups" })`; the initializer arguments are in the contract notes above.

1. **StakingMath and NetworkFreeze libraries.** Deploy `StakingMath` once (external library, its public functions run by
   `DELEGATECALL` on `Staking`'s storage); get the `Staking` factory with `{ libraries: { StakingMath } }` and deploy
   the proxy with `unsafeAllow: ["external-library-linking"]` (see `test/staking/Staking.fixture.ts`). Every later
   `Staking` implementation (an upgrade) must be linked again, to the same or to a new library address. `Staking` is 24
   174 bytes (limit 24 576), compiled with 169 optimizer runs: nothing may be added to it without moving code into the
   library. The Network is built the same way with `NetworkFreeze` (the freeze registry: `freeze`, `unfreeze`,
   `unfreezeMany`, `voidFreeze` run in the library by `DELEGATECALL`, the role checks, events and errors stay in
   Network): `getContractFactory("Network", { libraries: { NetworkFreeze } })` and
   `unsafeAllow: ["external-library-linking"]` (see `test/network/Network.library.ts`); the deploy engine has a
   `NetworkFreeze` step before the Network and `task:deploy:verify` passes the library address for it. `Network` is 22
   820 bytes, `NetworkFreeze` 3 987.
2. **Initializers.** `Staking(admin, vex, network, priceFeed, rewardVault)`: Rewards does not exist yet, so deploy with
   any vault (the admin) and call `setRewardVault(rewards)` afterwards (step 6).
   `Rewards(admin, vex, network, staking, priceFeed)`, `Jump(admin, vex, network, staking, priceFeed)`,
   `TokenSale(admin, vex, usdt, treasury, network, priceFeed)`,
   `LicenseSale(admin, license, usdt, treasury, network, priceFeed, staking)`. The admin passed in gets `DEFAULT_ADMIN`,
   `UPGRADER`, `OPERATOR` and `EXIT_PAUSER` (`Treasury`: `DEFAULT_ADMIN`, `UPGRADER`); it is never given `GUARDIAN`.
   `Staking.initialize` also gives the admin `AIRDROP_RELEASER_ROLE`: the hand-over moves it to the Safe (the admin
   console wallet, no timelock), `task:upgrade:staking` grants it on a live deployment.
3. **Hook roles on Network**, one per caller: `REGISTRAR_ROLE` (`register`) for TokenSale (first buy registers the
   sponsor), Staking and LicenseSale; `STAKING_HOOK_ROLE` (`setCapBase`, `markDeducted`, `onStakeOpened`) for Staking;
   `LICENSE_HOOK_ROLE` (`onActivated`, `onLicenseBought`) for LicenseSale; `WITHDRAWAL_HOOK_ROLE` (`onWithdrawal`,
   BackFlow) for Rewards. A holder can register accounts or credit bonuses, so no other account gets one. On a live
   Network `initializeV3(tokenSale, staking, licenseSale, rewards)` moves the four contracts from the old `HOOK_ROLE` to
   these roles. **REWARDS_ROLE on Network**: Rewards (`consumeBonus`). `Network.setPriceFeed(priceFeed)`
   (DEFAULT_ADMIN): without it, or without a VEX price, a license purchase pays no License Rewards (`SKIP_NO_PRICE`).
4. **Jump.** GRANTER_ROLE on Staking for Jump (`createGrantStake`); **HOOK_ROLE on Jump** for Staking (the slot hook)
   and `Staking.setJump(jump)` (DEFAULT_ADMIN; a Jump that reverts never blocks a stake, it emits `JumpHookFailed`).
   Jump needs nothing on Network but the read access every account has.
5. **REWARDS_ROLE on Staking**: Rewards (`consumeIncomeSplit`, `consumeIncome`).
6. **Reward vault.** `Staking.setRewardVault(rewards)` (DEFAULT_ADMIN): the early-close fee and the deductions land in
   the Rewards contract. OPERATOR `Rewards.fund(amount)` puts the reward VEX in.
7. **Treasury.** PAYER_ROLE for TokenSale and LicenseSale (`notifyPayment`), RESERVE_SPENDER_ROLE for TokenSale only
   (sell-back and current-price payouts; Rewards pays no USDT and gets no role, an earlier Rewards held it for the USDT
   License claims), `setWallets` (up to 16 wallets), `fundReserve` for the USDT the sell-back and the current-price
   sales are paid from. **License**: MINTER and BURNER for LicenseSale.
8. **PriceFeed.** `setRoundSource(tokenSale)`, `setBnbFeed(chainlinkBnbUsd, maxAge)`, OPERATOR `setManualPrice` and
   DEFAULT_ADMIN `setVexPriceMode` (ROUND is the mode once the sale is the source; a mode whose source is not set
   reverts `ModeNotConfigured`).
9. **VEX fee exemptions** (`Vexaro.setExempt`, EXEMPT_MANAGER): TokenSale, Staking, Rewards, Jump and the airdrop
   wallet. The contracts compare what arrives with what they sent and revert `FeeNotExempt` otherwise (TokenSale
   delivery, Staking pull / payout, Rewards `fund` and claims, Jump `fund`). The exemption of Jump and Rewards also
   keeps their `withdraw` 1:1 (the fee is charged only when neither side is exempt).
10. **Pools and rounds.** DEFAULT_ADMIN `addPoolVersion(id, params)` for the 14 pools of `deploy/params/stakingPools.ts`
    and `TokenSale.addRound`; DEFAULT_ADMIN `enablePoolHalves(1)` for Smart (the two-halves schedule, the catalogue's
    `halves` flag; the deploy engine does it and its check reads `poolHalves`); OPERATOR `launchPool` for the go-live
    pools, `fundRound` and `setActiveRound`. OPERATOR funds Jump (`fund`) before the first grant.
11. **Limits that start closed or at the default values.** The early-close refund cap `Staking.setRefundCapUsdt`
    (OPERATOR, **in USDT**, converted at the price of each close) starts at 0, which refuses every early close
    (`EarlyCloseRefused`) until it is set (the default is 1 000 USDT). The Rewards daily cap starts at 2 000 USDT
    (OPERATOR sets, GUARDIAN may only lower), the whole-balance switch on. One account may use 25 % of the Rewards daily
    cap (`Rewards.setAccountShareBps`: nothing to set, the default applies while the stored value is 0); the early-close
    refund cap has no per-account share. `Network.setBackFlow(bps, levels)` is bounded to `bps * levels <= 500` (5 %,
    the share a VEX claim keeps in the vault for BackFlow; the default is 0.5 % on 10 levels); Network's rate tables
    start at the defaults and only DEFAULT_ADMIN changes them. 11b. **Sell credit wiring.** SELL_CREDITOR_ROLE on the
    TokenSale for Rewards and Jump, `Rewards.setTokenSale(tokenSale)` and `Jump.setTokenSale(tokenSale)` (DEFAULT_ADMIN;
    zero switches the credit off), the fixed reserve floor `TokenSale.setReserveFloorFixed` (default 0) and the GUARDIAN
    freeze budget (default 50); the deploy engine does all of it on a new deployment. The daily limits of the
    purchase-price `sell` are set by `TokenSale.initializeV3(2000e18, 20000e18)` inside the upgrade of a live sale (a
    new deployment starts with them).
12. **Role holders.** GUARDIAN (the key held by the main backend) is granted by OPERATOR, not by DEFAULT_ADMIN, on every
    Managed contract that should have it (it can pause ENTRIES / REWARDS, freeze, block sell-back, reject Jump grants,
    lower caps; it never unpauses). DEFAULT_ADMIN and UPGRADER (and the VEX fee / exemption managers) are held by the
    24-hour timelock, whose only proposer, canceller and executor is the 2-of-3 Safe; OPERATOR and EXIT_PAUSER are held
    by the Safe, which acts at once. The deployer holds no role (it renounced `DEFAULT_ADMIN` and everything else it
    held, see `--renounce-admin`).
13. **Operational warnings.** `Rewards.withdraw` (DEFAULT_ADMIN) is **not limited by the claims still outstanding**: the
    unclaimed staking income, cashback and License credits are per account in Staking and Network and are not summed on
    chain, so the vault balance has to be watched against the backend's total (`Rewards.vaultBalance`). `Jump.withdraw`
    is not limited by unclaimed grants either; `Staking.rescue` is limited to VEX above the staked principal.
14. **Gas.** The paths above the 1.5 M limit are listed in [docs/gas.md](docs/gas.md): a STAKING claim of an account
    with 50 open stakes **and** 32 freeze intervals (2.1 M with BackFlow, 1.5 M from 24 intervals on), the first stake
    of an account that already has invitees under a 255-account sponsor chain with 15 paying levels and the fourth Jump
    slot (1.5 M), and the view `incomeOf` / `consumeIncome` at 32 intervals (1.6 M). At 32 freeze intervals
    `Network.freeze` reverts `FreezeLimit` for GUARDIAN and OPERATOR alike; the Safe makes room with `voidFreeze` (an
    empty interval does not count and is dropped by the next `freeze`).

### Upgrades

The contracts first deployed from `5595fb3` (`deployments/bsc.json`) were upgraded in place with the task sequence
below; every step is a UUPS upgrade, run before the hand-over to the Safe. Storage is append-only everywhere.

#### Core upgrade (Treasury, Network, TokenSale, Rewards, Jump)

The first upgrade replaced **Treasury, Network, TokenSale, Rewards and Jump** (Vexaro and License are not upgradeable,
Staking was 114 bytes under EIP-170). Storage is append-only. Each of the four contracts but the Treasury got a
`reinitializer(2)` step `initializeV2` that ran inside `upgradeToAndCall`: Network seeded the License Rewards owed from
the chain's events and set the GUARDIAN budget to 50, TokenSale set the fixed part of the reserve floor, Rewards and
Jump set the TokenSale. Both networks have run it (the initializer version of the four proxies is 2 on BSC mainnet and
on BSC testnet), so the steps, the task that ran them (`task:upgrade:core`) and its tests were removed; the record stays
in `deployments/<network>.json` (`upgrades`).

| Area               | Change                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freeze             | Network: `voidFreeze`, `unfreezeMany`, GUARDIAN freeze budget per UTC day, empty intervals do not count against `MAX_FREEZES`                           |
| Current-price sale | TokenSale: entitlement (lots + credit), `SELL_CREDITOR_ROLE`, `creditCurrentSell`; Rewards credits the net of every VEX claim, Jump the grant principal |
| Reserve floor      | TokenSale: reserve floor = the fixed part (nothing is owed in USDT any more)                                                                            |
| BNB reserve        | Treasury: `withdrawBnbReserve(to, amount)` (DEFAULT_ADMIN, BNB only; USDT stays reachable through RESERVE_SPENDER only)                                 |
| VEX pulls          | `_takeVex` checks the balance delta (`FeeNotExempt`); `vexExcess()` fails with `InventoryExceedsBalance`, not a panic                                   |

`task:deploy:check` still shows whether the five proxies run the compiled build (implementation rows).

#### Network upgrade (License Rewards as VEX)

License Rewards (LR) are credited as **VEX on the cashback balance**: at each license purchase the LR share is computed
in USDT as before (rate per level, `floor(usdtValue * rate / 10 000)`), converted to VEX at the PriceFeed price of that
moment (the price Network already used to count LR against the cap) and recorded with the Network Cashback and BackFlow
credits. LR are then claimed with `Rewards.claim(KIND_CASHBACK, ...)` under the cashback rules (24 h, 5 USDT minimum, at
most 50 % of the open stakes, 10 % fee = 5 % burned + 5 % BackFlow, the VEX daily cap, the sell credit of the net VEX).
There is no LICENSE balance any more: the LICENSE kind stayed in Rewards and Network for what an earlier Network version
credited in USDT (always 0 on mainnet, where no license was bought while LR were paid in USDT; possibly non-zero on
testnet) until it was removed from Rewards (see the largest-stake upgrade).

- **One contract changes: the Network implementation** (logic only: no new variable, no initializer, the storage layout
  is identical; `upgradeToAndCall(newImplementation, 0x)` by UPGRADER_ROLE). Rewards, Staking, StakingMath, LicenseSale,
  TokenSale and Treasury are NOT upgraded: their bytecode is identical (comments only changed).
- **The cap** keeps its meaning (VEX value at the credit price); a trimmed LR credit is the room in VEX itself (no round
  trip to USDT and back, so no rounding loss).
- **Staking's early-close deduction needs no change**: it adds up `vexCum` (every VEX credit since the stake opened and
  after the account's deducted mark) and converts only the legacy `usdtCum` at the current price. A License Reward is
  already in `vexCum`, so it counts in full, at the price of the credit and not at the price of the close. A stake that
  was opened before the upgrade keeps its marks: legacy USDT credits after its marks are still converted, new VEX
  credits are added (`test/upgrade/Network.upgrade.ts`).
- **ABI:** unchanged (function and event signatures are the same). Meaning changes: `BonusCredited.wanted/.credit` of
  program LR are VEX wei from the upgrade block on; `bonusBalances(...)[1]`, `bonusTotals(...)[1]` and `licenseOwed()`
  only hold the legacy USDT part and never grow.
- **Funding:** LR now come out of the reward VEX vault (`Rewards.fund`), not out of the Treasury USDT reserve: size the
  vault for them. The Treasury reserve keeps backing the sell-back and the current-price sales.
- The upgrade is run by `task:upgrade:network` ([docs/deploy.md](docs/deploy.md) section 13); `task:deploy:check` shows
  the Network implementation as DRIFT until it has run.

#### Staking upgrade (airdrop hold)

An AIRDROP stake (`Staking.stakeAirdrop`) is **on hold**: it accrues its daily income and matures exactly as before (95
% base return and the vesting of the VEST pools are unchanged), but neither can be claimed until an admin releases the
holder. The condition for a release (the team volume of the holder, limited to its license levels and to paid partner
stakes, must reach three times the airdrop USDT at the grant) is computed **off chain** by the backend and shown to the
admin as a hint; the contract does not check it.

- **What is held.** While an AIRDROP stake is open and its id is above the release mark of its owner: its income is left
  out of `incomeOf` / `consumeIncome` (so `Rewards.claim` KIND_STAKING can not take it; USER and JUMP stakes of the same
  account stay claimable) and it appears in the new view `heldIncomeOf(account)`; `closeMatured` and `closeEarly` of it
  revert `StakeOnHold(stakeId)` (the hold is reported first, before the maturity or the EARLY_NOT_USER refusal). A held
  stake is OPEN, so `claimVested` of it answers `WrongState`: the vesting can only start after a release.
  `isStakeHeld( stakeId)` says whether a stake is held. **Partner income is never held**: Network Cashback, License
  Rewards, BackFlow and the Jump grants are untouched (Network and Jump are not upgraded).
- **Release.** `releaseAirdropHold(account)` (new `AIRDROP_RELEASER_ROLE`, DEFAULT_ADMIN is its role admin) releases
  **every open AIRDROP stake the account has at that moment** and returns `(stakes, income)`; event
  `AirdropReleased(account indexed, releasedUpTo, stakes, income, by indexed)`. The released stakes' accrual is
  claimable income from then on and their principal follows the normal close and vesting rules. It reverts
  `NothingToRelease( account)` when the account has no held stake (an unknown account, only USER / JUMP stakes, or
  already released), and is not paused by any flag. Per account and not per stake ids: the grant condition is per
  holder, one call is O(open stakes) with no id list to get wrong, and the storage is one word per released account.
- **Storage (append-only).** One member at the end of the Staking namespace:
  `mapping(address => uint256) airdropReleasedUpTo` (a stake id). A stake is held while
  `source == AIRDROP && state == OPEN && id > mark(owner)`. The mark is 0 by default, so **every AIRDROP stake that
  exists when the contract is upgraded is held with no migration loop**; a release sets the mark to the newest stake id,
  so AIRDROP stakes opened afterwards (a new grant, a new condition) have a higher id and are held again. The hold is
  derived, not stored per stake: the indexer follows `StakeOpened` (source 2 = held from then on) and `AirdropReleased`
  (every stake of the account with an id up to `releasedUpTo` is released). `StakeView` is unchanged.
- **Accounting at the upgrade.** `Account.claimed` counts everything Rewards consumed, also the income of AIRDROP stakes
  claimed before the hold existed. While the stakes are held, `incomeOf` = settled + free accruals - claimed (0 floor)
  is therefore lower than the entitlement of an account that had claimed airdrop income before by exactly that amount;
  the release restores it (`incomeOf` after the release equals what was claimable before the upgrade), and nothing is
  ever paid twice. `heldIncomeOf` shows the full accrual of the held stakes. On BSC testnet the one existing AIRDROP
  stake had claimed nothing; on mainnet there is no stake at all yet.
- **Stakes closed before the upgrade** are outside the hold (a VESTING stake keeps vesting, its income is settled): no
  mainnet stake exists, and the testnet one is open.
- **Two contracts change: the Staking implementation and the StakingMath library** (a new library address: the income
  loop and the release live there; the Staking implementation links it). Rewards, Network, Jump and the others are NOT
  upgraded (their bytecode is identical); `IStaking` is unchanged. The Staking implementation is compiled with 100
  optimizer runs (`hardhat.config.ts`): at 800 it exceeded EIP-170 with the hold (24 462 bytes before, 23 920 now).
  `initialize` of a fresh deployment grants the role to the admin; an upgrade has no initializer: `task:upgrade:staking`
  grants it (to the deployer before the hand-over, to the multisig after it; the hand-over moves it to the multisig like
  OPERATOR).
- **ABI.** New: `AIRDROP_RELEASER_ROLE()`, `releaseAirdropHold(address) returns (uint256 stakes, uint256 income)`,
  `heldIncomeOf(address)`, `isStakeHeld(uint256)`, `airdropReleasedUpTo(address)`, event `AirdropReleased`, errors
  `StakeOnHold(uint256)` and `NothingToRelease(address)`. Changed behaviour: `incomeOf` / `consumeIncome` exclude held
  income; `closeMatured` / `closeEarly` of a held stake revert. StakingMath gains `heldIncome` and `release` (it has an
  ABI file in `deployments/abis/`).
- The upgrade is run by `task:upgrade:staking` ([docs/deploy.md](docs/deploy.md) section 14); `task:deploy:check` shows
  the Staking role row as DRIFT until it has run.

#### Largest-stake upgrade (largest open stake, airdrop eligibility, batch release)

**The rule.** The base of the partner-bonus cap and of the withdrawal maximum is the account's **largest single OPEN own
stake**, not the sum: any pool, **USER and AIRDROP stakes** (an AIRDROP stake counts also while it is on hold), **never
a JUMP stake**; measured by the stake's principal in VEX, the lowest stake id wins a tie. The cap is still 200 % of it
(Lite 100 %) and the counter still restarts at each license activation (except a Lite over a running Lite). When the
largest stake closes, the base falls to the next largest open one; bonuses already credited above the new cap stay
(nothing is clawed back) and new ones stop while `used >= limit`. The withdrawal maximum (Rewards) is half of the
**principal in VEX of the same stake** (before this upgrade: half of the sum of the entry USDT of all open USER stakes).
Applies to everyone from the upgrade on; no license was bought on mainnet before it.

**Eligibility.** Every place that required an open own USER stake accepts an open own AIRDROP stake as well, also while
the hold is on; a JUMP stake never counts anywhere:

| Place                                                                              | Before                         | Now                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| Partner bonuses NC / LR / BackFlow, `Network._eligibility` (`cap.base == 0` skips) | base = sum of the USER stakes  | base = largest USER / AIRDROP stake (`Staking.setCapBase` pushes it)    |
| Withdrawal maximum and eligibility, `Rewards._terms`                               | 50 % of the sum of USER stakes | 50 % of the principal (VEX) of the largest USER / AIRDROP stake         |
| Lite, `LicenseSale._liteStatus`                                                    | `Staking.openP15Now` (USER)    | `Staking.hasOpenOwnP15`: USER or AIRDROP stake of P1-P5                 |
| VEX Jump (`Jump.onStakeOpened` / `claimJump`, `openP15At` / `openP15Now`)          | inviter's USER P1-P5 stake     | **unchanged**: an AIRDROP stake does not make the inviter Jump-eligible |
| Network Cashback on the stake of a downline (`Staking._stake`, `onStakeOpened`)    | USER stakes only               | **unchanged**: an AIRDROP (or JUMP) stake pays nothing to the uplines   |

Bonuses earned by an airdrop-only holder are normal free VEX on the cashback wallet (not held).

**Design.** Staking keeps one record per account, `largest[account] = (stakeId uint64, principal uint96)` (one slot,
appended at the end of the Staking namespace). Opening a USER / AIRDROP stake compares its principal with the record
(O(1), one write when it is larger); closing a stake that is not the recorded one does nothing; closing the recorded one
finds the next largest in the open list (at most 50 stakes: one `openIds` read and one stake-slot read each, a second
slot only for a stake that beats the best so far). After every open or close of a USER / AIRDROP stake Staking pushes
the record's principal with `Network.setCapBase` (Network writes and emits `CapBaseSet` only when the value changed), so
**Network and the cap math are unchanged**. The record is derived data: an account last touched before the record
existed has none (`stakeId` 0) and the views read its open list until the next open / close writes it. The old sums
`openPrincipalOf` / `openEntryUsdtOf` stayed (USER stakes only) as informative views; the later upgrade drops them.

**New in the ABI** (Staking; `StakingMath` gains the same library functions):
`largestOpenOf(account) -> (stakeId, principal, entryUsdt)` (all zero without an own stake),
`hasOpenOwnP15(account) -> bool`, `releaseAirdropHoldBatch(address[]) -> released` (AIRDROP_RELEASER_ROLE, 1 to 50
accounts, `InvalidBatchSize(size)`; releases each account like `releaseAirdropHold`, skips an account with nothing on
hold without a revert, emits one `AirdropReleased` per released account), `syncCapBase(address[])` (anyone, 1 to 50
accounts: records the largest stake of each and pushes it to Network, idempotent). New interface `IStakingOwn` (the two
views, so that the legacy test fixtures keep implementing `IStaking`). **No new event; no changed signature.** Changed
meaning: `Network.capOf(...).base`, `MemberView.capBase`, `CapBaseSet(account, base)` and
`Rewards.claimsOf(...).maximum` follow the largest stake; `CapBaseSet` now also fires when an AIRDROP stake opens or
closes. `CheckpointUnorderedInsertion()` left the Staking ABI (the checkpoint push moved into the library; unreachable).
LicenseSale has no ABI change (it calls the new view); Rewards changes as described next.

**The legacy USDT License wallet is removed, in the same upgrade.** No license was ever bought on mainnet and Rewards
and Network hold 0 USDT (read-only check), so nothing has to migrate; the testnet legacy USDT balances are abandoned.
`Rewards`: kind 2 is gone (`claim(2, ...)` and `lastClaimOf(_, 2)` revert `InvalidKind`), no USDT minimum / maximum /
daily limit / payout; `claimsOf` returns `ClaimInfo[2]` (STAKING, CASHBACK), `capsOf()` returns the one VEX `CapInfo`,
`KIND_LICENSE` is removed, `setDailyCap` accepts the VEX token only (USDT: `UnknownToken`) and `initialize` emits one
`DailyCapSet`. `Staking` / `StakingMath`: an early close deducts the VEX credits only (`usdtCum` is not converted,
`markDeducted(account, vexCum, 0)`), `usdtMark` is no longer written (the `StakeOpened` event keeps its 9 fields,
`usdtMark` is 0). `Network` is NOT changed: `bonusTotals` / `bonusBalances` / `markDeducted` keep their USDT fields (0
on mainnet). Storage is append-only and unchanged: `Rewards.licenseLimit`, `lastClaim[account][2]`, the `usdt` and
`treasury` wiring and `Stake.usdtMark` stay as deprecated slots.

**Migration.** No per-account data has to be seeded: the record is lazy. What must move is the base that **Network**
stores for an account with more than one open stake or an AIRDROP stake (it holds the old sum):
`task:upgrade:largest-stake` finds those accounts from the stakes and sends `syncCapBase` for them (50 per transaction,
no role needed) right after the upgrade. **Mainnet today: no stake has ever been opened (`stakeView(1)` is empty,
`totalPrincipal` is 0), so there is nothing to sync**; BSC testnet has 19 stakes, 4 accounts, 3 of them with more than
one open stake and 1 AIRDROP-only account (all 4 are re-based by the sync).

**Contracts that change:** Staking (compiled with 100 optimizer runs, **23 799** bytes of 24 576), StakingMath (a new
library address, 11 594 bytes), Rewards and LicenseSale (the two reads above). **Network is not upgraded** (only its
comments changed; the bytecode on chain is the compiled one).

**Gas** (Hardhat network, one transaction from an EOA, 21 000 included; `test/staking/StakingGasLargest.ts`,
`test/system/Gas.ts`): opening a stake +0 to +27 k (a first USER stake 391 k -> 418 k, a repeat 274 k -> 276 k, a first
AIRDROP stake 242 k -> 295 k because it now tells Network its cap base); a close that is not the largest stake costs
what it did (`closeEarly` 347 k); closing the **largest of 50 open stakes** adds one pass over the other 49
(`closeEarly` 520 k; with 32 freeze intervals the close of the largest of 50 stakes is 0.6-0.7 M, under the 1.5 M
limit); `Rewards.claim` pays one more view (+3 k, 276 k for a typical claim); `releaseAirdropHoldBatch` of 50 accounts
with one stake each is 2.2 M (44 k per account), 50 accounts with nothing on hold 1.05 M, one account with 50 held
stakes 0.59 M (so 50 x 50 would be 28.7 M without freeze intervals; with 32 freezes each, 1.6 M an account, send fewer
accounts); `syncCapBase` of 50 accounts in sync 0.89 M. Why 50 accounts: one batch of ordinary holders (a few stakes
each) is far below a block; an oversized batch only runs out of gas and reverts whole, it can not do harm. **A caller
sizes the batch by estimating its gas** on the current state (the bound of 50 accounts is not a promise that 50 fit: a
batch of accounts with many held stakes and freeze intervals does not fit in a block) and splits a long list into
several transactions.

The upgrade is run by `task:upgrade:largest-stake` ([docs/deploy.md](docs/deploy.md) section 15), before the hand-over
(the Ledger is the sender). Tests: `test/staking/Staking.largest.ts` (largest vs sum, AIRDROP counts, JUMP does not,
close of the largest, tie, 50 stakes, over-cap stop without claw-back, activation reset, Lite, batch release, sync),
`test/rewards/Rewards.rules.ts`, `test/licenseSale/LicenseSale.lite.ts`, `test/upgrade/LargestStake.upgrade.ts`,
`test/upgrade/LargestStake.fork.ts` (opt-in, a fork of BSC mainnet with the Ledger impersonated) and the extended
invariants (`test/staking/Staking.invariant.ts`, `test/system/System.invariant.ts` + `System.ledger.ts`).

#### Release upgrade (built, not on mainnet yet): share of the Rewards daily cap, clean-up

One more upgrade of Network, LicenseSale, TokenSale, Jump, Staking (with a new StakingMath), Rewards and, as libraries,
NetworkFreeze (new) is built on this branch; the sections of those contracts above describe the new rules (the Lite
activation period and the restore of missed partner credits, the sell limits and the 24 h maturity, the invitee checks
and the grant credit of Jump, the two-halves schedule of Smart). It is run by **one task, `task:upgrade:release`**
([docs/deploy.md](docs/deploy.md#16-release-upgrade-every-contract-that-changed-since-the-live-build) section 16): it
upgrades whatever differs from the build on chain in one atomic Safe batch together with `Network.initializeV3`,
`TokenSale.initializeV3(2000e18, 20000e18)`, `Treasury.releaseAll` for USDT and BNB,
`Treasury.revokeRole(RESERVE_SPENDER_ROLE, Rewards)` and `Staking.enablePoolHalves(1)`, after read-only pre-checks (no
open Smart stake, the Jump cycles that need `recordSlotStakes`, the initializer versions); `--renounce-admin` then makes
the deployer leave every role. Tests: `test/upgrade/Release.upgrade.ts`, `test/deploy/HandoverExit.ts` and, opt-in on a
mainnet fork, `test/upgrade/Release.fork.ts`. What this part of it does:

- **Share of the Rewards daily cap.** One account can use 25 % of the Rewards daily cap (500 of 2 000 USDT) per UTC day,
  so the first callers of a day can no longer use up the whole cap. The share is a number of basis points of the cap in
  force, OPERATOR-settable from 1 % to 100 % (`Rewards.setAccountShareBps`; GUARDIAN may only lower it). The stored
  value 0 means 25 %, so the rule is live with the new implementation and **needs no initializer call**. The usage per
  account starts empty: a claim counted on the day of the upgrade stays in the global usage but not in the account's, so
  on that day an account may use its share once more. A refusal has its own error
  (`AccountDailyCapExceeded(requested, room)`); the site reads the state before the user signs from
  `Rewards.accountCapOf` and the share view. The early-close refund cap has no per-account share: a stake closes as a
  whole, so a share below the refund of a large stake would make that stake impossible to close early.
- **Dead code removed, storage kept.** Rewards: `setTreasury`, `TreasuryChanged`, `usdt()` and `treasury()` (and the two
  addresses are no longer set by `initialize`, whose arguments are now `(admin, vex, network, staking, priceFeed)`); the
  one-time steps `initializeV2` of Network, TokenSale, Rewards and Jump (all four proxies are past version 2 on both
  networks; the next one-time steps are `Network.initializeV3(tokenSale, staking, licenseSale, rewards)` and
  `TokenSale.initializeV3(2000e18, 20000e18)`); Staking: `openPrincipalOf`, `openEntryUsdtOf` and the alias
  `MAX_RELEASE_BATCH`. The sums behind the two views are no longer written on a stake open and close (up to 20 000 gas
  less on the first stake of an account, 3 000 to 5 000 afterwards); the fields stay as deprecated storage. The
  `StakeOpened` event keeps its `usdtMark` argument, which is always 0.
- **Rewards holds no role on the Treasury.** It pays no USDT. The deploy engine no longer grants `RESERVE_SPENDER_ROLE`
  to it; on a live deployment the Safe revokes the role it still holds
  (`Treasury.revokeRole(RESERVE_SPENDER_ROLE, rewards)`, call 10 of the batch of `task:upgrade:release`).
- **The Treasury sends the wallets' shares with each payment.** `notifyPayment` splits the payment as before and then
  pays every registered wallet its share in the same transaction, plus whatever an earlier failed send left in its
  bucket (`Released` per wallet; `BucketCredited` is still emitted). The unshared remainder (40 % today) stays in the
  contract as the reserve that pays the sell-back and the current-price sales. The rates and the wallets do not change.
  A wallet that cannot receive (a reverting contract, one without `receive`, one that runs out of gas, a token that
  refuses or returns false) never fails the purchase: its share stays in its bucket, `ReleaseSkipped` says so, and the
  next payment (or `release` / `releaseAll`) sends it. BNB goes with at most `WALLET_SEND_GAS` (50 000), so a receiver
  cannot burn the buyer's gas; the three mainnet wallets are plain accounts (no code). The state is settled before any
  send and every Treasury entry point is `nonReentrant`, so a receiver that calls back is refused and cannot be paid
  twice. Storage is unchanged. The release batch upgrades the Treasury and then calls `releaseAll` for USDT and for BNB,
  so the buckets that exist today leave at once; `--check` lists the bucket of every registered wallet.
- **Optimizer runs.** With the dead code gone Network compiles with 800 runs again, TokenSale with 210 and Staking with
  169 (`hardhat.config.ts`; the highest counts that keep at least 300 bytes under EIP-170, see "Static analysis"; the
  two-halves schedule took Staking from 210 to 169 runs).

### Risks and trust assumptions

- **OPERATOR (the Safe, no timelock) is trusted with the sale parameters.** It can change the active round
  (`setActiveRound`), the manual VEX price (`setManualPrice`) and the current-sell caps instantly. With the entitlement
  and the floor this cannot empty the reserve through VEX the attacker does not hold an entitlement for, and it cannot
  take the reserve below the fixed floor, but it can still move the price at which entitled VEX sells. This is an
  accepted trust assumption; `DEFAULT_ADMIN` and `UPGRADER` actions go through the 24-hour timelock, so they are visible
  a day before they take effect.
- **The daily limits are shared.** The caps of the Rewards claims, of the early-close refunds and of the sell-back are
  per UTC day for everybody, so a few large accounts could use them up for the day. The Rewards claims and the sell-back
  have a per-account share (Rewards claims: 25 % of the cap, OPERATOR-settable; the sell-back: its own per-account cap),
  so one account can not block the others there. The early-close refunds have none, because a stake closes as a whole: a
  few large early closes can use up the refund cap of a day, and the next ones wait for the next UTC day or for a higher
  cap.
- **BackFlow on AIRDROP and JUMP stakes.** BackFlow is paid on the gross of every VEX claim, and the income of AIRDROP
  and JUMP stakes is claimed through Rewards like any income, so their holders' uplines earn BackFlow on it. This is
  intended; Network Cashback and the partner bonuses are not paid on the stakes themselves.
- **A GUARDIAN freeze.** Frozen days are forfeited while the freeze lasts, but the Safe can void it (`voidFreeze`,
  `unfreezeMany(..., true)`) and the STAKING accrual is restored. NOT restored: NC / LR / BF credits skipped while the
  account was frozen, and income already claimed during the freeze. The GUARDIAN freeze budget (50 per UTC day by
  default) bounds what a leaked key can do per day.
- **Other VEX.** The current-price sale is limited by an amount: the matured lots plus the sell credit. It does not
  follow particular tokens, so an account that holds such an amount may sell any free VEX it owns, DEX-bought VEX
  included, up to it. VEX the account has no entitlement for (DEX purchases beyond it, VEX received from other wallets,
  airdrop VEX) cannot be sold at the current price. It can still be staked, and Network Cashback is paid to the sponsors
  on such a stake (`stake()` is unchanged).
- **Reserve floor.** The floor (`reserveFloorFixed`) holds back the current-price sale only, not the purchase-price
  `sell` (which keeps its own lots and daily limits as the limit) and not the early-close refunds (which are VEX).
- **Dust lock on the airdrop wallet.** `Vexaro.setAirdropWallet(newWallet)` reverts `AccountHasLock` if `newWallet`
  holds airdrop-locked VEX, and anyone can send a locked wei to a wallet that was announced before the change. Fee
  exemption does prevent it: a transfer to a fee-exempt receiver keeps no lock behind (`_airdropGate`: "a burn or an
  exempt receiver keeps no lock"). Procedure: (1) make the new wallet fee-exempt FIRST (`setExempt(newWallet, true)`,
  EXEMPT_MANAGER, executed before the next step); (2) check `airdropLockedOf(newWallet) == 0`; (3) only then call
  `setAirdropWallet(newWallet)`. If a lock got there anyway, the new wallet sends the locked amount to the CURRENT
  airdrop wallet (always allowed, the lock shrinks), then the change goes through. Doing both in one batch does not
  help: the dust can arrive before the exemption applies.
- **Kept views.** `PriceFeed.usdtToVexCeil` and `Network.isFrozenAt` have no on-chain caller; they stay as views for the
  backend and the UI. A few more views are read by no backend, site or admin code (Jump `currentCycle`, `grantsOf`;
  LicenseSale `licenseOptions`; Staking `vestedOf`; TokenSale `roundCount`; Treasury `accounted`, `bucketsTotal`,
  `totalRateBps`) and stay: every contract has at least 300 bytes under the size limit without removing them. The
  maintenance operations `allocateExcess`, `setSellSink`, `setBnbMaxAge` and `releaseAll` stay as well.

## Usage

### Pre Requisites

Install dependencies (this repo uses [Bun](https://bun.sh)):

```sh
bun install
```

[Hardhat Configuration Variables](https://hardhat.org/hardhat-runner/docs/guides/configuration-variables) are
**optional**: compile, test and coverage run without any. Only live networks need them: `LEDGER_ACCOUNT` (the Ledger
account that deploys to BSC mainnet; there is no private key for it), `TESTNET_DEPLOYER_KEY` (BSC testnet only: the
throwaway deployer key, set as `HARDHAT_VAR_TESTNET_DEPLOYER_KEY` in the environment of the hardhat process, never in a
file), `ETHERSCAN_API_KEY` (verification: an Etherscan API V2 key from etherscan.io, one key for all chains, BSC
included) and optionally `BSC_RPC_URL` / `BSC_TESTNET_RPC_URL` (an RPC that serves `eth_getLogs` for
`task:deploy:check --holders`), set with `bunx hardhat vars set <NAME>` or `HARDHAT_VAR_<NAME>` in CI. `PRIVATE_KEY` /
`INFURA_API_KEY` only serve the template's other networks. The wiring every deployment needs is the
[Deployment wiring checklist](#deployment-wiring-checklist).

### Compile

```sh
bun run compile
```

### TypeChain

Compile the smart contracts and generate TypeChain bindings (`types/` is generated output — never edit it by hand):

```sh
bun run typechain
```

### Test

```sh
bun run test
```

Run a single suite:

```sh
bunx hardhat test test/staking/Staking.close.ts
```

Tests use per-suite `*.fixture.ts` fixtures plus `loadFixture` snapshots. Every contract has unit and revert-path tests
(`test/<contract>/`), plus:

- `test/system/`: the **system** (`System.fixture.ts`: every contract behind its proxy, wired as in the checklist
  above): `System.invariant.ts` runs random actions of all kinds (buys, sell-backs, licenses, stakes in all pools, early
  / matured closes, vesting, the three reward claims, Jump slots / grants / reject / restore, airdrops with their locks
  (stakeAirdrop, returns, locked transfers), freezes, sell blocks, every pause flag, price modes, daily caps, refund
  cap, Treasury, round administration, 50-stake wallets, long time jumps) from several seeds. Every event of every step
  is replayed into a shadow model (`System.ledger.ts`) that checks the rules with an oracle that shares no code with the
  contracts and fails on a violated invariant: the principal obligations of Staking, claimed <= accrued + credited per
  balance type, the bonus cap, each credit deducted once on early close, the vault and Treasury reserve balances, the
  daily caps, Jump (at most four grants, only full eligible cycles, never a rejected one, never above the allocation),
  airdrop locks (never above the balance, free VEX never blocked), frozen accounts and the 50-stake limit. A revert that
  is not a custom error of the system (a panic or a bare revert) fails too. Seeds and length are environment variables:
  `SYSTEM_SEEDS=11,20261017 SYSTEM_STEPS=200 SYSTEM_DEEP_EVERY=20 bun run test test/system/System.invariant.ts`.
  `Gas.ts` measures every user-facing call of the wired system, typical and at the bounds, and holds each under a
  ceiling (`docs/gas.md`).
- `test/vectors/`: the shared License id table and the Staking accrual vectors, see below.
- `test/staking/`: Staking (pools, stakes, `stakeAirdrop` and grants, accrual, matured / early close and vesting,
  income, administration, reentrancy, gas) with an independent oracle, the shared vectors and a randomized model test
  (`Staking.invariant.ts`: stakes, grants, closes, claims, freezes and partner credits in random order; after every step
  the VEX held, the sums, the open list, the income and the vesting are compared with the model).
- `test/rewards/`: Rewards with real Staking / Network / Treasury / PriceFeed / LicenseSale (both kinds end to end, the
  removed LICENSE kind refused, 24 h edge, minimum, largest-stake maximum, no-stake 50 %, whole-balance switch on / off,
  daily caps, 90 / 5 / 5 and BackFlow over 1 to 12 uplines, price missing, frozen, pauses, vault, fee-exempt, wiring,
  reentrancy, upgrade, gas).
- `test/upgrade/`: storage-layout snapshots and `validateUpgrade`, see below; `Network.upgrade.ts`, `Staking.upgrade.ts`
  and `LargestStake.upgrade.ts` upgrade the earlier builds (`contracts/mocks/legacy/v2`, `v3`, `v4`, behind real proxies
  with live-like state) with the real upgrade tasks, direct and through a timelock.
- Per-account share of the Rewards daily cap: `test/rewards/Rewards.accountShare.ts` and `test/system/Shares.ts` (the
  wired system).
- Airdrop hold: `test/staking/Staking.hold.ts` (held income and exits, the release, the role, the views),
  `test/staking/Staking.invariant.ts` and `test/system/System.invariant.ts` (the hold and the release in the random
  models), `test/system/Airdrop.e2e.ts`, `test/upgrade/Staking.upgrade.ts` (the earlier Staking and StakingMath of
  `contracts/mocks/legacy/v3`, byte-identical to the deployed ones, behind a real proxy with AIRDROP stakes; upgraded
  directly and through a timelock), `Staking.manifest.ts` (the committed manifests) and `Staking.fork.ts` (opt-in,
  `STAKING_UPGRADE_FORK=1` with `STAKING_UPGRADE_FORK_URL`, `STAKING_UPGRADE_FORK_NETWORK=bscTestnet` for the timelock
  path).
- Freeze voiding and the current-price sale: `test/network/Network.freezeVoid.ts` (void, `unfreezeMany`, empty intervals
  and `MAX_FREEZES`, GUARDIAN budget, the License Rewards owed), `test/staking/Staking.voidFreeze.ts` (a voided freeze
  pays its moments again), `test/tokenSale/TokenSaleEntitlement.ts` (credit, entitlement, reserve floor, fee-exemption
  and inventory checks), `test/rewards/Rewards.sellCredit.ts` and `test/jump/Jump.sellCredit.ts` (the credit of claims
  and grants), `test/treasury/Treasury.bnbReserve.ts`, `test/vexaro/Vexaro.airdrop.ts` (the dust-lock runbook).

### Lint Solidity / TypeScript

```sh
bun run lint:sol
bun run lint:ts
```

Or everything at once (`solhint` + `eslint` + `prettier --check`):

```sh
bun run lint
```

### Coverage

```sh
bun run coverage
```

`contracts/mocks/` is excluded from the report (see `.solcover.js`). Coverage is 100 % of lines and branches for every
contract; CI fails below 95 % (`bun run coverage:check`, run after `bun run coverage`).

### Report Gas

See the gas usage per method call (hardhat-gas-reporter, off unless the flag is set):

```sh
REPORT_GAS=1 bun run test            # table on stdout
REPORT_GAS=1 REPORT_GAS_FILE=gas.txt bun run test
```

`docs/gas.md` has the summary of the main user actions.

### Static analysis

```sh
slither .
```

Bytecode sizes (runtime, limit 24 576 bytes, EIP-170) of this checkout: Network 24 245 (331 free; 800 optimizer runs,
the freeze registry is in the NetworkFreeze library, 3 987), TokenSale 23 846 (730 free; 210 runs), Staking 24 174 (402
free; 169 runs), Jump 21 792, Rewards 15 268, LicenseSale 14 904, Vexaro 11 186, Treasury 10 249, PriceFeed 9 563,
StakingMath 12 735 (library). The runs are the highest counts measured that leave at least 300 bytes free (Network 600:
24 182, 400: 23 617, 200: 22 754; TokenSale 225: 24 455, 200: 23 846, 100: 23 599; Staking 210: 24 333, 200: 24 333,
180: 24 325, 170: 24 299, 169: 24 174, 165: 24 131).

Configured by `slither.config.json`; every accepted finding is justified in `docs/slither.md`. CI runs it on each push.

### License id table

`test/vectors/licenseIds.json` is the table of the valid License ids (`id = tier * 1000 + days`: Lite 30 only, Basic to
Ultra 30 / 180 / 360). `test/license/License.ts` checks every row against `License.isValidId` and that the file is what
the test computes (`UPDATE_VECTORS=1 bun run test` rewrites it). The backend and the frontends read ids from it.

### Staking accrual vectors

`test/vectors/stakingAccrual.json` is the reward schedule of the 14 pools for min / mid / max / odd principals of the
USDT range at 0.036 USDT per VEX plus six frozen-day cases (62 vectors), as runs of equal daily credits. It is computed
by `test/staking/Staking.oracle.ts`, which shares no code with the contract (daily credits from the cumulative formula,
frozen days from a day-by-day loop), and `Staking.vectors.ts` checks both that the file is what the oracle computes
(`UPDATE_VECTORS=1 bun run test` rewrites it, then `bunx prettier --write test/vectors`) and that the deployed `Staking`
reproduces it at every run boundary (`accruedAt`), with the freezes made on the chain. The backend mirror takes its
vectors from this file.

### Upgrade safety

Every UUPS contract keeps its state in ERC-7201 namespaces and has a committed storage-layout snapshot in
`.storage-layouts/*.json` (members of each namespace and of the structs they use, in order). `test/upgrade/` fails when
a member is reordered, removed or retyped, or a namespace or its slot changes (append-only), checks the snapshot is up
to date, and runs `upgrades.validateUpgrade(current, current)` for each contract; the `*.manifest.ts` tests compare the
layout of this checkout with the implementations the proxies run now (`.openzeppelin/bsc.json`, `bsc-testnet.json`:
TokenSale, LicenseSale, Jump, Rewards, Staking, Network). `test/upgrade/Upgrade.ts` upgrades each of the 9 UUPS
contracts in place to a mock that appends a variable (`contracts/mocks/<Name>UpgradeMock.sol`): the OpenZeppelin
validation accepts it, its layout extends the committed snapshot, only the UPGRADER_ROLE can upgrade (not the other
roles, not a non-UUPS target), every read-only view and the roles survive, the appended slot works, and `initialize` can
not be run again on the proxy or on any implementation. After a legitimate append run `UPDATE_LAYOUTS=1 bun run test`,
`bunx prettier --write .storage-layouts` and review the diff (it may only add lines).

### Clean

Delete the smart contract artifacts, the coverage reports and the Hardhat cache:

```sh
bun run clean
```

### Deploy

The whole suite is deployed, wired, funded, checked and handed over by one engine (`tasks/deployAll.ts`,
`tasks/deploy/*`), driven by `deploy/params/<network>.ts`:

```sh
bunx hardhat task:deploy:all      --network bscTestnet --dry-run   # the steps, nothing sent
bunx hardhat task:deploy:all      --network bscTestnet             # deploy + wire + fund (idempotent, resumable)
bunx hardhat task:deploy:check    --network bscTestnet             # every wired value and role vs the params, exit 1 on drift
bunx hardhat task:deploy:verify   --network bscTestnet             # Etherscan V2 / BscScan (skipped without ETHERSCAN_API_KEY)
bunx hardhat task:deploy:handover --network bscTestnet             # timelock, roles to timelock / multisig, deployer renounces
bunx hardhat task:deploy:handover --network bsc                    # mainnet: roles straight to the Safe, the Ledger keeps DEFAULT_ADMIN
bunx hardhat task:governance:timelock --network bsc                # then: DEFAULT_ADMIN / UPGRADER / VEX managers move to a 24 h timelock
bunx hardhat task:deploy:handover --network bsc --renounce-admin   # last: the Ledger leaves every role it holds
bunx hardhat task:governance:call --network bsc --id <name> --calls <file>   # an admin call as the Safe's schedule / execute files
bunx hardhat task:upgrade:network --network bscTestnet --check     # the upgrades of a live deployment (docs/deploy.md sections 13 to 15)
bunx hardhat task:upgrade:release --network bsc --dry-run          # the combined upgrade (docs/deploy.md section 16)
```

Mainnet (`bsc`, Ledger) is deployed (`5595fb3`, `deployments/bsc.json`); the engine refuses a real run while a
`TODO(operator)` placeholder is left in the params. The runbook is [docs/deploy.md](docs/deploy.md) and the BSC testnet
deployment (addresses, faucet, admin wallet) is [docs/testnet.md](docs/testnet.md). BSC testnet signs with the throwaway
key in the hardhat var `TESTNET_DEPLOYER_KEY` (`HARDHAT_VAR_TESTNET_DEPLOYER_KEY`; only that network, never a file of
the repo); BSC mainnet signs with the Ledger only. Single-contract tasks: `task:deployVexaro`, `task:deployLicense`,
`accounts`. `test/system/System.fixture.ts` is the executable form of the same wiring on a local chain and
`test/deploy/` tests the engine (deploy, check, resume, drift, hand-over, params validation). `TestUSDT`
(`contracts/mocks/`, 18 decimals, open faucet capped at 100 000 per call) is the test-network stand-in for BSC-USD and
is never deployed on chain 56.
