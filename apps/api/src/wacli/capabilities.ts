import { checkWacliInstalled } from './commands.js';
import { parseVersion } from './update-check.js';

/**
 * The first wacli release that has each flag the console uses when it can.
 *
 * Asked of the version rather than learned by trying: an older wacli refuses an
 * unknown flag, but the commands these belong to are ones the operator is
 * waiting on, and a refusal first costs them a spawn and a retry.
 */
const SINCE = {
  /** `chats mark-read --through-message-id`. */
  readBoundary: [0, 22, 0],
  /** `media download --retry-on-phone`. */
  phoneMediaRecovery: [0, 22, 0],
} as const satisfies Record<string, readonly [number, number, number]>;

export type WacliCapability = keyof typeof SINCE;

/** Whether `version` (as `wacli --version` prints it) is at least `since`. */
export function versionAtLeast(
  version: string | null,
  since: readonly [number, number, number]
): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== since[i]) return parsed[i] > since[i];
  }
  return true;
}

/**
 * Whether the installed wacli has `capability`. A version that cannot be read
 * — a source build, a missing binary — has none of them, and the console does
 * what it did before they existed.
 *
 * The version is the one health already caches, so asking costs no spawn.
 */
export async function wacliSupports(capability: WacliCapability): Promise<boolean> {
  const installed = await checkWacliInstalled();
  return installed.installed && versionAtLeast(installed.version, SINCE[capability]);
}
