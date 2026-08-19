"""Follymarket API. Server-authoritative trading on Firestore.

Every write that touches money happens inside a Firestore transaction here.
The browser previews trades with the same maths but never decides anything.

Auth: Firebase ID token in `Authorization: Bearer`. Access: an email must be in
folly_allowlist, except FOLLY_ADMIN_EMAIL which admits itself on first login.
"""

import csv
import io
import json
import logging
import os
from datetime import datetime, timezone

import firebase_admin
import requests
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Header, Request
from fastapi.responses import StreamingResponse
from firebase_admin import auth as fb_auth, firestore
from pydantic import BaseModel, Field

import lmsr
from product_analytics import track_product_event
import push

# Everyone starts empty and chooses their own stake. The first top-up IS that
# choice, so there is no onboarding flag and no starting grant.
# Comma separated: which Google account he signs in with is not worth a redeploy.
ADMINS = {e.strip().lower() for e in os.environ.get("FOLLY_ADMIN_EMAIL", "").split(",") if e.strip()}
DISCORD = os.environ.get("FOLLY_DISCORD_WEBHOOK", "")
# The front door. He does not have everyone's email and does not want to ask, so
# entry is one shared code rather than an allowlist of addresses. The allowlist
# still works and is now only the pre-approval path (POST /api/admin/allowlist).
JOIN_CODE = os.environ.get("FOLLY_JOIN_CODE", "").strip().lower()

firebase_admin.initialize_app()
db = firestore.client()
app = FastAPI(title="follymarket")

U = "folly_users"
M = "folly_markets"
P = "folly_positions"
L = "folly_ledger"
A = "folly_allowlist"
PUSH = "folly_push"


