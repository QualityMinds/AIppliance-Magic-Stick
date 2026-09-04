import {promises as fs} from 'node:fs';
import {flattenInstances, formatBytes, formatMi, titleFromKey} from '@magicstick/dashboard-core';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import {parseArguments, option, optionValues, type ParsedArguments} from './args';
import {phase, stringify, table, truncate} from './output';
import {createRuntime, type Runtime, type RuntimeOptions} from './runtime';
import {loadSnapshot} from './snapshot';
import {runTui} from './tui';

export const VERSION = '0.1.0';

export interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  readStdin: () => Promise<string>;
}

export interface CliDependencies {
  createRuntime?: (options?: RuntimeOptions) => Promise<Runtime>;
  runTui?: typeof runTui;
}

const defaultIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
};

const HELP = `Magic Stick CLI and TUI

Usage:
  magicstick [global options] <command>
  magicstick tui

Authentication:
  login [--no-open]                    Sign in with the Keycloak device flow
  logout                               Delete the locally cached session
  whoami                               Show the current identity and role

Read commands:
  overview                             Appliance, module, instance and model summary
  service list                         List modules
  instance list                        List application instances
  model list                           List models and compute targets
  model search <query> [--provider huggingface|ollama]
  model popular [--provider huggingface|ollama]
  model artifacts <repo> [--provider huggingface|ollama]
  settings get
  user list [--search text] [--first 0] [--max 25]
  api-key list
  kubernetes-access list [--search text]
  status                               Hardware and Kubernetes status

Mutation commands:
  service enable <name> [--set key=value ...]
  service disable <name>
  service credentials <name>
  instance create <type> --file payload.json
  instance remove <name>
  instance credentials <name>
  model estimate --file payload.json
  model create-local --file payload.json
  model create-external --file payload.json
  model remove <name>
  model cleanup-runtime
  settings set [--public-domain domain] [--mdns-domain domain]
  user create <username> --password-file file [--access-level user|viewer|operator|admin]
  user update <id> [--first-name value] [--last-name value] [--email value]
  user role <id> <user|viewer|operator|admin>
  user enable|disable <id>
  user password <id> --password-file file [--permanent]
  user delete <id> --confirm <username>
  api-key create <name>
  api-key revoke <id>
  kubernetes-access set <id> <none|viewer|operator|admin>
  kubernetes-access kubeconfig <id> [--output path|-]

Global options:
  --api-url URL        Default: https://api.magicstick.local
  --issuer URL         Default: derived id.<domain>/realms/magicstick
  --client-id ID       Default: magicstick-cli
  --json               Machine-readable JSON output
  --no-color           Disable ANSI colors in the TUI
  --refresh SECONDS    TUI refresh interval; minimum 5, default 15
  -h, --help           Show this help
  -V, --version        Show the CLI version

Environment:
  MAGICSTICK_API_URL, MAGICSTICK_ISSUER, MAGICSTICK_CLIENT_ID
  MAGICSTICK_ACCESS_TOKEN (non-persistent automation token)
  MAGICSTICK_CONFIG_HOME, NODE_EXTRA_CA_CERTS
`;

const textOption = (parsed: ParsedArguments, name: string) => {
  const value = option(parsed, name);
  return typeof value === 'string' ? value : undefined;
};

const integerOption = (parsed: ParsedArguments, name: string, fallback: number) => {
  const raw = textOption(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer.`);
  return value;
};

const required = (value: string | undefined, description: string) => {
  if (!value) throw new Error(`Missing ${description}. Run \`magicstick --help\` for usage.`);
  return value;
};

const readJsonPayload = async (parsed: ParsedArguments, io: CliIo) => {
  const filename = required(textOption(parsed, 'file'), '--file');
  const content = filename === '-' ? await io.readStdin() : await fs.readFile(filename, 'utf8');
  try { return JSON.parse(content) as unknown; } catch { throw new Error(`The payload in ${filename} is not valid JSON.`); }
};

