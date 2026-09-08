/**
 * @typedef {{id: string, role: 'user' | 'assistant', text: string, revision?: number}} ChatMessage
 * @typedef {{id: string, text: string, revision: number}} MessageSnapshot
 */

/**
 * Merge streamed and recovered snapshots without duplicating messages or letting
 * a slower status response overwrite newer streamed text.
 * @param {ChatMessage[]} current
 * @param {MessageSnapshot[]} snapshots
 * @param {string | null} [placeholderId]
 * @returns {ChatMessage[]}
 */
export function mergeAgentMessages(current, snapshots, placeholderId = null) {
  let next = current;
  for (const snapshot of snapshots) {
    if (!snapshot.id || !snapshot.text) continue;
    const index = next.findIndex(message => message.id === snapshot.id);
    if (index >= 0 && (next[index].revision ?? 0) >= snapshot.revision) continue;
    const message = { id: snapshot.id, role: /** @type {const} */ ('assistant'), text: snapshot.text, revision: snapshot.revision };
    if (next === current) next = [...current];
    const placeholder = index < 0 && placeholderId
      ? next.findIndex(item => item.id === placeholderId && !item.text)
      : -1;
    if (index >= 0) next[index] = message;
    else if (placeholder >= 0) next[placeholder] = message;
    else next.push(message);
  }
  return next;
}
