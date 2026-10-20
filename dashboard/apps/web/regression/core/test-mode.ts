import type {RegressionTestMode} from '@magicstick/dashboard-contracts';
import {phaseSteps} from '../profiles/selections.ts';
import {requireSafe} from './errors.ts';

export function testMode(value: unknown = 'full'): RegressionTestMode {
  requireSafe(value === 'full' || value === 'non-destructive', 'CONFIG');
  return value;
}
export const isolatedStep = (step: string) => step === 'selftest' || /^(?:smoke|phase[2-8])-(?:fast|fixtures)$/.test(step);
/** Explicitly allow safe steps, not a denylist of today's destructive tests.
 * New installed scenarios are excluded until reviewed for this mode. */
export function selectedSteps(phase: number, mode: RegressionTestMode): string[] {
  requireSafe(Number.isInteger(phase) && phase >= 0 && phase <= 8, 'CONFIG');
  const steps = phaseSteps[`phase${phase}` as keyof typeof phaseSteps];
  return mode === 'full' ? [...steps] : [...steps.filter(isolatedStep), 'non-destructive-live'];
}
export function excludedSteps(mode: RegressionTestMode, phases: readonly number[]): string[] {
  return mode === 'full' ? [] : [...new Set(phases.flatMap(phase => {
    selectedSteps(phase, mode);
    return phaseSteps[`phase${phase}` as keyof typeof phaseSteps].filter(step => !isolatedStep(step)).map(step => `phase${phase}/${step}`);
  }))];
}
export function requireSafeStep(step: string, mode: RegressionTestMode) {
  requireSafe(mode === 'full' || isolatedStep(step) || step === 'non-destructive-live' || step === 'all' || /^phase[0-8]$/.test(step) || step === 'typecheck', 'MUTATION');
}
