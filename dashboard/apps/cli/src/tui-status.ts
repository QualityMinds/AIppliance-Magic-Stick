// System → System Status: overview, GPU operators, Flux, routes, model cache and
// regression tests (apps/web/src/pages/SystemPage.tsx, ModelCachePage.tsx, RegressionPage.tsx).
import {
  formatBytes, phaseTone, regressionBlockedKind, regressionBlockedLabel, regressionBlockedSummary,
} from '@magicstick/dashboard-core';
import type {
  HostOperationRequest, ManagedHost, RegressionBlockedCounts, RegressionCounts, RegressionPhase, RegressionResult, RegressionRun,
  RegressionStatus, RegressionTestMode,
} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import type {DialogItem, ViewerLine} from './tui-dialogs';
import {activeStatusSection, availableStatusSections, type PageState, type PageView} from './tui-state';
import {
  button, clipText, fit, gap, joinSpans, link, panel, phaseToneOf, progressBar, prose, rowWidth, span, table, toggle,
  type Row, type Tone,
} from './tui-screen';
import {
  blank, dateTime, facts, loadingRows, metrics, plural, sectionLabel, statusBadge, tabBar, terminalHostPhases, text,
} from './tui-widgets';

const indent = (rows: Row[], width = 2): Row[] => rows.map((row) => [gap(width), ...row]);

/** The section tabs, wrapped onto further rows when they do not fit, so every tab stays clickable. */
const wrappedTabs = (prefix: string, items: Array<{id: string; label: string}>, active: string, width: number): Row[] => {
  const groups: Array<typeof items> = [];
  for (const item of items) {
    const group = groups.at(-1);
    if (group && rowWidth(tabBar(prefix, [...group, item], active)) <= width) group.push(item);
    else groups.push([item]);
  }
  return groups.map((group) => tabBar(prefix, group, active));
};
const titled = (width: number, title: string, actions: Row = []): Row => fit(width, [span(title, undefined, true)], actions);

// ---------------------------------------------------------------- resources

const sortedOperators = (snapshot: DashboardSnapshot) => Object.entries(snapshot.status.hardwareOperators ?? {})
  .sort(([, left], [, right]) => String(left.displayName ?? left.module ?? '').localeCompare(String(right.displayName ?? right.module ?? '')));

const resourceCounts = (snapshot: DashboardSnapshot) => {
  const status = snapshot.status;
  const operators = sortedOperators(snapshot);
  return {
    operators,
    activeOperators: operators.filter(([, operator]) => operator.operatorActive).length,
    readyOperators: operators.filter(([, operator]) => String(operator.phase).toLowerCase() === 'ready').length,
    runningPods: (status.pods ?? []).filter((pod) => pod.phase === 'Running').length,
    readyFlux: (status.fluxKustomizations ?? []).filter((item) => item.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')).length,
    acceptedRoutes: (status.httpRoutes ?? []).filter((route) => route.accepted).length,
  };
};

const refreshRow = (width: number, label: string): Row => fit(width, [], [button('reload', label)]);

const overviewRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const status = snapshot.status;
  const counts = resourceCounts(snapshot);
  return [
    refreshRow(width, 'Refresh status'),
    ...metrics(width, [
      {label: 'Pods', value: `${counts.runningPods}/${status.pods?.length ?? 0}`, detail: span('running', 'dim')},
      {label: 'Services', value: String(status.services?.length ?? 0), detail: span('discovered', 'dim')},
      {label: 'Ingresses', value: String(status.ingresses?.length ?? 0), detail: span('discovered', 'dim')},
      {label: 'Gateway Routes', value: String(status.httpRoutes?.length ?? 0), detail: span('discovered', 'dim')},
    ]),
    blank,
    ...panel(width, {title: 'Status summary'}, [
      ...facts(width - 4, [
        ['GPU operators', `${counts.readyOperators} ready / ${counts.activeOperators} active / ${counts.operators.length} known`],
        ['Flux', `${counts.readyFlux} / ${status.fluxKustomizations?.length ?? 0} ready`],
        ['Gateway routes', `${counts.acceptedRoutes} / ${status.httpRoutes?.length ?? 0} accepted`],
      ]),
      blank,
      ...prose(width - 4, 'Open the corresponding tab for component details and reported failure reasons.', 'dim'),
    ]),
  ];
};

const operatorRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const counts = resourceCounts(snapshot);
  const inner = width - 4;
  return [
    refreshRow(width, 'Refresh status'),
    ...panel(width, {title: 'GPU Operators', meta: `${counts.readyOperators} ready / ${counts.activeOperators} active / ${counts.operators.length} known`}, [
      ...prose(inner, 'Operators activate only when shared hardware discovery finds a matching GPU.', 'dim'),
      ...(counts.operators.length ? counts.operators.flatMap(([id, operator]) => [
        blank,
        fit(inner, [span(operator.displayName ?? id, undefined, true)], [statusBadge(operator.phase)]),
        ...indent(facts(inner - 2, [
          ['Version', operator.operatorVersion ?? 'unknown'],
          ['Driver mode', operator.driverMode ?? 'unknown'],
          ['Detected / compatible', `${operator.detectedNodes?.length ?? 0} / ${operator.compatibleNodes?.length ?? 0} nodes`],
          ['Allocatable', `${operator.allocatableResources ?? 0} resource(s)`],
          ['Managed by', operator.managedBy ?? 'none'],
          ['Needed', operator.needed ? 'yes' : 'no'],
        ])),
        ...indent(prose(inner - 2, operator.message ?? 'No status message.', 'dim')),
      ]) : [blank, text(inner, 'Hardware operator status has not been reported yet.', 'dim')]),
    ]),
  ];
};

const fluxRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const items = snapshot.status.fluxKustomizations ?? [];
  const inner = width - 4;
  return [
    refreshRow(width, 'Refresh status'),
    ...panel(width, {title: 'Flux', meta: plural(items.length, 'Kustomization')}, items.length ? items.flatMap((item, index) => {
      const ready = item.conditions?.find((condition) => condition.type === 'Ready');
      const phase = ready?.status === 'True' ? 'Ready' : item.phase || 'Reconciling';
      return [
        ...(index ? [blank] : []),
        fit(inner, [span(`${item.namespace ?? ''}/${item.name ?? ''}`, undefined, true)], [statusBadge(phase)]),
        ...(ready?.reason ? indent(prose(inner - 2, ready.reason)) : []),
        ...(ready?.message && ready.message !== ready.reason ? indent(prose(inner - 2, ready.message, 'dim')) : []),
      ];
    }) : [text(inner, 'No Flux objects returned.', 'dim')]),
  ];
};

const routeRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const routes = snapshot.status.httpRoutes ?? [];
  const inner = width - 4;
  const accepted = routes.filter((route) => route.accepted).length;
  return [
    refreshRow(width, 'Refresh status'),
    ...panel(width, {title: 'Gateway Routes', meta: `${accepted} accepted`}, routes.length ? routes.flatMap((route, index) => [
      ...(index ? [blank] : []),
      fit(inner, [span(`${route.namespace ?? ''}/${route.name ?? ''}`, undefined, true)], [statusBadge(route.accepted ? 'Accepted' : 'Pending')]),
      ...(route.hostnames ?? []).map((hostname) => [gap(2), link(`https://${hostname}/`)]),
    ]) : [text(inner, 'No Gateway API routes returned.', 'dim')]),
  ];
};

// ---------------------------------------------------------------- model cache

const cacheSize = (value?: number) => value === 0 ? '0 B' : formatBytes(value);

/** Why clearing the cache is not possible right now, with the browser's wording; empty when allowed. */
export const cacheClearReason = (host: ManagedHost, stale: boolean) => {
  const cache = host.modelCache;
  const active = Boolean(host.operation && !terminalHostPhases.has(host.operation.phase));
  if (!cache) return 'Model cache management requires the current host worker.';
  return stale || !host.available ? 'Host information is unavailable or stale.'
    : host.updates?.busy || active ? 'Another host operation is in progress.'
      : cache.blocked ? cache.message || 'Stop local models before clearing the cache.'
        : !cache.reclaimableBytes ? 'The model cache is empty.'
          : !cache.id ? 'Host information is incomplete. Refresh before clearing the cache.' : '';
};

const modelCacheRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const inner = width - 4;
  const stale = Boolean(snapshot.errors?.hosts);
  const header: Row[] = [
    titled(width, 'Model cache', [button('reload', 'Refresh cache')]),
    ...prose(width, 'Disk space for downloaded models, not RAM or VRAM. Only known model-cache directories are cleared. Shared caches stay protected while local model deployments exist; unpinned and KubeAI deployments may also protect caches on other nodes.', 'dim'),
    blank,
  ];
  if (!snapshot.hosts) return [...header, ...loadingRows(width, snapshot.errors?.hosts, 'Host information')];
  const nodes = snapshot.hosts.nodes;
  return [
    ...header,
    ...nodes.flatMap((host) => {
      const cache = host.modelCache;
      if (!cache?.supported) return panel(width, {title: host.name}, prose(inner, cache?.message || 'Model cache management requires the current host worker.', 'dim'));
      const reason = cacheClearReason(host, stale);
      const operation = host.operation?.action === 'clear-model-cache' ? host.operation : undefined;
      return panel(width, {title: host.name}, [
        ...facts(inner, [
          ['System disk', cacheSize(cache.totalBytes)],
          ['Free disk space', cacheSize(cache.freeBytes)],
          ['Clearable model cache', cacheSize(cache.reclaimableBytes)],
        ]),
        blank,
        ...table(inner, [{header: 'Engine cache', max: 48}, {header: 'Size'}], cache.caches.map((entry) => ({cells: [span(entry.name), span(cacheSize(entry.usedBytes))]}))),
        ...(cache.caches.length ? [] : [text(inner, 'No engine caches reported.', 'dim')]),
        blank,
        fit(inner, [], [button(`cache:clear:${host.nodeUid}`, 'Clear model cache', 'danger', reason || undefined)]),
        ...(reason ? prose(inner, reason, 'dim') : []),
        ...(operation ? [
          blank,
          fit(inner, [span('Cache cleanup', undefined, true)], [statusBadge(operation.phase)]),
          ...indent(prose(inner - 2, operation.message || 'Waiting for the host worker.', 'dim')),
        ] : []),
      ]);
    }),
    ...(nodes.length ? [] : [text(width, 'No manageable computers reported.', 'dim')]),
  ];
};