class CloudRunJson(logging.Formatter):
    """Cloud Logging parses a JSON line into a structured entry, so severity and
    fields become filterable instead of being buried in a text blob.
    Query them with:
      gcloud logging read 'jsonPayload.event="signin.denied"' --project teejayproject
    """

    def format(self, record):
        entry = {
            "severity": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
        }
        entry.update(getattr(record, "fields", {}) or {})
        if record.exc_info:
            entry["stack"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


_h = logging.StreamHandler()
_h.setFormatter(CloudRunJson())
logging.basicConfig(level=logging.INFO, handlers=[_h], force=True)
log = logging.getLogger("folly")


def event(name: str, **fields) -> None:
    """One structured line per interesting thing. Never log a token or a webhook."""
    log.info(name, extra={"fields": {"event": name, **fields}})


def now():
    return datetime.now(timezone.utc)


def money_words(amount: float) -> str:
    return "₹%.0f" % amount


def tell_discord(text: str) -> None:
    # ponytail: best effort. A dead webhook must never fail a trade.
    if not DISCORD:
        return
    try:
        # allowed_mentions parse:[] means a market question containing @everyone
        # cannot ping the whole server.
        requests.post(DISCORD, json={"content": text[:1800],
                                     "allowed_mentions": {"parse": []}}, timeout=4)
    except Exception:
        pass


# ---------------------------------------------------------------- push fan-out

def _subs_for(uids: set[str]) -> list[tuple[str, dict]]:
    """Every live subscription belonging to these users."""
    out, uids = [], [u for u in uids if u]
    for i in range(0, len(uids), 10):          # Firestore caps an `in` filter
        chunk = uids[i:i + 10]
        for d in db.collection(PUSH).where(
                filter=firestore.FieldFilter("user", "in", chunk)).stream():
            sub = d.to_dict().get("sub")
            if sub:
                out.append((d.id, sub))
    return out


def notify(uids: set[str], title: str, body: str, url: str, tag: str = "") -> None:
    """Best effort, exactly like the Discord alerts: a failure must never break a
    trade or a resolution. Dead subscriptions are deleted here, where the database
    is in scope."""
    try:
        if not push.ENABLED or not uids:
            return
        subs = _subs_for(uids)
        dead = push.send_many(subs, title, body, url, tag)
        for sid in dead:
            db.collection(PUSH).document(sid).delete()
        event("push.sent", recipients=len(uids), subscriptions=len(subs), pruned=len(dead))
    except Exception:
        log.exception("notify failed")


def _holders(mid: str, exclude: str = "") -> set[str]:
    out = set()
    for d in db.collection(P).where(
            filter=firestore.FieldFilter("market", "==", mid)).stream():
        uid = d.to_dict().get("user")
        if uid and uid != exclude:
            out.add(uid)
    return out


def _players(exclude: str = "") -> set[str]:
    return {d.id for d in db.collection(U).where(
            filter=firestore.FieldFilter("status", "==", "allowed")).stream()
            if d.id != exclude}


# ---------------------------------------------------------------- auth

def me(authorization: str = Header(default="")) -> dict:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "no token")
    try:
        tok = fb_auth.verify_id_token(authorization[7:])
    except Exception as e:
        # The token itself never reaches the log, only why it was refused.
        event("auth.token_rejected", reason=type(e).__name__)
        raise HTTPException(401, "bad token")

    uid, email = tok["uid"], (tok.get("email") or "").lower()
    if not email:
        raise HTTPException(403, "no email on this account")

    ref = db.collection(U).document(uid)
    snap = ref.get()
    if snap.exists:
        user = snap.to_dict()
        ref.update({"last_seen_at": now()})
    else:
        allowed = bool(db.collection(A).document(email).get().exists) or email in ADMINS
        user = {
            "email": email,
            "name": tok.get("name") or email.split("@")[0],
            "picture": tok.get("picture", ""),
            "role": "admin" if email in ADMINS else "user",
            "status": "allowed" if allowed else "blocked",
            "cash": 0.0,
            "deposited": 0.0,
            "created_at": now(),
            "last_seen_at": now(),
        }
        try:
            ref.create(user)   # fails if a concurrent first request won the race
        except Exception:
            snap = ref.get()
            if not snap.exists:
                raise
            user = snap.to_dict()
            user["uid"] = uid
            return user
        event("signup", email=email, status=user["status"], uid=uid)
        tell_discord("New signup: %s (%s), status %s" % (user["name"], email, user["status"]))

    user["uid"] = uid
    return user


def allowed(user: dict = Depends(me)) -> dict:
    if user.get("status") != "allowed":
        event("access.denied", email=user.get("email"), status=user.get("status"))
        raise HTTPException(403, "not on the list")
    return user


def can_resolve(user: dict, market: dict) -> bool:
    return user["role"] == "admin" or market.get("resolver") == user["uid"]


# ---------------------------------------------------------------- reads

def market_view(doc, uid: str | None = None) -> dict:
    m = doc.to_dict()
    out = {
        "id": doc.id,
        "question": m["question"],
        "criteria": m.get("criteria", ""),
        "category": m.get("category", ""),
        "status": m["status"],
        "prob": lmsr.prob_yes(m["yes_shares"], m["no_shares"]),
        "volume": m.get("volume", 0.0),
        "close_mode": m.get("close_mode", "manual"),
        "close_at": m.get("close_at"),
        "creator_name": m.get("creator_name", ""),
        "resolver": m.get("resolver"),
        "outcome": m.get("outcome"),
        "resolution_note": m.get("resolution_note", ""),
        "resolved_by_name": m.get("resolved_by_name", ""),
        "created_at": m.get("created_at"),
        "trades": m.get("trade_count", 0),
        "comments": m.get("comment_count", 0),
    }
    if uid:
        pos = db.collection(P).document("%s_%s" % (uid, doc.id)).get()
        out["position"] = pos.to_dict() if pos.exists else None
    return out


