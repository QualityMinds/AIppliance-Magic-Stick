/** Pure CI selection shared with the plain-Node preparation entrypoint.
 * Keep live browser/API adapters out of this import graph: their TypeScript
 * may require Playwright's transpiler rather than Node's native type stripping. */
export function currentSecurityCiRun(value:any,path:string,revision:string,now=Date.now()) {
  const updated=Date.parse(value?.updated_at ?? '');
  return value?.path === path && value.head_sha === revision && value.status === 'completed' && value.conclusion === 'success' &&
    Number.isFinite(updated) && updated <= now && now-updated <= 8*86400_000 && value.repository?.full_name === 'QualityMinds/AIppliance-Magic-Stick';
}

export function latestSecurityCiRun(runs:any[],path:string,revision:string,now=Date.now()) {
  // A newer failed/pending run must not be hidden by an older green run. The
  // endpoint is queried by exact deployed SHA, including image-pin commits.
  const latest=runs.filter(run=>run.path===path && run.head_sha===revision &&
    run.repository?.full_name==='QualityMinds/AIppliance-Magic-Stick' && Number.isSafeInteger(run.id) && run.id>0)
    .sort((a,b)=>b.id-a.id || Number(b.run_attempt??1)-Number(a.run_attempt??1))[0];
  return latest && currentSecurityCiRun(latest,path,revision,now) ? latest : undefined;
}
