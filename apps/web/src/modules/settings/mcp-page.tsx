// Adapted from carbonme modules/integrations/mcp-setup-card.tsx (SetupSteps, CopyField, the brand.panel.3 setup card
// with its background.app inner box), modules/integrations/mcp-custom-servers.tsx (the "Custom MCP servers" heading
// with a count and an Add button, ConnectionTableFrame rows, AddCustomDialog's form with FormError / FormActions) and
// modules/integrations/connect-dialog.tsx (Benefit rows and the muted fine-print box in the dialog). Snippet blocks are
// carbonme modules/chats/chat-tool-runs.tsx ValueBlock. Page frame: carbonme modules/settings/settings-page.tsx.
import { useState, type ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Checkbox } from '@ops/ui/primitives/checkbox/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@ops/ui/primitives/dialog';
import { Input } from '@ops/ui/primitives/input';
import { Label } from '@ops/ui/primitives/label';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { toast } from '@ops/ui/primitives/toast/toast';
import { apiErrorMessage, isForbiddenError } from '../../api/errors';
import type {
  CreateMcpTokenResponse,
  McpToken,
  Scope,
} from '../../api/generated/opsAgentAPI.schemas';
import { apiUrl } from '../../config/api-url';
import { Pill, TONES } from '../proposals/components/badges';
import { formatAge } from '../proposals/proposal-values';
import { useMe } from '../session/session-api';
import { useNow } from '../system/use-now';
import { IntegrationEmptyState } from './integration-empty-state';
import { useCreateMcpToken, useMcpTokens, useRevokeMcpToken } from './settings-api';
import { SettingsPage, SettingsPanel } from './settings-page';

const MCP_URL = `${apiUrl}/mcp`;
const AGENT_CARD_URL = `${apiUrl}/api/.well-known/ops-lead/agent-card.json`;
const A2A_URL = `${apiUrl}/api/a2a/ops-lead`;

/** The snippets from apps/agent/README.md "MCP server", with this server's URL. */
const CLAUDE_CODE_JSON = `{
  "mcpServers": {
    "ops-agent": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer \${OPS_MCP_TOKEN}" }
    }
  }
}`;
const CLAUDE_CODE_CLI = `claude mcp add --transport http ops-agent ${MCP_URL} --header "Authorization: Bearer $OPS_MCP_TOKEN"`;
const CODEX_TOML = `[mcp_servers.ops-agent]
url = "${MCP_URL}"
bearer_token_env_var = "OPS_MCP_TOKEN"`;

const SCOPES: { scope: Scope; label: string; detail: string }[] = [
  { scope: 'read', label: 'Read', detail: 'Every read tool: Distru, Headset, proposals, runs and the audit log. Always on.' },
  { scope: 'propose', label: 'Propose', detail: 'propose_* tools, propose_undo and start_restock_run. Proposals still go through policy.' },
  { scope: 'approve', label: 'Approve', detail: 'decide_proposal. Never on proposals this token made (separation of duties).' },
];

const ROW_COLUMNS = 'minmax(0, 1fr) 9rem 8rem 6rem 6.5rem 5.5rem';

const SetupSteps = ({ steps }: { steps: ReactNode[] }) => (
  <styled.ol display="flex" flexDirection="column" gap="2.5">
    {steps.map((step, index) => (
      <HStack as="li" key={index} gap="3" alignItems="start" fontSize="1.5">
        <Flex
          align="center"
          justify="center"
          flexShrink="0"
          w="5"
          h="5"
          rounded="full"
          bg={{ base: 'background.app', _dark: 'brand.panel.10' }}
          fontSize="1"
          fontWeight="600"
        >
          {index + 1}
        </Flex>
        <styled.span pt="0.5">{step}</styled.span>
      </HStack>
    ))}
  </styled.ol>
);

const Code = ({ children }: { children: ReactNode }) => (
  <styled.code fontFamily="mono" fontSize="1" px="1" rounded="sm" bg="brand.panel.5">
    {children}
  </styled.code>
);

