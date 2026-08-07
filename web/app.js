import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";

// Public config. The API key identifies the project, it does not authorise anything.
const fb = initializeApp({
  apiKey: "AIzaSyDRNv2eMMX7DwBAGrDo3PGXaGwBqsygtvM",
  // Our own origin. The Worker proxies /__/auth/* to Firebase, so sign-in is
  // same-site: it survives Safari tracking prevention and in-app browsers, which
  // is what broke inside WhatsApp.
  // BOTH of these are registered as authorized redirect URIs on OAuth client
  // 974343814740-ep0esb453q5..., verified against Google on 2026-08-06:
  //   https://follymarket.tn07.dev/__/auth/handler
  //   https://teejayproject.firebaseapp.com/__/auth/handler
  // Never change this line without registering the new origin's handler URI
  // first. Google answers redirect_uri_mismatch and nobody can sign in at all.
  authDomain: "follymarket.tn07.dev",
  projectId: "teejayproject",
  appId: "1:974343814740:web:6bc1bf5ef3b8ed753e37c1",
});
const auth = getAuth(fb);

const view = document.getElementById("view");
// Last payload per screen. Polling used to rebuild the DOM every 8 seconds
// whether or not anything moved, which flickered and wiped what you typed.
const seen = {};
const chrome = document.getElementById("chrome");
const tabs = document.getElementById("tabs");
let me = null, timer = null;

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const pct = (p) => Math.round(p * 100) + "%";
// A share pays ₹1, so its price is rupees and paise. It was showing ¢.
const price = (p) => "₹" + p.toFixed(2);
const signed = (n) => (n >= 0 ? "+" : "-") + money(Math.abs(n));

function until(v) {
  const s = (new Date(v) - Date.now()) / 1000;
  if (s <= 0) return "now";
  if (s < 3600) return "in " + Math.ceil(s / 60) + "m";
  if (s < 86400) return "in " + Math.round(s / 3600) + "h";
  return "in " + Math.round(s / 86400) + "d";
}

function ago(v) {
  const t = new Date(v?.seconds ? v.seconds * 1000 : v);
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function toast(msg, bad) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

async function api(path, body, method) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch("/api" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}

// A failure in the browser leaves nothing in the server logs, which is exactly
// how the WhatsApp sign-in bug stayed invisible. This posts it to Discord.
// Deliberately not using api(): a sign-in failure has no token to send.
let reported = 0;
async function reportError(stage, e) {
  if (reported >= 5) return;               // one bad loop must not spam the channel
  reported += 1;
  try {
    await fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage,
        code: String(e?.code || e?.name || "").slice(0, 120),
        message: String(e?.message || e || "").slice(0, 400),
        email: auth.currentUser?.email || "",
      }),
    });
  } catch (_) {}
}

