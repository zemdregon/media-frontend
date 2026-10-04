# Provider fixtures (T1.1 spike)

Recorded HTTP exchanges from real provider containers, captured on 2026-10-04 for the provider spike ([docs/spikes/2026-provider-spike.md](../../docs/spikes/2026-provider-spike.md)). They feed the adapter contract tests (T1.2).

| Folder | Server | Image |
|---|---|---|
| `jellyfin/` | Jellyfin Server 12.1.0 | `jellyfin/jellyfin:latest` |
| `emby/` | Emby Server 4.10.1.0 | `emby/embyserver:latest` |
| `plex/` | Plex Media Server 1.43.4.10903 (claimed to the owner's plex.tv account) | `plexinc/pms-docker:latest` |

## How they were captured

- The library is synthetic: ffmpeg test-pattern clips with NFO sidecars. There are three movies: *Night of the Living Dead (1968)* (H.264/AAC MKV), *His Girl Friday (1940)* (H.264/AAC MP4) and *Plan 9 from Outer Space (1957)* (HEVC/AAC MKV with a muxed SRT and a sidecar `.en.srt`). There is also one series, *Dragnet (1951)*, with episodes S01E01 to S01E03. Jellyfin and Emby read only the NFOs. Plex fetched online metadata through its agents, so its cast lists differ from the NFOs.
- Jellyfin and Emby requests were made as the **non-admin service account** `cinewren-svc`, which has all-library access. Requests named `sessiontoken_*` used a **per-session token**, minted with `DeviceId=cinewren-ps-<id>`. Requests named `admin_*` used the admin account and are included only where they show state. Plex requests used the owner's account token or a transient token from `/security/token?type=delegation&scope=all`. No non-admin Plex user existed.
- Each request was made with Python `urllib` with redirects disabled. The raw captures stayed in the spike scratch directory, and each fixture was produced from one raw capture by a sanitizer.

## Fixture format

```json
{
  "_capture": { "server": "...", "date": "2026-10-04", "spike": "docs/spikes/2026-provider-spike.md" },
  "request":  { "method": "GET", "path": "/path?query", "headers": { }, "body": null },
  "response": { "status": 200, "headers": { "Content-Type": "...", "Access-Control-...": "..." }, "body": { } }
}
```

`response.body` is the parsed JSON when the response was JSON. Otherwise it is the first 4000 characters of text, as with playlists and VTT. Binary bodies are truncated. Only the content-type, range, length, location and `Access-Control-*` response headers are kept. The body structure is unchanged.

## Redactions (placeholders)

| Placeholder | What it replaced |
|---|---|
| `<ADMIN_TOKEN>` | Jellyfin/Emby admin access token |
| `<SERVICE_TOKEN>` | Service-account token (`DeviceId=cinewren-svc-main`) |
| `<SESSION_TOKEN_A>`, `<SESSION_TOKEN_B>`, `<SESSION_TOKEN_PLAY>`, `<SESSION_TOKEN>` | Per-session tokens. The last is any other token found in a URL, header or JSON |
| `<PASSWORD>` | `Pw`, `Password`, `NewPw` and `CurrentPw` values |
| `<PLEX_TOKEN>`, `<PLEX_TRANSIENT_TOKEN>` | Plex account token and transient token |
| `<PLEX_MACHINE_ID>`, `<PLEX_ACCOUNT_USERNAME>`, `<PLEX_ACCOUNT_TITLE>`, `<PLEX_AVATAR_URL>` | The owner's server identifier and plex.tv identity |

Item, user, library and server IDs of the throwaway Jellyfin and Emby containers are kept as captured. They are not secrets.

## Jellyfin and Emby fixtures (the same names in both folders)

| File | Request | Shows |
|---|---|---|
| `system_info_public.json` | `GET /System/Info/Public` (no auth) | `Id`, `Version`, `ServerName` |
| `system_info_svc.json` | `GET /System/Info` (service token) | Full info for a non-admin |
| `auth_svc.json` | `POST /Users/AuthenticateByName` | `AccessToken`, `User.Policy.IsAdministrator=false`, `SessionInfo`, `ServerId` |
| `auth_session_A.json` | Same, with `DeviceId=cinewren-ps-sessionA` | Per-session token mint |
| `views.json` | Jellyfin: `GET /UserViews?userId=`; Emby: `GET /Users/{id}/Views` | Libraries (`CollectionType`) |
| `views_altpath.json` | The other provider's path | Jellyfin 12.1 still serves `/Users/{id}/Views`; Emby returns 404 for `/UserViews` |
| `items_page_movies_0_2.json`, `items_page_movies_2_2.json` | `GET /Items?ParentId=&Recursive=true&...&StartIndex=&Limit=` | Paging, `TotalRecordCount`, `ProviderIds`, `MediaSources`, `MediaStreams` |
| `items_tv_all.json` | Series, season and episode listing | Episode `IndexNumber`, `ParentIndexNumber`, `SeriesId` |
| `items_changed_since_MinDateLastSaved.json` | `...&MinDateLastSaved=<ISO-8601>` after one metadata edit | Incremental filter (1 item) |
| `items_changed_since_after_new_episode.json` | `MinDateLastSaved` after adding a file and rescanning | Jellyfin returns every item; Emby returns only the new episode |
| `item_detail_with_people.json` | Item detail with `Fields=People` | `People[]`: `Id`, `Name`, `Role`, `Type`, in billing order |
| `items_page_with_people_field.json` | `GET /Items?...&Fields=People,ProviderIds` | `People` is returned inline in list queries |
| `person_detail.json` | Person item | Person `ProviderIds`: empty on Jellyfin; `tmdb` and `imdb` (lowercase) on Emby |
| `boxsets.json`, `boxset_members.json` | `IncludeItemTypes=BoxSet`, then `ParentId=<boxset>` | Collections and members |
| `synthetic_items_library_movies_with_people.json` | Same request as `items_page_movies_0_2.json` | **Synthetic, not a recording.** The two recorded movie pages merged into one, with `People` grafted in from `items_page_with_people_field.json`. Used only by the E2E mock origin (`apps/e2e/mock-origin.mjs`) so one paged request returns every movie with credits |
| `playbackinfo_mp4_directplay.json` | `POST /Items/{id}/PlaybackInfo` with a DeviceProfile | Direct play. Emby returns `DirectStreamUrl`; Jellyfin does not |
| `playbackinfo_hevc_mkv_transcode.json` | Same, HEVC MKV with subtitles | `TranscodingUrl` (`master.m3u8`), subtitle `DeliveryUrl` (`Stream.vtt`) |
| `playbackinfo_h264_mkv.json` | Same, H.264 in MKV | HLS remux or transcode decision |
| `sessions_playing.json`, `sessions_playing_progress.json`, `sessions_playing_stopped.json` | `POST /Sessions/Playing[/Progress\|/Stopped]` (session token) | 204 responses |
| `admin_sessions_after_start.json` | `GET /Sessions` (admin) | `NowPlayingItem` and `PlayState` after the start report |
| `session_logout_A.json` | `POST /Sessions/Logout` (session token) | 204, revocation |
| `sessiontoken_list_views.json` | Views with a session token | A session token can browse (it is not stream-only) |
| `sessiontoken_admin_create_user.json`, `sessiontoken_self_escalate_policy.json` | Admin calls with a session token | 403 |
| `sessiontoken_admin_list_users.json` | `GET /Users` with a session token | Jellyfin 200 (lists every user name); Emby 403 |
| `sessiontoken_views_restricted.json` | Views after restricting the service account to Movies | Grant confinement when browsing |
| `admin_devices_list.json` | `GET /Devices` (admin) | Device entries left by per-session tokens |
| `cors_preflight_items.json` | `OPTIONS /Items` with `Origin` and `Access-Control-Request-*` | Preflight headers |
| `cors_direct_stream_range.json` | `GET /Videos/{id}/stream.mp4?static=true` with `Range: bytes=100-299` | 206, `Content-Range`, CORS |
| `cors_hls_master.json`, `cors_hls_media_playlist.json` | HLS master and media playlists | Token propagation into child URLs (Jellyfin: yes; Emby segments: `PlaySessionId` only) |

## Plex fixtures

| File | Request | Shows |
|---|---|---|
| `identity.json` | `GET /identity` (no auth) | `machineIdentifier`, `version`, `claimed` |
| `root.json`, `root_unauth.json` | `GET /` with and without a token | Server capabilities; 401 without a token |
| `library_sections.json` | `GET /library/sections` | Sections (`type` movie/show) |
| `items_page_movies_0_2.json`, `items_page_movies_2_2.json` | `GET /library/sections/1/all?includeGuids=1` with `X-Plex-Container-Start` and `X-Plex-Container-Size` | Paging (`offset`, `totalSize`), `Guid[]` (`imdb://`, `tmdb://`, `tvdb://`) |
| `items_tv_episodes.json` | `GET /library/sections/2/all?type=4` | Episodes |
| `metadata_p9.json`, `metadata_hgf.json` | `GET /library/metadata/{ratingKey}?includeGuids=1` | `Role[]`, `Director[]`, `Writer[]`, `Producer[]` (`id`, `tag`, `tagKey`, `role`), `Media[].Part[].Stream[]` |
| `collections.json`, `collection_children.json` | `GET /library/sections/1/collections`, `GET /library/collections/{key}/children` | Collection (no `Guid`), members |
| `security_token_delegation.json` | `GET /security/token?type=delegation&scope=all` | Transient token mint (minted from the owner token) |
| `transcode_decision_hevc.json` | `GET /video/:/transcode/universal/decision?...` | Decision codes, stream decisions |
| `cors_hls_master.json`, `cors_hls_media_playlist.json` | `start.m3u8`, then `session/<id>/base/index.m3u8` | Child URLs carry no token |
| `cors_preflight_api.json`, `cors_direct_part_range.json` | `OPTIONS`; part URL with `Range` | CORS (origin reflected), 206 |
| `timeline_playing_5000.json`, `timeline_stopped_6000.json`, `status_sessions_after_playing_5000.json` | `GET /:/timeline?state=...`, `GET /status/sessions` | Telemetry, and the session as the server sees it |
