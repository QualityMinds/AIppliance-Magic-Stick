import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {HarnessError,requireSafe} from './errors.ts';

/** A disposable lab issuer, never the release/production signing key. The
 * optional LOCAL trust store must be explicitly provisioned by setup first. */
export interface TestLicenseSigner {version:1;applianceUid:string;installationId:string;kid:string;privateKey:string;publicKey:string;fingerprint:string}
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fingerprint=(pem:string)=>createHash('sha256').update(createPublicKey(pem).export({type:'spki',format:'der'})).digest('hex');
export function createTestLicenseSigner(applianceUid:string,installationId:string):TestLicenseSigner {
  requireSafe(/^[a-zA-Z0-9-]{1,64}$/.test(applianceUid) && uuid(installationId),'IDENTITY');
  const pair=generateKeyPairSync('ed25519');
  const publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString();
  return {version:1,applianceUid,installationId,kid:'regression-'+randomUUID(),
    privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey,fingerprint:fingerprint(publicKey)};
}
export function validateTestLicenseSigner(value:TestLicenseSigner,applianceUid:string,installationId:string) {
  requireSafe(value?.version === 1 && value.applianceUid === applianceUid && value.installationId === installationId && uuid(installationId) &&
    /^regression-[a-f0-9-]{36}$/.test(value.kid) && typeof value.privateKey === 'string' && typeof value.publicKey === 'string' &&
    value.privateKey.length < 4096 && value.publicKey.length < 4096,'IDENTITY');
  try {
    const privateKey=createPrivateKey(value.privateKey);
    requireSafe(privateKey.asymmetricKeyType === 'ed25519' && fingerprint(value.publicKey) === value.fingerprint &&
      createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString() === value.publicKey,'CONFIG');
  }catch{throw new HarnessError('CONFIG');}
  return value;
}
export function testLicenseDocument(signer:TestLicenseSigner,mode:'valid'|'expired'|'wrong-installation'|'tampered'|'short-lived',now=Date.now()) {
  validateTestLicenseSigner(signer,signer.applianceUid,signer.installationId);
  requireSafe(['valid','expired','wrong-installation','tampered','short-lived'].includes(mode) && Number.isSafeInteger(now) && now > 0,'CONFIG');
  const seconds=Math.floor(now/1000),expired=mode === 'expired';
  const header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'magicstick-license+jwt',kid:signer.kid})).toString('base64url');
  const claims={version:1,product:'magicstick',issuer:'magicstick',edition:'free-registered',features:['federated-sso'],
    licenseId:'regression-'+randomUUID(),customer:'Disposable regression test fixture',
    installationId:mode === 'wrong-installation' ? randomUUID() : signer.installationId,
    issuedAt:seconds-(expired ? 300 : 30),notBefore:seconds-(expired ? 300 : 30),
    expiresAt:expired ? seconds-60 : seconds+(mode === 'short-lived' ? 120 : 7*86400)};
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature=sign(null,Buffer.from(header+'.'+payload),createPrivateKey(signer.privateKey));
  if(mode === 'tampered')signature[0]=signature[0]!^1;
  return JSON.stringify({format:'magicstick-license/v1',token:header+'.'+payload+'.'+signature.toString('base64url')});
}
