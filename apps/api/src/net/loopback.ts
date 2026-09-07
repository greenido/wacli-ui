/**
 * Who is allowed to talk to this console.
 *
 * Mission Control binds loopback and holds a live WhatsApp session, so "the
 * request came from this machine" is the whole of its access control. These
 * two predicates are that rule, kept in their own module because both the REST
 * layer and the WebSocket upgrade need them — and the upgrade lives below the
 * server that used to own them.
 */

/**
 * Whether a `Host` header names this machine.
 *
 * A hostname that resolves to 127.0.0.1 is still somebody else's name: DNS
 * rebinding arrives at a loopback socket carrying the attacker's Host. Reading
 * the header rather than the socket is what notices that.
 */
export function isLoopbackHost(hostHeader?: string): boolean {
  if (!hostHeader) return false;
  try {
    const rawHost = hostHeader.startsWith('[')
      ? hostHeader.slice(1, hostHeader.indexOf(']'))
      : hostHeader.split(':')[0];
    const h = (rawHost ?? '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

/** Whether an `Origin` header names a page served from this machine. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const h = url.hostname;
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]')
    );
  } catch {
    return false;
  }
}

/**
 * Whether a WebSocket upgrade may proceed.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it, and reads the reply, whatever page asked for it. So the CORS rules
 * that guard `/api` do not reach `/ws` at all, and any page the operator had
 * open could connect here and read the live feed — every incoming message body,
 * sender and receipt — with nothing on screen to say so.
 *
 * Browsers always send `Origin` on a handshake, so checking it is what closes
 * that door. An absent `Origin` is a non-browser client — curl, a test, a
 * native app — which is the same client the REST layer's CORS callback lets
 * through, and which no web page can impersonate.
 */
export function isAllowedUpgrade(origin?: string, hostHeader?: string): boolean {
  if (origin && !isLoopbackOrigin(origin)) return false;
  if (hostHeader && !isLoopbackHost(hostHeader)) return false;
  return true;
}
