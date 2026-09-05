/**
 * What to call a chat we have no name for.
 *
 * For a DM the JID's local part is the phone number, which is genuinely useful.
 * For a group it is an opaque 18-digit WhatsApp group id — it identifies nothing
 * a human recognises, and rendered as a name it reads as a phone number, which
 * is worse than admitting we don't know. The tail is kept so two unnamed groups
 * stay tellable apart; `ChatInfoModal` still shows the full JID.
 *
 * Twin of `chatDisplayName` in `apps/api/src/wacli/normalize.ts`, which names the
 * same chat when it comes from the store instead. Keep them in step.
 */
export function chatDisplayName(jid: string, name?: string | null): string {
  const given = (name ?? '').trim();
  if (given) return given;

  const local = jid.split('@')[0] ?? '';
  if (!jid.endsWith('@g.us')) return local;

  return local ? `Group ${local.slice(-6)}` : 'Unnamed group';
}