const copy = (label: string, value: string) =>
  void navigator.clipboard
    .writeText(value)
    .then(() => toast.success(`${label} copied.`))
    .catch(() => toast.error('Copy failed. Select the text and copy it.'));

/** A value to paste into the client's settings, with a copy button (carbonme CopyField). */
const CopyField = ({ label, value, ...data }: { label: string; value: string } & Record<`data-${string}`, string>) => (
  <Box {...data}>
    <styled.span fontSize="1" color="text.muted">
      {label}
    </styled.span>
    <HStack mt="1" gap="1.5">
      <Input readOnly value={value} fontFamily="mono" onFocus={(event) => event.target.select()} aria-label={label} />
      <Button type="button" variant="soft" onClick={() => copy(label, value)}>
        <Icons.copy size={13} />
        Copy
      </Button>
    </HStack>
  </Box>
);

/** A config snippet as carbonme's ValueBlock, with a copy button in its label row. */
const Snippet = ({ label, file, value }: { label: string; file: string; value: string }) => (
  <Box data-mcp-snippet={label}>
    <HStack justify="space-between" gap="2">
      <styled.span fontSize="1" color="text.muted">
        {label} · <styled.code fontFamily="mono">{file}</styled.code>
      </styled.span>
      <Button type="button" size="xs" variant="ghost" onClick={() => copy(label, value)}>
        <Icons.copy size={12} />
        Copy
      </Button>
    </HStack>
    <styled.pre
      mt="1"
      px="3"
      py="2"
      rounded="lg"
      bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
      fontFamily="mono"
      fontSize="1"
      lineHeight="1.5"
      overflow="auto"
      whiteSpace="pre-wrap"
      overflowWrap="anywhere"
    >
      {value}
    </styled.pre>
  </Box>
);

const SNIPPET_TABS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
] as const;

/** Setup for Claude Code / Codex: numbered steps, the endpoint, and each client's config. */
const SetupCard = () => {
  const [tab, setTab] = useState<(typeof SNIPPET_TABS)[number]['key']>('claude');
  return (
    <Flex direction="column" gap="4" p="5" rounded="xl" bg="brand.panel.3" data-mcp-setup="">
      <Box>
        <styled.h2 fontSize="2" fontWeight="600">
          Connect Claude Code or Codex to this harness
        </styled.h2>
        <styled.p fontSize="1.5" color="text.muted" mt="1">
          The client gets the token’s tools: read tools always, propose_* with propose, decide_proposal with approve.
          Every call states an intent and is audited.
        </styled.p>
      </Box>
      <SetupSteps
        steps={[
          <>
            An approver creates a token below and copies it once. Export it as <Code>OPS_MCP_TOKEN</Code>.
          </>,
          <>
            Add the server to the client: <Code>.mcp.json</Code> in the repo root for Claude Code (or{' '}
            <Code>claude mcp add</Code>), <Code>~/.codex/config.toml</Code> for Codex.
          </>,
          <>
            Ask the client to call <Code>get_me</Code> first; it reports the token’s scopes and tools.
          </>,
        ]}
      />
      <Flex direction="column" gap="3" p="4" rounded="lg" bg={{ base: 'background.app', _dark: 'brand.panel.4' }}>
        <CopyField label="MCP URL" value={MCP_URL} data-mcp-url="" />
        <HStack gap="1" role="tablist" aria-label="Client">
          {SNIPPET_TABS.map((item) => (
            <styled.button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              h="7"
              px="2.5"
              rounded="md"
              fontSize="1.5"
              cursor="pointer"
              bg={tab === item.key ? 'brand.panel.4' : 'transparent'}
              color={tab === item.key ? 'text.app' : 'text.label'}
              fontWeight={tab === item.key ? '500' : '400'}
              _hover={{ bg: tab === item.key ? 'brand.panel.4' : 'brand.panel.3' }}
            >
              {item.label}
            </styled.button>
          ))}
        </HStack>
        {tab === 'claude' ? (
          <Flex direction="column" gap="3">
            <Snippet label="Claude Code" file=".mcp.json" value={CLAUDE_CODE_JSON} />
            <Snippet label="Or with the CLI" file="claude mcp add" value={CLAUDE_CODE_CLI} />
          </Flex>
        ) : (
          <Snippet label="Codex" file="~/.codex/config.toml" value={CODEX_TOML} />
        )}
      </Flex>
    </Flex>
  );
};

