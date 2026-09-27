import { AsyncLocalStorage } from 'node:async_hooks';
import { digest } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';

export interface ResearchPreview { input: string; chars: number; bytes: number; hash: string; limit: number; draft: string; question: string; purpose: string }
const currentPreview=new AsyncLocalStorage<{captured:ResearchPreview|null}>();
/** A preview computes the real envelope but leaves no consumer reservation. */
export function isResearchPreview():boolean{return currentPreview.getStore()!==undefined;}

/** Intercepts a new serialized envelope before reservation or provider dispatch.
 * A previously paid durable intent is resumed before reaching this boundary. */
export function interceptResearchPreview(input:string,metadata:Omit<ResearchPreview,'input'|'chars'|'bytes'|'hash'>):void{
  const state=currentPreview.getStore();if(!state)return;
  requireCondition(metadata.draft&&metadata.question&&metadata.purpose,'research_preview_unbound','Preview requires an audited question-bound request');
  state.captured??={input,chars:input.length,bytes:Buffer.byteLength(input),hash:digest(input),...metadata};
  throw new EngineError('research_preview_ready','The actual request is captured; no model call was dispatched');
}

/** Run on an isolated database copy: normal context/run journal writes may occur,
 * but a provider invocation and token reservation cannot occur in this mode. */
export async function previewResearch(work:()=>Promise<unknown>):Promise<ResearchPreview>{
  requireCondition(!currentPreview.getStore(),'research_preview_nested','Nested preview cannot replace the outer request');
  const state:{captured:ResearchPreview|null}={captured:null};
  return currentPreview.run(state,async()=>{
    try{await work();}catch(error){if(!(error instanceof EngineError&&error.code==='research_preview_ready'))throw error;}
    requireCondition(state.captured,'research_preview_missing','No request reached the provider boundary; inspect the actual preparation failure');
    return state.captured;
  });
}
