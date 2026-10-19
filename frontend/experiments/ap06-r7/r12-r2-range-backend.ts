import {inject,Injectable,InjectionToken} from '@angular/core';
import {HttpRequest} from '@angular/common/http';
import {inspectRangeRequest,R10RangeBackend} from './r10-range-backend';
import {CONDITIONS,Condition,routeRange} from '../../tools/ap06-r12-r2-contract.mjs';

export const R12R2_CONDITION=new InjectionToken<Readonly<{metadata:'xhr'|'fetch';payload:'xhr'|'fetch'}>>('R12R2_CONDITION');
export const R12R2_PROTOCOL=new InjectionToken<()=>readonly Readonly<{id:number;start:number;end:number}>[]>('R12R2_PROTOCOL');

@Injectable()
export class R12R2RangeBackend extends R10RangeBackend {
  readonly condition=inject(R12R2_CONDITION);
  readonly protocol=inject(R12R2_PROTOCOL);
  private cursor=0;
  override handle(request:HttpRequest<unknown>){
    const range=inspectRangeRequest(request,this.allowlist());
    if(!range)return this.xhr.handle(request);
    const sequence=this.protocol();
    const name=Object.keys(CONDITIONS).find(c=>CONDITIONS[c as Condition]===this.condition);
    if(!name||this.cursor>=54||sequence.length!==9||request.responseType!=='blob')throw new Error('R12R2_BACKEND_CONTRACT_CHANGED');
    const kind=routeRange(name,range,sequence[this.cursor%9]);
    this.cursor++;
    return (this.condition[kind]==='fetch'?this.fetchBackend:this.xhr).handle(request);
  }
}
