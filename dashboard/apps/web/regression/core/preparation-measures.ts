import type {Approval,Readiness} from './input-preparation.ts';

const definition=(blocker:string,actions:string[],scope?:Approval)=>({blocker,actions,scope});
/** Public, static guidance only. Never interpolate API payloads, credentials,
 * private paths, identities or exception messages into preparation output. */
const definitions={
  identity:definition('Node/host identity or readiness',[
    'Wait for the selected Node and managed host to be Ready and to report the same current boot. Inspect System > Hardware if they disagree.',
    'After an intentional reinstall, reboot or update, generate a new proposal; review identity/source/image changes and accept it instead of editing pins or bypassing preflight.',
  ]),
  capability:definition('Advertised engine capability',[
    'Check Models and System > Hardware: the selected compute targets and engines must be advertised as available. Restore the required runtime/operator and wait for readiness.',
    'Do not mark unsupported hardware available or substitute a different engine silently. Regenerate inputs after the actual capability changes.',
  ]),
  idle:definition('Idle appliance (stop unrelated local models first)',[
    'With the lab owner\'s permission, use Models > Stop for active local models; saved definitions and cache can remain. Wait for host/update/channel operations to finish.',
    'Rerun preparation on the idle appliance. Preparation itself never stops models or cancels operations.',
  ]),
  lease:definition('Idle, matching pre-created lab Lease',[
    'Let the existing test run finish and release its Lease. If it was interrupted, review its private recovery journal with the lab owner.',
    'For a new lab, rerun bash tools/regression.sh setup to provision the reviewed matching Lease. Never steal, force-reset or overwrite another holder.',
  ]),
  credentials:definition('Private base credential or narrow cleaner',[
    'Run bash tools/regression.sh setup to regenerate the separate observer, locker and model/app cleaner credentials through the Dashboard/API bootstrap.',
    'Check private file permissions (directory 0700, credentials 0600), token expiry and absence of symbolic links. Do not use an admin kubeconfig as a runner fallback.',
  ]),
  'cpu-profile':definition('Complete CPU fixture profile and pins',[
    'Run setup if endpoints or scoped credentials are missing, then regenerate the proposal from the advertised CPU model catalog.',
    'Review the small CPU fixtures, Inference endpoint, boot/source pins and Ready web/API digests. Retain reviewed budgets; missing catalog entries cannot be invented.',
  ]),
  'cpu-telemetry':definition('Current usable CPU RAM telemetry',[
    'Check that Models reports current available/unreserved system RAM. Restore the Dashboard\'s node-summary/metrics observation if those values are unknown.',
    'Wait for fresh measurements and rerun preparation. Unknown RAM is not zero or unlimited capacity.',
  ]),
  'cpu-model':definition('CPU model metadata/estimator or reviewed RAM budget needs attention',[
    'Check model discovery/download connectivity and the Dashboard memory estimate for the reviewed CPU fixtures.',
    'Select a smaller advertised fixture or review a RAM budget between the estimator minimum and current usable RAM. Preparation retains existing reviewed budgets rather than silently retuning them.',
  ]),
  'cpu-discovery':definition('CPU vLLM discovery: current paged results and immutable artifact metadata',[
    'Check Hugging Face discovery connectivity and that the reviewed search returns two non-duplicated pages containing the selected repository and a revision-bound artifact.',
    'Review phase2.discovery in the private lab profile if that repository/search is no longer suitable, then regenerate the proposal. Do not invent a revision or download size.',
  ]),
  'gpu-profile':definition('Current mixed-GPU profile, fixtures, telemetry and sharing approval',[
    'Check System > Hardware for one detected AMD GPU and one NVIDIA GPU on the same managed Ready node. This installed mixed-GPU profile cannot be accepted on a CPU-only or single-vendor lab.',
    'Check Models for available AMD/NVIDIA Ollama and vLLM fixtures. Retained models must fit the reviewed budgets. Experimental FreeToken cases are currently outside the regression scope.',
    'Review the candidate gpu section and inventory. Device selection changes require a newly reviewed GPU profile, not reuse of another GPU\'s identity or consent.',
  ],'gpu'),
  'app-cleaner':definition('App-intent cleaner credential',[
    'Run bash tools/regression.sh setup to provision the separate namespaced app-intent cleaner. Use setup --manual only for externally provisioned scoped credentials.',
    'Verify applications.cleanerKubeconfig names its private readable file; an observer or administrator credential is not a substitute.',
  ]),
  'optional-module':definition('Reviewed disabled optional module and approval',[
    'Run bash tools/regression.sh setup and select an advertised non-critical disabled module. After approval setup creates/verifies its disabled fixture through the normal Dashboard API.',
    'Do not use Dashboard, Identity, Inference, GPU or Mesh as the optional-module fixture.',
  ],'modules'),
  'amd-profile':definition('Alternate AMD profile and approval',[
    'In setup, select an actually advertised alternate AMD profile. Review its experimental flag and ensure the managed intent is idle.',
    'If the lab offers no alternate profile, this scenario needs another suitable fixture/lab; approving the operation alone cannot supply one.',
  ],'amd-profile'),
  users:definition('Approval for disposable test users',[
    'Review permission to create, change and delete only run-prefixed disposable users. The recovery/last administrator must remain untouched.',
  ],'identity'),
  'oidc-plugin':definition('Linux OIDC plugin hash and disposable-user grant approval',[
    'Run bash tools/regression.sh setup. Approve the pinned checksum-verified Linux OIDC plugin download for the detected runner architecture, or select your reviewed binary.',
    'The plugin must be executable (0700), match the stored checksum and use the trusted issuer. The separate test approval covers grants only to disposable users, not a permanent admin fallback.',
  ],'kubernetes'),
  licenses:definition('Installation-bound valid/expired/wrong-installation/tampered signed licenses and replacement approval',[
    'Run bash tools/regression.sh setup. Approve installation-bound TEST-only license generation and the optional local public trust key, or select externally signed test files.',
    'Review the separate document-only no-file baseline grant and license replacement. The original document is restored; installation identity and official issuer trust stay unchanged. Never import a production signing key.',
    'If this is the first activation, separately review retention via --approve first-license; there is no delete API for undoing first activation.',
  ],'license'),
  'api-restarter':definition('Separate API-Pod restarter and approval',[
    'In bash tools/regression.sh setup, separately approve the API restart scope; setup provisions its distinct narrow credential after lab-grant review. The manual --api-restart path remains available.',
    'License replacement consent does not also permit a restart. Approve that interruption separately after checking the fixture and recovery path.',
  ],'api-restart'),
  federation:definition('Controlled test IdP, broker cleaner, short-lived signed license, OIDC/SAML adapters and approval',[
    'Provision a separate controlled HTTPS test IdP, reviewed OIDC/SAML metadata and role mappings, and narrow upstream-user/broker-cleanup clients. Do not borrow production IdPs.',
    'Answer the federation questions in setup: controlled IdP/realm, actual OIDC/SAML mappings and hidden narrow-client secrets. The wizard saves the private bundle; no hand-written JSON is needed.',
    'With the approved local test signer, the test mints its short-lived license immediately before expiry proof. Without it, select an externally signed fresh fixture. Setup cannot create an external IdP merely from a URL.',
  ],'federation'),
  mesh:definition('Distinct pinned second appliance and approved Mesh/GPU transitions',[
    'Prepare a real second appliance with its own accepted identity/source/image pins, scoped credentials and Lease. Both peers need verified TLS and reachable Mesh enrollment, with no existing membership.',
    'In setup, select the second appliance\'s prepared private input directory and enrollment origin. The wizard imports the referenced scoped credentials and offers verified peer CA trust.',
    'One appliance or a browser fixture cannot provide remote Mesh inference evidence. Review transitions on both peers before approval.',
  ],'mesh'),
  companion:definition('Fresh exact-commit native companion build evidence',[
    'Run build-mesh-companion.yml on a ref resolving to the exact installed commit; wait for successful macos-arm64, macos-x64, linux-x64 and windows-x64 acceptance artifacts.',
    'Artifacts must be unexpired and the run at most 30 days old. Rerun preparation to discover the proof; if GitHub access is restricted, supply only a read-only tokenFile in the private companion profile.',
    'A local Linux build or another commit\'s successful run is not native companion acceptance. No new product release tag is required just to rerun CI.',
  ]),
  realtime:definition('Two reviewed advertised exclusive/shared Realtime fixtures and approval',[
    'In setup, select an advertised supported one-GPU Omni profile and review its bounded context/RAM/GPU budget. The wizard creates both exclusive and shared Realtime fixtures.',
    'No eligible profile means a real hardware/runtime prerequisite is missing. Ordinary vLLM/Ollama settings are not Realtime fixtures.',
  ],'realtime'),
  repeat:definition('Reviewed repeat budgets',[
    'Answer setup\'s repetition questions (3–10 cycles and memory/non-cache disk growth budgets). Warm the small CPU model cache before the live repetition test.',
  ]),
  'security-ci':definition('Fresh successful security/publication CI for the exact installed commit',[
    'Run dependency-security.yml (advisories) and public-release-checks.yml (release-checks) on a ref resolving to the exact installed commit. Both must succeed and be at most eight days old.',
    'Rerun preparation to discover these runs. Check GitHub/network access; a private securityCi.tokenFile can provide read-only access when needed.',
    'Fix genuine CI findings rather than reusing old run IDs, changing installed commit pins or disabling the gate. Offline tests are not a current advisory/secret audit.',
  ]),
  'physical-drill':definition('Reviewed destructive recipes and independent recovery',[
    'Run setup and explicitly approve the destructive host scope for this exact test installation. Select the actual managed host and confirm independent console recovery.',
    'Answer each typed maintenance/network/channel/cache/reboot recipe and expected outcome. Runtime derives only the fresh same-host plan/boot; unknown identities or unexplained reboots still block.',
    'For BOOT-02 only, after that review: bash tools/regression.sh prepare --phases 6 --drill BOOT-02 --approve reboot --independent-recovery. Accept its proposal, then run only that drill separately; it does not unblock all of Phase 6.',
    'A complete reviewed recipe bundle permits sequential phase6 execution. NET-07 still needs a real out-of-band console restart; update/failure fixtures and exact channel/image outcomes must actually exist.',
  ]),
  'unmanaged-key':definition('Reviewed disposable unmanaged key',[
    'In setup, approve the disposable unmanaged-key probe and automatic one-hour fixture creation/cleanup. Runtime proves the actual record before and after the denied Dashboard deletion.',
    'Alternatively select a real reviewed disposable key SHA-256 ID. Never select an application key or invent an ID; only automatically owned fixtures are deleted upstream.',
  ]),
};
export type PreparationMeasureId=keyof typeof definitions | `app-${'openclaw'|'hermes'|'paperclip'|'kubeopencode'|'odysseus'}`;
export interface PreparationMeasure {id:PreparationMeasureId; blocker:string; missing:string[]; actions:string[];
  approval?:{scope:Approval;command:string}}

