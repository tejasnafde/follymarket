import { createAnalytics } from "./analytics-client.js";

const analytics = createAnalytics({
  product: "follymarket",
  surface: "auth",
  environment: location.hostname === "follymarket.tn07.dev" ? "production" : "development",
});

export function authSignInCompleted() {
  analytics.track("auth_sign_in_completed");
}

export function marketDetailOpened() {
  analytics.track("market_detail_opened", {}, { surface: "markets" });
}
