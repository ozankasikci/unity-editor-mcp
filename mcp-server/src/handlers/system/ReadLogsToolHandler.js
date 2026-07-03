import { BaseToolHandler } from '../base/BaseToolHandler.js';

/**
 * Handler for the read_logs tool
 * Reads Unity console logs
 */
export class ReadLogsToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'read_logs',
      'Read Unity console logs',
      {
        type: 'object',
        properties: {
          count: {
            type: 'number',
            description: 'Number of logs to retrieve (1-1000, default: 100)',
            minimum: 1,
            maximum: 1000
          },
          logType: {
            type: 'string',
            description: 'Filter by log type (Log, Warning, Error, Assert, Exception)',
            enum: ['Log', 'Warning', 'Error', 'Assert', 'Exception']
          }
        },
        required: []
      }
    );
    
    this.unityConnection = unityConnection;
  }

  /**
   * Validates the input parameters
   * @param {object} params - Input parameters
   * @throws {Error} If validation fails
   */
  validate(params) {
    super.validate(params);
    
    // Additional validation for count
    if (params.count !== undefined) {
      const count = Number(params.count);
      if (isNaN(count) || count < 1 || count > 1000) {
        throw new Error('count must be a number between 1 and 1000');
      }
    }
    
    // Validate logType if provided
    if (params.logType !== undefined) {
      const validTypes = ['Log', 'Warning', 'Error', 'Assert', 'Exception'];
      if (!validTypes.includes(params.logType)) {
        throw new Error(`logType must be one of: ${validTypes.join(', ')}`);
      }
    }
  }

  /**
   * Executes the read_logs command
   * @param {object} params - Input parameters
   * @returns {Promise<object>} Logs result
   */
  async execute(params) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      await this.unityConnection.connect();
    }
    
    // Send read_logs command
    const result = await this.unityConnection.sendCommand('read_logs', {
      count: params.count || 100,
      logType: params.logType
    });
    
    // Attach a concise summary so the MCP text block stays short. The full log
    // array already travels once in structuredContent; the previous code also
    // emitted a second formatted-string copy (formattedLogs), multiplying tokens
    // on a tool that can return up to 1000 entries.
    if (result && Array.isArray(result.logs)) {
      const errors = result.logs.filter(log => log.logType === 'Error' || log.logType === 'Exception').length;
      const warnings = result.logs.filter(log => log.logType === 'Warning').length;
      const count = result.logs.length;
      result.summary = `Retrieved ${count} Unity log ${count === 1 ? 'entry' : 'entries'} ` +
        `(${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'})`;
    }

    return result;
  }
}