export type LoginPageState = "interactive" | "complete" | "external";

/** Auth/checkpoint redirects change frequently. Keep the window usable on any
 * HTTPS LinkedIn page, and only finish on a known signed-in destination. */
export function loginPageState(value: string): LoginPageState {
  let url: URL;
  try { url = new URL(value); } catch { return "external"; }
  if (url.protocol !== "https:" || url.username || url.password ||
    !(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))) return "external";
  if (/^\/(?:feed(?:\/|$)|in\/|sales\/(?:home|search|lead|account)(?:\/|$))/i.test(url.pathname)) return "complete";
  return "interactive";
}
