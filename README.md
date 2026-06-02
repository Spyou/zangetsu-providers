# Zangetsu Providers

Community streaming sources for the **Zangetsu** app, maintained by **Spyou**.

Each source is a self-contained JavaScript provider that runs inside the app's
sandboxed runtime — it resolves its own playable streams (no host-side
extractors required).

## Add this repo to Zangetsu

In the app: **Settings → Sources → Add repo**, then paste the manifest URL:

```
https://raw.githubusercontent.com/Spyou/zangetsu-providers/main/index.json
```

Then install the sources you want from the list.

## Sources

| Source     | Type  | Notes                                              |
| ---------- | ----- | -------------------------------------------------- |
| 4K HDHub   | Movie | Movies + series, up to 2160p / HDR (direct files). |

## Manifest format

`index.json` lists every source:

```json
{
  "name": "Zangetsu Providers",
  "description": "...",
  "sources": [
    { "id": "fourkhdhub", "name": "4K HDHub", "version": "1.0.0",
      "type": "movie", "lang": "en", "file": "providers/fourkhdhub.js" }
  ]
}
```

`file` is resolved relative to the manifest's directory. `type` is `movie` or
`anime`.
