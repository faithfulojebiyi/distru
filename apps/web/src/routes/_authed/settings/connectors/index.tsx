import { createFileRoute } from '@tanstack/react-router';

import { ConnectorsPage } from '../../../../modules/settings/connectors-page';

export const Route = createFileRoute('/_authed/settings/connectors/')({
  component: ConnectorsPage,
});
