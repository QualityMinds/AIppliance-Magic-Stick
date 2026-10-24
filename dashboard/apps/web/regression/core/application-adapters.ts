/** Repository-owned UI adapters, not another application/capability catalog. */
export type ApplicationAdapter='semantic-chat-v1'|'hermes-terminal-v1'|'opencode-chat-v1';
export function applicationAdapter(type:string):ApplicationAdapter {
  return type==='hermes'?'hermes-terminal-v1':type==='kubeopencode'?'opencode-chat-v1':'semantic-chat-v1';
}
export function repositoryAppAdapter(value:{type?:unknown;adapter?:unknown}) {
  return value.adapter==='semantic-chat-v1'||value.type==='hermes'&&value.adapter==='hermes-terminal-v1'||
    value.type==='kubeopencode'&&value.adapter==='opencode-chat-v1';
}
