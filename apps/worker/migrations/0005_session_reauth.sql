-- Migration 0005: fresh-authentication marker on auth sessions (T5.8 SR-04, FR-USR-006,
-- ADR-0014 notes). `reauth_at` is when this session last completed a passkey assertion or
-- registration with user verification: the sign-in ceremony that created it, or
-- `POST /me/reauth/verify`. Adding a passkey requires it to be at most 5 minutes old and clears it.
-- Expand-only (TDD section 3): one nullable column, no data change. Existing sessions read NULL,
-- so they must re-authenticate before adding a passkey.
ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
