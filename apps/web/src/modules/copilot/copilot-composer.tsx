// Adapted from carbonme modules/chats/chat-composer.tsx (ComposerForm, ComposerQuestion, ComposerToolbar, send and stop
// buttons, ComposerBand), the agent chip of steward-picker.tsx and the Tools chip of chat-connector-menu.tsx (2h).
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
import { connectorIcon, useConnectors } from '../settings/settings-api';
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

/** The connectors the Ops Lead's tools reach, with their health (carbonme's Tools chip, 2h). */
const ToolsMenu = () => {
  const connectors = useConnectors();
  const items = connectors.data ?? [];
  return (
    <DropdownMenu>
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
      <DropdownMenuContent align="start" w="18rem">
        <DropdownMenuLabel>Connected systems</DropdownMenuLabel>
        {connectors.isPending && (
          <DropdownMenuItem disabled>
            <Icons.loading size={12} /> Loading…
          </DropdownMenuItem>
        )}
        {items.map((connector) => (
          <DropdownMenuItem key={connector.id} asChild>
            <Link to="/settings/connectors/$connectorId" params={{ connectorId: connector.id }}>
              <AppLogo icon={connectorIcon(connector)} name={connector.id} size="sm" />
              <Box flex="1" minW="0">
                <HStack gap="1.5">
                  <styled.span fontWeight="500" textTransform="capitalize">
                    {connector.id}
                  </styled.span>
                  <StatusDot tone={connector.health.ok ? 'green' : 'amber'} />
                </HStack>
                <styled.span fontSize="1" color="text.muted">
                  {connector.readTools} read tools · {connector.actions} propose-only
                </styled.span>
              </Box>
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/connectors">
            <Icons.setting size={13} />
            Manage connectors
          </Link>
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
