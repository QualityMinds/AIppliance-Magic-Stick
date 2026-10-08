import type {BrowserContext} from '@playwright/test';
import type {ModelActivation, ModelsPayload} from '@magicstick/dashboard-contracts';
import type {LabConfig} from './config.ts';
import type {KubectlObserver, KubeObject} from './observer.ts';
import type {ResourceJournal} from './journal.ts';
import type {OwnedKeyClient} from './owned-key.ts';
import type {OwnedModelClient} from './owned-model.ts';
import type {InferenceProbe} from './inference.ts';

export interface CpuScenario {
  config: LabConfig;
  context: BrowserContext;
  observer: KubectlObserver;
  journal: ResourceJournal;
  keys: OwnedKeyClient;
  model: OwnedModelClient;
  inference: InferenceProbe;
  name: string;
  uid: string;
  generation: number;
  keyName: string;
  keyId: string;
  keySecret: string | undefined;
  allowedKeyName: string | undefined;
  allowedKeyId: string | undefined;
  blockedWrites: number;
  title(id: string, variant: string, text: string, layers?: string): string;
  heartbeat(): Promise<void>;
  editedContextWindow(): number;
  modelState(): Promise<{item: ModelActivation | null; models: ModelsPayload; pods: KubeObject[]}>;
}
