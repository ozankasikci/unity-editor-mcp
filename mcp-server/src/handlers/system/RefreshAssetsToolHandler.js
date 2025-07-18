import { BaseToolHandler } from '../base/BaseToolHandler.js';

/**
 * Handler for the refresh_assets tool
 * Triggers Unity to refresh assets and potentially recompile
 */
export class RefreshAssetsToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'refresh_assets',
      'Trigger Unity to refresh assets and check for compilation',
      {
        type: 'object',
        properties: {},
        required: []
      }
    );
    
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the refresh_assets command
   * @param {object} params - Input parameters (none required)
   * @returns {Promise<object>} Refresh result
   */
  async execute(params) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      await this.unityConnection.connect();
    }
    
    // Send refresh_assets command
    const result = await this.unityConnection.sendCommand('refresh_assets', {});
    
    return {
      message: result.message,
      isCompiling: result.isCompiling,
      timestamp: result.timestamp,
      note: result.isCompiling 
        ? 'Unity is compiling. New commands will be available after compilation completes.'
        : 'Asset refresh complete. Unity is not currently compiling.'
    };
  }
}