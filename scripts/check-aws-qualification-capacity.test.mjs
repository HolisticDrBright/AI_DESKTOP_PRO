import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessCapacity,reservedFunctions} from './check-aws-qualification-capacity.mjs';
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
