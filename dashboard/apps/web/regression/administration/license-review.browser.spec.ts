import {test,expect,type Browser,type Request} from '@playwright/test';
import type {LicenseStatus,LicensePreview} from '@magicstick/dashboard-contracts';
import {fixturePage,origin} from '../fixtures/dashboard.ts';
import {reviewLicenseUi} from './license-ui.cases.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
const annotation=evidenceAnnotations({id:'HAR-10',layer:'B'});
async function fixture(browser:Browser,options:{edition?:'free-registered'|'commercial';noOp?:boolean;failValidation?:boolean;failActivation?:boolean;wrongId?:boolean;poll?:boolean}={}) {
  const context=await browser.newContext({serviceWorkers:'block'}),document='synthetic-signed-document';
  let current:LicenseStatus={edition:'free',state:'missing',message:'Free mode.',valid:false,installationId:'fixture-installation',revision:'1',checkedAt:1,
    hasDocument:false,trustedKeyIds:['fixture-key'],features:[]};
  const claims={edition:options.edition??'free-registered',version:1,product:'magicstick',issuer:'magicstick',licenseId:'fixture-license',customer:'Fixture',
    installationId:'fixture-installation',features:options.edition==='commercial'?['commercial-production','federated-sso']:['federated-sso'],issuedAt:1,notBefore:1,expiresAt:4_000_000_000} as const;
  const candidate={valid:true,state:'valid',message:'Fixture verified.',keyId:'fixture-key',claims:{...claims,features:[...claims.features]}} as LicensePreview['candidate'];
  let activations=0,validations=0,reads=0,acknowledged=false;
  await fixturePage(context,{'/api/license':async(request:Request)=>{
    if(request.method()==='GET'){reads++;return current;}
    activations++;expect(request.postDataJSON()).toEqual({document,expectedRevision:'1'});
    current={...current,...candidate,hasDocument:true,revision:options.noOp?'1':'2',
      ...(options.wrongId?{claims:{...candidate.claims!,licenseId:'wrong-license'}}:{})};return current;
  },'/api/license/validate':async(request:Request)=>{
    validations++;expect(request.postDataJSON()).toEqual({document});await new Promise(resolve=>setTimeout(resolve,75));
    return {current,candidate};
  }});
  if(options.poll)await context.addInitScript(()=>{setInterval(()=>{void fetch('/api/license').catch(()=>{});},20);});
  if(options.failValidation||options.failActivation)await context.route(origin+(options.failValidation?'/api/license/validate':'/api/license'),async route=>{
    if(route.request().method()==='GET')await route.fallback();else await route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture unavailable"}'});
  });
  return {context,input:{origin,document,beforeRevision:'1',timeoutMs:2500},
    activate:{before:async()=>{},acknowledge:async(status:LicenseStatus)=>{acknowledged=true;expect(status.revision).toBe(options.noOp?'1':'2');}},
    counts:()=>({activations,validations,reads,acknowledged})};
}
test('LIC-02 the built UI previews both editions without sending activation, even with concurrent polling',annotation,async({browser})=>{
  for(const edition of ['free-registered','commercial'] as const) {
    const f=await fixture(browser,{edition,poll:true});
    try{const result=await reviewLicenseUi(f.context,f.input);expect(result.candidate.claims?.edition).toBe(edition);
      expect(f.counts().activations).toBe(0);expect(f.counts().validations).toBe(1);expect(f.context.pages()).toHaveLength(0);
    }finally{await f.context.close();}
  }
});
test('LIC-04 activation acknowledgement precedes postconditions and equal-document no-op revisions are accepted',annotation,async({browser})=>{
  for(const noOp of [false,true]) {
    const f=await fixture(browser,{noOp,poll:true});
    try{await reviewLicenseUi(f.context,{...f.input,activate:f.activate});expect(f.counts()).toMatchObject({activations:1,validations:1,acknowledged:true});
      expect(f.context.pages()).toHaveLength(0);
    }finally{await f.context.close();}
  }
});
test('LIC-02 LIC-04 unavailable APIs and wrong activation identity fail, rather than accepting a toast',annotation,async({browser})=>{
  for(const options of [{failValidation:true},{failActivation:true},{wrongId:true}]) {
    const f=await fixture(browser,options);
    try{await expect(reviewLicenseUi(f.context,{...f.input,activate:f.activate})).rejects.toMatchObject({outcome:'Failed',stage:options.failValidation?'license-review':'license-activate'});
      expect(f.counts().acknowledged).toBe(Boolean(options.wrongId));expect(f.context.pages()).toHaveLength(0);
    }finally{await f.context.close();}
  }
});
