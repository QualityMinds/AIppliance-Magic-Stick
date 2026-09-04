export interface ParsedArguments {
  positionals: string[];
  options: Record<string, string | string[] | boolean>;
}

const booleanOptions = new Set([
  'help', 'version', 'json', 'no-color', 'no-open', 'password-stdin', 'permanent',
]);

const aliases: Record<string, string> = {h: 'help', V: 'version', o: 'output'};

const addOption = (options: ParsedArguments['options'], key: string, value: string | boolean) => {
  const normalized = aliases[key] ?? key;
  const current = options[normalized];
  if (current === undefined) options[normalized] = value;
  else if (Array.isArray(current)) current.push(String(value));
  else options[normalized] = [String(current), String(value)];
};

export const parseArguments = (argv: string[]): ParsedArguments => {
  const parsed: ParsedArguments = {positionals: [], options: {}};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? '';
    if (value === '--') {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!value.startsWith('-') || value === '-') {
      parsed.positionals.push(value);
      continue;
    }
    const raw = value.replace(/^--?/, '');
    const separator = raw.indexOf('=');
    if (separator >= 0) {
      addOption(parsed.options, raw.slice(0, separator), raw.slice(separator + 1));
      continue;
    }
    const key = aliases[raw] ?? raw;
    if (booleanOptions.has(key)) {
      addOption(parsed.options, key, true);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      addOption(parsed.options, key, next);
      index += 1;
    } else addOption(parsed.options, key, true);
  }
  return parsed;
};

export const option = (parsed: ParsedArguments, name: string) => {
  const value = parsed.options[name];
  return Array.isArray(value) ? value.at(-1) : value;
};

export const optionValues = (parsed: ParsedArguments, name: string) => {
  const value = parsed.options[name];
  if (value === undefined || value === false) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
};
