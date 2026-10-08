import {setTimeout as sleep} from 'node:timers/promises';
import {HarnessError, type Stage} from './errors.ts';

/** No retry of mutations. A read error remains an error, not evidence of absence. */
export async function poll<T>(read: (signal: AbortSignal) => Promise<T>, accept: (value: T) => boolean, options: {
  timeoutMs: number; intervalMs?: number; signal?: AbortSignal; stage?: Stage;
  now?: () => number; wait?: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + options.timeoutMs;
  const wait = options.wait ?? (milliseconds => sleep(milliseconds, undefined, {signal: options.signal}));
  let interval = options.intervalMs ?? 100;
  while (now() < deadline) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineReached = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new HarnessError('DEADLINE', 'Failed', options.stage)); }, deadline - now());
    });
    let value: T;
    try { value = await Promise.race([read(signal), deadlineReached]); }
    finally { clearTimeout(timer); }
    if (now() < deadline && accept(value)) return value;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(interval, remaining));
    interval = Math.min(Math.ceil(interval * 1.5), 1000);
  }
  throw new HarnessError('DEADLINE', 'Failed', options.stage);
}

export function currentReady(value: {metadata?: {uid?: string; generation?: number}; status?: {
  observedGeneration?: number; conditions?: Array<{type?: string; status?: string; observedGeneration?: number}>;
}}, uid: string, generation: number) {
  return value.metadata?.uid === uid && value.metadata.generation === generation &&
    value.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True' &&
      (condition.observedGeneration ?? value.status?.observedGeneration) === generation) === true;
}
