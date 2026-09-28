import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { qualificationUpgradeFromAws } from './qualification-upgrade-aws-binding';
const caller = { Account: '588966314750' };
const values = { PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'disabled', DatabaseName: 'clinical_core_qualification',
  DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:synthetic', DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:synthetic' };
const stack = { StackStatus: 'CREATE_COMPLETE', StackId: 'arn:aws:cloudformation:us-east-2:588966314750:stack/ai-clinical-core-qualification-foundation/fixture-id',
  Outputs: Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
describe('qualification upgrade AWS binding', () => {
  it('binds to the actual fixed foundation without enabling its candidate profile', () => {
    expect(qualificationUpgradeFromAws(caller, { Stacks: [stack] })).toMatchObject({ expectedAccountId: '588966314750', qualificationDatabaseName: 'clinical_core_qualification', phiAllowed: false, activation: 'blocked' });
  });
  it('refuses wrong callers, stacks, completion states, missing and duplicate outputs', () => {
    for (const bad of [undefined, {}, { Account: '173535830222' }]) expect(() => qualificationUpgradeFromAws(bad, { Stacks: [stack] })).toThrow('boundary_refused');
    for (const bad of [{}, { Stacks: [] }, { Stacks: [stack, stack] }, { Stacks: [{ ...stack, StackStatus: 'UPDATE_IN_PROGRESS' }] },
      { Stacks: [{ ...stack, StackId: stack.StackId.replace('qualification-foundation', 'synthetic-staging') }] },
      { Stacks: [{ ...stack, Outputs: stack.Outputs.slice(1) }] }, { Stacks: [{ ...stack, Outputs: [...stack.Outputs, stack.Outputs[0]] }] }]) {
      expect(() => qualificationUpgradeFromAws(caller, bad)).toThrow('boundary_refused');
    }
    for (const [key, value] of [['PhiAllowed', 'true'], ['Activation', 'approved'], ['QualificationExecution', 'enabled'], ['DatabaseName', 'clinical_core'],
      ['DatabaseSecretArn', values.DatabaseSecretArn.replace('588966314750', '173535830222')], ['DatabaseClusterArn', values.DatabaseClusterArn.replace('us-east-2', 'us-west-2')]]) {
      const Outputs = stack.Outputs.map(o => o.OutputKey === key ? { ...o, OutputValue: value } : o);
      expect(() => qualificationUpgradeFromAws(caller, { Stacks: [{ ...stack, Outputs }] })).toThrow('boundary_refused');
    }
  });
  it('pins CLI and SDK profiles and requires clean compiled source for writes', () => {
    const source = readFileSync('src/server/clinical-core/qualification-schema-upgrade-operator.ts', 'utf8');
    expect(source).toContain("'--profile', PROFILE"); expect(source).toContain('fromIni({ profile: PROFILE })');
    expect(source).toContain("confirmation !== '--confirm-qualification-upgrade' || !__QUALIFICATION_UPGRADE_BUILD__.clean");
    expect(source).not.toContain('process.env.CLINICAL_DATABASE');
  });
});
