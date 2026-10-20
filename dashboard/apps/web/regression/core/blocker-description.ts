import {reasons,type ReasonCode} from './errors.ts';
import {remainingVariants,type LiveGate} from '../profiles/remaining-p0.ts';

const prerequisites:Record<LiveGate,string>={
  applications:'This live check requires an installed service, a disposable application fixture and its supported UI adapter.',
  identity:'This live check requires a disposable test identity and verified Kubernetes/identity access.',
  license:'This live check requires installation-bound, signed valid/expired/wrong-installation/tampered test licenses.',
  federation:'This live check requires a controlled external OIDC/SAML identity provider and cleanable broker-user fixtures.',
  maintenance:'This live check requires an external observer and a current-boot maintenance fixture.',
  network:'This live check requires an external observer that remains connected while the Appliance network changes.',
  channel:'This live check requires an external observer and a verified software-channel transition fixture.',
  cache:'This live check requires an owned cache fixture and verified cache access.',
  reboot:'This live check requires an external observer that survives Appliance reboot or shutdown.',
  mesh:'This live check requires a second, separately registered and pinned Appliance; one server cannot certify Mesh.',
  companion:'This live check requires native Mesh companion build evidence for the exact tested source commit.',
  realtime:'This live check requires advertised and validated exclusive/shared GPU Realtime model fixtures.',
  repeat:'This live check requires a healthy model/service fixture and retained evidence for repeated-run comparison.',
  'supply-chain':'This live check requires fresh, successful security and publication CI evidence for the exact installed commit.',
};

/** Fixed source definitions only. Do not print raw error bodies or private
 * fixture values; say which prerequisite this case needs, not invented facts. */
export function blockerDescription(reason:ReasonCode,id:string,variant?:string,layer?:string) {
  if(reason!=='PREREQUISITE')return reasons[reason];
  if(layer&&'UCB'.includes(layer))return 'Required isolated unit, contract or browser evidence was not recorded. Inspect the preceding runner step; this is not a passing live check.';
  const definition=variant?remainingVariants[variant]:undefined;
  if(definition?.id===id&&definition.gate)return prerequisites[definition.gate]+' Automatic preparation could not verify that prerequisite.';
  if(variant&&/^p[34]-/.test(variant)) {
    const vendor=variant.includes('nvidia')?'NVIDIA':variant.includes('amd')?'AMD':'the selected vendor';
    const multiple=/(multigpu|replicated)/.test(variant)?` At least ${variant.endsWith('-4')?'four':'two'} individually addressable cards are required for this variant.`:'';
    return `This live GPU check requires ${vendor} hardware, a ready runtime, current physical-device telemetry and the matching automatic model fixture.${multiple}`;
  }
  return reasons[reason];
}
