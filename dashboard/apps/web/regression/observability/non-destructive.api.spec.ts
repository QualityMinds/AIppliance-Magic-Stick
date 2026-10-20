import {test,expect} from '@playwright/test';
import {readOnlyConnection,observeReadOnlyPhase} from '../core/non-destructive.ts';
import {realLogin} from '../core/auth.ts';
import {readPrivate} from '../core/private-files.ts';
import {verifiedEndpoint} from '../core/preflight.ts';
import {readOnlyApi} from '../core/transport.ts';
import {requireSafe} from '../core/errors.ts';
import {evidenceStep} from '../core/evidence.ts';

const phase=Number(process.env.REGRESSION_READONLY_PHASE);
test('HAR-01 HAR-02 [layer:A] non-destructive live TLS, viewer login, installation identity and selected-phase inventory',async({browser},info)=>{
  requireSafe(process.env.REGRESSION_TEST_MODE==='non-destructive'&&Number.isInteger(phase)&&phase>=0&&phase<=8,'CONFIG');
  requireSafe(process.env.REGRESSION_INPUT_DIR,'CONFIG');
  const config=await readOnlyConnection(process.env.REGRESSION_INPUT_DIR),blocked:string[]=[];
  await evidenceStep(info,[{id:'HAR-01',variant:`p${phase}-non-destructive-tls`,layer:'A'}],async()=>{
    const ca=await readPrivate(config.caFile);
    for(const url of [config.dashboardUrl,config.identityUrl])await verifiedEndpoint(url,config.requestTimeoutMs,ca);
  });
  const context=await realLogin(browser,config,{onBlockedMutation:request=>{blocked.push(request.method);}});
  try {
    await evidenceStep(info,[{id:'HAR-02',variant:`p${phase}-non-destructive-read`,layer:'A'}],async()=>{
      await observeReadOnlyPhase(readOnlyApi(context.request,config.dashboardUrl,config.requestTimeoutMs),phase,config);
      expect(blocked).toEqual([]);
    });
  } finally {await context.close();}
});
