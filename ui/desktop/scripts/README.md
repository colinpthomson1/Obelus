# Obelus launcher

Put `obelus` in your `PATH` if you want to launch from a directory:

```
obelus .
```

This opens the Obelus desktop app from any path you specify.

# Unregister deep-link protocols (macOS only)

`unregister-deeplink-protocols.js` unregisters the `obelus://` deep-link protocol.
This is handy when testing deep links with a development build of Obelus.

# Usage

To unregister the deeplink protocols, run the following command in your terminal:
Then launch Obelus again so the current build registers itself on startup.

```bash
node scripts/unregister-deeplink-protocols.js
```
