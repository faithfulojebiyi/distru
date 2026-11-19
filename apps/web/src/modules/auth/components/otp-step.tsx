// Copied from clarkia apps/dashboard/src/modules/auth/components/otp-step.tsx; only the import scope and the dev-delivery note
// differ.
import { useState, type FormEvent } from 'react';
import { VStack, styled } from '@ops/ui/jsx';

import { authClient } from '../../../lib/auth-client';
import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Span, Text } from '@ops/ui/primitives/text';
import { AuthHeading, CodeInput, OrDivider } from './auth-form';
import { OTP_PURPOSE_COPY, otpErrorMessage } from './constants';
import type { OtpPurpose } from './types';

export type OtpStepProps = {
  email: string;
  /** Signing in with the code, or confirming a new account's email; defaults to signing in. */
  purpose?: OtpPurpose;
  onBack: () => void;
  onVerified: () => void | Promise<void>;
};

/** Sends the code to the endpoint for its purpose; verifying an email also signs the account in. */
const verifyCode = async (purpose: OtpPurpose, email: string, otp: string) => {
  switch (purpose) {
    case 'sign-in':
      return await authClient.signIn.emailOtp({ email, otp });

    case 'email-verification':
      return await authClient.emailOtp.verifyEmail({ email, otp });
  }
};

/** Verify the six-digit code sent through the configured mail transport, or ask for a new one. */
export const OtpStep = ({
  email,
  purpose = 'sign-in',
  onBack,
  onVerified,
}: OtpStepProps) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setPending(true);

    setError(null);

    setNotice(null);

    try {
      const { error: verifyError } = await verifyCode(purpose, email, code);

      if (verifyError) {
        setError(otpErrorMessage(verifyError, 'That code did not work'));

        return;
      }

      await onVerified();
    } catch {
      setError('Could not verify that code');
    } finally {
      setPending(false);
    }
  };

  const resend = async () => {
    setPending(true);

    setError(null);

    setNotice(null);

    try {
      const { error: sendError } =
        await authClient.emailOtp.sendVerificationOtp({ email, type: purpose });

      if (sendError) {
        setError(sendError.message ?? 'Could not send a new code');

        return;
      }

      setCode('');

      setNotice('We sent a new code.');
    } catch {
      setError('Could not send a new code');
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <VStack alignItems="stretch" gap="3">
        <AuthHeading icon={Icons.sms} title={OTP_PURPOSE_COPY[purpose].title}>
          We sent a six digit code to{' '}
          <Span color="text.app" fontWeight="500">
            {email}
          </Span>
          . {OTP_PURPOSE_COPY[purpose].detail}
        </AuthHeading>

        <CodeInput value={code} onChange={setCode} invalid={error !== null} />

        {error ? (
          <Text
            color="brand.error.11"
            fontSize="1.5"
            role="alert"
            textAlign="center"
          >
            {error}
          </Text>
        ) : null}

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

        <Button disabled={pending || code.length < 6} size="md" type="submit">
          {pending ? 'Verifying…' : OTP_PURPOSE_COPY[purpose].submit}
        </Button>

        <Text color="text.muted" fontSize="1.5" textAlign="center">
          Didn’t get it?{' '}
          <styled.button
            color="text.app"
            disabled={pending}
            fontWeight="500"
            onClick={() => void resend()}
            type="button"
          >
            Send a new code
          </styled.button>
        </Text>

        <OrDivider />

        <Button onClick={onBack} size="md" type="button" variant="outline">
          Use a different email
        </Button>

        <Span color="text.placeholder" fontSize="1" textAlign="center">
          The code expires after five minutes. Local development delivers it to the Resend emulator mailbox (and the agent log).
        </Span>
      </VStack>
    </form>
  );
};
