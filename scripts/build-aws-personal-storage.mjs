import {build} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
import {personalStorageCandidate} from './personal-storage-candidate.mjs';
const out='dist/aws-clinical-core/personal-storage';mkdirSync(out,{recursive:true});
await build({entryPoints:['src/server/clinical-core/owned-consumer-api-lambda.ts'],outfile:`${out}/index.js`,bundle:true,platform:'node',target:'node22',format:'cjs',minify:true,legalComments:'none'});
// Intentionally not an activation template. No data-plane IAM or credentials.
const ref=name=>({Ref:name});const sub=value=>({'Fn::Sub':value});
const template={AWSTemplateFormatVersion:'2010-09-09',Description:'Disabled independent consumer storage endpoint; no PHI access',Parameters:{ApiId:{Type:'String',AllowedPattern:'[a-z0-9]{10}'},ConsumerAuthorizerId:{Type:'String'},ConsumerIssuer:{Type:'String'},ConsumerAudience:{Type:'String'},CodeBucket:{Type:'String'},CodeKey:{Type:'String'}},Resources:{
  Logs:{Type:'AWS::Logs::LogGroup',Properties:{LogGroupName:sub('/aws/lambda/${ApiId}-personal-storage-disabled'),RetentionInDays:14}},
  Role:{Type:'AWS::IAM::Role',Properties:{AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]},Policies:[{PolicyName:'bounded-logs-only',PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['logs:CreateLogStream','logs:PutLogEvents'],Resource:{'Fn::GetAtt':['Logs','Arn']}}]}}]}},
  Function:{Type:'AWS::Lambda::Function',Properties:{FunctionName:sub('${ApiId}-personal-storage-disabled'),Runtime:'nodejs22.x',Handler:'index.handler',Role:{'Fn::GetAtt':['Role','Arn']},Timeout:20,MemorySize:256,Code:{S3Bucket:ref('CodeBucket'),S3Key:ref('CodeKey')},Environment:{Variables:{CONSUMER_ISSUER:ref('ConsumerIssuer'),CONSUMER_AUDIENCE:ref('ConsumerAudience'),PHI_ALLOWED:'false',PERSONAL_STORAGE_ACTIVATION:'blocked',PERSONAL_STORAGE_ALLOWED_SCOPES:''}},LoggingConfig:{LogGroup:ref('Logs')}}},
  Integration:{Type:'AWS::ApiGatewayV2::Integration',Properties:{ApiId:ref('ApiId'),IntegrationType:'AWS_PROXY',IntegrationUri:{'Fn::GetAtt':['Function','Arn']},PayloadFormatVersion:'2.0'}},
  Invoke:{Type:'AWS::Lambda::Permission',Properties:{FunctionName:ref('Function'),Action:'lambda:InvokeFunction',Principal:'apigateway.amazonaws.com',SourceArn:sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*/clinical-core/consumer/personal/*')}}
},Outputs:{PhiAllowed:{Value:'false'},Activation:{Value:'blocked'}}};
['GET records','POST records','GET record','GET consent','POST consent','GET chat-context','POST privacy-export','GET privacy-export','GET active-plan','POST active-plan','POST active-plan/release','GET privacy-request','POST privacy-request','POST privacy-request/tombstone'].forEach((route,index)=>{const [method,resource]=route.split(' ');template.Resources[`Route${index}`]={Type:'AWS::ApiGatewayV2::Route',Properties:{ApiId:ref('ApiId'),RouteKey:`${method} /clinical-core/consumer/personal/${resource}`,AuthorizationType:'JWT',AuthorizerId:ref('ConsumerAuthorizerId'),Target:{'Fn::Join':['/',['integrations',ref('Integration')]]}}};});
writeFileSync(`${out}/disabled-template.json`,JSON.stringify(template,null,2));
writeFileSync(`${out}/template.json`,JSON.stringify(personalStorageCandidate(template),null,2));
console.log('Built personal storage Lambda, legacy disabled template and default-blocked production candidate. No deployment or activation.');
