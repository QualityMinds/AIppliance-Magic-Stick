import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {lstat,open,rename,rm,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {HarnessError} from './errors.ts';
import {publicResult} from './kubernetes-progress.ts';

export const maximumReportBytes=64*1024*1024;
const products=['summary.html','junit.xml','report-artifacts.tar.gz'] as const;

/** Validate the whole export before making any download visible. Private input
 * bounds remain unchanged; only these generated, sanitized files may export. */
export async function publishReportArtifacts(directory:string,published:string) {
  const sources:Array<{name:typeof products[number];handle:FileHandle}>=[];
  try {
    for(const path of [directory,published]) {
      const stat=await lstat(path);
      if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error();
    }
    for(const name of products) {
      // Bind validation and reads to the same open file, not a re-opened path.
      const handle=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);sources.push({name,handle});
      const stat=await handle.stat();
      if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>maximumReportBytes)throw new Error();
    }
    for(const {name,handle} of sources) {
      const temporary=join(published,'.export-'+randomUUID());let target:FileHandle|undefined;
      try {
        target=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        const buffer=Buffer.alloc(64*1024);let total=0;
        for(;;) {
          const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;
          total+=bytesRead;if(total>maximumReportBytes)throw new Error();
          await target.writeFile(buffer.subarray(0,bytesRead));
        }
        await target.sync();await target.close();
        await rename(temporary,join(published,name));
      }finally{if(target){await target.close();await rm(temporary,{force:true});}}
    }
  }catch{throw new HarnessError('REPORT_EXPORT','Failed','report-export');}
  finally{await Promise.all(sources.map(({handle})=>handle.close()));}
}

interface ReportSnapshot {
  result?:ReturnType<typeof publicResult>;
  outcome?:'Passed'|'Failed'|'Blocked';
  message:string;
  reportAvailable:boolean;
  credentialRecoveryRequired:boolean;
}

/** Publication is not execution or recovery. Do not replace thousands of
 * completed outcomes with HAR-02, or retain credentials for an export error. */
export async function completeReportPublication(snapshot:ReportSnapshot,publish:()=>Promise<void>) {
  try {
    await publish();snapshot.reportAvailable=true;return true;
  }catch {
    snapshot.outcome='Failed';snapshot.reportAvailable=false;
    snapshot.message='Execution finished, but report download export failed. Recorded test results were retained; inspect HAR-10 at report-export.';
    if(snapshot.result) {
      const result=snapshot.result;
      const diagnostic=publicResult({counts:{Failed:1},cases:[{id:'HAR-10',layer:'A',environment:'live',
        outcome:'Failed',reason:'REPORT_EXPORT',stage:'report-export',durationMs:0}]},{phases:[]}).cases[0]!;
      snapshot.result={...result,counts:{...result.counts,Failed:(result.counts.Failed??0)+1},
        // Infrastructure evidence is not an additional executed test scenario.
        cases:[diagnostic,...result.cases].slice(0,200),omittedCases:result.omittedCases+Math.max(0,result.cases.length+1-200),
        ...(result.evidenceCounts?{evidenceCounts:{...result.evidenceCounts,
          live:{...result.evidenceCounts.live,Failed:(result.evidenceCounts.live?.Failed??0)+1}}}:{})};
    }
    // In particular, preserve an already verified clean result AND an actual
    // outstanding cleanup fence. Never infer either from a download failure.
    return false;
  }
}
