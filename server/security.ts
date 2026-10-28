import type { IncomingHttpHeaders } from "node:http";
/** Check the literal authority, not the resolved IP: localhost aliases and rebinding
 * domains must not become trusted merely because they resolve to loopback. */
export function requestAllowed(
  headers: IncomingHttpHeaders,
  publicUrl?: string,
): boolean {
  const host = headers.host?.toLowerCase();
  if (!host || /[\s/@\\?#]/.test(host)) return false;
  let configured: URL | undefined;
  try {
    if (publicUrl) configured = new URL(publicUrl);
  } catch {
    return false;
  }
  if (
    !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) &&
    host !== configured?.host
  )
    return false;
  try {
    const target = new URL(`http://${host}`);
    if (target.username || target.password) return false;
    if (!headers.origin) return true; // Local CLI and OBS without an Origin header.
    const source = new URL(headers.origin);
    if (
      !["http:", "https:"].includes(source.protocol) ||
      source.origin !== headers.origin
    )
      return false;
    return source.host === target.host || source.origin === configured?.origin;
  } catch {
    return false;
  }
}
