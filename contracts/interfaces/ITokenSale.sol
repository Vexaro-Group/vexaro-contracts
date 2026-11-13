// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IRoundPriceSource} from "./IRoundPriceSource.sol";

/// @notice The VEX sale: rounds, buy with USDT / BNB, lots per (account, round) and FIFO sell-back. Round ids run
///         1..roundCount; `0` means "no round" (nothing is open). Prices are USDT wei per 1 VEX, amounts are wei.
interface ITokenSale is IRoundPriceSource {
    /// @dev The account already sold today (`sell` and `sellAtCurrentPrice` count together); it may sell again at
    ///      `nextSaleAt`, the next 00:00 UTC.
    error SaleAlreadyMadeToday(address account, uint256 nextSaleAt);

    /// @dev One round with its derived `remaining` (VEX still for sale: `funded - sold`).
    struct RoundView {
        uint256 id;
        uint256 price;
        uint256 allocation;
        uint256 funded;
        uint256 sold;
        uint256 remaining;
    }

    /// @dev What the account still holds as a sell-back lot of one round, and what selling it all would pay.
    struct LotView {
        uint256 round;
        uint256 vexAmount;
        uint256 price;
        uint256 usdtValue;
    }

    // ------------------------------------------------------------------ rounds (DEFAULT_ADMIN / OPERATOR)

    /// @notice Adds the next round (DEFAULT_ADMIN); at most 8.
    /// @return round The new round's id.
    function addRound(uint256 price, uint256 allocation) external returns (uint256 round);

    /// @notice Changes a round's price (DEFAULT_ADMIN); refused once the round has sold anything, because lots are
    ///         sold back at the price they were bought at.
    function setRoundPrice(uint256 round, uint256 price) external;

    /// @notice Changes a round's allocation, the most VEX it can ever hold in inventory (DEFAULT_ADMIN); not below
    ///         what is already funded.
    function setRoundAllocation(uint256 round, uint256 allocation) external;

    /// @notice Opens `round` for sale, closing the previous one; 0 closes sales (OPERATOR, manual switch).
    function setActiveRound(uint256 round) external;

    /// @notice Pulls `amount` VEX from the caller into `round`'s inventory (OPERATOR; the caller approved this
    ///         contract). Credits the balance actually received; the round's funding may not exceed its allocation.
    function fundRound(uint256 round, uint256 amount) external;

    // ------------------------------------------------------------------ user entry points

    /// @notice Spends `payAmount` of `payToken` (USDT, or address(0) = BNB sent as `msg.value`) on VEX at the active
    ///         round's price; the buyer gets `floor(usdtValue * 1e18 / price)`. The first purchase of an account
    ///         registers `sponsor` in Network (later calls ignore it).
    /// @param minVexOut Reverts `Slippage` when fewer VEX would be delivered.
    /// @return vexOut The VEX delivered.
    function buy(
        address payToken,
        uint256 payAmount,
        uint256 minVexOut,
        address sponsor
    ) external payable returns (uint256 vexOut);

    /// @notice Buys exactly `vexAmount` VEX, paying the rounded-up price. With BNB, `msg.value` must equal `maxPay`
    ///         and the part above the price is refunded.
    /// @param maxPay Reverts `Slippage` when the price would be higher.
    /// @return payAmount What was paid in `payToken`.
    function buyExact(
        address payToken,
        uint256 vexAmount,
        uint256 maxPay,
        address sponsor
    ) external payable returns (uint256 payAmount);

    /// @notice Sells `vexAmount` platform-bought VEX back for USDT from the Treasury reserve: FIFO from the lowest
    ///         round that still has a lot, each part at its round's price, each part's USDT rounded down. The USDT
    ///         paid out is limited per UTC day per account and in total (`SellLimitExceeded`, see `sellLimits`).
    /// @param minUsdtOut Reverts `Slippage` when the payout would be lower.
    /// @return usdtOut The USDT paid.
    function sell(uint256 vexAmount, uint256 minUsdtOut) external returns (uint256 usdtOut);

    /// @notice Sells `vexAmount` of FREE VEX (any origin; airdrop-locked VEX is refused by the token) at the current
    ///         `PriceFeed.vexPrice()`, paid from the Treasury reserve, and takes `min(matured lots, vexAmount)` off the
    ///         caller's FIFO lots (then the credit). Purchases count 24 hours after they were made. Reverts
    ///         `NotEntitled` above lots + credit, `LotsNotMatured` when only younger lots would cover it and
    ///         `ReserveFloor` when the payout would take the USDT reserve below `reserveFloor()`. Limited by the 5
    ///         USDT minimum and the per-account and global daily caps (on the net payout).
    /// @param minUsdtOut Reverts `Slippage` when the net payout would be lower.
    /// @return usdtOut The USDT paid (gross minus the fee).
    function sellAtCurrentPrice(uint256 vexAmount, uint256 minUsdtOut) external returns (uint256 usdtOut);

