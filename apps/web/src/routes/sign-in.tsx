import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type ComponentProps, type FormEvent } from 'react';
import { HStack, VStack } from '@ops/ui/jsx';

import { authClient } from '../lib/auth-client';
import { clearSessionQueries, getQueryClient } from '../lib/query';
import { safeRedirect } from '../lib/safe-redirect';
import {
  AuthField,
  AuthHeading,
  OrDivider,
  PasswordInput,
  SwitchPrompt,
} from '../modules/auth/components/auth-form';
import { AuthShell, WelcomeAside } from '../modules/auth/components/auth-shell';
import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Input } from '@ops/ui/primitives/input';
import { Span, Text } from '@ops/ui/primitives/text';

type Search = { redirect?: string };

type Credentials = { email: string; password: string };

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  ssr: false,
  component: SignIn,
});

/** Seeded by the agent server; one account per role so a visitor can try both sides of an approval. */
const DEMO_PASSWORD = 'demo-password';
const DEMO_ACCOUNTS = [
  {
    email: 'operator@demo.dev',
    label: 'Operator',
    hint: 'Starts runs and proposes changes',
  },
  {
    email: 'approver@demo.dev',
    label: 'Approver',
    hint: 'Approves or rejects proposed writes',
  },
] as const;

const SignInError = ({ error }: { error: string | null }) => {
  if (!error) {
    return null;
  }

  return (
    <Text color="brand.error.11" fontSize="1.5" role="alert" textAlign="center">
      {error}
    </Text>
  );
};

/** Top right of the sign-in screen: the way to sign-up. */
const SignUpSwitch = () => (
  <SwitchPrompt prompt="New to Ops Agent?">
    <Button asChild size="xs" variant="outline">
      <Link to="/sign-up">Sign up</Link>
    </Button>
  </SwitchPrompt>
);

/** One click into a seeded account, so the demo needs no typing. */
const DemoAccounts = ({
  pending,
  onSignIn,
}: {
  pending: boolean;
  onSignIn: (credentials: Credentials) => void;
}) => (
  <VStack alignItems="stretch" gap="2">
    <Span color="text.muted" fontSize="1" textAlign="center">
      Use a demo account
    </Span>
    <HStack gap="2">
      {DEMO_ACCOUNTS.map((account) => (
        <Button
          key={account.email}
          disabled={pending}
          flex="1"
          onClick={() =>
            onSignIn({ email: account.email, password: DEMO_PASSWORD })
          }
          size="md"
          title={`${account.email} · ${account.hint}`}
          type="button"
          variant="outline"
        >
          {account.label}
        </Button>
      ))}
    </HStack>
  </VStack>
);

const CredentialsView = ({
  email,
  error,
  onDemoSignIn,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  password,
  pending,
}: {
  email: string;
  error: string | null;
  onDemoSignIn: (credentials: Credentials) => void;
  onEmailChange: (email: string) => void;
  onPasswordChange: (password: string) => void;
  onSubmit: ComponentProps<'form'>['onSubmit'];
  password: string;
  pending: boolean;
}) => (
  <AuthShell aside={<WelcomeAside />} switchTo={<SignUpSwitch />}>
    <form onSubmit={onSubmit}>
      <VStack alignItems="stretch" gap="3">
        <AuthHeading icon={Icons.user} title="Welcome back">
          Sign in to review what the agents have proposed.
        </AuthHeading>
        <AuthField label="Work email">
          <Input
            aria-label="Work email"
            autoComplete="email"
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="you@company.com"
            required
            size="md"
            type="email"
            value={email}
          />
        </AuthField>
        <AuthField label="Password">
          <PasswordInput
            autoComplete="current-password"
            label="Password"
            onChange={onPasswordChange}
            placeholder="Your password"
            value={password}
          />
        </AuthField>
        <SignInError error={error} />
        <Button disabled={pending || !email} size="md" type="submit">
          {pending ? 'Working…' : 'Sign in'}
        </Button>
        <OrDivider />
        <DemoAccounts pending={pending} onSignIn={onDemoSignIn} />
      </VStack>
    </form>
  </AuthShell>
);

function SignIn() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const destination = safeRedirect(redirect);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const signIn = async (credentials: Credentials) => {
    setPending(true);
    setError(null);
    try {
      const { error: signInError } = await authClient.signIn.email(credentials);

      if (signInError) {
        return setError(signInError.message ?? 'Could not sign in');
      }

      // A previous account's cached reads must not show under this one.
      clearSessionQueries(getQueryClient());
      await navigate({ to: destination });
    } catch {
      setError('Could not sign in');
    } finally {
      setPending(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void signIn({ email, password });
  };

  return (
    <CredentialsView
      email={email}
      error={error}
      onDemoSignIn={(credentials) => {
        setEmail(credentials.email);
        setPassword(credentials.password);
        void signIn(credentials);
      }}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onSubmit={onSubmit}
      password={password}
      pending={pending}
    />
  );
}