@app.get("/api/me")
def get_me(user: dict = Depends(me)):
    return {"uid": user["uid"], "email": user["email"], "name": user["name"],
            "picture": user.get("picture", ""), "role": user["role"],
            "status": user["status"], "cash": user.get("cash", 0.0),
            "deposited": user.get("deposited", 0.0),
            # Only an admin needs the code, so only an admin is told it.
            "join_code": JOIN_CODE if user["role"] == "admin" else None,
            "vapid_public": push.PUBLIC if push.ENABLED else None}


@app.get("/api/markets")
def list_markets(user: dict = Depends(allowed)):
    docs = db.collection(M).order_by("created_at", direction=firestore.Query.DESCENDING).limit(60).stream()
    return [market_view(d, user["uid"]) for d in docs]


@app.get("/api/markets/{mid}")
def get_market(mid: str, user: dict = Depends(allowed)):
    doc = db.collection(M).document(mid).get()
    if not doc.exists:
        raise HTTPException(404, "no such market")
    out = market_view(doc, user["uid"])

    trades = list(db.collection(M).document(mid).collection("trades")
                  .order_by("at", direction=firestore.Query.DESCENDING).limit(40).stream())
    out["recent"] = [t.to_dict() for t in trades]

    # chart: the probability after every trade, oldest first, plus the open
    series = [{"at": doc.to_dict().get("created_at"), "prob": doc.to_dict().get("initial_prob", 0.5)}]
    series += [{"at": t["at"], "prob": t["prob_after"]} for t in reversed(out["recent"])]
    out["series"] = series

    holders = {}
    for pos in db.collection(P).where(filter=firestore.FieldFilter("market", "==", mid)).stream():
        d = pos.to_dict()
        holders[d["user_name"]] = {"name": d["user_name"], "yes": d.get("yes", 0.0),
                                   "no": d.get("no", 0.0), "spent": d.get("spent", 0.0)}
    out["holders"] = sorted(holders.values(), key=lambda h: -(h["yes"] + h["no"]))

    out["comment_list"] = [c.to_dict() for c in db.collection(M).document(mid)
                           .collection("comments").order_by("at").limit(200).stream()]
    return out


@app.get("/api/portfolio")
def portfolio(user: dict = Depends(allowed)):
    positions, value = [], 0.0
    for pos in db.collection(P).where(filter=firestore.FieldFilter("user", "==", user["uid"])).stream():
        d = pos.to_dict()
        mdoc = db.collection(M).document(d["market"]).get()
        if not mdoc.exists:
            continue
        m = mdoc.to_dict()
        p = lmsr.prob_yes(m["yes_shares"], m["no_shares"])
        mark = d.get("yes", 0.0) * p + d.get("no", 0.0) * (1 - p)
        if m["status"] in ("resolved", "void"):
            continue
        value += mark
        positions.append({"market": d["market"], "question": m["question"],
                          "yes": d.get("yes", 0.0), "no": d.get("no", 0.0),
                          "spent": d.get("spent", 0.0), "value": mark, "prob": p})
    # A `where` plus an `order_by` on a different field needs a composite index in
    # Firestore, and returns 500 until someone creates it. One player's ledger is
    # tens of rows, so sort here instead.
    # ponytail: O(n) fetch per view. Add the composite index if a ledger ever
    # reaches thousands of rows.
    ledger = sorted((x.to_dict() for x in db.collection(L)
                     .where(filter=firestore.FieldFilter("user", "==", user["uid"])).stream()),
                    key=lambda x: x.get("at") or datetime.min.replace(tzinfo=timezone.utc),
                    reverse=True)[:50]
    settled = sum(x["amount"] for x in ledger if x["type"] in ("resolution", "refund"))
    cash, deposited = user.get("cash", 0.0), user.get("deposited", 0.0)
    return {"cash": cash, "position_value": value,
            "unrealised": value - sum(p["spent"] for p in positions),
            "settled": settled, "deposited": deposited,
            "net": cash + value - deposited,
            "positions": positions, "ledger": ledger}


