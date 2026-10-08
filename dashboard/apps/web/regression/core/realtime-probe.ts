import {request} from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import type {Duplex} from 'node:stream';
import {HarnessError,requireSafe} from './errors.ts';

/** Minimal RFC6455 client for authenticated protocol acceptance, not a browser
 * or OpenAI feature-parity emulator. No extensions, audio capture or raw events
 * are retained in reports. HTTP authorization is never put in a URL. */
export function websocketFrame(payload:Buffer,opcode=1) {
  requireSafe(payload.length <= 65535 && [1,8,10].includes(opcode),'CONFIG');
  const mask=randomBytes(4),header=Buffer.alloc(payload.length < 126 ? 6 : 8);
  header[0]=0x80|opcode;
  if(payload.length < 126) header[1]=0x80|payload.length;
  else {header[1]=0x80|126;header.writeUInt16BE(payload.length,2);}
  mask.copy(header,header.length-4);
  const body=Buffer.from(payload);for(let index=0;index<body.length;index++) body[index]!^=mask[index%4]!;
  return Buffer.concat([header,body]);
}
export function websocketEvent(frame:Buffer):{consumed:number;opcode:number;payload:Buffer}|undefined {
  if(frame.length < 2) return;
  requireSafe((frame[0]! & 0x70) === 0 && (frame[1]! & 0x80) === 0 && (frame[0]! & 0x80) !== 0,'API');
  let size=frame[1]!&0x7f,offset=2;
  if(size === 126) {if(frame.length < 4) return;size=frame.readUInt16BE(2);offset=4;}
  requireSafe(size !== 127 && size <= 65535,'API');
  if(frame.length < offset+size) return;
  return {consumed:offset+size,opcode:frame[0]!&0x0f,payload:frame.subarray(offset,offset+size)};
}
export async function realtimeSession(origin:string,model:string,key:string|undefined,expectDenied=false,timeoutMs=30_000) {
  const url=new URL('/v1/realtime',origin);requireSafe(url.protocol === 'https:' && url.origin === origin && !url.username && !url.password,'CONFIG');
  url.searchParams.set('model',model);
  const handshakeKey=randomBytes(16).toString('base64');
  return new Promise<void>((resolve,reject)=>{
    let socket:Duplex|undefined,settled=false,buffer=Buffer.alloc(0);
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);socket?.destroy();req.destroy();error?reject(error):resolve();};
    const req=request(url,{method:'GET',headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':handshakeKey,
      'OpenAI-Beta':'realtime=v1',...(key?{Authorization:'Bearer '+key}:{}),Origin:origin}});
    const timer=setTimeout(()=>finish(new HarnessError('DEADLINE','Failed')),timeoutMs);
    req.on('response',response=>{response.resume();finish(expectDenied && [401,403].includes(response.statusCode ?? 0)?undefined:new HarnessError('API','Failed'));});
    req.on('error',()=>finish(new HarnessError('API','Failed')));
    req.on('upgrade',(response,stream,head)=>{
      socket=stream;
      if(expectDenied || response.headers['sec-websocket-accept'] !== createHash('sha1').update(handshakeKey+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') ||
        response.headers['sec-websocket-extensions']) {finish(new HarnessError('API','Failed'));return;}
      const receive=(chunk:Buffer)=>{
        try {
          buffer=Buffer.concat([buffer,chunk]);requireSafe(buffer.length <= 128*1024,'API');
          for(let event=websocketEvent(buffer);event;event=websocketEvent(buffer)) {
            buffer=buffer.subarray(event.consumed);
            if(event.opcode === 9) {socket!.write(websocketFrame(event.payload,10));continue;}
            if(event.opcode === 8) {finish(new HarnessError('API','Failed'));return;}
            requireSafe(event.opcode === 1,'API');const value=JSON.parse(event.payload.toString('utf8'));
            requireSafe(value && typeof value === 'object' && typeof value.type === 'string','API');
            // A coherent native session event is necessary; receiving an error,
            // health response or successfully opening TCP never passes.
            if(value.type === 'error') {finish(new HarnessError('API','Failed'));return;}
            if(value.type === 'session.created' && value.session && typeof value.session === 'object') {finish();return;}
          }
        } catch {finish(new HarnessError('API','Failed'));}
      };
      stream.on('data',receive);stream.on('error',()=>finish(new HarnessError('API','Failed')));
      stream.on('close',()=>{if(!settled)finish(new HarnessError('API','Failed'));});
      if(head.length)receive(head);
    });req.end();
  });
}
