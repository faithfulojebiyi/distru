// Adapted from carbonme modules/chats/chat-composer.tsx (ComposerForm, ComposerQuestion, ComposerToolbar, send and stop
// buttons, ComposerBand), the agent chip of steward-picker.tsx and the Tools chip of chat-connector-menu.tsx (2h).
// The Tools menu copies chat-connector-menu.tsx ConnectorMenuContent (search, MenuHeading sections, single-line rows
// with MenuMark-sized marks, "Manage in …" footer opening a new tab).
// Files, Hubs, skills, models and workflows are stripped: the Copilot has one agent and the harness's connectors.
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { css } from '@ops/ui/css';
import { Box, HStack, styled } from '@ops/ui/jsx';

import { ThinkingOrb } from '@ops/ui/blocks/thinking-orb';
import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ops/ui/primitives/dropdown-menu';
import { AppLogo } from '../settings/connectors-page';
import { connectorIcon, connectorName, useConnectors } from '../settings/settings-api';
import type { ConnectorSummary } from '../../api/generated/opsAgentAPI.schemas';
import { Input } from '@ops/ui/primitives/input';
import { StatusDot } from '../settings/status-dot';

/** Toolbar labels hide once the composer becomes too narrow (carbonme chat-composer-styles.ts). */
const narrowComposerHidden = css({
  '@container (max-width: 560px)': { display: 'none' },
});

const QUESTION_CHARS = 4_000;

/** The agent the question goes to: the Ops Lead, which hands work to its specialists (carbonme's Steward chip). */
const AgentChip = () => (
  <Button
    type="button"
    size="xs"
    rounded="full"
    variant="ghost"
    flexShrink="1"
    minW="0"
    bg="brand.panel.4"
    color="text.app"
    cursor="default"
    _hover={{ bg: 'brand.panel.4' }}
    title="Ops Lead: delegates to Inventory Analyst, Procurement Planner, Compliance Reviewer and Policy Critic. Read-only."
    data-agent-chip="ops-lead"
  >
    <ThinkingOrb state="breathing" tone="agent" />
    <styled.span className={narrowComposerHidden}>Ops Lead</styled.span>
  </Button>
);

/** The heading over a section of the Tools menu (carbonme chat-connector-menu.tsx MenuHeading). */
const MenuHeading = ({ shown, children }: { shown: boolean; children: React.ReactNode }) => {
  if (!shown) return null;

  return (
    <DropdownMenuLabel px="2" pt="2" pb="3px" fontSize="0.719" fontWeight="500" color="text.muted">
      {children}
    </DropdownMenuLabel>
  );
};

