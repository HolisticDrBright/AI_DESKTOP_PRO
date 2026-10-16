import { readFileSync, writeFileSync } from 'node:fs';

const sourcePath = new URL('../infra/aws-clinical-core/identity-api-extension.json', import.meta.url);
const outputPath = new URL('../infra/aws-clinical-core/qualification-program-api-candidate.json', import.meta.url);
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));

// This candidate is intentionally not a second deployment of the full staging
// identity stack. Qualification already has independently owned clinical routes.
const resourceNames = [
  'IdentityApiLogGroup', 'IdentityApiRole', 'IdentityApiFunction',
  'WorkforceJwtAuthorizer', 'ConsumerJwtAuthorizer', 'IdentityApiIntegration',
  'ConsumerProgramAssignmentsRoute', 'WorkforceProgramAssignmentsRoute',
  'IdentityApiErrorAlarm',
];
for (const name of resourceNames) {
  if (!source.Resources[name]) throw new Error(`program_qualification_source_missing:${name}`);
}
const resources = Object.fromEntries(resourceNames.map(name => [name, structuredClone(source.Resources[name])]));
const parameters = structuredClone(source.Parameters);
parameters.ClinicalApiId.AllowedValues = ['6zt8e9qz04'];
parameters.WorkforceUserPoolId.AllowedValues = ['us-east-2_ueGlFRbNB'];
parameters.WorkforceUserPoolClientId.AllowedValues = ['4s7jgr4o8sqdq7cvo9gmq96e2h'];
parameters.ConsumerUserPoolId.AllowedValues = ['us-east-2_nYngyyYGE'];
parameters.ConsumerUserPoolClientId.AllowedValues = ['72aksm2dm4nf03l8d9nrp2dbh0'];
parameters.DatabaseClusterArn.AllowedValues = [
  'arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa',
];
parameters.DatabaseSecretArn.AllowedPattern = '^arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-[A-Za-z0-9-]+$';
parameters.DatabaseName.AllowedValues = ['clinical_core_qualification'];
parameters.ClinicalCoreKeyArn.AllowedValues = [
  'arn:aws:kms:us-east-2:588966314750:key/519c32c7-8dae-4722-9ab2-cd54e9a56611',
];
parameters.LambdaCodeBucket.AllowedValues = ['alp-qualification-code-588966314750-us-east-2'];
parameters.SourceCommit = { Type: 'String', AllowedPattern: '^[0-9a-f]{40}$' };
parameters.AlarmTopicArn = {
  Type: 'String',
  AllowedValues: ['arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms'],
};

resources.IdentityApiLogGroup.Properties.LogGroupName = {
  // The qualification foundation's log KMS policy admits /aws/lambda/6zt8e9qz04-*
  // but not an arbitrary /ai-clinical-core/qualification/* group.
  'Fn::Sub': '/aws/lambda/${ClinicalApiId}-qualification-programs',
};
resources.IdentityApiFunction.Properties.FunctionName = {
  'Fn::Sub': '${ClinicalApiId}-qualification-programs',
};
resources.IdentityApiFunction.Properties.Environment.Variables = {
  ...resources.IdentityApiFunction.Properties.Environment.Variables,
  DEPLOYMENT_ACCOUNT_ID: '588966314750',
  PHI_ALLOWED: 'false',
  QUALIFICATION_EXECUTION: 'programs',
  SOURCE_COMMIT: { Ref: 'SourceCommit' },
};
resources.WorkforceJwtAuthorizer.Properties.Name = 'qualification-program-workforce';
resources.ConsumerJwtAuthorizer.Properties.Name = 'qualification-program-consumer';
resources.IdentityApiErrorAlarm.Properties.AlarmDescription = 'Fictional qualification program API Lambda errors';
resources.IdentityApiErrorAlarm.Properties.AlarmName = 'ai-clinical-core-qualification-program-api-errors';
resources.IdentityApiErrorAlarm.Properties.AlarmActions = [{ Ref: 'AlarmTopicArn' }];

const invokePermission = path => ({
  Type: 'AWS::Lambda::Permission',
  Properties: {
    Action: 'lambda:InvokeFunction',
    FunctionName: { Ref: 'IdentityApiFunction' },
    Principal: 'apigateway.amazonaws.com',
    SourceArn: {
      'Fn::Sub': `arn:\${AWS::Partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${ClinicalApiId}/*/POST/clinical-core/${path}/programs`,
    },
  },
});
resources.ConsumerProgramInvokePermission = invokePermission('consumer');
resources.WorkforceProgramInvokePermission = invokePermission('workforce');

const candidate = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'BLOCKED fictional-only qualification overlay for two program assignment routes; no production or PHI activation.',
  Metadata: {
    ClinicalCore: {
      ContractVersion: 'qualification-program-api-candidate/1',
      Environment: 'isolated-qualification',
      DataClassification: 'synthetic_only',
      AccountId: '588966314750',
      PhiAllowed: false,
      Activation: 'blocked',
      SourceTemplate: 'infra/aws-clinical-core/identity-api-extension.json',
      RuntimeSchemaRequirement: {
        Adapter: 'synthetic_program_assignments',
        Function: 'clinical_core.program_assignment_request(jsonb)',
        ParentTable: 'clinical_core.synthetic_desktop_program_versions',
        ProductionFunctionIsNotCompatible: 'clinical_core.production_program_assignment_request(jsonb)',
      },
    },
  },
  Parameters: parameters,
  Resources: resources,
  Outputs: {
    FunctionArn: { Value: { 'Fn::GetAtt': ['IdentityApiFunction', 'Arn'] } },
    QualificationExecution: { Value: 'programs_fictional_only' },
    PhiAllowed: { Value: 'false' },
  },
};

const rendered = `${JSON.stringify(candidate, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8').replaceAll('\r\n', '\n') !== rendered) {
    throw new Error('qualification_program_api_candidate_drift');
  }
} else {
  writeFileSync(outputPath, rendered);
}
