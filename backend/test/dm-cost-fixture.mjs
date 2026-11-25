/* SPDX-License-Identifier: AGPL-3.0-only */
// Test-only bundle instrumentation: no production diagnostics or storage writes.
export function instrumentCosts(script) {
  for (const name of ['DirectRoom', 'UserInbox', 'RateLimiter']) {
    const start = script.indexOf('var ' + name + ' = class');
    const end = script.indexOf('\n};', start) + 3;
    if (start < 0 || end < start) throw new Error('Missing fixture class: ' + name);
    let body = script.slice(start, end);
    body = body.replace(/(class extends \w+ \{)/, '$1\n costs(reset = false) { const result = this.__cost || {}; if (reset) this.__cost = {}; return result; }\n costAlarm() { return this.ctx.storage.getAlarm(); }');
    body = body.replaceAll('this.ctx.storage.sql.exec(', '__costSQL(this, ')
      .replaceAll('this.ctx.storage.setAlarm(', '__costAlarm(this, "set", ')
      .replaceAll('this.ctx.storage.deleteAlarm()', '__costAlarm(this, "delete")')
      .replaceAll('await this.apply(snapshot);', '__costCount(this, "localApply"); await this.apply(snapshot);');
    body = body.replace(/((?:async )?(?:handle|apply|check|alarm|webSocketMessage)\([^\n]*\) \{)/g,
      (method) => method + '\n __costCount(this, ' + JSON.stringify(method.match(/(?:async )?(\w+)\(/)[1]) + ');');
    script = script.slice(0, start) + body + script.slice(end);
  }
  return script + `
function __costCount(object, key, count = 1) {
  object.__cost ||= {}; object.__cost[key] = (object.__cost[key] || 0) + count;
}
function __costSQL(object, ...args) {
  const cursor = object.ctx.storage.sql.exec(...args);
  const rows = cursor.toArray(); // Read counters only after consuming the cursor.
  __costCount(object, 'rowsRead', cursor.rowsRead);
  __costCount(object, 'rowsWritten', cursor.rowsWritten);
  __costCount(object, 'sql');
  return { toArray: () => rows, one: () => {
    if (rows.length !== 1) throw new Error('Expected one row'); return rows[0];
  }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
}
function __costAlarm(object, action, time) {
  __costCount(object, action + 'Alarm');
  return action === 'set' ? object.ctx.storage.setAlarm(time) : object.ctx.storage.deleteAlarm();
}
`;
}
