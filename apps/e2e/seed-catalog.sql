-- TEMPORARY (until workstream A's sync lands): catalog rows written straight into local D1 so
-- browse, detail, search, people and collections have content. Applied by the journey right
-- after it registers the mock origin as "Mock Jellyfin" (see tests/journey.spec.ts). Once sync
-- indexes the mock origin's recorded Jellyfin library, delete this file and its call.
--
-- Shapes follow LLD-SCHEMA and apps/worker/test/catalog-seed.ts. The registered server is found
-- by name; a second server, "Seedbox", gives the first movie a second copy.

INSERT INTO servers (id, type, name, base_url, origin_server_id, priority, status, created_at, updated_at)
VALUES ('e2e-srv-seedbox', 'jellyfin', 'Seedbox', 'https://seedbox.example.test', 'origin-e2e-seedbox', 1, 'active', 1700000000000, 1700000000000);

INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled) VALUES
  ('e2e-lib-main', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-seed-main', 'Seeded Movies', 'movies', 1),
  ('e2e-lib-tv', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-seed-tv', 'Seeded Shows', 'tv', 1),
  ('e2e-lib-seedbox', 'e2e-srv-seedbox', 'e2e-seed-seedbox', 'Seedbox Movies', 'movies', 1);

INSERT INTO media_items (id, type, parent_id, title, sort_title, year, overview, genres, runtime_ms, season_number, episode_number, metadata_source_id, date_added, created_at, updated_at) VALUES
  ('m-night', 'movie', NULL, 'Night of the Living Dead', 'night of the living dead', 1968, 'A group of strangers barricade themselves in a farmhouse against the dead.', '["Horror","Thriller"]', 5760000, NULL, NULL, 'src-m-night-main', 1700000004000, 1700000000000, 1700000000000),
  ('m-friday', 'movie', NULL, 'His Girl Friday', 'his girl friday', 1940, 'A newspaper editor tries to win back his ex-wife.', '["Comedy"]', 5520000, NULL, NULL, 'src-m-friday-main', 1700000003000, 1700000000000, 1700000000000),
  ('m-plan9', 'movie', NULL, 'Plan 9 from Outer Space', 'plan 9 from outer space', 1957, 'Aliens resurrect the dead.', '["Horror","Sci-Fi"]', 4740000, NULL, NULL, 'src-m-plan9-main', 1700000002000, 1700000000000, 1700000000000),
  ('s-dragnet', 'series', NULL, 'Dragnet', 'dragnet', 1951, 'Police procedural.', '["Crime"]', NULL, NULL, NULL, 'src-s-dragnet-tv', 1700000001000, 1700000000000, 1700000000000),
  ('se-1', 'season', 's-dragnet', 'Season 1', 'season 1', 1951, NULL, '[]', NULL, 1, NULL, 'src-se-1-tv', 1700000001000, 1700000000000, 1700000000000),
  ('e-1', 'episode', 'se-1', 'Episode 1', 'episode 1', 1951, NULL, '[]', 1800000, 1, 1, 'src-e-1-tv', 1700000001000, 1700000000000, 1700000000000),
  ('e-2', 'episode', 'se-1', 'Episode 2', 'episode 2', 1951, NULL, '[]', 1800000, 1, 2, 'src-e-2-tv', 1700000001000, 1700000000000, 1700000000000),
  ('e-3', 'episode', 'se-1', 'Episode 3', 'episode 3', 1951, NULL, '[]', 1800000, 1, 3, 'src-e-3-tv', 1700000001000, 1700000000000, 1700000000000);

INSERT INTO sources (id, server_id, library_id, provider_item_id, media_item_id, item_type, title, match_method, artwork, content_hash, status, updated_at) VALUES
  ('src-m-night-main', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-lib-main', 'prov-m-night', 'm-night', 'movie', 'Night of the Living Dead', 'new', '{}', 'h', 'present', 1700000000000),
  ('src-m-night-seedbox', 'e2e-srv-seedbox', 'e2e-lib-seedbox', 'prov-m-night-sb', 'm-night', 'movie', 'Night of the Living Dead', 'new', '{}', 'h', 'present', 1700000000000),
  ('src-m-friday-main', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-lib-main', 'prov-m-friday', 'm-friday', 'movie', 'His Girl Friday', 'new', '{}', 'h', 'present', 1700000000000),
  ('src-m-plan9-main', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-lib-main', 'prov-m-plan9', 'm-plan9', 'movie', 'Plan 9 from Outer Space', 'new', '{}', 'h', 'present', 1700000000000),
  ('src-s-dragnet-tv', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-lib-tv', 'prov-s-dragnet', 's-dragnet', 'series', 'Dragnet', 'new', '{}', 'h', 'present', 1700000000000),
  ('src-se-1-tv', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-lib-tv', 'prov-se-1', 'se-1', 'season', 'Season 1', 'new', '{}', 'h', 'present', 1700000000000),
  ('src-e-1-tv', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-lib-tv', 'prov-e-1', 'e-1', 'episode', 'Episode 1', 'new', '{}', 'h', 'present', 1700000000000),
  ('src-e-2-tv', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-lib-tv', 'prov-e-2', 'e-2', 'episode', 'Episode 2', 'new', '{}', 'h', 'present', 1700000000000),
  ('src-e-3-tv', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'e2e-lib-tv', 'prov-e-3', 'e-3', 'episode', 'Episode 3', 'new', '{}', 'h', 'present', 1700000000000);

INSERT INTO item_availability (media_item_id, library_id) VALUES
  ('m-night', 'e2e-lib-main'), ('m-night', 'e2e-lib-seedbox'), ('m-friday', 'e2e-lib-main'),
  ('m-plan9', 'e2e-lib-main'), ('s-dragnet', 'e2e-lib-tv'), ('se-1', 'e2e-lib-tv'),
  ('e-1', 'e2e-lib-tv'), ('e-2', 'e2e-lib-tv'), ('e-3', 'e2e-lib-tv');

INSERT INTO media_versions (id, source_id, provider_version_id, video_codec, height, hdr) VALUES
  ('ver-night-main', 'src-m-night-main', 'pv-0', 'hevc', 2160, 'hdr10'),
  ('ver-night-seedbox', 'src-m-night-seedbox', 'pv-0', 'h264', 1080, 'none'),
  ('ver-friday-main', 'src-m-friday-main', 'pv-0', 'h264', 1080, 'none'),
  ('ver-plan9-main', 'src-m-plan9-main', 'pv-0', 'h264', 720, 'none');

INSERT INTO people (id, name, sort_name, name_key, metadata_link_id, created_at, updated_at)
VALUES ('p-jones', 'Duane Jones', 'duane jones', 'duane jones', 'plink-p-jones', 1700000000000, 1700000000000);
INSERT INTO person_provider_links (id, person_id, server_id, provider_person_id, name, artwork, match_method, updated_at)
VALUES ('plink-p-jones', 'p-jones', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'pp-p-jones', 'Duane Jones', '{}', 'new', 1700000000000);
INSERT INTO credits (source_id, link_id, role, person_id, media_item_id, character, sort_order)
VALUES ('src-m-night-main', 'plink-p-jones', 'actor', 'p-jones', 'm-night', 'Ben', 0);

INSERT INTO collections (id, name, sort_name, overview, metadata_link_id, created_at, updated_at)
VALUES ('c-horror', 'Classic Horror', 'classic horror', 'Creaky and beloved.', 'clink-c-horror', 1700000000000, 1700000000000);
INSERT INTO collection_provider_links (id, collection_id, server_id, provider_collection_id, name, artwork, match_method, updated_at)
VALUES ('clink-c-horror', 'c-horror', (SELECT id FROM servers WHERE name = 'Mock Jellyfin'), 'pc-c-horror', 'Classic Horror', '{}', 'new', 1700000000000);
INSERT INTO collection_members (link_id, source_id, media_item_id) VALUES
  ('clink-c-horror', 'src-m-night-main', 'm-night'), ('clink-c-horror', 'src-m-plan9-main', 'm-plan9');

INSERT INTO search_fts (kind, entity_id, name, alt_name) VALUES
  ('title', 'm-night', 'Night of the Living Dead', NULL),
  ('title', 'm-friday', 'His Girl Friday', NULL),
  ('title', 'm-plan9', 'Plan 9 from Outer Space', NULL),
  ('title', 's-dragnet', 'Dragnet', NULL),
  ('person', 'p-jones', 'Duane Jones', NULL),
  ('collection', 'c-horror', 'Classic Horror', NULL);
