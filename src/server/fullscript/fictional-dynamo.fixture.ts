import {
  DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand as LowQueryCommand, TransactWriteItemsCommand, UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Fictional DynamoDB tables for the Fullscript tests: plain items keyed by `pk|sk`, the condition, key-condition and
 * update expressions these modules actually write, evaluated rather than matched, and all-or-nothing transactions that
 * cancel with per-item reasons as DynamoDB does. Both the document client's commands (injected `send`) and the
 * low-level client's (the token store) reach the same items. Fictional tables, tokens and accounts only.
 */
type Item = Record<string, unknown>;
type Values = Record<string, unknown>;
type Names = Record<string, string>;

/* ---------------------------------------------------------------- marshalling, for the low-level client */
const fromAttribute = (value: AttributeValue): unknown => {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL) return null;
  if (value.SS) return new Set(value.SS);
  if (value.L) return value.L.map(fromAttribute);
  if (value.M) return fromMap(value.M);
  throw new Error("fictional_unsupported_attribute");
};
const fromMap = (map: Record<string, AttributeValue> | undefined): Item | undefined =>
  map === undefined ? undefined : Object.fromEntries(Object.entries(map).map(([k, v]) => [k, fromAttribute(v)]));
const toAttribute = (value: unknown): AttributeValue => {
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (value === null) return { NULL: true };
  if (value instanceof Set) return { SS: [...value] as string[] };
  if (Array.isArray(value)) return { L: value.map(toAttribute) };
  if (typeof value === "object") return { M: toMap(value as Item) };
  throw new Error("fictional_unsupported_value");
};
const toMap = (item: Item): Record<string, AttributeValue> => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, toAttribute(v)]));

/* ---------------------------------------------------------------- expressions */
type Token = { kind: "word" | "value" | "op" | "punct"; text: string };
function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(<>|<=|>=|=|<|>|\(|\)|,|\+|-|:[A-Za-z0-9_]+|#?[A-Za-z_][A-Za-z0-9_]*)/y;
  let match: RegExpExecArray | null;
  while (pattern.lastIndex < expression.length && (match = pattern.exec(expression))) {
    const text = match[1]!;
    tokens.push({ kind: text.startsWith(":") ? "value" : /^[<>=]/.test(text) ? "op" : /^[(),+-]$/.test(text) ? "punct" : "word", text });
  }
  if (expression.slice(pattern.lastIndex).trim()) throw new Error(`fictional_unparsed_expression:${expression}`);
  return tokens;
}

function evaluate(expression: string | undefined, item: Item | undefined, values: Values = {}, names: Names = {}): boolean {
  if (!expression) return true;
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at]?.text, next = () => tokens[at++]!;
  const name = (text: string) => (text.startsWith("#") ? names[text] : text) ?? text;
  const operand = (): unknown => {
    const token = next();
    if (token.kind === "value") return values[token.text];
    return item?.[name(token.text)];
  };
  const primary = (): boolean => {
    if (peek() === "(") { next(); const result = or(); next(); return result; }
    if (peek()?.toUpperCase() === "NOT") { next(); return !primary(); }
    const word = peek()!;
    if (["attribute_not_exists", "attribute_exists", "begins_with", "contains"].includes(word)) {
      next(); next();
      const path = name(next().text);
      let argument: unknown;
      if (peek() === ",") { next(); argument = operand(); }
      next();
      const present = item?.[path];
      if (word === "attribute_not_exists") return present === undefined;
      if (word === "attribute_exists") return present !== undefined;
      if (word === "begins_with") return typeof present === "string" && present.startsWith(String(argument));
      return present instanceof Set ? present.has(argument) : typeof present === "string" && present.includes(String(argument));
    }
    const left = operand(), op = next().text, right = operand();
    if (op === "=") return left !== undefined && left === right;
    if (op === "<>") return left !== right;
    if (left === undefined || right === undefined) return false;
    const [l, r] = [left as string | number, right as string | number];
    return op === "<=" ? l <= r : op === "<" ? l < r : op === ">=" ? l >= r : l > r;
  };
  const and = (): boolean => { let result = primary(); while (peek()?.toUpperCase() === "AND") { next(); const right = primary(); result = result && right; } return result; };
  const or = (): boolean => { let result = and(); while (peek()?.toUpperCase() === "OR") { next(); const right = and(); result = result || right; } return result; };
  return or();
}

