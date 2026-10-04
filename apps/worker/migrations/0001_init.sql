-- Migration 0001_init: schema v1 (LLD-SCHEMA, DR-001, DR-004, DR-005).
-- Forward-only (TDD §3). The DDL follows the LLD-SCHEMA "DDL sketch" verbatim; change the LLD
-- first, then add a new migration. Never edit this file after it has been applied anywhere.
-- Conventions: IDs are ULIDs (TEXT); times are INTEGER Unix milliseconds; JSON columns are TEXT.

CREATE TABLE users (                        -- created only by setup or invite redemption (FR-USR-002)
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- the only personal label; no email is collected (NFR-PRIV-001)
  role TEXT NOT NULL CHECK (role IN ('operator','viewer')),
  status TEXT NOT NULL CHECK (status IN ('invited','active','disabled')),  -- 'deleted' = row removed
  theme_preference TEXT NOT NULL DEFAULT 'system' CHECK (theme_preference IN ('system','dark','light')),  -- NFR-UX-001; owner decision Q-8; the only stored preference
  created_at INTEGER NOT NULL, last_seen_at INTEGER);

CREATE TABLE passkey_credentials (          -- IR-006; a user may have several (FR-USR-006)
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,        -- base64url WebAuthn credential ID
  public_key BLOB NOT NULL,                  -- COSE public key
  sign_count INTEGER NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '[]',
  aaguid TEXT, backed_up INTEGER, label TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE INDEX pk_user ON passkey_credentials(user_id);

CREATE TABLE invites (                      -- invite, re-enrollment and recovery links (FR-USR-002, -004, -007)
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('signup','reenroll')),
  token_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of the 32-byte token; plaintext never stored (NFR-SEC-007)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- signup: the 'invited' user created with the invite (role + library_grants set then, FR-USR-005)
      -- reenroll: the existing user who gets an extra passkey
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,     -- NULL for CLI recovery links
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  redeemed_at INTEGER, revoked_at INTEGER);
CREATE INDEX inv_open ON invites(kind, redeemed_at, revoked_at, expires_at);
CREATE INDEX inv_user ON invites(user_id);

CREATE TABLE sessions (                     -- NFR-SEC-007
  id_hash TEXT PRIMARY KEY,                  -- SHA-256 of the cookie value
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passkey_id TEXT REFERENCES passkey_credentials(id) ON DELETE CASCADE,  -- removing a passkey ends its sessions
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
  user_agent_hint TEXT);                     -- coarse "Firefox on macOS" label for the user's session list
CREATE INDEX sess_user ON sessions(user_id);
CREATE INDEX sess_expiry ON sessions(idle_expires_at);

CREATE TABLE webauthn_challenges (          -- single-use, TTL 5 min (proposed)
  id TEXT PRIMARY KEY,                       -- opaque handle returned to the client with the options
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('setup','signup','reenroll','login','add_passkey')),
  invite_id TEXT REFERENCES invites(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL);
CREATE INDEX wc_expiry ON webauthn_challenges(expires_at);

CREATE TABLE servers (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('jellyfin','emby','plex')),
  name TEXT NOT NULL, base_url TEXT NOT NULL, origin_server_id TEXT NOT NULL UNIQUE, -- provider's unique ID (FR-SRV-002)
  version TEXT, priority INTEGER NOT NULL DEFAULT 0,                                 -- FR-SRV-006
  status TEXT NOT NULL CHECK (status IN ('pending_validation','active','degraded','unreachable','disabled','removing')),  -- 'removed' = row deleted
  last_latency_ms INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, consecutive_ok INTEGER NOT NULL DEFAULT 0,
  last_validated_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE server_credentials (            -- DR-002; never selected by catalog queries
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL, secret_envelope TEXT NOT NULL,   -- username/password or token (LLD-TOKEN)
  service_token_envelope TEXT,                                   -- cached origin access token, re-obtained on 401
  updated_at INTEGER NOT NULL);

CREATE TABLE libraries (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  provider_library_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('movies','tv')),
  enabled INTEGER NOT NULL DEFAULT 0, last_full_sync_id TEXT, UNIQUE (server_id, provider_library_id));

CREATE TABLE library_grants (               -- viewers only; operators see all enabled libraries (FR-USR-005)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL, PRIMARY KEY (user_id, library_id));

