import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
import {loadRuntimeLabDns,labDnsAddress} from './browser-dns.ts';

// Preload before Playwright's API driver. Redirect DNS, never URLs, Host/SNI,
// certificate verification, proxies or network permissions.
const originalLookup=dns.lookup.bind(dns);
const originalPromiseLookup=dns.promises.lookup.bind(dns.promises);
async function pinned(hostname,options) {
  if(typeof hostname!=='string')return undefined;
  const plan=await loadRuntimeLabDns();
  const address=plan&&labDnsAddress(plan,hostname);
  if(!address)return undefined;
  const family=typeof options==='number'?options:options?.family;
  if(family===6||family==='IPv6') {
    const error=new Error('No IPv6 address in the private lab DNS plan.');
    error.code='ENOTFOUND';error.syscall='getaddrinfo';throw error;
  }
  return options?.all?[{address,family:4}]:{address,family:4};
}
dns.lookup=function(hostname,options,callback) {
  if(typeof options==='function'){callback=options;options=undefined;}
  if(typeof callback!=='function')return originalLookup(hostname,options,callback);
  pinned(hostname,options).then(result=>{
    if(result===undefined)return originalLookup(hostname,options,callback);
    if(Array.isArray(result))callback(null,result);else callback(null,result.address,result.family);
  },error=>callback(error));
};
dns.promises.lookup=async function(hostname,options) {
  return await pinned(hostname,options) ?? originalPromiseLookup(hostname,options);
};
syncBuiltinESMExports();
