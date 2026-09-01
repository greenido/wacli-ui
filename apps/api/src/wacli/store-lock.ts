export const STORE_LOCK_CODE = 'STORE_LOCKED';

export function isStoreLockMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('store is locked') || lower.includes('store locked');
}

export function parseLockHolderPid(message: string): number | null {
  const match = message.match(/\(pid=(\d+)/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : null;
}

export class StoreLockedError extends Error {
  public readonly code = STORE_LOCK_CODE;

  constructor(
    message: string,
    public readonly lockHolderPid: number | null,
    public readonly command?: string
  ) {
    super(message);
    this.name = 'StoreLockedError';
  }
}

export function toStoreLockedError(message: string, command?: string): StoreLockedError {
  return new StoreLockedError(message, parseLockHolderPid(message), command);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
