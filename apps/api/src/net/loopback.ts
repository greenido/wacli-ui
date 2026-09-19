import fs from 'node:fs';
import path from 'node:path';

/**
 * Who is allowed to talk to this console.
 *
 * Mission Control binds loopback, holds a live WhatsApp session and
 * authenticates nothing, so "a page this app served, on this machine" is the
 * whole of its access control. Both the REST layer and the WebSocket upgrade
 * apply these rules, so they live here rather than in either.
 *
 * "On this machine" used to be the rule on its own: any loopback origin, on any
 * port. That trusted every other local app as well — a dev server, a notebook,
 * the MAMP site next door — and any of them running one bad script could read
 * the WhatsApp session keys through the media route. So a page is trusted only
 * on a port this app serves it from.
 */

/** The address the server binds, and the only one a trusted name may point at. */
const BIND_ADDRESS = '127.0.0.1';

/**
 * Ports the Vite dev server and preview listen on (apps/web/vite.config.ts,
 * where `strictPort` keeps them from drifting). Their pages proxy /api and /ws
 * here and arrive carrying their own Origin. Trusted only when the API runs
 * under `npm run dev`, which passes `--dev-ui`: anywhere else a page on these
 * ports is just some other local app.
 */
export const DEV_UI_PORTS = [5174, 4174] as const;

export interface AccessPolicy {
  /** Lower-case names a request's Host header may carry. */
  readonly hostnames: ReadonlySet<string>;
  /** Ports a trusted page may be served from. */
  readonly ports: ReadonlySet<number>;
}

/**
 * Names the hosts file points at this server's address, such as `wacli-ui`
 * from a `127.0.0.1 wacli-ui` line.
 *
 * Only this machine answers for a name mapped there, so it is as safe as
 * `localhost`. The same name without that line goes out to DNS, search domains
 * included, where a hostile resolver could rebind it to this port. So the hosts
 * file decides which extra names count, not a list in code.
 *
 * Other loopback addresses do not count: this server does not listen on
 * `127.0.0.2` or `::1`, so a page under a name mapped there was served by
 * something else.
 */
export function namesMappedToBindAddress(hostsFile: string): string[] {
  const names: string[] = [];
  for (const line of hostsFile.split(/\r?\n/)) {
    const [address, ...aliases] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (address === BIND_ADDRESS) {
      names.push(...aliases.map((name) => name.toLowerCase()));
    }
  }
  return names;
}

function readHostsFile(): string {
  const hostsPath =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
      : '/etc/hosts';
  try {
    return fs.readFileSync(hostsPath, 'utf8');
  } catch {
    return '';
  }
}

export function accessPolicy(options: {
  port: number;
  /** Also trust the Vite dev server and preview. */
  devUi?: boolean;
  /** The hosts file's contents; read from disk when omitted. */
  hostsFile?: string;
}): AccessPolicy {
  return {
    hostnames: new Set([
      'localhost',
      BIND_ADDRESS,
      ...namesMappedToBindAddress(options.hostsFile ?? readHostsFile()),
    ]),
    ports: new Set([options.port, ...(options.devUi ? DEV_UI_PORTS : [])]),
  };
}

/**
 * Whether a `Host` header names this machine.
 *
 * A hostname that resolves to 127.0.0.1 is still somebody else's name: DNS
 * rebinding arrives at a loopback socket carrying the attacker's Host. Reading
 * the header rather than the socket is what notices that. The port is not
 * checked, because the Vite proxy forwards with its own.
 */
export function isAllowedHost(hostHeader: string | undefined, policy: AccessPolicy): boolean {
  if (!hostHeader) return false;
  try {
    return policy.hostnames.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether an `Origin` header names a page this app served.
 *
 * No header at all is a client that is not a web page: curl, a test, wacli's
 * own webhook. Browsers always send one on a write and on a WebSocket
 * handshake, so a page cannot pass itself off as that. `null` (a sandboxed
 * frame, a file:// page) names nobody and is refused.
 */
export function isAllowedOrigin(origin: string | undefined, policy: AccessPolicy): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // An origin is exactly scheme://host[:port]; anything else is not one.
  if (url.protocol !== 'http:' || url.origin !== origin) return false;
  return policy.hostnames.has(url.hostname) && policy.ports.has(Number(url.port || 80));
}

/**
 * Whether a WebSocket upgrade may proceed.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it, and reads the reply, whatever page asked for it. So the CORS rules
 * that guard `/api` do not reach `/ws` at all, and without this any page could
 * connect and read the live feed — every incoming message body, sender and
 * receipt — with nothing on screen to say so.
 */
export function isAllowedUpgrade(
  origin: string | undefined,
  hostHeader: string | undefined,
  policy: AccessPolicy
): boolean {
  if (!isAllowedOrigin(origin, policy)) return false;
  if (hostHeader !== undefined && !isAllowedHost(hostHeader, policy)) return false;
  return true;
}
