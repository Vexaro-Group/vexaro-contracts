// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Managed} from "./abstracts/Managed.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {INetwork} from "./interfaces/INetwork.sol";
import {IRoundPriceSource} from "./interfaces/IRoundPriceSource.sol";
import {ITokenSale} from "./interfaces/ITokenSale.sol";
import {ITreasury} from "./interfaces/ITreasury.sol";
import {SalePayment} from "./libraries/SalePayment.sol";

/// @title TokenSale
/// @notice The VEX sale: the rounds, the prices and the sell-back lots live in this contract, no backend key signs
///         a quote. It holds the round inventories (VEX the OPERATOR funds in parts) and nothing else.
///
///         Rounds. Up to 8, ids 1..n in the order they were added. DEFAULT_ADMIN adds a round and sets
///         its price and allocation; OPERATOR funds the inventory (`funded <= allocation`) and switches the active
///         round by hand. A price is frozen once the round has sold anything, because the lots of that round are
///         bought back at it. `currentRoundPrice()` is what PriceFeed reads in ROUND mode.
///
///         Buy. USDT, or BNB (`payToken == address(0)`, sent as `msg.value`) at the Chainlink price of PriceFeed (a
///         stale answer reverts). `buy` spends a payment and delivers `floor(usdt * 1e18 / price)`, `buyExact` delivers
///         exactly the VEX asked for and charges `ceil(vex * price / 1e18)` (BNB: that USDT converted at the
///         BNB price, rounded up again). The payment moves once, buyer -> Treasury, and is then reported with
///         `notifyPayment` (transfer-then-notify; this contract needs PAYER_ROLE on the Treasury). The first purchase
///         registers the sponsor in Network (this contract needs REGISTRAR_ROLE there), later ones ignore the argument;
///         a frozen account is refused. Every purchase adds its VEX to `lots[account][round]`.
///
///         Sell-back. Only VEX bought here, FIFO from the lowest round that still has a lot, each part at the price
///         of its round, `usdt = sum(floor(take * price / 1e18))`. The seller's VEX goes to the sell sink (this
///         contract by default, where it is unallocated excess), the USDT comes from the Treasury reserve
///         (RESERVE_SPENDER_ROLE); BNB takings are never used for it. Refused while Network says the account is sell
///         blocked or not active. There is no fee and no holding period, but the USDT paid out is limited per UTC
///         day: `sellAccountCapUsdt` per account and `sellGlobalCapUsdt` in total (2 000 / 20 000 USDT at the start;
///         OPERATOR sets any value, GUARDIAN may only lower one, 0 turns the sell-back off). A payout above the room
///         left reverts `SellLimitExceeded(global, requested, room)`; a lot paid in BNB is bought back in USDT and
///         counts the same.
///
///         Sell at the current price. `sellAtCurrentPrice` takes any FREE VEX (income, bonuses, matured principal,
///         bought VEX; the token refuses airdrop-locked VEX because this contract is platform-restricted there) at the
///         `PriceFeed.vexPrice()` of the moment (it reverts while the price is unavailable):
///         `gross = floor(vex * price / 1e18)`, `fee = ceil(gross * feeBps / 10_000)` (`feeBps` 0 by default, at most
///         `MAX_CURRENT_SELL_FEE_BPS`, set by DEFAULT_ADMIN), `net = gross - fee`; the fee simply stays in the
///         Treasury reserve. Same checks as `sell` (active, not sell-blocked) and the same pause flag (ENTRIES, so
///         GUARDIAN can pause it). The USDT comes from the Treasury reserve (`payFromReserve`, which reverts when
///         the reserve is short), the VEX goes to the sell sink. Limits: a minimum `gross` of 5 USDT, and a per
///         account and a global daily cap on `net` (UTC day; a cap of 0 BLOCKS the path, it is not "no cap";
///         OPERATOR sets any value, GUARDIAN may only lower one). The sale also consumes the seller's FIFO lots
///         (lowest round first, `min(matured lots, vex)`), so the purchase-price `sell` can never be used for more VEX
///         than was bought and not yet sold.
///
///         Entitlement. The token cannot tell bought VEX from income, so the sale itself tracks
///         what an account may sell at the current price: its remaining purchase lots that are older than 24 hours
///         plus `currentSellCredit`, which the Rewards contract (SELL_CREDITOR_ROLE) raises by the NET VEX it pays out
///         in a claim (staking income, Network Cashback, BackFlow, airdrop- and Jump-stake income) and the Jump
///         contract by the principal of a grant stake as the stake pays it back. The sale consumes the matured lots
///         first, then the credit, and reverts `NotEntitled(account, requested, entitled)` above lots plus credit.
///         The credit is a quota of VEX, not a claim on particular tokens: it limits the amount an account may sell
///         at the current price, not the origin of the VEX it holds. Principal that comes back from Staking is not
///         credited (it is the user's own VEX). Residual risk: VEX from elsewhere can fill the quota, and such VEX
///         can still be staked, where Network Cashback is paid on it.
///
///         Maturity. A purchase counts towards the entitlement 24 hours after it, so a buy just before a round
///         switch cannot be sold at the new price right after it. The purchases of the last 24 hours are kept in four
///         tranches per account; a fifth purchase within the day joins the newest tranche, which then matures 24 hours
///         after that purchase. The young amount is capped by the lots that remain. A sale that would fit only with
///         younger lots reverts `LotsNotMatured(requested, matured, availableAt)`. Lots bought before this rule have
///         no tranche and count at once.
///
///         Reserve floor. `sellAtCurrentPrice` may not take the Treasury USDT reserve below `reserveFloorFixed`
///         (DEFAULT_ADMIN); `sell` may still use the whole reserve.
///
///         One sale per day. An account may make one sale per UTC day in total: a successful `sell` or
///         `sellAtCurrentPrice` closes both until 00:00 UTC (`SaleAlreadyMadeToday`, see `nextSaleAt`); the amount
///         limits above stay as they are. The check comes after the account checks (not active, sell-blocked), so
///         such an account sees its own reason.
///
///         Rounding never favours the user: a buyer gets the floor and pays the ceiling, a seller is paid the floor of
///         every part. VEX must be fee-exempt for this contract, which `_deliver` checks on every buy.
///
///         Pauses. ENTRIES stops `buy`, `buyExact`, `sell` and `sellAtCurrentPrice`; the OPERATOR / admin functions
///         stay open. The credit call of Rewards / Jump is not paused (a claim must never fail because of it).
///
///         Storage (ERC-7201 `vexaro.storage.TokenSale`): five wiring addresses, then `sellSink | roundCount |
///         activeRound` in one slot; Round = price | allocation (slot) + funded | sold (slot), all uint128 (the total
///         supply is 1e27, far below 2^128); lots per (account, round) are uint256. The current-price sale
///         settings and counters are appended at the end of the struct, then the credit per account, the fixed part
///         of the reserve floor, the `sell` caps and counters and the maturing purchases (four tranches of 32 + 96 bits
///         per account), then the day of the account's last sale plus one.
contract TokenSale is ITokenSale, Managed {
    using SafeERC20 for IERC20;

    /// @notice Most rounds the sale can hold (bounds the FIFO loop).
    uint256 public constant MAX_ROUNDS = 8;
    /// @notice Held by the Rewards and Jump contracts: raises an account's `currentSellCredit`.
    bytes32 public constant SELL_CREDITOR_ROLE = keccak256("SELL_CREDITOR_ROLE");
    /// @notice Smallest `gross` USDT value of a `sellAtCurrentPrice` sale.
    uint256 public constant MIN_CURRENT_SELL_USDT = 5e18;
    /// @notice Highest `currentSellFeeBps` (10 %).
    uint16 public constant MAX_CURRENT_SELL_FEE_BPS = 1_000;
    /// @notice How long a purchase waits before it counts towards `sellAtCurrentPrice`.
    uint256 public constant CURRENT_SELL_MATURITY = 24 hours;
    /// @notice Daily caps of `sell` a new deployment starts with, USDT wei (2 000 per account, 20 000 in total).
    uint256 public constant DEFAULT_SELL_ACCOUNT_CAP = 2_000e18;
    uint256 public constant DEFAULT_SELL_GLOBAL_CAP = 20_000e18;
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    /// @dev Purchases of the last 24 hours are kept in this many tranches; a fuller day merges into the newest.
    uint256 private constant MATURING_TRANCHES = 4;

    struct Round {
        uint128 price;
        uint128 allocation;
        uint128 funded;
        uint128 sold;
    }

    /// @dev One UTC day of sales: `used` counts `day` only.
    struct DayUsed {
        uint64 day;
        uint96 used;
    }

    /// @dev Purchased VEX that has not matured for the current-price sale yet: bought at `at`, counts from
    ///      `at + CURRENT_SELL_MATURITY`.
    struct Tranche {
        uint32 at;
        uint96 amount;
    }

    /// @custom:storage-location erc7201:vexaro.storage.TokenSale
    struct TokenSaleStorage {
        address vex;
        address usdt;
        address treasury;
        address network;
        address priceFeed;
        address sellSink;
        uint8 roundCount;
        uint8 activeRound;
        mapping(uint256 round => Round) rounds;
        mapping(address account => mapping(uint256 round => uint256 amount)) lots;
        uint16 currentSellFeeBps;
        uint96 accountCapUsdt;
        uint96 globalCapUsdt;
        DayUsed globalUsed;
        mapping(address account => DayUsed) accountUsed;
        // appended after the initial layout; do not reorder
        mapping(address account => uint256 vexAmount) currentSellCredit;
        uint256 reserveFloorFixed;
        uint96 sellAccountCapUsdt;
        uint96 sellGlobalCapUsdt;
        DayUsed sellGlobalUsed;
        mapping(address account => DayUsed) sellAccountUsed;
        mapping(address account => Tranche[MATURING_TRANCHES]) maturing;
        mapping(address account => uint256) lastSaleDayPlusOne;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.TokenSale")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant TOKEN_SALE_STORAGE_LOCATION =
        0xafa52ed948a3e464d24378da372dbfe7be9351eb92d90d8da8e5f8feb85be100;

    event RoundAdded(uint256 indexed round, uint256 price, uint256 allocation);
    event RoundPriceSet(uint256 indexed round, uint256 oldPrice, uint256 newPrice);
    event RoundAllocationSet(uint256 indexed round, uint256 oldAllocation, uint256 newAllocation);
    event ActiveRoundChanged(uint256 indexed oldRound, uint256 indexed newRound);
    event RoundFunded(uint256 indexed round, address indexed funder, uint256 amount, uint256 funded);
    event ExcessAllocated(uint256 indexed round, uint256 amount, uint256 funded);
    /// @param usdtValue What the payment is worth in USDT (BNB at the Chainlink price, rounded down).
    event Bought(
        address indexed account,
        uint256 indexed round,
        address payToken,
        uint256 payAmount,
        uint256 usdtValue,
        uint256 vexAmount
    );
    event Sold(address indexed account, uint256 vexAmount, uint256 usdtAmount);
    /// @notice One FIFO part of a `Sold`: what was taken from the lot of `round` and what that part paid.
    event LotSold(address indexed account, uint256 indexed round, uint256 vexAmount, uint256 usdtAmount);
    /// @param price The `PriceFeed.vexPrice()` used.
    /// @param usdtNet What the account was paid (`usdtGross - fee`).
    /// @param lotsConsumed The part of `vexAmount` taken off the seller's FIFO lots.
    event SoldAtCurrentPrice(
        address indexed account,
        uint256 vexAmount,
        uint256 price,
        uint256 usdtGross,
        uint256 fee,
        uint256 usdtNet,
        uint256 lotsConsumed
    );
    /// @notice One FIFO part of the lots a `SoldAtCurrentPrice` consumed (no payout of its own).
    event LotConsumed(address indexed account, uint256 indexed round, uint256 vexAmount);
    /// @notice `amount` VEX of platform-paid VEX became sellable at the current price; `credit` is the new total.
    event CurrentSellCredited(address indexed account, uint256 amount, uint256 credit);
    /// @notice A `SoldAtCurrentPrice` spent `amount` VEX of the credit (after the lots); `credit` is what is left.
    event CurrentSellCreditUsed(address indexed account, uint256 amount, uint256 credit);
    event ReserveFloorFixedSet(uint256 oldFloor, uint256 newFloor);
    event CurrentSellFeeChanged(uint16 oldFeeBps, uint16 newFeeBps);
    event CurrentSellCapSet(bool indexed global, uint256 oldCapUsdt, uint256 newCapUsdt, address indexed by);
    /// @notice A daily cap of the round-price `sell` changed (`global` tells which one).
    event SellCapSet(bool indexed global, uint256 oldCapUsdt, uint256 newCapUsdt, address indexed by);
    event SellSinkChanged(address indexed oldSink, address indexed newSink);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event NetworkChanged(address indexed oldNetwork, address indexed newNetwork);
    event PriceFeedChanged(address indexed oldPriceFeed, address indexed newPriceFeed);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error ZeroAmount();
    /// @dev A zero price.
    error InvalidPrice();
    error NotAContract(address account);
    error TooManyRounds();
    /// @dev The id is 0 or above the number of rounds.
    error UnknownRound(uint256 round);
    /// @dev The round has sold VEX, so its price is part of the lots and cannot change.
    error RoundHasSales(uint256 round);
    /// @dev Funding would put more VEX into the round than its allocation allows.
    error ExceedsAllocation(uint256 round, uint256 funded, uint256 allocation);
    /// @dev An allocation cannot go below what is already funded (it is in the inventory for good).
    error AllocationBelowFunded(uint256 round, uint256 allocation, uint256 funded);
    error NoActiveRound();
    error InventoryShort(uint256 round, uint256 available, uint256 requested);
    /// @dev `actual` is outside the limit the caller gave: a bought amount below `minVexOut` / a payout below
    ///      `minUsdtOut` (actual < limit), or a price above `maxPay` (actual > limit).
    error Slippage(uint256 actual, uint256 limit);
    /// @dev The account is not registered or is frozen.
    error NotActive(address account);
    error SellBlocked(address account);
    /// @dev The account holds fewer sell-back lots than it tries to sell.
    error ExceedsSellable(uint256 sellable, uint256 requested);
    /// @dev `gross` of a `sellAtCurrentPrice` sale is below the 5 USDT minimum.
    error BelowMinimum(uint256 gross, uint256 minimum);
    /// @dev The sale's `net` is above what is left of the daily cap (`global` tells which one).
    error CurrentSellCapExceeded(bool global, uint256 requested, uint256 room);
    error FeeTooHigh(uint16 feeBps, uint16 maxFeeBps);
    error InvalidValue();
    /// @dev GUARDIAN may only lower a cap.
    error CapNotLowered(uint256 current, uint256 requested);
    error FeeNotExempt(uint256 expected, uint256 received);
    error ExceedsExcess(uint256 amount, uint256 excess);
    /// @dev The payout of a round-price `sell` is above what is left of the day's cap (`global` tells which one).
    error SellLimitExceeded(bool global, uint256 requested, uint256 room);
    /// @dev `requested` VEX is more than the account may ever sell at the current price (all lots + credit).
    error NotEntitled(address account, uint256 requested, uint256 entitled);
    /// @dev The account is entitled to `requested` VEX, but part of it comes from purchases younger than 24 hours;
    ///      `matured` is usable now and the sale becomes possible at `availableAt`.
    error LotsNotMatured(uint256 requested, uint256 matured, uint40 availableAt);
    /// @dev The payout would take the USDT reserve below `floor` (`reserve` is what it holds now).
    error ReserveFloor(uint256 reserve, uint256 payout, uint256 floor);
    /// @dev The balance is below the inventories (this contract is not fee-exempt, or VEX left it another way).
    error InventoryExceedsBalance(uint256 inventory, uint256 balance);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address vex_,
        address usdt_,
        address treasury_,
        address network_,
        address priceFeed_
    ) external initializer {
        __Managed_init(admin);
        _requireContract(vex_);
        _requireContract(usdt_);
        TokenSaleStorage storage $ = _tokenSaleStorage();
        $.vex = vex_;
        $.usdt = usdt_;
        _setTreasury($, treasury_);
        _setNetwork($, network_);
        _setPriceFeed($, priceFeed_);
        $.sellSink = address(this);
        emit SellSinkChanged(address(0), address(this));
        _setSellCaps($, DEFAULT_SELL_ACCOUNT_CAP, DEFAULT_SELL_GLOBAL_CAP);
    }

    /// @notice Upgrade step (DEFAULT_ADMIN, called by `upgradeToAndCall`): sets the daily caps of the round-price
    ///         `sell`, USDT wei per account and in total.
    function initializeV3(
        uint256 accountCapUsdt,
        uint256 globalCapUsdt
    ) external reinitializer(3) onlyRole(DEFAULT_ADMIN_ROLE) {
        if (accountCapUsdt > type(uint96).max || globalCapUsdt > type(uint96).max) revert InvalidValue();
        _setSellCaps(_tokenSaleStorage(), accountCapUsdt, globalCapUsdt);
    }

    // ------------------------------------------------------------------ rounds

    /// @inheritdoc ITokenSale
    function addRound(uint256 price, uint256 allocation) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 round) {
        if (price == 0) revert InvalidPrice();
        if (allocation == 0) revert ZeroAmount();
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint8 count = $.roundCount;
        if (count >= MAX_ROUNDS) revert TooManyRounds();
        count += 1;
        $.roundCount = count;
        round = count;
        $.rounds[round] = Round({
            price: SafeCast.toUint128(price),
            allocation: SafeCast.toUint128(allocation),
            funded: 0,
            sold: 0
        });
        emit RoundAdded(round, price, allocation);
    }

    /// @inheritdoc ITokenSale
    function setRoundPrice(uint256 round, uint256 price) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (price == 0) revert InvalidPrice();
        Round storage r = _round(_tokenSaleStorage(), round);
        if (r.sold != 0) revert RoundHasSales(round);
        emit RoundPriceSet(round, r.price, price);
        r.price = SafeCast.toUint128(price);
    }

    /// @inheritdoc ITokenSale
    function setRoundAllocation(uint256 round, uint256 allocation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Round storage r = _round(_tokenSaleStorage(), round);
        if (allocation < r.funded) revert AllocationBelowFunded(round, allocation, r.funded);
        if (allocation == 0) revert ZeroAmount();
        emit RoundAllocationSet(round, r.allocation, allocation);
        r.allocation = SafeCast.toUint128(allocation);
    }

    /// @inheritdoc ITokenSale
    function setActiveRound(uint256 round) external onlyRole(OPERATOR_ROLE) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        if (round > $.roundCount) revert UnknownRound(round);
        // `round` is at most 8 here, so the cast to uint8 is exact.
        if (round == $.activeRound) revert NoChange(uint8(round));
        emit ActiveRoundChanged($.activeRound, round);
        $.activeRound = uint8(round);
    }

    /// @inheritdoc ITokenSale
    function fundRound(uint256 round, uint256 amount) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        TokenSaleStorage storage $ = _tokenSaleStorage();
        Round storage r = _round($, round);
        IERC20 token = IERC20($.vex);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        emit RoundFunded(round, msg.sender, received, _addFunding(r, round, received));
    }

    /// @notice Moves VEX held above the inventories (sold-back VEX, donations) into `round`'s inventory (OPERATOR).
    ///         Guarded like every VEX-moving call: while a buy delivers, the VEX in flight is momentarily "excess".
    function allocateExcess(uint256 round, uint256 amount) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        TokenSaleStorage storage $ = _tokenSaleStorage();
        Round storage r = _round($, round);
        uint256 excess = _vexExcess($);
        if (amount > excess) revert ExceedsExcess(amount, excess);
        emit ExcessAllocated(round, amount, _addFunding(r, round, amount));
    }

    // ------------------------------------------------------------------ buy

    // The inventory and the lot are written before any payment moves (the guard is transient, so a re-entrant call
    // reverts), the later storage access Slither sees is only the namespace pointer.
    // slither-disable-start reentrancy-eth
    /// @inheritdoc ITokenSale
    function buy(
        address payToken,
        uint256 payAmount,
        uint256 minVexOut,
        address sponsor
    ) external payable whenNotPaused(ENTRIES) nonReentrant returns (uint256 vexOut) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 round = _openRound($);
        _join($, sponsor);
        if (payAmount == 0) revert ZeroAmount();
        uint256 usdtValue = _usdtValue($, payToken, payAmount);
        Round storage r = $.rounds[round];
        vexOut = Math.mulDiv(usdtValue, WAD, r.price);
        if (vexOut == 0) revert ZeroAmount();
        if (vexOut < minVexOut) revert Slippage(vexOut, minVexOut);

        _fill($, r, round, vexOut);
        SalePayment.collect($.treasury, payToken, payAmount, payAmount);
        _deliver($, vexOut);
        emit Bought(msg.sender, round, payToken, payAmount, usdtValue, vexOut);
    }

    /// @inheritdoc ITokenSale
    function buyExact(
        address payToken,
        uint256 vexAmount,
        uint256 maxPay,
        address sponsor
    ) external payable whenNotPaused(ENTRIES) nonReentrant returns (uint256 payAmount) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 round = _openRound($);
        _join($, sponsor);
        if (vexAmount == 0) revert ZeroAmount();
        Round storage r = $.rounds[round];
        uint256 usdtValue;
        (payAmount, usdtValue) = _payFor($, payToken, Math.mulDiv(vexAmount, r.price, WAD, Math.Rounding.Ceil));
        if (payAmount > maxPay) revert Slippage(payAmount, maxPay);

        _fill($, r, round, vexAmount);
        SalePayment.collect($.treasury, payToken, payAmount, maxPay);
        _deliver($, vexAmount);
        emit Bought(msg.sender, round, payToken, payAmount, usdtValue, vexAmount);
    }
    // slither-disable-end reentrancy-eth

    // ------------------------------------------------------------------ sell

    /// @inheritdoc ITokenSale
    function sell(
        uint256 vexAmount,
        uint256 minUsdtOut
    ) external whenNotPaused(ENTRIES) nonReentrant returns (uint256 usdtOut) {
        if (vexAmount == 0) revert ZeroAmount();
        TokenSaleStorage storage $ = _tokenSaleStorage();
        INetwork net = INetwork($.network);
        if (!net.isActive(msg.sender)) revert NotActive(msg.sender);
        if (net.isSellBlocked(msg.sender)) revert SellBlocked(msg.sender);
        _requireNoSaleToday($, msg.sender);

        usdtOut = _plan($, msg.sender, vexAmount);
        if (usdtOut == 0) revert ZeroAmount();
        if (usdtOut < minUsdtOut) revert Slippage(usdtOut, minUsdtOut);
        _consume($, msg.sender, vexAmount);
        (uint8 failed, uint256 room) = _countDay(
            $.sellAccountUsed[msg.sender],
            $.sellGlobalUsed,
            $.sellAccountCapUsdt,
            $.sellGlobalCapUsdt,
            usdtOut
        );
        if (failed != 0) revert SellLimitExceeded(failed == 2, usdtOut, room);

        _markSaleToday($, msg.sender);
        _takeVex($, vexAmount);
        ITreasury($.treasury).payFromReserve($.usdt, msg.sender, usdtOut);
        emit Sold(msg.sender, vexAmount, usdtOut);
    }

    /// @inheritdoc ITokenSale
    function sellAtCurrentPrice(
        uint256 vexAmount,
        uint256 minUsdtOut
    ) external whenNotPaused(ENTRIES) nonReentrant returns (uint256 usdtOut) {
        if (vexAmount == 0) revert ZeroAmount();
        TokenSaleStorage storage $ = _tokenSaleStorage();
        INetwork net = INetwork($.network);
        if (!net.isActive(msg.sender)) revert NotActive(msg.sender);
        if (net.isSellBlocked(msg.sender)) revert SellBlocked(msg.sender);
        _requireNoSaleToday($, msg.sender);
        (uint256 entitled, uint256 maturedLots, ) = _entitlement($, msg.sender);
        if (vexAmount > entitled) _revertNotEntitled($, msg.sender, vexAmount, entitled);

        uint256 price = IPriceFeed($.priceFeed).vexPrice();
        (uint256 gross, uint256 fee) = _currentSellQuote($, vexAmount, price);
        usdtOut = gross - fee;
        if (gross < MIN_CURRENT_SELL_USDT) revert BelowMinimum(gross, MIN_CURRENT_SELL_USDT);
        if (usdtOut < minUsdtOut) revert Slippage(usdtOut, minUsdtOut);
        _requireAboveFloor($, usdtOut);
        _countCurrentSell($, msg.sender, usdtOut);
        uint256 consumed = _consumeUpTo($, msg.sender, Math.min(vexAmount, maturedLots));
        if (consumed < vexAmount) _useCredit($, msg.sender, vexAmount - consumed);

        _markSaleToday($, msg.sender);
        _takeVex($, vexAmount);
        ITreasury($.treasury).payFromReserve($.usdt, msg.sender, usdtOut);
        emit SoldAtCurrentPrice(msg.sender, vexAmount, price, gross, fee, usdtOut, consumed);
    }

    /// @notice Raises `account`'s current-price sell credit by `amount` VEX (SELL_CREDITOR_ROLE: Rewards after a VEX
    ///         claim, Jump as a grant stake pays its principal back). Not paused and never reverts for a zero amount,
    ///         so it cannot stop a claim.
    function creditCurrentSell(address account, uint256 amount) external onlyRole(SELL_CREDITOR_ROLE) {
        if (amount == 0) return;
        uint256 credit = _tokenSaleStorage().currentSellCredit[account] + amount;
        _tokenSaleStorage().currentSellCredit[account] = credit;
        emit CurrentSellCredited(account, amount, credit);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sets the reserve floor of `sellAtCurrentPrice`, USDT wei (DEFAULT_ADMIN).
    function setReserveFloorFixed(uint256 newFloor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        emit ReserveFloorFixedSet($.reserveFloorFixed, newFloor);
        $.reserveFloorFixed = newFloor;
    }

    /// @notice Sets the fee of `sellAtCurrentPrice` in basis points, at most `MAX_CURRENT_SELL_FEE_BPS`
    ///         (DEFAULT_ADMIN).
    function setCurrentSellFee(uint16 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > MAX_CURRENT_SELL_FEE_BPS) revert FeeTooHigh(feeBps, MAX_CURRENT_SELL_FEE_BPS);
        TokenSaleStorage storage $ = _tokenSaleStorage();
        emit CurrentSellFeeChanged($.currentSellFeeBps, feeBps);
        $.currentSellFeeBps = feeBps;
    }

    /// @notice Sets the per-account daily cap of `sellAtCurrentPrice` in USDT wei (0 turns the path off).
    ///         OPERATOR sets any value; GUARDIAN may only lower it.
    function setCurrentSellAccountCap(uint256 capUsdt) external {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 current = $.accountCapUsdt;
        _checkCapAuthority(current, capUsdt);
        // `capUsdt` is at most uint96 max, checked above.
        $.accountCapUsdt = uint96(capUsdt);
        emit CurrentSellCapSet(false, current, capUsdt, msg.sender);
    }

    /// @notice Sets the global daily cap of `sellAtCurrentPrice` in USDT wei (0 turns the path off). Same rules.
    function setCurrentSellGlobalCap(uint256 capUsdt) external {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 current = $.globalCapUsdt;
        _checkCapAuthority(current, capUsdt);
        // `capUsdt` is at most uint96 max, checked above.
        $.globalCapUsdt = uint96(capUsdt);
        emit CurrentSellCapSet(true, current, capUsdt, msg.sender);
    }

    /// @notice Sets the per-account daily cap of the round-price `sell` in USDT wei (0 turns the path off). OPERATOR
    ///         sets any value; GUARDIAN may only lower it.
    function setSellAccountCap(uint256 capUsdt) external {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 current = $.sellAccountCapUsdt;
        _checkCapAuthority(current, capUsdt);
        // `capUsdt` is at most uint96 max, checked above.
        $.sellAccountCapUsdt = uint96(capUsdt);
        emit SellCapSet(false, current, capUsdt, msg.sender);
    }

    /// @notice Sets the global daily cap of the round-price `sell` in USDT wei (0 turns the path off). Same rules.
    function setSellGlobalCap(uint256 capUsdt) external {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 current = $.sellGlobalCapUsdt;
        _checkCapAuthority(current, capUsdt);
        // `capUsdt` is at most uint96 max, checked above.
        $.sellGlobalCapUsdt = uint96(capUsdt);
        emit SellCapSet(true, current, capUsdt, msg.sender);
    }

    /// @notice Where sold-back VEX goes; this contract by default (DEFAULT_ADMIN).
    function setSellSink(address newSink) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSink == address(0)) revert ZeroAddress();
        TokenSaleStorage storage $ = _tokenSaleStorage();
        emit SellSinkChanged($.sellSink, newSink);
        $.sellSink = newSink;
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(_tokenSaleStorage(), newTreasury);
    }

    function setNetwork(address newNetwork) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setNetwork(_tokenSaleStorage(), newNetwork);
    }

    function setPriceFeed(address newPriceFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPriceFeed(_tokenSaleStorage(), newPriceFeed);
    }

    /// @notice Sends out tokens that are not round inventory: any token but VEX, or VEX above the inventories, and
    ///         BNB (`token == address(0)`; the sale keeps none, a payment goes straight to the Treasury)
    ///         (DEFAULT_ADMIN).
    function sweep(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        TokenSaleStorage storage $ = _tokenSaleStorage();
        if (token == $.vex) {
            uint256 excess = _vexExcess($);
            if (amount > excess) revert ExceedsExcess(amount, excess);
        }
        if (token == address(0)) Address.sendValue(payable(to), amount);
        else IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    // ------------------------------------------------------------------ views

    function vex() external view returns (address) {
        return _tokenSaleStorage().vex;
    }

    function usdt() external view returns (address) {
        return _tokenSaleStorage().usdt;
    }

    function treasury() external view returns (address) {
        return _tokenSaleStorage().treasury;
    }

    function network() external view returns (address) {
        return _tokenSaleStorage().network;
    }

    function priceFeed() external view returns (address) {
        return _tokenSaleStorage().priceFeed;
    }

    function sellSink() external view returns (address) {
        return _tokenSaleStorage().sellSink;
    }

    /// @inheritdoc ITokenSale
    function roundCount() external view returns (uint256) {
        return _tokenSaleStorage().roundCount;
    }

    /// @inheritdoc ITokenSale
    function currentRound() external view returns (uint256) {
        return _tokenSaleStorage().activeRound;
    }

    /// @inheritdoc IRoundPriceSource
    function currentRoundPrice() external view returns (uint256 price, bool active) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 round = $.activeRound;
        if (round == 0) return (0, false);
        return ($.rounds[round].price, true);
    }

    /// @inheritdoc ITokenSale
    function roundOf(uint256 round) external view returns (RoundView memory) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        _round($, round);
        return _roundView($, round);
    }

    /// @inheritdoc ITokenSale
    function rounds() external view returns (RoundView[] memory list) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        list = new RoundView[]($.roundCount);
        for (uint256 i = 0; i < list.length; ++i) list[i] = _roundView($, i + 1);
    }

    /// @inheritdoc ITokenSale
    function remaining(uint256 round) external view returns (uint256) {
        Round storage r = _round(_tokenSaleStorage(), round);
        return r.funded - r.sold;
    }

    /// @inheritdoc ITokenSale
    function lotsOf(address account) external view returns (LotView[] memory list) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        list = new LotView[]($.roundCount);
        for (uint256 i = 0; i < list.length; ++i) {
            uint256 amount = $.lots[account][i + 1];
            uint256 price = $.rounds[i + 1].price;
            list[i] = LotView({
                round: i + 1,
                vexAmount: amount,
                price: price,
                usdtValue: Math.mulDiv(amount, price, WAD)
            });
        }
    }

    /// @inheritdoc ITokenSale
    function nextSaleAt(address account) external view returns (uint256) {
        return _nextSaleAt(_tokenSaleStorage(), account);
    }

    /// @inheritdoc ITokenSale
    function sellable(address account) external view returns (uint256 total) {
        return _lotTotal(_tokenSaleStorage(), account);
    }

    /// @inheritdoc ITokenSale
    function quoteBuy(address payToken, uint256 payAmount) external view returns (uint256 vexOut, uint256 usdtValue) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 round = _openRound($);
        usdtValue = _usdtValue($, payToken, payAmount);
        vexOut = Math.mulDiv(usdtValue, WAD, $.rounds[round].price);
    }

    /// @inheritdoc ITokenSale
    function quoteBuyExact(
        address payToken,
        uint256 vexAmount
    ) external view returns (uint256 payAmount, uint256 usdtValue) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        uint256 round = _openRound($);
        return _payFor($, payToken, Math.mulDiv(vexAmount, $.rounds[round].price, WAD, Math.Rounding.Ceil));
    }

    /// @inheritdoc ITokenSale
    function quoteSell(address account, uint256 vexAmount) external view returns (uint256 usdtOut) {
        return _plan(_tokenSaleStorage(), account, vexAmount);
    }

    /// @inheritdoc ITokenSale
    function quoteSellAtCurrentPrice(
        uint256 vexAmount
    ) external view returns (uint256 usdtGross, uint256 fee, uint256 usdtNet) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        (usdtGross, fee) = _currentSellQuote($, vexAmount, IPriceFeed($.priceFeed).vexPrice());
        usdtNet = usdtGross - fee;
    }

    /// @inheritdoc ITokenSale
    function currentSellFeeBps() external view returns (uint16) {
        return _tokenSaleStorage().currentSellFeeBps;
    }

    /// @inheritdoc ITokenSale
    function currentSellCaps() external view returns (uint256 accountCapUsdt, uint256 globalCapUsdt) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        return ($.accountCapUsdt, $.globalCapUsdt);
    }

    /// @inheritdoc ITokenSale
    function currentSellRoom(address account) external view returns (uint256 accountRoom, uint256 globalRoom) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        accountRoom = _room($.accountCapUsdt, $.accountUsed[account]);
        globalRoom = _room($.globalCapUsdt, $.globalUsed);
    }

    /// @inheritdoc ITokenSale
    function currentSellEntitlement(
        address account
    ) external view returns (uint256 entitled, uint256 lotVex, uint256 creditVex) {
        return _entitlement(_tokenSaleStorage(), account);
    }

    /// @inheritdoc ITokenSale
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
        )
    {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        accountCap = $.sellAccountCapUsdt;
        accountUsed = _used($.sellAccountUsed[account]);
        accountRoom = _room(accountCap, $.sellAccountUsed[account]);
        globalCap = $.sellGlobalCapUsdt;
        globalUsed = _used($.sellGlobalUsed);
        globalRoom = _room(globalCap, $.sellGlobalUsed);
    }

    /// @inheritdoc ITokenSale
    function currentSellMaturity(
        address account
    ) external view returns (uint256 matured, uint256 maturing, uint256 nextMaturityAt) {
        TokenSaleStorage storage $ = _tokenSaleStorage();
        (matured, , ) = _entitlement($, account);
        (maturing, nextMaturityAt) = _maturing($, account);
        maturing = Math.min(maturing, _lotTotal($, account));
    }

    /// @inheritdoc ITokenSale
    function reserveFloor() external view returns (uint256 floor, uint256 licenseOwed, uint256 fixedPart) {
        fixedPart = _tokenSaleStorage().reserveFloorFixed;
        return (fixedPart, 0, fixedPart);
    }

    /// @inheritdoc ITokenSale
    function vexExcess() external view returns (uint256) {
        return _vexExcess(_tokenSaleStorage());
    }

    /// @inheritdoc ITokenSale
    function inventory() external view returns (uint256) {
        return _inventory(_tokenSaleStorage());
    }

    // ------------------------------------------------------------------ internals

    /// @dev The active round's id; reverts when sales are closed.
    function _openRound(TokenSaleStorage storage $) private view returns (uint256 round) {
        round = $.activeRound;
        if (round == 0) revert NoActiveRound();
    }

    /// @dev Registers the sponsor on the first purchase and refuses accounts that are not active (frozen).
    function _join(TokenSaleStorage storage $, address sponsor) private {
        INetwork net = INetwork($.network);
        // `register` says whether the account joined just now, which `isActive` makes irrelevant here.
        // slither-disable-next-line unused-return
        net.register(msg.sender, sponsor);
        if (!net.isActive(msg.sender)) revert NotActive(msg.sender);
    }

    /// @dev Takes `vexAmount` from the round's inventory and books it as the caller's lot.
    function _fill(TokenSaleStorage storage $, Round storage r, uint256 round, uint256 vexAmount) private {
        uint256 sold = r.sold;
        uint256 available = r.funded - sold;
        if (vexAmount > available) revert InventoryShort(round, available, vexAmount);
        // sold + vexAmount <= funded, which is a uint128
        r.sold = uint128(sold + vexAmount);
        $.lots[msg.sender][round] += vexAmount;
        _addMaturing($, msg.sender, vexAmount);
    }

    /// @dev Books a purchase as maturing: the tranches that matured are dropped, the purchase becomes the newest one.
    ///      When four tranches are still running it joins the newest, which then matures 24 hours after this purchase.
    function _addMaturing(TokenSaleStorage storage $, address account, uint256 vexAmount) private {
        Tranche[MATURING_TRANCHES] storage list = $.maturing[account];
        Tranche[MATURING_TRANCHES] memory kept;
        uint256 n = 0;
        for (uint256 i = 0; i < MATURING_TRANCHES; ++i) {
            Tranche memory t = list[i];
            if (t.amount != 0 && t.at + CURRENT_SELL_MATURITY > block.timestamp) kept[n++] = t;
        }
        if (n == MATURING_TRANCHES) {
            --n;
            vexAmount += kept[n].amount;
        }
        kept[n] = Tranche({at: uint32(block.timestamp), amount: SafeCast.toUint96(vexAmount)});
        for (uint256 i = 0; i < MATURING_TRANCHES; ++i) list[i] = kept[i];
    }

    /// @dev Sends the VEX and checks the buyer got all of it (fails when this contract is not fee-exempt).
    function _deliver(TokenSaleStorage storage $, uint256 vexAmount) private {
        IERC20 token = IERC20($.vex);
        uint256 before = token.balanceOf(msg.sender);
        token.safeTransfer(msg.sender, vexAmount);
        uint256 received = token.balanceOf(msg.sender) - before;
        if (received != vexAmount) revert FeeNotExempt(vexAmount, received);
    }

    /// @dev The USDT a payment of `payAmount` is worth, rounded down (BNB at the Chainlink price).
    function _usdtValue(
        TokenSaleStorage storage $,
        address payToken,
        uint256 payAmount
    ) private view returns (uint256) {
        return SalePayment.usdtValue($.priceFeed, $.usdt, payToken, payAmount);
    }

    /// @dev What the buyer pays in `payToken` for `usdtNeeded` USDT (rounded up) and what that is worth in USDT.
    function _payFor(
        TokenSaleStorage storage $,
        address payToken,
        uint256 usdtNeeded
    ) private view returns (uint256 payAmount, uint256 usdtValue) {
        return SalePayment.payFor($.priceFeed, $.usdt, payToken, usdtNeeded);
    }

    /// @dev What FIFO over the account's lots (lowest round first) pays for `vexAmount`, each part at the price of its
    ///      round; reverts when the lots do not cover it.
    function _plan(
        TokenSaleStorage storage $,
        address account,
        uint256 vexAmount
    ) private view returns (uint256 usdtOut) {
        uint256 count = $.roundCount;
        uint256 left = vexAmount;
        for (uint256 round = 1; round <= count && left != 0; ++round) {
            uint256 take = Math.min($.lots[account][round], left);
            usdtOut += Math.mulDiv(take, $.rounds[round].price, WAD);
            left -= take;
        }
        if (left != 0) revert ExceedsSellable(vexAmount - left, vexAmount);
    }

    /// @dev Takes `vexAmount` off the account's lots in the order of `_plan` (which has checked they cover it).
    function _consume(TokenSaleStorage storage $, address account, uint256 vexAmount) private {
        uint256 count = $.roundCount;
        uint256 left = vexAmount;
        for (uint256 round = 1; round <= count && left != 0; ++round) {
            uint256 lot = $.lots[account][round];
            if (lot == 0) continue;
            uint256 take = Math.min(lot, left);
            $.lots[account][round] = lot - take;
            left -= take;
            emit LotSold(account, round, take, Math.mulDiv(take, $.rounds[round].price, WAD));
        }
    }

    /// @dev Pulls the seller's VEX into this contract first (a platform-restricted account, so locked VEX is
    ///      refused by the token whatever the sink is) and checks all of it arrived (it does not when this contract is
    ///      not fee-exempt), then forwards it to the sell sink.
    function _takeVex(TokenSaleStorage storage $, uint256 vexAmount) private {
        IERC20 token = IERC20($.vex);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), vexAmount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != vexAmount) revert FeeNotExempt(vexAmount, received);
        address sink = $.sellSink;
        if (sink != address(this)) token.safeTransfer(sink, vexAmount);
    }

    /// @dev The account's remaining purchase lots, all rounds.
    function _lotTotal(TokenSaleStorage storage $, address account) private view returns (uint256 total) {
        uint256 count = $.roundCount;
        for (uint256 round = 1; round <= count; ++round) total += $.lots[account][round];
    }

    /// @dev What the account may sell at the current price now: the remaining lots that are not part of a purchase
    ///      younger than 24 hours (`lotVex`) + the credit. Lots of purchases made before the maturity rule existed
    ///      have no tranche, so they count at once.
    function _entitlement(
        TokenSaleStorage storage $,
        address account
    ) private view returns (uint256 entitled, uint256 lotVex, uint256 creditVex) {
        lotVex = _lotTotal($, account);
        (uint256 young, ) = _maturing($, account);
        lotVex -= Math.min(young, lotVex);
        creditVex = $.currentSellCredit[account];
        entitled = lotVex + creditVex;
    }

    /// @dev The VEX of purchases younger than 24 hours and when the oldest of them matures (0 when none).
    function _maturing(
        TokenSaleStorage storage $,
        address account
    ) private view returns (uint256 young, uint256 nextAt) {
        Tranche[MATURING_TRANCHES] storage list = $.maturing[account];
        for (uint256 i = 0; i < MATURING_TRANCHES; ++i) {
            Tranche memory t = list[i];
            uint256 at = t.at + CURRENT_SELL_MATURITY;
            if (t.amount == 0 || at <= block.timestamp) continue;
            young += t.amount;
            if (nextAt == 0) nextAt = at;
        }
    }

    /// @dev Reverts for a `sellAtCurrentPrice` of `vexAmount` above `entitled`: `NotEntitled` when even all lots
    ///      would not cover it, `LotsNotMatured` with the moment enough of them matures when they would.
    function _revertNotEntitled(
        TokenSaleStorage storage $,
        address account,
        uint256 vexAmount,
        uint256 entitled
    ) private view {
        uint256 lots = _lotTotal($, account);
        uint256 credit = $.currentSellCredit[account];
        if (vexAmount > lots + credit) revert NotEntitled(account, vexAmount, lots + credit);
        // The young part may be at most `room` for the sale to fit: the tranches drop out oldest first.
        uint256 room = lots + credit - vexAmount;
        (uint256 young, ) = _maturing($, account);
        Tranche[MATURING_TRANCHES] storage list = $.maturing[account];
        uint256 availableAt;
        for (uint256 i = 0; i < MATURING_TRANCHES && young > room; ++i) {
            Tranche memory t = list[i];
            uint256 at = t.at + CURRENT_SELL_MATURITY;
            if (t.amount == 0 || at <= block.timestamp) continue;
            young -= t.amount;
            availableAt = at;
        }
        revert LotsNotMatured(vexAmount, entitled, uint40(availableAt));
    }

    /// @dev Spends `amount` of the credit (the lots were consumed first; `_entitlement` guarantees it covers this).
    function _useCredit(TokenSaleStorage storage $, address account, uint256 amount) private {
        uint256 left = $.currentSellCredit[account] - amount;
        $.currentSellCredit[account] = left;
        emit CurrentSellCreditUsed(account, amount, left);
    }

    /// @dev The USDT reserve must keep `reserveFloor` after paying `usdtOut`.
    function _requireAboveFloor(TokenSaleStorage storage $, uint256 usdtOut) private view {
        uint256 reserve = ITreasury($.treasury).reserveOf($.usdt);
        uint256 floor = $.reserveFloorFixed;
        // with no floor a short reserve is the Treasury's own error (InsufficientReserve)
        if (floor != 0 && reserve < usdtOut + floor) revert ReserveFloor(reserve, usdtOut, floor);
    }

    /// @dev `gross` (rounded down) and `fee` (rounded up) of a current-price sale of `vexAmount` at `price`.
    function _currentSellQuote(
        TokenSaleStorage storage $,
        uint256 vexAmount,
        uint256 price
    ) private view returns (uint256 gross, uint256 fee) {
        gross = Math.mulDiv(vexAmount, price, WAD);
        fee = Math.mulDiv(gross, $.currentSellFeeBps, BPS, Math.Rounding.Ceil);
    }

    /// @dev The next 00:00 UTC after an account's last sale when that sale was today, else 0.
    function _nextSaleAt(TokenSaleStorage storage $, address account) private view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        return $.lastSaleDayPlusOne[account] == today + 1 ? (today + 1) * 1 days : 0;
    }

    /// @dev One sale per account and UTC day, `sell` and `sellAtCurrentPrice` together.
    function _requireNoSaleToday(TokenSaleStorage storage $, address account) private view {
        uint256 next = _nextSaleAt($, account);
        if (next != 0) revert SaleAlreadyMadeToday(account, next);
    }

    function _markSaleToday(TokenSaleStorage storage $, address account) private {
        $.lastSaleDayPlusOne[account] = block.timestamp / 1 days + 1;
    }

    /// @dev What a daily counter has used today (the counter of an earlier day is stale).
    function _used(DayUsed storage day) private view returns (uint256) {
        // Day counter comparison, not a balance check.
        // slither-disable-next-line incorrect-equality
        return day.day == block.timestamp / 1 days ? day.used : 0;
    }

    /// @dev What is left of a daily cap (a cap of 0 leaves nothing).
    function _room(uint256 cap, DayUsed storage day) private view returns (uint256) {
        uint256 used = _used(day);
        return cap > used ? cap - used : 0;
    }

    /// @dev Counts `amount` against an account's and the global daily cap. Returns 0 when it fits (and is counted),
    ///      1 / 2 with the room left when the account's / the global cap is exceeded (nothing is counted then).
    function _countDay(
        DayUsed storage accountDay,
        DayUsed storage globalDay,
        uint256 accountCap,
        uint256 globalCap,
        uint256 amount
    ) private returns (uint8 failed, uint256 room) {
        room = _room(accountCap, accountDay);
        if (amount > room) return (1, room);
        room = _room(globalCap, globalDay);
        if (amount > room) return (2, room);
        uint64 today = uint64(block.timestamp / 1 days);
        // Both sums are within their caps (uint96), checked above.
        accountDay.used = uint96(_used(accountDay) + amount);
        accountDay.day = today;
        globalDay.used = uint96(_used(globalDay) + amount);
        globalDay.day = today;
    }

    /// @dev Counts `usdtNet` of a current-price sale against its daily caps.
    function _countCurrentSell(TokenSaleStorage storage $, address account, uint256 usdtNet) private {
        (uint8 failed, uint256 room) = _countDay(
            $.accountUsed[account],
            $.globalUsed,
            $.accountCapUsdt,
            $.globalCapUsdt,
            usdtNet
        );
        if (failed != 0) revert CurrentSellCapExceeded(failed == 2, usdtNet, room);
    }

    function _setSellCaps(TokenSaleStorage storage $, uint256 accountCap, uint256 globalCap) private {
        emit SellCapSet(false, $.sellAccountCapUsdt, accountCap, msg.sender);
        emit SellCapSet(true, $.sellGlobalCapUsdt, globalCap, msg.sender);
        // Both fit a uint96: the constants and `initializeV3` check it.
        $.sellAccountCapUsdt = uint96(accountCap);
        $.sellGlobalCapUsdt = uint96(globalCap);
    }

    /// @dev Takes up to `vexAmount` off the account's lots, lowest round first; returns what was taken.
    function _consumeUpTo(
        TokenSaleStorage storage $,
        address account,
        uint256 vexAmount
    ) private returns (uint256 consumed) {
        uint256 count = $.roundCount;
        uint256 left = vexAmount;
        for (uint256 round = 1; round <= count && left != 0; ++round) {
            uint256 lot = $.lots[account][round];
            if (lot == 0) continue;
            uint256 take = Math.min(lot, left);
            $.lots[account][round] = lot - take;
            left -= take;
            emit LotConsumed(account, round, take);
        }
        consumed = vexAmount - left;
    }

    /// @dev OPERATOR sets any cap; GUARDIAN only lowers one. A cap fits a uint96.
    function _checkCapAuthority(uint256 current, uint256 requested) private view {
        if (requested > type(uint96).max) revert InvalidValue();
        if (!hasRole(OPERATOR_ROLE, msg.sender)) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender)) _checkRole(OPERATOR_ROLE);
            if (requested >= current) revert CapNotLowered(current, requested);
        }
    }

    /// @dev Credits `amount` to the round's inventory; the funding may not exceed the allocation.
    function _addFunding(Round storage r, uint256 round, uint256 amount) private returns (uint256 funded) {
        funded = uint256(r.funded) + amount;
        if (funded > r.allocation) revert ExceedsAllocation(round, funded, r.allocation);
        r.funded = uint128(funded);
    }

    function _round(TokenSaleStorage storage $, uint256 round) private view returns (Round storage) {
        if (round == 0 || round > $.roundCount) revert UnknownRound(round);
        return $.rounds[round];
    }

    function _roundView(TokenSaleStorage storage $, uint256 round) private view returns (RoundView memory v) {
        Round storage r = $.rounds[round];
        v = RoundView({
            id: round,
            price: r.price,
            allocation: r.allocation,
            funded: r.funded,
            sold: r.sold,
            remaining: r.funded - r.sold
        });
    }

    function _inventory(TokenSaleStorage storage $) private view returns (uint256 total) {
        uint256 count = $.roundCount;
        for (uint256 round = 1; round <= count; ++round) total += $.rounds[round].funded - $.rounds[round].sold;
    }

    function _vexExcess(TokenSaleStorage storage $) private view returns (uint256) {
        uint256 balance = IERC20($.vex).balanceOf(address(this));
        uint256 held = _inventory($);
        if (balance < held) revert InventoryExceedsBalance(held, balance);
        return balance - held;
    }

    function _setTreasury(TokenSaleStorage storage $, address newTreasury) private {
        _requireContract(newTreasury);
        emit TreasuryChanged($.treasury, newTreasury);
        $.treasury = newTreasury;
    }

    function _setNetwork(TokenSaleStorage storage $, address newNetwork) private {
        _requireContract(newNetwork);
        emit NetworkChanged($.network, newNetwork);
        $.network = newNetwork;
    }

    function _setPriceFeed(TokenSaleStorage storage $, address newPriceFeed) private {
        _requireContract(newPriceFeed);
        emit PriceFeedChanged($.priceFeed, newPriceFeed);
        $.priceFeed = newPriceFeed;
    }

    function _requireContract(address account) private view {
        if (account == address(0)) revert ZeroAddress();
        if (account.code.length == 0) revert NotAContract(account);
    }

    function _tokenSaleStorage() private pure returns (TokenSaleStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := TOKEN_SALE_STORAGE_LOCATION
        }
    }
}
