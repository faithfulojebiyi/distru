// Ported from clarkia apps/dashboard/src/routes/sign-in.tsx: the credentials step with password or emailed code
// (method toggle), "Forgot password?" into PasswordReset, the code step (OtpStep, purpose sign-in) and the
// verify-email step when the password sign-in answers EMAIL_NOT_VERIFIED, plus the reset notice. Clarkia's
// workspace-invitation completion is left out (Ops Agent has no workspaces); the demo account buttons are Ops Agent's.
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type ComponentProps, type FormEvent } from 'react';
import { HStack, VStack, styled } from '@ops/ui/jsx';

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
import { OtpStep } from '../modules/auth/components/otp-step';
import { PasswordReset } from '../modules/auth/components/password-reset';
import type { OtpPurpose, SignInStep } from '../modules/auth/components/types';
import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Input } from '@ops/ui/primitives/input';
import { Span, Text } from '@ops/ui/primitives/text';

type Search = { redirect?: string };

type Credentials = { email: string; password: string };

type SignInMethod = 'password' | 'otp';

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

const SignInNotice = ({ notice }: { notice: string | null }) => {
  if (!notice) {
    return null;
  }

  return (
    <Text color="brand.success.11" fontSize="1.5" role="status" textAlign="center">
      {notice}
    </Text>
  );
};

const submitLabel = (method: SignInMethod, pending: boolean) => {
  if (pending) {
    return 'Working…';
  }

  if (method === 'password') {
    return 'Sign in';
  }

  return 'Email me a code';
};

const methodToggleLabel = (method: SignInMethod) => {
  if (method === 'password') {
    return 'Email me a code instead';
  }

  return 'Use my password';
};

const OtpView = ({
  email,
  error,
  purpose,
  onBack,
  onVerified,
}: {
  email: string;
  error: string | null;
  purpose: OtpPurpose;
  onBack: () => void;
  onVerified: () => void;
}) => (
  <AuthShell aside={<WelcomeAside />} switchTo={<SignUpSwitch />}>
    <VStack alignItems="stretch" gap="3">
      <OtpStep email={email} purpose={purpose} onBack={onBack} onVerified={onVerified} />
      <SignInError error={error} />
    </VStack>
  </AuthShell>
);

const CredentialsView = ({
  email,
  error,
  method,
  notice,
  onDemoSignIn,
  onEmailChange,
  onForgotPassword,
  onMethodChange,
  onPasswordChange,
  onSubmit,
  password,
  pending,
}: {
  email: string;
  error: string | null;
  method: SignInMethod;
  notice: string | null;
  onDemoSignIn: (credentials: Credentials) => void;
  onEmailChange: (email: string) => void;
  onForgotPassword: () => void;
  onMethodChange: () => void;
  onPasswordChange: (password: string) => void;
  onSubmit: ComponentProps<'form'>['onSubmit'];
  password: string;
  pending: boolean;
}) => (
  <AuthShell aside={<WelcomeAside />} switchTo={<SignUpSwitch />}>
    <form onSubmit={onSubmit}>
      <VStack alignItems="stretch" gap="3">
        <AuthHeading
          icon={method === 'password' ? Icons.user : Icons.sms}
          title={method === 'password' ? 'Welcome back' : 'Sign in with a code'}
        >
          {method === 'password'
            ? 'Sign in to review what the agents have proposed.'
            : 'We’ll email you a six digit code. No password needed.'}
        </AuthHeading>
        <SignInNotice notice={notice} />
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
        {method === 'password' && (
          <AuthField
            label="Password"
            aside={
              <styled.button
                color="text.muted"
                fontWeight="400"
                onClick={onForgotPassword}
                type="button"
                _hover={{ color: 'text.app' }}
              >
                Forgot password?
              </styled.button>
            }
          >
            <PasswordInput
              autoComplete="current-password"
              label="Password"
              onChange={onPasswordChange}
              placeholder="Your password"
              value={password}
            />
          </AuthField>
        )}
        <SignInError error={error} />
        <Button disabled={pending || !email} size="md" type="submit">
          {submitLabel(method, pending)}
        </Button>
        <OrDivider />
        <Button onClick={onMethodChange} size="md" type="button" variant="outline">
          {methodToggleLabel(method)}
        </Button>
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
  const [method, setMethod] = useState<SignInMethod>('password');
  const [step, setStep] = useState<SignInStep>('credentials');
  const [notice, setNotice] = useState<string | null>(null);

  /** Signed in (password, code or a confirmed email): drop the previous account's cache and open the app. */
  const finishSignIn = async () => {
    setError(null);
    try {
      clearSessionQueries(getQueryClient());
      await navigate({ to: destination });
    } catch {
      setError('Signed in, but could not open your account');
    }
  };

  const sendCode = async () => {
    setPending(true);
    setError(null);
    try {
      const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'sign-in',
      });
      if (sendError) {
        return setError(sendError.message ?? 'Could not send a code');
      }

      setStep('code');
    } catch {
      setError('Could not send a code');
    } finally {
      setPending(false);
    }
  };

  const signIn = async (credentials: Credentials) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const { error: signInError } = await authClient.signIn.email(credentials);

      // The server has just emailed a code to confirm the address; confirming it signs the account in.
      if (signInError?.code === 'EMAIL_NOT_VERIFIED') {
        setStep('verify-email');

        return;
      }

      if (signInError) {
        return setError(signInError.message ?? 'Could not sign in');
      }

      await finishSignIn();
    } catch {
      setError('Could not sign in');
    } finally {
      setPending(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (method === 'otp') {
      return void sendCode();
    }

    void signIn({ email, password });
  };

  const changeMethod = () => {
    setMethod(method === 'password' ? 'otp' : 'password');
    setError(null);
  };

  const backToCredentials = () => {
    setError(null);

    setStep('credentials');
  };

  const passwordReset = (resetEmail: string) => {
    setEmail(resetEmail);

    setPassword('');

    setMethod('password');

    setError(null);

    setNotice('Your password was changed. Sign in with your new password.');

    setStep('credentials');
  };

  switch (step) {
    case 'code':
      return (
        <OtpView
          email={email}
          error={error}
          purpose="sign-in"
          onBack={backToCredentials}
          onVerified={() => void finishSignIn()}
        />
      );

    case 'verify-email':
      return (
        <OtpView
          email={email}
          error={error}
          purpose="email-verification"
          onBack={backToCredentials}
          onVerified={() => void finishSignIn()}
        />
      );

    case 'reset':
      return (
        <AuthShell aside={<WelcomeAside />} switchTo={<SignUpSwitch />}>
          <PasswordReset initialEmail={email} onBack={backToCredentials} onDone={passwordReset} />
        </AuthShell>
      );

    case 'credentials':
      return (
        <CredentialsView
          email={email}
          error={error}
          method={method}
          notice={notice}
          onDemoSignIn={(credentials) => {
            setEmail(credentials.email);
            setPassword(credentials.password);
            setMethod('password');
            void signIn(credentials);
          }}
          onEmailChange={setEmail}
          onForgotPassword={() => {
            setError(null);

            setNotice(null);

            setStep('reset');
          }}
          onMethodChange={changeMethod}
          onPasswordChange={setPassword}
          onSubmit={onSubmit}
          password={password}
          pending={pending}
        />
      );
  }
}
