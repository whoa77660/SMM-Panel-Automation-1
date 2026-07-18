const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin SDK
let db = null;
let isInitialized = false;

async function initializeFirebase() {
    if (isInitialized && db) {
        return db;
    }

    try {
        require('dotenv').config();
        
        let serviceAccount;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            } catch (e) {
                throw new Error('Failed to parse FIREBASE_SERVICE_ACCOUNT JSON string from environment');
            }
        } else if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PROJECT_ID) {
            serviceAccount = {
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            };
        } else {
            const serviceAccountPath = path.join(__dirname, 'Service-account.json');
            if (fs.existsSync(serviceAccountPath)) {
                serviceAccount = require(serviceAccountPath);
            } else {
                throw new Error('Firebase credentials not found in environment or Service-account.json');
            }
        }

        const databaseURL = process.env.DATABASE;

        if (!databaseURL) {
            throw new Error('DATABASE URL not found in .env file');
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: databaseURL
        });

        db = admin.database();
        isInitialized = true;
        console.log('✅ Firebase Realtime Database initialized successfully');
        return db;
    } catch (error) {
        console.error('❌ Firebase initialization failed:', error.message);
        throw error;
    }
}

// ============ DATABASE OPERATIONS ============

// Read operation
async function readFromDatabase(path_key, defaultValue = null) {
    try {
        const snapshot = await db.ref(path_key).once('value');
        const data = snapshot.val();
        return data !== null ? data : defaultValue;
    } catch (error) {
        console.error(`❌ Read error [${path_key}]:`, error.message);
        return defaultValue;
    }
}

// Write operation
async function writeToDatabase(path_key, data) {
    try {
        await db.ref(path_key).set(data);
        console.log(`✅ Data saved to [${path_key}]`);
        return true;
    } catch (error) {
        console.error(`❌ Write error [${path_key}]:`, error.message);
        return false;
    }
}

// Update operation (merge data)
async function updateDatabase(path_key, data) {
    try {
        await db.ref(path_key).update(data);
        console.log(`✅ Data updated at [${path_key}]`);
        return true;
    } catch (error) {
        console.error(`❌ Update error [${path_key}]:`, error.message);
        return false;
    }
}

// Delete operation
async function deleteFromDatabase(path_key) {
    try {
        await db.ref(path_key).remove();
        console.log(`✅ Data deleted from [${path_key}]`);
        return true;
    } catch (error) {
        console.error(`❌ Delete error [${path_key}]:`, error.message);
        return false;
    }
}

// Push new item (auto-generated ID)
async function pushToDatabase(path_key, data) {
    try {
        const newRef = await db.ref(path_key).push(data);
        console.log(`✅ Data pushed to [${path_key}] with ID: ${newRef.key}`);
        return newRef.key;
    } catch (error) {
        console.error(`❌ Push error [${path_key}]:`, error.message);
        return null;
    }
}

// ============ COLLECTION OPERATIONS (Arrays stored as objects) ============

// Get all items from a collection (stored as object with IDs as keys)
async function getCollection(collectionPath, defaultValue = {}) {
    try {
        const snapshot = await db.ref(collectionPath).once('value');
        const data = snapshot.val();
        
        if (data === null) {
            return defaultValue;
        }
        
        if (Array.isArray(data)) {
            return data.filter(item => item !== null && item !== undefined);
        }
        
        // Convert Firebase object to array if needed
        if (typeof data === 'object') {
            return Object.entries(data).map(([id, item]) => ({
                ...item,
                id: item.id !== undefined ? item.id : (isNaN(id) ? id : parseInt(id)),
                firebase_id: id
            })).filter(item => item !== null && item !== undefined);
        }
        
        return data || defaultValue;
    } catch (error) {
        console.error(`❌ Collection read error [${collectionPath}]:`, error.message);
        return defaultValue;
    }
}

// Save collection (convert array to object with IDs)
async function saveCollection(collectionPath, items) {
    try {
        let dataToSave = {};
        
        if (Array.isArray(items)) {
            items.forEach(item => {
                const id = item.id || item.firebase_id || Date.now();
                const { firebase_id, ...rest } = item;
                dataToSave[id] = rest;
            });
        } else {
            dataToSave = items;
        }
        
        await db.ref(collectionPath).set(dataToSave);
        console.log(`✅ Collection saved [${collectionPath}]`);
        return true;
    } catch (error) {
        console.error(`❌ Collection save error [${collectionPath}]:`, error.message);
        return false;
    }
}

