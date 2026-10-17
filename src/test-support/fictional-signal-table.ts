/**
 * One fictional DynamoDB table for the staff revocation signal (staff-revocation-signal/2), as the document client sees
 * it, shared by the emergency revocation's writer and the campaign engine's reader in tests. It evaluates the exact
 * condition expressions the two sides use and refuses any other, so a change on either side that the other does not
 * expect fails here instead of passing against a looser fake. It can be made unwritable or unreadable, and a write can
 * be applied with its reply lost. Fictional subjects only.
 */
type Item = { subject: string } & Record<string, unknown>;
type Input = {
  TableName?: string; Key?: { subject: string }; Item?: Item; ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown>; ProjectionExpression?: string; ConsistentRead?: boolean;
};
const ONCE = 'attribute_not_exists(#s)';
const OWN_DECISION = '#d = :decision';
const conditionFailed = () => Object.assign(new Error('fictional condition'), { name: 'ConditionalCheckFailedException' });

export function fictionalSignalTable(tableName = 'alp-campaign-staff-revocations') {
  const items = new Map<string, Item>();
  const down = { writes: false, reads: false };
  /** Applied, then the reply is lost: the next write of each kind lands but its caller sees a timeout. */
  const lose = { put: 0, delete: 0 };
  /** Writes wait on this gate before landing, so a test can decide when they arrive. */
  let gate: Promise<void> | null = null;
  const writes: string[] = [];
  const send = async (command: { constructor: { name: string }; input: Input }) => {
    const input = command.input;
    if (input.TableName !== tableName) throw Object.assign(new Error('no such table'), { name: 'ResourceNotFoundException' });
    const kind = command.constructor.name;
    if (kind === 'GetCommand') {
      if (down.reads) throw Object.assign(new Error('fictional outage'), { name: 'InternalServerError' });
      if (!input.ConsistentRead) throw new Error('the signal is only ever read strongly consistent');
      const item = items.get(input.Key!.subject);
      if (!item) return {};
      const names = Object.values(input.ExpressionAttributeNames ?? {});
      return { Item: Object.fromEntries(Object.entries(item).filter(([k]) => names.includes(k))) };
    }
    if (gate) await gate;
    if (down.writes) throw Object.assign(new Error('fictional outage'), { name: 'InternalServerError' });
    if (kind === 'PutCommand') {
      const item = input.Item!;
      // A revocation is written once; a pending decision (its own key) is written over freely.
      const pending = item.subject.startsWith('pending#');
      if (pending ? input.ConditionExpression !== undefined : input.ConditionExpression !== ONCE) throw new Error(`unexpected condition ${input.ConditionExpression} for ${item.subject}`);
      if (!pending && items.has(item.subject)) throw conditionFailed();
      items.set(item.subject, { ...item });
      writes.push(`put:${item.subject}`);
      if (lose.put > 0) { lose.put--; throw Object.assign(new Error('reply lost'), { name: 'TimeoutError' }); }
      return {};
    }
    if (kind === 'DeleteCommand') {
      // The writer's role may delete pending items only (dynamodb:LeadingKeys pending#*); a revocation never.
      if (!input.Key!.subject.startsWith('pending#')) throw Object.assign(new Error('fictional IAM'), { name: 'AccessDeniedException' });
      if (input.ConditionExpression !== OWN_DECISION) throw new Error(`unexpected condition ${input.ConditionExpression}`);
      const present = items.get(input.Key!.subject);
      if (!present || present.decisionId !== input.ExpressionAttributeValues?.[':decision']) throw conditionFailed();
      items.delete(input.Key!.subject);
      writes.push(`delete:${input.Key!.subject}`);
      if (lose.delete > 0) { lose.delete--; throw Object.assign(new Error('reply lost'), { name: 'TimeoutError' }); }
      return {};
    }
    throw new Error(`unexpected ${kind}`);
  };
  let open: (() => void) | null = null;
  return {
    tableName, items, down, lose, writes, client: { send },
    /** Holds every write until `arrive()`. */
    delayWrites() { gate = new Promise<void>(resolve => { open = resolve; }); },
    arrive() { open?.(); gate = null; open = null; },
  };
}
