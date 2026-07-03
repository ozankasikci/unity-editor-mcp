import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { getGameObjectDetailsToolDefinition } from '../../tools/analysis/getGameObjectDetails.js';

const inputSchema = {
    ...getGameObjectDetailsToolDefinition.inputSchema,
    required: [],
    properties: {
        ...getGameObjectDetailsToolDefinition.inputSchema.properties,
        maxDepth: {
            ...getGameObjectDetailsToolDefinition.inputSchema.properties.maxDepth,
            minimum: 0,
            maximum: 10
        }
    },
    oneOf: [
        {
            required: ['gameObjectName'],
            not: { required: ['path'] }
        },
        {
            required: ['path'],
            not: { required: ['gameObjectName'] }
        }
    ]
};

/**
 * Handler for get_gameobject_details tool
 */
export class GetGameObjectDetailsToolHandler extends BaseToolHandler {
    constructor(unityConnection) {
        super(
            getGameObjectDetailsToolDefinition.name,
            getGameObjectDetailsToolDefinition.description,
            inputSchema
        );
        this.unityConnection = unityConnection;
    }

    async execute(args) {
        if (!this.unityConnection.isConnected()) {
            throw new Error('Unity connection not available');
        }

        const result = await this.unityConnection.sendCommand('get_gameobject_details', args);

        if (!result || typeof result === 'string') {
            throw new Error('Invalid response format');
        }

        if (result.error) {
            const error = new Error(result.error);
            error.code = 'UNITY_ERROR';
            throw error;
        }

        // Concise summary keeps the MCP text block short; the full component and
        // property detail travels once in structuredContent instead of also being
        // dumped as JSON text.
        if (result && typeof result === 'object' && result.name) {
            const componentCount = Array.isArray(result.components) ? result.components.length : null;
            result.summary = `GameObject "${result.name}"${result.path ? ` (${result.path})` : ''}` +
                (componentCount != null ? ` — ${componentCount} component${componentCount === 1 ? '' : 's'}` : '');
        }

        return result;
    }
}
