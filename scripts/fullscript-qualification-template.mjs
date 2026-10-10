// Restricted source candidate only; generation makes no AWS calls or reviews.
const ref=name=>({Ref:name}),sub=text=>({'Fn::Sub':text}),get=(name,attribute)=>({'Fn::GetAtt':[name,attribute]});
const str=(pattern,extra={})=>({Type:'String',AllowedPattern:pattern,...extra});
export function fullscriptQualificationTemplate(build){
 if(build?.contract!=='fullscript-api-build/1'||build.clean!==true||!/^[a-f0-9]{40}$/.test(build.sourceCommit??'')
  ||!/^[a-f0-9]{64}$/.test(build.zipSha256??'')||!/^[A-Za-z0-9+/]{43}=$/.test(build.codeSha256??'')
  ||Buffer.from(build.zipSha256,'hex').toString('base64')!==build.codeSha256||build.handler!=='index.handler'||build.runtime!=='nodejs22.x'
  ||build.phiAllowed!==false||build.activation!=='blocked'||build.execution!=='qualification_only'
  ||build.deployed!==false||build.targetEmbedded!==false||build.hostedQualified!==false)throw Error('fullscript_template_build_refused');
 const secret='^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$';
 const kms='^arn:aws:kms:us-east-2:588966314750:key/[a-f0-9-]{36}$';
 const source=build.sourceCommit;
 const t={AWSTemplateFormatVersion:'2010-09-09',Description:'Fullscript fictional qualification only; PHI and production remain blocked',
  Metadata:{Contract:'fullscript-qualification-candidate/1',SourceCommit:source,ZipSha256:build.zipSha256,
   TargetContract:'fullscript-qualification-target-release/2',MigrationCount:111,ApprovedForPhi:false,HostedQualified:false},
  Parameters:{
   QualificationExecution:{Type:'String',Default:'false',AllowedValues:['false','true']},
   PhiAllowed:{Type:'String',Default:'false',AllowedValues:['false']},Activation:{Type:'String',Default:'blocked',AllowedValues:['blocked']},
   SourceCommit:{Type:'String',Default:source,AllowedValues:[source]},CodeSha256:{Type:'String',Default:build.codeSha256,AllowedValues:[build.codeSha256]},
   FunctionName:str('^alp-fullscript-qualification-[a-z0-9-]{1,30}$'),ApiId:str('^[a-z0-9]{10}$'),
   ConsumerAudience:str('^[A-Za-z0-9]{20,128}$'),WorkforceAudience:str('^[A-Za-z0-9]{20,128}$'),
   ConsumerPoolId:str('^us-east-2_[A-Za-z0-9]+$'),WorkforcePoolId:str('^us-east-2_[A-Za-z0-9]+$'),
   OrganizationId:str('^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
   CodeKey:{Type:'String',Default:`fullscript/qualification-api/${source}/function.zip`,AllowedValues:[`fullscript/qualification-api/${source}/function.zip`]},CodeObjectVersion:str('^[A-Za-z0-9_.+/=-]{1,1024}$'),
   TargetKey:str('^fullscript/qualification-target/[a-f0-9]{32}/target\\.json$'),TargetObjectVersion:str('^[A-Za-z0-9_.+/=-]{1,1024}$'),
   TargetReviewSha256:str('^(?!0{64}$)[a-f0-9]{64}$'),
   DatabaseName:{Type:'String',Default:'clinical_core_qualification',AllowedValues:['clinical_core_qualification']},
   DatabaseClusterArn:str('^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]+$'),DatabaseSecretArn:str(secret),
   DatabaseSecretKmsKeyArn:str('^$|'+kms,{Default:''}),ProviderSecretArn:str(secret),ProviderSecretVersion:str('^[A-Za-z0-9-]{32,64}$'),
   ProviderSecretKmsKeyArn:str('^$|'+kms,{Default:''}),TokenTableName:str('^[A-Za-z0-9_.-]{3,255}$'),
   RedirectUri:str('^https://[^/?#@]+/api/live/fullscript/oauth/callback$'),
   AlarmTopicArn:str('^arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms$'),
  },
  Conditions:{
   Enabled:{'Fn::And':[{'Fn::Equals':[ref('QualificationExecution'),'true']},{'Fn::Equals':[ref('AWS::AccountId'),'588966314750']},
    {'Fn::Equals':[ref('AWS::Region'),'us-east-2']},{'Fn::Not':[{'Fn::Equals':[ref('ProviderSecretArn'),ref('DatabaseSecretArn')]}]},
    {'Fn::Not':[{'Fn::Equals':[ref('ConsumerAudience'),ref('WorkforceAudience')]}]},
    {'Fn::Not':[{'Fn::Equals':[ref('ConsumerPoolId'),ref('WorkforcePoolId')]}]},
    {'Fn::Not':[{'Fn::Equals':[ref('TargetObjectVersion'),'null']}]},{'Fn::Not':[{'Fn::Equals':[ref('CodeObjectVersion'),'null']}]}]},
   ProviderKey:{'Fn::Not':[{'Fn::Equals':[ref('ProviderSecretKmsKeyArn'),'']}]},
   DatabaseKey:{'Fn::Not':[{'Fn::Equals':[ref('DatabaseSecretKmsKeyArn'),'']}]},
  },Resources:{},Outputs:{}};
 const codeBucket='alp-qualification-code-588966314750-us-east-2';
 t.Resources.Logs={Type:'AWS::Logs::LogGroup',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{
  LogGroupName:sub('/aws/lambda/${FunctionName}'),RetentionInDays:14}};
 const allow=(Sid,Action,Resource,Condition)=>({Sid,Effect:'Allow',Action,Resource,...(Condition?{Condition}:{})});
 const statements=[
  allow('FunctionLogs',['logs:CreateLogStream','logs:PutLogEvents'],sub('arn:aws:logs:us-east-2:588966314750:log-group:/aws/lambda/${FunctionName}:*')),
  allow('ExactTargetVersion',['s3:GetObjectVersion'],sub(`arn:aws:s3:::${codeBucket}/\${TargetKey}`),{StringEquals:{'s3:VersionId':ref('TargetObjectVersion')}}),
  allow('ObservedFunction',['lambda:GetFunctionConfiguration'],sub('arn:aws:lambda:us-east-2:588966314750:function:${FunctionName}:*')),
  allow('ObservedRoute',['apigateway:GET'],['routes','authorizers','integrations'].map(path=>sub('arn:aws:apigateway:us-east-2::/apis/${ApiId}/'+path+'/*'))),
  allow('CurrentUsers',['cognito-idp:DescribeUserPool','cognito-idp:DescribeUserPoolClient','cognito-idp:AdminGetUser'],
   ['ConsumerPoolId','WorkforcePoolId'].map(pool=>sub('arn:aws:cognito-idp:us-east-2:588966314750:userpool/${'+pool+'}'))),
  allow('DatabaseTransactions',['rds-data:BeginTransaction','rds-data:ExecuteStatement','rds-data:CommitTransaction','rds-data:RollbackTransaction'],ref('DatabaseClusterArn')),
  allow('DatabaseCredential',['secretsmanager:GetSecretValue'],ref('DatabaseSecretArn')),
  allow('PinnedProviderCredential',['secretsmanager:GetSecretValue'],ref('ProviderSecretArn'),{StringEquals:{'secretsmanager:VersionId':ref('ProviderSecretVersion')}}),
  allow('ClinicCredentialCustody',['dynamodb:GetItem','dynamodb:PutItem'],sub('arn:aws:dynamodb:us-east-2:588966314750:table/${TokenTableName}'),
   {'ForAllValues:StringEquals':{'dynamodb:LeadingKeys':[sub('ORG#${OrganizationId}')]}}),
  ...['Provider','Database'].map(kind=>({'Fn::If':[kind+'Key',allow(kind+'SecretDecrypt',['kms:Decrypt'],ref(kind+'SecretKmsKeyArn'),
   {StringEquals:{'kms:ViaService':'secretsmanager.us-east-2.amazonaws.com','kms:EncryptionContext:SecretARN':ref(kind+'SecretArn')}}),ref('AWS::NoValue')]})),
 ];
 t.Resources.Role={Type:'AWS::IAM::Role',Condition:'Enabled',Properties:{AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{
  Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]},Policies:[{PolicyName:'fullscript-qualification-only',
   PolicyDocument:{Version:'2012-10-17',Statement:statements}}]}};
 const variables={NODE_ENV:'production',PHI_ALLOWED:ref('PhiAllowed'),PRODUCTION_ACTIVATION:ref('Activation'),
  QUALIFICATION_EXECUTION:'true',QUALIFICATION_ACCOUNT_ID:'588966314750',FULLSCRIPT_SOURCE_COMMIT:ref('SourceCommit'),
  FULLSCRIPT_TARGET_BUCKET:codeBucket,FULLSCRIPT_TARGET_KEY:ref('TargetKey'),FULLSCRIPT_TARGET_VERSION:ref('TargetObjectVersion'),
  QUALIFICATION_REVIEW_SHA256:ref('TargetReviewSha256'),CLINICAL_DATABASE_NAME:ref('DatabaseName'),
  CLINICAL_DATABASE_CLUSTER_ARN:ref('DatabaseClusterArn'),CLINICAL_DATABASE_SECRET_ARN:ref('DatabaseSecretArn'),
  FULLSCRIPT_PROVIDER_SECRET_ARN:ref('ProviderSecretArn'),FULLSCRIPT_PROVIDER_SECRET_VERSION:ref('ProviderSecretVersion'),
  FULLSCRIPT_TOKEN_TABLE:ref('TokenTableName'),FULLSCRIPT_REDIRECT_URI:ref('RedirectUri')};
 t.Resources.Function={Type:'AWS::Lambda::Function',Condition:'Enabled',DependsOn:'Logs',Properties:{FunctionName:ref('FunctionName'),
  Runtime:'nodejs22.x',Handler:'index.handler',Role:get('Role','Arn'),Timeout:30,MemorySize:512,ReservedConcurrentExecutions:1,
  Code:{S3Bucket:codeBucket,S3Key:ref('CodeKey'),S3ObjectVersion:ref('CodeObjectVersion')},Environment:{Variables:variables}}};
 t.Resources.Version={Type:'AWS::Lambda::Version',Condition:'Enabled',Properties:{FunctionName:ref('Function'),CodeSha256:ref('CodeSha256'),
  Description:sub('Source ${SourceCommit}; target ${TargetReviewSha256}')}};
 t.Resources.Integration={Type:'AWS::ApiGatewayV2::Integration',Condition:'Enabled',Properties:{ApiId:ref('ApiId'),IntegrationType:'AWS_PROXY',
  IntegrationUri:ref('Version'),PayloadFormatVersion:'2.0',TimeoutInMillis:30000}};
 for(const role of ['Consumer','Workforce']){
  const path='/clinical-core/'+role.toLowerCase()+'/fullscript/draft';
  t.Resources[role+'Authorizer']={Type:'AWS::ApiGatewayV2::Authorizer',Condition:'Enabled',Properties:{ApiId:ref('ApiId'),
   Name:sub('${FunctionName}-'+role.toLowerCase()),AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],
   JwtConfiguration:{Issuer:sub('https://cognito-idp.us-east-2.amazonaws.com/${'+role+'PoolId}'),Audience:[ref(role+'Audience')]}}};
  t.Resources[role+'Permission']={Type:'AWS::Lambda::Permission',Condition:'Enabled',Properties:{FunctionName:ref('Version'),
   Action:'lambda:InvokeFunction',Principal:'apigateway.amazonaws.com',SourceAccount:'588966314750',
   SourceArn:sub('arn:aws:execute-api:us-east-2:588966314750:${ApiId}/*/POST'+path)}};
  t.Resources[role+'Route']={Type:'AWS::ApiGatewayV2::Route',Condition:'Enabled',DependsOn:role+'Permission',Properties:{ApiId:ref('ApiId'),
   RouteKey:'POST '+path,AuthorizationType:'JWT',AuthorizerId:ref(role+'Authorizer'),Target:sub('integrations/${Integration}')}};
 }
 for(const metric of ['Errors','Throttles'])t.Resources[metric+'Alarm']={Type:'AWS::CloudWatch::Alarm',Condition:'Enabled',Properties:{
  AlarmDescription:'Fictional Fullscript qualification '+metric+'; no clinical payload',Namespace:'AWS/Lambda',MetricName:metric,
  Dimensions:[{Name:'FunctionName',Value:ref('FunctionName')}],Statistic:'Sum',Period:60,EvaluationPeriods:1,Threshold:1,
  ComparisonOperator:'GreaterThanOrEqualToThreshold',TreatMissingData:'notBreaching',AlarmActions:[ref('AlarmTopicArn')]}};
 t.Outputs.SourceCommit={Value:ref('SourceCommit')};t.Outputs.PhiAllowed={Value:'false'};t.Outputs.Activation={Value:'blocked'};
 t.Outputs.Execution={Value:{'Fn::If':['Enabled','qualification','disabled']}};
 t.Outputs.FunctionArn={Condition:'Enabled',Value:get('Function','Arn')};t.Outputs.PublishedVersionArn={Condition:'Enabled',Value:ref('Version')};
 return t;
}
