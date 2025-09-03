const admin = require('firebase-admin');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('❌ Error parsing FIREBASE_SERVICE_ACCOUNT:', err);
    process.exit(1);
  }
} else {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable is not set!');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = { admin, db };