import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {requireProof as requireSafe,HarnessError,atStage} from '../core/errors.ts';

const platforms={'macos-arm64':'darwin','macos-x64':'darwin','linux-x64':'linux','windows-x64':'win32'} as const;
export const companionAcceptanceCheck='magicstick-companion-acceptance';
export function validCompanionReport(value:any,platform:string,revision:string) {
  const native=value?.launchCheck;
  return Object.hasOwn(platforms,platform) && value?.version === 1 && value.platform === platform && value.sourceRevision === revision &&
    /^[0-9a-f]{64}$/.test(value.archiveSha256 ?? '') && native?.version === 1 && native.platform === platforms[platform as keyof typeof platforms] &&
    ['launcherVerified','transportVerified','loopbackAuthVerified','inferenceAuthorityVerified','originHostVerified','isolatedStateVerified'].every(key=>native[key] === true) &&
    native.meshInferenceVerified === false;
}
/** Public GitHub-owned check output replaces credential-only artifact downloads.
 * The successful fixed workflow/run and every native platform remain mandatory. */
export function publicCompanionProof(checks:any,run:any,revision:string) {
  requireSafe(Array.isArray(checks?.check_runs),'API');
  requireSafe(Number.isSafeInteger(run.id)&&run.id>0&&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0,'API');
  const identity=`${run.id}:${run.run_attempt}`;
  const matches=checks.check_runs.filter((check:any)=>check.name===companionAcceptanceCheck && check.external_id===identity);
  if(!matches.length)return;
  requireSafe(matches.length===1,'REVISION');const check=matches[0];
  requireSafe(check.app?.slug==='github-actions' && check.head_sha===revision && check.status==='completed' &&
    check.conclusion==='success' && check.details_url===`https://github.com/QualityMinds/AIppliance-Magic-Stick/actions/runs/${run.id}`,'REVISION');
  requireSafe(typeof check.output?.text==='string' && Buffer.byteLength(check.output.text)<=48*1024,'API');
  let proof;try{proof=JSON.parse(check.output.text);}catch{throw new HarnessError('API','Failed','companion-evidence');}
  requireSafe(proof?.version===1 && proof.runId===run.id && proof.runAttempt===run.run_attempt && proof.sourceRevision===revision &&
    Array.isArray(proof.reports) && proof.reports.length===Object.keys(platforms).length,'REVISION');
  requireSafe(Object.keys(platforms).every(platform=>proof.reports.filter((report:any)=>report?.platform===platform &&
    validCompanionReport(report,platform,revision)).length===1),'API');
  return proof.reports.map((report:any)=>({platform:report.platform,archiveSha256:report.archiveSha256}));
}
/** Preparation must select the workflow attempt whose proof the live adapter
 * can actually read. A newer PR build has artifacts but no public proof. */
export async function discoverCompanionRun(runs:any[],checks:any,revision:string,
  artifacts:(runId:number)=>Promise<any>,legacyToken=false) {
  requireSafe(Array.isArray(runs),'API');
  const publicRuns=runs.filter(run=>['push','workflow_dispatch'].includes(run.event) &&
    publicCompanionProof(checks,run,revision));
  const publicIds=new Set(publicRuns.map(run=>run.id));
  for(const run of [...publicRuns,...(legacyToken?runs.filter(run=>!publicIds.has(run.id)):[])]) {
    const listing=await artifacts(run.id);
    if(Object.keys(platforms).every(platform=>listing.artifacts?.filter((item:any)=>
      item.name==='companion-acceptance-'+platform&&!item.expired).length===1))return run;
  }
}
/** Native binaries cannot be executed on four OSes inside one Linux container.
 * Consume freshly verified, commit-bound native build-matrix evidence from the
 * fixed repository/workflow. Never accept arbitrary uploaded local pass files. */