function applyUpdate(expression: string, item: Item, values: Values = {}, names: Names = {}): Item {
  const result: Item = { ...item };
  const name = (text: string) => (text.startsWith("#") ? names[text] : text) ?? text;
  for (const clause of expression.split(/\s+(?=SET\s|REMOVE\s|ADD\s|DELETE\s)/).map((part) => part.trim()).filter(Boolean)) {
    const [keyword, ...rest] = clause.split(/\s+/);
    const body = rest.join(" ");
    for (const part of body.split(",").map((piece) => piece.trim())) {
      if (keyword === "REMOVE") { delete result[name(part)]; continue; }
      if (keyword === "SET") {
        const [target, assigned] = part.split("=").map((piece) => piece.trim()) as [string, string];
        const plus = assigned.split("+").map((piece) => piece.trim());
        const read = (text: string) => (text.startsWith(":") ? values[text] : result[name(text)]);
        result[name(target)] = plus.length === 2 ? Number(read(plus[0]!) ?? 0) + Number(read(plus[1]!)) : read(plus[0]!);
        continue;
      }
      if (keyword === "ADD") {
        const [target, value] = part.split(/\s+/) as [string, string];
        result[name(target)] = Number(result[name(target)] ?? 0) + Number(values[value]);
        continue;
      }
      throw new Error(`fictional_unsupported_update:${keyword}`);
    }
  }
  return result;
}

/* ---------------------------------------------------------------- the tables */
export type FictionalFault = { when: (command: unknown) => boolean; mode: "fail_before" | "lost_reply" };
const conditionFailed = () => Object.assign(new Error("fictional condition failed"), { name: "ConditionalCheckFailedException" });

