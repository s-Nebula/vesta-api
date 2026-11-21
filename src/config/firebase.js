const admin = require('firebase-admin');
const fs = require('node:fs');
const path = require('node:path');

if (!admin.apps.length) {
  const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

  if (usingEmulator) {
    admin.initializeApp({
      projectId: process.env.GCLOUD_PROJECT || 'demo-vesta',
    });
  } else {
    const credentialPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      path.resolve(__dirname, '../../../../secrets/firebase-admin.json');

    if (!fs.existsSync(credentialPath)) {
      throw new Error('No se encontró el archivo de credenciales de Firebase.');
    }

    const serviceAccount = JSON.parse(
      fs.readFileSync(credentialPath, 'utf8')
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
