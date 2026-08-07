"""LMSR binary market maker.

One share pays 1 rupee if its side wins. Cost of a trade is the difference in
the LMSR cost function, so the market maker's loss is bounded by b*ln(2).

B is fixed on purpose: see CLAUDE.md. It is tuned for the bets people actually
place, 25 to 200 rupees: a 100 rupee YES buy takes a 50% market to about 70%.
That is the joke, so there is no sensitivity setting. Lower B is more violent.
"""

from math import exp, log, log1p

B = 200.0


def _cost(y: float, n: float, b: float = B) -> float:
    """b * ln(e^(y/b) + e^(n/b)), shifted so the exponentials cannot overflow."""
    m = max(y, n)
    return m + b * log(exp((y - m) / b) + exp((n - m) / b))


def prob_yes(y: float, n: float, b: float = B) -> float:
    """Sigmoid of the share difference. Stable for large |y-n|."""
    d = (y - n) / b
    if d >= 0:
        return 1.0 / (1.0 + exp(-d))
    e = exp(d)
    return e / (1.0 + e)


def shares_from(y: float, n: float, side: str, amount: float, b: float = B) -> float:
    """Shares bought for `amount` spent on `side`.

    Solve cost(y', n) - cost(y, n) = amount for the chosen side. Rearranged with
    log1p so the subtraction does not lose precision for small trades.
    """
    if amount <= 0:
        raise ValueError("amount must be positive")
    own, other = (y, n) if side == "yes" else (n, y)
    target = _cost(y, n, b) + amount
    # own' = b * ln(e^(target/b) - e^(other/b))
    #      = target + b * ln1p(-e^((other-target)/b))
    inner = (other - target) / b
    if inner >= 0:  # cannot happen for amount > 0, but never divide the joke by zero
        raise ValueError("degenerate trade")
    new_own = target + b * log1p(-exp(inner))
    return new_own - own


def quote(y: float, n: float, side: str, amount: float, b: float = B) -> dict:
    """What the buyer sees before confirming."""
    shares = shares_from(y, n, side, amount, b)
    ny, nn = (y + shares, n) if side == "yes" else (y, n + shares)
    return {
        "shares": shares,
        "avg_price": amount / shares,
        "prob_before": prob_yes(y, n, b),
        "prob_after": prob_yes(ny, nn, b),
        "payout": shares,        # 1 rupee a share
        "max_loss": amount,
        "yes_shares": ny,
        "no_shares": nn,
    }


def shares_for_probability(p: float, b: float = B) -> float:
    """YES shares that put a fresh market at probability p, with NO at zero."""
    if not 0.0 < p < 1.0:
        raise ValueError("probability must be strictly between 0 and 1")
    return b * log(p / (1.0 - p))


def _selfcheck() -> None:
    # the headline promise, and the shape of the whole betting range
    assert 0.69 < quote(0, 0, "yes", 100)["prob_after"] < 0.71
    for amount, lo, hi in ((25, 0.55, 0.57), (50, 0.60, 0.62),
                           (200, 0.81, 0.83), (500, 0.95, 0.97)):
        p = quote(0, 0, "yes", amount)["prob_after"]
        assert lo < p < hi, (amount, p)

    # a fresh market is a coin flip, and buying moves the right way
    assert abs(prob_yes(0, 0) - 0.5) < 1e-12
    assert quote(0, 0, "no", 500)["prob_after"] < 0.5

    # bigger trades move price more, and cost more per share
    small, big = quote(0, 0, "yes", 25), quote(0, 0, "yes", 2000)
    assert small["prob_after"] < big["prob_after"]
    assert small["avg_price"] < big["avg_price"]

    # you never buy a share for more than a rupee's payout unless price says so
    assert 0.5 < small["avg_price"] < 1.0

    # cost is symmetric: same spend on either side of a fresh market
    assert abs(quote(0, 0, "yes", 500)["shares"] - quote(0, 0, "no", 500)["shares"]) < 1e-9

    # round trip through the starting-probability helper
    for p in (0.01, 0.25, 0.5, 0.9, 0.99):
        assert abs(prob_yes(shares_for_probability(p), 0) - p) < 1e-9

    # extreme state stays finite instead of overflowing
    assert prob_yes(1e6, 0) == 1.0
    assert quote(1e5, 0, "no", 500)["shares"] > 0

    # two sequential buys equal one big buy, so the maker cannot be arbitraged
    a = quote(0, 0, "yes", 250)
    bq = quote(a["yes_shares"], a["no_shares"], "yes", 250)
    one = quote(0, 0, "yes", 500)
    assert abs((a["shares"] + bq["shares"]) - one["shares"]) < 1e-9

    print("lmsr selfcheck ok  b=%.0f  100 on a coin flip -> %.1f%%"
          % (B, 100 * quote(0, 0, "yes", 100)["prob_after"]))


if __name__ == "__main__":
    _selfcheck()
