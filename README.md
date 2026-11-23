# vesta-api

Backend of **Vesta Security**: Express + firebase-admin. It manages child profiles and
linking, privacy consents and per-purpose authorisations, device authorisation, and
sends push notifications (alerts, requests, offline watchdog and weekly summary).

- Firestore rules: `firestore.test.rules` (deployed to production).
- Service account: `secrets/firebase-admin.json` (never committed).
- Legal document versions: `VESTA_TERMS_VERSION` / `VESTA_PRIVACY_VERSION`.

```bash
npm ci
npm test                 # unit tests
npm run test:emulator:all  # Firestore emulator tests
npm start
```

## Licence

Copyright © 2026 FORBIDDEN S.A.S.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License version 3 (AGPL-3.0). See `LICENSE`.