const readPassword = async (parsed: ParsedArguments, io: CliIo) => {
  const filename = textOption(parsed, 'password-file');
  if (filename) return (filename === '-' ? await io.readStdin() : await fs.readFile(filename, 'utf8')).replace(/[\r\n]+$/, '');
  if (option(parsed, 'password-stdin')) return (await io.readStdin()).replace(/[\r\n]+$/, '');
  throw new Error('Use --password-file <path|-> or --password-stdin; passwords are intentionally not accepted as command-line values.');
};

const output = (io: CliIo, parsed: ParsedArguments, value: unknown, human: () => string) => {
  io.stdout(option(parsed, 'json') ? stringify(value) : `${human()}\n`);
};

const summary = async (api: MagicStickApi, parsed: ParsedArguments, io: CliIo) => {
  const snapshot = await loadSnapshot(api);
  const modules = Object.values(snapshot.modules.modules ?? {});
  const instances = flattenInstances(snapshot.instances);
  const value = {
    appliance: {name: snapshot.appliance.metadata?.name ?? 'local', phase: snapshot.appliance.status?.phase},
    modules: {enabled: modules.filter((item) => item.enabled).length, total: modules.length},
    instances: instances.length,
    models: snapshot.models.activations.length,
    loadedAt: new Date(snapshot.loadedAt).toISOString(),
  };
  output(io, parsed, value, () => table(['RESOURCE', 'VALUE', 'STATUS'], [
    ['Appliance', value.appliance.name, phase(value.appliance.phase)],
    ['Modules', `${value.modules.enabled}/${value.modules.total}`, 'enabled'],
    ['Instances', value.instances, 'configured'],
    ['Models', value.models, 'activated'],
  ]));
};