const clearModelCache = (ctx: TuiContext, nodeUid: string) => {
  const stale = () => Boolean(ctx.snapshot().errors?.hosts);
  const host = ctx.snapshot().hosts?.nodes.find((item) => item.nodeUid === nodeUid);
  if (!host?.modelCache) return ctx.missing();
  const reason = cacheClearReason(host, stale());
  if (reason) return ctx.message('Cache cleanup unavailable', reason);
  const cache = host.modelCache;
  const request: HostOperationRequest = {
    action: 'clear-model-cache', nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId,
    requestId: ctx.requestId(), planId: cache.id, confirmation: host.name,
    acknowledgeDisruption: true, allowExperimental: false, experimentMode: false,
  };
  ctx.confirm({
    title: 'Clear model cache', confirmLabel: 'Clear cache', expected: host.name, danger: true,
    description: `${host.name}: delete cached Hugging Face and Ollama model files (${formatBytes(cache.reclaimableBytes)}). They must be downloaded again when needed. Model settings, credentials, container images and application data are kept. Active models block cleanup; this action does not stop them.`,
    onConfirm: () => {
      // The host may have changed while the confirmation was open: recheck it like the browser does.
      const current = ctx.snapshot().hosts?.nodes.find((item) => item.nodeUid === nodeUid);
      const blocked = !current ? 'This computer is no longer reported.' : current.bootId !== host.bootId || current.modelCache?.id !== cache.id
        ? 'Host state changed. Review the current model cache again.' : cacheClearReason(current, stale());
      if (blocked) throw new Error(blocked);
      return ctx.perform('Clear model cache', async () => {
        await ctx.api.requestHostOperation(request);
        return {lines: [`Cache cleanup was requested on ${host.name}. Follow the operation status; a request is not confirmation that the files were removed.`]};
      });
    },
  });
};

// ---------------------------------------------------------------- regression tests

const TERMINAL_RUN = new Set(['Passed', 'Failed', 'Blocked', 'Cancelled']);
export const REGRESSION_PHASES: Array<{phase: RegressionPhase; name: string}> = [
  {phase: 0, name: 'Runner and safety'},
  {phase: 1, name: 'Core dashboard workflows'},
  {phase: 2, name: 'Model configuration and lifecycle'},
  {phase: 3, name: 'GPUs and multi-GPU models'},
  {phase: 4, name: 'GPU sharing and slots'},
  {phase: 5, name: 'Services and administration'},
  {phase: 6, name: 'Host maintenance'},
  {phase: 7, name: 'Mesh and Realtime'},
  {phase: 8, name: 'Security, usability and performance'},
];
const ALL_PHASES = REGRESSION_PHASES.map((option) => option.phase);

const recordedCounts = (value: unknown): value is RegressionCounts => Boolean(value && typeof value === 'object'
  && (['Passed', 'Failed', 'Blocked'] as const).every((outcome) => {
    const count = (value as Record<string, unknown>)[outcome];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  }));

const blockedBreakdown = (counts: RegressionBlockedCounts | undefined, total: number) => total === 0 ? ''
  : counts ? regressionBlockedSummary(counts) : 'Cause breakdown unavailable for this older run.';

const outcomeMetrics = (width: number, counts: RegressionCounts, blocked: RegressionBlockedCounts | undefined, unit: string): Row[] => [
  ...metrics(width, (['Passed', 'Failed', 'Blocked'] as const).map((outcome) => ({
    label: outcome, value: String(counts[outcome]), detail: span(unit, 'dim'),
  }))),
  ...(counts.Blocked ? prose(width, `Blocked: ${blockedBreakdown(blocked, counts.Blocked)}`, 'dim') : []),
];

type RegressionCase = RegressionResult['cases'][number];
const caseLabel = (row: RegressionCase): {label: string; tone: Tone} => {
  if (row.outcome !== 'Blocked') return {label: row.outcome, tone: phaseToneOf(phaseTone(row.outcome))};
  const kind = row.blockedBy?.kind ?? (row.reason === 'PREREQUISITE' && !row.executionId ? 'unknown' : regressionBlockedKind(row.reason));
  return {label: regressionBlockedLabel(kind), tone: kind === 'failure' ? 'bad' : 'warn'};
};

/** Every field the browser shows for one failed or blocked check. */
export const regressionCaseLines = (row: RegressionCase): ViewerLine[] => {
  const outcome = caseLabel(row);
  return [
    {text: `${row.id} · ${row.layer} · ${row.variant}`, bold: true},
    {text: outcome.label, tone: outcome.tone},
    ...(row.description ? [{text: row.description}] : []),
    {text: `Reason: ${row.reason} — ${row.message}`},
    ...(row.causeReason ? [{text: `Underlying cause: ${row.causeReason}${row.causeStage ? ` · ${row.causeStage}` : ''}`}] : []),
    ...(row.diagnostics?.length ? [{text: 'Cleanup observations:'}, ...row.diagnostics.map((line) => ({text: `  · ${line}`, tone: 'dim' as const}))] : []),
    ...(row.gpuValidationDiagnostics?.length ? [{text: 'GPU verification observations:'}, ...row.gpuValidationDiagnostics.map((line) => ({text: `  · ${line}`, tone: 'dim' as const}))] : []),
    ...(row.blockedBy?.caseId ? [{text: `Blocking check: ${row.blockedBy.caseId}${row.blockedBy.reason ? ` · ${row.blockedBy.reason}` : ''}${row.blockedBy.stage ? ` · Stage: ${row.blockedBy.stage}` : ''}`}] : []),
    {text: `${row.phase !== undefined ? `Phase ${row.phase} · ` : ''}Check layer ${row.layer}${row.stage ? ` · Stage: ${row.stage}` : ''}`, tone: 'dim'},
    {text: `Next action: ${row.action}`, tone: 'dim'},
    ...(row.tracePath ? [{text: `Trace in report archive: ${row.tracePath}`, tone: 'dim' as const}] : []),
    ...(row.blockedBy?.traceRunId && row.blockedBy.executionId ? [{text: `Blocking scenario trace: report-artifacts/${row.blockedBy.traceRunId}/traces/${row.blockedBy.executionId}.json`, tone: 'dim' as const}] : []),
    {text: ''},
  ];
};

