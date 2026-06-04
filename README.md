# zangetsu-providers

Default source repo for the [Zangetsu](https://github.com/Spyou/Zangetsu) app. Each `.js` file is a self-contained scraper for one streaming site (anime or movie/series) that the app installs at runtime — no app update required.

## How users install sources

Zangetsu uses a **manifest** model — one URL gives you the whole repo's worth of sources:

1. Open the app
2. **Settings → Sources → Add repo**
3. Paste the manifest URL:
   ```
   https://raw.githubusercontent.com/Spyou/zangetsu-providers/main/index.json
   ```
4. The repo appears with every source listed
5. Tap **Install** next to the ones you want

One manifest = many sources. This default repo is added on first launch, so users get every source here without doing anything.

> Don't paste the URL of a single `.js` file. That's one source, not a repo. The manifest URL ends in `index.json`.

## Sources

| Source | Type | Notes |
| --- | --- | --- |
| AllAnime | Anime | Large catalog, sub and dub. |
| HiAnime | Anime | Sub and dub, multiple subtitle languages. |
| 4K HDHub | Movie / Series | Movies and series up to 2160p / HDR. |
| UHD Movies | Movie / Series | Movies and series, high-bitrate releases. |
| HDHub4u | Movie / Series | Movies and series, Bollywood and Hollywood. |

Availability depends on each site staying up; sources are updated as sites change.

## The manifest

`index.json` at the root lists every source:

```json
{
  "name": "Zangetsu Providers",
  "description": "Streaming sources for the Zangetsu app.",
  "sources": [
    {
      "id": "allanime",
      "name": "AllAnime",
      "version": "1.0.0",
      "type": "anime",
      "lang": "en",
      "file": "providers/allanime.js",
      "nsfw": false
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable lowercase id. Don't rename after release. |
| `name` | yes | Display name shown in the app. |
| `version` | yes | Bump on every change so users see an update. |
| `type` | yes | `anime` or `movie`. |
| `lang` | yes | Language code (`en`, `hi`, ...). |
| `file` | yes | Path to the `.js` from the manifest's directory. |
| `logo` | no | Square icon URL. |
| `nsfw` | no | Defaults to `false`. |

## Hosting your own repo

You don't have to use this one. Anyone can fork it or build their own:

1. Make a new GitHub repo, or use any host that serves raw files
2. Add your `.js` source files
3. Add an `index.json` that lists them
4. Share the manifest URL — users add it under **Settings → Sources → Add repo**

Multiple repos coexist in the app. This repo is added on first launch; others are user-added.

## Updating a source

When a source changes, bump its `version` in both the `.js` file and its `index.json` entry. Installed users will see an update in the app, which pulls the new file without a restart.

## License

These sources respect each site's robots.txt and rate limits. The code is MIT.
