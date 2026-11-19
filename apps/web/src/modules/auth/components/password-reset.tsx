// Copied from clarkia apps/dashboard/src/modules/auth/components/password-reset.tsx; only the import scope and the dev-delivery note
// differ.
import { useState, type ComponentProps, type FormEvent } from 'react';
import { HStack, VStack, styled } from '@ops/ui/jsx';

import { authClient } from '../../../lib/auth-client';
import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Input } from '@ops/ui/primitives/input';
import { Span, Text } from '@ops/ui/primitives/text';
import { AuthField, AuthHeading, CodeInput, PasswordInput } from './auth-form';
import { otpErrorMessage } from './constants';
import type { PasswordResetStep } from './types';

export type PasswordResetProps = {
  /** What the member had typed on sign-in, so they need not type it again. */
  initialEmail: string;
  onBack: () => void;
  /** The password changed; sign-in takes over with a note. */
  onDone: (email: string) => void;
};

const ResetError = ({ error }: { error: string | null }) => {
  if (!error) {
    return null;
  }

  return (
    <Text color="brand.error.11" fontSize="1.5" role="alert" textAlign="center">
      {error}
    </Text>
  );
};

const EmailView = ({
  email,
  error,
  pending,
  onEmailChange,
  onSubmit,
  onBack,
}: {
  email: string;
  error: string | null;
  pending: boolean;
  onEmailChange: (email: string) => void;
  onSubmit: ComponentProps<'form'>['onSubmit'];
  onBack: () => void;
}) => (
  <form onSubmit={onSubmit}>
    <VStack alignItems="stretch" gap="3">
      <AuthHeading icon={Icons.key} title="Reset your password">
        We’ll email you a six digit code to set a new one.
      </AuthHeading>
      <AuthField label="Work email">
        <Input
          aria-label="Work email"
          autoComplete="email"
          autoFocus
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="you@company.com"
          required
          size="md"
          type="email"
          value={email}
        />
      </AuthField>
      <ResetError error={error} />
      <Button disabled={pending || !email} size="md" type="submit">
        {pending ? 'Working…' : 'Email me a code'}
      </Button>
      <Button onClick={onBack} size="md" type="button" variant="ghost">
        Back to sign in
      </Button>
    </VStack>
  </form>
);

const CodeView = ({
  email,
  code,
  password,
  error,
  notice,
  pending,
  onCodeChange,
  onPasswordChange,
  onSubmit,
  onResend,
  onEdit,
}: {
  email: string;
  code: string;
  password: string;
  error: string | null;
  notice: string | null;
  pending: boolean;
  onCodeChange: (code: string) => void;
  onPasswordChange: (password: string) => void;
  onSubmit: ComponentProps<'form'>['onSubmit'];
  onResend: () => void;
  /** back to the email step, to change the address */
  onEdit: () => void;
}) => (
  <form onSubmit={onSubmit}>
    <VStack alignItems="stretch" gap="3">
      <AuthHeading icon={Icons.lock} title="Set a new password">
        Enter the code we sent to your email and choose a new password.
      </AuthHeading>
      <HStack
        bg="brand.panel.5"
        fontSize="1.5"
        h="9"
        justify="space-between"
        px="3"
        rounded="lg"
      >
        <Span truncate>{email}</Span>
        <styled.button
          color="text.secondary"
          fontSize="1"
          fontWeight="500"
          onClick={onEdit}
          textDecoration="underline"
          type="button"
        >
          Edit
        </styled.button>
      </HStack>
      <AuthField label="Code">
        <CodeInput
          value={code}
          onChange={onCodeChange}
          invalid={error !== null}
        />
      </AuthField>
      <AuthField label="New password">
        <PasswordInput
          autoComplete="new-password"
          label="New password"
          minLength={8}
          onChange={onPasswordChange}
          placeholder="At least 8 characters"
          value={password}
        />
      </AuthField>
      <ResetError error={error} />
      {notice ? (
        <Text
          color="brand.success.11"
          fontSize="1.5"
          role="status"
          textAlign="center"
        >
          {notice}
        </Text>
      ) : null}
      <Button
        disabled={pending || code.length < 6 || password.length < 8}
        size="md"
        type="submit"
      >
        {pending ? 'Working…' : 'Save new password'}
      </Button>
      <Text color="text.muted" fontSize="1.5" textAlign="center">
        Didn’t get it?{' '}
        <styled.button
          color="text.app"
          disabled={pending}
          fontWeight="500"
          onClick={onResend}
          type="button"
        >
          Send a new code
        </styled.button>
      </Text>
      <Span color="text.placeholder" fontSize="1" textAlign="center">
        The code expires after five minutes. Local development delivers it to the Resend emulator mailbox (and the agent log).
      </Span>
    </VStack>
  </form>
);

/** Forgot password: an emailed code, then the code with a new password. */
export const PasswordReset = ({
  initialEmail,
  onBack,
  onDone,
}: PasswordResetProps) => {
  const [step, setStep] = useState<PasswordResetStep>('email');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /** Returns whether the code went out; a failure is shown inline. */
  const sendCode = async () => {
    setPending(true);

    setError(null);

    setNotice(null);

    try {
      const { error: sendError } =
        await authClient.emailOtp.requestPasswordReset({ email });

      if (sendError) {
        setError(sendError.message ?? 'Could not send a code');

        return false;
      }

      return true;
    } catch {
      setError('Could not send a code');

      return false;
    } finally {
      setPending(false);
    }
  };

  const requestCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (await sendCode()) {
      setStep('code');
    }
  };

  const resend = async () => {
    if (await sendCode()) {
      setCode('');

      setNotice('We sent a new code.');
    }
  };

  const reset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setPending(true);

    setError(null);

    setNotice(null);

    try {
      const { error: resetError } = await authClient.emailOtp.resetPassword({
        email,
        otp: code,
        password,
      });

      if (resetError) {
        setError(otpErrorMessage(resetError, 'Could not reset your password'));

        return;
      }

      onDone(email);
    } catch {
      setError('Could not reset your password');
    } finally {
      setPending(false);
    }
  };

  switch (step) {
    case 'email':
      return (
        <EmailView
          email={email}
          error={error}
          pending={pending}
          onEmailChange={setEmail}
          onSubmit={(event) => void requestCode(event)}
          onBack={onBack}
        />
      );

    case 'code':
      return (
        <CodeView
          email={email}
          code={code}
          password={password}
          error={error}
          notice={notice}
          pending={pending}
          onCodeChange={setCode}
          onPasswordChange={setPassword}
          onSubmit={(event) => void reset(event)}
          onResend={() => void resend()}
          onEdit={() => {
            setError(null);

            setStep('email');
          }}
        />
      );
  }
};
