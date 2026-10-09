import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessCapacity,reservedFunctions,CAPACITY_CANDIDATES,loadCapacityTemplate,assertCapacityPrincipal} from './check-aws-qualification-capacity.mjs';
import {loadTemplate} from './build-aws-qualification-parameters.mjs';
const f=[{name:'qualification-personal-storage',desired:4,existing:0}];
test('the actual ten-unit account refuses before deployment without weakening caps',()=>{
  const r=assessCapacity({ConcurrentExecutions:10,UnreservedConcurrentExecutions:10},f);
  assert.equal(r.ready,false);assert.equal(r.minimumTotalWithCurrentReservations,104);assert.equal(r.mutations,false);
});
test('existing reservations are not counted twice; reductions are not assumed released',()=>{
  assert.equal(assessCapacity({ConcurrentExecutions:150,UnreservedConcurrentExecutions:115},[{...f[0],existing:4}]).additionalReserved,0);
  assert.equal(assessCapacity({ConcurrentExecutions:150,UnreservedConcurrentExecutions:115},[{...f[0],existing:8}]).additionalReserved,0);
});
test('all 35 new reservations need at least 135 under the conservative floor',()=>{
  assert.equal(assessCapacity({ConcurrentExecutions:134,UnreservedConcurrentExecutions:134},[{...f[0],desired:35}]).ready,false);
  const r=assessCapacity({ConcurrentExecutions:135,UnreservedConcurrentExecutions:135},[{...f[0],desired:35}]);
  assert.equal(r.ready,true);assert.equal(r.positiveHostedAcceptance,false);
});
test('unknown, contradictory and malformed observations fail closed',()=>{
  for(const limits of [{},{ConcurrentExecutions:10,UnreservedConcurrentExecutions:11},{ConcurrentExecutions:Infinity,UnreservedConcurrentExecutions:10},{ConcurrentExecutions:10,UnreservedConcurrentExecutions:'10'}])assert.throws(()=>assessCapacity(limits,f));
  const limits={ConcurrentExecutions:150,UnreservedConcurrentExecutions:150};
  for(const functions of [[],[...f,...f],[{...f[0],existing:-1}],[{...f[0],desired:NaN}]])assert.throws(()=>assessCapacity(limits,functions));
});
test('template functions resolve only observed supported names and literal caps',()=>{
  const template={Resources:{Function:{Type:'AWS::Lambda::Function',Properties:{FunctionName:{'Fn::Sub':'${ApiId}-personal-storage'},ReservedConcurrentExecutions:4}}}};
  assert.deepEqual(reservedFunctions(template,'6zt8e9qz04'),[{name:'6zt8e9qz04-personal-storage',desired:4}]);
  template.Resources.Function.Properties.FunctionName={'Fn::Sub':'${Other}-personal-storage'};
  assert.throws(()=>reservedFunctions(template,'6zt8e9qz04'));
});
test('clinical API names resolve and unnamed functions get no invented physical name',()=>{
  const template={Resources:{Worker:{Type:'AWS::Lambda::Function',Properties:{FunctionName:{'Fn::Sub':'${ClinicalApiId}-worker'},ReservedConcurrentExecutions:4}},Voice:{Type:'AWS::Lambda::Function',Properties:{ReservedConcurrentExecutions:4}}}};
  assert.deepEqual(reservedFunctions(template,'6zt8e9qz04'),[{name:'6zt8e9qz04-worker',desired:4},{name:null,logicalId:'Voice',desired:4}]);
});
test('capacity preflight loads recording templates without a persisted dist artifact',()=>{
  const template=loadTemplate('recording-authority');
  const functions=reservedFunctions(template,'6zt8e9qz04');
  assert.ok(functions.some(f=>f.name==='6zt8e9qz04-recording-authority'&&f.desired===2));
});
test('messaging and connections add their exact reservations to fleet capacity',()=>{
  assert.equal(CAPACITY_CANDIDATES.length,12);assert.equal(new Set(CAPACITY_CANDIDATES).size,12);
  assert.ok(CAPACITY_CANDIDATES.includes('care-messaging'));
  assert.deepEqual(reservedFunctions(loadCapacityTemplate('care-messaging'),'6zt8e9qz04'),[{name:'6zt8e9qz04-care-messaging',desired:2}]);
  assert.ok(CAPACITY_CANDIDATES.includes('care-connections'));
  assert.deepEqual(reservedFunctions(loadCapacityTemplate('care-connections'),'6zt8e9qz04'),[{name:'6zt8e9qz04-care-connections',desired:2}]);
  const report=assessCapacity({ConcurrentExecutions:150,UnreservedConcurrentExecutions:136},[{name:'old-fleet',desired:35,existing:10},
    {name:'care-messaging',desired:2,existing:0},{name:'care-connections',desired:2,existing:0}]);
  assert.equal(report.requestedReserved,39);assert.equal(report.additionalReserved,29);assert.equal(report.ready,true);
  assert.equal(assessCapacity({ConcurrentExecutions:150,UnreservedConcurrentExecutions:128},[{name:'old-fleet',desired:35,existing:10},
    {name:'care-messaging',desired:2,existing:0},{name:'care-connections',desired:2,existing:0}]).ready,false);
});
test('capacity observation refuses root, IAM user, foreign account and missing principal',()=>{
  assert.doesNotThrow(()=>assertCapacityPrincipal({Account:'588966314750',Arn:'arn:aws:sts::588966314750:assumed-role/QualificationOperator/session'}));
  for(const identity of [{},{Account:'588966314750'},{Account:'588966314750',Arn:'arn:aws:iam::588966314750:root'},
    {Account:'588966314750',Arn:'arn:aws:iam::588966314750:user/operator'},{Account:'173535830222',Arn:'arn:aws:sts::173535830222:assumed-role/Operator/session'}])assert.throws(()=>assertCapacityPrincipal(identity),/synthetic_assumed_role_required/);
});
