const DEFAULT_ENDPOINT = "https://analytics.tn07.dev/v1/events";

function browserBeacon(url, body) {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }
  return navigator.sendBeacon(
    url,
    new Blob([body], { type: "application/json" }),
  );
}

function browserFetch(url, body) {
  if (typeof fetch !== "function") return;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    credentials: "omit",
  }).catch(() => {});
}

export function createAnalytics({
  product,
  surface,
  environment,
  endpoint = DEFAULT_ENDPOINT,
  sendBeacon = browserBeacon,
  sendFetch = browserFetch,
}) {
  return {
    track(event, properties = {}, options = {}) {
      if (environment !== "production") return false;
      const body = JSON.stringify({
        event,
        event_version: 1,
        product,
        surface: options.surface ?? surface,
        environment,
        authority: options.authority ?? "client",
        platform: options.platform ?? "web",
        properties,
      });
      if (!sendBeacon(endpoint, body)) sendFetch(endpoint, body);
      return true;
    },
  };
}
