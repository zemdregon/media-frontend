# Provider spike (T1.1): Jellyfin, Emby, Plex

| Field | Value |
|---|---|
| Status | **Complete for Jellyfin and Emby. Partial for Plex:** the non-admin token model is unverified, and so are Q-3 (terms) and the transient-token lifetime. |
| Date | 2026-10-04 |
| Method | Real containers on localhost with a synthetic library: Jellyfin Server **12.1.0** (`jellyfin/jellyfin:latest`), Emby Server **4.10.1.0** (`emby/embyserver:latest`) and Plex Media Server **1.43.4.10903** (`plexinc/pms-docker:latest`, claimed to the owner's plex.tv account by the orchestrator). Every result below comes from an observed HTTP exchange. |
| Roadmap | T1.1. Feeds ADR-0013, ADR-0008, Q-3, Q-6, IR-003 to IR-005, FR-PLAY-007, FR-PLAY-009, FR-SYNC-008 and LLD-PROV/LLD-TOKEN |
| Fixtures | [`test-fixtures/providers/`](../../test-fixtures/providers/README.md): 34 Jellyfin, 34 Emby and 20 Plex sanitized exchanges |

Secrets in this report are placeholders: `<ADMIN_TOKEN>`, `<SERVICE_TOKEN>`, `<SESSION_TOKEN>`, `<PASSWORD>`, `<PLEX_TOKEN>` and `<PLEX_TRANSIENT_TOKEN>`.

## 1. Setup

- **Media:** synthetic clips made with `/usr/lib/jellyfin-ffmpeg/ffmpeg`:
  - *Night of the Living Dead (1968)*: H.264/AAC MKV, 12 s.
  - *His Girl Friday (1940)*: H.264/AAC MP4 with faststart.
  - *Plan 9 from Outer Space (1957)*: HEVC/AAC MKV with a muxed SRT and a sidecar `.en.srt`.
  - *Dragnet (1951)*: Season 01, E01 to E03.

  NFOs carry the TMDB and IMDb IDs (TVDB for the series), cast with roles, and a `<set tmdbcolid="900001">` on two movies.
- **Jellyfin and Emby:**
  - The wizard ran over the API (`/Startup/Configuration`, `/Startup/User`, `/Startup/RemoteAccess`, `/Startup/Complete`) and created admin `spikeadmin`.
  - Service user `cinewren-svc` was created with `POST /Users/New`. Its policy was then set with `POST /Users/{id}/Policy`: `IsAdministrator=false`, `EnableAllFolders=true`, deletion off, remote control off.
  - Libraries were added with `POST /Library/VirtualFolders` (Movies at `/data/movies`, Shows at `/data/tv`), followed by `POST /Library/Refresh`.
- **Plex:** libraries were added with `POST /library/sections?type=movie|show&agent=tv.plex.agents.movie|series&location=/data/...`. The Plex agents also fetched online metadata.
- **Not done:** I created no managed or shared Plex user, because that would change the owner's real plex.tv account (Plex Home or friend sharing). That decision is the owner's, and §9 lists it as the next step.

## 2. Results by question and provider

Legend: **V** = Verified, **D** = Disproved (the assumption in the docs is wrong), **P** = Partial, **U** = Unverified.

| # | Question | Jellyfin 12.1.0 | Emby 4.10.1.0 | Plex 1.43.4 |
|---|---|---|---|---|
| 1a | Non-admin service account can authenticate by name | **V**: `POST /Users/AuthenticateByName` returns 200 with `AccessToken`, `User.Policy.IsAdministrator=false` and `SessionInfo` | **V**: same response shape | **U**: there was no non-admin user, and the owner token was used throughout |
| 1b | Auth header format | **V/D**: `Authorization: MediaBrowser Client="…", Device="…", DeviceId="…", Version="…"[, Token="…"]` works. `X-Emby-Authorization` returns **400** on auth. `X-Emby-Token`, `X-MediaBrowser-Token` and `?api_key=` return **401**. Only `?ApiKey=` works as a query carrier | **V**: `Authorization: MediaBrowser …`, `X-Emby-Authorization`, `X-Emby-Token`, `X-MediaBrowser-Token`, `?api_key=` and `?X-Emby-Token=` all work. **`?ApiKey=` returns 401.** The `/emby` path prefix is optional | **V**: `X-Plex-Token` header or query parameter |
| 1c | Token lifetime | **V**: no expiry field. Valid until logout, device delete or a re-auth on the same DeviceId. `InactiveSessionThreshold` = 0 (off) by default | **V**: no expiry field. Valid until logout or device delete | **U**: transient token. All transient tokens died on a server restart (**V**). The roughly 48 h lifetime is unverified |
| 2 | Per-session credential (ADR-0013) | **P**, see §3 | **V** with caveats, see §3 | **D** with the owner token, **U** with a non-admin user, see §3 |
| 3a | Library listing | **V**: `GET /UserViews?userId=` (the legacy `/Users/{id}/Views` and `/Users/{id}/Items` still return 200 on 12.1) | **V**: `GET /Users/{id}/Views` (`/UserViews` returns 404) | **V**: `GET /library/sections` |
| 3b | Paging | **V**: `StartIndex` and `Limit` with `TotalRecordCount` | **V**: same | **V**: `X-Plex-Container-Start` and `X-Plex-Container-Size`, as query or header; the response carries `offset` and `totalSize` |
| 3c | "Changed since" filter | **P**: `MinDateLastSaved=<ISO-8601 Z>` filters correctly (one edited item returns 1; a future date returns 0). **But every library scan re-saves every item**, so after any scan the filter returns everything. Unknown parameters such as `MinDateModified` are silently ignored | **V**: `MinDateLastSaved` is precise. A metadata edit returns 1, a new file returns only the new episode, and a no-change rescan returns 0 | **V**: `updatedAt>=<unix>` and `addedAt>=<unix>` filters are honoured (a future value returns 0) |
| 3d | External IDs | **V**: `ProviderIds.{Tmdb,Imdb,Tvdb}`, plus `ProviderIds.TmdbCollection` on movies that are in a set | **V**: `ProviderIds.{Tmdb,Imdb,Tvdb}` | **V**: `Guid[]` with `includeGuids=1`: `imdb://`, `tmdb://`, `tvdb://` |
| 4a | People | **V**: `People[]` (`Id`, `Name`, `Role`, `Type`, `PrimaryImageTag`) in billing order, returned **inline in `/Items` list queries** with `Fields=People`. Person `ProviderIds` are **absent**: empty in `People[]` and in the person item, even though the NFO had `<tmdbid>` for the actor | **V**: inline `People[]` in list queries. Person **detail** has `ProviderIds` with **lowercase** keys (`tmdb`, `imdb`) taken from the NFO, but `People[]` entries do not | **V**: `Role[]` (`id`, `tag`, `role`, `tagKey`, `thumb`), `Director[]`, `Writer[]`, `Producer[]`. `id` is server-local. `tagKey` (for example `5d77682e…`) is a plex.tv global person key, which could merge people across Plex servers. No TMDB or IMDb person IDs |
| 4b | Collections | **P**: BoxSets list (`IncludeItemTypes=BoxSet`) and members (`ParentId=`) work. The NFO `<set>` did **not** create a BoxSet (default library options). One created with `POST /Collections` has empty `ProviderIds` | **V**: a BoxSet was auto-created from the NFO `<set>` with `ProviderIds.Tmdb="900001"`. Members via `ParentId=` | **V**: `GET /library/sections/{id}/collections` and `/library/collections/{key}/children`. A collection has `guid: collection://<uuid>` and no external `Guid[]` |
| 5a | PlaybackInfo with a DeviceProfile | **V**: `POST /Items/{id}/PlaybackInfo?UserId=`. The MP4 gets `SupportsDirectPlay=true` but **no `DirectStreamUrl`**, so the adapter builds the URL. HEVC and MKV get a `TranscodingUrl` with `TranscodingSubProtocol=hls` | **V**: direct play returns `DirectStreamUrl=/videos/{id}/original.mp4?DeviceId=…&MediaSourceId=mediasource_{n}&PlaySessionId=…&api_key=<SESSION_TOKEN>`. HEVC gets a `TranscodingUrl` (`master.m3u8`) | **V**: `GET /video/:/transcode/universal/decision?path=/library/metadata/{key}&protocol=hls&…` returns decision codes (1001 and so on). `start.m3u8` works. The direct part URL is `/library/parts/{id}/{ts}/file.ext` |
| 5b | HLS URL and token propagation | **V**: the master's child `main.m3u8` and its segment URLs **carry `ApiKey=`**, so revocation stops the stream | **P**: the child playlist carries `api_key`, but **segments carry only `PlaySessionId`** and are fetchable without a token until the transcode stops | **P**: `start.m3u8` needs the token, but `session/<id>/base/index.m3u8` and its segments **carry no token** and return 200 anonymously |
| 5c | Subtitles as WebVTT | **V**: `DeliveryUrl=/Videos/{id}/{msId}/Subtitles/{idx}/0/Stream.vtt?ApiKey=…` returns `text/vtt`, for both embedded and sidecar. **Served without auth** | **V**: the same pattern with `api_key`, returning `text/vtt`. **Served without auth** | **P**: a sidecar via `/library/streams/{id}` returns **raw SRT** (with `Content-Type: text/html`). An embedded stream returns **501**. WebVTT over HLS was not achieved: the decision gave `ass` in `segments-subs` |
| 5d | Range requests on direct streams | **V**: `Range: bytes=100-299` returns 206 with `Content-Range` and `Accept-Ranges: bytes`. A suffix range also works | **V**: same | **V**: the part URL returns 206 with `Content-Range: bytes 100-299/209804` |
| 6 | CORS (`Origin: https://cinewren.example`) | **V**: `Access-Control-Allow-Origin: *` on API, stream, HLS, segment, VTT and image responses. Preflight returns 204 with the requested method and headers (`authorization`, `range`). Configurable through `CorsHosts` (default `["*"]`) | **V**: **reflects the origin** with `Allow-Credentials: true` on every response type. Preflight returns 200 with a broad `Allow-Headers` list | **V**: reflects the origin on API, part, HLS and segments. Preflight returns 200 with `Allow-Headers: x-plex-token` and `Max-Age 1209600` |
| 7 | Session telemetry | **V**: `POST /Sessions/Playing`, `/Progress` and `/Stopped` each return 204 with the session token. `/Sessions` shows `NowPlayingItem` and `PositionTicks`. `Stopped` ends the transcode. **Side effect:** the service user's `Played` and `PlayCount` on the origin are updated | **V**: same, including the side effect | **V**: `GET /:/timeline?ratingKey=&key=&state=playing\|stopped&time=&duration=` returns 200, and `/status/sessions` reflects it. `/video/:/transcode/universal/stop?session=` returns 200 |
| 8 | Identity and version | **V**: `GET /System/Info/Public` (no auth) returns `Id`, `Version: "12.1.0"`, `ProductName`, `StartupWizardCompleted` | **V**: same path, `Version: "4.10.1.0"`, `ProductName: null` | **V**: `GET /identity` (no auth) returns `machineIdentifier`, `version`, `claimed` |
| 9 | Admin detection (ADR-0008 "where detectable") | **V**: `User.Policy.IsAdministrator` in the auth response | **V**: same | **U** |

## 3. ADR-0013 exit criteria: explicit verdicts

Test procedure (`adr13.py`, run against each provider):
1. Authenticate the service account with `DeviceId=cinewren-svc-main`.
2. Mint session tokens A and B with `DeviceId=cinewren-ps-sessionA` and `cinewren-ps-sessionB`.
3. Use each token in stream and HLS URLs.
4. Run 19 representative admin and non-admin calls with token A.
5. Revoke A with `POST /Sessions/Logout`, and revoke B by deleting its device as admin. Re-test the stream, HLS and API.
6. Mint 30 more tokens, then log them all out.

### Jellyfin 12.1.0

| Criterion | Verdict | Evidence |
|---|---|---|
| 1. Minted by the service account without human interaction | **Yes** | `POST /Users/AuthenticateByName` with `Authorization: MediaBrowser Client="Cinewren", Device="Cinewren Playback", DeviceId="cinewren-ps-sessionA", Version="0.0.1"` and body `{"Username":"cinewren-svc","Pw":"<PASSWORD>"}` returns 200 with a fresh `AccessToken` that differs from the service token. Each mint costs about 190 ms (password hashing): 30 mints took 5.7 s. **Re-auth on the same DeviceId invalidates the previous token** (A returned 401 after the re-auth), so the DeviceId must be unique per session. |
| 2. Cannot perform admin actions | **Yes (admin), but it is not stream-only** | With token A, these return 403: `POST /Users/New`, `POST /System/Configuration`, `GET /Library/VirtualFolders`, `POST /Library/Refresh`, `GET /Devices`, `DELETE /Devices`, `GET /Auth/Keys`, `POST /Users/{admin}/Policy`, `POST /Users/{self}/Policy` with `IsAdministrator:true`, `GET /ScheduledTasks`, `GET /Users/{admin}/Items`, and a password change with the wrong current password. `DELETE /Items/{id}` returns 401. **Allowed (non-admin user scope):** `GET /UserViews`, `GET /Items`, `GET /Users` (lists all user names, admin included), `GET /System/Configuration` (a sanitized subset), `GET /Sessions` (the service user's own sessions) and `POST /UserFavoriteItems/{id}` (writes the service user's data). **Library grants are enforced on browsing only:** with the service account restricted to Movies, episode detail and PlaybackInfo return 404, but `master.m3u8` for that episode returns **200**. |
| 3. Revocable, or expires; the stream URL stops working | **Partial** | **HLS and API: yes.** After `POST /Sessions/Logout` with token A (204), `GET /System/Info` returns 401, a new `master.m3u8` returns 401, and re-fetching the already-issued `main.m3u8` and segment URLs returns **401 and 401**. An admin `DELETE /Devices?id=cinewren-ps-sessionB` (204) has the same effect on B. The service token and the other session tokens are unaffected. **Direct play: not applicable.** `GET /Videos/{id}/stream?static=true&MediaSourceId=…` returns **206 with no token, with a garbage token, and with revoked tokens** (a full GET with no token returned all 9,729,927 bytes). Jellyfin 12.1 does not authenticate direct static streams, so there is no credential to revoke. VTT subtitles and images are also served without auth. There is no expiry. |
| 4. No operational problems from minting many tokens | **Yes** | 30 mints created 30 device entries. `POST /Sessions/Logout` **removes the device entry** (32 entries before the logouts, 2 after). There was no rate limiting, licence limit or error. Each mint adds about 190 ms (NFR-PERF-002). |

**Jellyfin verdict:** the mechanism in ADR-0013 works as written for API and **HLS** playback, so the ADR can be **accepted with an amendment**. The amendment: on Jellyfin 12.1, direct-play (progressive) URLs are unauthenticated at the origin, so for that mode FR-PLAY-007 is met only nominally. A leaked direct URL gives access to that one file with no expiry. Options, for the orchestrator or owner to choose:
- (a) For Jellyfin, prefer the HLS remux path (`EnableDirectPlay=false`, with `AllowVideoStreamCopy` and `AllowAudioStreamCopy`) so that every byte request is token-gated. This costs a little origin CPU.
- (b) Accept the residual risk for direct play and record it in ADR-0013.
- (c) Report it upstream.

The session token carries the service account's whole **non-admin user scope** (browse and user-data writes), not stream-only rights.

### Emby 4.10.1.0

| Criterion | Verdict | Evidence |
|---|---|---|
| 1. Minted without human interaction | **Yes** | The same request (with the `Authorization: MediaBrowser …` header, or `X-Emby-Authorization`) returns a distinct `AccessToken`. **Re-auth on the same DeviceId returns the same token** (idempotent), so the DeviceId must be unique per concurrent session. After a logout, re-auth on that DeviceId gives a new token, and the old one returns 401. A mint takes about 3 ms (30 in 0.09 s). |
| 2. Cannot perform admin actions | **Yes (admin), but it is not stream-only** | With token A, these return 403: `GET /Users`, `POST /Users/New`, `POST /System/Configuration`, `POST /Library/Refresh`, `GET /Devices`, `DELETE /Devices`, `GET /Auth/Keys`, policy changes for others and for self, `DELETE /Items/{id}`, `GET /ScheduledTasks`, and a password change with the wrong current password. **Allowed:** views, items, `GET /Library/VirtualFolders` (**exposes library paths**), `GET /System/Configuration`, `GET /Sessions` (own), and favourite writes. **Grants are enforced on browsing only:** with the service account restricted to Movies, the episode's `/Users/{id}/Items/{ep}`, its PlaybackInfo, its direct stream and its HLS all return **200 or 206**. |
| 3. Revocable; the stream URL stops working | **Yes, with a caveat** | After `POST /Sessions/Logout` (204), the direct stream `…/stream?static=true&api_key=<A>` returns **401**, as do the API, a new `master.m3u8`, and a re-fetch of the issued child playlist. An admin `DELETE /Devices?Id=cinewren-ps-sessionB` (204) also makes B's stream return 401. A stream with no token returns 401. **Caveat:** HLS **segment** URLs (`hls1/main/0.ts?PlaySessionId=…`) still return 200 after revocation while that transcode is alive. Stopping playback (`/Sessions/Playing/Stopped`) ends the transcode. VTT subtitles are served without auth. There is no expiry. |
| 4. No operational problems from minting many tokens | **No: the device list grows** | `POST /Sessions/Logout` **does not remove the device entry** (34 entries after minting 30 and logging all out). Removal needs admin `DELETE /Devices`, which the service account gets 403 for. **Mitigation verified:** a bounded pool of DeviceIds (`cinewren-ps-00…NN`, at least as many as peak concurrent sessions) can be reused, because re-auth on a DeviceId that has been logged out mints a new token. There were no rate limits or licence errors on the free server. |

**Emby verdict:** this provider meets ADR-0013 most closely. Direct, HLS-playlist and API access are all token-gated and revoked by logout. **Accept with amendments:**
- Use a DeviceId pool instead of one DeviceId per session ID, to bound device growth.
- Revocation does not cut HLS segments of a live transcode until the stop is reported.
- The token carries the non-admin user scope, including library paths.

### Plex 1.43.4

| Criterion | Verdict | Evidence |
|---|---|---|
| 1. Minted without human interaction | **Yes (from the owner token); unverified from a non-admin token** | `GET /security/token?type=delegation&scope=all` with `X-Plex-Token: <PLEX_TOKEN>` returns 200 with `{"MediaContainer":{"size":0,"token":"<PLEX_TRANSIENT_TOKEN>"}}` (46 characters, distinct per mint, about 3 ms). `type=delegation` with no scope, `scope=playback` or `scope=foo`, and `type=transient`, all return **400**. **Every new `X-Plex-Client-Identifier` registers a device** (30 more), so mints must use one stable client ID. |
| 2. Cannot perform admin actions | **No (from the owner token); unverified from a shared or managed user** | With the transient token, these return 200: `GET /:/prefs`, **`PUT /:/prefs?logDebug=0`**, `GET /accounts`, `GET /library/sections/1/refresh`, `GET /butler`, `GET /devices` and `GET /status/sessions`. Only minting another transient token was refused (**403**). So a transient token inherits the owner's rights. The delete probes were uninformative: they return 404 even without auth. |
| 3. Revocable; the stream URL stops working | **Partial** | No per-token revoke endpoint was found. A `docker restart` **invalidated all transient tokens** (part URL 206 before, 401 after; the account token still returned 206). The documented lifetime of about 48 h is unverified. HLS child playlists and segments are served **without a token** by session path until `/video/:/transcode/universal/stop`. |
| 4. Operational problems | **Device growth from client IDs, otherwise unverified** | Use a fixed `X-Plex-Client-Identifier` for minting. Plex Pass, shared-user limits and the remote-relay behaviour are untested. |

**Plex verdict:** the exit criteria are **not met** with the only token available (the owner's). The transient token is not admin-restricted. **ADR-0013 must stay open for Plex** until a non-admin model is tested, or Plex takes a fallback:
- the server-access token of a **shared or managed user**, with a transient token minted from it;
- otherwise, the ADR-0013 fallback (1), a restricted playback account with rotation, or (2), a gateway.

Q-3 (Plex API terms for third-party clients) was **not** examined. It needs a terms review, not a container.

### Summary

| Exit criterion | Jellyfin 12.1 | Emby 4.10.1 | Plex 1.43.4 |
|---|---|---|---|
| 1 Mint without interaction | Yes | Yes | Yes (owner token); non-admin unverified |
| 2 No admin actions | Yes (non-admin user scope; browse allowed) | Yes (non-admin user scope; library paths readable) | **No** from the owner token; non-admin unverified |
| 3 Revocable, stream stops | **Partial**: HLS and API yes; direct play is unauthenticated | Yes; HLS segments of a live transcode survive until stop | Partial: restart only; segments anonymous |
| 4 No operational problems | Yes (logout removes the device) | **Device list grows**; DeviceId pool mitigates | Device per client ID; the rest unverified |
| Recommended ADR-0013 outcome | Accept with a direct-play amendment | Accept with a DeviceId-pool amendment | Keep open; decide after the shared-user test (B-2/Q-3) |

## 4. Exact request and response samples (abridged)

Full exchanges are in the fixtures.

```http
POST /Users/AuthenticateByName HTTP/1.1            (Jellyfin and Emby)
Authorization: MediaBrowser Client="Cinewren", Device="Cinewren Playback", DeviceId="cinewren-ps-sessionA", Version="0.0.1"
Content-Type: application/json

{"Username":"cinewren-svc","Pw":"<PASSWORD>"}
→ 200 {"User":{"Id":"…","Policy":{"IsAdministrator":false,"EnableAllFolders":true,…}},
       "SessionInfo":{"DeviceId":"cinewren-ps-sessionA","Client":"Cinewren",…},
       "AccessToken":"<SESSION_TOKEN_A>","ServerId":"…"}
```

```http
GET /System/Info HTTP/1.1                          (Jellyfin 12.1: token carriers)
X-Emby-Token: <ADMIN_TOKEN>                        → 401
X-MediaBrowser-Token: <ADMIN_TOKEN>                → 401
X-Emby-Authorization: MediaBrowser …, Token="…"    → 401
Authorization: MediaBrowser Token="<ADMIN_TOKEN>"  → 200
GET /System/Info?api_key=<ADMIN_TOKEN>             → 401
GET /System/Info?ApiKey=<ADMIN_TOKEN>              → 200
(Emby 4.10.1: every carrier above → 200 except ?ApiKey= → 401)
```

```http
GET /Videos/{id}/stream?static=true&MediaSourceId={ms}     (no token at all)
Jellyfin → 200 / 206, Content-Type: video/x-matroska, Accept-Ranges: bytes
Emby     → 401

POST /Sessions/Logout   Authorization: MediaBrowser Token="<SESSION_TOKEN_A>"  → 204
then  Jellyfin: GET …/main.m3u8?…&ApiKey=<SESSION_TOKEN_A> → 401; …/hls1/main/0.ts?…&ApiKey=… → 401
      Emby:     GET …/stream?static=true&api_key=<SESSION_TOKEN_A> → 401; …/hls1/main/0.ts?PlaySessionId=… → 200
```

```http
POST /Items/{id}/PlaybackInfo?UserId={uid}   Authorization: MediaBrowser Token="<SESSION_TOKEN_PLAY>"
{"UserId":"…","DeviceProfile":{"DirectPlayProfiles":[{"Container":"mp4,m4v","Type":"Video","VideoCodec":"h264","AudioCodec":"aac,mp3"}],
 "TranscodingProfiles":[{"Container":"ts","Type":"Video","VideoCodec":"h264","AudioCodec":"aac","Context":"Streaming","Protocol":"hls"}],
 "SubtitleProfiles":[{"Format":"vtt","Method":"External"},{"Format":"vtt","Method":"Hls"}]},
 "EnableDirectPlay":true,"EnableDirectStream":true,"EnableTranscoding":true,"AutoOpenLiveStream":false}
→ HEVC MKV: "SupportsDirectPlay":false,"TranscodingSubProtocol":"hls",
  "TranscodingUrl":"/videos/{id}/master.m3u8?DeviceId=cinewren-ps-play1&MediaSourceId=…&PlaySessionId=…&ApiKey=<SESSION_TOKEN_PLAY>&…"   (Emby: api_key=)
  subtitle stream: "DeliveryMethod":"External","DeliveryUrl":"/Videos/{id}/{msId}/Subtitles/3/0/Stream.vtt?ApiKey=<SESSION_TOKEN_PLAY>"
```

```http
OPTIONS /Items?…   Origin: https://cinewren.example   Access-Control-Request-Method: GET   Access-Control-Request-Headers: authorization
Jellyfin → 204  Access-Control-Allow-Origin: *  Access-Control-Allow-Headers: authorization  Access-Control-Allow-Methods: GET
Emby     → 200  Access-Control-Allow-Origin: https://cinewren.example  Access-Control-Allow-Credentials: true  Allow-Headers: Accept, …, Authorization, …, Range, …, X-Emby-Token, …
Plex     → 200  Access-Control-Allow-Origin: https://cinewren.example  Access-Control-Allow-Headers: x-plex-token  Access-Control-Max-Age: 1209600
```

```http
GET /security/token?type=delegation&scope=all   X-Plex-Token: <PLEX_TOKEN>    → 200 {"MediaContainer":{"size":0,"token":"<PLEX_TRANSIENT_TOKEN>"}}
PUT /:/prefs?logDebug=0                          X-Plex-Token: <PLEX_TRANSIENT_TOKEN> → 200   (admin write accepted)
GET /security/token?type=delegation&scope=all   X-Plex-Token: <PLEX_TRANSIENT_TOKEN> → 403
docker restart → GET /library/parts/…/file.mp4?X-Plex-Token=<PLEX_TRANSIENT_TOKEN> → 401
```

## 5. Other findings

- **Plex `allowedNetworks`:** with `allowedNetworks=172.16.0.0/255.240.0.0` set, unauthenticated requests from that range got **full access**, including `/:/prefs` (200) and part URLs (206). Minting a transient token without a token still returned 400. The setting was reverted afterwards (no token → 401). Operators must never list the internet-facing proxy's network there. The setup guide should say so.
- **Plex `/status/sessions`** exposes `Session.id = "token=<PLEX_TRANSIENT_TOKEN>"` to whoever can read sessions.
- **Telemetry writes play state for the service user on the origin.** Jellyfin and Emby both set `Played` and `PlayCount` for `cinewren-svc`. This is not Cinewren's DEF-4 write-back, but the origin's own view of the service account accumulates watched state from every viewer. Harmless, but worth documenting.
- **ID formats:** Jellyfin uses 32-hex GUIDs (`TranscodingUrl` uses the dashed form `/videos/25900aea-80a2-…/`). Emby uses short numeric strings (`"10"`) and `MediaSourceId="mediasource_10"`. Plex uses numeric `ratingKey`s. Adapters must treat all IDs as opaque strings.
- **Emby `ProviderIds` key casing differs:** items use `Tmdb` and `Imdb`, persons use `tmdb` and `imdb`. Parse case-insensitively.
- **Unknown query parameters are silently ignored** (for example Jellyfin's `MinDateModified`). Contract tests should prove a filter is applied by checking that a future date returns 0, as this spike did.
- **Artwork:** Jellyfin serves `/Items/{id}/Images/Primary` without auth (200). Emby returned 500 for the generated item, which had no image, so that result is inconclusive.

## 6. Recommended version minimums

Only the current releases were available, and they show breaking differences (for example, the Jellyfin token carriers), so the minimums are set to **what was verified**:

| Requirement | Was *(proposed)* | Recommendation | Reason |
|---|---|---|---|
| IR-003 Jellyfin | 10.10 | **12.1** (verified). Allow older versions only after a follow-up spike against 10.10 or 10.11 | 12.1 rejects `X-Emby-Token`, `X-Emby-Authorization` and `api_key=`. An adapter written for 12.1 uses `Authorization: MediaBrowser Token=` and `ApiKey=`. Whether older versions accept `ApiKey=` was not tested. |
| IR-004 Emby | 4.8 | **4.10** (verified) | 4.10.1.0 was tested. `ApiKey=` is rejected, so use `api_key=` or the header. |
| IR-005 Plex | n/a | **1.43** (1.43.4.10903 verified) | The token-model work is still open. Revisit with B-2. |

The `validate()` version check should parse `Version` from `/System/Info/Public` (Jellyfin and Emby; Emby uses the four-part `4.10.1.0`) and from `/identity` `version` (Plex, `1.43.4.10903-e5521bd8c`).

## 7. Doc changes needed (for the orchestrator)

**ADR-0013**
- Status: Accepted for Jellyfin and Emby, with the per-provider results table from §3.
  - Jellyfin amendment: direct-play URLs are unauthenticated at the origin. Choose between "prefer HLS remux" and "accept the residual risk".
  - Emby amendment: use a DeviceId pool, because logout leaves device entries and the service account cannot delete devices. HLS segments of a live transcode survive revocation until the stop is reported.
- Plex remains Proposed or open, pending the shared-user test (or a superseding fallback ADR).
- Correct the Consequences line "leak of a stream URL exposes only one session's stream, for a bounded time". It is false for Jellyfin direct play and for Plex and Emby HLS segments.
- Add that the session token carries the service account's non-admin **user** scope (browse and user-data writes), and that library grants are **not** enforced by the origin on stream or PlaybackInfo endpoints.

**ADR-0008**
- "Admin credentials are rejected where detectable (to verify in M1 spike)" becomes: detectable on Jellyfin and Emby via `User.Policy.IsAdministrator` in the `AuthenticateByName` response. Plex is unverified.
- The service credential for Jellyfin and Emby is **username and password** (re-auth mints tokens), not an API key. This settles the add-server form question (ROADMAP conflict row, UX §8 a and h).

**SRS**
- IR-003 → 12.1, IR-004 → 4.10, IR-005 → 1.43 (§6).
- FR-PLAY-007: add the Jellyfin direct-play exception, or require the HLS-only mode for Jellyfin (owner decision). Note that "cannot authorize administrative actions" holds for Jellyfin and Emby.
- FR-PLAY-009 is confirmed as written for all three providers.
- FR-SYNC-008 is confirmed. Add a note that person external IDs are absent on Jellyfin and Plex.

**LLD-PROV per-provider table**
- *Service auth:* use `Authorization: MediaBrowser Client=…, Device=…, DeviceId=…, Version=…[, Token=…]` for **both** Jellyfin and Emby (`X-Emby-Authorization` fails on Jellyfin 12.1). Drop "header `X-Emby-Authorization` / `X-Emby-Token`" as the Emby requirement: it works, but it is not needed.
- *Stream URL:* the Jellyfin example `…&api_key=<session token>` is **wrong** for 12.1. Use **`ApiKey=`**. Emby keeps **`api_key=`** (`ApiKey` returns 401 on Emby). Emby's PlaybackInfo returns `DirectStreamUrl` (`/videos/{id}/original.{ext}?…`). Jellyfin's does not, so the adapter builds `/Videos/{id}/stream?static=true&MediaSourceId=…`.
- *Text subtitles:* the path is `/Videos/{id}/{msId}/Subtitles/{idx}/**0**/Stream.vtt` (the LLD omits the `/0/` segment). Prefer the `DeliveryUrl` returned by PlaybackInfo with `SubtitleProfiles: [{Format:"vtt",Method:"External"}]`. Plex: the sidecar arrives as raw SRT from `/library/streams/{id}`, and embedded tracks are not extractable that way. Use Worker-side SRT→VTT conversion (TDD §11.3 allows subtitles through the Worker), or more spike work on Plex HLS WebVTT.
- *Paged items / incremental:* the parameter name is confirmed as **`MinDateLastSaved`** (ISO 8601 UTC) on Jellyfin and Emby. Jellyfin re-saves all items on every scan, so incremental is correct but not minimal. Plex `updatedAt>=` and `addedAt>=` are confirmed. There are no tombstones on any provider, so the full listing stays the only way to detect missing items (LLD-SYNC already says this).
- *Libraries:* Jellyfin `/UserViews?userId=` is confirmed, and Emby `/Users/{id}/Views` is confirmed (`/UserViews` returns 404 on Emby). The `/emby` prefix is not needed.
- *People:* `Fields=People` works inline in `/Items` list queries, so no per-item call is needed. Person `ProviderIds`: Jellyfin has none; Emby has them only on the person item (lowercase keys); Plex has none, but `tagKey` is a candidate global key across Plex servers (relevant to ADR-0015).
- *Collections:* Jellyfin does not auto-create BoxSets from NFO `<set>` with default options, and an API-created BoxSet has no `ProviderIds`. Movies carry `ProviderIds.TmdbCollection`, a fallback merge key. Emby BoxSets carry `ProviderIds.Tmdb`. Plex collections have no external GUID (`collection://<uuid>`). The members endpoints are confirmed.
- *Session credential:* Jellyfin's "re-authenticate with `DeviceId=cinewren-ps-<sessionId>`, revoke with `POST /Sessions/Logout`" is confirmed. Note that re-auth on the same DeviceId kills the previous token. For Emby, use a DeviceId pool. For Plex, `/security/token?type=delegation&scope=all` exists but inherits the minting account's rights, and no other scope value is accepted.
- *CORS row:* resolved, per §2 row 6.
- *Range:* confirmed on all three, with the token in the query string.
- *Telemetry:* confirmed. Note the origin-side played-state side effect on the service account.

**LLD-TOKEN**
- The playback lifecycle holds. Add:
  - Jellyfin per-play mint latency (about 190 ms).
  - The Emby DeviceId pool and its lease.
  - Revocation does not stop Plex or Emby HLS segments until the transcode stops, so `reportPlayback(stop)` must run before or with the revoke.
- The `shared_restricted` fallback is likely for Plex.

**HLD, TDD, ADR-0003 and ROADMAP**
- HLD §CORS and range rows, TDD §11.3 and the ADR-0003 CORS note: default CORS works on all three, with no reverse-proxy change needed. Jellyfin uses `*`; Emby and Plex reflect the origin. The setup guide only needs to mention `CorsHosts` for operators who have narrowed it.
- ROADMAP risks: R-3 is retired for default configs. R-1 is realised for Plex (pending the non-admin test) and partially for Jellyfin direct play. Add a risk for Jellyfin's unauthenticated direct streams.
- FRD lines 90, 160 and 578 ("(to verify in M1 spike)"): resolved for Jellyfin and Emby by this report. Plex carries into M4.

## 8. Reproduction

The scripts are in the spike scratch directory (`h.py`, `setup.py`, `setup2.py`, `adr13.py`, `confine.py`, `capture.py`, `plex1.py` to `plex3.py`, `sanitize.py`), with the media under `scratchpad/spike/media/`. The containers run with `-p 127.0.0.1:8096:8096` (Jellyfin) and `-p 127.0.0.1:8097:8096` (Emby), each with `-v media:/data:ro`.

## 9. Still unverified

1. **Plex non-admin model (Q-3, B-2):**
   - Create a managed (Plex Home) or shared user on the owner's account.
   - Obtain that user's server access token (`plex.tv` resources API).
   - Check that it is library-scoped and non-admin.
   - Mint a transient token from it and repeat the §3 tests.
2. **Plex API terms for third-party clients (Q-3):** this needs a reading of the terms, not testing.
3. The Plex transient-token lifetime (about 48 h, as documented).
4. Plex WebVTT subtitle delivery over HLS.
5. Plex licence and Plex Pass effects.
6. Older Jellyfin (10.10 or 10.11) and Emby (4.8 or 4.9) versions: auth carriers, and whether `ApiKey=` or `api_key=` is accepted.
7. Person external IDs on Jellyfin when online TMDB metadata is enabled (this spike ran offline from NFOs only).
8. Whether Jellyfin's unauthenticated direct stream is configurable, or depends on the version.