    /// @notice Raises `account`'s current-price sell credit by `amount` VEX of newly paid platform VEX
    ///         (SELL_CREDITOR_ROLE: Rewards, Jump).
    function creditCurrentSell(address account, uint256 amount) external;

    // ------------------------------------------------------------------ views

    function roundCount() external view returns (uint256);

    /// @return The active round's id (0 = none).
    function currentRound() external view returns (uint256);

    function roundOf(uint256 round) external view returns (RoundView memory);

    /// @return Every round, ids 1..roundCount in order.
    function rounds() external view returns (RoundView[] memory);

    /// @return VEX still for sale in `round` (`funded - sold`).
    function remaining(uint256 round) external view returns (uint256);

    /// @return One entry per round (including the empty ones), lowest round first: the order `sell` consumes them.
    function lotsOf(address account) external view returns (LotView[] memory);

    /// @return The VEX the account can sell back: the sum of its lots (the wallet balance and the allowance are
    ///         checked when the VEX is pulled).
    function sellable(address account) external view returns (uint256);

    /// @return vexOut What `buy(payToken, payAmount, ...)` would deliver now.
    /// @return usdtValue The USDT value of the payment (BNB at the Chainlink price, rounded down).
    function quoteBuy(address payToken, uint256 payAmount) external view returns (uint256 vexOut, uint256 usdtValue);

    /// @return payAmount What `buyExact(payToken, vexAmount, ...)` would charge now (rounded up).
    /// @return usdtValue The USDT value of that payment.
    function quoteBuyExact(
        address payToken,
        uint256 vexAmount
    ) external view returns (uint256 payAmount, uint256 usdtValue);

    /// @return usdtOut What `account` would be paid for selling `vexAmount` now.
    function quoteSell(address account, uint256 vexAmount) external view returns (uint256 usdtOut);

    /// @return usdtGross floor(vexAmount * vexPrice / 1e18)
    /// @return fee ceil(usdtGross * feeBps / 10_000)
    /// @return usdtNet What `sellAtCurrentPrice(vexAmount, ...)` would pay now (before the minimum and the caps).
    function quoteSellAtCurrentPrice(
        uint256 vexAmount
    ) external view returns (uint256 usdtGross, uint256 fee, uint256 usdtNet);

    /// @return The fee of `sellAtCurrentPrice` in basis points.
    function currentSellFeeBps() external view returns (uint16);

    /// @return accountCapUsdt The per-account daily cap of `sellAtCurrentPrice` (USDT wei, 0 = off).
    /// @return globalCapUsdt The global daily cap.
    function currentSellCaps() external view returns (uint256 accountCapUsdt, uint256 globalCapUsdt);

    /// @return accountRoom What `account` may still be paid today by `sellAtCurrentPrice`.
    /// @return globalRoom What all accounts together may still be paid today.
    function currentSellRoom(address account) external view returns (uint256 accountRoom, uint256 globalRoom);

    /// @return entitled The VEX `account` may sell at the current price now: `lotVex + creditVex`.
    /// @return lotVex Its remaining purchase lots that are older than 24 hours (consumed first).
    /// @return creditVex Its credit from VEX the platform paid out (Rewards claims, Jump grants).
    function currentSellEntitlement(
        address account
    ) external view returns (uint256 entitled, uint256 lotVex, uint256 creditVex);

    /// @return matured What `account` may sell at the current price now (matured lots plus credit).
    /// @return maturing Its remaining lots that were bought less than 24 hours ago.
    /// @return nextMaturityAt The second the oldest of them matures (0 when none is maturing).
    function currentSellMaturity(
        address account
    ) external view returns (uint256 matured, uint256 maturing, uint256 nextMaturityAt);

    /// @notice When the account may sell again: 0 when it may sell now, else the next 00:00 UTC after its sale of
    ///         today. `sell` and `sellAtCurrentPrice` share this limit of one sale per account and UTC day.
    function nextSaleAt(address account) external view returns (uint256);

    /// @return accountCap The `sell` cap per account and UTC day, USDT wei.
    /// @return accountUsed What `account` was paid today.
    /// @return accountRoom What `account` may still be paid today.
    /// @return globalCap The `sell` cap for all accounts together.
    /// @return globalUsed What all accounts were paid today.
    /// @return globalRoom What all accounts together may still be paid today.
    function sellLimits(
        address account
    )
        external
        view
        returns (
            uint256 accountCap,
            uint256 accountUsed,
            uint256 accountRoom,
            uint256 globalCap,
            uint256 globalUsed,
            uint256 globalRoom
        );

    /// @return floor What `sellAtCurrentPrice` must leave in the USDT reserve: `fixedPart`.
    /// @return licenseOwed Always 0: nothing is owed in USDT any more.
    /// @return fixedPart The value DEFAULT_ADMIN sets.
    function reserveFloor() external view returns (uint256 floor, uint256 licenseOwed, uint256 fixedPart);

    /// @return VEX held by this contract above the round inventories (sold-back VEX, donations).
    function vexExcess() external view returns (uint256);

    /// @return VEX still for sale in all rounds together.
    function inventory() external view returns (uint256);
}