CREATE TABLE media_items (                  -- canonical, derived (DR-001)
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('movie','series','season','episode')),
  parent_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,
  title TEXT NOT NULL, sort_title TEXT NOT NULL, original_title TEXT, year INTEGER, overview TEXT,
  genres TEXT NOT NULL DEFAULT '[]', runtime_ms INTEGER, season_number INTEGER, episode_number INTEGER,
  metadata_source_id TEXT,                  -- source whose metadata is displayed (LLD-MATCH)
  best_height INTEGER, has_hdr INTEGER NOT NULL DEFAULT 0, date_added INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX mi_browse ON media_items(type, sort_title, id);
CREATE INDEX mi_added ON media_items(type, date_added DESC, id);
CREATE INDEX mi_year ON media_items(type, year, id);
CREATE INDEX mi_children ON media_items(parent_id, season_number, episode_number);

CREATE TABLE external_ids (
  media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL, scheme TEXT NOT NULL CHECK (scheme IN ('tmdb','imdb','tvdb')), value TEXT NOT NULL,
  PRIMARY KEY (media_item_id, scheme, value));
CREATE INDEX ext_lookup ON external_ids(item_type, scheme, value);  -- TMDB IDs are namespaced by type

CREATE TABLE sources (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  provider_item_id TEXT NOT NULL, provider_parent_id TEXT,
  media_item_id TEXT NOT NULL REFERENCES media_items(id),        -- no cascade: items are deleted only when sourceless
  item_type TEXT NOT NULL, title TEXT NOT NULL, year INTEGER, season_number INTEGER, episode_number INTEGER,
  external_ids TEXT NOT NULL DEFAULT '{}',                       -- raw IDs as reported by provider
  match_method TEXT NOT NULL CHECK (match_method IN ('external_id','episode_position','new','manual')),
  artwork TEXT NOT NULL DEFAULT '{}',                            -- {poster:{tag},backdrop:{tag}}
  content_hash TEXT NOT NULL,                                    -- hash of normalized fields: skip no-op writes
  status TEXT NOT NULL CHECK (status IN ('present','missing')), missing_since INTEGER,
  last_seen_sync_id TEXT, date_added INTEGER, updated_at INTEGER NOT NULL,
  UNIQUE (server_id, provider_item_id));
CREATE INDEX src_item ON sources(media_item_id, status);
CREATE INDEX src_lib_seen ON sources(library_id, status, last_seen_sync_id);
CREATE INDEX src_missing ON sources(status, missing_since);

CREATE TABLE media_versions (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  provider_version_id TEXT NOT NULL, container TEXT, video_codec TEXT, video_profile TEXT,
  width INTEGER, height INTEGER,
  hdr TEXT NOT NULL DEFAULT 'none' CHECK (hdr IN ('none','hdr10','hdr10plus','hlg','dolby_vision')),
  bitrate INTEGER, runtime_ms INTEGER,
  size_bytes INTEGER,                          -- file size as reported by the origin; NULL if unknown (FR-CAT-013)
  audio_tracks TEXT NOT NULL DEFAULT '[]',     -- [{index,codec,channels,language,title,default}]
  subtitle_tracks TEXT NOT NULL DEFAULT '[]',  -- [{index,format,kind:'text'|'image',language,title,forced,default}]
  UNIQUE (source_id, provider_version_id));

CREATE TABLE item_availability (            -- denormalized BR-1 helper; maintained with sources (see below)
  media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  PRIMARY KEY (media_item_id, library_id)) WITHOUT ROWID;
CREATE INDEX ia_lib ON item_availability(library_id, media_item_id);

