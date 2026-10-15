const FIELDS = {
  heap: ['usedSize','totalSize','embedderHeapUsedSize','backingStorageSize'],
  dom: ['documents','nodes','jsEventListeners'],
};

export async function sampleRenderer(session) {
  const replies = await Promise.allSettled(['Runtime.getHeapUsage','Memory.getDOMCounters'].map(method => session.send(method)));
  return Object.fromEntries(Object.entries(FIELDS).map(([kind, fields], index) => {
    const reply = replies[index], unavailable = {};
    if (reply.status === 'rejected' && !/wasn't found|method.*not.*supported|not implemented|unknown method/i.test(String(reply.reason?.message))) {
      throw reply.reason;
    }
    const values = Object.fromEntries(fields.map(field => {
      if (reply.status === 'rejected' || reply.value[field] === undefined) {
        unavailable[field] = reply.status === 'rejected' ? 'API_NOT_SUPPORTED' : 'FIELD_NOT_SUPPORTED';
        return [field, null];
      }
      const value = reply.value[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || kind === 'dom' && !Number.isInteger(value)) {
        throw new Error('R10_INVALID_AUXILIARY_METRIC');
      }
      return [field,value];
    }));
    if (kind === 'heap' && values.usedSize !== null && values.totalSize !== null && values.usedSize > values.totalSize) {
      throw new Error('R10_INVALID_HEAP_SIZE_RELATION');
    }
    return [kind, { status: Object.keys(unavailable).length === fields.length ? 'UNAVAILABLE' :
      Object.keys(unavailable).length ? 'PARTIAL' : 'AVAILABLE', ...values, unavailable }];
  }));
}