const phaseResultRows = (width: number, result: RegressionResult): Row[] => {
  const columns = [8, 14, 8, 8, 8];
  const cells = (values: Array<{text: string; tone?: Tone}>): Row => values.flatMap((value, index) => [
    span(clipText(value.text, columns[index]! - 1).padEnd(columns[index]!), value.tone),
  ]);
  return [
    ...prose(width, 'Phase results · case / variant / layer evidence', undefined),
    cells([{text: 'Phase', tone: 'dim'}, {text: 'Outcome', tone: 'dim'}, {text: 'Passed', tone: 'dim'}, {text: 'Failed', tone: 'dim'}, {text: 'Blocked', tone: 'dim'}]),
    ...result.phases.flatMap((row) => [
      cells([{text: String(row.phase)}, {text: row.outcome, tone: phaseToneOf(phaseTone(row.outcome))}, {text: String(row.counts.Passed)}, {text: String(row.counts.Failed)}, {text: String(row.counts.Blocked)}]),
      ...(row.counts.Blocked ? indent(prose(width - columns[0]!, blockedBreakdown(row.blockedCounts, row.counts.Blocked), 'dim'), columns[0]) : []),
    ]),
  ];
};

const runRows = (run: RegressionRun, state: PageState, width: number): Row[] => {
  const inner = width - 4;
  const recover = run.operation === 'recover-lock';
  const terminal = TERMINAL_RUN.has(run.phase);
  const percent = Math.max(0, Math.min(100, run.progress.percent ?? 0));
  const totalPhases = run.progress.totalPhases ?? run.phases.length;
  // Report totals include evidence outside executable scenarios; never infer them from progress or the case list.
  const counts = recordedCounts(run.result?.counts) ? run.result.counts : undefined;
  const executionCounts = recordedCounts(run.result?.executionCounts) ? run.result.executionCounts
    : !run.result && recordedCounts(run.progress.executionCounts) ? run.progress.executionCounts : undefined;
  const executionBlocked = run.result ? run.result.executionBlockedCounts : run.progress.executionBlockedCounts;
  const preparation = run.result?.preparation;
  const excludedOpen = state.expanded[`regression-excluded:${run.uid}`] ?? false;
  const executionOpen = state.expanded[`regression-executions:${run.uid}`] ?? false;
  const cases = run.result?.cases ?? [];
  const report = run.reportAvailable ? undefined : 'The report is not available for this run yet.';
  const cleanupState = run.cleanup?.state ?? run.result?.cleanup?.state ?? 'unknown (legacy or not verified)';
  return panel(width, {
    title: recover ? 'Previous run cleanup' : dateTime(run.createdAt),
    meta: `${recover ? `${dateTime(run.createdAt)} · ` : ''}Runner revision ${run.sourceRevision.slice(0, 12)}`,
    status: statusBadge(run.phase),
  }, [
    ...prose(inner, run.message),
    ...(!recover ? prose(inner, `Selected phases: ${run.phases.join(', ')}.`) : []),
    ...(run.diagnosticSelection ? prose(inner, `Diagnostic subset: ${run.result?.diagnosticSelection?.title ?? run.diagnosticSelection}${run.result?.diagnosticSelection?.caseIds.length ? ` (${run.result.diagnosticSelection.caseIds.join(', ')})` : ''}. Full-phase acceptance is not assessed.`) : []),
    ...(!recover ? prose(inner, `Test mode: ${run.testMode === 'non-destructive' ? 'Non-destructive only' : 'Full, including destructive tests'}.`) : []),
    ...(run.result?.excludedSteps?.length ? [
      [toggle(`expand:regression-excluded:${run.uid}`, `Not selected in this mode (${plural(run.result.excludedSteps.length, 'step')})`, excludedOpen)],
      ...(excludedOpen ? indent([
        ...prose(inner - 2, 'Destructive and preparation-dependent live steps were not run or counted as passed. Full-phase acceptance was not assessed.', 'dim'),
        ...run.result.excludedSteps.flatMap((step) => prose(inner - 2, `· ${step}`)),
      ]) : []),
    ] : []),
    ...(preparation && preparation.outcome !== 'Passed' ? [
      blank,
      [span(`Automatic preparation ${preparation.outcome.toLowerCase()}`, 'bad', true)],
      ...prose(inner, preparation.message, 'bad'),
      ...(preparation.action ? prose(inner, `Next action: ${preparation.action}`, 'bad') : []),
      ...prose(inner, 'Dependent live checks could not start. Passed isolated checks are not live acceptance.', 'bad'),
    ] : []),
    blank,
    progressBar(percent, `${run.progress.currentPhase !== undefined ? `Phase ${run.progress.currentPhase} P0` : run.phase} · ${percent}%`, terminal ? phaseToneOf(phaseTone(run.phase)) : 'accent'),
    ...prose(inner, recover ? 'Cleanup only: verify the old journal, restore owned resources and release its exact lock. No test phases are selected.'
      : `${run.progress.completedPhases ?? 0} / ${totalPhases} ${totalPhases === 1 ? 'phase' : 'phases'} finished. Progress reflects completed test steps, not an estimated time.`, 'dim'),
    ...prose(inner, '100% means execution finished, not passed.', 'dim'),
    ...(run.progress.step ? prose(inner, `Current step: ${run.progress.step} · ${run.progress.testIndex ?? 0} / ${run.progress.testTotal ?? 0} scenarios`) : []),
    ...(!terminal && run.progress.currentTest ? prose(inner, run.progress.currentTest) : []),
    blank,
    ...(counts ? [
      sectionLabel(inner, 'All checks', 'Case / variant / layer evidence · isolated + live'),
      ...outcomeMetrics(inner, counts, run.result?.blockedCounts, 'check evidence'),
    ] : prose(inner, `All-check totals are not available${terminal ? ' for this run' : ' yet'}.${executionCounts ? ' Only preliminary executable scenario counts are available.' : ' No final totals were reported.'}`, 'dim')),
    ...(executionCounts ? [
      [toggle(`expand:regression-executions:${run.uid}`, 'Executable scenarios', executionOpen)],
      ...(executionOpen ? indent([
        ...(!counts ? prose(inner - 2, 'Preliminary executable scenario counts; these are not all-check totals.', 'dim') : []),
        ...prose(inner - 2, 'One executable scenario can produce several check results. Runner and cleanup errors without a scenario ID are included in All checks, not added as executed scenarios.', 'dim'),
        ...outcomeMetrics(inner - 2, executionCounts, executionBlocked, 'executable scenarios'),
      ]) : []),
    ] : []),
    blank,
    ...prose(inner, `Tests: ${terminal ? 'finished' : 'in progress'} · Resource cleanup: ${cleanupState} · Test account: ${run.credentialsCleaned ? 'removed' : 'not yet removed'}`),
    ...(run.cleanup?.reason || run.cleanup?.stage ? prose(inner, `Cleanup reason: ${run.cleanup.reason ?? 'not recorded'}${run.cleanup.stage ? ` · ${run.cleanup.stage}` : ''}`, 'dim') : []),
    ...(run.result?.recoveryRequired || (run.cleanup && run.cleanup.state !== 'verified' && terminal)
      ? prose(inner, 'Resource cleanup could not be verified. Removing the test account or finishing the tests does not prove a clean baseline. Use Clean up previous test run or start a full run for exact journal recovery; old test results are never reused.', 'bad') : []),
    ...(run.result?.evidenceCounts ? prose(inner, `Live evidence: ${run.result.evidenceCounts.live.Passed} passed · ${run.result.evidenceCounts.live.Failed} failed · ${run.result.evidenceCounts.live.Blocked} blocked. Case / variant / layer evidence, separate from isolated checks and scenario counts.`, 'dim') : []),
    ...(run.result?.phases.length ? [blank, ...phaseResultRows(inner, run.result)] : []),
    ...(counts?.Blocked ? prose(inner, `Blocked evidence (case / variant / layer): ${run.result?.blockedCounts ? regressionBlockedSummary(run.result.blockedCounts) : 'Cause breakdown unavailable for this older report.'}`, 'dim') : []),
    ...(cases.length ? [
      blank,
      fit(inner, [button(`regression:cases:${run.uid}`, `Failures and blocked checks (${cases.length}${run.result?.omittedCases ? ` shown; ${run.result.omittedCases} more in the report` : ''})`)]),
    ] : []),
    blank,
    joinSpans([
      button(`regression:download:archive:${run.id}`, 'Download report', 'ghost', report),
      button(`regression:download:html:${run.id}`, 'HTML summary', 'ghost', report),
      button(`regression:download:junit:${run.id}`, 'JUnit XML', 'ghost', report),
    ]),
    ...prose(inner, 'The report archive contains summaries, JUnit, test steps and filtered traces. Credentials, kubeconfigs, raw logs and recovery journals stay private.', 'dim'),
  ]);
};