window.addEventListener("error", (e) => reportError("window", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => reportError("promise", e.reason));

// ---------------------------------------------------------------- sign in
function renderLogin(blockedEmail) {
  chrome.hidden = tabs.hidden = true;
  document.body.style.paddingBottom = "0";
  view.innerHTML = `
    <section class="screen" id="login" style="display:grid;align-content:center;justify-items:center;
             min-height:100dvh;text-align:center;padding:24px 0">
      <div class="mark">f</div>
      <h1>Follymarket</h1>
      <p class="sm muted" style="margin-top:8px">
        A private market on things your friends will probably do. Fake money, real consequences.
      </p>
      ${blockedEmail ? `
        <div class="card pad" style="margin-top:24px;text-align:left;max-width:340px">
          <label class="lbl" for="code">Join code</label>
          <input id="code" type="text" autocapitalize="off" autocomplete="off" spellcheck="false"
                 placeholder="from the group chat">
          <button class="btn primary full" id="join" style="margin-top:10px">Join</button>
          <p class="xs faint" style="margin-top:10px">
            Signed in as ${esc(blockedEmail)}. You need the code to play.</p>
          <p class="xs err" id="jerr" style="margin-top:6px"></p>
          <button class="btn sm" style="margin-top:10px" id="out">Use another account</button>
        </div>` : `
        <button class="gbtn" style="margin-top:24px" id="in">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.6 5-4 7l7 5c4-4 6-9.6 6-16z"/>
            <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7-5.4C29.6 36.6 27 37.4 24 37.4c-5.8 0-10.7-3.8-12.5-9l-7.3 5.6C7.9 41.2 15.3 46 24 46z"/>
            <path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.3-5.7C2.8 16.9 2 20.4 2 24s.8 7.1 2.2 10.1l7.3-5.7z"/>
            <path fill="#EA4335" d="M24 10.6c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.3 2 7.9 6.8 4.2 13.9l7.3 5.7c1.8-5.2 6.7-9 12.5-9z"/>
          </svg>Continue with Google
        </button>
        <p class="xs faint" style="margin-top:14px">Invite only. You choose your own stake, and top up whenever your judgement fails you.</p>`}
    </section>`;
  view.querySelector("#in")?.addEventListener("click", async () => {
    const provider = new GoogleAuthProvider();
    // In-app browsers cannot host a popup, and Google refuses OAuth in some of
    // them outright, so go straight to a full-page redirect there.
    if (embeddedBrowser()) return signInWithRedirect(auth, provider);
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      const code = e.code || "";
      if (/popup|cancelled|blocked|operation-not-supported|web-storage/.test(code)) {
        reportError("signin.popup-fallback", e);
        return signInWithRedirect(auth, provider);
      }
      reportError("signin.popup", e);
      toast(code || "sign in failed", true);
    }
  });
  view.querySelector("#out")?.addEventListener("click", () => signOut(auth));

  const code = view.querySelector("#code");
  const join = view.querySelector("#join");
  if (code) {
    const fromLink = new URLSearchParams(location.hash.replace(/^#/, "")).get("join");
    if (fromLink) code.value = fromLink;
    const submit = async () => {
      join.disabled = true;
      try {
        await api("/join", { code: code.value });
        location.hash = "#/";
        await loadMe();
        start();
      } catch (e) {
        view.querySelector("#jerr").textContent = e.message;
        join.disabled = false;
      }
    };
    join.addEventListener("click", submit);
    code.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    if (fromLink) submit();          // the link carries the code, so do not make them click
  }
}

// ---------------------------------------------------------------- push
// Plain Web Push with a VAPID key. iOS is the catch: Safari only allows push once
// the site is installed to the Home Screen, so on iPhone we say that instead of
// offering a button that cannot work.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = window.matchMedia("(display-mode: standalone)").matches ||
  window.navigator.standalone === true;

// WhatsApp, Instagram, Facebook and friends. Their UA strings differ wildly, so
// this looks for what they have in common and falls back to redirect either way.
function embeddedBrowser() {
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|Instagram|Line\/|Twitter|MicroMessenger|WhatsApp/i.test(ua)) return true;
  if (/\bwv\b/.test(ua)) return true;                       // Android WebView
  // iOS in-app browsers are Safari-shaped but omit the Safari token.
  return isIOS && /AppleWebKit/.test(ua) && !/Safari|CriOS|FxiOS/.test(ua);
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window &&
    typeof Notification !== "undefined";
}

function keyToBytes(b64) {
  const s = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function swRegistration() {
  // register() resolves before the worker is active, and subscribing on an
  // inactive registration throws, so wait for ready.
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  return reg;
}

async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (isIOS && !installed) return "needs-install";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    return sub ? "on" : "off";
  } catch (_) { return "off"; }
}

async function enablePush() {
  if (!me.vapid_public) return toast("Push is not configured", true);
  const perm = await Notification.requestPermission();   // must follow a click
  if (perm !== "granted") return toast("You blocked notifications", true);
  const reg = await swRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // A subscription made with a different server key can never be delivered to,
    // so drop it and make a new one rather than storing something useless.
    const old = sub.options?.applicationServerKey;
    const want = keyToBytes(me.vapid_public);
    const same = old && new Uint8Array(old).length === want.length &&
      new Uint8Array(old).every((v, i) => v === want[i]);
    if (!same) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(me.vapid_public),
    });
  }
  await api("/push/subscribe", { subscription: sub.toJSON() });
  toast("Notifications on");
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return;
  // Tell the server first: after unsubscribe() the endpoint is gone locally.
  try { await api("/push/unsubscribe", { subscription: sub.toJSON() }); } catch (_) {}
  await sub.unsubscribe();
  toast("Notifications off");
}

