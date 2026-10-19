export type Condition='r12r2.0'|'r12r2.1'|'r12r2.2'|'r12r2.3';
export const CONDITIONS:Readonly<Record<Condition,Readonly<{metadata:'xhr'|'fetch';payload:'xhr'|'fetch'}>>>;
export function selectCondition(value:unknown,...historical:unknown[]):Condition|null;
export function routeRange(condition:string,range:{id:number;start:number;end:number},expected:{id:number;start:number;end:number}|undefined):'metadata'|'payload';
export function transportCounts(condition:string,sessions:number):Record<string,number>;