@app.get("/api/ledger.csv")
def ledger_csv(user: dict = Depends(allowed)):
    if user["role"] != "admin":
        raise HTTPException(403, "admins only")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["when", "email", "type", "amount", "description"])
    names = {d.id: d.to_dict().get("email", "") for d in db.collection(U).stream()}
    for x in db.collection(L).order_by("at").stream():
        d = x.to_dict()
        w.writerow([d["at"].isoformat(), names.get(d["user"], d["user"]),
                    d["type"], "%.2f" % d["amount"], d.get("description", "")])
    buf.seek(0)
    return StreamingResponse(buf, media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=follymarket-ledger.csv"})


# ---------------------------------------------------------------- writes

class NewMarket(BaseModel):
    question: str = Field(min_length=4, max_length=200)
    criteria: str = Field(default="", max_length=1000)
    category: str = Field(default="Chaos", max_length=40)
    initial_prob: float = Field(default=0.5, gt=0.01, lt=0.99)
    close_mode: str = "manual"
    close_at: datetime | None = None


@app.post("/api/markets")
def create_market(body: NewMarket, user: dict = Depends(allowed)):
    close_at = body.close_at
    if body.close_mode == "datetime":
        if not close_at:
            raise HTTPException(400, "close_at is required")
        if close_at.tzinfo is None:          # naive vs aware raises TypeError
            close_at = close_at.replace(tzinfo=timezone.utc)
        if close_at <= now():
            raise HTTPException(400, "close_at must be in the future")
    ref = db.collection(M).document()
    ref.set({"question": body.question.strip(), "criteria": body.criteria.strip(),
             "category": body.category, "status": "open",
             "initial_prob": body.initial_prob,
             "yes_shares": lmsr.shares_for_probability(body.initial_prob), "no_shares": 0.0,
             "volume": 0.0, "trade_count": 0, "comment_count": 0,
             "close_mode": body.close_mode,
             "close_at": close_at if body.close_mode == "datetime" else None,
             "creator": user["uid"], "creator_name": user["name"], "resolver": user["uid"],
             "created_at": now()})
    tell_discord('New market: "%s"\nBy %s, opening at %d%%'
                 % (body.question.strip(), user["name"], round(100 * body.initial_prob)))
    notify(_players(exclude=user["uid"]), "New market",
           "%s: %s" % (user["name"], body.question.strip()),
           "/#/m/" + ref.id, "market-" + ref.id)
    return {"id": ref.id}


class Trade(BaseModel):
    market: str
    side: str
    amount: float = Field(gt=0, le=1_000_000)
    # The client sends one id per confirmed trade and reuses it on retry. It
    # becomes the trade document id, so a dropped response cannot double charge:
    # the second attempt finds the document and stops. Preview ignores it.
    nonce: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")


def _open_for_trading(m: dict) -> bool:
    if m["status"] != "open":
        return False
    close_at = m.get("close_at")
    return not (close_at and close_at <= now())


@app.post("/api/trades/preview")
def preview(body: Trade, user: dict = Depends(allowed)):
    if body.side not in ("yes", "no"):
        raise HTTPException(400, "side must be yes or no")
    doc = db.collection(M).document(body.market).get()
    if not doc.exists:
        raise HTTPException(404, "no such market")
    m = doc.to_dict()
    if not _open_for_trading(m):
        raise HTTPException(409, "market is closed")
    q = lmsr.quote(m["yes_shares"], m["no_shares"], body.side, body.amount)
    q["cash_after"] = user.get("cash", 0.0) - body.amount
    q["affordable"] = q["cash_after"] >= 0
    return q


@app.post("/api/trades")
def trade(body: Trade, background_tasks: BackgroundTasks, user: dict = Depends(allowed)):
    if body.side not in ("yes", "no"):
        raise HTTPException(400, "side must be yes or no")
    mref = db.collection(M).document(body.market)
    uref = db.collection(U).document(user["uid"])
    pref = db.collection(P).document("%s_%s" % (user["uid"], body.market))

    tcol = mref.collection("trades")
    tref = tcol.document(body.nonce) if body.nonce else tcol.document()
    lref = (db.collection(L).document("trade_%s_%s" % (body.market, body.nonce))
            if body.nonce else db.collection(L).document())

    @firestore.transactional
    def run(tx):
        msnap = mref.get(transaction=tx)
        if not msnap.exists:
            raise HTTPException(404, "no such market")
        if body.nonce and tref.get(transaction=tx).exists:
            raise HTTPException(409, "this trade was already recorded")
        m = msnap.to_dict()
        if not _open_for_trading(m):
            raise HTTPException(409, "market is closed")

        cash = uref.get(transaction=tx).to_dict().get("cash", 0.0)
        if body.amount > cash:
            raise HTTPException(400, "not enough cash")

        q = lmsr.quote(m["yes_shares"], m["no_shares"], body.side, body.amount)
        psnap = pref.get(transaction=tx)
        pos = psnap.to_dict() if psnap.exists else {"yes": 0.0, "no": 0.0, "spent": 0.0}

        tx.update(mref, {"yes_shares": q["yes_shares"], "no_shares": q["no_shares"],
                         "volume": m.get("volume", 0.0) + body.amount,
                         "trade_count": m.get("trade_count", 0) + 1})
        tx.update(uref, {"cash": cash - body.amount})
        tx.set(pref, {"user": user["uid"], "user_name": user["name"], "market": body.market,
                      "yes": pos.get("yes", 0.0) + (q["shares"] if body.side == "yes" else 0.0),
                      "no": pos.get("no", 0.0) + (q["shares"] if body.side == "no" else 0.0),
                      "spent": pos.get("spent", 0.0) + body.amount, "updated_at": now()})
        tx.set(tref,
               {"user": user["uid"], "user_name": user["name"], "side": body.side,
                "amount": body.amount, "shares": q["shares"],
                "prob_before": q["prob_before"], "prob_after": q["prob_after"], "at": now()})
        tx.set(lref,
               {"user": user["uid"], "market": body.market, "type": "trade",
                "amount": -body.amount, "at": now(),
                "description": "Buy %s, %s" % (body.side.upper(), m["question"])})
        return q, m["question"]

    q, question = run(db.transaction())
    event("trade", uid=user["uid"], market=body.market, side=body.side,
          amount=body.amount, prob_after=round(q["prob_after"], 4))
    notify(_holders(body.market, exclude=user["uid"]),
           "%s bought %s" % (user["name"], body.side.upper()),
           "%s is now %d%%, was %d%%" % (question, round(100 * q["prob_after"]),
                                         round(100 * q["prob_before"])),
           "/#/m/" + body.market, "trade-" + body.market)
    if abs(q["prob_after"] - q["prob_before"]) >= 0.15 or body.amount >= 1000:
        tell_discord("%s bought %s %.0f on \"%s\"\n%d%% to %d%%"
                     % (user["name"], body.side.upper(), body.amount, question,
                        round(100 * q["prob_before"]), round(100 * q["prob_after"])))
    background_tasks.add_task(track_product_event, "trade_completed", "trade")
    return q


@app.post("/api/markets/{mid}/close")
def close_market(mid: str, user: dict = Depends(allowed)):
    ref = db.collection(M).document(mid)

    # Transactional so two clicks cannot both report success, and so a trade in
    # flight retries and then sees the closed market instead of slipping through.
    @firestore.transactional
    def run(tx):
        snap = ref.get(transaction=tx)
        if not snap.exists:
            raise HTTPException(404, "no such market")
        m = snap.to_dict()
        if not can_resolve(user, m):
            raise HTTPException(403, "not the resolver")
        if m["status"] != "open":
            raise HTTPException(409, "already closed")
        tx.update(ref, {"status": "closed", "closed_at": now(), "closed_by": user["uid"]})

    run(db.transaction())
    return {"status": "closed"}


class Resolution(BaseModel):
    outcome: str
    note: str = Field(default="", max_length=500)


@app.post("/api/markets/{mid}/resolve")
def resolve(mid: str, body: Resolution, user: dict = Depends(allowed)):
    if body.outcome not in ("yes", "no", "void"):
        raise HTTPException(400, "outcome must be yes, no or void")
    mref = db.collection(M).document(mid)
    doc = mref.get()
    if not doc.exists:
        raise HTTPException(404, "no such market")
    m = doc.to_dict()
    if not can_resolve(user, m):
        raise HTTPException(403, "not the resolver")
    final = "void" if body.outcome == "void" else "resolved"

    # Claim the market in one transaction BEFORE paying anyone. Two resolvers
    # clicking together used to both pass this check and both pay every holder,
    # because the status only changed after the payout loop.
    @firestore.transactional
    def claim(tx):
        snap = mref.get(transaction=tx)
        if not snap.exists:
            raise HTTPException(404, "no such market")
        cur = snap.to_dict()
        if cur["status"] in ("resolved", "void"):
            # Re-running the SAME outcome is allowed on purpose: it finishes a
            # payout that died halfway. A different outcome is refused.
            if cur.get("outcome") != body.outcome:
                raise HTTPException(409, "already settled as " + str(cur.get("outcome")))
            return cur
        tx.update(mref, {"status": final, "outcome": body.outcome,
                         "resolution_note": body.note.strip(),
                         "resolved_by": user["uid"], "resolved_by_name": user["name"],
                         "resolved_at": now()})
        return cur

    claim(db.transaction())

    # Payouts are one transaction per holder: Firestore caps a transaction at 500
    # writes, and a per-holder transaction retries on its own. `settled_as` on the
    # position and a deterministic ledger id make each payout exactly once.
    paid = 0.0
    for pos in db.collection(P).where(filter=firestore.FieldFilter("market", "==", mid)).stream():
        d = pos.to_dict()
        if d.get("settled_as") == body.outcome:
            continue
        if body.outcome == "yes":
            amount, kind = d.get("yes", 0.0), "resolution"
        elif body.outcome == "no":
            amount, kind = d.get("no", 0.0), "resolution"
        else:
            amount, kind = d.get("spent", 0.0), "refund"
        pref, uref = pos.reference, db.collection(U).document(d["user"])
        lref = db.collection(L).document("%s_%s_%s" % (body.outcome, mid, d["user"]))

        @firestore.transactional
        def pay(tx, pref=pref, uref=uref, lref=lref, amount=amount, kind=kind, holder=d):
            if pref.get(transaction=tx).to_dict().get("settled_as") == body.outcome:
                return 0.0
            usnap = uref.get(transaction=tx)
            if not usnap.exists:
                return 0.0
            tx.update(pref, {"settled_as": body.outcome})
            if amount <= 0:
                return 0.0
            tx.update(uref, {"cash": usnap.to_dict().get("cash", 0.0) + amount})
            tx.set(lref, {"user": holder["user"], "market": mid, "type": kind,
                          "amount": amount, "at": now(),
                          "description": "%s %s, %s" % (
                              "Void refund" if kind == "refund" else "Resolved",
                              body.outcome.upper(), m["question"])})
            return amount

        paid += pay(db.transaction())

    mref.update({"paid_out": firestore.Increment(paid)})
    event("resolve", market=mid, outcome=body.outcome, paid_out=paid, by=user["uid"])
    notify(_holders(mid), "Resolved %s" % body.outcome.upper(),
           "%s. %s paid out." % (m["question"], money_words(paid)),
           "/#/m/" + mid, "resolve-" + mid)
    tell_discord('Resolved %s: "%s"\nBy %s. %.0f paid out.%s'
                 % (body.outcome.upper(), m["question"], user["name"], paid,
                    "\n" + body.note.strip() if body.note.strip() else ""))
    return {"status": "resolved", "outcome": body.outcome, "paid_out": paid}


@app.delete("/api/markets/{mid}")
def delete_market(mid: str, user: dict = Depends(allowed)):
    """Admin escape hatch for a market that should never have existed.

    Only before the first trade. Once money is in, deleting would either strand
    it or need a refund pass, and that refund pass already exists and is called
    VOID. So a traded market is voided, never deleted.
    """
    if user["role"] != "admin":
        raise HTTPException(403, "admins only")
    ref = db.collection(M).document(mid)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(404, "no such market")
    m = snap.to_dict()
    if m.get("trade_count", 0) > 0:
        raise HTTPException(409, "this market has trades, void it instead: that refunds everyone")

    # Deleting a document does NOT delete its subcollections in Firestore, so the
    # comments and trades would linger as orphans forever.
    for sub in ("comments", "trades"):
        for d in ref.collection(sub).stream():
            d.reference.delete()
    ref.delete()
    tell_discord('%s deleted the untraded market "%s"' % (user["name"], m["question"]))
    return {"deleted": mid}


class Comment(BaseModel):
    body: str = Field(min_length=1, max_length=1000)


@app.post("/api/markets/{mid}/comments")
def comment(mid: str, body: Comment, user: dict = Depends(allowed)):
    mref = db.collection(M).document(mid)
    if not mref.get().exists:
        raise HTTPException(404, "no such market")
    text = body.body.strip()
    mref.collection("comments").add({"user": user["uid"], "user_name": user["name"],
                                     "body": text, "at": now()})
    mref.update({"comment_count": firestore.Increment(1)})
    notify(_holders(mid, exclude=user["uid"]), "%s commented" % user["name"],
           text[:120], "/#/m/" + mid, "comment-" + mid)
    return {"ok": True}


class TopUp(BaseModel):
    amount: float = Field(gt=0, le=1_000_000)
    nonce: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")


@app.post("/api/topup")
def topup(body: TopUp, background_tasks: BackgroundTasks, user: dict = Depends(allowed)):
    """Print yourself money. Fake money, so the only control that matters is that
    everyone can see you did it: it goes to the ledger and to Discord, and the
    portfolio scores you on cash plus positions MINUS what you put in."""
    uref = db.collection(U).document(user["uid"])
    lref = (db.collection(L).document("topup_" + body.nonce) if body.nonce
            else db.collection(L).document())

    @firestore.transactional
    def run(tx):
        d = uref.get(transaction=tx).to_dict()
        if body.nonce and lref.get(transaction=tx).exists:
            raise HTTPException(409, "this top-up was already recorded")
        tx.update(uref, {"cash": d.get("cash", 0.0) + body.amount,
                         "deposited": d.get("deposited", 0.0) + body.amount})
        tx.set(lref,
               {"user": user["uid"], "market": None, "type": "topup",
                "amount": body.amount, "at": now(),
                "description": "Topped up %.0f" % body.amount})
        return d.get("cash", 0.0) + body.amount, d.get("deposited", 0.0) + body.amount

    cash, deposited = run(db.transaction())
    tell_discord("%s topped up %.0f, %.0f in total"
                 % (user["name"], body.amount, deposited))
    background_tasks.add_task(track_product_event, "top_up_completed", "wallet")
    return {"cash": cash, "deposited": deposited}


class PushSub(BaseModel):
    subscription: dict


@app.post("/api/push/subscribe")
def push_subscribe(body: PushSub, user: dict = Depends(allowed)):
    if not push.ENABLED:
        raise HTTPException(503, "push is not configured")
    if not push.valid_subscription(body.subscription):
        raise HTTPException(400, "that is not a push subscription")
    sid = push.sub_id(body.subscription["endpoint"])
    # The id is derived from the endpoint, so re-subscribing the same browser
    # replaces its row instead of piling up duplicates and double notifications.
    db.collection(PUSH).document(sid).set({"user": user["uid"], "sub": body.subscription,
                                           "at": now()})
    event("push.subscribed", uid=user["uid"])
    return {"ok": True}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(body: PushSub, user: dict = Depends(allowed)):
    ep = (body.subscription or {}).get("endpoint")
    if not isinstance(ep, str):
        raise HTTPException(400, "no endpoint")
    ref = db.collection(PUSH).document(push.sub_id(ep))
    snap = ref.get()
    # Only delete your own, so an endpoint id cannot be used to mute someone else.
    if snap.exists and snap.to_dict().get("user") == user["uid"]:
        ref.delete()
    return {"ok": True}


@app.post("/api/push/test")
def push_test(user: dict = Depends(allowed)):
    if not push.ENABLED:
        raise HTTPException(503, "push is not configured")
    count = len(_subs_for({user["uid"]}))
    if not count:
        raise HTTPException(409, "this browser is not subscribed")
    notify({user["uid"]}, "Follymarket", "Notifications are working.", "/#/", "test")
    return {"ok": True, "sent_to": count}


class Join(BaseModel):
    code: str = Field(min_length=1, max_length=64)


@app.post("/api/join")
def join(body: Join, user: dict = Depends(me)):
    """Trade the shared code for entry. Anyone with the link can play."""
    if user.get("status") == "allowed":
        return {"status": "allowed"}
    if not JOIN_CODE or body.code.strip().lower() != JOIN_CODE:
        event("join.bad_code", email=user.get("email"))
        raise HTTPException(403, "that code is wrong")
    event("join.ok", email=user["email"], uid=user["uid"])
    db.collection(U).document(user["uid"]).update({"status": "allowed", "joined_at": now()})
    tell_discord("%s (%s) joined with the code" % (user["name"], user["email"]))
    return {"status": "allowed"}


class Invite(BaseModel):
    email: str


@app.post("/api/admin/allowlist")
def invite(body: Invite, user: dict = Depends(allowed)):
    if user["role"] != "admin":
        raise HTTPException(403, "admins only")
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "not an email")
    db.collection(A).document(email).set({"added_by": user["uid"], "at": now()})
    return {"ok": True, "email": email}