async function pushCard() {
  const state = await pushState();
  const line = {
    on: "You get a notification for new markets, and for trades and comments on markets you hold.",
    off: "Get told when a new market opens, or when someone trades or comments on one you hold.",
    denied: "Notifications are blocked for this site. Turn them back on in your browser settings.",
    "needs-install": "On iPhone, Safari only allows notifications after you install the app: Share, then Add to Home Screen. Open it from there and this button appears.",
    unsupported: "This browser cannot do web push.",
  }[state];
  return `<div class="card pad" style="margin-bottom:12px">
    <div class="rowb"><span class="lbl" style="margin:0">Notifications</span>
      ${state === "on" ? '<span class="tag live"><i class="dot"></i>On</span>' : ""}</div>
    <p class="sm muted" style="margin-top:10px">${line}</p>
    ${state === "off" ? '<button class="btn primary full" id="pushon" style="margin-top:12px">Turn on notifications</button>' : ""}
    ${state === "on" ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
        <button class="btn" id="pushtest">Send a test</button>
        <button class="btn" id="pushoff">Turn off</button></div>` : ""}
  </div>`;
}

function wirePush(root, after) {
  root.querySelector("#pushon")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { await enablePush(); } catch (err) { toast(err.message || "could not subscribe", true); }
    e.target.disabled = false;
    after?.();
  });
  root.querySelector("#pushoff")?.addEventListener("click", async () => {
    try { await disablePush(); } catch (_) {}
    after?.();
  });
  root.querySelector("#pushtest")?.addEventListener("click", async () => {
    try { await api("/push/test", {}); toast("Sent"); } catch (e) { toast(e.message, true); }
  });
}

// ---------------------------------------------------------------- money in
const STAKES = [500, 1000, 2500, 5000];

let topUpNonce = null;

async function topUp(amount, btn) {
  if (!(amount > 0)) return toast("Pick an amount", true);
  if (btn) btn.disabled = true;
  topUpNonce = topUpNonce || crypto.randomUUID();
  try {
    await api("/topup", { amount, nonce: topUpNonce });
    topUpNonce = null;
    await loadMe();
    toast("Added " + money(amount));
    location.hash = "#/";
    render();
  } catch (e) { toast(e.message, true); if (btn) btn.disabled = false; }
}

function stakeForm(first) {
  return `<div class="field"><span class="lbl">${first ? "Pick your stake" : "How much"}</span>
      <div class="quick" style="margin-top:0">${STAKES.map((v) =>
        `<button data-stake="${v}">${v >= 1000 ? v / 1000 + "k" : v}</button>`).join("")}</div>
      <input id="stake" class="amount" type="number" min="1" step="100" value="1000"
             inputmode="numeric" style="margin-top:8px">
      <button class="btn primary full" id="add" style="margin-top:10px">
        ${first ? "Start playing" : "Top up"}</button>
      <p class="xs faint" style="margin-top:10px">
        Top up whenever you like. Every top-up is public in the ledger, and your
        score is cash plus positions minus everything you put in.</p>
    </div>`;
}

function wireStake(root) {
  root.querySelectorAll("[data-stake]").forEach((b) => b.addEventListener("click", () => {
    root.querySelector("#stake").value = b.dataset.stake;
  }));
  root.querySelector("#add").addEventListener("click", (e) =>
    topUp(Number(root.querySelector("#stake").value), e.target));
}

function firstStake() {
  view.innerHTML = `
    <section class="screen">
      <div class="phead"><div><h1>Buy in</h1>
        <p>You start with nothing. Choose what your judgement is worth.</p></div></div>
      <div class="card pad" style="max-width:420px">${stakeForm(true)}</div>
    </section>`;
  wireStake(view);
}

// ---------------------------------------------------------------- feed
const statusTag = (m) =>
  m.status === "open" && m.close_at && new Date(m.close_at) - Date.now() < 6 * 3600e3
    ? `<span class="tag soon"><i class="dot"></i>Closes ${until(m.close_at)}</span>`
    : m.status === "open" ? '<span class="tag live"><i class="dot"></i>Open</span>'
    : m.status === "closed" ? '<span class="tag"><i class="dot"></i>Closed</span>'
    : m.status === "void" ? '<span class="tag"><i class="dot"></i>Void</span>'
    : `<span class="tag done"><i class="dot"></i>Resolved ${esc((m.outcome || "").toUpperCase())}</span>`;

function marketCard(m) {
  const settled = m.status === "resolved" || m.status === "void";
  const pos = m.position;
  const held = pos && (pos.yes > 0.5 || pos.no > 0.5)
    ? `<span class="tag mine n">${Math.round(pos.yes > pos.no ? pos.yes : pos.no)} ${pos.yes > pos.no ? "YES" : "NO"}</span>` : "";
  return `<a class="card mcard${settled ? " settled" : ""}" href="#/m/${m.id}">
    <div class="top">
      <h3>${esc(m.question)}</h3>
      <div class="pc"><b class="big">${settled && m.outcome ? esc(m.outcome.toUpperCase()) : pct(m.prob)}</b></div>
    </div>
    <div class="track${m.prob < 0.5 ? " neg" : ""}${settled ? " dim" : ""}"><i style="width:${Math.round(m.prob * 100)}%"></i></div>
    <div class="meta xs">${statusTag(m)}${held}
      <span class="faint n">${money(m.volume)} traded${m.comments ? ` &middot; ${m.comments} comments` : ""}</span>
    </div>
  </a>`;
}

async function feed(poll) {
  const ms = await api("/markets");
  const sig = JSON.stringify(ms);
  if (poll && seen.feed === sig) return;
  seen.feed = sig;
  const open = ms.filter((m) => m.status === "open");
  const vol = ms.reduce((a, m) => a + m.volume, 0);
  view.innerHTML = `
    <section class="screen">
      <div class="phead">
        <div><h1>Follymarket</h1>
          <p class="n">${open.length} open &middot; ${money(vol)} traded</p></div>
        <div class="act"><a class="btn primary" href="#/new" style="text-decoration:none">New market</a></div>
      </div>
      ${(await pushState()) === "off" && !localStorage.getItem("nopush")
        ? `<div class="card pad" style="margin-bottom:12px">
             <div class="rowb"><span class="sm">Get notified when a market moves?</span></div>
             <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
               <button class="btn primary" id="pushon">Yes, notify me</button>
               <button class="btn" id="pushlater">Not now</button></div>
           </div>` : ""}
      <div class="stack">${ms.length ? ms.map(marketCard).join("") :
        '<div class="empty">No markets yet. Ask the first stupid question.</div>'}</div>
    </section>`;
  wirePush(view, () => { seen.feed = null; feed(); });
  view.querySelector("#pushlater")?.addEventListener("click", () => {
    localStorage.setItem("nopush", "1");
    seen.feed = null;
    feed();
  });
}

// ---------------------------------------------------------------- detail
function chart(series) {
  if (series.length < 2) return '<p class="xs faint" style="margin-top:14px">The chart starts after the first trade.</p>';
  const pts = series.map((s, i) => [
    (i / (series.length - 1)) * 620,
    172 - Math.max(0, Math.min(1, s.prob)) * 156,
  ]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const rising = series.at(-1).prob >= series[0].prob;
  const col = rising ? "#2ee6a8" : "#ff5f70";
  return `<svg class="chart" viewBox="0 0 620 188" preserveAspectRatio="none" role="img"
      aria-label="probability from ${pct(series[0].prob)} to ${pct(series.at(-1).prob)}">
    <g stroke="#1c1c22" stroke-width="1" shape-rendering="crispEdges">
      <line x1="0" y1="16" x2="620" y2="16"/><line x1="0" y1="59" x2="620" y2="59"/>
      <line x1="0" y1="102" x2="620" y2="102"/><line x1="0" y1="145" x2="620" y2="145"/>
    </g>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${pts.at(-1)[0].toFixed(1)}" cy="${pts.at(-1)[1].toFixed(1)}" r="3.5" fill="${col}"/>
  </svg>`;
}

let side = "yes";

async function detail(id, poll) {
  const m = await api("/markets/" + id);
  const sig = JSON.stringify(m);
  if (poll && seen.mkt === sig) return;
  seen.mkt = sig;
  // Keep what the user was doing across a genuine update.
  const keepAmt = view.querySelector("#amt")?.value;
  const keepFocus = document.activeElement?.id;
  const open = m.status === "open";
  const mayResolve = m.resolver === me.uid || me.role === "admin";
  const p = m.prob, pos = m.position;
  const delta = m.series.length > 1 ? p - m.series[0].prob : 0;

  view.innerHTML = `
    <section class="screen">
      <div class="split">
        <div class="stack" style="gap:12px">
          <div class="card pad qhead">
            <div class="meta xs" style="margin:0 0 11px">${statusTag(m)}
              <span class="tag">${m.close_mode === "manual" ? "Manual close" : "Timed close"}</span></div>
            <h1>${esc(m.question)}</h1>
            ${m.criteria ? `<p class="sm muted" style="margin-top:9px">${esc(m.criteria)}</p>` : ""}
            <p class="xs faint" style="margin-top:9px">${esc(m.creator_name)} created this</p>
            <div class="probrow"><b class="big">${pct(p)}</b>
              ${delta ? `<span class="d n ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : ""}${Math.round(delta * 100)} since open</span>` : ""}
            </div>
            <p class="xs faint n" style="margin-top:4px">${money(m.volume)} traded &middot; ${m.holders.length} holders &middot; ${m.trades} trades</p>
            ${chart(m.series)}
            ${m.outcome ? `<p class="sm" style="margin-top:14px">Resolved <b>${esc(m.outcome.toUpperCase())}</b> by ${esc(m.resolved_by_name)}.
              ${m.resolution_note ? `<span class="muted">"${esc(m.resolution_note)}"</span>` : ""}</p>` : ""}
          </div>

          <div class="card pad">
            <span class="lbl">Recent trades</span>
            ${m.recent.length ? `<table><tbody>${m.recent.map((t) => `
              <tr><td><span class="who"><i class="pip">${esc((t.user_name || "?")[0].toUpperCase())}</i>${esc(t.user_name)}</span></td>
                  <td class="${t.side === "yes" ? "up" : "down"}" style="font-weight:560">${t.side.toUpperCase()}</td>
                  <td class="n">${money(t.amount)}</td>
                  <td class="n muted hide-s">${Math.round(t.prob_before * 100)} &rarr; ${Math.round(t.prob_after * 100)}</td>
                  <td class="faint">${ago(t.at)}</td></tr>`).join("")}</tbody></table>`
              : '<p class="sm faint">Nobody has traded yet.</p>'}
          </div>

          <div class="card pad">
            <span class="lbl">Comments</span>
            ${m.comment_list.map((c) => `<div class="cmt">
              <div class="sm"><b style="font-weight:560">${esc(c.user_name)}</b>
                <span class="xs faint">${ago(c.at)}</span></div>
              <div class="sm muted">${esc(c.body)}</div></div>`).join("")}
            <div style="display:flex;gap:8px;margin-top:12px">
              <input type="text" id="cbody" placeholder="Say something" maxlength="1000">
              <button class="btn" id="csend">Post</button>
            </div>
          </div>
        </div>

        <aside class="side">
          ${open ? `<div class="card pad">
            <div class="sides">
              <button class="y${side === "yes" ? " on" : ""}" data-side="yes"><strong>YES</strong><small>${price(p)}</small></button>
              <button class="n${side === "no" ? " on" : ""}" data-side="no"><strong>NO</strong><small>${price(1 - p)}</small></button>
            </div>
            <div style="margin-top:14px">
              <label class="lbl" for="amt">You spend</label>
              <input id="amt" class="amount" type="number" min="1" step="1" value="100" inputmode="numeric">
              <div class="quick">${[25, 50, 100, 200].map((v) => `<button data-amt="${v}">${v}</button>`).join("")}
                <button data-amt="max">Max</button></div>
            </div>
            <div class="hr"></div>
            <dl class="kv" id="prev"><dt>Shares</dt><dd>-</dd></dl>
            <button class="btn primary full" id="buy" style="margin-top:14px">Buy ${side.toUpperCase()}</button>
            <p class="xs faint" style="margin-top:10px" id="note"></p>
          </div>` : `<div class="card pad"><p class="sm muted">Trading is ${esc(m.status)}.</p></div>`}

          ${pos && (pos.yes > 0.5 || pos.no > 0.5) ? `<div class="card pad">
            <div class="rowb"><span class="lbl" style="margin:0">Your position</span>
              <span class="tag mine">${pos.yes > pos.no ? "YES" : "NO"}</span></div>
            <dl class="kv" style="margin-top:12px">
              <dt>Shares</dt><dd>${Math.round(Math.max(pos.yes, pos.no))}</dd>
              <dt>Spent</dt><dd>${money(pos.spent)}</dd>
              <dt>Value now</dt><dd>${money(pos.yes * p + pos.no * (1 - p))}</dd>
              <dt>Payout if right</dt><dd>${money(Math.max(pos.yes, pos.no))}</dd>
            </dl></div>` : ""}

          ${mayResolve && m.status !== "resolved" && m.status !== "void" ? `<div class="card pad">
            <span class="lbl">Resolver</span>
            <div style="display:grid;gap:8px">
              ${open ? '<button class="btn" id="close">Close trading</button>' : ""}
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <button class="btn" data-res="yes">Resolve YES</button>
                <button class="btn" data-res="no">Resolve NO</button>
              </div>
              <button class="btn" data-res="void">Void and refund</button>
              ${me.role === "admin" && !m.trades ? '<button class="btn" id="del">Delete market</button>' : ""}
            </div>
            <p class="xs faint" style="margin-top:10px">Every action is logged with your name.
              ${me.role === "admin" ? (m.trades
                ? "Traded markets cannot be deleted, only voided, which refunds everyone."
                : "Nobody has traded yet, so this one can still be deleted outright.") : ""}</p>
          </div>` : ""}
        </aside>
      </div>
    </section>`;

  // ---- trade panel wiring
  const amt = view.querySelector("#amt");
  if (amt && keepAmt) amt.value = keepAmt;
  if (keepFocus) document.getElementById(keepFocus)?.focus();
  const prev = view.querySelector("#prev");
  const note = view.querySelector("#note");
  const buy = view.querySelector("#buy");

  async function refreshPreview() {
    if (!amt) return;
    const amount = Number(amt.value);
    if (!(amount > 0)) { prev.innerHTML = "<dt>Shares</dt><dd>-</dd>"; return; }
    try {
      const q = await api("/trades/preview", { market: id, side, amount });
      prev.innerHTML = `
        <dt>Shares</dt><dd>${Math.round(q.shares)}</dd>
        <dt>Average price</dt><dd>${price(q.avg_price)}</dd>
        <dt>Probability</dt><dd>${Math.round(q.prob_before * 100)} &rarr;
          <span class="${side === "yes" ? "up" : "down"}">${pct(q.prob_after)}</span></dd>
        <dt>Payout if right</dt><dd class="hero ${side === "yes" ? "up" : "down"}">${money(q.payout)}</dd>
        <dt>Max loss</dt><dd class="hero">${money(q.max_loss)}</dd>`;
      note.innerHTML = q.affordable
        ? `Moves the market ${Math.abs(Math.round((q.prob_after - q.prob_before) * 100))} points. Cash left ${money(q.cash_after)}.`
        : '<span class="err">You cannot afford this.</span>';
      buy.disabled = !q.affordable;
      buy.style.opacity = q.affordable ? "1" : ".5";
    } catch (e) { note.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  }

  view.querySelectorAll("[data-side]").forEach((b) => b.addEventListener("click", () => {
    side = b.dataset.side;
    view.querySelectorAll("[data-side]").forEach((x) => x.classList.toggle("on", x === b));
    buy.textContent = "Buy " + side.toUpperCase();
    refreshPreview();
  }));
  view.querySelectorAll("[data-amt]").forEach((b) => b.addEventListener("click", () => {
    amt.value = b.dataset.amt === "max" ? Math.floor(me.cash) : b.dataset.amt;
    refreshPreview();
  }));
  amt?.addEventListener("input", debounce(refreshPreview, 250));
  refreshPreview();

  // Kept across failures on purpose: retrying a trade whose response was lost
  // must reuse the id, or the server records it twice.
  let tradeNonce = null;
  buy?.addEventListener("click", async () => {
    buy.disabled = true;
    tradeNonce = tradeNonce || crypto.randomUUID();
    try {
      await api("/trades", { market: id, side, amount: Number(amt.value), nonce: tradeNonce });
      tradeNonce = null;
      await loadMe();
      toast("Bought " + side.toUpperCase());
      render();
    } catch (e) { toast(e.message, true); buy.disabled = false; }
  });

  view.querySelector("#csend")?.addEventListener("click", async () => {
    const body = view.querySelector("#cbody").value.trim();
    if (!body) return;
    try { await api(`/markets/${id}/comments`, { body }); render(); }
    catch (e) { toast(e.message, true); }
  });

  view.querySelector("#close")?.addEventListener("click", async () => {
    try { await api(`/markets/${id}/close`, {}); toast("Trading closed"); render(); }
    catch (e) { toast(e.message, true); }
  });

  view.querySelector("#del")?.addEventListener("click", async () => {
    if (!confirm("Delete this market for good? Only possible because nobody has traded it.")) return;
    try {
      await api("/markets/" + id, null, "DELETE");
      toast("Market deleted");
      location.hash = "#/";
    } catch (e) { toast(e.message, true); }
  });

  view.querySelectorAll("[data-res]").forEach((b) => b.addEventListener("click", async () => {
    const outcome = b.dataset.res;
    const note = prompt(`Resolve ${outcome.toUpperCase()}. Add a short note:`, "");
    if (note === null) return;
    try {
      const r = await api(`/markets/${id}/resolve`, { outcome, note });
      await loadMe();
      toast(`Resolved ${outcome.toUpperCase()}, ${money(r.paid_out)} paid out`);
      render();
    } catch (e) { toast(e.message, true); }
  }));
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------- create
function create() {
  view.innerHTML = `
    <section class="screen">
      <div class="phead"><div><h1>New market</h1>
        <p>Ask something the group can actually settle.</p></div></div>
      <div class="split">
        <div class="card pad stack" style="gap:16px">
          <div class="field"><label class="lbl" for="q">Question</label>
            <input id="q" type="text" maxlength="200" placeholder="Nihal gets too drunk before 9pm on night one"></div>
          <div class="field"><label class="lbl" for="c">How it resolves</label>
            <textarea id="c" maxlength="1000" placeholder="Resolves YES if two or more people agree."></textarea></div>
          <div class="two">
            <div class="field"><label class="lbl" for="cat">Category</label>
              <select id="cat"><option>Chaos</option><option>Logistics</option><option>Money</option><option>Romance</option></select></div>
            <div class="field"><label class="lbl" for="p0">Starting probability</label>
              <input id="p0" type="number" value="50" min="2" max="98"></div>
          </div>
          <p class="xs faint" style="margin-top:-6px">Prices swing hard here. One ₹100 YES buy takes a 50% market to about 70%.</p>
          <div class="field"><span class="lbl">Trading closes</span>
            <div class="seg">
              <label><input type="radio" name="cm" value="manual" checked hidden><strong>When I close it</strong><small>Manual</small></label>
              <label><input type="radio" name="cm" value="datetime" hidden><strong>At a set time</strong><small>Automatic</small></label>
            </div>
            <div class="closeat" id="ca" style="display:none"><label class="lbl" for="cat2">Closes at</label>
              <input id="cat2" type="datetime-local"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <a class="btn" href="#/" style="text-decoration:none">Cancel</a>
            <button class="btn primary" id="go">Create market</button>
          </div>
          <p class="xs faint" id="cerr"></p>
        </div>
      </div>
    </section>`;

  const segs = view.querySelectorAll(".seg label");
  segs.forEach((l) => l.addEventListener("click", () => {
    setTimeout(() => {
      segs.forEach((x) => x.style.cssText = x.querySelector("input").checked
        ? "border-color:var(--ink);background:var(--s2)" : "");
      view.querySelector("#ca").style.display =
        view.querySelector('[name="cm"]:checked').value === "datetime" ? "block" : "none";
    }, 0);
  }));
  segs[0].style.cssText = "border-color:var(--ink);background:var(--s2)";

  view.querySelector("#go").addEventListener("click", async (e) => {
    const mode = view.querySelector('[name="cm"]:checked').value;
    const body = {
      question: view.querySelector("#q").value.trim(),
      criteria: view.querySelector("#c").value.trim(),
      category: view.querySelector("#cat").value,
      initial_prob: Number(view.querySelector("#p0").value) / 100,
      close_mode: mode,
      close_at: mode === "datetime" && view.querySelector("#cat2").value
        ? new Date(view.querySelector("#cat2").value).toISOString() : null,
    };
    if (body.question.length < 4) { view.querySelector("#cerr").innerHTML = '<span class="err">Write a question first.</span>'; return; }
    e.target.disabled = true;
    try { const r = await api("/markets", body); location.hash = "#/m/" + r.id; }
    catch (err) { view.querySelector("#cerr").innerHTML = `<span class="err">${esc(err.message)}</span>`; e.target.disabled = false; }
  });
}

// ---------------------------------------------------------------- portfolio
async function portfolio() {
  const d = await api("/portfolio");
  view.innerHTML = `
    <section class="screen">
      <div class="phead"><div><h1>Portfolio</h1><p>Fake money. Real reputation.</p></div>
        ${me.role === "admin" ? '<div class="act"><button class="btn sm" id="csv">Export ledger CSV</button></div>' : ""}</div>
      <div class="stats">
        <div class="card pad stat"><span class="lbl" style="margin:0">Cash</span><b class="big">${money(d.cash)}</b></div>
        <div class="card pad stat"><span class="lbl" style="margin:0">Positions</span><b class="big">${money(d.position_value)}</b></div>
        <div class="card pad stat"><span class="lbl" style="margin:0">Net</span>
          <b class="big ${d.net >= 0 ? "up" : "down"}">${signed(d.net)}</b></div>
        <div class="card pad stat"><span class="lbl" style="margin:0">Put in</span><b class="big">${money(d.deposited)}</b></div>
      </div>
      <div class="card pad" style="margin-bottom:12px">${stakeForm(false)}</div>
      <div class="card pad" style="margin-bottom:12px">
        <span class="lbl">Open positions</span>
        ${d.positions.length ? `<table><tbody>${d.positions.map((p) => {
          const shares = Math.max(p.yes, p.no), pl = p.value - p.spent;
          return `<tr><td><div>${esc(p.question)}</div>
            <div class="xs faint n">${Math.round(shares)} ${p.yes > p.no ? "YES" : "NO"} &middot; spent ${money(p.spent)}</div></td>
            <td><div class="n">${money(p.value)}</div>
            <div class="xs n ${pl >= 0 ? "up" : "down"}">${signed(pl)}</div></td></tr>`;
        }).join("")}</tbody></table>` : '<p class="sm faint">No open positions.</p>'}
      </div>
      ${await pushCard()}
      ${me.join_code ? `<div class="card pad" style="margin-bottom:12px">
        <span class="lbl">Invite link</span>
        <input type="text" readonly id="invite"
               value="${location.origin}/#join=${encodeURIComponent(me.join_code)}">
        <p class="xs faint" style="margin-top:8px">Anyone with this link and a Google account can play.
          Tap to copy, then drop it in the group chat.</p>
      </div>` : ""}
      <div class="card pad"><span class="lbl">Ledger</span>
        <table><tbody>${d.ledger.map((x) => `<tr><td>${esc(x.description)}</td>
          <td class="n ${x.amount >= 0 ? "up" : "down"}">${signed(x.amount)}</td></tr>`).join("")}</tbody></table>
      </div>
    </section>`;
  wireStake(view);
  wirePush(view, () => portfolio());
  view.querySelector("#invite")?.addEventListener("click", (e) => {
    e.target.select();
    navigator.clipboard?.writeText(e.target.value).then(() => toast("Link copied"), () => {});
  });
  view.querySelector("#csv")?.addEventListener("click", async () => {
    const csv = await api("/ledger.csv");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: "follymarket-ledger.csv" }).click();
  });
}

// ---------------------------------------------------------------- router
async function loadMe() {
  me = await api("/me");
  document.getElementById("cash").innerHTML = "₹<b>" + Math.round(me.cash).toLocaleString("en-IN") + "</b>";
}

async function render() {
  const hash = location.hash.replace(/^#/, "") || "/";
  document.querySelectorAll("[data-tab]").forEach((a) =>
    a.classList.toggle("on", a.dataset.tab === hash));
  clearInterval(timer);
  // Nobody gets a feed before they have skin in the game.
  if (!me.deposited) return firstStake();
  try {
    if (hash.startsWith("/m/")) { seen.mkt = null; await detail(hash.slice(3)); timer = setInterval(() => {
      if (!document.hidden && location.hash.slice(1) === hash) detail(hash.slice(3), true).catch(() => {});
    }, 8000); }
    else if (hash === "/new") create();
    else if (hash === "/portfolio") await portfolio();
    else { seen.feed = null; await feed(); timer = setInterval(() => {
      if (!document.hidden && (location.hash.slice(1) || "/") === "/") feed(true).catch(() => {});
    }, 8000); }
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

window.addEventListener("hashchange", render);
// The avatar is the only account control, so it must not sign you out by
// accident. ponytail: native confirm, not a dropdown nobody asked for.
document.getElementById("signout").addEventListener("click", () => {
  if (confirm("Sign out of Follymarket?")) signOut(auth);
});

// Shared by first sign-in and by joining with a code, so both land in one place.
function start() {
  // Registering early is harmless and does not prompt: the permission dialog
  // only appears on the button click.
  if (pushSupported()) navigator.serviceWorker.register("/sw.js").catch(() => {});
  chrome.hidden = tabs.hidden = false;
  document.body.style.paddingBottom = "";
  const pic = document.getElementById("signout");
  // The URL comes from Google's token. Quote it so a stray character cannot end
  // the url() and inject more CSS.
  if (me.picture) pic.style.cssText += `background-image:url("${me.picture}");background-size:cover`;
  render();
}

getRedirectResult(auth).catch((e) => {
  reportError("signin.redirect", e);
  toast(e.code || "sign in failed", true);
});

onAuthStateChanged(auth, async (user) => {
  clearInterval(timer);
  if (!user) { me = null; renderLogin(null); return; }
  try {
    await loadMe();
  } catch (e) {
    renderLogin(user.email || "your account");
    return;
  }
  if (me.status !== "allowed") { renderLogin(me.email); return; }
  start();
});