CREATE TABLE people (                       -- canonical, derived (DR-001, ADR-0015)
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT NOT NULL,
  name_key TEXT NOT NULL,                    -- case- and diacritic-folded, whitespace-collapsed name: the name-merge key (LLD-MATCH)
  metadata_link_id TEXT,                     -- link whose name and portrait are shown (highest server priority, as for items)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ppl_name ON people(name_key);
CREATE INDEX ppl_sort ON people(sort_name, id);

CREATE TABLE person_provider_links (        -- one row per (server, origin person); derived
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  provider_person_id TEXT NOT NULL, name TEXT NOT NULL,
  tmdb_id TEXT, imdb_id TEXT,                -- person IDs, when the origin reports them (to verify in M1 spike); NULL otherwise
  artwork TEXT NOT NULL DEFAULT '{}',        -- {poster:{tag}} portrait reference
  match_method TEXT NOT NULL CHECK (match_method IN ('external_id','name','new','manual')),
  updated_at INTEGER NOT NULL, UNIQUE (server_id, provider_person_id));
CREATE INDEX ppl_link_person ON person_provider_links(person_id);
CREATE INDEX ppl_link_tmdb ON person_provider_links(tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX ppl_link_imdb ON person_provider_links(imdb_id) WHERE imdb_id IS NOT NULL;

CREATE TABLE credits (                      -- person <-> title; derived. Written per supplying source so a purge of one source removes only its credits
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES person_provider_links(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('actor','director','writer','producer','other')),
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,          -- denormalized from the link; re-keyed on person merge or split
  media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE, -- denormalized from the source; re-keyed on item merge or split
  character TEXT, sort_order INTEGER NOT NULL,                             -- billing order as reported by the origin
  PRIMARY KEY (source_id, link_id, role)) WITHOUT ROWID;
CREATE INDEX cr_person ON credits(person_id, media_item_id);
CREATE INDEX cr_item ON credits(media_item_id, role, sort_order);

CREATE TABLE collections (                  -- canonical, derived (DR-001, ADR-0015)
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT NOT NULL, overview TEXT,
  metadata_link_id TEXT,                     -- link whose name, overview and artwork are shown
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX col_sort ON collections(sort_name, id);

CREATE TABLE collection_provider_links (    -- one row per (server, origin collection); derived
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  provider_collection_id TEXT NOT NULL, name TEXT NOT NULL, overview TEXT,
  tmdb_collection_id TEXT,                   -- the only cross-server merge key (ADR-0015); NULL if the origin has none
  artwork TEXT NOT NULL DEFAULT '{}',
  match_method TEXT NOT NULL CHECK (match_method IN ('external_id','new','manual')),
  last_seen_sync_id TEXT, updated_at INTEGER NOT NULL, UNIQUE (server_id, provider_collection_id));
CREATE INDEX col_link_coll ON collection_provider_links(collection_id);
CREATE INDEX col_link_tmdb ON collection_provider_links(tmdb_collection_id) WHERE tmdb_collection_id IS NOT NULL;

CREATE TABLE collection_members (           -- membership as reported by each origin; the canonical collection's members are the union over its links
  link_id TEXT NOT NULL REFERENCES collection_provider_links(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,  -- denormalized from the source; re-keyed on item merge or split
  PRIMARY KEY (link_id, source_id)) WITHOUT ROWID;
CREATE INDEX cm_item ON collection_members(media_item_id);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('full','incremental')), trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed')),
  since_ms INTEGER,                           -- incremental lower bound
  checkpoint TEXT,                            -- {libraryIdx, cursor} (LLD-SYNC)
  lease_token TEXT, lease_expires_at INTEGER,
  libraries_ok TEXT NOT NULL DEFAULT '[]', libraries_failed TEXT NOT NULL DEFAULT '[]',
  added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,                         -- ≤ 4 KB, no secrets (FR-SYNC-006)
  queued_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER);
CREATE UNIQUE INDEX sync_one_active ON sync_runs(server_id) WHERE status IN ('queued','running');  -- FR-SYNC-002
CREATE INDEX sync_hist ON sync_runs(server_id, queued_at DESC);

CREATE TABLE health_probes (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  probed_at INTEGER NOT NULL, ok INTEGER NOT NULL, latency_ms INTEGER, error_code TEXT);
CREATE INDEX hp_server ON health_probes(server_id, probed_at DESC);

CREATE TABLE playback_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_item_id TEXT REFERENCES media_items(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL, server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  version_id TEXT, mode TEXT NOT NULL CHECK (mode IN ('direct_play','direct_stream','transcode')),
  status TEXT NOT NULL CHECK (status IN ('authorized','started','ended','expired','failed')),
  credential_envelope TEXT,                   -- session-scoped origin credential (LLD-TOKEN; pending ADR-0013 / M1 spike); NULL once revoked
  revoke_pending INTEGER NOT NULL DEFAULT 0, provider_session_ref TEXT,
  replaces_session_id TEXT, decision TEXT,    -- ranking keys snapshot (NFR-OBS-002)
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  authorized_at INTEGER NOT NULL, auth_expires_at INTEGER NOT NULL, started_at INTEGER,
  last_progress_at INTEGER, ended_at INTEGER, end_reason TEXT);
CREATE INDEX ps_sweep ON playback_sessions(status, auth_expires_at);
CREATE INDEX ps_idle ON playback_sessions(status, last_progress_at);
CREATE INDEX ps_revoke ON playback_sessions(revoke_pending) WHERE revoke_pending = 1;

CREATE TABLE watch_progress (                -- primary data (DR-001)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,  -- DR-003 / DR-005: kept until the user is deleted or the item is purged
  position_ms INTEGER NOT NULL, runtime_ms INTEGER, watched INTEGER NOT NULL DEFAULT 0, watched_at INTEGER,
  last_source_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, media_item_id));
CREATE INDEX wp_continue ON watch_progress(user_id, watched, updated_at DESC);

CREATE TABLE curation_overrides (            -- primary data; keyed by stable provider identity (BR-3)
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('pin','separate')),
  entity_kind TEXT NOT NULL DEFAULT 'item' CHECK (entity_kind IN ('item','person','collection')),  -- ADR-0015, FR-CAT-007
  media_item_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,   -- DR-005; set iff entity_kind='item'
  person_id TEXT REFERENCES people(id) ON DELETE CASCADE,            -- set iff 'person'
  collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,   -- set iff 'collection'
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  provider_item_id TEXT NOT NULL,            -- the origin's ID for that entity: item, person or collection
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
  UNIQUE (entity_kind, server_id, provider_item_id),
  CHECK ((entity_kind='item') = (media_item_id IS NOT NULL) AND (entity_kind='person') = (person_id IS NOT NULL)
         AND (entity_kind='collection') = (collection_id IS NOT NULL)));