/** Derived state of the regression suite, with the browser's rules. */
export const regressionState = (data: RegressionStatus) => {
  const active = data.runs.find((run) => !TERMINAL_RUN.has(run.phase));
  const cleanupPending = data.runs.some((run) => TERMINAL_RUN.has(run.phase) && (!run.credentialsCleaned || (run.cleanup && run.cleanup.state !== 'verified')));
  const resourcesPending = data.runs.some((run) => TERMINAL_RUN.has(run.phase) && run.cleanup && run.cleanup.state !== 'verified');
  const cleanup = data.cleanup ?? {available: Boolean(data.lock?.canRecover), revision: data.lock?.revision,
    message: data.lock && data.lock.state !== 'free' ? data.lock.message : cleanupPending
      ? 'Previous run cleanup is pending; refresh to check its recovery status.' : 'No previous test run needs cleanup. New tests will verify the starting state.'};
  const lockBusy = Boolean(data.lock && data.lock.state !== 'free');
  const startBlocked = !data.registered ? 'Register this disposable test Appliance first.'
    : !data.runtimeAvailable ? 'Enable the regression runner and wait for readiness.'
      : active ? 'A test or cleanup run is active. Wait for it to finish.'
        : cleanupPending && !data.recoveryAvailable ? 'Previous-run cleanup must finish before new tests can start.'
          : lockBusy && !data.lock?.canRecover ? data.lock?.message || 'The regression lock is held.' : undefined;
  const cleanupBlocked = !data.registered ? 'Register this disposable test Appliance before cleanup.'
    : !data.runtimeAvailable ? 'Enable the regression runner and wait for readiness before cleanup.'
      : active ? 'A test or cleanup run is active. Wait for it to finish.'
        : !cleanup.available ? cleanup.message : undefined;
  return {active, cleanupPending, resourcesPending, cleanup, lockBusy, startBlocked, cleanupBlocked};
};

