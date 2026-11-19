import { createFileRoute } from '@tanstack/react-router';

import { McpPage } from '../../../modules/settings/mcp-page';

export const Route = createFileRoute('/_authed/settings/mcp')({
  component: McpPage,
});
