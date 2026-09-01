/** WhatsApp refreshes composing every ~4s; auto-clear if no refresh arrives. */
export const TYPING_TTL_MS = 10_000;

export function sameWhatsAppUser(a: string, b: string): boolean {
  const base = (jid: string) => jid.split(':')[0].split('@')[0];
  return base(a) === base(b);
}
