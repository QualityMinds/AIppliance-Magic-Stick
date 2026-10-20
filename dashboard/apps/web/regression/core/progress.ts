/** Opt-in, public-safe structured events; no console-log scraping or raw errors. */
export function progressEvent(value:Record<string,unknown>) {
  if(process.env.REGRESSION_PROGRESS_EVENTS === '1')process.stdout.write('REGRESSION_EVENT '+JSON.stringify({version:1,...value})+'\n');
}
