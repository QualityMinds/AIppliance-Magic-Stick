import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import type {MemoryEstimate} from '@magicstick/dashboard-contracts';
import {formatBytes, formatMi} from '@magicstick/dashboard-core';
import {EstimatePanel, SystemMemoryPanel} from './ModelMemorySettings';

const estimate: MemoryEstimate = {computeTarget: 'nvidia-gpu', minimumMi: 66560, recommendedMi: 76800,
  weightsMi: 49152, kvCacheMi: 3072, theoreticalKvCacheMi: 3072, kvCacheSavingsMi: 3072,
  reserveMi: 14336, recommendedReserveMi: 10240, runtimeDetails: {engineRuntimeReserveMi: 14336},
  downloadBytes: 376700000000, confidence: 'high', calculations: {weightsMi: {formula: 'weights per GPU', substitution: '49,152 MiB'}},
  warnings: ['Multi-GPU figures are per card; weights are estimated as shards with 10% headroom.']};
const row = (label: string) => within(screen.getByText(label, {selector: 'dt'}).parentElement!);

describe('memory reservation breakdown scope', () => {
  it.each([2, 4])('shows every vLLM GPU component for the same %i-GPU group as the calculator', async (count) => {
    render(<EstimatePanel estimate={estimate} budgetDevices={count} availableMi={49152} selectedMi={40000} onSelected={vi.fn()} />);
    await userEvent.click(screen.getByText('Breakdown', {selector: 'summary'}));
    expect(screen.getByText(`Breakdown totals cover all ${count} selected GPUs, matching the total VRAM reservation above. Host RAM and download size remain separate.`)).toBeVisible();
    expect(screen.getByText('The displayed totals combine per-GPU estimates; weights are estimated as shards with 10% headroom.')).toBeVisible();
    expect(screen.queryByText(/^Multi-GPU figures are per card;/)).not.toBeInTheDocument();
    for (const [label, mi] of [['Weights', 49152], ['Theoretical KV cache', 3072], ['Engine runtime reserve', 14336], ['Recommended headroom', 10240], ['KV cache saving vs F16', 3072]] as const)
      expect(row(label).getByText(formatMi(mi * count), {exact: true})).toBeVisible();
    expect(row('Download (disk / network)').getByText(formatBytes(estimate.downloadBytes), {exact: true})).toBeVisible();
    await userEvent.click(row('Weights').getByRole('button', {name: 'Explain Weights'}));
    expect(screen.getByRole('dialog', {name: 'Weights calculation'})).toHaveTextContent(`Total for ${count} GPUs: ${count} × 49,152 MiB = ${(count * 49152).toLocaleString('en-US')} MiB`);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getAllByRole('button', {name: 'Explain Minimum'})[0]!);
    expect(screen.getByRole('dialog', {name: 'Minimum calculation'})).toHaveTextContent(`${(count * 66600).toLocaleString('en-US')} MiB`);
  });
  it('keeps Ollama single-device cache components and runtime reserve unchanged', async () => {
    const ollama = {...estimate, computeTarget: 'cpu', weightsMi: 114688, minimumMi: 133233, recommendedMi: 153718,
      kvCacheMi: 6257, theoreticalKvCacheMi: undefined, runtimeDetails: {attentionKvCacheMi: 6144, recurrentStateMi: 113, engineRuntimeReserveMi: 12288}, reserveMi: 12288};
    render(<EstimatePanel estimate={ollama} availableMi={252928} selectedMi={153800} onSelected={vi.fn()} />);
    await userEvent.click(screen.getByText('Breakdown', {selector: 'summary'}));
    expect(row('Weights').getByText('112 GiB', {exact: true})).toBeVisible();
    expect(row('Attention KV cache').getByText('6.0 GiB', {exact: true})).toBeVisible();
    expect(row('Recurrent state cache').getByText('113 MiB', {exact: true})).toBeVisible();
    expect(row('Engine runtime reserve').getByText('12 GiB', {exact: true})).toBeVisible();
  });
  it('keeps a replicated copy at its full per-copy budget instead of multiplying it twice', async () => {
    render(<EstimatePanel estimate={{...estimate, gpuCount: 4, replicaCount: 4, gpuParallelism: 'replicated'}} budgetDevices={1} availableMi={49152} selectedMi={40000} onSelected={vi.fn()} />);
    await userEvent.click(screen.getByText('Breakdown', {selector: 'summary'}));
    expect(row('Weights').getByText('48 GiB', {exact: true})).toBeVisible();
    expect(row('Engine runtime reserve').getByText('14 GiB', {exact: true})).toBeVisible();
    expect(screen.queryByText(/Breakdown totals cover/)).not.toBeInTheDocument();
  });
  it('sums offloaded shares but reserves host runtime and download only once for a split Pod', async () => {
    const offloading = {enabled: true, mode: 'weights' as const, vramBudgetMi: 30720, weightsOnGpuMi: 20480,
      weightsOnCpuMi: 28672, kvOnGpuMi: 3072, kvOnCpuMi: 0, hostRuntimeMi: 12288,
      ramMinimumMi: 126976, ramRecommendedMi: 157696, ramMaximumMi: 252928,
      gpuMinimumMi: 37888, gpuRecommendedMi: 48128, fitsVram: false, estimated: true};
    render(<EstimatePanel estimate={{...estimate, offloading}} budgetDevices={4} availableMi={49152} selectedMi={40000} onSelected={vi.fn()} />);
    await userEvent.click(screen.getByText('Breakdown', {selector: 'summary'}));
    expect(row('Weights · GPU').getByText('80 GiB', {exact: true})).toBeVisible();
    expect(row('Weights · RAM').getByText('112 GiB', {exact: true})).toBeVisible();
    expect(row('Host runtime reserve').getByText('12 GiB', {exact: true})).toBeVisible();
    expect(row('Download (disk / network)').getByText(formatBytes(estimate.downloadBytes), {exact: true})).toBeVisible();
  });
  it('keeps missing weight data unknown', async () => {
    render(<EstimatePanel estimate={{...estimate, weightsMi: undefined}} budgetDevices={4} availableMi={49152} selectedMi={40000} onSelected={vi.fn()} />);
    await userEvent.click(screen.getByText('Breakdown', {selector: 'summary'}));
    expect(row('Weights').getByText('unknown', {exact: true})).toBeVisible();
  });
  const system = {scope: 'per-pod' as const, replicaCount: 1, workerCount: 4,
    minimumMi: 10240, recommendedMi: 133120, runningMinimumMi: 8192, runningRecommendedMi: 10240,
    startupMinimumMi: 10240, startupUpperMi: 112640, maximumMi: 122880, totalRecommendedMi: 133120,
    weightsOnCpuMi: 0, cacheOnCpuMi: 0, hostRuntimeMi: 8192, multimodalCacheMi: 0, promptBuffersMi: 0,
    loadingBuffersMi: 2048, fileCacheUpperMi: 104448, confidence: 'estimated' as const,
    calculations: {recommendedMi: {formula: 'startup envelope + headroom', substitution: '133,120 MiB'}},
    warnings: ['RAM figures are estimates, not measured process RSS.']};
  it('separates serving RAM and startup range without multiplying a split Pod by GPUs', async () => {
    render(<SystemMemoryPanel estimate={{...estimate, gpuCount: 4, systemMemory: system}} selectedMi={16400} />);
    const panel = screen.getByRole('region', {name: 'System RAM planning'});
    expect(panel).toHaveTextContent('one model Pod');
    expect(screen.getByText('While serving').parentElement).toHaveTextContent(formatMi(8192));
    expect(within(panel).getByText(`${formatMi(10240)} – ${formatMi(112640)}`, {exact: true})).toBeVisible();
    expect(within(panel).getByText(formatMi(133120), {exact: true})).toBeVisible();
    expect(screen.queryByLabelText('Host RAM budget (MiB)')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('RAM breakdown', {selector: 'summary'}));
    expect(panel).toHaveTextContent('Do not sum both startup bounds');
  });
  it('preserves saved host RAM and clamps only an explicit recommendation to capacity', async () => {
    const change = vi.fn();
    const {rerender} = render(<SystemMemoryPanel estimate={{...estimate, systemMemory: system}} selectedMi={16400} onSelected={change} />);
    expect(screen.getByLabelText('Host RAM budget (MiB)')).toHaveValue(16400);
    rerender(<SystemMemoryPanel estimate={{...estimate, systemMemory: {...system, recommendedMi: 143360}}} selectedMi={16400} onSelected={change} />);
    expect(change).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', {name: 'Use recommended RAM allocation'}));
    expect(change).toHaveBeenLastCalledWith(122800);  // Safe capacity rounds DOWN to the 100 MiB step.
  });
  it('shows unknown RAM without offering a fabricated recommendation', () => {
    render(<SystemMemoryPanel estimate={{...estimate, systemMemory: {...system, minimumMi: null, recommendedMi: null,
      runningMinimumMi: null, startupMinimumMi: null, startupUpperMi: null, maximumMi: null, confidence: 'unknown'}}} selectedMi={16400} onSelected={vi.fn()} />);
    expect(screen.getByText('At startup · estimated range').parentElement).toHaveTextContent('Unknown');
    expect(screen.getByRole('button', {name: 'Use recommended RAM allocation'})).toBeDisabled();
    expect(screen.getByRole('slider', {name: 'Host RAM reservation'})).toBeDisabled();
  });
  it('shows per-copy host RAM and one explicit combined recommendation for replication', () => {
    render(<SystemMemoryPanel estimate={{...estimate, systemMemory: {...system, scope: 'per-copy', replicaCount: 4,
      totalRecommendedMi: 532480}}} selectedMi={16400} />);
    expect(screen.getByText(/4 independent copies/)).toHaveTextContent('520 GiB');
    expect(screen.getByText('Conservative recommended budget').parentElement).toHaveTextContent(formatMi(133120));
  });
});
