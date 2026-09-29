// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {DayCount} from "./DayCount.sol";
import {Registry} from "./Registry.sol";
import {ServicedToken} from "./ServicedToken.sol";

/// @title AssetFlow servicer: one bond's terms, coupons, redemptions and maturity
/// @notice The Solana program's servicing, on an EVM chain. Every amount is
/// computed here from the terms. A coupon is owed on each holder's balance at
/// the record date, read from the token's own history, so no register is
/// committed by anyone; anyone may pay any holder once the payment is fully
/// funded, and the coupon of a holder no longer eligible is held back. An early
/// redemption locks units until the issuer settles (face plus accrued interest,
/// units burned in the same call) or rejects. After the last payment date anyone
/// may start maturity: no unit can be issued again, and once the principal is
/// fully funded anyone may redeem any eligible holding at face.
contract Servicer is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Period {
        uint64 accrualStart;
        uint64 accrualEnd;
        uint64 recordTs;
        uint64 paymentTs;
    }

    struct Payment {
        uint128 funded;
        uint128 paid;
        uint128 heldBack;
        uint32 payments;
    }

    struct Paid {
        uint128 amount;
        bool done;
        bool heldBack;
    }

    enum Status {
        None,
        Requested,
        Settled,
        Rejected,
        Cancelled
    }

    struct Request {
        address holder;
        uint64 units;
        Status status;
        uint64 requestedTs;
        uint64 closedTs;
        uint128 principal;
        uint128 interest;
    }

    struct Maturity {
        bool started;
        uint64 startedTs;
        uint64 units;
        uint128 required;
        uint128 funded;
        uint128 paid;
        uint64 unitsRedeemed;
    }

    uint256 public constant MAX_PERIODS = 8;

    ServicedToken public immutable token;
    Registry public immutable registry;
    address public immutable issuer;
    IERC20 public immutable currency;
    uint8 public immutable currencyDecimals;
    /// Face of one unit, in currency base units.
    uint128 public immutable facePerUnit;
    /// Annual coupon rate in basis points.
    uint16 public immutable couponBps;
    Period[] private schedule;

    mapping(uint256 => Payment) private payments_;
    mapping(uint256 => mapping(address => Paid)) private paid_;
    Request[] private requests_;
    Maturity private maturity_;
    mapping(address => uint128) public redeemedAtMaturity;

    event CouponFunded(uint256 indexed period, uint256 amount, uint256 funded);
    event CouponPaid(uint256 indexed period, address indexed holder, uint256 units, uint256 amount, bool heldBack);
    event RedemptionRequested(uint256 indexed id, address indexed holder, uint256 units);
    event RedemptionSettled(uint256 indexed id, address indexed holder, uint256 units, uint256 principal, uint256 interest);
    event RedemptionReturned(uint256 indexed id, address indexed holder, uint256 units, bool rejected);
    event MaturityStarted(uint256 units, uint256 required);
    event MaturityFunded(uint256 amount, uint256 funded);
    event RedeemedAtMaturity(address indexed holder, uint256 units, uint256 amount);

    error Unauthorized();
    error InvalidTerms();
    error InvalidPeriod();
    error RecordDateNotReached();
    error Underfunded();
    error Overdrawn();
    error AlreadyPaid();
    error NothingHeld();
    error NotEligible(address wallet);
    error InvalidAmount();
    error RequestClosed();
    error AssetMatured();
    error MaturityNotReached();
    error MaturityNotStarted();
    error OpenRequest();

    constructor(
        string memory name_,
        string memory symbol_,
        Registry registry_,
        IERC20 currency_,
        uint128 facePerUnit_,
        uint16 couponBps_,
        Period[] memory periods_
    ) {
        uint8 decimals_ = IERC20Metadata(address(currency_)).decimals();
        if (facePerUnit_ == 0 || couponBps_ == 0 || couponBps_ > 10_000 || decimals_ < 2) revert InvalidTerms();
        if (periods_.length == 0 || periods_.length > MAX_PERIODS) revert InvalidTerms();
        for (uint256 i; i < periods_.length; i++) {
            Period memory p = periods_[i];
            if (p.accrualStart >= p.accrualEnd || p.recordTs > p.paymentTs) revert InvalidTerms();
            if (i > 0) {
                Period memory prev = periods_[i - 1];
                if (p.accrualStart < prev.accrualEnd || p.recordTs < prev.paymentTs) revert InvalidTerms();
            }
            schedule.push(p);
        }
        registry = registry_;
        issuer = msg.sender;
        currency = currency_;
        currencyDecimals = decimals_;
        facePerUnit = facePerUnit_;
        couponBps = couponBps_;
        token = new ServicedToken(name_, symbol_, registry_, msg.sender, address(this));
    }

    // ---- coupons ----

    /// A holding's coupon for a period, rounded down to the cent on the whole holding.
    function couponAmount(uint256 period, uint256 units) public view returns (uint256) {
        Period memory p = schedule[period];
        return DayCount.interest(units, facePerUnit, couponBps, DayCount.days30360(p.accrualStart, p.accrualEnd), currencyDecimals);
    }

    /// What the whole payment costs: the coupon on every unit outstanding at the
    /// record date. Parts rounded down never add up to more than the whole.
    function required(uint256 period) public view returns (uint256) {
        Period memory p = _recorded(period);
        return couponAmount(period, token.totalSupplyAt(p.recordTs));
    }

    /// Anyone: put money toward one payment. Counted as what arrived.
    function fund(uint256 period, uint256 amount) external nonReentrant {
        _recorded(period);
        uint256 received = _pull(amount);
        Payment storage pay_ = payments_[period];
        pay_.funded += SafeCast.toUint128(received);
        emit CouponFunded(period, received, pay_.funded);
    }

    /// Anyone: pay one holder their coupon, or hold it back if they are not
    /// eligible today. Nothing is paid until the payment is fully funded.
    function pay(uint256 period, address holder) public nonReentrant {
        Period memory p = _recorded(period);
        Payment storage pay_ = payments_[period];
        if (pay_.funded < required(period)) revert Underfunded();
        Paid storage rec = paid_[period][holder];
        if (rec.done) revert AlreadyPaid();
        uint256 units = token.balanceAt(holder, p.recordTs);
        if (units == 0) revert NothingHeld();
        uint256 amount = couponAmount(period, units);
        if (uint256(pay_.paid) + pay_.heldBack + amount > pay_.funded) revert Overdrawn();
        bool eligible = registry.isEligible(holder);
        rec.done = true;
        rec.amount = SafeCast.toUint128(amount);
        rec.heldBack = !eligible;
        pay_.payments += 1;
        if (eligible) {
            pay_.paid += SafeCast.toUint128(amount);
            if (amount > 0) currency.safeTransfer(holder, amount);
        } else {
            pay_.heldBack += SafeCast.toUint128(amount);
        }
        emit CouponPaid(period, holder, units, amount, !eligible);
    }

    /// Pay every listed holder not yet paid who held units on the record date.
    function payMany(uint256 period, address[] calldata holders) external {
        Period memory p = _recorded(period);
        for (uint256 i; i < holders.length; i++) {
            if (!paid_[period][holders[i]].done && token.balanceAt(holders[i], p.recordTs) > 0) pay(period, holders[i]);
        }
    }

    // ---- early redemption ----

    /// Face of `units` plus interest accrued at `when`: 30/360 from the start of
    /// the running period, none once its record date has passed (the holder on
    /// the register takes the whole coupon).
    function priceOf(uint256 units, uint256 when) public view returns (uint256 principal, uint256 interest) {
        principal = units * facePerUnit;
        for (uint256 i; i < schedule.length; i++) {
            Period memory p = schedule[i];
            if (p.accrualStart <= when && when < p.accrualEnd) {
                if (when < p.recordTs) {
                    interest = DayCount.interest(units, facePerUnit, couponBps, DayCount.days30360(p.accrualStart, when), currencyDecimals);
                }
                break;
            }
        }
    }

    /// Ask to redeem units early. They stay yours, locked, until the issuer answers.
    function requestRedemption(uint256 units) external returns (uint256 id) {
        if (units == 0) revert InvalidAmount();
        if (maturity_.started) revert AssetMatured();
        if (!registry.isEligible(msg.sender)) revert NotEligible(msg.sender);
        token.lock(msg.sender, units);
        id = requests_.length;
        requests_.push(
            Request({
                holder: msg.sender,
                units: SafeCast.toUint64(units),
                status: Status.Requested,
                requestedTs: SafeCast.toUint64(block.timestamp),
                closedTs: 0,
                principal: 0,
                interest: 0
            })
        );
        emit RedemptionRequested(id, msg.sender, units);
    }

    /// The issuer settles: the program's price moves from the issuer to the
    /// holder and the units burn, in one call.
    function settle(uint256 id) external nonReentrant {
        if (msg.sender != issuer) revert Unauthorized();
        Request storage r = _open(id);
        if (maturity_.started) revert AssetMatured();
        if (!registry.isEligible(r.holder)) revert NotEligible(r.holder);
        (uint256 principal, uint256 interest) = priceOf(r.units, block.timestamp);
        r.status = Status.Settled;
        r.closedTs = SafeCast.toUint64(block.timestamp);
        r.principal = SafeCast.toUint128(principal);
        r.interest = SafeCast.toUint128(interest);
        currency.safeTransferFrom(issuer, r.holder, principal + interest);
        token.burn(r.holder, r.units, true);
        emit RedemptionSettled(id, r.holder, r.units, principal, interest);
    }

    /// The holder withdraws a request the issuer has not answered.
    function cancel(uint256 id) external {
        Request storage r = _open(id);
        if (msg.sender != r.holder) revert Unauthorized();
        _return(id, r, Status.Cancelled);
    }

    /// The issuer refuses a request; the units are free to move again.
    function reject(uint256 id) external {
        if (msg.sender != issuer) revert Unauthorized();
        _return(id, _open(id), Status.Rejected);
    }

    // ---- maturity ----

    function matured() external view returns (bool) {
        return maturity_.started;
    }

    /// Anyone, once the last payment date has passed.
    function startMaturity() external {
        if (maturity_.started) revert AssetMatured();
        if (block.timestamp < schedule[schedule.length - 1].paymentTs) revert MaturityNotReached();
        uint256 units = token.totalSupply();
        maturity_.started = true;
        maturity_.startedTs = SafeCast.toUint64(block.timestamp);
        maturity_.units = SafeCast.toUint64(units);
        maturity_.required = SafeCast.toUint128(units * facePerUnit);
        emit MaturityStarted(units, maturity_.required);
    }

    function fundMaturity(uint256 amount) external nonReentrant {
        if (!maturity_.started) revert MaturityNotStarted();
        uint256 received = _pull(amount);
        maturity_.funded += SafeCast.toUint128(received);
        emit MaturityFunded(received, maturity_.funded);
    }

    /// Anyone: redeem one eligible holding at face, once all the principal is funded.
    function redeem(address holder) external nonReentrant {
        if (!maturity_.started) revert MaturityNotStarted();
        if (maturity_.funded < maturity_.required) revert Underfunded();
        if (token.locked(holder) != 0) revert OpenRequest();
        if (!registry.isEligible(holder)) revert NotEligible(holder);
        uint256 units = token.balanceOf(holder);
        if (units == 0) revert NothingHeld();
        uint256 amount = units * facePerUnit;
        if (uint256(maturity_.paid) + amount > maturity_.funded) revert Overdrawn();
        maturity_.paid += SafeCast.toUint128(amount);
        maturity_.unitsRedeemed += SafeCast.toUint64(units);
        redeemedAtMaturity[holder] += SafeCast.toUint128(amount);
        token.burn(holder, units, false);
        currency.safeTransfer(holder, amount);
        emit RedeemedAtMaturity(holder, units, amount);
    }

    // ---- reads for the console ----

    function periods() external view returns (Period[] memory) {
        return schedule;
    }

    function payment(uint256 period) external view returns (Payment memory) {
        return payments_[period];
    }

    function paidTo(uint256 period, address holder) external view returns (Paid memory) {
        return paid_[period][holder];
    }

    function requestCount() external view returns (uint256) {
        return requests_.length;
    }

    function request(uint256 id) external view returns (Request memory) {
        return requests_[id];
    }

    function maturity() external view returns (Maturity memory) {
        return maturity_;
    }

    // ---- internals ----

    function _recorded(uint256 period) internal view returns (Period memory p) {
        if (period >= schedule.length) revert InvalidPeriod();
        p = schedule[period];
        // strictly after: nothing can change a balance at the record date any more
        if (block.timestamp <= p.recordTs) revert RecordDateNotReached();
    }

    function _open(uint256 id) internal view returns (Request storage r) {
        r = requests_[id];
        if (r.status != Status.Requested) revert RequestClosed();
    }

    function _return(uint256 id, Request storage r, Status status) internal {
        r.status = status;
        r.closedTs = SafeCast.toUint64(block.timestamp);
        token.unlock(r.holder, r.units);
        emit RedemptionReturned(id, r.holder, r.units, status == Status.Rejected);
    }

    function _pull(uint256 amount) internal returns (uint256 received) {
        if (amount == 0) revert InvalidAmount();
        uint256 before = currency.balanceOf(address(this));
        currency.safeTransferFrom(msg.sender, address(this), amount);
        received = currency.balanceOf(address(this)) - before;
    }
}