export function fictionalDynamoTables(...names: string[]) {
  const tables = new Map<string, Map<string, Item>>(names.map((table) => [table, new Map()]));
  const id = (key: Item) => `${String(key.pk)}|${String(key.sk)}`;
  const table = (name: string | undefined) => {
    const found = tables.get(String(name));
    if (!found) throw new Error(`fictional_unknown_table:${name}`);
    return found;
  };
  const faults: FictionalFault[] = [];
  const applied = new Set<string>();
  const commands: unknown[] = [];

  type Write = { kind: "check" | "put" | "delete" | "update"; table: string; key: Item; item?: Item; condition?: string; values?: Values; names?: Names; update?: string };
  function check(write: Write): boolean {
    return evaluate(write.condition, table(write.table).get(id(write.key)), write.values, write.names);
  }
  function apply(write: Write) {
    const rows = table(write.table), key = id(write.key);
    if (write.kind === "put") rows.set(key, structuredClone(write.item!));
    if (write.kind === "delete") rows.delete(key);
    if (write.kind === "update") rows.set(key, applyUpdate(write.update!, rows.get(key) ?? { ...write.key }, write.values, write.names));
  }
  function transact(writes: Write[]) {
    const reasons = writes.map((write) => ({ Code: check(write) ? "None" : "ConditionalCheckFailed" }));
    if (reasons.some((reason) => reason.Code !== "None")) {
      throw Object.assign(new Error("fictional transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    }
    writes.forEach(apply);
  }
  function single(write: Write) {
    if (!check(write)) throw conditionFailed();
    apply(write);
  }
  function query(input: { TableName?: string; IndexName?: string; KeyConditionExpression?: string; ExpressionAttributeValues?: Values;
    ExpressionAttributeNames?: Names; Limit?: number; ProjectionExpression?: string }) {
    const matched = [...table(input.TableName).values()]
      .filter((row) => evaluate(input.KeyConditionExpression, row, input.ExpressionAttributeValues, input.ExpressionAttributeNames))
      .sort((a, b) => input.IndexName === "RevocationQueue"
        ? String(a.nextAttemptAt).localeCompare(String(b.nextAttemptAt)) || id(a).localeCompare(id(b))
        : String(a.sk).localeCompare(String(b.sk)));
    const limited = input.Limit ? matched.slice(0, input.Limit) : matched;
    // A KEYS_ONLY index answers with the table key and the index key, never the payload.
    const items = input.IndexName === "RevocationQueue"
      ? limited.map((row) => ({ pk: row.pk, sk: row.sk, revocationQueue: row.revocationQueue, nextAttemptAt: row.nextAttemptAt }))
      : limited.map((row) => structuredClone(row));
    return { Items: items, ...(input.Limit && matched.length > input.Limit ? { LastEvaluatedKey: { pk: limited.at(-1)!.pk, sk: limited.at(-1)!.sk } } : {}) };
  }

  function documentWrite(entry: NonNullable<TransactWriteCommand["input"]["TransactItems"]>[number]): Write {
    if (entry.ConditionCheck) return { kind: "check", table: entry.ConditionCheck.TableName!, key: entry.ConditionCheck.Key as Item,
      condition: entry.ConditionCheck.ConditionExpression, values: entry.ConditionCheck.ExpressionAttributeValues, names: entry.ConditionCheck.ExpressionAttributeNames };
    if (entry.Put) return { kind: "put", table: entry.Put.TableName!, key: entry.Put.Item as Item, item: entry.Put.Item as Item,
      condition: entry.Put.ConditionExpression, values: entry.Put.ExpressionAttributeValues, names: entry.Put.ExpressionAttributeNames };
    if (entry.Delete) return { kind: "delete", table: entry.Delete.TableName!, key: entry.Delete.Key as Item,
      condition: entry.Delete.ConditionExpression, values: entry.Delete.ExpressionAttributeValues, names: entry.Delete.ExpressionAttributeNames };
    if (entry.Update) return { kind: "update", table: entry.Update.TableName!, key: entry.Update.Key as Item, update: entry.Update.UpdateExpression,
      condition: entry.Update.ConditionExpression, values: entry.Update.ExpressionAttributeValues, names: entry.Update.ExpressionAttributeNames };
    throw new Error("fictional_unsupported_transact_item");
  }
  function lowWrite(entry: NonNullable<TransactWriteItemsCommand["input"]["TransactItems"]>[number]): Write {
    const values = (map?: Record<string, AttributeValue>) => fromMap(map);
    if (entry.ConditionCheck) return { kind: "check", table: entry.ConditionCheck.TableName!, key: fromMap(entry.ConditionCheck.Key)!,
      condition: entry.ConditionCheck.ConditionExpression, values: values(entry.ConditionCheck.ExpressionAttributeValues), names: entry.ConditionCheck.ExpressionAttributeNames };
    if (entry.Put) return { kind: "put", table: entry.Put.TableName!, key: fromMap(entry.Put.Item)!, item: fromMap(entry.Put.Item)!,
      condition: entry.Put.ConditionExpression, values: values(entry.Put.ExpressionAttributeValues), names: entry.Put.ExpressionAttributeNames };
    if (entry.Delete) return { kind: "delete", table: entry.Delete.TableName!, key: fromMap(entry.Delete.Key)!,
      condition: entry.Delete.ConditionExpression, values: values(entry.Delete.ExpressionAttributeValues), names: entry.Delete.ExpressionAttributeNames };
    if (entry.Update) return { kind: "update", table: entry.Update.TableName!, key: fromMap(entry.Update.Key)!, update: entry.Update.UpdateExpression,
      condition: entry.Update.ConditionExpression, values: values(entry.Update.ExpressionAttributeValues), names: entry.Update.ExpressionAttributeNames };
    throw new Error("fictional_unsupported_transact_item");
  }

  function execute(command: unknown): unknown {
    if (command instanceof GetCommand) {
      const found = table(command.input.TableName).get(id(command.input.Key as Item));
      return { Item: found ? structuredClone(found) : undefined };
    }
    if (command instanceof PutCommand) { single({ kind: "put", table: command.input.TableName!, key: command.input.Item as Item, item: command.input.Item as Item,
      condition: command.input.ConditionExpression, values: command.input.ExpressionAttributeValues, names: command.input.ExpressionAttributeNames }); return {}; }
    if (command instanceof DeleteCommand) { single({ kind: "delete", table: command.input.TableName!, key: command.input.Key as Item,
      condition: command.input.ConditionExpression, values: command.input.ExpressionAttributeValues, names: command.input.ExpressionAttributeNames }); return {}; }
    if (command instanceof UpdateCommand) { single({ kind: "update", table: command.input.TableName!, key: command.input.Key as Item, update: command.input.UpdateExpression,
      condition: command.input.ConditionExpression, values: command.input.ExpressionAttributeValues, names: command.input.ExpressionAttributeNames }); return {}; }
    if (command instanceof QueryCommand) return query(command.input as never);
    if (command instanceof TransactWriteCommand) {
      // DynamoDB applies a transaction with the same client request token at most once (within ten minutes).
      const token = command.input.ClientRequestToken;
      if (token && applied.has(token)) return {};
      transact((command.input.TransactItems ?? []).map(documentWrite));
      if (token) applied.add(token);
      return {};
    }
    if (command instanceof GetItemCommand) {
      const found = table(command.input.TableName).get(id(fromMap(command.input.Key)!));
      return { Item: found ? toMap(found) : undefined };
    }
    if (command instanceof PutItemCommand) { const item = fromMap(command.input.Item)!; single({ kind: "put", table: command.input.TableName!, key: item, item,
      condition: command.input.ConditionExpression, values: fromMap(command.input.ExpressionAttributeValues), names: command.input.ExpressionAttributeNames }); return {}; }
    if (command instanceof DeleteItemCommand) { single({ kind: "delete", table: command.input.TableName!, key: fromMap(command.input.Key)!,
      condition: command.input.ConditionExpression, values: fromMap(command.input.ExpressionAttributeValues), names: command.input.ExpressionAttributeNames }); return {}; }
    if (command instanceof UpdateItemCommand) { single({ kind: "update", table: command.input.TableName!, key: fromMap(command.input.Key)!, update: command.input.UpdateExpression,
      condition: command.input.ConditionExpression, values: fromMap(command.input.ExpressionAttributeValues), names: command.input.ExpressionAttributeNames }); return {}; }
    if (command instanceof LowQueryCommand) {
      const answer = query({ ...command.input, ExpressionAttributeValues: fromMap(command.input.ExpressionAttributeValues) });
      return { Items: answer.Items.map(toMap) };
    }
    if (command instanceof TransactWriteItemsCommand) { transact((command.input.TransactItems ?? []).map(lowWrite)); return {}; }
    throw new Error("fictional_unexpected_command");
  }

  /** Every command, document or low-level. A fault fails the command before it runs, or runs it and loses the reply. */
  async function send(command: unknown): Promise<unknown> {
    commands.push(command);
    const index = faults.findIndex((fault) => fault.when(command));
    const fault = index >= 0 ? faults.splice(index, 1)[0] : undefined;
    if (fault?.mode === "fail_before") throw Object.assign(new Error("fictional network failure"), { name: "TimeoutError" });
    const answer = execute(command);
    await Promise.resolve();
    if (fault?.mode === "lost_reply") throw Object.assign(new Error("fictional reply lost"), { name: "TimeoutError" });
    return answer;
  }

  return {
    tables, send, commands,
    rows: (name: string) => table(name),
    get: (name: string, key: { pk: string; sk: string }) => table(name).get(id(key)),
    set: (name: string, item: Item & { pk: string; sk: string }) => table(name).set(id(item), structuredClone(item)),
    fault(fault: FictionalFault) { faults.push(fault); },
  };
}

export const isTransaction = (command: unknown) => command instanceof TransactWriteCommand || command instanceof TransactWriteItemsCommand;
export const writesTo = (command: unknown, prefix: string) => {
  const items = command instanceof TransactWriteCommand ? command.input.TransactItems ?? []
    : command instanceof TransactWriteItemsCommand ? (command.input.TransactItems ?? []).map((entry) => ({ Put: entry.Put ? { Item: fromMap(entry.Put.Item) } : undefined,
      Delete: entry.Delete ? { Key: fromMap(entry.Delete.Key) } : undefined })) : [];
  return items.some((entry) => String((entry.Put?.Item as Item | undefined)?.pk ?? (entry.Delete?.Key as Item | undefined)?.pk ?? "").startsWith(prefix));
};
