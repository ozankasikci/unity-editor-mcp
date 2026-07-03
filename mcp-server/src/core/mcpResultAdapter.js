export function toMcpToolResult(handlerResult, toolName) {
  if (!handlerResult || handlerResult.status !== 'error') {
    const structuredContent = normalizeStructuredContent(handlerResult?.result, toolName);
    return {
      content: [
        {
          type: 'text',
          text: formatResultText(structuredContent)
        }
      ],
      structuredContent
    };
  }

  const structuredContent = {
    code: handlerResult.code || 'TOOL_ERROR',
    message: handlerResult.error || 'Tool execution failed'
  };

  if (handlerResult.details !== undefined) {
    structuredContent.details = handlerResult.details;
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: formatErrorText(structuredContent)
      }
    ],
    structuredContent
  };
}

export function normalizeStructuredContent(value, toolName = 'tool') {
  if (value === undefined || value === null) {
    return {
      status: 'success',
      tool: toolName,
      message: 'Operation completed successfully but no details were returned'
    };
  }

  if (isLegacyMcpResult(value)) {
    return {
      status: value.isError ? 'error' : 'success',
      content: value.content,
      structuredContent: value.structuredContent
    };
  }

  if (Array.isArray(value)) {
    return { result: value };
  }

  if (typeof value === 'object') {
    return value;
  }

  return { result: value };
}

function formatResultText(structuredContent) {
  if (structuredContent?.summary) {
    return String(structuredContent.summary);
  }

  if (structuredContent?.message) {
    return String(structuredContent.message);
  }

  // Compact, not pretty-printed: structuredContent already carries the full
  // object, so the text fallback should not also spend tokens on indentation.
  return JSON.stringify(structuredContent);
}

function formatErrorText(errorContent) {
  const code = errorContent.code || 'TOOL_ERROR';
  const message = errorContent.message || 'Tool execution failed';
  const details = errorContent.details === undefined
    ? ''
    : `\nDetails: ${JSON.stringify(errorContent.details, null, 2)}`;

  return `Error: ${message}\nCode: ${code}${details}`;
}

function isLegacyMcpResult(value) {
  return (
    value &&
    typeof value === 'object' &&
    Array.isArray(value.content) &&
    value.content.every((item) => item && typeof item.type === 'string')
  );
}
