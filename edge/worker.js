// One origin for the whole app: static files from Workers Assets, /api/* proxied
// to Cloud Run. Same origin means no CORS to keep in sync, and no second
// hostname. Cloud Run routes by Host header, so the outbound request must carry
// the run.app host, not folly.tn07.dev (see CLAUDE.local.md, Cloud Run gotcha 5).
const API = "https://follymarket-api-974343814740.asia-south1.run.app";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Firebase's auth handler, served from OUR origin. Without this, sign-in runs
    // on teejayproject.firebaseapp.com, which means a cross-site popup: Safari's
    // tracking prevention and every in-app browser (WhatsApp, Instagram) break it,
    // and Google answered "400 malformed" inside WhatsApp. Same origin fixes both
    // and needs no third-party cookies.
    if (url.pathname.startsWith("/__/")) {
      const target = new URL(url.pathname + url.search, "https://teejayproject.firebaseapp.com");
      const upstream = new Request(target, request);
      upstream.headers.set("host", "teejayproject.firebaseapp.com");
      return fetch(upstream);
    }

    if (!url.pathname.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(request);
      // app.js and style.css have no content hash in their names, so a browser
      // that cached them keeps running the old app across deploys. Revalidation
      // is one cheap 304 for three small files; a stale app is a support call.
      const out = new Response(res.body, res);
      out.headers.set("cache-control", "no-cache");
      return out;
    }

    const target = new URL(url.pathname + url.search, API);
    const res = await fetch(new Request(target, request));

    // Rewrite any redirect back onto our hostname, or a bounce leaks run.app.
    const loc = res.headers.get("location");
    if (!loc) return res;
    const out = new Response(res.body, res);
    out.headers.set("location", loc.replace(API, url.origin));
    return out;
  },
};