const regressionRows = (snapshot: DashboardSnapshot, state: PageState, width: number): Row[] => {
  const inner = width - 4;
  const header: Row[] = [
    titled(width, 'Regression tests', [button('reload', 'Refresh tests')]),
    ...prose(width, "Run all or selected Phase 0–8 P0 tests inside this Magic Stick's Kubernetes cluster.", 'dim'),
    blank,
  ];
  const data = snapshot.regression;
  if (!data) return [...header, ...loadingRows(width, snapshot.errors?.regression, 'Regression status')];
  const derived = regressionState(data);
  const enableRequested = state.ui['regression.enableRequested'] === '1';
  const enabling = !data.runtimeAvailable && enableRequested;
  const activationMessage = 'Activation requested. Waiting for the regression runner to become ready…';
  const cleanupStatus = !data.registered ? 'Register this disposable test Appliance before cleanup.'
    : !data.runtimeAvailable ? 'Enable the regression runner and wait for readiness before cleanup.'
      : derived.active ? 'A test or cleanup run is active. Wait for it to finish.' : derived.cleanup.message;
  return [
    ...header,
    ...panel(width, {title: 'Run the suite'}, [
      ...prose(inner, 'No license is required to run regression tests or download reports. Sign in as an administrator and register this disposable test server once; this is not license registration.'),
      ...prose(inner, 'For dedicated test servers only. Choose non-destructive checks, or full tests that may stop models, alter settings, deploy models and services, replace test licenses and clear model caches.'),
      ...prose(inner, 'Host restart, power-loss, network-disconnection and software-replacement drills require the external Docker runner and are reported as Blocked here. Missing GPUs, Mesh peers or test identity providers block only their dependent cases.', 'dim'),
      ...(!data.runtimeAvailable ? [
        blank,
        ...(enabling ? [
          ...prose(inner, activationMessage),
          progressBar(35, 'Starting runner services', 'warn'),
          ...prose(inner, 'Downloading images and starting the runner services can take several minutes. Status updates automatically; no tests have been started. If readiness stalls, check Services and System Status → Flux.', 'dim'),
        ] : prose(inner, data.message)),
        fit(inner, [button('regression:enable', enabling ? 'Waiting for runner readiness…' : 'Enable regression runner', 'ghost',
          enabling ? 'Activation was requested. Waiting for the regression runner to become ready.' : undefined)]),
      ] : []),
      ...(data.runtimeAvailable && enableRequested ? prose(inner, `Regression runner is ready.${!data.registered ? ' Register this disposable test Appliance to continue.' : ''}`, 'good') : []),
      ...(data.runtimeAvailable && !data.registered ? [blank, fit(inner, [button('regression:register', 'Register test Appliance', 'danger')])] : []),
      blank,
      joinSpans([
        button('regression:start', 'Start regression tests', 'primary', derived.startBlocked),
        ...(derived.active ? [button('regression:cancel', 'Cancel tests', 'danger', derived.active.phase === 'Cancelling' ? 'Cancellation is already in progress.' : undefined)] : []),
        button('regression:recover', 'Clean up previous test run', 'danger', derived.cleanupBlocked),
      ]),
      ...prose(inner, cleanupStatus),
      ...(data.lock && data.lock.state !== 'free' && data.lock.message !== derived.cleanup.message ? prose(inner, data.lock.message) : []),
      ...(derived.cleanupPending ? prose(inner, data.recoveryAvailable
        ? 'Full tests can automatically clean up the previous run first. For non-destructive tests, clean up separately before starting. Cleanup must succeed before a fresh test ID and new tests are started.'
        : derived.resourcesPending ? 'Previous-run resource cleanup is not verified. The exact recovery journal must be checked before new live tests can start.'
          : "Removing the completed run's generated test account before another run can start.", 'warn') : []),
      ...prose(inner, 'No recurring setup or manually prepared test files. Reloading or leaving this page does not stop the job.', 'dim'),
    ]),
    ...data.runs.flatMap((run) => runRows(run, state, width)),
    ...(data.runs.length ? [] : [text(width, 'No regression runs yet.', 'dim')]),
  ];
};

const startDescription = (mode: RegressionTestMode) => mode === 'non-destructive'
  ? 'Read existing appliance state and run isolated tests without stopping models or changing services, settings, licenses or caches. Creates a temporary viewer account, a Kubernetes runner Job and reports. Previous-run cleanup is not performed automatically. Excluded steps are named in the report; this is not full-phase acceptance.'
  : 'Run the selected P0 phases from the beginning after automatic cleanup and baseline checks. Existing models may be stopped; settings, services, licenses and caches may be changed on this dedicated test Appliance. Failures and unavailable prerequisites remain visible.';

const savedPhases = (ctx: TuiContext): RegressionPhase[] => {
  const saved = ctx.view.ui['regression.phases'];
  if (saved === undefined) return [...ALL_PHASES];
  return saved.split(',').filter(Boolean).map(Number).filter((value): value is RegressionPhase => ALL_PHASES.includes(value as RegressionPhase));
};

