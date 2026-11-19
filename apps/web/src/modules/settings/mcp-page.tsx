// Built on carbonme modules/settings/settings-page.tsx and the numbered steps of
// modules/integrations/mcp-setup-card.tsx (SetupSteps).
import { Flex, HStack, styled } from '@ops/ui/jsx';

import { SettingsPage, SettingsPanel } from './settings-page';

const STEPS = [
  'Copy this harness’s MCP URL (shown here once the server publishes it).',
  'In Claude Code run `claude mcp add`, or add it to Codex’s `config.toml` under `mcp_servers`.',
  'Sign in when the client opens the browser. The token carries your role: operators get read and propose, approvers also approve.',
];

const SetupSteps = ({ steps }: { steps: string[] }) => (
  <styled.ol display="flex" flexDirection="column" gap="2.5">
    {steps.map((step, index) => (
      <HStack as="li" key={step} gap="3" alignItems="start" fontSize="1.5">
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
        <styled.span pt="0.5">
          {step.split('`').map((part, at) =>
            at % 2 === 1 ? (
              <styled.code
                key={part}
                fontFamily="mono"
                fontSize="1"
                px="1"
                rounded="sm"
                bg="brand.panel.5"
              >
                {part}
              </styled.code>
            ) : (
              part
            ),
          )}
        </styled.span>
      </HStack>
    ))}
  </styled.ol>
);

/** Settings → MCP access: how to drive this harness from Claude Code or Codex. */
export const McpPage = () => (
  <SettingsPage
    title="MCP access"
    description="Connect Claude Code or Codex to this harness. They get the same governed tools as the agents: read, propose, and approve for approvers only."
  >
    <SettingsPanel
      title="Connect Claude Code / Codex to this harness"
      description="The MCP endpoint URL will be added here."
      data-mcp-setup=""
    >
      <SetupSteps steps={STEPS} />
      <HStack
        gap="2"
        px="3"
        py="2"
        rounded="lg"
        bg="brand.panel.4"
        color="text.muted"
        fontSize="1.5"
      >
        <styled.span fontFamily="mono">https://…/mcp</styled.span>
        <styled.span ml="auto" fontSize="1">
          Coming soon
        </styled.span>
      </HStack>
    </SettingsPanel>
  </SettingsPage>
);
