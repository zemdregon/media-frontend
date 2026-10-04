-- Migration 0003: stream DeviceId pool leases (T3.3; ADR-0013 Emby amendment, LLD-TOKEN).
-- Emby returns the same token when the same DeviceId signs in again and keeps device entries
-- after logout, so stream credentials use a bounded, reusable pool of DeviceIds per server
-- (`cinewren-ps-00` to `NN`). A slot is leased to one playback session from before the token is
-- minted until that token has been revoked; the primary key makes a double lease impossible.
-- Jellyfin uses one DeviceId per session and never leases.
-- Expand-only (TDD section 3): a new table, no change to existing ones.
CREATE TABLE stream_device_leases (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,                     -- DeviceId cinewren-ps-<slot, zero-padded to 2>
  session_id TEXT NOT NULL,                  -- playback_sessions.id (the row may not exist yet)
  leased_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, slot)) WITHOUT ROWID;
CREATE INDEX sdl_session ON stream_device_leases(session_id);
