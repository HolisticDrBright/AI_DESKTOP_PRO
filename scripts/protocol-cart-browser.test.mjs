/** Actual React panel in Chromium, with fictional in-memory transports only.
 * This is component lifecycle evidence, not hosted or device acceptance. */
import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {resolve} from 'node:path';

let browser, bundle;
const versionId='22222222-2222-4222-8222-222222222222';
before(async()=>{
  const result=await build({stdin:{contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ProtocolCartPanel} from './src/components/programs/ProtocolCartPanel';
    import {AppProgramAssignmentsPanel} from './src/components/programs/AppProgramAssignmentsPanel';
    const root=createRoot(document.getElementById('root'));
    window.renderCart=(id)=>root.render(<React.StrictMode><ProtocolCartPanel programVersionId={id}/></React.StrictMode>);
    window.unmountCart=()=>root.unmount();
    window.renderAssignments=()=>root.render(<React.StrictMode><AppProgramAssignmentsPanel/></React.StrictMode>);
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',
    jsx:'automatic',tsconfig:resolve('tsconfig.json'),define:{'process.env.NODE_ENV':'"development"'}});
  bundle=result.outputFiles[0].text;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();});

async function mount(t,assignments=false){
  const page=await browser.newPage();t.after(()=>page.close());
  // No document server, credentials, health data or real API is used.
  await page.route('**/*',route=>route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(()=>{
    const manifestId='11111111-1111-4111-8111-111111111111';
    window.cartFixture={mode:'valid',calls:[],pending:[],signals:[],readChange:{}};
    window.assignmentFixture={mode:'valid',calls:[],assigned:false};
    window.fetch=async(url,options)=>{
      if(url==='/api/live/program-assignments'){
        const request=JSON.parse(options.body),versionId='22222222-2222-4222-8222-222222222222';
        const fixture=window.assignmentFixture;
        fixture.calls.push(request);
        if(request.action==='assign'){
          if(fixture.mode==='conflict')return new Response('{}',{status:409});
          fixture.assigned=true;
          if(fixture.mode==='lost-reply')throw new Error('fictional_lost_reply_after_commit');
          return new Response(JSON.stringify({data:{action:'assign',enrollmentId:'88888888-8888-4888-8888-888888888888',
            sourceDigest:(fixture.mode==='wrong-receipt'?'e':'d').repeat(64),state:'offered',revision:'1',duplicate:false}}),{status:200});
        }
        if(request.action==='status'){
          if(fixture.mode==='status-unavailable')return new Response('{}',{status:503});
          if(fixture.mode==='status-denied')return new Response('{}',{status:403});
          return new Response(JSON.stringify({data:{action:'status',assignments:fixture.assigned?[{
            enrollmentId:'88888888-8888-4888-8888-888888888888',title:'Fictional assigned program',state:'offered',revision:'1',
            patientRecordId:'66666666-6666-4666-8666-666666666666',connectionId:'55555555-5555-4555-8555-555555555555',
            phaseIndex:0,phaseCount:1,finished:false,completedCount:0,assignedAt:'2026-10-08T12:00:00Z',updatedAt:'2026-10-08T12:00:00Z'}]:[]}}),{status:200});
        }
        const phases=[{id:'phase-1',title:'Fictional lesson phase',days:7,transition:'scheduled',
          items:[{id:'lesson-1',title:'Fictional lesson',kind:'lesson',instructions:'Fictional education only',released:true}]}];
        const data=request.action==='connections'
          ? {action:'connections',connections:[{connectionId:'55555555-5555-4555-8555-555555555555',
            patientRecordId:'66666666-6666-4666-8666-666666666666',verifiedAt:'2026-10-08T12:00:00Z'}]}
          : request.action==='programs'
            ? {action:'programs',programs:[{programVersionId:versionId,programId:'77777777-7777-4777-8777-777777777777',
              programVersion:'1',programName:'Fictional program',title:'Fictional program',phaseCount:1,assignable:true,
              publishedAt:'2026-10-08T12:00:00Z'}]}
            : {action:'preview',programVersionId:versionId,programVersion:'1',title:'Fictional preview',phases,
              sourceDigest:'d'.repeat(64),review:{planRevision:'fictional-1',inventoryComplete:false,
                add:['lesson-1'],duplicate:[],held:[],conflicts:[]}};
        return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
      }
      if(url!=='/api/live/protocol-carts')throw new Error('unexpected_transport');
      const request=JSON.parse(options.body),fixture=window.cartFixture;
      fixture.calls.push(request);fixture.signals.push(options.signal);
      if(fixture.mode==='deny')return new Response(JSON.stringify({error:'private_fixture_error'}),{status:403});
      const data=request.action==='compile'
        ? {action:'compile',manifestId,programVersion:1,includedCount:1,excludedCount:1,contentSha256:'b'.repeat(64),replayed:true}
        : {action:'read',manifestId,programVersionId:'22222222-2222-4222-8222-222222222222',programVersion:1,
          status:'compiled',versionContentSha256:'a'.repeat(64),contentSha256:'b'.repeat(64),includedCount:1,excludedCount:1,
          lines:[{phaseId:'phase-1',itemId:'item-1',title:'Fictional permitted product',productId:'product-1',dose:'Fictional reviewed dose',
            ingredientKeys:['fictional'],purchaseUrl:'https://shop.example.test/product',included:true,exclusionReason:null},
          {phaseId:'phase-1',itemId:'item-2',title:'Fictional held iron',productId:'product-2',dose:'Individual review only',
            ingredientKeys:['iron'],purchaseUrl:null,included:false,exclusionReason:'iron_requires_individual_review'}],
          delivery:{state:'not_implemented',detail:'Nothing sent'},...fixture.readChange};
      if(fixture.mode===request.action+'-pending')await new Promise(done=>fixture.pending.push(done));
      // Deliberately finish even after abort: the panel must reject late results too.
      return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
    };
  });
  await page.addScriptTag({content:bundle});
  if(assignments){
    await page.evaluate(()=>window.renderAssignments());
    await page.getByRole('button',{name:'Load linked patients'}).click();
    await page.getByLabel('Linked patient').selectOption('55555555-5555-4555-8555-555555555555');
    await page.getByRole('button',{name:'Load published programs',exact:true}).first().click();
    await page.getByLabel('Published program').selectOption(versionId);
    await page.getByTestId('program-preview').waitFor();
  }else await page.evaluate(id=>window.renderCart(id),versionId);
  await page.getByTestId('protocol-cart-compile').waitFor();
  return page;
}

test('StrictMode survives its setup/cleanup probe; exclusions and honest delivery remain visible',async t=>{
  const page=await mount(t);
  await page.getByTestId('protocol-cart-compile').click();
  await page.getByTestId('cart-line-included').waitFor();
  assert.match(await page.getByTestId('protocol-cart-source').innerText(),/1 to buy, 1 for you to decide/);
  assert.match(await page.getByTestId('cart-line-excluded').innerText(),/Fictional held iron/);
  assert.match(await page.getByTestId('protocol-cart-delivery').innerText(),/Nothing has been sent/);
  assert.match(await page.getByTestId('protocol-cart-notice').innerText(),/already built/);
  assert.deepEqual(await page.evaluate(()=>window.cartFixture.calls.map(call=>call.action)),['compile','read']);
});

test('a refused refresh clears the previously displayed list and does not expose server text',async t=>{
  const page=await mount(t);
  await page.getByTestId('protocol-cart-compile').click();
  await page.getByTestId('cart-line-included').waitFor();
  await page.evaluate(()=>{window.cartFixture.mode='deny';});
  await page.getByTestId('protocol-cart-compile').click();
  await page.getByTestId('protocol-cart-error').waitFor();
  assert.equal(await page.getByTestId('cart-line-included').count(),0);
  assert.equal(await page.getByTestId('protocol-cart-notice').count(),0);
  assert.doesNotMatch(await page.locator('body').innerText(),/private_fixture_error/);
});

for(const phase of ['compile','read'])test(`changing version aborts a pending ${phase} and refuses its late result`,async t=>{
  const page=await mount(t);
  await page.evaluate(phase=>{window.cartFixture.mode=phase+'-pending';},phase);
  await page.getByTestId('protocol-cart-compile').click();
  await page.waitForFunction(()=>window.cartFixture.pending.length===1);
  await page.evaluate(()=>window.renderCart('33333333-3333-4333-8333-333333333333'));
  await page.waitForFunction(()=>window.cartFixture.signals.every(signal=>signal.aborted));
  await page.evaluate(()=>{window.cartFixture.pending.splice(0).forEach(done=>done());});
  await page.getByTestId('protocol-cart-compile').waitFor({state:'visible'});
  assert.equal(await page.getByTestId('cart-line-included').count(),0);
  assert.equal(await page.getByTestId('protocol-cart-source').count(),0);
  // A subsequent real click against the new selection proves the old manifest cannot be reopened.
  await page.evaluate(()=>{window.cartFixture.mode='valid';});
  await page.getByTestId('protocol-cart-compile').click();
  await page.getByTestId('protocol-cart-error').waitFor();
  assert.equal(await page.getByTestId('cart-line-included').count(),0);
  assert.equal(await page.evaluate(()=>window.cartFixture.calls.filter(call=>call.action==='read').length),phase==='compile'?1:2);
});

test('a response for another manifest is never rendered',async t=>{
  const page=await mount(t);
  await page.evaluate(()=>{window.cartFixture.readChange={manifestId:'44444444-4444-4444-8444-444444444444'};});
  await page.getByTestId('protocol-cart-compile').click();
  await page.getByTestId('protocol-cart-error').waitFor();
  assert.equal(await page.getByTestId('cart-line-included').count(),0);
});

test('unmount aborts an in-flight read',async t=>{
  const page=await mount(t);
  await page.evaluate(()=>{window.cartFixture.mode='read-pending';});
  await page.getByTestId('protocol-cart-compile').click();
  await page.waitForFunction(()=>window.cartFixture.pending.length===1);
  await page.evaluate(()=>window.unmountCart());
  await page.waitForFunction(()=>window.cartFixture.signals.every(signal=>signal.aborted));
  await page.evaluate(()=>{window.cartFixture.pending.splice(0).forEach(done=>done());});
  assert.equal(await page.locator('#root').innerText(),'');
});

for(const reason of ['session','cross-tab','hidden'])test(`${reason} invalidation clears an opened list and requires a fresh request`,async t=>{
  const page=await mount(t);
  await page.getByTestId('protocol-cart-compile').click();
  await page.getByTestId('cart-line-included').waitFor();
  await page.evaluate(reason=>{
    window.cartFixture.mode='deny';
    if(reason==='session')window.dispatchEvent(new Event('alp-workforce-session-change'));
    else if(reason==='cross-tab')window.dispatchEvent(new StorageEvent('storage',{key:'alp-workforce-session-change'}));
    else {Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}
  },reason);
  await page.getByTestId('protocol-cart-error').waitFor({timeout:3000});
  assert.equal(await page.getByTestId('cart-line-included').count(),0);
  assert.equal(await page.getByTestId('protocol-cart-notice').count(),0);
  assert.equal(await page.evaluate(()=>window.cartFixture.calls.length),2);
  await page.getByTestId('protocol-cart-compile').click();
  await page.waitForFunction(()=>window.cartFixture.calls.length===3);
  assert.equal(await page.getByTestId('cart-line-included').count(),0);
});

test('a session change aborts a pending read and ignores a late authorized response',async t=>{
  const page=await mount(t);
  await page.evaluate(()=>{window.cartFixture.mode='read-pending';});
  await page.getByTestId('protocol-cart-compile').click();
  await page.waitForFunction(()=>window.cartFixture.pending.length===1);
  await page.evaluate(()=>window.dispatchEvent(new Event('alp-workforce-session-change')));
  await page.waitForFunction(()=>window.cartFixture.signals.every(signal=>signal.aborted),null,{timeout:3000});
  await page.evaluate(()=>{window.cartFixture.pending.splice(0).forEach(done=>done());});
  await page.getByTestId('protocol-cart-error').waitFor();
  assert.equal(await page.getByTestId('cart-line-included').count(),0);
});

for(const reason of ['session','cross-tab','hidden'])test(`assignment ${reason} invalidation drops both patient and program selection`,async t=>{
  const page=await mount(t,true);
  await page.getByTestId('protocol-cart-compile').click();
  await page.getByTestId('cart-line-included').waitFor();
  await page.evaluate(reason=>{
    if(reason==='session')window.dispatchEvent(new Event('alp-workforce-session-change'));
    else if(reason==='cross-tab')window.dispatchEvent(new StorageEvent('storage',{key:'alp-workforce-session-change'}));
    else {Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}
  },reason);
  await page.waitForFunction(()=>!document.querySelector('[data-testid="program-source-picker"]'),null,{timeout:3000});
  assert.equal(await page.getByTestId('protocol-cart').count(),0);
  assert.equal(await page.getByTestId('program-preview').count(),0);
  await page.getByRole('button',{name:'Load linked patients'}).click();
  assert.equal(await page.getByLabel('Linked patient').inputValue(),'');
});

test('a confirmed share refreshes assignment status once and preserves the confirmation',async t=>{
  const page=await mount(t,true);
  await page.getByRole('button',{name:'Share with this patient'}).click();
  await page.getByText('Fictional assigned program',{exact:true}).waitFor({timeout:3000});
  assert.match(await page.getByRole('status').innerText(),/Shared with the patient app/);
  assert.deepEqual(await page.evaluate(()=>window.assignmentFixture.calls.filter(call=>['assign','status'].includes(call.action)).map(call=>call.action)),['assign','status']);
});

test('an unavailable post-share read does not undo or misreport the confirmed assignment',async t=>{
  const page=await mount(t,true);
  await page.evaluate(()=>{window.assignmentFixture.mode='status-unavailable';});
  await page.getByRole('button',{name:'Share with this patient'}).click();
  await page.getByRole('alert').filter({hasText:'assignment list'}).waitFor({timeout:3000});
  assert.match(await page.getByRole('status').innerText(),/Shared with the patient app/);
  assert.equal(await page.evaluate(()=>window.assignmentFixture.calls.filter(call=>call.action==='assign').length),1);
  assert.doesNotMatch(await page.locator('body').innerText(),/Nothing was changed/);
});

test('a lost share reply is uncertain, never called unchanged or automatically retried',async t=>{
  const page=await mount(t,true);
  await page.evaluate(()=>{window.assignmentFixture.mode='lost-reply';});
  await page.getByRole('button',{name:'Share with this patient'}).click();
  await page.getByRole('alert').filter({hasText:'could not confirm'}).waitFor({timeout:3000});
  assert.doesNotMatch(await page.locator('body').innerText(),/Nothing was changed|Shared with the patient app/);
  assert.equal(await page.evaluate(()=>window.assignmentFixture.calls.filter(call=>call.action==='assign').length),1);
  assert.equal(await page.getByRole('button',{name:'Share with this patient'}).isDisabled(),true);
  await page.getByRole('button',{name:'Load / refresh assignments'}).click();
  await page.getByText('Fictional assigned program',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.assignmentFixture.calls.filter(call=>call.action==='assign').length),1);
});

