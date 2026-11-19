import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type ComponentProps, type FormEvent } from 'react';
import { VStack } from '@ops/ui/jsx';

import { authClient } from '../lib/auth-client';
import { clearSessionQueries, getQueryClient } from '../lib/query';
import {
  AuthField,
  AuthHeading,
  PasswordInput,
  SwitchPrompt,
} from '../modules/auth/components/auth-form';
import { AuthShell, WelcomeAside } from '../modules/auth/components/auth-shell';
import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Input } from '@ops/ui/primitives/input';
import { Span, Text } from '@ops/ui/primitives/text';

export const Route = createFileRoute('/sign-up')({
  ssr: false,
  component: SignUp,
});

const SignUpError = ({ error }: { error: string | null }) => {
  if (!error) {
    return null;
  }

  return (
    <Text color="brand.error.11" fontSize="1.5" role="alert" textAlign="center">
      {error}
    </Text>
  );
};

/** Top right of the sign-up screen: the way back to sign-in. */
const SignInSwitch = () => (
  <SwitchPrompt prompt="Already have an account?">
    <Button asChild size="xs" variant="outline">
      <Link to="/sign-in">Sign in</Link>
    </Button>
  </SwitchPrompt>
);

const DetailsView = ({
  email,
  error,
  name,
  onEmailChange,
  onNameChange,
  onPasswordChange,
  onSubmit,
  password,
  pending,
}: {
  email: string;
  error: string | null;
  name: string;
  onEmailChange: (email: string) => void;
  onNameChange: (name: string) => void;
  onPasswordChange: (password: string) => void;
  onSubmit: ComponentProps<'form'>['onSubmit'];
  password: string;
  pending: boolean;
}) => (
  <AuthShell aside={<WelcomeAside />} switchTo={<SignInSwitch />}>
    <form onSubmit={onSubmit}>
      <VStack alignItems="stretch" gap="3">
        <AuthHeading icon={Icons.user} title="Create your account">
          Watch the agents find at-risk stock and draft the restock.
        </AuthHeading>
        <AuthField label="Full name">
          <Input
            aria-label="Full name"
            autoComplete="name"
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Your name"
            required
            size="md"
            value={name}
          />
        </AuthField>
        <AuthField label="Work email">
          <Input
            aria-label="Work email"
            autoComplete="email"
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="you@company.com"
            required
            size="md"
            type="email"
            value={email}
          />
        </AuthField>
        <AuthField label="Password">
          <PasswordInput
            autoComplete="new-password"
            label="Password"
            minLength={8}
            onChange={onPasswordChange}
            placeholder="At least 8 characters"
            value={password}
          />
        </AuthField>
        <SignUpError error={error} />
        <Button
          disabled={pending || !name || !email || password.length < 8}
          size="md"
          type="submit"
        >
          {pending ? 'Creating…' : 'Create account'}
        </Button>
        <Span color="text.placeholder" fontSize="1" textAlign="center">
          New accounts start as operators. Approvals need an approver.
        </Span>
      </VStack>
    </form>
  </AuthShell>
);

function SignUp() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setPending(true);
    setError(null);

    try {
      // Email verification is off, so Better Auth signs the new account straight in.
      const { error: signUpError } = await authClient.signUp.email({
        name,
        email,
        password,
      });

      if (signUpError) {
        setError(signUpError.message ?? 'Could not create your account');

        return;
      }

      clearSessionQueries(getQueryClient());
      await navigate({ to: '/' });
    } catch {
      setError('Could not create your account');
    } finally {
      setPending(false);
    }
  };

  return (
    <DetailsView
      email={email}
      error={error}
      name={name}
      onEmailChange={setEmail}
      onNameChange={setName}
      onPasswordChange={setPassword}
      onSubmit={(event) => void onSubmit(event)}
      password={password}
      pending={pending}
    />
  );
}