class ClientError(BaseModel):
    stage: str = Field(max_length=40)
    code: str = Field(default="", max_length=120)
    message: str = Field(default="", max_length=400)
    email: str = Field(default="", max_length=120)


# ponytail: per instance, not global, and reset every minute. Ten reports a minute
# is plenty for ten players and caps what an outsider can push into Discord.
_err_window = [0, 0]


def _report_budget_ok(limit: int = 10) -> bool:
    minute = int(now().timestamp() // 60)
    if _err_window[0] != minute:
        _err_window[0], _err_window[1] = minute, 0
    _err_window[1] += 1
    return _err_window[1] <= limit


@app.post("/api/client-error")
def client_error(body: ClientError, request: Request):
    """Unauthenticated on purpose: the failures worth hearing about, like a sign-in
    that dies at Google, happen before there is any token to send. Everything here
    is attacker-controlled text, so it is truncated, fenced so Discord cannot be
    tricked into markdown or a mention, and rate limited."""
    ua = (request.headers.get("user-agent") or "")[:200]
    event("client.error", stage=body.stage, code=body.code,
          message=body.message[:200], email=body.email or None, ua=ua)
    if not _report_budget_ok():
        return {"ok": True, "throttled": True}
    tell_discord("Client error at `%s`\n```\n%s\n%s\n%s\n%s\n```" % (
        body.stage.replace("`", ""), body.code.replace("`", "'"),
        body.message.replace("`", "'"), body.email.replace("`", "'"), ua.replace("`", "'")))
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "b": lmsr.B}
