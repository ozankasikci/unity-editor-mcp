import { BaseToolHandler } from '../base/BaseToolHandler.js';

/**
 * Handler for canceling running tests in Unity
 */
export class CancelTestsToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'cancel_tests',
      'Cancel currently running tests in Unity',
      {
        type: 'object',
        properties: {},
        required: []
      }
    );
    
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the cancel tests command
   * @param {object} params - Input parameters
   * @returns {Promise<object>} Cancellation status
   */
  async execute(params) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      await this.unityConnection.connect();
    }
    
    // Send cancel tests command
    const result = await this.unityConnection.sendCommand('cancel_tests', {});
    
    return result;
  }
}