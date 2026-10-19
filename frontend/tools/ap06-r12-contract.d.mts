export type R12Condition = 'r12.0'|'r12.1'|'r12.2'|'r12.3'|'r12.4';
export const R12_CONDITIONS: Readonly<Record<R12Condition,{readonly transport:'xhr'|'fetch';readonly payload:'blob'|'blob-arraybuffer'|'direct-arraybuffer'}>>;
export function selectR12(value:unknown,r11?:unknown,r10?:unknown,r9?:unknown):R12Condition|null;
export function rangeBodyBytes(condition:string,isPayload:boolean,body:unknown):number;
