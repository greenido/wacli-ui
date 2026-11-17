import type { Request, Response, NextFunction } from 'express';

/**
 * The browser-side half of the console's defences, sent on every response.
 *
 * Everything the console renders that it did not write — a message body, a
 * contact's name, a group subject, a file name — was typed by somebody else.
 * React escapes all of it, and that has been the only line: one slip into raw
 * HTML anywhere in the app would hand a contact script running on this origin,
 * with the whole API behind it. The policy below is the second line. It allows
 * the bundle this server ships and nothing else: no inline script, no script
 * from anywhere, no plugin content, no `<base>` rewiring where the bundle loads
 * from.
 *
 * Styles are `'self'` too, which holds because Vite emits CSS as a file and
 * React applies `style={…}` through the CSSOM, which CSP does not govern. Fonts
 * are bundled for the same reason (see `apps/web/src/main.tsx`): a stylesheet
 * from Google was the one thing the page pulled from outside this machine.
 */
export function contentSecurityPolicy(hostHeader: string | undefined): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    // Media comes from /api/media/content. `blob:` and `data:` cover anything
    // the page builds for itself; neither can be pointed at another host.
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src ${connectSources(hostHeader)}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // Refusing the call is not refusing the frame: a page that frames the
    // console reads nothing through it, but the operator's own clicks land
    // inside, and one of them unlocks live sends.
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * `'self'` plus the live feed's socket, named outright.
 *
 * CSP Level 3 lets `'self'` match `ws:` on the page's own host, but Safari
 * only learned that in 15.4. The name comes from the `Host` header, which the
 * loopback check vets before any route runs; it is rebuilt through `URL` so a
 * header that is not a plain host[:port] contributes nothing to the policy.
 */
function connectSources(hostHeader: string | undefined): string {
  if (!hostHeader) return "'self'";
  try {
    const { host } = new URL(`http://${hostHeader}`);
    return host === hostHeader.toLowerCase() ? `'self' ws://${host}` : "'self'";
  } catch {
    return "'self'";
  }
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.headers.host));
  // frame-ancestors is what modern browsers honour; this is what older ones read.
  res.setHeader('X-Frame-Options', 'DENY');
  // A type is what the server said it is, never a guess from the bytes. The
  // media route set this for itself; every response deserves it.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A link opened from a message tells the site nothing about where it was
  // clicked — not this console, not the port, not the chat in the URL.
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Another site may still make a request here with an <img> or <video>, which
  // sends no Origin and so passes the origin check. This stops the browser
  // handing it the answer, or even whether there was one. `same-site`, not
  // `same-origin`: a UI built with VITE_API_URL is on another port of the
  // same host.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // A window this page opens cannot reach back into it, and one that opens
  // this page cannot either.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}
