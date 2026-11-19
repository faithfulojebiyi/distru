import { createFileRoute } from '@tanstack/react-router';

import { ConnectorPage } from '../../../../modules/settings/connector-page';

export const Route = createFileRoute('/_authed/settings/connectors/$connectorId')({
  component: Connector,
});

function Connector() {
  const { connectorId } = Route.useParams();
  return <ConnectorPage key={connectorId} connectorId={connectorId} />;
}
