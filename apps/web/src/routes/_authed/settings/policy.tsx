import { createFileRoute } from '@tanstack/react-router';

import { PolicyPage } from '../../../modules/settings/policy-page';

export const Route = createFileRoute('/_authed/settings/policy')({
  component: PolicyPage,
});
