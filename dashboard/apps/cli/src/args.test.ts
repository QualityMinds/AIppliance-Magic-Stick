import {describe, expect, it} from 'vitest';
import {option, optionValues, parseArguments} from './args';

describe('parseArguments', () => {
  it('keeps commands positional while accepting global and repeated options', () => {
    const parsed = parseArguments([
      '--api-url=https://appliance.example',
      'service', 'enable', 'litellm',
      '--set', 'mode=local', '--set=replicas=2', '--json',
    ]);

    expect(parsed.positionals).toEqual(['service', 'enable', 'litellm']);
    expect(option(parsed, 'api-url')).toBe('https://appliance.example');
    expect(optionValues(parsed, 'set')).toEqual(['mode=local', 'replicas=2']);
    expect(option(parsed, 'json')).toBe(true);
  });

  it('supports documented short options and literal positionals', () => {
    const parsed = parseArguments(['-o', 'cluster.yaml', '--', '-literal']);
    expect(option(parsed, 'output')).toBe('cluster.yaml');
    expect(parsed.positionals).toEqual(['-literal']);
  });
});