const startRegression = (ctx: TuiContext) => {
  const data = ctx.snapshot().regression;
  if (!data) return ctx.missing();
  const blocked = regressionState(data).startBlocked;
  if (blocked) return ctx.message('Tests cannot start', blocked);
  const draft = {mode: 'non-destructive' as RegressionTestMode, diagnostic: '', phases: savedPhases(ctx)};
  const live = () => ctx.snapshot().regression ?? data;
  const nonDestructiveBlocked = () => {
    const current = live();
    const derived = regressionState(current);
    return draft.mode === 'non-destructive' && (derived.cleanupPending || derived.lockBusy);
  };
  const remember = () => { ctx.view.ui['regression.phases'] = draft.phases.join(','); };
  const setPhases = (phases: RegressionPhase[]) => {
    draft.phases = [...new Set(phases)].sort((left, right) => left - right);
    remember();
  };
  const locked = () => draft.diagnostic ? 'A diagnostic subset selects its own phase.' : undefined;
  ctx.dialog({
    title: 'Start regression tests',
    items: () => {
      const profiles = live().diagnosticSelections ?? [];
      const items: DialogItem[] = [
        {kind: 'note', text: startDescription(draft.mode), tone: 'normal'},
        {kind: 'blank'},
        {kind: 'choice', id: 'mode', label: 'Test mode', value: draft.mode, choices: [
          {value: 'non-destructive', label: 'Non-destructive only'}, {value: 'full', label: 'Include destructive tests'},
        ], onChange: (value) => {
          draft.mode = value as RegressionTestMode;
          if (draft.mode === 'non-destructive') draft.diagnostic = '';
        }},
        ...(profiles.length ? [{kind: 'choice' as const, id: 'diagnostic', label: 'Test selection', value: draft.diagnostic, choices: [
          {value: '', label: 'All tests in selected phases'},
          ...profiles.map((profile) => ({value: profile.id, label: `${profile.title} (Phase ${profile.phase} · ${profile.caseIds.join(', ')})`})),
        ], onChange: (value: string) => {
          draft.diagnostic = value;
          const profile = profiles.find((item) => item.id === value);
          if (profile) {
            draft.mode = 'full';
            setPhases([profile.phase]);
          }
        }}] : []),
        ...(draft.diagnostic ? [{kind: 'note' as const, text: `Only this Phase ${draft.phases[0]} diagnostic subset will run. Preparation and cleanup remain required; this is not full-phase acceptance.`}] : []),
        ...(nonDestructiveBlocked() ? [{kind: 'note' as const, tone: 'warn' as const, text: 'Clean up the previous run separately before non-destructive tests. This mode never restores old test resources or clears their lock.'}] : []),
        {kind: 'blank'},
        {kind: 'heading', text: 'Test phases'},
        {kind: 'buttons', items: [
          {id: 'phases-all', label: 'Select all', onPress: () => setPhases([...ALL_PHASES]), disabled: locked()},
          {id: 'phases-none', label: 'Clear selection', onPress: () => setPhases([]), disabled: locked()},
        ]},
        ...REGRESSION_PHASES.map((option): DialogItem => ({
          kind: 'check', id: `phase-${option.phase}`, label: `Phase ${option.phase} · ${option.name}`, checked: draft.phases.includes(option.phase), disabled: locked(),
          onChange: (checked) => setPhases(checked ? [...draft.phases, option.phase] : draft.phases.filter((phase) => phase !== option.phase)),
        })),
        {kind: 'note', text: `${draft.mode === 'full' ? 'Preparation and cleanup run automatically for your selection.' : 'Only isolated tests and read-only inventory checks run. Existing workloads remain active.'} Other test phases are not executed or counted as passed.`},
        draft.phases.length ? {kind: 'note', text: `Selected phases: ${draft.phases.join(', ')}.`, tone: 'normal'} : {kind: 'note', text: 'Select at least one test phase.', tone: 'bad'},
      ];
      return items;
    },
    submit: {
      label: 'Start tests', tone: 'danger',
      disabled: () => !draft.phases.length ? 'Select at least one test phase.'
        : nonDestructiveBlocked() ? 'Clean up the previous run separately before non-destructive tests.' : undefined,
      run: () => ctx.perform('Start regression tests', async () => {
        const current = live();
        const derived = regressionState(current);
        if (!draft.phases.length) throw new Error('Select at least one test phase.');
        if (draft.mode === 'non-destructive' && (derived.cleanupPending || derived.lockBusy)) throw new Error('Clean up the previous run separately before non-destructive tests.');
        if (derived.startBlocked) throw new Error(derived.startBlocked);
        const profile = current.diagnosticSelections?.find((item) => item.id === draft.diagnostic);
        if (draft.diagnostic && !profile) throw new Error('This diagnostic selection is no longer available. Refresh before starting.');
        if (draft.diagnostic) await ctx.api.startRegression(ctx.requestId(), [profile!.phase], 'full', draft.diagnostic);
        else await ctx.api.startRegression(ctx.requestId(), draft.phases, draft.mode);
        delete ctx.view.ui['regression.enableRequested'];
        return {lines: ['Regression tests were requested. Progress appears under System Status → Regression tests; reloading or leaving this page does not stop the job.']};
      }),
    },
  });
};

const DOWNLOADS: Record<string, {label: string; extension: string}> = {
  archive: {label: 'report archive', extension: 'tar.gz'},
  html: {label: 'HTML summary', extension: 'html'},
  junit: {label: 'JUnit XML', extension: 'xml'},
};

const downloadReport = (ctx: TuiContext, target: string) => {
  const [kind = 'archive', ...rest] = target.split(':');
  const id = rest.join(':');
  const download = DOWNLOADS[kind];
  const run = ctx.snapshot().regression?.runs.find((item) => item.id === id);
  if (!download || !run) return ctx.missing();
  if (!run.reportAvailable) return ctx.message('Report unavailable', 'The report is not available for this run yet.');
  ctx.saveAs({
    title: `Save ${download.label}`,
    defaultName: `magicstick-${run.id}.${download.extension}`,
    content: async () => new Uint8Array(await (await ctx.api.downloadRegression(run.id, kind as 'archive' | 'html' | 'junit')).arrayBuffer()),
    done: `The ${download.label} of this run.`,
  });
};

