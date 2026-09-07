import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {ProgressBar} from './components';

describe('model runtime progress', () => {
  it('shows a starting runtime as incomplete, not ready', () => {
    render(<ProgressBar phase="Starting" />);
    expect(screen.getByLabelText('Starting model runtime: 85%')).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });
});
