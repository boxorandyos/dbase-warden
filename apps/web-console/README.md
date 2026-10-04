# Web console

Operator GUI for Dbase Warden.

The shell follows the Warden family: top bar sections (Pulse, Estate, Operations, Fleet), sharp corners, uppercase nav tracking, and a split login. Color tokens use indigo as the primary accent and teal as the secondary accent so the product is distinct from Nginx Warden's cyan theme.

```bash
pnpm --filter @dbase-warden/web-console dev
```

Dev server: `http://localhost:8188`, with `/api` proxied to port `3101`.
