# Source: initial architecture concept (2026-10-04)

> **Status:** Historical source material. Not authoritative.
> **Provenance:** Provided by the project owner on 2026-10-04 as `idea.txt` together with the request to plan this repository. It appears to be an exported AI-assistant conversation. Citation markers of the form `:chatgpt-content-reference{...}` point to sources that were not included, so they cannot be followed. They are kept verbatim.
> **How it is used:** It is the origin of the user-provided direction recorded in [ROADMAP.md](../ROADMAP.md#3-constraints-assumptions-decisions-and-open-questions). External claims in it were re-checked against Cloudflare documentation on 2026-10-04 (see [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md)). Where this document and the canonical documents differ, the canonical documents win.

---

Yes. The clean architecture would be:

**Cloudflare = UI + catalog/index + auth/control plane**  
**Plex/Jellyfin/Emby servers = media origins + transcoding + actual video delivery**

The important distinction is whether “passes through streams” means the video bytes actually traverse a Cloudflare Worker.

Cloudflare Workers technically can stream arbitrarily large responses without buffering them; Workers' response bodies have no enforced size limit, and the Streams API is explicitly designed for multi-GB streaming. :chatgpt-content-reference{index="0"} However, Cloudflare's current policy specifically says its general CDN services historically prohibit using their bandwidth to deliver video unless you're using an appropriate video-delivery product/service. :chatgpt-content-reference{index="1"} So I would **not** architect it as:

`Viewer → Cloudflare Worker → Plex/Jellyfin → Worker → Viewer`

for sustained media traffic.

Instead:

```text
                         ┌─────────────────────┐
                         │ Cloudflare          │
                         │                     │
Viewer ─────────────────►│ Workers / Assets    │
                         │ Web frontend        │
                         │ Auth                │
                         │ Catalog API         │
                         │ D1 index            │
                         └──────────┬──────────┘
                                    │ API calls
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
          Jellyfin #1          Plex #1             Emby #1
          ───────────          ───────             ───────
          Movies A             Movies B            Movies C
          TV A                 TV B                TV C
                │                   │                   │
                └──────────── media streams ───────────┘
                                    │
                                    ▼
                                  Viewer
```

Your Cloudflare application would periodically query each server's API and normalize everything into one catalog. For example, D1 could contain a canonical record along the lines of:

```text
MediaItem
├── id
├── title
├── type
├── year
├── imdb_id / tmdb_id
├── metadata
├── artwork
└── Sources
    ├── Jellyfin / server-1 / item-8372
    ├── Plex / server-2 / ratingKey-1937
    └── Emby / server-3 / item-8291
```

That gives you something potentially more interesting than merely putting a different frontend on Jellyfin. You can create a **federated media library**.

If three servers all contain *Interstellar*, the frontend doesn't have to show three copies. It could show:

> **Interstellar (2014)**  
> 4K HDR · 1080p  
> Available from 3 servers

Then your backend can decide which source to use based on resolution, codec compatibility, server availability, latency, current load, whether transcoding would be necessary, and user permissions.

For the frontend/backend itself, Cloudflare fits extremely well. I'd probably use **Workers + Static Assets** for the application, **D1** for the normalized catalog/users/server relationships, and perhaps **KV** for inexpensive cacheable metadata. Static assets served by Workers are free/unlimited, while dynamic Worker invocations are billed normally. :chatgpt-content-reference{index="2"}

You also wouldn't need to store the media itself in R2.

### Streaming

There are two good approaches.

**Option A — direct streaming, which I'd recommend**

The browser asks your Worker:

```text
GET /api/play/8f271
```

Worker determines:

```text
User authorized: yes
Best source: Jellyfin #3
Item: 78219
Playback mode: direct play
```

It returns a short-lived signed playback URL:

```text
https://media3.example.net/stream/78219?token=...
```

Then:

```text
Browser ─────────────────────────► Jellyfin
        ◄────── 20 Mbps HEVC ─────
```

Cloudflare never touches those bytes.

This is extremely cheap to operate.

**Option B — your own media gateway**

If you don't want clients knowing where the Jellyfin/Plex/Emby servers are, put a small gateway somewhere else:

```text
                         Cloudflare
                      frontend + API
                            │
                            ▼
Viewer ───────────► Media Gateway
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
          Plex #1    Jellyfin #1   Emby #1
```

That gateway could be a cheap VPS or a geographically distributed set of gateways. Cloudflare still handles everything except the actual media payload.

There is also a hybrid where Cloudflare authenticates the playback request and then redirects the client to the selected origin. Workers are quite suitable for signed URLs and personalized request handling. Cloudflare itself documents signed URLs as one of the things Workers can do in front of origins. :chatgpt-content-reference{index="3"}

### The interesting part: make Plex/Jellyfin/Emby implementation details

I wouldn't expose the concept of Plex/Jellyfin/Emby to the frontend much at all.

Build a provider interface:

```text
MediaProvider
    authenticate()
    scanLibrary()
    getItem()
    getArtwork()
    getPlaybackInfo()
    getStreamURL()
    getSubtitleTracks()
    getAudioTracks()
    reportPlayback()
```

Then implement:

```text
JellyfinProvider
EmbyProvider
PlexProvider
```

Your frontend talks exclusively to **your API**.

That gives you:

```text
                    Your Media Platform
                           │
              ┌────────────┼────────────┐
              │            │            │
           Jellyfin       Emby         Plex
              │            │            │
          Server A      Server B     Server C
          Server D      Server E     Server F
```

And you can add other sources later without touching the client.

This could even support automatic source selection:

```text
User presses PLAY
       │
       ▼
Find all copies
       │
       ├─ Server A: 4K HEVC HDR, 62 Mbps
       ├─ Server B: 1080p H264, 12 Mbps
       └─ Server C: 4K AV1, 28 Mbps
       │
       ▼
Check device capabilities
       │
       ▼
Check server health/load
       │
       ▼
Select optimal source
       │
       ▼
Issue temporary playback authorization
       │
       ▼
Direct client to origin
```

You could also maintain server health information in Cloudflare. Durable Objects are particularly useful if you eventually need real-time state/coordination; Workers support WebSockets and Cloudflare specifically points to Durable Objects for coordinating connections/state. :chatgpt-content-reference{index="4"}

One issue you'll have to solve carefully is **browser reachability**. If these are random private Jellyfin servers sitting behind residential NAT, Cloudflare can't magically make the user's browser able to connect to them. You'd need each server exposed securely somehow—public HTTPS, Cloudflare Tunnel depending on your traffic arrangement, Tailscale-style networking, or your own lightweight connector/gateway.

But conceptually, yes: **a nearly entirely serverless Cloudflare-hosted "universal media frontend" with Plex, Emby, and Jellyfin acting as federated media origins is very feasible.** I'd specifically keep the heavy video bytes off Workers/Cloudflare and make Cloudflare responsible for everything up to the moment playback begins. That makes the Cloudflare portion extremely lightweight and inexpensive while still letting you present all of the servers as one unified library.