/** Agent-to-agent: the Ops Lead's card and endpoint, with the same tokens. */
const A2APanel = () => (
  <SettingsPanel
    title="Agent-to-agent (A2A)"
    description="Other agents can discover and message the Ops Lead with the same tokens: the card needs any valid token, sending a message needs propose."
    data-a2a=""
  >
    <CopyField label="Agent card URL" value={AGENT_CARD_URL} data-a2a-card="" />
    <CopyField label="A2A endpoint" value={A2A_URL} />
  </SettingsPanel>
);

const FormError = ({ error }: { error: string | null }) =>
  error ? (
    <styled.p role="alert" fontSize="1" color="text.error">
      {error}
    </styled.p>
  ) : null;

/** The plaintext token, shown once after creating it (the server keeps only its hash). */
const CreatedToken = ({ created, close }: { created: CreateMcpTokenResponse; close: () => void }) => (
  <Flex direction="column" gap="4" mt="4" data-mcp-created="">
    <HStack
      gap="2"
      px="3"
      py="2"
      rounded="lg"
      bg={{ base: 'palette.orange.3', _dark: 'palette.amber.3' }}
      color="palette.amber.11"
      fontSize="1.5"
      alignItems="start"
    >
      <Icons.warn size={14} flexShrink="0" mt="0.5" />
      <styled.span>Copy it now. This is the only time the token is shown; only its hash is stored.</styled.span>
    </HStack>
    <CopyField label="Token" value={created.token} data-mcp-token="" />
    <CopyField label="MCP URL" value={created.mcpUrl || MCP_URL} />
    <styled.p fontSize="1" color="text.muted" bg="background.muted" rounded="lg" px="3" py="2">
      Export it as <Code>OPS_MCP_TOKEN</Code>; the setup snippets on this page read it from there.
    </styled.p>
    <HStack justify="flex-end">
      <Button type="button" onClick={close}>
        Done
      </Button>
    </HStack>
  </Flex>
);

/** Name + scopes (read always on), then the token once. Approvers only. */
const CreateTokenDialog = ({ close }: { close: () => void }) => {
  const create = useCreateMcpToken();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ReadonlySet<Scope>>(new Set<Scope>(['read', 'propose']));
  const created = create.data ?? null;
  const busy = create.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent p="6" w="min(30rem, 95vw)" data-mcp-create-dialog="">
        <DialogTitle>{created ? `${created.record.name} is ready` : 'Create MCP token'}</DialogTitle>
        <styled.p fontSize="1.5" color="text.muted" mt="1.5">
          {created
            ? 'Paste it into Claude Code, Codex or another agent. Revoke it here any time.'
            : 'One token per client, so each can be revoked on its own. Tool calls are audited with the token’s name.'}
        </styled.p>
        {created ? (
          <CreatedToken created={created} close={close} />
        ) : (
          <styled.form
            mt="5"
            display="flex"
            flexDirection="column"
            gap="4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !busy) create.mutate({ name: name.trim(), scopes: SCOPES.map((s) => s.scope).filter((s) => scopes.has(s)) });
            }}
          >
            <Box>
              <Label htmlFor="mcp-token-name" fontSize="1" color="text.muted">
                Name
              </Label>
              <Input
                id="mcp-token-name"
                mt="1"
                autoFocus
                required
                placeholder="Claude Code on Olivia’s laptop"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            </Box>
            <Flex direction="column" gap="1" role="group" aria-label="Scopes">
              <styled.span fontSize="1" color="text.muted">
                Scopes
              </styled.span>
              {SCOPES.map((item) => (
                <styled.label
                  key={item.scope}
                  display="flex"
                  alignItems="flex-start"
                  gap="2.5"
                  px="3"
                  py="2"
                  rounded="lg"
                  bg={scopes.has(item.scope) ? 'brand.panel.4' : 'transparent'}
                  cursor={item.scope === 'read' ? 'default' : 'pointer'}
                  _hover={{ bg: 'brand.panel.4' }}
                  data-mcp-scope={item.scope}
                >
                  <Checkbox
                    mt="0.5"
                    checked={scopes.has(item.scope)}
                    disabled={item.scope === 'read' || busy}
                    onCheckedChange={(state) => {
                      const next = new Set(scopes);
                      if (state === true) next.add(item.scope);
                      else next.delete(item.scope);
                      setScopes(next);
                    }}
                  />
                  <Box>
                    <styled.span display="block" fontSize="1.5" fontWeight="500">
                      {item.label}
                    </styled.span>
                    <styled.span display="block" fontSize="1" color="text.muted">
                      {item.detail}
                    </styled.span>
                  </Box>
                </styled.label>
              ))}
            </Flex>
            <FormError error={create.isError ? apiErrorMessage(create.error) : null} />
            <HStack justify="flex-end" mt="2" gap="2">
              <Button type="button" variant="soft" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || busy} data-mcp-create-submit="">
                {busy ? <Icons.loading size={13} /> : null}
                Create token
              </Button>
            </HStack>
          </styled.form>
        )}
      </DialogContent>
    </Dialog>
  );
};