CREATE TABLE match_conflicts (               -- FR-CAT-010; one open subject per row: a source, a person link or a collection link
  id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL DEFAULT 'item' CHECK (entity_kind IN ('item','person','collection')),
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,                          -- set iff 'item'
  person_link_id TEXT REFERENCES person_provider_links(id) ON DELETE CASCADE,       -- set iff 'person'
  collection_link_id TEXT REFERENCES collection_provider_links(id) ON DELETE CASCADE, -- set iff 'collection'
  media_item_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,  -- item it was kept apart from (items only)
  reason TEXT NOT NULL CHECK (reason IN ('conflicting_ids','multiple_candidates','type_mismatch','ambiguous_name')),  -- type_mismatch: items; ambiguous_name: people
  details TEXT NOT NULL,                     -- {candidates:[{itemId|personId|collectionId, sharedIds, conflictingIds}]}
  status TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  detected_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((entity_kind='item') = (source_id IS NOT NULL) AND (entity_kind='person') = (person_link_id IS NOT NULL)
         AND (entity_kind='collection') = (collection_link_id IS NOT NULL)));
CREATE UNIQUE INDEX mc_source ON match_conflicts(source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX mc_person ON match_conflicts(person_link_id) WHERE person_link_id IS NOT NULL;
CREATE UNIQUE INDEX mc_collection ON match_conflicts(collection_link_id) WHERE collection_link_id IS NOT NULL;
CREATE INDEX mc_open ON match_conflicts(status, detected_at);

CREATE TABLE audit_log (                     -- append-only (FR-OPS-005)
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL DEFAULT '{}', request_id TEXT);
CREATE INDEX al_at ON audit_log(at DESC);

CREATE TABLE idempotency_keys (              -- LLD-ERR
  user_id TEXT NOT NULL, key TEXT NOT NULL, route TEXT NOT NULL, request_hash TEXT NOT NULL,
  status_code INTEGER, response TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, key));

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- e.g. servers_version for CSP cache (TDD §6.1)

CREATE VIRTUAL TABLE search_fts USING fts5(     -- FR-CAT-004, FR-CAT-011, FR-CAT-012: one index, three kinds
  kind,                                        -- 'title' | 'person' | 'collection' (indexed, so it can be a column filter)
  entity_id UNINDEXED,                         -- media_items.id | people.id | collections.id
  name, alt_name,                              -- title or name; original title or the other names of a merged person or collection
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');  -- case/diacritic-insensitive, prefix
