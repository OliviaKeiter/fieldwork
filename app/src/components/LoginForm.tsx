import { useState, type FormEvent } from 'react';
import { signInWithOtp } from '../lib/auth';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setErrorMessage(null);

    const { error } = await signInWithOtp(email);

    if (error) {
      setStatus('error');
      setErrorMessage(error.message);
      return;
    }

    setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-center">
        <p className="text-lg font-medium text-text">Check your email</p>
        <p className="mt-2 text-sm text-text-dim">
          We sent a sign-in link to <span className="text-text">{email}</span>. Open it on
          this device to continue.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-2 text-sm text-text-dim">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="rounded-lg border border-border bg-surface px-3 py-2 text-text outline-none focus:border-accent"
        />
      </label>

      <button
        type="submit"
        disabled={status === 'sending'}
        className="rounded-lg bg-accent px-4 py-2 font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {status === 'sending' ? 'Sending link…' : 'Send magic link'}
      </button>

      {status === 'error' && errorMessage && (
        <p className="text-sm text-danger">{errorMessage}</p>
      )}
    </form>
  );
}
