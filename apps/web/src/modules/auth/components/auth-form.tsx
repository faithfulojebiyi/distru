// Copied from clarkia apps/dashboard/src/modules/auth/components/auth-form.tsx (AuthHeading, AuthField, PasswordInput,
// OrDivider, SwitchPrompt, CodeInput).
import { useState, type ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import type { TIcon } from '@ops/ui/icons/types';
import { Input } from '@ops/ui/primitives/input';
import { Heading, Span, Text } from '@ops/ui/primitives/text';

const CODE_SLOTS = [0, 1, 2, 3, 4, 5];

/** A plain glyph over the title and one line of subtitle; every auth step opens with it. */
export const AuthHeading = ({
  icon: Icon,
  title,
  children,
}: {
  icon: TIcon;
  title: string;
  children: ReactNode;
}) => (
  <Flex align="center" direction="column" gap="1.5" mb="2.5" textAlign="center">
    <Box color="text.muted" mb="1">
      <Icon size={22} />
    </Box>
    <Heading
      as="h2"
      fontSize="6"
      fontWeight="600"
      letterSpacing="-0.02em"
      lineHeight="1.2"
    >
      {title}
    </Heading>
    <Text color="text.muted" fontSize="1.5" textWrap="balance">
      {children}
    </Text>
  </Flex>
);

/** A label over its control, with an optional link on the right such as "Forgot password?". */
export const AuthField = ({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <Flex direction="column" gap="1.5">
    <HStack
      color="text.secondary"
      fontSize="1"
      fontWeight="500"
      justify="space-between"
    >
      <span>{label}</span>
      {aside}
    </HStack>
    {children}
  </Flex>
);

/** A password input with a show/hide toggle. */
export const PasswordInput = ({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder: string;
  minLength?: number;
}) => {
  const [shown, setShown] = useState(false);

  const Toggle = shown ? Icons.eyeSlash : Icons.eye;

  return (
    <Box position="relative">
      <Input
        aria-label={label}
        autoComplete={autoComplete}
        minLength={minLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        pr="9"
        required
        size="md"
        type={shown ? 'text' : 'password'}
        value={value}
      />
      <styled.button
        aria-label={shown ? 'Hide password' : 'Show password'}
        color="text.placeholder"
        display="grid"
        h="9"
        onClick={() => setShown(!shown)}
        placeItems="center"
        position="absolute"
        right="0"
        top="0"
        type="button"
        w="9"
        _hover={{ color: 'text.muted' }}
      >
        <Toggle size={15} />
      </styled.button>
    </Box>
  );
};

/** The "Or" rule between the main action and its alternative. */
export const OrDivider = () => (
  <styled.div
    alignItems="center"
    color="text.placeholder"
    display="grid"
    fontSize="1"
    gap="2.5"
    gridTemplateColumns="1fr auto 1fr"
    my="1"
    _before={{ bg: 'brand.panel.8', content: '""', h: '1px' }}
    _after={{ bg: 'brand.panel.8', content: '""', h: '1px' }}
  >
    Or
  </styled.div>
);

/** Six boxes over one real input, so paste, autofill and screen readers see a single code field. */
export const CodeInput = ({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
}) => {
  const [focused, setFocused] = useState(false);

  return (
    <Box position="relative">
      <styled.div display="grid" gap="2" gridTemplateColumns="repeat(6, 1fr)">
        {CODE_SLOTS.map((slot) => (
          <styled.span
            key={slot}
            bg={invalid ? 'brand.error.3' : 'brand.panel.5'}
            color={invalid ? 'brand.error.11' : 'text.app'}
            display="grid"
            fontFamily="mono"
            fontSize="4"
            fontWeight="600"
            h="2.875rem"
            placeItems="center"
            ring={focused && slot === Math.min(value.length, 5) ? '2px' : '0'}
            ringColor="brand.panel.15"
            rounded="lg"
          >
            {value[slot] ?? ''}
          </styled.span>
        ))}
      </styled.div>
      <styled.input
        aria-invalid={invalid}
        aria-label="Code"
        autoComplete="one-time-code"
        autoFocus
        caretColor="transparent"
        color="transparent"
        inputMode="numeric"
        inset="0"
        maxLength={6}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))}
        onFocus={() => setFocused(true)}
        opacity="0"
        position="absolute"
        required
        value={value}
        w="full"
      />
    </Box>
  );
};

/** The top-right prompt with a small outline button to the other auth page. */
export const SwitchPrompt = ({
  prompt,
  children,
}: {
  prompt: string;
  children: ReactNode;
}) => (
  <>
    <Span display={{ base: 'none', sm: 'inline' }}>{prompt}</Span>
    {children}
  </>
);
