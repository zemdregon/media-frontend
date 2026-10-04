import type { ReactNode } from 'react';

/** Centred 420 px card used by sign-in, invite signup and setup (UX §5). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <section className="card" aria-labelledby="auth-title">
        <p className="wordmark">Cinewren</p>
        <h1 id="auth-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

export function Alert({ message }: { message: string | null }) {
  return message ? (
    <p className="alert" role="alert">
      {message}
    </p>
  ) : null;
}