/** "12 read · 3 write": what the Ops Lead can do with a connector; a zero side is left out. */
const toolCounts = (connector: ConnectorSummary) =>
  [
    connector.readTools ? `${connector.readTools} read` : null,
    connector.actions ? `${connector.actions} write` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** One connector on one line: its mark, its name, and its health or tool counts at the end
 * (carbonme ConnectionOption / ReconnectOption; the Copilot has no per-chat switches, so a row opens the connector). */
const ConnectorOption = ({ connector }: { connector: ConnectorSummary }) => {
  const name = connectorName(connector.id);
  const ok = connector.health.ok;
  const counts = toolCounts(connector);
  return (
    <DropdownMenuItem asChild gap="2" minH="8">
      <Link
        to="/settings/connectors/$connectorId"
        params={{ connectorId: connector.id }}
        title={ok ? `${name}: ${counts || 'no tools'}` : (connector.health.detail ?? `${name} is not reachable`)}
        aria-label={ok ? name : `${name}, not reachable`}
        data-connector={connector.id}
      >
        <AppLogo icon={connectorIcon(connector)} name={name} size="xs" />
        <styled.span truncate flex="1" minW="0" fontSize="1.5">
          {name}
        </styled.span>
        {ok ? (
          <HStack gap="1.5" flexShrink="0">
            {counts ? (
              <styled.span fontSize="1" color="text.muted" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
                {counts}
              </styled.span>
            ) : null}
            <StatusDot tone="green" />
          </HStack>
        ) : (
          <styled.span flexShrink="0" fontSize="1" fontWeight="500" color="palette.amber.11" data-connector-unhealthy="">
            Check
          </styled.span>
        )}
      </Link>
    </DropdownMenuItem>
  );
};

/** The connectors the Ops Lead's tools reach, with their health: carbonme's composer Tools menu (2h,
 * chat-connector-menu.tsx ConnectorMenuContent): a search field, single-line rows by section, then Manage in Settings. */
const ToolsMenu = () => {
  const connectors = useConnectors();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = (connectors.data ?? []).filter(
    (connector) => !needle || connectorName(connector.id).toLowerCase().includes(needle) || connector.id.includes(needle),
  );
  const healthy = shown.filter((connector) => connector.health.ok);
  const unreachable = shown.filter((connector) => !connector.health.ok);
  const total = connectors.data?.length ?? 0;
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setQuery('');
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="xs"
          rounded="full"
          variant="ghost"
          flexShrink="0"
          bg="brand.panel.4"
          color="text.muted"
          _hover={{ bg: 'brand.panel.5' }}
          aria-label="Tools"
          data-tools-chip=""
        >
          <Icons.tools size={13} />
          <styled.span className={narrowComposerHidden}>Tools</styled.span>
          <Icons.caretDown size={10} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        w="18.25rem"
        maxW="calc(100vw - 3rem)"
        maxH="26rem"
        overflowY="auto"
        rounded="xl"
        shadow="chatPop"
        p="1"
        aria-label="Tools"
        data-tools-menu=""
      >
        <Input
          aria-label="Search connectors"
          placeholder="Search tools"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          size="xs"
          bg="transparent"
          mb="1"
          data-connector-search=""
        />
        {connectors.isPending && <DropdownMenuItem disabled>Loading connectors…</DropdownMenuItem>}
        {connectors.isError && <DropdownMenuItem disabled>Could not load connectors</DropdownMenuItem>}
        {connectors.isSuccess && total === 0 && <DropdownMenuItem disabled>No connectors yet</DropdownMenuItem>}
        {connectors.isSuccess && total > 0 && shown.length === 0 && <DropdownMenuItem disabled>No matches</DropdownMenuItem>}
        <MenuHeading shown={healthy.length > 0}>Connected</MenuHeading>
        {healthy.map((connector) => (
          <ConnectorOption key={connector.id} connector={connector} />
        ))}
        <MenuHeading shown={unreachable.length > 0}>Not reachable</MenuHeading>
        {unreachable.map((connector) => (
          <ConnectorOption key={connector.id} connector={connector} />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          gap="2"
          onSelect={() => window.open('/settings/connectors', '_blank', 'noopener')}
          data-connector-manage=""
        >
          <Icons.gears size={14} />
          <styled.span flex="1" fontSize="1.5">
            Manage in Settings
          </styled.span>
          <Icons.exportSquare size={12} color="text.muted" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ComposerStopButton = ({ stop }: { stop: (() => void) | null }) => {
  if (!stop) return null;

  return (
    <Button
      type="button"
      size="icon"
      rounded="full"
      variant="soft"
      ml="auto"
      flexShrink="0"
      h="2rem"
      w="2rem"
      aria-label="Stop answering"
      title="Stop answering"
      onClick={stop}
    >
      <Icons.stop size={14} />
    </Button>
  );
};

const ComposerSendButton = ({
  canSend,
  stopping,
}: {
  canSend: boolean;
  stopping: boolean;
}) => (
  <Button
    type="submit"
    size="icon"
    rounded="full"
    ml={stopping ? '0' : 'auto'}
    flexShrink="0"
    h="2rem"
    w="2rem"
    aria-label="Ask"
    title="Ask"
    disabled={!canSend}
  >
    <Icons.arrowUp size={15} />
  </Button>
);

/** The Copilot composer: a question, the agent and its tools; the page places it in an opaque band at the bottom. */
export const CopilotComposer = ({
  send,
  stop,
  busy,
  fill,
  placeholder = 'Ask about stock, vendors and orders, or start a restock run',
}: {
  send: (question: string) => void;
  /** Set while an answer streams. */
  stop: (() => void) | null;
  busy: boolean;
  /** A picked prompt to place in the box. */
  fill?: { text: string; at: number } | null;
  placeholder?: string;
}) => {
  const [draft, setDraft] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const question = draft.trim();
  const canSend = Boolean(question) && question.length <= QUESTION_CHARS && !busy;

  useEffect(() => {
    if (!fill) return;
    setDraft(fill.text);
    textarea.current?.focus();
  }, [fill]);

  const submit = () => {
    if (!canSend) return;
    send(question);
    setDraft('');
  };

  return (
    <Box mx="auto" w="full" maxW="48rem" data-testid="chat-composer">
      <styled.form
        position="relative"
        zIndex="1"
        rounded="2xl"
        bg="background.app"
        backgroundImage="linear-gradient({colors.brand.panel.5}, {colors.brand.panel.5})"
        px={{ base: '3', md: '4' }}
        pt="3"
        pb="2.5"
        containerType="inline-size"
        data-testid="chat-composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <styled.textarea
          ref={textarea}
          aria-label="Ask a question"
          placeholder={stop ? 'Answering…' : placeholder}
          value={draft}
          rows={2}
          w="full"
          resize="none"
          bg="transparent"
          outline="none"
          fontSize="2"
          lineHeight="1.6"
          _placeholder={{ color: 'text.muted' }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        {question.length > QUESTION_CHARS * 0.9 && (
          <styled.p
            aria-live="polite"
            fontSize="1"
            color={question.length > QUESTION_CHARS ? 'text.error' : 'text.muted'}
            textAlign="right"
          >
            {question.length.toLocaleString('en')} / {QUESTION_CHARS.toLocaleString('en')}
          </styled.p>
        )}
        <HStack gap="1.5" mt="1" minW="0">
          <AgentChip />
          <ToolsMenu />
          <ComposerStopButton stop={stop} />
          <ComposerSendButton canSend={canSend} stopping={Boolean(stop)} />
        </HStack>
      </styled.form>
    </Box>
  );
};

/** The opaque band that holds the composer at the bottom of a page, outside its scrolling content. */
export const ComposerBand = ({ children }: { children: React.ReactNode }) => (
  <Box
    flexShrink="0"
    bg="background.app"
    px={{ base: '3', md: '6' }}
    pt="3"
    style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    data-testid="composer-band"
  >
    {children}
  </Box>
);
