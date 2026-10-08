import {describe,expect,it} from 'vitest';
import {parseProtocolCartResponse} from './protocolCarts';

const manifestId='11111111-1111-4111-8111-111111111111';
export const cartFixture=()=>({action:'read' as const,manifestId,
  programVersionId:'22222222-2222-4222-8222-222222222222',programVersion:1,status:'compiled' as const,
  versionContentSha256:'a'.repeat(64),contentSha256:'b'.repeat(64),includedCount:1,excludedCount:0,
  lines:[{phaseId:'phase-1',itemId:'item-1',title:'Fictional product',productId:'product-1',dose:'Reviewed fictional dose',
    ingredientKeys:['fictional-ingredient'],purchaseUrl:'https://shop.example.test/product',included:true,exclusionReason:null}],
  delivery:{state:'not_implemented' as const,detail:'Nothing sent'},
});
const request={action:'read' as const,manifestId};
describe('protocol cart response integrity',()=>{
  it('accepts consistent included and excluded manifests',()=>{
    expect(parseProtocolCartResponse(request,cartFixture())).toEqual(cartFixture());
    const excluded=cartFixture();excluded.lines[0].included=false;
    Object.assign(excluded.lines[0],{purchaseUrl:null,exclusionReason:'no_purchase_destination'});
    excluded.includedCount=0;excluded.excludedCount=1;
    expect(parseProtocolCartResponse(request,excluded)).toEqual(excluded);
  });
  it('refuses a different manifest instead of displaying it for the requested chart',()=>{
    expect(()=>parseProtocolCartResponse({...request,manifestId:'33333333-3333-4333-8333-333333333333'},cartFixture())).toThrow();
  });
  it('refuses displayed counts that disagree with the actual lines',()=>{
    for(const counts of [{includedCount:2},{excludedCount:1},{includedCount:0,excludedCount:1}])
      expect(()=>parseProtocolCartResponse(request,{...cartFixture(),...counts})).toThrow();
  });
  it('refuses contradictory inclusion and exclusion flags',()=>{
    for(const change of [{included:false},{exclusionReason:'iron_requires_individual_review'},{purchaseUrl:null}]){
      const data=cartFixture();Object.assign(data.lines[0],change);
      expect(()=>parseProtocolCartResponse(request,data)).toThrow();
    }
  });
  it('refuses duplicate phase/item lines rather than counting them as another product',()=>{
    const data=cartFixture();data.lines.push({...data.lines[0]});data.includedCount=2;
    expect(()=>parseProtocolCartResponse(request,data)).toThrow();
  });
  it('refuses executable, insecure and credential-bearing purchase destinations',()=>{
    for(const purchaseUrl of ['javascript:alert(1)','http://shop.example.test/item','https://user:pass@shop.example.test/item']){
      const data=cartFixture();data.lines[0].purchaseUrl=purchaseUrl;
      expect(()=>parseProtocolCartResponse(request,data)).toThrow();
    }
  });
});
