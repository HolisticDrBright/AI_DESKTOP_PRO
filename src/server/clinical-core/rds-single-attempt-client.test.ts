import { describe, expect, it } from 'vitest';
import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { createSingleAttemptRdsClient } from './rds-single-attempt-client';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const parameters = { resourceArn: 'arn:aws:rds:us-east-2:123456789012:cluster:fictional',
  secretArn: 'arn:aws:secretsmanager:us-east-2:123456789012:secret:fictional-test', database: 'fictional' };
const credentials = { accessKeyId: 'FICTIONAL_TEST_ONLY', secretAccessKey: 'FICTIONAL_TEST_ONLY' };
const response = (body: Record<string, unknown>, statusCode = 200) => ({ response: {
  statusCode, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(body)),
} });
const failure = (kind: string) => {
  if (kind === 'timeout') throw Object.assign(new Error('Fictional timeout after admission'), { name: 'TimeoutError' });
  return response({ __type: kind === 'throttle' ? 'ThrottlingException' : 'InternalServerErrorException',
    message: 'Fictional failure after admission' }, kind === 'throttle' ? 429 : 500);
};

function constructorProblems(text: string, file = 'fixture.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = new Set(['RDSDataClient']), namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== '@aws-sdk/client-rds-data') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements)
      if ((item.propertyName ?? item.name).text === 'RDSDataClient') names.add(item.name.text);
  }
  let constructors = 0; const problems: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && (ts.isIdentifier(node.expression) && names.has(node.expression.text)
      || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'RDSDataClient'
        && ts.isIdentifier(node.expression.expression) && namespaces.has(node.expression.expression.text))) {
      constructors++;
      const config = node.arguments?.[0];
      const properties = config && ts.isObjectLiteralExpression(config) ? config.properties : undefined;
      const pin = properties?.findIndex(p => ts.isPropertyAssignment(p)
        && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'maxAttempts');
      const property = pin !== undefined && pin >= 0 ? properties![pin] : undefined;
      const spread = properties?.some(ts.isSpreadAssignment);
      const afterPin = pin !== undefined && pin >= 0 && properties!.slice(pin + 1).some(p =>
        ts.isSpreadAssignment(p) || !p.name || ts.isComputedPropertyName(p.name)
        || (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && ['maxAttempts', 'retryStrategy'].includes(p.name.text));
      if (!property || !ts.isPropertyAssignment(property) || !ts.isNumericLiteral(property.initializer)
        || property.initializer.text !== '1' || afterPin
        || spread && !file.endsWith('rds-single-attempt-client.ts')
        || properties?.some(p => p.name && (ts.isComputedPropertyName(p.name)
          || (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'retryStrategy')))
        problems.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return { constructors, problems };
}

describe('actual RDS SDK middleware with fictional HTTP transport only', () => {
  it.each(['begin', 'query', 'commit'])('never repeats an ambiguous %s request on retryable server failure', async stage => {
    let requests = 0;
    const sdk = createSingleAttemptRdsClient({ region: 'us-east-2',
      credentials: { accessKeyId: 'FICTIONAL_TEST_ONLY', secretAccessKey: 'FICTIONAL_TEST_ONLY' },
      requestHandler: { handle: async () => {
        requests++;
        return { response: { statusCode: 500, headers: { 'content-type': 'application/x-amz-json-1.1' },
          body: Buffer.from(JSON.stringify({ __type: 'InternalServerErrorException', message: 'Fictional server failure after admission' })) } };
      } } });
    const send = () => stage === 'begin' ? sdk.send(new BeginTransactionCommand(parameters))
      : stage === 'commit' ? sdk.send(new CommitTransactionCommand({ ...parameters, transactionId: 'fictional-tx' }))
        : sdk.send(new ExecuteStatementCommand({ ...parameters, transactionId: 'fictional-tx', sql: 'insert into fictional_table values(1)' }));
    try { await expect(send()).rejects.toThrow(); expect(requests).toBe(1); }
    finally { sdk.destroy(); }
  });
  it.each(['begin', 'query', 'commit'].flatMap(stage => ['timeout', 'throttle'].map(kind => ({ stage, kind }))))
    ('does not retry SDK $stage after $kind', async ({ stage, kind }) => {
      let requests = 0;
      const sdk = createSingleAttemptRdsClient({ region: 'us-east-2', credentials,
        requestHandler: { handle: async () => { requests++; return failure(kind); } } });
      const send = () => stage === 'begin' ? sdk.send(new BeginTransactionCommand(parameters))
        : stage === 'commit' ? sdk.send(new CommitTransactionCommand({ ...parameters, transactionId: 'fictional-tx' }))
          : sdk.send(new ExecuteStatementCommand({ ...parameters, transactionId: 'fictional-tx', sql: 'insert into fictional_table values(1)' }));
      try { await expect(send()).rejects.toThrow(); expect(requests).toBe(1); }
      finally { sdk.destroy(); }
    });
  it.each(['begin', 'query', 'commit'].flatMap(stage => ['server', 'timeout', 'throttle'].map(kind => ({ stage, kind }))))
    ('keeps the real transaction adapter single-attempt on $stage/$kind and does not certify rollback', async ({ stage, kind }) => {
      const calls: string[] = [];
      const sdk = createSingleAttemptRdsClient({ region: 'us-east-2', credentials,
        requestHandler: { handle: async (request: { path: string; body?: unknown }) => {
          const endpoint = request.path.split('/').at(-1)!;
          const action = endpoint === 'Execute' ? 'ExecuteStatement' : endpoint;
          const body = JSON.parse(String(request.body)) as { sql?: string };
          calls.push(action === 'ExecuteStatement' && body.sql?.startsWith('set local role') ? 'role' : action);
          if (action === 'BeginTransaction' && stage === 'begin'
            || action === 'ExecuteStatement' && body.sql?.startsWith('insert ') && stage === 'query'
            || action === 'CommitTransaction' && stage === 'commit') return failure(kind);
          // Simulate uncertain rollback as well: it must not repeat or convert
          // the original failure to success/deletion evidence.
          if (action === 'RollbackTransaction') return failure(kind);
          return response(action === 'BeginTransaction' ? { transactionId: 'fictional-tx' } : {});
        } } });
      const database = createRdsDataClinicalCoreDatabase({ clusterArn: parameters.resourceArn,
        secretArn: parameters.secretArn, databaseName: parameters.database }, sdk);
      try {
        await expect(database.transaction(tx => tx.query('insert into fictional_table values(1)')))
          .rejects.toThrow(stage === 'begin' ? 'transaction_failed' : 'query_failed');
        expect(calls.filter(c => c === 'BeginTransaction')).toHaveLength(1);
        expect(calls.filter(c => c === 'ExecuteStatement')).toHaveLength(stage === 'begin' ? 0 : 1);
        expect(calls.filter(c => c === 'CommitTransaction')).toHaveLength(stage === 'commit' ? 1 : 0);
        expect(calls.filter(c => c === 'RollbackTransaction')).toHaveLength(stage === 'begin' ? 0 : 1);
      } finally { sdk.destroy(); }
    });
  it('overrides a supplied retry-count provider and refuses custom retry strategies before requests', async () => {
    const sdk = createSingleAttemptRdsClient({ region: 'us-east-2', maxAttempts: async () => 99 });
    try { expect(await sdk.config.maxAttempts()).toBe(1); } finally { sdk.destroy(); }
    expect(() => createSingleAttemptRdsClient({ region: 'us-east-2', retryStrategy: {} as never })).toThrow('rds_retry_strategy_refused');
  });
  it('captures options once before examining retry strategy', async () => {
    let reads = 0;
    const sdk = createSingleAttemptRdsClient({ region: 'us-east-2', get retryStrategy() {
      reads++; return reads === 1 ? undefined : {} as never;
    } });
    try { expect(reads).toBe(1); expect(await sdk.config.maxAttempts()).toBe(1); }
    finally { sdk.destroy(); }
  });
  it.each([
    'new RDSDataClient({region})', 'new RDSDataClient({maxAttempts:3})',
    'new RDSDataClient({maxAttempts:1,...options})', 'new RDSDataClient({...options,maxAttempts:1})',
    'new RDSDataClient({[key]:strategy,maxAttempts:1})',
    "import {RDSDataClient as Data} from '@aws-sdk/client-rds-data'; new Data({})",
    "import * as SDK from '@aws-sdk/client-rds-data'; new SDK.RDSDataClient({maxAttempts:2})",
  ])('source regression rejects unsafe construction: %s', text => {
    expect(constructorProblems(text)).toMatchObject({ constructors: 1, problems: [expect.any(Number)] });
  });
  it('requires every shipped source/script RDS constructor to pin one attempt', () => {
    const files: string[] = [];
    const walk = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(path)) files.push(path);
    } };
    walk('src'); walk('scripts');
    let constructors = 0; const problems: string[] = [];
    for (const file of files) {
      const checked = constructorProblems(readFileSync(file, 'utf8'), file);
      constructors += checked.constructors;
      problems.push(...checked.problems.map(line => `${file}:${line}`));
    }
    expect(constructors).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  }, 30000);
});
