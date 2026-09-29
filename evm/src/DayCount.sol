// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The Solana program's coupon arithmetic, line for line: 30/360
/// (MSRB Rule G-33), rounded down to the cent on the whole holding.
library DayCount {
    /// Civil date for a count of days since 1970-01-01 (Howard Hinnant).
    function civilFromDays(int256 z0) internal pure returns (int256 y, int256 m, int256 d) {
        int256 z = z0 + 719_468;
        int256 era = (z >= 0 ? z : z - 146_096) / 146_097;
        int256 doe = z - era * 146_097;
        int256 yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        int256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        int256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        y = yoe + era * 400 + (m <= 2 ? int256(1) : int256(0));
    }

    /// Days between two times on the 30/360 basis: a 31st start counts as the
    /// 30th, and a 31st end counts as the 30th when the start is the 30th or 31st.
    function days30360(uint256 start, uint256 end) internal pure returns (int256) {
        // a day count fits int256 for any uint256 time
        // forge-lint: disable-next-line(unsafe-typecast)
        (int256 y1, int256 m1, int256 d1) = civilFromDays(int256(start / 86_400));
        // forge-lint: disable-next-line(unsafe-typecast)
        (int256 y2, int256 m2, int256 d2) = civilFromDays(int256(end / 86_400));
        if (d1 == 31) d1 = 30;
        if (d2 == 31 && d1 >= 30) d2 = 30;
        return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
    }

    /// Interest on `units` for `days_`, rounded down to the cent of a currency with `decimals`.
    function interest(uint256 units, uint256 facePerUnit, uint256 couponBps, int256 days_, uint8 decimals)
        internal
        pure
        returns (uint256)
    {
        if (days_ <= 0) return 0;
        // days_ is positive here
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 raw = (units * facePerUnit * couponBps * uint256(days_)) / (10_000 * 360);
        uint256 cent = 10 ** (decimals - 2);
        return raw - (raw % cent);
    }
}
