import {HarnessError,requireSafe} from './errors.ts';

// Only protocol vocabulary, never the server's message, details or stderr.
const statusCodes={BadRequest:400,Unauthorized:401,Forbidden:403,NotFound:404,MethodNotAllowed:405,
  NotAcceptable:406,AlreadyExists:409,Conflict:409,Gone:410,Expired:410,RequestEntityTooLarge:413,
  UnsupportedMediaType:415,Invalid:422,TooManyRequests:429,InternalError:500,
  ServiceUnavailable:503,Timeout:504,ServerTimeout:500} as const;
const matchesStatus=(reason:keyof typeof statusCodes,code:number|null)=>reason==='InternalError'?
  code===null||code>=500&&code<=599:statusCodes[reason]===code;
export const commandFailures=['api','timeout','spawn','input','signal','output-limit','unknown'] as const;
export const commandSignals=['SIGTERM','SIGKILL','SIGINT','SIGHUP','SIGPIPE','OTHER'] as const;
export interface KubernetesCommandDiagnostic {
  commandFailure:typeof commandFailures[number];httpStatus:number|null;
  kubernetesReason?:keyof typeof statusCodes;exitCode?:number;processSignal?:typeof commandSignals[number];
}
export function parseKubernetesCommandDiagnostic(value:unknown):KubernetesCommandDiagnostic {
  const v=value as KubernetesCommandDiagnostic;
  requireSafe(v&&commandFailures.includes(v.commandFailure)&&
    (v.httpStatus===null||Number.isInteger(v.httpStatus)&&v.httpStatus>=100&&v.httpStatus<=599),'CONFIG');
  const result:KubernetesCommandDiagnostic={commandFailure:v.commandFailure,httpStatus:v.httpStatus};
  if(v.kubernetesReason!==undefined){requireSafe(Object.hasOwn(statusCodes,v.kubernetesReason)&&
    matchesStatus(v.kubernetesReason,v.httpStatus),'CONFIG');result.kubernetesReason=v.kubernetesReason;}
  if(v.exitCode!==undefined){requireSafe(Number.isInteger(v.exitCode)&&v.exitCode>=0&&v.exitCode<=255,'CONFIG');result.exitCode=v.exitCode;}
  if(v.processSignal!==undefined){requireSafe(commandSignals.includes(v.processSignal),'CONFIG');result.processSignal=v.processSignal;}
  requireSafe(v.commandFailure==='api'||v.httpStatus===null&&v.kubernetesReason===undefined,'CONFIG');
  requireSafe(v.commandFailure!=='api'||v.exitCode===1&&v.processSignal===undefined,'CONFIG');
  requireSafe(v.commandFailure!=='signal'||v.processSignal!==undefined,'CONFIG');
  return result;
}
export class KubernetesCommandError extends HarnessError {
  readonly diagnostic:Readonly<KubernetesCommandDiagnostic>;
  constructor(value:KubernetesCommandDiagnostic) {
    super('OBSERVER');this.diagnostic=Object.freeze(parseKubernetesCommandDiagnostic(value));
  }
}

/** kubectl's fixed server-error prefix is recognized only at the beginning,
 * not from arbitrary text containing '409' or a nested application message. */
export function kubernetesCommandFailure(stdout:string,stderr:string,exitCode:number|null,
  signal:NodeJS.Signals|null):KubernetesCommandDiagnostic {
  const exit=exitCode!==null&&Number.isInteger(exitCode)&&exitCode>=0&&exitCode<=255?{exitCode}:{};
  if(signal)return {commandFailure:'signal',httpStatus:null,...exit,
    processSignal:commandSignals.includes(signal as typeof commandSignals[number])?signal as typeof commandSignals[number]:'OTHER'};
  // kubectl's handled API errors exit 1. An interrupted/crashed process is not
  // a confirmed server rejection, even if its partial stderr resembles one.
  if(exitCode===1) {
    let body:unknown;
    try {if(stdout.length<=64*1024)body=JSON.parse(stdout);}catch{/* No raw output is retained. */}
    if(body&&typeof body==='object'&&!Array.isArray(body)) {
      const s=body as Record<string,unknown>;
      if(s.kind==='Status'&&['v1','meta.k8s.io/v1'].includes(String(s.apiVersion))&&s.status==='Failure'&&
        Number.isInteger(s.code)&&Number(s.code)>=400&&Number(s.code)<=599) {
        const known=typeof s.reason==='string'&&Object.hasOwn(statusCodes,s.reason)?s.reason as keyof typeof statusCodes:undefined;
        // Inconsistent protocol fields must not manufacture a retryable 409.
        if(known&&!matchesStatus(known,Number(s.code)))return {commandFailure:'unknown',httpStatus:null,...exit};
        return {commandFailure:'api',httpStatus:Number(s.code),...exit,...(known?{kubernetesReason:known}:{})};
      }
    }
    const prefix=stderr.trimStart().match(/^Error from server \(([A-Za-z]+)\):/);
    if(prefix&&Object.hasOwn(statusCodes,prefix[1]!)) {
      const kubernetesReason=prefix[1] as keyof typeof statusCodes;
      // Kubernetes also uses InternalError for generic 5xx responses. The
      // prefix alone does not establish their exact HTTP status.
      return {commandFailure:'api',httpStatus:kubernetesReason==='InternalError'?null:statusCodes[kubernetesReason],kubernetesReason,...exit};
    }
  }
  return {commandFailure:'unknown',httpStatus:null,...exit};
}
