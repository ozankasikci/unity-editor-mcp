import { BaseToolHandler } from '../base/BaseToolHandler.js';

/**
 * Handler for getting test results from Unity
 */
export class GetTestResultsToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'get_test_results',
      'Get results from the last test run in Unity',
      {
        type: 'object',
        properties: {
          includeDetails: {
            type: 'boolean',
            description: 'Include detailed test output, stack traces, and assertion results',
            default: true
          },
          filterStatus: {
            type: 'string',
            description: 'Filter results by status (Passed, Failed, Skipped, Inconclusive)',
            enum: ['Passed', 'Failed', 'Skipped', 'Inconclusive']
          }
        },
        required: []
      }
    );
    
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the get test results command
   * @param {object} params - Input parameters
   * @returns {Promise<object>} Test results
   */
  async execute(params) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      await this.unityConnection.connect();
    }
    
    // Send get test results command
    const result = await this.unityConnection.sendCommand('get_test_results', {
      includeDetails: params.includeDetails,
      filterStatus: params.filterStatus
    });
    
    return result;
  }
}