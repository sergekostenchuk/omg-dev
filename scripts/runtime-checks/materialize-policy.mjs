// Deterministic preparation only. Emits exact import commands and policy;
// it never opens or writes the product database or launches a checker.
import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const order=value=>Array.isArray(value)?value.map(order):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])])):value;
const canonical=value=>JSON.stringify(order(value));
function requireThat(value,code){if(!value)throw Object.assign(new Error(code),{code});}

export function materialize(matrix, root) {
  const assets=matrix.runtimeAssets;
  requireThat(assets && assets.module?.path && assets.document?.path && Array.isArray(assets.subjects)
    && assets.subjects.length && typeof assets.database==='string','runtime_assets_missing');
  const match=/^research-scope:(.+):R2$/.exec(matrix.sourceScope?.id??'');requireThat(match,'scope_project_missing');
  const project=match[1],module=readFileSync(resolve(root,assets.module.path),'utf8'),moduleHash=hash(module);
  const document=readFileSync(resolve(root,assets.document.path),'utf8');
  const sources=[{id:`runtime-check-module-${moduleHash.slice(0,16)}`,path:assets.module.path,content:module},
    {id:assets.document.sourceId,path:assets.document.path,content:document}].map(source=>{
    const value={projectId:project,origin:{kind:'owner-document',location:source.id},content:source.content,mediaType:'text/plain',sha256:hash(source.content)};
    return {...source,sha256:value.sha256,ref:{id:`source:${project}:${source.id}`,revision:1,hash:hash(canonical(value))},
      command:{type:'source-document',project,id:source.id,text:source.content,media:'text/plain',expected:0}};
  });
  const [code,report]=sources, result=structuredClone(matrix);
  const modes={'actors-g3':'isolation','effective-runtime-isolation':'isolation','delivery-g1':'platform','delivery-g2':'provider','integration-g1':'integration'};
  const found=new Set();
  for(const item of result.obligations){
    const mode=modes[item.obligation];
    if(mode){
      requireThat(item.proposedKind==='environment-confirmation','runtime_kind_changed');found.add(item.obligation);
      item.runtimeModule={path:assets.module.path,sha256:moduleHash,source:code.ref,mode};
      item.runtimeCheck={script:code.ref,dependencies:[],subjects:[...assets.subjects],
        executables:['codex','node','git','ps',...(mode==='platform'?['npm']:[])],
        args:[mode,...(['provider','integration'].includes(mode)?[assets.database]:[])],timeoutMs:60000,
        purpose:item.proposedMoment==='R2'?item.gap.question:item.returnCondition,
        ...(item.proposedMoment==='R3'?{satisfies:item.returnCondition}:{})};
      delete item.runtimeCheckPreparation;
    }
    if(item.obligation==='delivery-g3'){
      requireThat(item.resolutionSource?.limits,'document_claim_limit_missing');
      item.documentaryAllowance={sources:[report.ref],claimLimit:item.resolutionSource.limits};
      item.documentSource={path:report.path,sha256:report.sha256,source:report.ref};
      delete item.documentaryAllowancePreparation;
    }
  }
  requireThat(found.size===Object.keys(modes).length,'runtime_assignment_missing');
  result.runtimePreparationStatus='Modules and deterministic expected source refs materialized. Import exact bytes and compare actual refs before applying policy once; no import or observation was executed by this preparation.';
  const policy={version:1,sourceScope:matrix.sourceScope,assignments:result.obligations.map(item=>({
    obligation:item.obligation,original:item.original,kind:item.proposedKind,moment:item.proposedMoment,
    responsibleNode:item.responsibleNode,responsibleConsumer:item.responsibleConsumer,neededForR2:item.proposedMoment==='R2',
    reason:item.rationale,returnCondition:item.returnCondition,
    ...(item.runtimeCheck?{runtimeCheck:item.runtimeCheck}:{}),...(item.documentaryAllowance?{documentaryAllowance:item.documentaryAllowance}:{})}))};
  return {matrix:result,imports:sources,policy};
}

if(process.argv[1]&&existsSync(process.argv[1])&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==3||args[0]!=='--matrix')throw new Error('Usage: materialize-policy.mjs --matrix MATRIX OUTPUT_DIRECTORY');
  const matrixPath=resolve(args[1]),output=resolve(args[2]),root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const result=materialize(JSON.parse(readFileSync(matrixPath,'utf8')),root);
  // The output directory is explicitly supplied and must already exist.
  writeFileSync(resolve(output,'matrix.json'),JSON.stringify(result.matrix,null,2)+'\n',{flag:'wx'});
  writeFileSync(resolve(output,'policy.json'),JSON.stringify(result.policy,null,2)+'\n',{flag:'wx'});
  writeFileSync(resolve(output,'imports.json'),JSON.stringify(result.imports,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,module:result.imports[0].sha256,assignments:result.policy.assignments.length,
    imports:result.imports.map(({path,sha256,ref})=>({path,sha256,ref}))}));
}
