/** Fictional conditional store for operation regressions. Not DynamoDB or hosted
 * evidence. Refuse expressions outside the explicitly implemented subset. */
type Row = Record<string, unknown>;
type Command = { constructor: { name: string }; input: Row };
const keyOf = (key: Row) => `${key.pk}|${key.sk}`;
const conditional = (transaction: boolean) => Object.assign(new Error("fictional_condition_refused"),
  { name: transaction ? "TransactionCanceledException" : "ConditionalCheckFailedException" });

function condition(expression: string | undefined, row: Row, names: Row, values: Row): boolean {
  if (!expression) return true;
  const tokens = expression.match(/attribute_not_exists|attribute_exists|contains|AND|OR|\(|\)|,|<>|>=|<=|=|>|<|[#:][A-Za-z0-9_]+|[A-Za-z0-9_]+/g) ?? [];
  let position = 0;
  const field = (token: string) => token.startsWith("#") ? String(names[token]) : token;
  const value = (token: string) => token.startsWith(":") ? values[token] : row[field(token)];
  const atom = (): boolean => {
    const token = tokens[position++];
    if (token === "(") { const result = or(); if (tokens[position++] !== ")") throw new Error("unsupported_condition"); return result; }
    if (token === "attribute_not_exists" || token === "attribute_exists") {
      if (tokens[position++] !== "(") throw new Error("unsupported_condition");
      const exists = field(tokens[position++]) in row;
      if (tokens[position++] !== ")") throw new Error("unsupported_condition");
      return token === "attribute_exists" ? exists : !exists;
    }
    if (token === "contains") {
      if (tokens[position++] !== "(") throw new Error("unsupported_condition");
      const container = row[field(tokens[position++])];
      if (tokens[position++] !== ",") throw new Error("unsupported_condition");
      const member = value(tokens[position++]);
      if (tokens[position++] !== ")") throw new Error("unsupported_condition");
      return container instanceof Set ? container.has(member) : Array.isArray(container) ? container.includes(member)
        : typeof container === "string" && typeof member === "string" && container.includes(member);
    }
    const left = value(token), operator = tokens[position++], right = value(tokens[position++]);
    if (operator === "=") return left === right;
    if (operator === "<>") return left !== right;
    if (operator === ">") return Number(left) > Number(right);
    if (operator === ">=") return Number(left) >= Number(right);
    if (operator === "<") return Number(left) < Number(right);
    if (operator === "<=") return Number(left) <= Number(right);
    throw new Error("unsupported_condition");
  };
  const and = (): boolean => { let result = atom(); while (tokens[position] === "AND") { position++; const next = atom(); result = result && next; } return result; };
  const or = (): boolean => { let result = and(); while (tokens[position] === "OR") { position++; const next = and(); result = result || next; } return result; };
  const result = or(); if (position !== tokens.length) throw new Error("unsupported_condition"); return result;
}

export class FictionalAppointmentStore {
  rows = new Map<string, Row>();
  commands: Command[] = [];
  /** Throw before/after a selected transaction to model an unknown receipt. */
  transactionLoss: "none" | "admission_before" | "admission_after" | "commit_before" | "commit_after" | "reservation_after" = "none";
  seed(...rows: Row[]) { for (const row of rows) this.rows.set(keyOf(row), structuredClone(row)); return this; }
  get(key: Row) { return structuredClone(this.rows.get(keyOf(key))); }
  private apply(part: Row, rows: Map<string, Row>, transactional: boolean) {
    const [kind, raw] = Object.entries(part)[0], input = raw as Row;
    const key = (kind === "Put" ? input.Item : input.Key) as Row;
    const existing = rows.get(keyOf(key)) ?? {};
    const names = (input.ExpressionAttributeNames ?? {}) as Row, values = (input.ExpressionAttributeValues ?? {}) as Row;
    if (!condition(input.ConditionExpression as string | undefined, existing, names, values)) throw conditional(transactional);
    if (kind === "ConditionCheck") return;
    if (kind === "Put") { rows.set(keyOf(key), structuredClone(input.Item as Row)); return; }
    if (kind !== "Update") throw new Error("unsupported_write");
    const next: Row = { ...existing, ...key }, expression = String(input.UpdateExpression);
    const name = (target: string) => target.startsWith("#") ? String(names[target]) : target;
    // SET, REMOVE, ADD (numbers and string sets) and DELETE (string sets), each at most once, in any order.
    const sections = [...expression.matchAll(/(?:^|\s)(SET|REMOVE|ADD|DELETE)\s+([\s\S]*?)(?=\s+(?:SET|REMOVE|ADD|DELETE)\s|$)/g)];
    if (sections.length === 0 || new Set(sections.map(([, action]) => action)).size !== sections.length
      || sections.map(([, action, body]) => `${action} ${body.trim()}`).join(" ").replace(/\s+/g, " ") !== expression.trim().replace(/\s+/g, " ")) {
      throw new Error("unsupported_update");
    }
    for (const [, action, body] of sections) for (const part of body.split(",").map(item => item.trim())) {
      if (action === "SET") {
        const [target, source] = part.split(/\s*=\s*/);
        const addition = source.match(/^(#[A-Za-z0-9_]+)\+(:[A-Za-z0-9_]+)$/);
        if (addition) next[name(target)] = Number(next[String(names[addition[1]])]) + Number(values[addition[2]]);
        else {
          if (!(source in values)) throw new Error("unsupported_update");
          next[name(target)] = structuredClone(values[source]);
        }
      } else if (action === "REMOVE") delete next[name(part)];
      else {
        const [target, source] = part.split(/\s+/), operand = values[source], current = next[name(target)];
        if (action === "ADD" && typeof operand === "number" && (current === undefined || typeof current === "number")) next[name(target)] = Number(current ?? 0) + operand;
        else if (action === "ADD" && operand instanceof Set && (current === undefined || current instanceof Set)) next[name(target)] = new Set([...(current ?? []), ...operand]);
        else if (action === "DELETE" && operand instanceof Set && (current === undefined || current instanceof Set)) {
          const remaining = new Set([...(current ?? [])].filter(member => !operand.has(member)));
          if (remaining.size === 0) delete next[name(target)]; else next[name(target)] = remaining;
        } else throw new Error("unsupported_update");
      }
    }
    rows.set(keyOf(key), next);
  }
  send = async (command: Command): Promise<Row> => {
    this.commands.push(structuredClone({ constructor: { name: command.constructor.name }, input: command.input }));
    const input = command.input;
    if (command.constructor.name === "GetCommand") return { Item: this.get(input.Key as Row) };
    if (command.constructor.name === "QueryCommand") {
      const values = input.ExpressionAttributeValues as Row;
      const prefix = String(values[":request"] ?? values[":slot"] ?? "SLOT#");
      return { Items: [...this.rows.values()].filter(row => row.pk === values[":org"] && String(row.sk).startsWith(prefix)
        && (!(":id" in values) || row.requestId === values[":id"])).map(row => structuredClone(row)) };
    }
    if (command.constructor.name === "TransactWriteCommand") {
      const parts = input.TransactItems as Row[];
      const admission = parts.some(part => String((part.Put as Row | undefined)?.Item && ((part.Put as Row).Item as Row).sk).startsWith("REQOP#"));
      const commit = parts.some(part => String((part.Update as Row | undefined)?.UpdateExpression).includes("committedVersion"));
      const reservation = parts.some(part => String((part.Update as Row | undefined)?.UpdateExpression).includes("reservedSlotKey"));
      const loss = this.transactionLoss;
      if ((admission && loss === "admission_before") || (commit && loss === "commit_before")) { this.transactionLoss = "none"; throw new Error("fictional_lost_receipt"); }
      const keys = parts.map(part => { const [kind, raw] = Object.entries(part)[0]; return keyOf((raw as Row)[kind === "Put" ? "Item" : "Key"] as Row); });
      if (new Set(keys).size !== keys.length) throw new Error("duplicate_transaction_key");
      const next = new Map([...this.rows].map(([key, row]) => [key, structuredClone(row)]));
      for (const [index, part] of parts.entries()) {
        try { this.apply(part, next, true); } catch (error) {
          // Like DynamoDB, name the item whose condition failed, so a caller can tell its own refusal from a fence's.
          if ((error as Error).message === "fictional_condition_refused") Object.assign(error as Error, {
            CancellationReasons: parts.map((_, position) => ({ Code: position === index ? "ConditionalCheckFailed" : "None" })) });
          throw error;
        }
      }
      this.rows = next;
      if ((admission && loss === "admission_after") || (commit && loss === "commit_after") || (reservation && loss === "reservation_after")) {
        this.transactionLoss = "none"; throw new Error("fictional_lost_receipt");
      }
      return {};
    }
    if (command.constructor.name === "UpdateCommand" || command.constructor.name === "PutCommand") {
      this.apply({ [command.constructor.name === "UpdateCommand" ? "Update" : "Put"]: input }, this.rows, false);
      return { Attributes: this.get(input.Key as Row ?? input.Item as Row) };
    }
    throw new Error("unsupported_command");
  };
}
