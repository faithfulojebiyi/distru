/** Rate-limited MCP reads: recognised (HTTP 429 or JSON-RPC -32029) and retried after Retry-After. */
import { describe, expect, test } from 'bun:test';
import { isRateLimitedMcpError, McpBoundaryError, retryAfterMsOf } from '../src';

const inFlight = new Error(
  'Error POSTing to endpoint: {"jsonrpc":"2.0","id":24,"error":{"code":-32029,"message":"Rate limit exceeded: tool calls in flight at once (6). Retry after 1 seconds.","data":{"limit":"max_in_flight","retryAfterSeconds":1}}}',
);

describe('rate-limited MCP errors', () => {
  test('JSON-RPC -32029 and HTTP 429 are rate limits; boundary refusals and other errors are not', () => {
    expect(isRateLimitedMcpError(inFlight)).toBe(true);
    expect(isRateLimitedMcpError(Object.assign(new Error('Too Many Requests'), { status: 429 }))).toBe(true);
    expect(isRateLimitedMcpError(Object.assign(new Error('x'), { code: -32029 }))).toBe(true);
    expect(isRateLimitedMcpError(new Error('Product not found'))).toBe(false);
    expect(isRateLimitedMcpError(new McpBoundaryError('rate limit exceeded'))).toBe(false);
  });

  test('retryAfterSeconds is read from the error body', () => {
    expect(retryAfterMsOf(inFlight)).toBe(1000);
    expect(retryAfterMsOf(new Error('nope'))).toBeNull();
  });
});