/** Revoking asks once, like carbonme's delete dialogs; clients stop on their next request. */
const RevokeDialog = ({ token, close }: { token: McpToken; close: () => void }) => {
  const revoke = useRevokeMcpToken();
  return (
    <Dialog open onOpenChange={(open) => !open && !revoke.isPending && close()}>
      <DialogContent p="5" w="min(26rem, 95vw)" data-mcp-revoke-dialog="">
        <DialogTitle mb="3">Revoke {token.name}?</DialogTitle>
        <styled.p color="text.muted" fontSize="1.5">
          Clients using <styled.code fontFamily="mono">{token.prefix}…</styled.code> lose access on their next request.
          This cannot be undone; create a new token to reconnect.
        </styled.p>
        <FormError error={revoke.isError ? apiErrorMessage(revoke.error) : null} />
        <HStack justify="flex-end" mt="5" gap="2">
          <Button type="button" variant="soft" onClick={close} disabled={revoke.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(token.id, { onSuccess: close })}
            data-mcp-revoke-confirm=""
          >
            {revoke.isPending ? <Icons.loading size={13} /> : null}
            Revoke token
          </Button>
        </HStack>
      </DialogContent>
    </Dialog>
  );
};

const ScopePills = ({ scopes }: { scopes: Scope[] }) => (
  <HStack gap="1" flexWrap="wrap">
    {scopes.map((scope) => (
      <Pill key={scope} tone={scope === 'approve' ? TONES.waiting : scope === 'propose' ? TONES.info : TONES.muted} label={scope} />
    ))}
  </HStack>
);

const TokenRow = ({ token, now, revoke }: { token: McpToken; now: number; revoke: () => void }) => {
  const revoked = token.revokedAt !== null;
  return (
    <Box
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: ROW_COLUMNS }}
      alignItems="center"
      gap="3"
      px="3"
      py="2.5"
      minH="14"
      rounded="lg"
      fontSize="1.5"
      bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
      opacity={revoked ? '0.6' : undefined}
      data-mcp-token-row={token.id}
    >
      <HStack gap="2.5" minW="0">
        <Flex align="center" justify="center" w="7" h="7" rounded="lg" bg="brand.panel.4" color="text.muted" flexShrink="0">
          <Icons.key size={15} />
        </Flex>
        <Flex direction="column" minW="0">
          <styled.span fontWeight="500" truncate>
            {token.name}
          </styled.span>
          <styled.span fontSize="1" color="text.muted" fontFamily="mono" truncate>
            {token.prefix}…
          </styled.span>
        </Flex>
      </HStack>
      <ScopePills scopes={token.scopes} />
      <styled.span color="text.label" fontSize="1">
        {formatAge(token.createdAt, now)}
      </styled.span>
      <styled.span color="text.label" fontSize="1">
        {token.lastUsedAt ? formatAge(token.lastUsedAt, now) : 'Never'}
      </styled.span>
      <Box>{revoked ? <Pill tone={TONES.muted} label="Revoked" /> : <Pill tone={TONES.good} label="Active" />}</Box>
      <Box justifySelf={{ md: 'end' }}>
        {revoked ? null : (
          <Button size="xs" variant="ghost" onClick={revoke} data-mcp-revoke={token.id}>
            Revoke
          </Button>
        )}
      </Box>
    </Box>
  );
};