const showCases = (ctx: TuiContext, uid: string) => {
  const run = ctx.snapshot().regression?.runs.find((item) => item.uid === uid);
  const cases = run?.result?.cases ?? [];
  if (!run || !cases.length) return ctx.missing();
  ctx.viewer({
    title: `Failures and blocked checks (${cases.length}${run.result?.omittedCases ? ` shown; ${run.result.omittedCases} more in the report` : ''})`,
    description: `${run.operation === 'recover-lock' ? 'Previous run cleanup' : dateTime(run.createdAt)} · ${run.phase}`,
    lines: () => cases.flatMap(regressionCaseLines),
  });
};

const regressionAction = (ctx: TuiContext, verb: string, target: string) => {
  const data = ctx.snapshot().regression;
  if (verb === 'download') return downloadReport(ctx, target);
  if (verb === 'cases') return showCases(ctx, target);
  if (!data) return ctx.missing();
  const derived = regressionState(data);
  const settled = () => { delete ctx.view.ui['regression.enableRequested']; };
  if (verb === 'enable') {
    if (data.runtimeAvailable) return ctx.message('Runner ready', 'The regression runner is already available.');
    return void ctx.perform('Enable regression runner', async () => {
      await ctx.api.enableModule('regression');
      ctx.view.ui['regression.enableRequested'] = '1';
      return {lines: ['Activation requested. Waiting for the regression runner to become ready…', 'Downloading images and starting the runner services can take several minutes. No tests have been started.']};
    });
  }
  if (verb === 'register') {
    if (data.registered) return ctx.message('Already registered', 'This Appliance is already registered as a disposable test server.');
    return ctx.confirm({
      title: 'Register disposable test Appliance', expected: 'DISPOSABLE TEST SERVER', confirmLabel: 'Register test Appliance', danger: true,
      description: 'This permanently binds the test policy to this Appliance and its Node identities. Do not register a production server.',
      onConfirm: () => ctx.perform('Register test Appliance', async () => {
        await ctx.api.registerRegression();
        settled();
        return {lines: ['This Appliance is registered as a disposable test server.']};
      }),
    });
  }
  if (verb === 'start') return startRegression(ctx);
  if (verb === 'cancel') {
    if (!derived.active) return ctx.message('Nothing to cancel', 'No active run to cancel.');
    const id = derived.active.id;
    return ctx.confirm({
      title: 'Cancel regression tests', confirmLabel: 'Cancel tests', danger: true,
      description: 'Stop further tests and allow bounded cleanup. Interrupted operations retain their recovery journal; cancellation does not mean restoration succeeded.',
      onConfirm: () => ctx.perform('Cancel regression tests', async () => {
        await ctx.api.cancelRegression(id);
        settled();
        return {lines: ['Cancellation was requested. Interrupted operations retain their recovery journal; cancellation does not mean restoration succeeded.']};
      }),
    });
  }
  if (verb === 'recover') {
    if (derived.cleanupBlocked) return ctx.message('Cleanup unavailable', derived.cleanupBlocked);
    // The reviewed lock revision is sent; a lock that changed meanwhile must be reviewed again.
    const reviewed = derived.cleanup.revision;
    return ctx.confirm({
      title: 'Clean up previous test run', confirmLabel: 'Clean up previous run', danger: true,
      description: 'Restore retained setup access and verify the old run’s exact resources and unchanged borrowed settings, even if its lock is already free. Active owners and missing or changed journals are not bypassed. No new regression tests will start; historical results remain unchanged.',
      onConfirm: () => ctx.perform('Clean up previous test run', async () => {
        const current = ctx.snapshot().regression;
        const cleanup = current ? regressionState(current).cleanup : undefined;
        if (!reviewed || !cleanup || cleanup.revision !== reviewed || !cleanup.available) throw new Error('The lock changed after review. Refresh and review it again.');
        await ctx.api.recoverRegressionLock(ctx.requestId(), reviewed);
        settled();
        return {lines: ['Cleanup of the previous test run was requested. No new regression tests were started.']};
      }),
    });
  }
};

// ---------------------------------------------------------------- section

export const statusSection = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const active = activeStatusSection(snapshot, state.statusSection);
  const rows = active === 'gpu-operators' ? operatorRows(snapshot, width)
    : active === 'flux' ? fluxRows(snapshot, width)
      : active === 'network' ? routeRows(snapshot, width)
        : active === 'model-cache' ? modelCacheRows(snapshot, width)
          : active === 'regression' ? regressionRows(snapshot, state, width)
            : overviewRows(snapshot, width);
  return {hotkeys: [{key: 't', label: 'Status tab', actionId: 'status-tab:next'}], rows: [
    fit(width, [span('System Status', undefined, true)]),
    ...prose(width, 'System health, resource details and maintenance tools.', 'dim'),
    ...wrappedTabs('status-tab', availableStatusSections(snapshot), active, width),
    blank,
    ...rows,
  ]};
};

export const statusModule: AreaModule = {
  scopes: {cache: 'admin', regression: 'admin'},
  readOnly: ({scope, verb}) => scope === 'regression' && verb === 'cases',
  handle: (ctx, {scope, verb, target}) => {
    if (scope === 'cache' && verb === 'clear') return clearModelCache(ctx, target);
    if (scope === 'regression') return regressionAction(ctx, verb, target);
  },
};

