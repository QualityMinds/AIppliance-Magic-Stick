import {expect} from '@playwright/test';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {writePrivate} from '../core/private-files.ts';
import {HarnessError} from '../core/errors.ts';

/** Execute the owning Vitest suite without duplicating product behavior here. */
export async function componentSuite(file: string, requiredTitles: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'magicstick-units-'));
  try {
    const report = join(directory, 'units.json');
    const processResult=spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', file, '--config', 'regression/components/vitest.config.ts',
      '--configLoader=native', '--maxWorkers=1', '--reporter=json', '--outputFile=' + report],
    {timeout: 180_000, stdio: 'pipe', maxBuffer: 1024 * 1024,
      env: {...process.env, HOME: directory, XDG_CONFIG_HOME:directory, XDG_DATA_HOME:directory,
        REGRESSION_UNIT_CACHE_DIR: join(directory, 'cache')}});
    let result:{success:boolean;testResults:Array<{assertionResults:Array<{fullName:string;status:string}>}>};
    try {result=JSON.parse(await readFile(report,'utf8'));}
    catch {throw new HarnessError('COMPONENT');}
    if(processResult.error || processResult.status !== 0 || !result.success) {
      // Retain only bounded structured status, never captured stdout, exception
      // bodies, assertion values, stack traces or dynamically interpolated titles.
      if(process.env.REGRESSION_RUN_DIR)await writePrivate(join(process.env.REGRESSION_RUN_DIR,'component-failure.json'),{
        version:1,suite:file,status:processResult.status,failedAssertions:result.testResults.flatMap(item=>item.assertionResults)
          .filter(item=>item.status !== 'passed').map((_item,index)=>({index,status:'failed'}))});
      throw new HarnessError('COMPONENT');
    }
    expect(result.success).toBe(true);
    const assertions = result.testResults.flatMap(item => item.assertionResults);
    expect(assertions.length).toBeGreaterThan(0); expect(assertions.every(item => item.status === 'passed')).toBe(true);
    for (const title of requiredTitles) expect(assertions.some(item => item.fullName.includes(title))).toBe(true);
  } finally { await rm(directory, {recursive: true, force: true}); }
}

/** Execute selected repository-owned Python contracts and require their named proof. */
export function pythonSuite(cwd: string, tests: string[]) {
  const result = spawnSync('python3', ['-m', 'unittest', '-v', ...tests], {
    cwd: resolve(cwd), timeout: 180_000, stdio: 'pipe', maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: [resolve('../../..'),process.env.PYTHONPATH].filter(Boolean).join(':')},
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  for (const name of tests) expect(output).toContain(name.split('.').at(-1));
  expect(result.error).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toContain('OK');
  expect(output).not.toMatch(/\bskipped=|\.\.\. skipped|\bexpected failures=/);
}
