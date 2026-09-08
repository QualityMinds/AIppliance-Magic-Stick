import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import {MemoryInfo, unreservedCalculation} from './MemoryInfo';

const calculation = {
  formula: 'ceil(layers × KV heads × (key + value) × bytes/value × tokens × sequences ÷ 1,048,576)',
  substitution: 'ceil(16 × 4 × (256 + 256) × 2 × 10,000 × 1 ÷ 1,048,576) = 625 MiB',
  notes: ['65,536 bytes (64 KiB) per token per sequence. Weight quantization does not set KV precision.'],
};

describe('memory calculation overlays', () => {
  it('opens via click without submitting the model form, closes with Escape and restores focus', async () => {
    const user = userEvent.setup(); const submit = vi.fn((event) => event.preventDefault());
    render(<form onSubmit={submit}><MemoryInfo label="Attention KV cache" value="625 MiB" calculation={calculation} /></form>);
    const button = screen.getByRole('button', {name: 'Explain Attention KV cache'});
    await user.click(button);
    const dialog = screen.getByRole('dialog', {name: 'Attention KV cache calculation'});
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveTextContent('65,536 bytes (64 KiB)');
    expect(dialog).toHaveTextContent(calculation.substitution);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(submit).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('supports focus preview, keyboard activation and the close button', async () => {
    const user = userEvent.setup();
    render(<MemoryInfo label="Runtime" value="1 GiB" calculation={calculation} />);
    await user.tab();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.click(screen.getByRole('button', {name: 'Close explanation'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Explain Runtime'})).toHaveFocus();
  });

  it('previews on hover, remains reachable and dismisses on leaving or outside click', async () => {
    const user = userEvent.setup();
    render(<><MemoryInfo label="Runtime" value="1 GiB" calculation={calculation} /><button>Outside</button></>);
    const button = screen.getByRole('button', {name: 'Explain Runtime'});
    await user.hover(button);
    await user.hover(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.unhover(screen.getByRole('dialog'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(button);
    await user.click(screen.getByRole('button', {name: 'Outside'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('updates an open explanation instead of retaining stale context values', async () => {
    const user = userEvent.setup();
    const view = render(<MemoryInfo label="KV cache" value="625 MiB" calculation={calculation} />);
    await user.click(screen.getByRole('button', {name: 'Explain KV cache'}));
    view.rerender(<MemoryInfo label="KV cache" value="1250 MiB" calculation={{...calculation, substitution: '20,000 tokens = 1,250 MiB'}} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('20,000 tokens = 1,250 MiB');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('10,000');
  });

  it('states unavailable details honestly and explains 100 MiB reservation rounding', async () => {
    const user = userEvent.setup();
    render(<MemoryInfo label="Minimum" value="2.1 GiB" roundedMi={2113} />);
    await user.click(screen.getByRole('button', {name: 'Explain Minimum'}));
    expect(screen.getByRole('dialog')).toHaveTextContent('Calculation details are unavailable');
    expect(screen.getByRole('dialog')).toHaveTextContent('2,200 MiB');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('= 0 MiB');
  });

  it('ports outside the parent scroll container and repositions on resize', async () => {
    const user = userEvent.setup();
    const view = render(<div style={{overflow: 'hidden'}}><MemoryInfo label="KV" value="625 MiB" calculation={calculation} /></div>);
    await user.click(screen.getByRole('button', {name: 'Explain KV'}));
    const dialog = screen.getByRole('dialog');
    expect(view.container).not.toContainElement(dialog);
    fireEvent.resize(window);
    expect(dialog.parentElement).toBe(document.body);
    expect(parseFloat(dialog.style.left)).toBeGreaterThanOrEqual(12);
  });

  it('distinguishes unreserved from unused and does not invent unknown capacity', () => {
    expect(unreservedCalculation(23456).substitution).toContain('23,400 MiB');
    expect(unreservedCalculation(null).substitution).toBe('Unreserved capacity is unknown.');
  });
});
