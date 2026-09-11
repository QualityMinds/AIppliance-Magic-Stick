import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it} from 'vitest';
import type {ComputeMemoryDevice, SharedMemoryPool} from '@magicstick/dashboard-contracts';
import {ComputeMemory, MemoryGauge} from './ComputeMemory';

const pool: SharedMemoryPool = {id: 'shared-example', node: 'example-node', installedMemoryMi: 131072,
  firmwareReservedMi: 65536, physicalMemoryMi: 65536, gpuAccessibleMi: 47104,
  gpuCapacityMi: 65536, gpuAllocationMode: 'firmware-reserved', gpuCapacitySource: 'kfd-topology',
  freeMi: 55296, totalMi: 57344, unreservedMi: 40960, gpuUnreservedMi: 57344};
const gpu: ComputeMemoryDevice = {id: 'amd-example', name: 'Example GPU', kind: 'gpu', computeTarget: 'amd-gpu',
  memoryArchitecture: 'unified', sharedPoolId: pool.id, gpuAllocationMode: 'firmware-reserved',
  gpuCapacityMi: 65536, totalMi: 65536, unreservedMi: 57344, freeMi: null, metricsAvailable: false,
  message: 'GPU accounting is not a guaranteed hard limit.'};
const reading = (container: HTMLElement, id: string) => container.querySelector(`[data-reading="${id}"]`)!;