export async function companionWorkflow(live:LiveFoundation) {
  return atStage('companion-evidence',()=>collectCompanionEvidence(live));
}
async function collectCompanionEvidence(live:LiveFoundation) {
  const plan=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)).companion;
  requireSafe(Number.isSafeInteger(plan?.runId) && plan.runId > 0 && /^[0-9a-f]{40}$/.test(plan.sourceRevision ?? ''),'PREREQUISITE');
  const headers:Record<string,string>={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  if(plan.tokenFile)headers.Authorization='Bearer '+(await readPrivate(plan.tokenFile)).trim();
  const root='https://api.github.com/repos/QualityMinds/AIppliance-Magic-Stick/actions';
  const get=async(path:string)=>{
    const response=await live.context.request.get(root+path,{headers,timeout:live.config.requestTimeoutMs,maxRedirects:0});
    requireSafe(response.status() === 200 && (await response.body()).length < 512*1024,'API');return response.json();
  };
  const run=await get('/runs/'+plan.runId);
  const updated=Date.parse(run.updated_at);
  requireSafe(run.head_sha === plan.sourceRevision && live.config.expected.flux?.revision.endsWith(plan.sourceRevision) &&
    run.repository?.full_name === 'QualityMinds/AIppliance-Magic-Stick' && run.path === '.github/workflows/build-mesh-companion.yml' &&
    run.status === 'completed' && run.conclusion === 'success' && Number.isFinite(updated) && updated <= Date.now() &&
    Date.now()-updated < 30*86400_000,'REVISION');
  const checksResponse=await live.context.request.get('https://api.github.com/repos/QualityMinds/AIppliance-Magic-Stick/commits/'+
    plan.sourceRevision+'/check-runs?check_name='+companionAcceptanceCheck+'&filter=all&per_page=100',
    {headers,timeout:live.config.requestTimeoutMs,maxRedirects:0});
  requireSafe(checksResponse.status()===200 && (await checksResponse.body()).length<512*1024,'API');
  const proof=publicCompanionProof(await checksResponse.json(),run,plan.sourceRevision);
  if(proof) {
    await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'companion-acceptance.json'),{version:1,runId:plan.runId,
      sourceRevision:plan.sourceRevision,evidence:proof,proofSource:'github-check',meshInferenceVerified:false},true);
    return;
  }
  // Legacy Actions ZIPs are private even for a public repository. Never begin
  // a doomed anonymous download or turn missing access into a product failure.
  if(!plan.tokenFile)throw new HarnessError('CI_ACCESS','Blocked','companion-evidence');
  const listing=await get('/runs/'+plan.runId+'/artifacts?per_page=100');
  requireSafe(Array.isArray(listing.artifacts),'API');
  const evidence=[];
  for(const platform of Object.keys(platforms)) {
    const matches=listing.artifacts.filter((item:any)=>item.name === 'companion-acceptance-'+platform && !item.expired);
    requireSafe(matches.length === 1 && matches[0].size_in_bytes < 128*1024,'PREREQUISITE');
    const response=await live.context.request.get(root+'/artifacts/'+matches[0].id+'/zip',{headers,timeout:live.config.requestTimeoutMs,maxRedirects:0});
    requireSafe(response.status() === 302,'API');const location=new URL(response.headers().location ?? '');
    requireSafe(location.protocol === 'https:' && (location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.githubusercontent.com')),'TLS');
    // Do not forward the GitHub credential to the signed storage download.
    const archive=await live.context.request.get(location.href,{timeout:live.config.requestTimeoutMs,maxRedirects:0});
    const bytes=await archive.body();requireSafe(archive.status() === 200 && bytes.length < 128*1024,'API');
    let report;
    try {report=JSON.parse(execFileSync('python3',['-c',
      'import sys,io,json,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); i=z.infolist(); assert len(i)==1 and i[0].file_size<32768 and i[0].filename.endswith(".acceptance.json"); print(json.dumps(json.loads(z.read(i[0]))))'],
      {input:bytes,encoding:'utf8',timeout:5000,maxBuffer:64*1024}));}
    catch {requireSafe(false,'API');}
    requireSafe(validCompanionReport(report,platform,plan.sourceRevision),'API');
    evidence.push({platform,artifactId:matches[0].id,archiveSha256:report.archiveSha256});
  }
  await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'companion-acceptance.json'),{version:1,runId:plan.runId,sourceRevision:plan.sourceRevision,evidence,meshInferenceVerified:false},true);
}
