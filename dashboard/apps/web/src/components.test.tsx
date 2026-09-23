import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {ProgressBar} from './components';

describe('model runtime progress', () => {
  it('does not invent a completion percentage for a starting runtime', () => {
    render(<ProgressBar phase="Starting" />);
    expect(screen.getByRole('progressbar', {name: 'Starting model runtime'})).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });

  it('distinguishes waiting for a Pod from a running startup', () => {
    render(<ProgressBar phase="WaitingForPod" />);
    expect(screen.getByRole('progressbar', {name: 'Waiting for model Pod'})).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByText('Starting model runtime')).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });

  it('shows a creation failure without a misleading completion percentage', () => {
    render(<ProgressBar phase="Degraded" message="No model Pod was created." />);
    expect(screen.getByRole('progressbar', {name: 'No model Pod was created.'})).toHaveClass('progress-bad');
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });

  it('still confirms a ready runtime as complete', () => {
    render(<ProgressBar phase="Ready" />);
    expect(screen.getByRole('progressbar', {name: 'Ready: 100%'})).toHaveAttribute('aria-valuenow', '100');
  });
});
