import { isAdapterError } from '@/adapters/errors';

/** A vanished or unauthorized record must not leave clinical text or SDK
 * credentials resident in a still-mounted visit/note controller. */
export function telehealthAccessLost(error: unknown): boolean {
  return isAdapterError(error) && ['unauthenticated', 'forbidden', 'not_found'].includes(error.code);
}
