import {certificateHint} from './auth';
import {runCli} from './commands';

runCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`Error: ${certificateHint(error)}\n`);
    process.exitCode = 1;
  },
);
