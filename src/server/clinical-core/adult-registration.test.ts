import {describe,it,expect} from 'vitest';
import {ADULT_REGISTRATION_POLICY,isAdultRegistrationEligible} from './adult-registration';
const row={dateOfBirth:'2008-09-14',attestsAdult:true,registrationPolicy:ADULT_REGISTRATION_POLICY};
describe('adult self-service launch eligibility',()=>{
  it('accepts exactly 18, refuses the day before and never rounds by year',()=>{
    expect(isAdultRegistrationEligible(row,'2026-09-14')).toBe(true);
    expect(isAdultRegistrationEligible(row,'2026-09-13')).toBe(false);
    expect(isAdultRegistrationEligible({...row,dateOfBirth:'2008-12-31'},'2026-09-14')).toBe(false);
  });
  it('handles leap births conservatively without overflow',()=>{
    expect(isAdultRegistrationEligible({...row,dateOfBirth:'2008-02-29'},'2026-02-28')).toBe(false);
    expect(isAdultRegistrationEligible({...row,dateOfBirth:'2008-02-29'},'2026-03-01')).toBe(true);
  });
  it.each([undefined,null,{},[],{...row,attestsAdult:false},{...row,attestsAdult:'true'},
    {...row,registrationPolicy:'wrong'},{...row,dateOfBirth:'2026-02-30'},
    {...row,dateOfBirth:'2099-01-01'},{...row,dateOfBirth:'2000-01-01T00:00:00Z'},
    {...row,dateOfBirth:'2010-01-01'}])('refuses incomplete, malformed or minor input %j',value=>{
    expect(isAdultRegistrationEligible(value,'2026-09-14')).toBe(false);
  });
});
