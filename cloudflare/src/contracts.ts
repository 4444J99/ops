import { parseCron } from './cron-matcher';
/** Resource admission. Pure data validation; never grants provider authority. */
export type Environment = 'production' | 'staging' | 'disabled';
export type Metric = 'kvRead' | 'kvWrite' | 'kvList' | 'kvDelete' | 'd1Read' | 'd1Write' | 'requests' | 'cpuMs';
export type Cost = Record<Metric, number>;
export const METRICS: Metric[] = ['kvRead', 'kvWrite', 'kvList', 'kvDelete', 'd1Read', 'd1Write', 'requests', 'cpuMs'];
// Workers free-plan execution budget: 100,000 requests/day; cpuMs derives from
// the 10 ms CPU limit per request applied across the request allowance.
export const FREE_ALLOWANCE: Cost = {kvRead:100000, kvWrite:1000, kvList:1000, kvDelete:1000, d1Read:5000000, d1Write:100000, requests:100000, cpuMs:1000000};
export interface Ownership {
  repositoryId: number;
  repository: string;
  environment: 'production' | 'staging';
  accountRef: string;
  service: string;
  capability: string;
  authorization: 'named-entrypoint' | 'legacy-default';
  contractVersion: 1;
  maxDurationMs: number;
  maxInvocationsPerDay: number;
  freshnessMs: number;
  resourceBudget: {state:'unmeasured'; issue:string} | {state:'bounded'; perInvocation:Cost; perDay:Cost};
}
export interface RegisteredTarget {
  name: string;
  schedule: string;
  binding: string;
  active: boolean;
  ownership: Ownership;
  continuationSchedule?: string;
}
const NAME = /^[a-z][a-z0-9-]{0,79}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function positive(value:number): boolean { return Number.isSafeInteger(value) && value > 0; }
export function validateCost(cost:Cost): void {
  if (!cost || Object.keys(cost).length !== METRICS.length || METRICS.some(k => !Number.isSafeInteger(cost[k]) || cost[k] < 0)) throw new Error('invalid_resource_budget');
}
export function validateTargets(targets: readonly RegisteredTarget[]): void {
  const names = new Set<string>(), bindings = new Set<string>(), resources = new Map<string, number>(), capabilities=new Set<string>();
  for (const t of targets) {
    const o=t.ownership;
    parseCron(t.schedule); if(t.continuationSchedule)parseCron(t.continuationSchedule);
    if (!NAME.test(t.name) || !/^[A-Z][A-Z0-9_]*$/.test(t.binding) || names.has(t.name) || bindings.has(t.binding)) throw new Error('duplicate_or_invalid_target');
    if (!o || !positive(o.repositoryId) || !REPO.test(o.repository) || !NAME.test(o.service) || !NAME.test(o.accountRef) || !['production','staging'].includes(o.environment)) throw new Error('invalid_owner');
    if (o.contractVersion!==1 || !['named-entrypoint','legacy-default'].includes(o.authorization) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(o.capability)) throw new Error('invalid_capability');
    if (o.authorization==='named-entrypoint' && o.capability==='default') throw new Error('named_capability_required');
    if (!positive(o.maxDurationMs) || o.maxDurationMs>300000 || !positive(o.maxInvocationsPerDay) || o.maxInvocationsPerDay>20000 || !positive(o.freshnessMs)) throw new Error('invalid_execution_budget');
    const resource=`${o.accountRef}/worker/${o.service}`;
    if (resources.has(resource) && resources.get(resource)!==o.repositoryId) throw new Error('conflicting_resource_owner');
    resources.set(resource,o.repositoryId);
    const capability=resource+'/'+o.capability;
    if(capabilities.has(capability))throw new Error('duplicate_resource_capability');
    capabilities.add(capability);
    if (o.resourceBudget?.state==='bounded') {
      validateCost(o.resourceBudget.perInvocation); validateCost(o.resourceBudget.perDay);
      if (METRICS.some(k => o.resourceBudget.state==='bounded' && o.resourceBudget.perInvocation[k]>o.resourceBudget.perDay[k])) throw new Error('invocation_exceeds_daily_allocation');
    } else if (o.resourceBudget?.state!=='unmeasured' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/.test(o.resourceBudget.issue)) throw new Error('missing_budget_evidence');
    names.add(t.name); bindings.add(t.binding);
  }
}
export function validateNewRegistration(t:RegisteredTarget):void {
  validateTargets([t]);
  if (t.ownership.authorization!=='named-entrypoint' || t.ownership.resourceBudget.state!=='bounded') throw new Error('new_registration_requires_isolated_measured_contract');
}
export function assertController(t:RegisteredTarget, environment:unknown):void {
  if (environment!=='production' && environment!=='staging') throw new Error('controller_disabled');
  if (environment==='staging' && t.ownership.environment!=='staging') throw new Error('environment_crossing_refused');
}
export function validateAllocation(targets:readonly RegisteredTarget[], allowance:Cost, overhead:Cost, reservePercent=20):void {
  validateTargets(targets); validateCost(allowance); validateCost(overhead);
  if (!Number.isFinite(reservePercent) || reservePercent<0 || reservePercent>=100) throw new Error('invalid_reserve');
  const total={...overhead};
  for(const t of targets) {
    if (!t.active) continue;
    if(t.ownership.resourceBudget.state!=='bounded') throw new Error('account_budget_not_fully_measured');
    for(const k of METRICS) total[k]+=t.ownership.resourceBudget.perDay[k];
  }
  if(METRICS.some(k=>total[k]>Math.floor(allowance[k]*(1-reservePercent/100)))) throw new Error('account_allocation_exceeded');
}
export function logicalRunKey(t:RegisteredTarget, scheduledTime:number, mode:'scheduled'|'drain'):string {
  if(!['scheduled','drain'].includes(mode) || !Number.isSafeInteger(scheduledTime) || scheduledTime<0 || !Number.isFinite(new Date(scheduledTime).getTime())) throw new Error('invalid_scheduled_time');
  return `${t.name}:${t.ownership.environment}:${Math.floor(scheduledTime/60000)*60000}:${mode}`;
}
