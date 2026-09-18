/**
 * Claim a complete file proposal once. Access grants and unknown request types
 * must still be handled manually. Attempts remain claimed even after a failed
 * or ambiguous response: replayed stream/status events must never retry writes.
 * @param {{id: string | number, approvalType?: string, files?: unknown[]} | null} approval
 * @param {boolean} enabled
 * @param {boolean} busy
 * @param {Set<string>} attempted
 */
export function claimAutoApproval(approval, enabled, busy, attempted) {
  if (!enabled || busy || !approval || approval.approvalType !== "file" || !approval.files?.length) return false;
  const id = String(approval.id);
  if (attempted.has(id)) return false;
  attempted.add(id);
  return true;
}
