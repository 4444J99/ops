/** Compile the existing manifest; compare provider config to that one authority. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require(process.env.TYPESCRIPT_PATH||'typescript');
const root=resolve(import.meta.dirname,'..');
function moduleURL(file) {
 let js=ts.transpileModule(readFileSync(resolve(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 js=js.replace(/from (['"])(\.\/[\w-]+)\1/g, (_all, quote, path) => 'from '+quote+moduleURL(resolve(root,dirname(file),path+'.ts'))+quote);
 return 'data:text/javascript;base64,'+Buffer.from(js).toString('base64');
}
async function load(file) { return import(moduleURL(file)); }
const {SCHEDULE_MANIFEST:targets}=await load('src/manifest.ts');
const {validateTargets,validateNewRegistration,validateAllocation,FREE_ALLOWANCE}=await load('src/contracts.ts');
validateTargets(targets);
const configs=JSON.parse(execFileSync('python3',['-c',
 'import tomllib,json,sys; print(json.dumps([tomllib.load(open(p,"rb")) for p in sys.argv[1:]]))',
 resolve(root,'wrangler.toml'),resolve(root,'wrangler-no-cron.toml')],{encoding:'utf8'}));
const [config,retired]=configs;
for(const dormant of [config,config.env.staging,retired]){
 assert.deepEqual(dormant.triggers.crons,[],'noncanonical clock must stay off');
 assert.deepEqual(dormant.services,[],'noncanonical controller cannot retain product authority');
 assert.notEqual(dormant.vars.OPS_CONTROLLER_ENV,'production');
}
const prod=config.env.production;
assert.equal(prod.name,'ops-scheduler-production');assert.equal(prod.vars.OPS_CONTROLLER_ENV,'production');
assert.deepEqual(prod.triggers.crons,['* * * * *']);
assert.equal(prod.d1_databases.length,1);assert.equal(prod.d1_databases[0].binding,'SCHED_DB');
assert.equal(prod.services.length,targets.length);
for(const t of targets){
 const binding=prod.services.filter(s=>s.binding===t.binding);assert.equal(binding.length,1);
 assert.equal(binding[0].service,t.ownership.service,'misdirected capability');
 assert.equal(binding[0].entrypoint??'default',t.ownership.capability,'named ingress lost');
}
// These are explicitly grandfathered identities, not a second schedule registry.
// Each exemption is bound to the complete immutable resource-and-capability
// identity (repository, target, account, service, environment, capability):
// editing any of those fields re-admits the target through new-registration
// validation instead of silently keeping the exemption.
// New callers require all-account allocation evidence; unknown old budgets may
// not be used to manufacture spare capacity for a newly admitted product.
const legacyKey=(t)=>`${t.ownership.repositoryId}:${t.name}:${t.ownership.accountRef}:${t.ownership.service}:${t.ownership.environment}:${t.ownership.capability}`;
const legacy=new Set([
 '1228974136:bountyscope:primary-cloudflare:bountyscope:production:default',
 '1228965461:edgarflash:primary-cloudflare:edgarflash:production:default',
 '1228979753:trendpulse:primary-cloudflare:trendpulse:production:default',
 '1229016238:vulnpulse:primary-cloudflare:vulnpulse:production:default',
 '1380697675:ucc-staging:primary-cloudflare:ucc-mca-edge-staging:staging:KvIncidentScheduledIngress',
 '1380697675:ucc-production:primary-cloudflare:ucc-mca-edge-production:production:default',
]);
const added=targets.filter(t=>!legacy.has(legacyKey(t)));
for(const t of added)validateNewRegistration(t);
if(added.length)validateAllocation(targets,FREE_ALLOWANCE,{kvRead:0,kvWrite:0,kvList:0,kvDelete:0,d1Read:100000,d1Write:20000,requests:1440,cpuMs:0});
assert.ok(targets.reduce((n,t)=>n+t.ownership.maxInvocationsPerDay,0)<=2000,'fleet dispatch reservations exceed runtime capacity');
if(process.argv.includes('--emit'))writeFileSync(resolve(root,'dist/admitted-targets.json'),JSON.stringify(targets,null,2));
console.log(JSON.stringify({validatedTargets:targets.length,newAdmissions:added.length,productionControllers:1,dormantCapabilityBindings:0,unmeasuredLegacyBudgets:targets.filter(t=>t.ownership.resourceBudget.state==='unmeasured').length}));
