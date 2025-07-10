import admin from 'firebase-admin';


// Initialize Firebase Admin SDK
const initializeFirebase = () => {
    if (!admin.apps.length) {

        const app = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            }),
            storageBucket: "vx-ai-a7407.firebasestorage.app"
        });

        const databaseName = process.env.NODE_ENV === 'production' ? '(default)' : 'development';
        const firestore = app.firestore();

        console.log(`Firebase initialized with database: ${databaseName}`);
        if (databaseName !== '(default)') {
            firestore.settings({ databaseId: databaseName });
        }

        return { admin, firestore };
    }

    return { admin, firestore: admin.firestore() };
};

export const { admin: adminSDK } = initializeFirebase();

export const db = adminSDK.firestore();