describe('compact compute memory gauges', () => {
  it('shows one GPU with four distinct readings and keeps explanations off the page', () => {
    const {container} = render(<ComputeMemory memory={{devices: [gpu], sharedPools: [pool]}} />);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ring]')).toHaveLength(4);
    expect(screen.getByRole('region', {name: 'Dedicated memory'})).toHaveTextContent('64 GiB');
    expect(screen.getByRole('region', {name: 'Shared memory'})).toHaveTextContent('46 GiB');
    expect(reading(container, 'dedicated-free')).toHaveTextContent('—');
    expect(reading(container, 'dedicated-unreserved')).toHaveTextContent('56 GiB');
    expect(reading(container, 'shared-free')).toHaveTextContent('46 GiB');
    expect(reading(container, 'shared-unreserved')).toHaveTextContent('40 GiB');
    expect(screen.getByText('dedicated unreserved')).toBeInTheDocument();
    expect(screen.queryByText(/Physical memory layout|110 GiB/)).not.toBeInTheDocument();
    expect(screen.queryByText('Installed RAM')).not.toBeInTheDocument();
    expect(screen.queryByText(/GPU accounting is not a guaranteed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses a dashed unknown ring rather than zero or invented free dedicated VRAM', () => {
    const {container} = render(<MemoryGauge device={gpu} pool={pool} />);
    const ring = container.querySelector('[data-ring="dedicated-free"]')!;
    expect(ring).toHaveAttribute('data-known', 'false');
    expect(ring.querySelector('.gauge-track-unknown')).not.toBeNull();
    expect(ring.querySelector('.gauge-progress')).toBeNull();
    expect(within(reading(container, 'dedicated-free') as HTMLElement).getByLabelText('Not reported')).toBeInTheDocument();
    expect(reading(container, 'dedicated-free')).not.toHaveTextContent('0 MiB');
  });

  it('keeps a genuinely exhausted reservation budget distinct from missing live metrics', () => {
    const {container} = render(<MemoryGauge device={{...gpu, unreservedMi: 0}} pool={pool} />);
    expect(reading(container, 'dedicated-unreserved')).toHaveTextContent('0 MiB');
    expect(container.querySelector('[data-ring="dedicated-unreserved"]')).toHaveAttribute('data-known', 'true');
    expect(container.querySelector('[data-ring="dedicated-unreserved"] .gauge-progress')).toBeNull();
    expect(reading(container, 'dedicated-free')).toHaveTextContent('—');
  });

  it('uses live dedicated metrics only for the confirmed fixed allocation domain', () => {
    const {container} = render(<MemoryGauge device={{...gpu, freeMi: 24576, metricsAvailable: true}} pool={pool} />);
    expect(reading(container, 'dedicated-free')).toHaveTextContent('24 GiB');
    expect(container.querySelector('[data-ring="dedicated-free"] .gauge-progress')).toHaveAttribute('stroke-dasharray', '37.5 100');
    expect(reading(container, 'shared-free')).toHaveTextContent('46 GiB');
    expect(screen.getByText('dedicated free')).toBeInTheDocument();
  });

  it('bounds shared availability by both current Linux availability and its ceiling', () => {
    const {container} = render(<MemoryGauge device={gpu} pool={{...pool, freeMi: 8192, unreservedMi: 65536}} />);
    expect(reading(container, 'shared-free')).toHaveTextContent('8.0 GiB');
    expect(reading(container, 'shared-unreserved')).toHaveTextContent('46 GiB');
    expect(reading(container, 'dedicated-unreserved')).toHaveTextContent('56 GiB');
  });

  it('intersects shared GPU budgets with Linux budgets without attributing them to dedicated VRAM', () => {
    const dynamicPool = {...pool, firmwareReservedMi: 512, physicalMemoryMi: 129024, gpuAccessibleMi: 112640,
      gpuCapacityMi: 112640, gpuAllocationMode: 'shared-gtt' as const, freeMi: 81920,
      unreservedMi: 71680, gpuUnreservedMi: 61440};
    const dynamicGpu = {...gpu, gpuAllocationMode: 'shared-gtt' as const, totalMi: 112640, unreservedMi: 61440,
      freeMi: 81920, metricsAvailable: true};
    const {container} = render(<MemoryGauge device={dynamicGpu} pool={dynamicPool} />);
    expect(reading(container, 'dedicated-free')).toHaveTextContent('—');
    expect(reading(container, 'dedicated-unreserved')).toHaveTextContent('—');
    expect(reading(container, 'shared-free')).toHaveTextContent('80 GiB');
    expect(reading(container, 'shared-unreserved')).toHaveTextContent('60 GiB');
    expect(screen.getByText('shared free')).toBeInTheDocument();
  });

  it('never substitutes another node or missing counters for the selected shared pool', () => {
    const {container} = render(<ComputeMemory memory={{devices: [gpu], sharedPools: [{...pool, id: 'another-node'}]}} />);
    expect(reading(container, 'shared-free')).toHaveTextContent('—');
    expect(reading(container, 'shared-unreserved')).toHaveTextContent('—');
    expect(reading(container, 'dedicated-unreserved')).toHaveTextContent('56 GiB');
  });

  it('fails closed for conflicting domains, invalid counters and unavailable metrics', () => {
    const {container, rerender} = render(<MemoryGauge device={{...gpu, freeMi: 12345}} pool={{...pool, freeMi: Number.NaN, unreservedMi: -1}} />);
    expect(reading(container, 'dedicated-free')).toHaveTextContent('—');
    expect(reading(container, 'shared-free')).toHaveTextContent('—');
    expect(reading(container, 'shared-unreserved')).toHaveTextContent('—');
    rerender(<MemoryGauge device={gpu} pool={{...pool, gpuAllocationMode: 'shared-gtt'}} />);
    expect(screen.getByText('not reported')).toBeInTheDocument();
    expect(reading(container, 'dedicated-unreserved')).toHaveTextContent('—');
    expect(reading(container, 'shared-unreserved')).toHaveTextContent('—');
  });

  it('retains two rings for ordinary CPU and discrete GPUs', () => {
    const {container} = render(<ComputeMemory memory={{devices: [
      {id: 'cpu', name: 'CPU', kind: 'cpu', totalMi: 65536, unreservedMi: 32768, freeMi: 49152, metricsAvailable: true},
      {id: 'nvidia-example', name: 'Example discrete GPU', kind: 'gpu', totalMi: 24576, unreservedMi: 12288, freeMi: 8192, metricsAvailable: true},
    ]}} />);
    expect(container.querySelectorAll('[data-ring]')).toHaveLength(4);
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByRole('region', {name: 'Shared memory'})).not.toBeInTheDocument();
    expect(screen.getAllByText('actually free')).toHaveLength(2);
  });

  it('uses the displayed Linux capacity for both CPU rings without changing the remaining budget', () => {
    const {container} = render(<MemoryGauge device={{id: 'cpu', name: 'CPU', kind: 'cpu', memoryArchitecture: 'unified',
      sharedMemoryMi: 65536, totalMi: 57344, unreservedMi: 32768, freeMi: 49152, metricsAvailable: true}} />);
    expect(screen.getByRole('region', {name: 'RAM memory'})).toHaveTextContent('64 GiB');
    expect(container.querySelector('[data-ring="unreserved"] .gauge-progress')).toHaveAttribute('stroke-dasharray', '50 100');
    expect(container.querySelector('[data-ring="free"] .gauge-progress')).toHaveAttribute('stroke-dasharray', '75 100');
    expect(reading(container, 'unreserved')).toHaveTextContent('32 GiB');
  });

  it('opens explanations on hover and supports keyboard, click, dismissal and live updates', async () => {
    const user = userEvent.setup();
    const {rerender} = render(<MemoryGauge device={gpu} pool={pool} />);
    const button = screen.getByRole('button', {name: 'Explain Example GPU memory'});
    await user.hover(button);
    expect(screen.getByRole('dialog')).toHaveTextContent('Shared free = min');
    expect(screen.getByRole('dialog')).toHaveTextContent('not two deployment targets');
    expect(screen.getByRole('dialog')).toHaveTextContent(gpu.message!);
    await user.click(button);
    expect(screen.getByRole('dialog')).toHaveFocus();
    rerender(<MemoryGauge device={gpu} pool={{...pool, gpuAccessibleMi: 32768}} />);
    expect(screen.getByText('Dynamic GPU ceiling').parentElement).toHaveTextContent('32 GiB');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(screen.queryByText(gpu.message!)).not.toBeInTheDocument();
  });
});
