import { BaseToolHandler } from '../base/BaseToolHandler.js';

/**
 * Handler for listing available tests in Unity
 */
export class ListTestsToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'list_tests',
      'List all available tests in the Unity project',
      {
        type: 'object',
        properties: {
          testMode: {
            type: 'string',
            description: 'Test mode to list (EditMode, PlayMode, or EditAndPlayMode)',
            enum: ['EditMode', 'PlayMode', 'EditAndPlayMode']
          },
          filter: {
            type: 'string',
            description: 'Filter pattern to match test names'
          },
          includeCategories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Include tests with these categories'
          },
          excludeCategories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exclude tests with these categories'
          }
        },
        required: []
      }
    );
    
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the list tests command
   * @param {object} params - Input parameters
   * @returns {Promise<object>} List of available tests
   */
  async execute(params) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      await this.unityConnection.connect();
    }
    
    // Send list tests command
    const result = await this.unityConnection.sendCommand('list_tests', {
      testMode: params.testMode,
      filter: params.filter,
      includeCategories: params.includeCategories,
      excludeCategories: params.excludeCategories
    });
    
    return result;
  }
}