/** The token table (carbonme CustomServers): heading with a count, Create, then ConnectionTableFrame rows. */
const TokensSection = ({ canManage }: { canManage: boolean }) => {
  const tokens = useMcpTokens(canManage);
  const now = useNow(60_000);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<McpToken | null>(null);
  const rows = tokens.data ?? [];
  const active = rows.filter((token) => token.revokedAt === null);

  return (
    <Box data-mcp-tokens="">
      <HStack justify="space-between" gap="3">
        <HStack gap="2">
          <styled.h2 fontSize="2" fontWeight="600">
            Tokens
          </styled.h2>
          {canManage && tokens.data ? (
            <styled.span fontSize="2" color="text.muted">
              {active.length}
            </styled.span>
          ) : null}
        </HStack>
        {canManage ? (
          <Button onClick={() => setCreating(true)} data-mcp-create="">
            <Icons.add size={13} />
            Create token
          </Button>
        ) : null}
      </HStack>
      <styled.p fontSize="1.5" color="text.muted" mt="1.5" mb="4">
        Each client gets its own token with only the scopes it needs. Sessions are not accepted on /mcp.
      </styled.p>
      {!canManage ? (
        <IntegrationEmptyState
          title="Only approvers manage tokens"
          detail="Ask an approver to create a token for your client. You can still use the setup below once you have one."
          roomy
        />
      ) : tokens.isPending ? (
        <Skeleton h="16" rounded="xl" />
      ) : tokens.isError ? (
        <styled.p fontSize="1.5" color="text.muted" role="alert">
          {isForbiddenError(tokens.error) ? 'Only approvers can list tokens.' : 'Could not load the tokens.'}{' '}
          <styled.button type="button" textDecoration="underline" onClick={() => void tokens.refetch()}>
            Try again
          </styled.button>
        </styled.p>
      ) : rows.length === 0 ? (
        <IntegrationEmptyState
          title="No tokens yet"
          detail="Create one for Claude Code, Codex or another agent. The token is shown once, then only its prefix."
          roomy
        />
      ) : (
        <Flex direction="column" gap="1" p="1.5" pt="1" rounded="xl" bg="brand.panel.3">
          <Box
            display={{ base: 'none', md: 'grid' }}
            // Panda only generates classes for values it can read at build time; these columns arrive as a constant.
            style={{ gridTemplateColumns: ROW_COLUMNS }}
            gap="3"
            px="3"
            h="7"
            alignItems="center"
            fontSize="1"
            fontWeight="500"
            color="text.muted"
          >
            <span>Token</span>
            <span>Scopes</span>
            <span>Created</span>
            <span>Last used</span>
            <span>Status</span>
            <span />
          </Box>
          {rows.map((token) => (
            <TokenRow key={token.id} token={token} now={now} revoke={() => setRevoking(token)} />
          ))}
        </Flex>
      )}
      {creating && <CreateTokenDialog close={() => setCreating(false)} />}
      {revoking && <RevokeDialog token={revoking} close={() => setRevoking(null)} />}
    </Box>
  );
};

/** Settings → MCP access: per-client tokens, setup for Claude Code / Codex, and the A2A agent card. */
export const McpPage = () => {
  const me = useMe();
  return (
    <SettingsPage
      title="MCP access"
      description="Drive this harness from Claude Code, Codex or another agent. They get the same governed tools as the agents: read, propose, and approve only with that scope."
      width="admin"
    >
      {me.isPending ? <Skeleton h="24" rounded="xl" /> : <TokensSection canManage={me.data?.canApprove ?? false} />}
      <SetupCard />
      <A2APanel />
    </SettingsPage>
  );
};
