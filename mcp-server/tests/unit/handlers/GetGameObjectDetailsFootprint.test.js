import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GetGameObjectDetailsToolHandler } from '../../../src/handlers/analysis/GetGameObjectDetailsToolHandler.js';

// get_gameobject_details returned the full component/property detail with no
// summary, so the adapter dumped it as JSON text AND structuredContent. A short
// summary becomes the text block while the detail travels once in structuredContent.
describe('get_gameobject_details token footprint', () => {
  it('adds a concise summary of the GameObject', async () => {
    const connection = {
      isConnected: mock.fn(() => true),
      connect: mock.fn(async () => {}),
      sendCommand: mock.fn(async () => ({
        name: 'Player',
        path: '/Player',
        components: [{ type: 'Transform' }, { type: 'Rigidbody' }]
      }))
    };
    const handler = new GetGameObjectDetailsToolHandler(connection);

    const result = await handler.execute({ path: '/Player' });

    assert.match(result.summary, /Player/);
    assert.match(result.summary, /2 components/);
  });
});
