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

Proprietary software. © FORBIDDEN S.A.S. All rights reserved. See `LICENSE`.
