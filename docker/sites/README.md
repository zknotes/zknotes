# Extra Caddy sites

The Caddyfile imports every `*.caddy` file in this directory. `setup.sh` writes `storage.caddy` here
when you choose the built-in object storage: it serves the storage on its own domain
(`STORAGE_DOMAIN`), because browsers upload to it directly. The generated files are not committed.

You can add a site of your own the same way; restart Caddy (`docker compose restart caddy`) after a
change.
