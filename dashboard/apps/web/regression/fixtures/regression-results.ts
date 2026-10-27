import type {RegressionResult} from '@magicstick/dashboard-contracts';

/** Public-safe saved-report fixture: infrastructure evidence is not an extra
 * executed scenario. The API's case list intentionally contains no passes. */
export function reportCountsFixture():RegressionResult {
  const cause={kind:'failure' as const,caseId:'HAR-07',reason:'CLEANUP',stage:'recovery-barrier'};
  const cases:RegressionResult['cases']=[
    {id:'HAR-10',layer:'A',variant:'',outcome:'Failed',reason:'UNEXPECTED',stage:'runner-execution',
      message:'The runner failed unexpectedly.',action:'Inspect the runner diagnostic.',durationMs:0},
    ...Array.from({length:2},()=>({id:'HAR-07',layer:'A',variant:'',outcome:'Failed' as const,reason:'CLEANUP',stage:'recovery-barrier',
      message:'Resource cleanup is not verified.',action:'Keep the exact recovery journal.',durationMs:0})),
    {id:'HAR-07',layer:'A',variant:'',outcome:'Blocked',reason:'LOCK_BUSY',message:'Another owner holds the lab reservation.',
      action:'Wait for the owner to finish.',durationMs:0,blockedBy:{kind:'prerequisite',caseId:'HAR-07',reason:'LOCK_BUSY'}},
    ...Array.from({length:17},()=>({id:'HAR-02',layer:'A',variant:'',outcome:'Blocked' as const,reason:'RECOVERY',stage:'recovery-barrier',
      message:'An earlier cleanup failed.',action:'Inspect the original cleanup failure.',durationMs:0,blockedBy:cause})),
  ];
  const counts={Passed:441,Failed:3,Blocked:18},executionCounts={Passed:345,Failed:0,Blocked:1};
  const blockedCounts={prerequisite:1,failure:17,cancelled:0,unknown:0};
  const executionBlockedCounts={prerequisite:1,failure:0,cancelled:0,unknown:0};
  return {counts,executionCounts,blockedCounts,executionBlockedCounts,cases,omittedCases:0,recoveryRequired:true,
    cleanup:{state:'unknown',reason:'RECOVERY',stage:'recovery-barrier'},
    evidenceCounts:{fixture:{Passed:433,Failed:0,Blocked:0},live:{Passed:8,Failed:3,Blocked:18}},
    phases:[{phase:0,outcome:'Failed',counts:{...counts},executionCounts:{...executionCounts},
      blockedCounts:{...blockedCounts},executionBlockedCounts:{...executionBlockedCounts}}]};
}
