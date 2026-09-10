import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {SharedMemoryOverview} from './SharedMemoryOverview';

describe('physical memory inventory', () => {
  it('separates installed, fixed, Linux and dynamic memory without adding the dynamic pool', () => {
    render(<SharedMemoryOverview pool={{node: 'example-node', installedMemoryMi: 131072, firmwareReservedMi: 65536, physicalMemoryMi: 64000, gpuAccessibleMi: 32000}} />);
    expect(screen.getByText('Installed RAM').parentElement).toHaveTextContent('128 GiB');
    expect(screen.getByText('Fixed GPU reservation').parentElement).toHaveTextContent('64 GiB');
    expect(screen.getByText('Linux-visible RAM').parentElement).toHaveTextContent('62.5 GiB');
    expect(screen.getByText('Dynamic GPU ceiling').parentElement).toHaveTextContent('31.3 GiB');
    expect(screen.getByText(/Within Linux RAM · not additional memory/)).toBeInTheDocument();
    expect(screen.getByText(/1.5 GiB other firmware\/platform memory/)).toBeInTheDocument();
    expect(screen.getByText(/not yet verified; no capacity guarantee/)).toBeInTheDocument();
  });

  it('does not invent installed or firmware capacity when an older host omits inventory', () => {
    render(<SharedMemoryOverview pool={{node: 'example-node', physicalMemoryMi: 65536, gpuAccessibleMi: 32768}} />);
    expect(screen.getByText('Installed RAM').parentElement).toHaveTextContent('Not reported');
    expect(screen.getByText('Fixed GPU reservation').parentElement).toHaveTextContent('Not reported');
    expect(screen.queryByText(/Installed RAM =/)).not.toBeInTheDocument();
  });

  it('flags conflicting totals instead of a negative platform reservation', () => {
    render(<SharedMemoryOverview pool={{node: 'example-node', installedMemoryMi: 65536, firmwareReservedMi: 65536, physicalMemoryMi: 65536, gpuAccessibleMi: null}} />);
    expect(screen.getByText(/totals do not reconcile/)).toBeInTheDocument();
    expect(screen.queryByText(/Installed RAM =/)).not.toBeInTheDocument();
  });
});