const serviceCommand = async (runtime: Runtime, parsed: ParsedArguments, io: CliIo, action: string, name?: string) => {
  if (!action || action === 'list') {
    const payload = await runtime.api.modules();
    const catalog = payload.catalogJson?.modules ?? {};
    output(io, parsed, payload, () => table(['NAME', 'DISPLAY NAME', 'ENABLED', 'PHASE'], Object.entries(payload.modules ?? {}).map(([id, item]) => [
      id, item.displayName ?? catalog[id]?.displayName ?? titleFromKey(id), item.enabled ? 'yes' : 'no', phase(item.status?.phase),
    ])));
    return;
  }
  const id = required(name, 'service name');
  if (action === 'enable') {
    const parameters = Object.fromEntries(optionValues(parsed, 'set').map((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error(`Invalid --set ${entry}; expected key=value.`);
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    const result = await runtime.api.enableModule(id, parameters);
    output(io, parsed, result, () => `Enabled ${id}.`);
    return;
  }
  if (action === 'disable') {
    const result = await runtime.api.disableModule(id);
    output(io, parsed, result, () => `Disabled ${id}.`);
    return;
  }
  if (action === 'credentials') {
    const result = await runtime.api.moduleCredentials(id);
    output(io, parsed, result, () => table(['KEY', 'VALUE'], (result.credentials ?? []).map((item) => [item.key, item.value])));
    return;
  }
  throw new Error(`Unknown service action: ${action}`);
};

const instanceCommand = async (runtime: Runtime, parsed: ParsedArguments, io: CliIo, action: string, name?: string) => {
  if (!action || action === 'list') {
    const payload = await runtime.api.instances();
    output(io, parsed, payload, () => table(['TYPE', 'NAME', 'PHASE', 'MESSAGE'], flattenInstances(payload).map((item) => [
      item.type, item.name, phase(item.value.status?.phase), truncate(item.value.status?.message),
    ])));
    return;
  }
  const id = required(name, action === 'create' ? 'instance type' : 'instance name');
  if (action === 'create') {
    const result = await runtime.api.createInstance(id, await readJsonPayload(parsed, io));
    output(io, parsed, result, () => `Created ${id} instance request.`);
  } else if (action === 'remove') {
    const result = await runtime.api.removeInstance(id);
    output(io, parsed, result, () => `Removed instance ${id}.`);
  } else if (action === 'credentials') {
    const result = await runtime.api.instanceCredentials(id);
    output(io, parsed, result, () => table(['KEY', 'VALUE'], (result.credentials ?? []).map((item) => [item.key, item.value])));
  } else throw new Error(`Unknown instance action: ${action}`);
};

const discoveryParams = (parsed: ParsedArguments, query?: string) => {
  const params = new URLSearchParams({provider: textOption(parsed, 'provider') ?? 'huggingface'});
  if (query) params.set('q', query);
  const limit = textOption(parsed, 'limit');
  const cursor = textOption(parsed, 'cursor');
  if (limit) params.set('limit', limit);
  if (cursor) params.set('cursor', cursor);
  return params;
};

const modelCommand = async (runtime: Runtime, parsed: ParsedArguments, io: CliIo, action: string, argument?: string) => {
  if (!action || action === 'list') {
    const payload = await runtime.api.models();
    output(io, parsed, payload, () => [
      table(['NAME', 'TYPE', 'PHASE', 'ENGINE', 'TARGET'], payload.activations.map((item) => {
        const local = item.spec?.local ?? {};
        return [item.metadata?.name, item.spec?.type, phase(item.status?.phase), String(local.engine ?? ''), String(local.computeTarget ?? '')];
      })),
      '', 'Compute targets',
      table(['ID', 'AVAILABLE', 'ENGINES', 'MESSAGE'], payload.computeTargets.targets.map((target) => [target.id, target.available ? 'yes' : 'no', target.engines?.join(','), truncate(target.message)])),
    ].join('\n'));
    return;
  }
  if (action === 'search') {
    const result = await runtime.api.searchModels(discoveryParams(parsed, required(argument, 'search query')));
    output(io, parsed, result, () => table(['REPOSITORY', 'FORMAT', 'QUANTIZATION', 'SIZE'], result.results.map((item) => [item.repo, item.format, item.quantization?.label, item.sizeLabel])));
  } else if (action === 'popular') {
    const result = await runtime.api.popularModels(discoveryParams(parsed));
    output(io, parsed, result, () => table(['REPOSITORY', 'PUBLISHER', 'FORMAT', 'SIZE'], result.results.map((item) => [item.repo, item.author, item.format, item.sizeLabel])));
  } else if (action === 'artifacts') {
    const params = discoveryParams(parsed);
    params.set('repo', required(argument, 'model repository'));
    const result = await runtime.api.modelArtifacts(params);
    output(io, parsed, result, () => table(['ARTIFACT', 'FORMAT', 'QUANTIZATION', 'SIZE'], result.artifacts.map((item) => [item.repo, item.format, item.quantization?.label, item.sizeLabel])));
  } else if (action === 'estimate') {
    const result = await runtime.api.estimateMemory(await readJsonPayload(parsed, io));
    output(io, parsed, result, () => table(['MINIMUM', 'RECOMMENDED', 'WEIGHTS', 'KV CACHE', 'DOWNLOAD'], [[
      formatMi(result.minimumMi), formatMi(result.recommendedMi), formatMi(result.weightsMi), formatMi(result.kvCacheMi), formatBytes(result.downloadBytes),
    ]]));
  } else if (action === 'create-local' || action === 'create-external') {
    const payload = await readJsonPayload(parsed, io);
    const result = action === 'create-local' ? await runtime.api.createLocalModel(payload) : await runtime.api.createExternalModel(payload);
    output(io, parsed, result, () => `Created ${action === 'create-local' ? 'local' : 'external'} model request.`);
  } else if (action === 'remove') {
    const name = required(argument, 'model name');
    const result = await runtime.api.removeModel(name);
    output(io, parsed, result, () => `Removed model ${name}.`);
  } else if (action === 'cleanup-runtime') {
    const result = await runtime.api.removeLocalRuntime();
    output(io, parsed, result, () => 'Requested local runtime cleanup.');
  } else throw new Error(`Unknown model action: ${action}`);
};

const settingsCommand = async (runtime: Runtime, parsed: ParsedArguments, io: CliIo, action: string) => {
  if (!action || action === 'get') {
    const result = await runtime.api.settings();
    output(io, parsed, result, () => table(['PUBLIC DOMAIN', 'DASHBOARD HOST', 'MDNS DOMAIN'], [[result.publicDomain, result.dashboardHost, result.mdnsDomain]]));
    return;
  }
  if (action !== 'set') throw new Error(`Unknown settings action: ${action}`);
  const current = await runtime.api.settings();
  const result = await runtime.api.updateSettings({
    publicDomain: textOption(parsed, 'public-domain') ?? current.publicDomain,
    mdnsDomain: textOption(parsed, 'mdns-domain') ?? current.mdnsDomain,
  });
  output(io, parsed, result, () => 'Settings updated.');
};

const userCommand = async (runtime: Runtime, parsed: ParsedArguments, io: CliIo, action: string, id?: string, value?: string) => {
  if (!action || action === 'list') {
    const result = await runtime.api.users(textOption(parsed, 'search') ?? '', integerOption(parsed, 'first', 0), integerOption(parsed, 'max', 25));
    output(io, parsed, result, () => table(['ID', 'USERNAME', 'ENABLED', 'ACCESS', 'PROVIDER'], result.users.map((user) => [
      user.id, user.username, user.enabled ? 'yes' : 'no', user.effectiveAccessLevel ?? user.accessLevel, typeof user.provider === 'string' ? user.provider : String(user.source ?? ''),
    ])));
    return;
  }
  const userId = required(id, action === 'create' ? 'username' : 'user id');
  let result: unknown;
  if (action === 'create') result = await runtime.api.createUser({
    username: userId,
    password: await readPassword(parsed, io),
    accessLevel: textOption(parsed, 'access-level') ?? 'user',
    firstName: textOption(parsed, 'first-name') ?? '',
    lastName: textOption(parsed, 'last-name') ?? '',
    email: textOption(parsed, 'email') ?? '',
  });
  else if (action === 'update') result = await runtime.api.updateUser(userId, {
    ...(textOption(parsed, 'first-name') !== undefined ? {firstName: textOption(parsed, 'first-name')} : {}),
    ...(textOption(parsed, 'last-name') !== undefined ? {lastName: textOption(parsed, 'last-name')} : {}),
    ...(textOption(parsed, 'email') !== undefined ? {email: textOption(parsed, 'email')} : {}),
  });
  else if (action === 'role') result = await runtime.api.updateUserRoles(userId, required(value, 'access level'));
  else if (action === 'enable' || action === 'disable') result = await runtime.api.setUserEnabled(userId, action === 'enable');
  else if (action === 'password') result = await runtime.api.resetUserPassword(userId, await readPassword(parsed, io), !option(parsed, 'permanent'));
  else if (action === 'delete') result = await runtime.api.deleteUser(userId, required(textOption(parsed, 'confirm'), '--confirm username'));
  else throw new Error(`Unknown user action: ${action}`);
  output(io, parsed, result, () => `User ${action} completed.`);
};

const apiKeyCommand = async (runtime: Runtime, parsed: ParsedArguments, io: CliIo, action: string, argument?: string) => {
  if (!action || action === 'list') {
    const result = await runtime.api.apiAccess();
    output(io, parsed, result, () => table(['ID', 'NAME', 'HINT', 'STATUS'], result.items.map((item) => [item.id, item.name, item.keyHint, item.status])));
  } else if (action === 'create') {
    const result = await runtime.api.createApiKey(required(argument, 'API key name'));
    output(io, parsed, result, () => `API key created. Copy it now; it is shown only once:\n${result.key}`);
  } else if (action === 'revoke') {
    const id = required(argument, 'API key id');
    const result = await runtime.api.revokeApiKey(id);
    output(io, parsed, result, () => `Revoked API key ${id}.`);
  } else throw new Error(`Unknown api-key action: ${action}`);
};

const kubernetesCommand = async (runtime: Runtime, parsed: ParsedArguments, io: CliIo, action: string, id?: string, level?: string) => {
  if (!action || action === 'list') {
    const result = await runtime.api.kubernetesAccess(textOption(parsed, 'search') ?? '', integerOption(parsed, 'first', 0), integerOption(parsed, 'max', 100));
    output(io, parsed, result, () => table(['ID', 'USERNAME', 'ENABLED', 'ACCESS'], result.users.map((user) => [user.id, user.username, user.enabled ? 'yes' : 'no', user.accessLevel ?? 'none'])));
  } else if (action === 'set') {
    const result = await runtime.api.updateKubernetesAccess(required(id, 'user id'), required(level, 'access level'));
    output(io, parsed, result, () => 'Kubernetes access updated.');
  } else if (action === 'kubeconfig') {
    const result = await runtime.api.kubeconfig(required(id, 'user id'));
    const filename = textOption(parsed, 'output');
    if (!filename || filename === '-') io.stdout(result.content.endsWith('\n') ? result.content : `${result.content}\n`);
    else {
      await fs.writeFile(filename, result.content, {mode: 0o600});
      io.stdout(`Wrote ${filename}.\n`);
    }
  } else throw new Error(`Unknown kubernetes-access action: ${action}`);
};

const statusCommand = async (runtime: Runtime, parsed: ParsedArguments, io: CliIo) => {
  const result = await runtime.api.status();
  output(io, parsed, result, () => [
    table(['OPERATOR', 'ACTIVE', 'PHASE', 'MESSAGE'], Object.entries(result.hardwareOperators ?? {}).map(([id, item]) => [id, item.operatorActive ? 'yes' : 'no', phase(item.phase), truncate(item.message)])),
    '', table(['RESOURCE', 'COUNT'], [['Flux', result.fluxKustomizations?.length], ['Pods', result.pods?.length], ['Services', result.services?.length], ['Ingresses', result.ingresses?.length], ['HTTPRoutes', result.httpRoutes?.length]]),
  ].join('\n'));
};

export const runCli = async (argv: string[], suppliedIo: Partial<CliIo> = {}, dependencies: CliDependencies = {}) => {
  const io = {...defaultIo, ...suppliedIo};
  const parsed = parseArguments(argv);
  if (option(parsed, 'version')) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (option(parsed, 'help') || !parsed.positionals.length) {
    io.stdout(HELP);
    return 0;
  }
  const runtimeFactory = dependencies.createRuntime ?? createRuntime;
  const runtime = await runtimeFactory({
    apiUrl: textOption(parsed, 'api-url'), issuer: textOption(parsed, 'issuer'), clientId: textOption(parsed, 'client-id'),
  });
  const [command = '', action = '', argument, extra] = parsed.positionals;
  if (command === 'login') {
    await runtime.login(!option(parsed, 'no-open'), ({verificationUri, userCode, completeUri}) => {
      io.stdout(`Open ${completeUri ?? verificationUri}\nEnter code: ${userCode}\nWaiting for authentication…\n`);
    });
    const session = await runtime.api.session();
    output(io, parsed, session, () => `Signed in as ${session.username}.`);
  } else if (command === 'logout') {
    await runtime.logout();
    io.stdout('Signed out locally.\n');
  } else if (command === 'whoami') {
    const result = await runtime.api.session();
    output(io, parsed, result, () => table(['USERNAME', 'ROLES'], [[result.username, result.roles.join(', ')]]));
  } else if (command === 'overview') await summary(runtime.api, parsed, io);
  else if (command === 'service' || command === 'services') await serviceCommand(runtime, parsed, io, action, argument);
  else if (command === 'instance' || command === 'instances') await instanceCommand(runtime, parsed, io, action, argument);
  else if (command === 'model' || command === 'models') await modelCommand(runtime, parsed, io, action, argument);
  else if (command === 'settings') await settingsCommand(runtime, parsed, io, action);
  else if (command === 'user' || command === 'users') await userCommand(runtime, parsed, io, action, argument, extra);
  else if (command === 'api-key' || command === 'api-keys') await apiKeyCommand(runtime, parsed, io, action, argument);
  else if (command === 'kubernetes-access' || command === 'kubernetes') await kubernetesCommand(runtime, parsed, io, action, argument, extra);
  else if (command === 'status') await statusCommand(runtime, parsed, io);
  else if (command === 'tui') await (dependencies.runTui ?? runTui)(runtime, {
    color: !option(parsed, 'no-color'),
    refreshSeconds: integerOption(parsed, 'refresh', 15),
  });
  else throw new Error(`Unknown command: ${command}. Run \`magicstick --help\` for usage.`);
  return 0;
};
