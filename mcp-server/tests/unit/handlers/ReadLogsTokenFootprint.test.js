import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ReadLogsToolHandler } from '../../../src/handlers/system/ReadLogsToolHandler.js';

// read_logs used to return both `logs` and a `formattedLogs` string copy, with no
// summary — so its (large) payload was emitted as pretty-printed JSON text AND
// structuredContent, roughly 4x the raw log text. It should carry the logs once
// plus a short summary that becomes the MCP text block.
describe('read_logs token footprint', () => {
  function connectionReturning(logs) {
    return {
      isConnected: mock.fn(() => true),
      connect: mock.fn(async () => {}),
      sendCommand: mock.fn(async () => ({ logs }))
    };
  }

  it('adds a concise summary and does not duplicate logs as formattedLogs', async () => {
    const logs = [
      { logType: 'Error', timestamp: 't1', message: 'boom' },
      { logType: 'Warning', timestamp: 't2', message: 'careful' },
      { logType: 'Log', timestamp: 't3', message: 'hello' }
    ];
    const handler = new ReadLogsToolHandler(connectionReturning(logs));

    const result = await handler.execute({});

    assert.equal(result.formattedLogs, undefined, 'formattedLogs (a redundant copy of logs) must not be returned');
    assert.ok(Array.isArray(result.logs), 'the structured logs array is still returned once');
    assert.equal(result.logs.length, 3);
    assert.match(result.summary, /3 Unity log entries/);
    assert.match(result.summary, /1 error/);
    assert.match(result.summary, /1 warning/);
  });
});
