/**
 * Firebase Utility Scripts
 * Run these manually when needed for Firebase operations
 * 
 * Usage:
 *   node firebaseUtils.js --backup      # Backup Firebase to local files
 *   node firebaseUtils.js --restore     # Restore local files to Firebase
 *   node firebaseUtils.js --sync        # Sync local and Firebase
 *   node firebaseUtils.js --verify      # Verify Firebase connection
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const firebaseService = require('./firebaseService');

const DATA_DIR = path.join(__dirname, 'data');
const COLLECTIONS = {
    users: 'app/users',
    keys: 'app/registration_keys',
    favorites: 'app/favorites',
    packageServices: 'app/package_services',
    sharedPackages: 'app/shared_packages',
    automations: 'app/automations',
    services: 'app/services_cache',
    settings: 'app/settings'
};

const FILES = {
    users: path.join(DATA_DIR, 'users.json'),
    keys: path.join(DATA_DIR, 'registration_keys.json'),
    favorites: path.join(DATA_DIR, 'favorites.json'),
    packageServices: path.join(DATA_DIR, 'package_services.json'),
    sharedPackages: path.join(DATA_DIR, 'shared_packages.json'),
    automations: path.join(DATA_DIR, 'automations.json'),
    services: path.join(DATA_DIR, 'services_cache.json'),
    settings: path.join(DATA_DIR, 'settings.json')
};

async function verifyConnection() {
    console.log('\n🔍 Verifying Firebase Connection...\n');
    try {
        await firebaseService.initializeFirebase();
        
        // Test read operation
        const testData = await firebaseService.readFromDatabase('app/users', null);
        
        if (testData !== null) {
            console.log('✅ Firebase connection successful!');
            console.log('📊 Sample data found in Firebase');
            console.log('🎯 Database URL:', process.env.DATABASE);
        } else {
            console.log('⚠️  Firebase connection OK, but no data found yet');
            console.log('💡 Tip: Run with --restore to sync data to Firebase');
        }
    } catch (error) {
        console.error('❌ Firebase connection failed:', error.message);
        process.exit(1);
    }
}

async function backupToLocal() {
    console.log('\n📥 Backing up Firebase to Local Files...\n');
    
    try {
        await firebaseService.initializeFirebase();
        
        // Ensure data directory exists
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            console.log('📁 Created data directory');
        }
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const [key, fbPath] of Object.entries(COLLECTIONS)) {
            try {
                const data = await firebaseService.readFromDatabase(fbPath, {});
                
                // Convert Firebase object to array if needed
                let saveData = data;
                if (typeof data === 'object' && !Array.isArray(data) && data !== null) {
                    saveData = Object.entries(data).map(([id, item]) => ({
                        ...item,
                        id: item.id || parseInt(id)
                    }));
                }
                
                fs.writeFileSync(FILES[key], JSON.stringify(saveData, null, 2), 'utf8');
                console.log(`✅ Backed up ${key}: ${FILES[key]}`);
                successCount++;
            } catch (error) {
                console.error(`❌ Failed to backup ${key}:`, error.message);
                errorCount++;
            }
        }
        
        console.log(`\n📊 Summary: ${successCount} successful, ${errorCount} failed`);
    } catch (error) {
        console.error('❌ Backup operation failed:', error.message);
        process.exit(1);
    }
}

async function restoreToFirebase() {
    console.log('\n📤 Restoring Local Files to Firebase...\n');
    
    try {
        await firebaseService.initializeFirebase();
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const [key, fbPath] of Object.entries(COLLECTIONS)) {
            try {
                if (!fs.existsSync(FILES[key])) {
                    console.log(`⏭️  Skipped ${key}: File not found`);
                    continue;
                }
                
                const data = JSON.parse(fs.readFileSync(FILES[key], 'utf8'));
                
                // Convert array to Firebase object format
                let dataToSave = {};
                if (Array.isArray(data)) {
                    data.forEach(item => {
                        const id = item.id || Date.now();
                        dataToSave[id] = item;
                    });
                } else {
                    dataToSave = data;
                }
                
                await firebaseService.writeToDatabase(fbPath, dataToSave);
                console.log(`✅ Restored ${key}: ${FILES[key]}`);
                successCount++;
            } catch (error) {
                console.error(`❌ Failed to restore ${key}:`, error.message);
                errorCount++;
            }
        }
        
        console.log(`\n📊 Summary: ${successCount} successful, ${errorCount} failed`);
    } catch (error) {
        console.error('❌ Restore operation failed:', error.message);
        process.exit(1);
    }
}

async function syncBoth() {
    console.log('\n🔄 Two-Way Sync: Local ↔ Firebase...\n');
    
    try {
        await firebaseService.initializeFirebase();
        
        console.log('📥 Phase 1: Backup Firebase to Local...');
        await backupToLocal();
        
        console.log('\n📤 Phase 2: Restore Local to Firebase...');
        await restoreToFirebase();
        
        console.log('\n✅ Sync complete! Local and Firebase are now in sync.');
    } catch (error) {
        console.error('❌ Sync operation failed:', error.message);
        process.exit(1);
    }
}

async function showStats() {
    console.log('\n📊 Firebase Database Statistics\n');
    
    try {
        await firebaseService.initializeFirebase();
        
        let totalItems = 0;
        
        for (const [key, fbPath] of Object.entries(COLLECTIONS)) {
            const data = await firebaseService.readFromDatabase(fbPath, {});
            
            let count = 0;
            if (typeof data === 'object' && data !== null) {
                if (Array.isArray(data)) {
                    count = data.length;
                } else {
                    count = Object.keys(data).length;
                }
            }
            
            console.log(`  ${key.padEnd(20)} : ${count.toString().padStart(4)} items`);
            totalItems += count;
        }
        
        console.log(`\n  Total Items        : ${totalItems}`);
        console.log(`  Database URL       : ${process.env.DATABASE}`);
        console.log('\n');
    } catch (error) {
        console.error('❌ Failed to retrieve statistics:', error.message);
        process.exit(1);
    }
}

// Parse command line arguments
const command = process.argv[2];

async function main() {
    switch (command) {
        case '--verify':
            await verifyConnection();
            break;
        case '--backup':
            await backupToLocal();
            break;
        case '--restore':
            await restoreToFirebase();
            break;
        case '--sync':
            await syncBoth();
            break;
        case '--stats':
            await showStats();
            break;
        default:
            console.log(`
Firebase Utility Script

Usage:
  node firebaseUtils.js --verify    Verify Firebase connection
  node firebaseUtils.js --backup    Backup Firebase → Local files
  node firebaseUtils.js --restore   Restore Local files → Firebase
  node firebaseUtils.js --sync      Two-way sync (Backup + Restore)
  node firebaseUtils.js --stats     Show database statistics

Examples:
  node firebaseUtils.js --verify
  node firebaseUtils.js --backup
  node firebaseUtils.js --restore
            `);
    }
}

main().catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
});