export function preparationMeasure(id:PreparationMeasureId,missing:string[]=[],phase?:number,approvalNeeded=false):PreparationMeasure {
  const entry=id in definitions ? definitions[id as keyof typeof definitions] : definition(`Reviewed ${id.slice(4)} UI adapter`,[
    `Check that ${id.slice(4)} is advertised in the application catalog and inspect its shipped UI on an approved disposable instance.`,
    'Run bash tools/regression.sh setup and answer the application adapter questions. Save the actual HTTPS {name} origin template, prompt label, send-button name, response selector and marker once; do not guess controls.',
  ]);
  return {id,blocker:entry.blocker,missing:missing.length ? [...new Set(missing)] : [entry.blocker],actions:[...entry.actions],
    ...(entry.scope && approvalNeeded && phase !== undefined ? {approval:{scope:entry.scope,
      command:`bash tools/regression.sh prepare --phases ${phase} --approve ${entry.scope}`}} : {})};
}

/** Normal registered-lab output must not send users back to the retired
 * questionnaire. These are actual infrastructure actions, not approval forms. */
export function automaticPreparationMeasure(id:PreparationMeasureId,missing:string[]=[]):PreparationMeasure {
  const action=id === 'mesh' ? 'Register a real second disposable appliance for Mesh tests; a single server cannot provide peer inference.' :
    id === 'federation' ? 'Provide a controlled test IdP. Without one, only federation cases are Blocked; local identity tests still run.' :
    id === 'security-ci' ? 'Run dependency-security.yml and public-release-checks.yml successfully for the installed commit, then repeat all; current evidence is discovered automatically.' :
    id === 'companion' ? 'Run build-mesh-companion.yml successfully for the installed commit on all four packaged platforms, then repeat all; current evidence is discovered automatically.' :
    id === 'physical-drill' ? 'The requested drill needs an available repository-owned recipe and, for forced outages, a real independent power controller. Other host tests still run.' :
    id === 'lease' ? 'Wait for the other run. Never steal a live Lease; interrupted mutations need verified restoration.' :
    id === 'identity' ? 'Restore the registered server. An intentional reinstall requires a new explicit registration; reboots are discovered automatically.' :
    id === 'credentials' || id === 'oidc-plugin' || id === 'api-restarter' || id === 'app-cleaner' || id === 'licenses' ?
      'Repeat all after restoring test-server reachability. The runner renews scoped access and creates its own fixtures; no manual kubeconfigs or approvals are needed.' :
    id === 'idle' ? 'Wait for the current host operation; all stops existing local models automatically without deleting their definitions.' :
    id === 'amd-profile' ? 'This change-profile case needs another compatible profile advertised by the installed AMD catalog. Other AMD tests still run; do not invent an unsupported profile.' :
    id === 'gpu-profile' || id === 'capability' || id === 'realtime' ?
      'Restore the missing real hardware or advertised runtime. Available providers and engines are tested independently.' :
    id.startsWith('app-') || id === 'optional-module' ?
      'Restore the advertised application/module catalog or its runtime. The runner chooses fixtures and inspects UI controls automatically.' :
      'Restore model discovery, downloads or current RAM telemetry. The runner selects and sizes small catalog fixtures automatically.';
  const original=preparationMeasure(id,missing);
  const cleanMissing=missing.map(item=>item.replace(/^The reviewed typed recipe for ([A-Z][A-Z0-9]+-[0-9]+) was not completed in setup\.$/,
    'No available repository-owned host recipe for $1.')).filter(item=>!/(?:approved|consent|reviewed|completed in setup)/i.test(item));
  return {id,blocker:id === 'physical-drill' ? 'Available host drill and recovery infrastructure' :
    id === 'gpu-profile' ? 'Available GPU/runtime fixtures' : id.startsWith('app-') ? 'Advertised application and automatic UI adapter' :
    original.blocker.replace(/Reviewed | and approval|approval|reviewed /gi,''),
    missing:cleanMissing.length ? [...new Set(cleanMissing)] : [action],actions:[action]};
}

/** Same actionable text is saved privately and printed; structured plan.json
 * retains the reasons/actions too. Commands are guidance, never executed here. */
export function readinessLines(readiness:Readiness[]):string[] {
  return readiness.flatMap(item=>[`Phase ${item.phase}: ${item.state}`,...item.measures.flatMap(measure=>[
    '  - '+measure.blocker,...measure.missing.map(reason=>'    Missing: '+reason),
    ...measure.actions.map(action=>'    Action: '+action),
    ...(measure.approval ? ['    Only after review (proposal only): '+measure.approval.command] : []),
  ])]);
}