// Add item to collection
async function addToCollection(collectionPath, item) {
    try {
        const id = item.id || Date.now();
        const { firebase_id, ...rest } = item;
        await db.ref(`${collectionPath}/${id}`).set(rest);
        console.log(`✅ Item added to [${collectionPath}] with ID: ${id}`);
        return id;
    } catch (error) {
        console.error(`❌ Add to collection error [${collectionPath}]:`, error.message);
        return null;
    }
}

// Update item in collection
async function updateCollectionItem(collectionPath, itemId, updates) {
    try {
        await db.ref(`${collectionPath}/${itemId}`).update(updates);
        console.log(`✅ Item updated [${collectionPath}/${itemId}]`);
        return true;
    } catch (error) {
        console.error(`❌ Update collection item error [${collectionPath}]:`, error.message);
        return false;
    }
}

// Delete item from collection
async function removeFromCollection(collectionPath, itemId) {
    try {
        await db.ref(`${collectionPath}/${itemId}`).remove();
        console.log(`✅ Item removed from [${collectionPath}]`);
        return true;
    } catch (error) {
        console.error(`❌ Remove from collection error [${collectionPath}]:`, error.message);
        return false;
    }
}

// ============ BATCH OPERATIONS ============

async function batchWrite(operations) {
    try {
        const updates = {};
        operations.forEach(op => {
            if (op.type === 'set') {
                updates[op.path] = op.data;
            } else if (op.type === 'delete') {
                updates[op.path] = null;
            }
        });
        
        await db.ref().update(updates);
        console.log(`✅ Batch write completed (${operations.length} operations)`);
        return true;
    } catch (error) {
        console.error('❌ Batch write error:', error.message);
        return false;
    }
}

// ============ SYNC WITH LOCAL FILE (BACKUP) ============

async function syncFromDatabase(dbPath, localFilePath, defaultValue = []) {
    try {
        const data = await readFromDatabase(dbPath, defaultValue);
        
        // If data is stored as Firebase object, convert to array
        let saveData = data;
        if (typeof data === 'object' && !Array.isArray(data) && data !== null) {
            saveData = Object.entries(data).map(([id, item]) => ({
                ...item,
                id: item.id || parseInt(id)
            }));
        }
        
        fs.writeFileSync(localFilePath, JSON.stringify(saveData, null, 2), 'utf8');
        console.log(`✅ Synced from Firebase to ${localFilePath}`);
        return saveData;
    } catch (error) {
        console.error(`❌ Sync from database error:`, error.message);
        return defaultValue;
    }
}

async function syncToDatabase(localFilePath, dbPath, defaultValue = []) {
    try {
        let data = defaultValue;
        
        if (fs.existsSync(localFilePath)) {
            const raw = fs.readFileSync(localFilePath, 'utf8');
            data = JSON.parse(raw);
        }
        
        // Convert array to object with IDs for Firebase
        let dataToSave = {};
        if (Array.isArray(data)) {
            data.forEach(item => {
                const id = item.id || Date.now();
                dataToSave[id] = item;
            });
        } else {
            dataToSave = data;
        }
        
        await writeToDatabase(dbPath, dataToSave);
        console.log(`✅ Synced from ${localFilePath} to Firebase`);
        return true;
    } catch (error) {
        console.error(`❌ Sync to database error:`, error.message);
        return false;
    }
}

// ============ LISTEN FOR CHANGES (REAL-TIME) ============

function listenToPath(path_key, callback) {
    try {
        db.ref(path_key).on('value', (snapshot) => {
            callback(null, snapshot.val());
        }, (error) => {
            console.error(`❌ Listen error [${path_key}]:`, error.message);
            callback(error, null);
        });
    } catch (error) {
        console.error(`❌ Listen setup error [${path_key}]:`, error.message);
    }
}

function unlistenFromPath(path_key) {
    try {
        db.ref(path_key).off();
        console.log(`✅ Unlistened from [${path_key}]`);
    } catch (error) {
        console.error(`❌ Unlisten error [${path_key}]:`, error.message);
    }
}

module.exports = {
    initializeFirebase,
    readFromDatabase,
    writeToDatabase,
    updateDatabase,
    deleteFromDatabase,
    pushToDatabase,
    getCollection,
    saveCollection,
    addToCollection,
    updateCollectionItem,
    removeFromCollection,
    batchWrite,
    syncFromDatabase,
    syncToDatabase,
    listenToPath,
    unlistenFromPath,
    getDatabase: () => db
};