test('an explicit share conflict is a refusal, never success or an automatic retry',async t=>{
  const page=await mount(t,true);
  await page.evaluate(()=>{window.assignmentFixture.mode='conflict';});
  await page.getByRole('button',{name:'Share with this patient'}).click();
  await page.getByRole('alert').filter({hasText:'Nothing was assigned'}).waitFor({timeout:3000});
  assert.doesNotMatch(await page.locator('body').innerText(),/could not confirm|Shared with the patient app/);
  assert.equal(await page.getByRole('status').count(),0);
  assert.equal(await page.evaluate(()=>window.assignmentFixture.assigned),false);
  assert.deepEqual(await page.evaluate(()=>window.assignmentFixture.calls.filter(call=>['assign','status'].includes(call.action)).map(call=>call.action)),['assign']);
});

test('a share receipt for other content is not presented as verified success',async t=>{
  const page=await mount(t,true);
  await page.evaluate(()=>{window.assignmentFixture.mode='wrong-receipt';});
  await page.getByRole('button',{name:'Share with this patient'}).click();
  await page.getByRole('alert').filter({hasText:'could not confirm'}).waitFor({timeout:3000});
  assert.equal(await page.getByRole('status').count(),0);
  assert.equal(await page.evaluate(()=>window.assignmentFixture.calls.filter(call=>call.action==='assign').length),1);
});

test('authorization loss during the post-share read drops the opened clinic context',async t=>{
  const page=await mount(t,true);
  await page.evaluate(()=>{window.assignmentFixture.mode='status-denied';});
  await page.getByRole('button',{name:'Share with this patient'}).click();
  await page.getByRole('alert').filter({hasText:'Access changed'}).waitFor({timeout:3000});
  assert.equal(await page.getByRole('status').count(),0);
  assert.equal(await page.getByLabel('Linked patient').count(),0);
  assert.equal(await page.getByTestId('program-source-picker').count(),0);
  assert.equal(await page.evaluate(()=>window.assignmentFixture.calls.filter(call=>call.action==='assign').length),1);
});
