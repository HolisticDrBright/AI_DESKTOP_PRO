import {
  protocolCartRequest, parseProtocolCartResponse, type ProtocolCartResponse,
} from '../../contracts/protocolCarts';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';

/**
 * Compiling a cart from a published protocol.
 *
 * Nothing here decides anything. Which version may be compiled, which lines are excluded and
 * why, and whether a second compile makes a second cart are all settled in SQL, in the same
 * transaction as the write. An exclusion re-implemented at this layer could only disagree with
 * the one that counts, and a cart is the wrong place to be wrong about iron.
 */
export type ProtocolCartCategory = 'request_invalid' | 'identity_refused'
  | 'operation_refused' | 'service_unavailable';
export class ProtocolCartError extends Error {
  constructor(readonly category: ProtocolCartCategory) { super(category); this.name = 'ProtocolCartError'; }
}
const rejection = (error: unknown): ProtocolCartCategory => {
  if (!(error instanceof ClinicalCoreDatabaseRejection)) return 'service_unavailable';
  switch (error.category) {
    case 'request_invalid': return 'request_invalid';
    // An absent manifest, an unpublished version and a protocol with nothing to buy are one
    // answer, so a caller cannot use the status to learn which protocols exist.
    case 'operation_refused': return 'operation_refused';
    default: return 'identity_refused';
  }
};

export const createProtocolCartWorkforce = (database: ClinicalCoreDatabase) =>
  async (context: ClinicalRequestContext, body: unknown): Promise<ProtocolCartResponse> => {
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new ProtocolCartError('identity_refused');
    }
    if (context.identityPool !== 'workforce') throw new ProtocolCartError('identity_refused');
    const parsed = protocolCartRequest.safeParse(body);
    if (!parsed.success) throw new ProtocolCartError('request_invalid');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          { kind: 'uuid', value: context.actorPersonId }, { kind: 'uuid', value: context.organizationId },
          context.identityPool, context.identitySubject, context.purpose, context.environment,
          context.dataClassification,
        ]);
        const result = await tx.query<{ data: unknown }>(
          'select clinical_core.protocol_cart_workforce($1::jsonb) as data', [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        return parseProtocolCartResponse(parsed.data, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) { throw new ProtocolCartError(rejection(error)); }
  };
