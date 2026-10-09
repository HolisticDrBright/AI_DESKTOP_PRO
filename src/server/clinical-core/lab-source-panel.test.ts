import {describe,it,expect} from 'vitest';
import {resolveLabSourcePanel} from './lab-source-panel';
const panel={panelId:'fictional-panel',panelName:'Fictional panel',testDate:'2026-01-01'};
const context={dateOfBirth:'2000-01-01',observedOn:panel.testDate,sex:null,pregnancyStatus:null,cyclePhase:null,reproductiveStage:null,contraception:null,pregnancyTrimester:null,assayId:null};
describe('lab source provenance',()=>{
  it('retains saved panel dates without optional longitudinal history',()=>{
    expect(resolveLabSourcePanel({sourcePanel:panel})).toEqual(panel);
    expect(resolveLabSourcePanel({longitudinalContext:{incomingPanel:panel}})).toEqual(panel);
  });
  it('does not manufacture provenance for old jobs',()=>expect(resolveLabSourcePanel({})).toBeNull());
  it('rejects conflicts, invalid dates and unsupported authority',()=>{
    for(const patch of [{panelId:'other'},{panelName:'other'},{testDate:'2026-02-01'}])
      expect(()=>resolveLabSourcePanel({sourcePanel:panel,longitudinalContext:{incomingPanel:{...panel,...patch}}})).toThrow();
    for(const patch of [{testDate:'2026-02-30'},{testDate:'2099-01-01'},{approved:true}])
      expect(()=>resolveLabSourcePanel({sourcePanel:{...panel,...patch}})).toThrow();
  });
  it('requires per-marker collection time to agree with its panel',()=>{
    expect(resolveLabSourcePanel({sourcePanel:panel,structuredBiomarkers:[{collectionContext:context}]})).toEqual(panel);
    expect(()=>resolveLabSourcePanel({structuredBiomarkers:[{collectionContext:context}]})).toThrow('lab_collection_date_mismatch');
    expect(()=>resolveLabSourcePanel({sourcePanel:panel,structuredBiomarkers:[{collectionContext:{...context,observedOn:'2026-02-01'}}]})).toThrow('lab_collection_date_mismatch');
  });
});
