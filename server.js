require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

// Firebase service
const firebaseService = require('./firebaseService');

const app = express();
const server = http.createServer(app);

// ============ CONFIGURATION ============
const PORT = process.env.PORT || 11958;
const API_URL = "https://my.smmgen.com/api/v2";
const ADMIN_SECRET = "ADMIN2026";
const SERVICE_GAP_SECONDS = 2;
const STATUS_CHECK_COOLDOWN = 5;
const MAX_RETRIES = 3;
const USE_FIREBASE = true; // Set to false to use local JSON files only

const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_URL ||
    "https://smm-panel-automation-1.onrender.com/";
const KEEP_ALIVE_INTERVAL_MS = 49 * 1000;

async function sendKeepAlivePing() {
    try {
        const response = await axios.get(KEEP_ALIVE_URL, { timeout: 15000 });
        console.log(`🟢 Keep-alive ping -> ${response.status}`);
    } catch (e) {
        console.warn(`⚠️ Keep-alive ping failed: ${e.message}`);
    }
}

function startKeepAlive() {
    if (!KEEP_ALIVE_URL) {
        console.warn('⚠️ KEEP_ALIVE_URL is not defined. Keep-alive ping will not run.');
        return;
    }

    console.log(`🔁 Starting keep-alive pings to: ${KEEP_ALIVE_URL}`);
    sendKeepAlivePing();
    setInterval(sendKeepAlivePing, KEEP_ALIVE_INTERVAL_MS);
}

// ============ REQUEST LOGGING ============
app.use((req, res, next) => {
    const now = new Date().toISOString();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    console.log(`🌐 Visit ${now} ${req.method} ${req.originalUrl} from ${ip}`);
    next();
});

// ============ DATA DIRECTORY (BACKUP) ============
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('✅ Data directory created');
}

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

// Firebase paths
const FB_PATHS = {
    users: 'app/users',
    keys: 'app/registration_keys',
    favorites: 'app/favorites',
    packageServices: 'app/package_services',
    sharedPackages: 'app/shared_packages',
    automations: 'app/automations',
    services: 'app/services_cache',
    settings: 'app/settings'
};

// ============ LOCAL JSON HELPERS WITH WRITE MUTEX ============
const writeLocks = {};

function readJSON(filePath, defaultValue = []) {
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.filter(item => item !== null && item !== undefined);
            }
            return parsed;
        }
    } catch (e) {
        console.error(`❌ Read error [${path.basename(filePath)}]:`, e.message);
    }
    return defaultValue;
}

function writeJSON(filePath, data) {
    const key = filePath;

    if (writeLocks[key]) {
        writeLocks[key] = writeLocks[key].then(() => performWrite(filePath, data));
    } else {
        writeLocks[key] = performWrite(filePath, data);
    }

    return writeLocks[key];
}

async function performWrite(filePath, data) {
    try {
        const temp = filePath + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(temp, filePath);
        return true;
    } catch (e) {
        console.error(`❌ Write error [${path.basename(filePath)}]:`, e.message);
        try { if (fs.existsSync(filePath + '.tmp')) fs.unlinkSync(filePath + '.tmp'); } catch (ex) { }
        return false;
    }
}

// ============ HYBRID SAVE FUNCTION (Firebase + Local Backup) ============
async function saveData(dataType, data) {
    // Always save to local file as backup
    await writeJSON(FILES[dataType], data);

    // Save to Firebase if enabled
    if (USE_FIREBASE) {
        try {
            await firebaseService.saveCollection(FB_PATHS[dataType], data);
        } catch (error) {
            console.error(`⚠️ Firebase save failed for ${dataType}:`, error.message);
        }
    }
}

// ============ IN-MEMORY DATA ============
let users = readJSON(FILES.users, []);
let keys = readJSON(FILES.keys, []);
let favorites = readJSON(FILES.favorites, []);
let packageServices = readJSON(FILES.packageServices, []);
let sharedPackages = readJSON(FILES.sharedPackages, []);
let automations = readJSON(FILES.automations, []);
let servicesCache = readJSON(FILES.services, []);
let settings = readJSON(FILES.settings, { usd_to_bdt_rate: 122.67 });

// ============ AUTO-CREATE ADMIN ============
async function ensureAdminExists() {
    if (!users.find(u => u && u.is_admin)) {
        users.push({
            id: 1,
            username: 'admin',
            secret_key: ADMIN_SECRET,
            created_at: new Date().toISOString(),
            is_admin: 1,
            api_key: ''
        });
        await saveData('users', users);
        console.log('👑 Default admin created');
    }
}

// ============ INITIALIZE FIREBASE ============
async function initializeApp() {
    try {
        if (USE_FIREBASE) {
            await firebaseService.initializeFirebase();
            console.log('✅ Firebase initialization successful');

            // Load from Firebase, fallback to local data and upload if Firebase is empty
            const fbUsers = await firebaseService.getCollection(FB_PATHS.users, null);
            if (fbUsers !== null && Array.isArray(fbUsers) && fbUsers.length > 0) {
                users = fbUsers;
                console.log(`📥 Loaded ${users.length} user(s) from Firebase`);
            } else if (users.length > 0) {
                await firebaseService.saveCollection(FB_PATHS.users, users);
                console.log(`📤 Uploaded ${users.length} local user(s) to Firebase`);
            }

            const fbKeys = await firebaseService.getCollection(FB_PATHS.keys, null);
            if (fbKeys !== null && Array.isArray(fbKeys) && fbKeys.length > 0) {
                keys = fbKeys;
                console.log(`📥 Loaded ${keys.length} registration key(s) from Firebase`);
            } else if (keys.length > 0) {
                await firebaseService.saveCollection(FB_PATHS.keys, keys);
                console.log(`📤 Uploaded ${keys.length} local registration key(s) to Firebase`);
            }

            const fbFavorites = await firebaseService.getCollection(FB_PATHS.favorites, null);
            if (fbFavorites !== null && Array.isArray(fbFavorites) && fbFavorites.length > 0) {
                favorites = fbFavorites;
                console.log(`📥 Loaded ${favorites.length} favorite service(s) from Firebase`);
            } else if (favorites.length > 0) {
                await firebaseService.saveCollection(FB_PATHS.favorites, favorites);
                console.log(`📤 Uploaded ${favorites.length} local favorite service(s) to Firebase`);
            }

            const fbPackageServices = await firebaseService.getCollection(FB_PATHS.packageServices, null);
            if (fbPackageServices !== null && Array.isArray(fbPackageServices) && fbPackageServices.length > 0) {
                packageServices = fbPackageServices;
                console.log(`📥 Loaded ${packageServices.length} package service(s) from Firebase`);
            } else if (packageServices.length > 0) {
                await firebaseService.saveCollection(FB_PATHS.packageServices, packageServices);
                console.log(`📤 Uploaded ${packageServices.length} local package service(s) to Firebase`);
            }

            const fbSharedPackages = await firebaseService.getCollection(FB_PATHS.sharedPackages, null);
            if (fbSharedPackages !== null && Array.isArray(fbSharedPackages) && fbSharedPackages.length > 0) {
                sharedPackages = fbSharedPackages;
                console.log(`📥 Loaded ${sharedPackages.length} shared package(s) from Firebase`);
            } else if (sharedPackages.length > 0) {
                await firebaseService.saveCollection(FB_PATHS.sharedPackages, sharedPackages);
                console.log(`📤 Uploaded ${sharedPackages.length} local shared package(s) to Firebase`);
            }

            const fbAutomations = await firebaseService.getCollection(FB_PATHS.automations, null);
            if (fbAutomations !== null && Array.isArray(fbAutomations) && fbAutomations.length > 0) {
                automations = fbAutomations;
                console.log(`📥 Loaded ${automations.length} automation(s) from Firebase`);
            } else if (automations.length > 0) {
                await firebaseService.saveCollection(FB_PATHS.automations, automations);
                console.log(`📤 Uploaded ${automations.length} local automation(s) to Firebase`);
            }

            const fbServicesCache = await firebaseService.getCollection(FB_PATHS.services, null);
            if (fbServicesCache !== null && Array.isArray(fbServicesCache) && fbServicesCache.length > 0) {
                servicesCache = fbServicesCache;
                console.log(`📥 Loaded ${servicesCache.length} service(s) from cache on Firebase`);
            } else if (servicesCache.length > 0) {
                await firebaseService.saveCollection(FB_PATHS.services, servicesCache);
                console.log(`📤 Uploaded ${servicesCache.length} local service(s) to Firebase`);
            }

            const fbSettings = await firebaseService.readFromDatabase(FB_PATHS.settings, null);
            if (fbSettings !== null && typeof fbSettings === 'object') {
                settings = fbSettings;
                console.log(`📥 Loaded settings from Firebase`);
            } else {
                await firebaseService.writeToDatabase(FB_PATHS.settings, settings);
                console.log(`📤 Uploaded default settings to Firebase`);
            }
        }

        await ensureAdminExists();
    } catch (error) {
        console.error('❌ Initialization error:', error.message);
        console.log('⚠️ Continuing with local storage only');
    }
}

// ============ ID GENERATOR ============
function getNextId(dataArray) {
    if (!dataArray || dataArray.length === 0) return 1;
    const ids = dataArray.map(item => item.id || 0);
    return Math.max(...ids, 0) + 1;
}

// ============ MIDDLEWARE ============
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
    secret: crypto.randomBytes(24).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: false,
        maxAge: 30 * 24 * 60 * 60 * 1000
    }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ============ AUTH MIDDLEWARE ============
function loginRequired(req, res, next) {
    if (!req.session.logged_in) {
        return res.status(401).json({ error: "Login required", code: 'AUTH_REQUIRED' });
    }
    next();
}

function adminRequired(req, res, next) {
    if (!req.session.is_admin) {
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(403).json({ error: "Admin access required", code: 'ADMIN_REQUIRED' });
        }
        return res.redirect('/?error=admin_required');
    }
    next();
}

// ============ API HELPERS ============
async function callSMMApi(payload, apiKey) {
    try {
        const response = await axios.post(API_URL, {
            key: apiKey,
            ...payload
        }, {
            timeout: 15000,
            headers: { 'User-Agent': 'SMM-Panel/1.0' }
        });
        return response.data;
    } catch (e) {
        if (e.code === 'ECONNABORTED') {
            return { error: 'Request timeout' };
        }
        if (e.response) {
            return { error: `API Error: ${e.response.status}` };
        }
        return { error: e.message };
    }
}

function extractOrderId(response) {
    if (!response) return null;

    if (typeof response === 'string' || typeof response === 'number') {
        return String(response);
    }

    const possibleKeys = ['order', 'order_id', 'id', 'orderId', 'orderid'];

    for (const key of possibleKeys) {
        if (response[key] !== undefined && response[key] !== null) {
            return String(response[key]);
        }
    }

    if (response.data && typeof response.data === 'object') {
        for (const key of possibleKeys) {
            if (response.data[key] !== undefined && response.data[key] !== null) {
                return String(response.data[key]);
            }
        }
    }

    return null;
}

async function checkOrderStatus(apiKey, orderId) {
    try {
        const response = await axios.post(API_URL, {
            key: apiKey,
            action: 'status',
            order: orderId
        }, { timeout: 15000 });

        const data = response.data;

        if (!data || data.error) {
            return {
                error: data?.error || 'Unknown error',
                status: 'Error',
                remains: 0
            };
        }

        let status = 'Pending';
        let remains = 0;

        if (typeof data === 'object') {
            status = data.status || data.order_status || data.state ||
                (data.data && (data.data.status || data.data.order_status)) || 'Pending';
            remains = data.remains || data.remain ||
                (data.data && (data.data.remains || data.data.remain)) || 0;
        }

        const statusMap = {
            'completed': 'Completed',
            'complete': 'Completed',
            'processing': 'Processing',
            'in progress': 'In Progress',
            'in_progress': 'In Progress',
            'pending': 'Pending',
            'partial': 'Partial',
            'cancelled': 'Cancelled',
            'canceled': 'Cancelled',
            'failed': 'Failed',
            'error': 'Failed',
            'refunded': 'Cancelled'
        };

        const normalized = statusMap[String(status).toLowerCase().trim()] ||
            String(status).charAt(0).toUpperCase() + String(status).slice(1);

        return {
            status: normalized,
            remains: parseInt(remains) || 0
        };
    } catch (e) {
        return {
            error: e.message,
            status: 'Error',
            remains: 0
        };
    }
}

// ============ SERVICES REFRESH ============
let isRefreshing = false;

async function refreshServices() {
    if (isRefreshing) return;
    isRefreshing = true;

    try {
        const adminUser = users.find(u => u && u.api_key);
        if (!adminUser) {
            console.log('⚠️ No API key found for service refresh');
            return;
        }

        const response = await axios.post(API_URL, {
            key: adminUser.api_key,
            action: 'services'
        }, { timeout: 25000 });

        if (Array.isArray(response.data)) {
            servicesCache = response.data
                .filter(s => {
                    const name = (s.name || '').toLowerCase();
                    return name.includes('instagram') || name.includes('tiktok');
                })
                .map(s => ({
                    service: s.service,
                    name: s.name || 'Unknown',
                    rate: s.rate || 0,
                    min: s.min || 100,
                    max: s.max || 10000
                }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

            await saveData('services', servicesCache);
            console.log(`✅ Services refreshed: ${servicesCache.length} loaded`);
        }
    } catch (e) {
        console.error('❌ Service refresh failed:', e.message);
    } finally {
        isRefreshing = false;
    }
}

setTimeout(refreshServices, 3000);
setInterval(refreshServices, 4 * 60 * 60 * 1000);

// ============ AUTOMATION QUEUE SYSTEM ============
const orderQueue = [];
let processingQueue = false;

async function processQueue() {
    if (processingQueue || orderQueue.length === 0) return;
    processingQueue = true;

    while (orderQueue.length > 0) {
        const task = orderQueue.shift();
        let retries = MAX_RETRIES;
        let completed = false;

        while (retries > 0 && !completed) {
            try {
                const result = await callSMMApi({
                    action: 'add',
                    service: task.serviceId,
                    link: task.link,
                    quantity: task.quantity
                }, task.apiKey);

                const orderId = extractOrderId(result);

                if (orderId) {
                    task.resolve({ order_id: orderId, error: null });
                    completed = true;
                } else if (retries <= 1) {
                    task.resolve({
                        order_id: null,
                        error: result.error || 'Failed to create order after retries'
                    });
                }
            } catch (e) {
                if (retries <= 1) {
                    task.resolve({ order_id: null, error: e.message });
                }
            }

            retries--;
            if (!completed && retries > 0) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        if (orderQueue.length > 0) {
            await new Promise(r => setTimeout(r, SERVICE_GAP_SECONDS * 1000));
        }
    }

    processingQueue = false;
}

function queueOrder(serviceId, link, quantity, apiKey) {
    return new Promise(resolve => {
        orderQueue.push({
            serviceId,
            link,
            quantity,
            apiKey,
            resolve,
            queued_at: Date.now()
        });
        processQueue();
    });
}

// ============ AUTOMATION ENGINE ============
const runningAutomations = new Set();

async function runAutomation(autoId) {
    if (runningAutomations.has(autoId)) {
        console.log(`⚠️ Automation ${autoId} is already running`);
        return;
    }

    const autoIndex = automations.findIndex(a => a.id === autoId);
    if (autoIndex === -1) return;

    const auto = automations[autoIndex];
    const user = users.find(u => u.id === auto.user_id);

    if (!user?.api_key) {
        auto.status = 'Stopped (No API key)';
        await saveData('automations', automations);
        return;
    }

    if (auto.current_run >= auto.total_runs) {
        auto.status = 'Completed';
        await saveData('automations', automations);
        return;
    }

    let servicesTemplate = [];
    try {
        servicesTemplate = JSON.parse(auto.services_template || '[]');
    } catch (e) {
        console.error(`❌ Invalid template for automation ${autoId}`);
        auto.status = 'Stopped (Invalid template)';
        await saveData('automations', automations);
        return;
    }

    if (!servicesTemplate.length) {
        auto.status = 'Stopped (Empty template)';
        await saveData('automations', automations);
        return;
    }

    runningAutomations.add(autoId);

    try {
        for (let runNum = auto.current_run + 1; runNum <= auto.total_runs; runNum++) {
            const ci = automations.findIndex(a => a.id === autoId);
            if (ci === -1 || automations[ci].status === 'Stopped') {
                console.log(`⏹️ Automation ${autoId} stopped`);
                break;
            }

            automations[ci].current_run = runNum;
            automations[ci].status = `Running (${runNum}/${auto.total_runs})`;

            let runsHistory = [];
            try {
                runsHistory = JSON.parse(automations[ci].runs_history || '[]');
            } catch (e) {
                runsHistory = [];
            }

            let currentRun = runsHistory.find(r => r.run_number === runNum);
            if (!currentRun) {
                currentRun = {
                    run_number: runNum,
                    services: [],
                    status: 'Running',
                    started_at: new Date().toISOString(),
                    completed_at: null
                };
                runsHistory.push(currentRun);
            }

            currentRun.status = 'Running';
            currentRun.started_at = new Date().toISOString();
            automations[ci].runs_history = JSON.stringify(runsHistory);
            await saveData('automations', automations);

            const serviceResults = [];
            for (const sv of servicesTemplate) {
                const si = automations.findIndex(a => a.id === autoId);
                if (si === -1 || automations[si].status === 'Stopped') {
                    console.log(`⏹️ Automation ${autoId} stopped during execution`);
                    break;
                }

                const serviceId = sv.id || sv.service_id;
                const serviceName = sv.name || sv.service_name || 'Unknown';
                const quantity = sv.quantity || 0;
                const rate = sv.rate || 0;

                const { order_id, error } = await queueOrder(
                    serviceId,
                    automations[si].link,
                    quantity,
                    user.api_key
                );

                serviceResults.push({
                    service_id: serviceId,
                    service_name: serviceName,
                    quantity: quantity,
                    rate: rate,
                    api_status: order_id ? 'Pending' : 'Failed',
                    order_id: order_id || null,
                    api_remains: 0,
                    placed_at: order_id ? new Date().toISOString() : null,
                    last_checked: null,
                    error: order_id ? null : (error || 'Failed to place order')
                });
            }

            const fi = automations.findIndex(a => a.id === autoId);
            if (fi === -1) break;

            let finalHistory = [];
            try {
                finalHistory = JSON.parse(automations[fi].runs_history || '[]');
            } catch (e) {
                finalHistory = [];
            }

            const finalRun = finalHistory.find(r => r.run_number === runNum);
            if (finalRun) {
                finalRun.services = serviceResults;

                const failedCount = serviceResults.filter(s => s.api_status === 'Failed').length;
                const successCount = serviceResults.filter(s => s.api_status !== 'Failed').length;

                if (failedCount === 0) finalRun.status = 'Completed';
                else if (successCount === 0) finalRun.status = 'Failed';
                else finalRun.status = 'Partial';

                finalRun.completed_at = new Date().toISOString();
            }

            automations[fi].runs_history = JSON.stringify(finalHistory);

            if (runNum < auto.total_runs) {
                const waitMs = (auto.interval_minutes || 60) * 60 * 1000;
                automations[fi].status = `Waiting (${runNum}/${auto.total_runs})`;
                automations[fi].next_run_at = new Date(Date.now() + waitMs).toISOString();
                await saveData('automations', automations);

                console.log(`⏰ Automation ${autoId}: Waiting ${auto.interval_minutes || 60}min for run ${runNum + 1}`);
                await new Promise(r => setTimeout(r, waitMs));
            } else {
                const lf = automations.findIndex(a => a.id === autoId);
                if (lf !== -1) {
                    automations[lf].status = 'Completed';
                    automations[lf].next_run_at = null;
                    await saveData('automations', automations);
                    console.log(`✅ Automation ${autoId}: Fully completed!`);
                }
            }
        }
    } catch (e) {
        console.error(`❌ Automation ${autoId} error:`, e.message);
        const ei = automations.findIndex(a => a.id === autoId);
        if (ei !== -1) {
            automations[ei].status = `Error: ${e.message}`;
            await saveData('automations', automations);
        }
    } finally {
        runningAutomations.delete(autoId);
    }
}

// ============ ROUTES - AUTH ============
app.get('/', (req, res) => {
    if (req.session.logged_in) {
        return res.render('new_order', {
            username: req.session.username || 'User',
            usd_to_bdt_rate: settings.usd_to_bdt_rate || 122.67
        });
    }
    res.render('index');
});

app.post('/login', (req, res) => {
    const { secret_key } = req.body;

    if (!secret_key) {
        return res.status(400).json({ success: false, message: 'Secret key required' });
    }

    const user = users.find(u => u.secret_key === secret_key);

    if (user) {
        req.session.logged_in = true;
        req.session.user_id = user.id;
        req.session.username = user.username;
        req.session.is_admin = !!user.is_admin;

        return res.json({
            success: true,
            is_admin: !!user.is_admin,
            username: user.username
        });
    }

    res.status(401).json({ success: false, message: 'Invalid secret key' });
});

app.post('/register', async (req, res) => {
    const { username, secret_key, api_key } = req.body;

    if (!username || !secret_key || !api_key) {
        return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (username.length < 1) {
        return res.status(400).json({ success: false, message: 'Username must be at least 1 characters' });
    }

    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ success: false, message: 'Username already exists' });
    }

    const key = keys.find(k => k.secret_key === secret_key && !k.used_by);
    if (!key) {
        return res.status(401).json({ success: false, message: 'Invalid or used registration key' });
    }

    const newUser = {
        id: getNextId(users),
        username,
        secret_key,
        created_at: new Date().toISOString(),
        is_admin: key.target_role === 'admin' ? 1 : 0,
        api_key
    };

    users.push(newUser);
    key.used_by = newUser.id;
    key.used_at = new Date().toISOString();

    await saveData('users', users);
    await saveData('keys', keys);

    res.json({ success: true, message: 'Registration successful!' });
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.json({ success: true });
    });
});

// ============ ROUTES - USER ============
app.get('/api/get_user_info', loginRequired, (req, res) => {
    res.json({
        username: req.session.username,
        user_id: req.session.user_id,
        is_admin: req.session.is_admin
    });
});

app.post('/api/set_api_key', loginRequired, async (req, res) => {
    const { api_key } = req.body;

    if (!api_key) {
        return res.status(400).json({ success: false, message: 'API key required' });
    }

    const user = users.find(u => u.id === req.session.user_id);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.api_key = api_key;
    await saveData('users', users);

    if (servicesCache.length === 0) {
        refreshServices();
    }

    res.json({ success: true, message: 'API Key saved!' });
});

app.get('/api/get_api_key', loginRequired, (req, res) => {
    const user = users.find(u => u.id === req.session.user_id);
    res.json({ api_key: user?.api_key || '' });
});

// ============ ROUTES - BALANCE & ORDERS ============
app.get('/api/balance', loginRequired, async (req, res) => {
    const user = users.find(u => u.id === req.session.user_id);

    if (!user?.api_key) {
        return res.status(400).json({ error: 'API key not set', code: 'NO_API_KEY' });
    }

    const result = await callSMMApi({ action: 'balance' }, user.api_key);
    res.json(result);
});

app.post('/api/order', loginRequired, async (req, res) => {
    const user = users.find(u => u.id === req.session.user_id);

    if (!user?.api_key) {
        return res.status(400).json({ error: 'API key not set' });
    }

    const { service, link, quantity } = req.body;

    if (!service || !link || !quantity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await callSMMApi({
        action: 'add',
        service,
        link,
        quantity
    }, user.api_key);

    res.json(result);
});

// ============ ROUTES - SERVICES ============
app.get('/api/services', loginRequired, (req, res) => {
    if (!servicesCache.length) {
        refreshServices();
    }
    res.json(servicesCache || []);
});

app.post('/api/services/filter', loginRequired, (req, res) => {
    const platform = (req.body.platform || '').toLowerCase();

    if (!platform) {
        return res.json(servicesCache || []);
    }

    let filtered = servicesCache || [];

    if (platform === 'instagram') {
        filtered = servicesCache.filter(s =>
            (s.name || '').toLowerCase().includes('instagram')
        );
    } else if (platform === 'tiktok') {
        filtered = servicesCache.filter(s =>
            (s.name || '').toLowerCase().includes('tiktok')
        );
    }

    res.json(filtered);
});

// Return real min/max for a single service from the global cache (all platforms)
app.get('/api/services/info/:id', loginRequired, (req, res) => {
    const id = parseInt(req.params.id);
    const svc = (servicesCache || []).find(s => s.service == id);
    if (!svc) return res.json({ found: false });
    res.json({ found: true, min: svc.min || 100, max: svc.max || 10000, name: svc.name, rate: svc.rate });
});

// ============ ROUTES - FAVORITES (UPDATED WITH MIN QUANTITY) ============
app.get('/api/get_favorites', loginRequired, (req, res) => {
    const userFavs = favorites.filter(f => f.user_id === req.session.user_id);
    res.json(userFavs.map(f => {
        // Always return the real min from the live services cache so badges
        // show the correct minimum even if the favorite was saved with the
        // stale default of 100 before the service list was first loaded.
        const live = (servicesCache || []).find(s => s.service == f.service_id);
        return {
            id: f.service_id,
            name: f.service_name,
            rate: f.service_rate,
            min: (live && live.min) ? live.min : (f.min_quantity || 100)
        };
    }));
});

app.post('/api/add_favorite', loginRequired, async (req, res) => {
    const { service_id, service_name, service_rate, min_quantity } = req.body;

    if (!service_id) {
        return res.status(400).json({ success: false, message: 'Service ID required' });
    }

    const exists = favorites.find(f =>
        f.user_id === req.session.user_id && f.service_id == service_id
    );

    if (exists) {
        return res.json({ success: false, message: 'Already in favorites' });
    }

    favorites.push({
        id: getNextId(favorites),
        user_id: req.session.user_id,
        service_id,
        service_name: service_name || 'Unknown',
        service_rate: service_rate || 0,
        min_quantity: min_quantity || 100,
        added_at: new Date().toISOString()
    });

    await saveData('favorites', favorites);
    res.json({ success: true, message: 'Added to favorites!' });
});

app.post('/api/remove_favorite', loginRequired, async (req, res) => {
    const { service_id } = req.body;

    const initialLength = favorites.length;
    favorites = favorites.filter(f =>
        !(f.user_id === req.session.user_id && f.service_id == service_id)
    );

    if (favorites.length < initialLength) {
        await saveData('favorites', favorites);
        res.json({ success: true, message: 'Removed from favorites' });
    } else {
        res.json({ success: false, message: 'Not found in favorites' });
    }
});

// ============ ROUTES - PACKAGE ============
app.get('/api/get_package', loginRequired, (req, res) => {
    const userPkg = packageServices.filter(p => p.user_id === req.session.user_id);
    res.json(userPkg.map(p => ({
        id: p.service_id,
        name: p.service_name,
        rate: p.service_rate,
        quantity: p.quantity,
        min: p.min_quantity || 100
    })));
});

app.post('/api/add_to_package', loginRequired, async (req, res) => {
    const { service_id, service_name, service_rate, quantity } = req.body;

    if (!service_id || !quantity) {
        return res.status(400).json({ success: false, message: 'Service ID and quantity required' });
    }

    const qty = parseInt(quantity);
    if (isNaN(qty) || qty < 1) {
        return res.status(400).json({ success: false, message: 'Invalid quantity' });
    }

    const serviceInfo = servicesCache.find(s => s.service == service_id);
    const minQty = serviceInfo ? (serviceInfo.min || 100) : 100;

    if (qty < minQty) {
        return res.status(400).json({
            success: false,
            message: `Minimum quantity is ${minQty}`
        });
    }

    const exists = packageServices.find(p =>
        p.user_id === req.session.user_id && p.service_id == service_id
    );

    if (exists) {
        return res.json({ success: false, message: 'Service already in package' });
    }

    packageServices.push({
        id: getNextId(packageServices),
        user_id: req.session.user_id,
        service_id,
        service_name: service_name || 'Unknown Service',
        service_rate: parseFloat(service_rate) || 0,
        quantity: qty,
        min_quantity: minQty,
        added_at: new Date().toISOString()
    });

    await saveData('packageServices', packageServices);
    res.json({ success: true, message: 'Added to package!' });
});

app.post('/api/remove_from_package', loginRequired, async (req, res) => {
    const { service_id } = req.body;

    packageServices = packageServices.filter(p =>
        !(p.user_id === req.session.user_id && p.service_id == service_id)
    );

    await saveData('packageServices', packageServices);
    res.json({ success: true, message: 'Removed from package' });
});

app.delete('/api/clear_package', loginRequired, async (req, res) => {
    packageServices = packageServices.filter(p => p.user_id !== req.session.user_id);
    await saveData('packageServices', packageServices);
    res.json({ success: true, message: 'Package cleared' });
});

// ============ NEW ROUTE - UPDATE PACKAGE QUANTITY ============
app.post('/api/update_package_quantity', loginRequired, async (req, res) => {
    const { service_id, quantity } = req.body;

    if (!service_id || !quantity) {
        return res.status(400).json({ success: false, message: 'Service ID and quantity required' });
    }

    const qty = parseInt(quantity);
    if (isNaN(qty) || qty < 1) {
        return res.status(400).json({ success: false, message: 'Invalid quantity' });
    }

    const pkgIndex = packageServices.findIndex(p =>
        p.user_id === req.session.user_id && p.service_id == service_id
    );

    if (pkgIndex === -1) {
        return res.status(404).json({ success: false, message: 'Service not in package' });
    }

    const minQty = packageServices[pkgIndex].min_quantity || 100;
    if (qty < minQty) {
        return res.status(400).json({
            success: false,
            message: `Minimum quantity is ${minQty}`
        });
    }

    packageServices[pkgIndex].quantity = qty;
    await saveData('packageServices', packageServices);

    res.json({ success: true, message: 'Quantity updated!' });
});

// ============ ROUTES - SHARED PACKAGES ============
app.post('/api/share_api_settings', loginRequired, async (req, res) => {
    const { name, description } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Package name required' });
    }

    const userPkg = packageServices.filter(p => p.user_id === req.session.user_id);

    if (!userPkg.length) {
        return res.status(400).json({ success: false, message: 'Your package is empty' });
    }

    const existingName = sharedPackages.find(p =>
        p.user_id === req.session.user_id &&
        p.name.toLowerCase() === name.trim().toLowerCase()
    );

    if (existingName) {
        return res.status(400).json({ success: false, message: 'Package name already exists' });
    }

    sharedPackages.push({
        id: getNextId(sharedPackages),
        user_id: req.session.user_id,
        username: req.session.username,
        name: name.trim(),
        description: (description || '').trim(),
        service_data: JSON.stringify(userPkg.map(p => ({
            service_id: p.service_id,
            service_name: p.service_name,
            service_rate: p.service_rate,
            quantity: p.quantity
        }))),
        created_at: new Date().toISOString()
    });

    await saveData('sharedPackages', sharedPackages);
    res.json({ success: true, message: `Package "${name.trim()}" published!` });
});

app.get('/api/get_shared_api_settings', loginRequired, (req, res) => {
    const all = sharedPackages.map(p => {
        let services = [];
        try {
            services = JSON.parse(p.service_data || '[]');
        } catch (e) { }

        return {
            id: p.id,
            user_id: p.user_id,
            name: p.name,
            description: p.description,
            service_data: services,
            created_at: p.created_at,
            username: p.username || 'Unknown'
        };
    });

    res.json(all);
});

app.post('/api/use_shared_api_settings/:id', loginRequired, async (req, res) => {
    const sharedId = parseInt(req.params.id);
    const shared = sharedPackages.find(p => p.id === sharedId);

    if (!shared) {
        return res.status(404).json({ success: false, message: 'Package not found' });
    }

    let services = [];
    try {
        services = JSON.parse(shared.service_data || '[]');
    } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid package data' });
    }

    let imported = 0;
    services.forEach(svc => {
        const exists = packageServices.find(p =>
            p.user_id === req.session.user_id &&
            p.service_id == svc.service_id
        );

        if (!exists) {
            packageServices.push({
                id: getNextId(packageServices),
                user_id: req.session.user_id,
                service_id: svc.service_id,
                service_name: svc.service_name,
                service_rate: svc.service_rate,
                quantity: svc.quantity,
                min_quantity: 100,
                added_at: new Date().toISOString()
            });
            imported++;
        }
    });

    await saveData('packageServices', packageServices);
    res.json({
        success: true,
        message: imported > 0 ?
            `Imported ${imported} service(s) to your package!` :
            'All services already in your package'
    });
});

app.delete('/api/delete_my_shared_package/:id', loginRequired, async (req, res) => {
    const sharedId = parseInt(req.params.id);
    const shared = sharedPackages.find(p => p.id === sharedId);

    if (!shared) {
        return res.status(404).json({ success: false, message: 'Package not found' });
    }

    if (shared.user_id !== req.session.user_id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }

    sharedPackages = sharedPackages.filter(p => p.id !== sharedId);
    await saveData('sharedPackages', sharedPackages);
    res.json({ success: true, message: 'Package deleted' });
});

// ============ ROUTES - AUTOMATION ============
app.post('/api/create_package_automation', loginRequired, async (req, res) => {
    try {
        const { link, total_runs, interval, services, package_name } = req.body;

        if (!link || !services || !services.length) {
            return res.status(400).json({
                success: false,
                message: 'Link and at least one service are required'
            });
        }

        if (!link.match(/^https?:\/\//)) {
            return res.status(400).json({
                success: false,
                message: 'Link must start with http:// or https://'
            });
        }

        const user = users.find(u => u.id === req.session.user_id);
        if (!user?.api_key) {
            return res.status(400).json({
                success: false,
                message: 'Please set your API key first'
            });
        }

        const runs = parseInt(total_runs) || 1;
        if (runs < 1 || runs > 100) {
            return res.status(400).json({
                success: false,
                message: 'Runs must be between 1 and 100'
            });
        }

        let intervalMinutes = 60;
        if (interval) {
            if (interval.includes('h')) {
                intervalMinutes = parseInt(interval) * 60;
            } else if (interval.includes('m')) {
                intervalMinutes = parseInt(interval);
            }
        }

        if (isNaN(intervalMinutes) || intervalMinutes < 1) {
            intervalMinutes = 60;
        }

        const newAutomation = {
            id: getNextId(automations),
            user_id: req.session.user_id,
            package_name: package_name || `Automation_${Date.now()}`,
            link,
            total_runs: runs,
            interval_minutes: intervalMinutes,
            interval_display: interval || '1h',
            status: 'Running',
            current_run: 0,
            created_at: new Date().toISOString(),
            runs_history: '[]',
            services_template: JSON.stringify(services),
            next_run_at: null
        };

        automations.push(newAutomation);
        await saveData('automations', automations);

        setImmediate(() => runAutomation(newAutomation.id));

        res.json({
            success: true,
            message: `Automation started! ${runs} run(s) with ${services.length} service(s) each.`,
            automation_id: newAutomation.id
        });

    } catch (e) {
        console.error('Create automation error:', e);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/get_package_automations', loginRequired, (req, res) => {
    const userAutos = automations
        .filter(a => a.user_id === req.session.user_id)
        .map(a => {
            let runsHistory = [];
            try {
                runsHistory = JSON.parse(a.runs_history || '[]');
            } catch (e) { }

            const currentRun = a.current_run || 0;
            let services = [];

            if (currentRun > 0) {
                const runData = runsHistory.find(r => r.run_number === currentRun);
                if (runData) {
                    services = runData.services || [];
                }
            }

            return {
                id: a.id,
                package_name: a.package_name,
                link: a.link,
                total_runs: a.total_runs,
                interval_display: a.interval_display,
                status: a.status,
                current_run: currentRun,
                created_at: a.created_at,
                services: services,
                runs_history: runsHistory,
                progress_percent: a.total_runs > 0 ?
                    Math.round((currentRun / a.total_runs) * 100) : 0,
                next_run_at: a.next_run_at
            };
        });

    userAutos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(userAutos.slice(0, 50));
});

app.post('/api/check_run_status/:autoId/:runNumber', loginRequired, async (req, res) => {
    const autoId = parseInt(req.params.autoId);
    const runNumber = parseInt(req.params.runNumber);

    const auto = automations.find(a =>
        a.id === autoId && a.user_id === req.session.user_id
    );

    if (!auto) {
        return res.status(404).json({ success: false, message: 'Automation not found' });
    }

    const user = users.find(u => u.id === req.session.user_id);
    if (!user?.api_key) {
        return res.status(400).json({ success: false, message: 'API key not set' });
    }

    const now = Date.now();
    if (auto._lastStatusCheck && (now - auto._lastStatusCheck) < STATUS_CHECK_COOLDOWN * 1000) {
        const remaining = Math.ceil(
            (auto._lastStatusCheck + STATUS_CHECK_COOLDOWN * 1000 - now) / 1000
        );
        return res.json({
            cooldown: true,
            message: `Please wait ${remaining}s before checking again`,
            remaining_seconds: remaining
        });
    }

    let runsHistory = [];
    try {
        runsHistory = JSON.parse(auto.runs_history || '[]');
    } catch (e) { }

    const runData = runsHistory.find(r => r.run_number === runNumber);
    if (!runData) {
        return res.status(404).json({ success: false, message: 'Run not found' });
    }

    const services = runData.services || [];
    if (!services.length) {
        return res.json({ success: false, message: 'No services in this run' });
    }

    const updatedServices = [];
    for (let i = 0; i < services.length; i++) {
        const sv = { ...services[i] };

        if (['Completed', 'Cancelled', 'Failed'].includes(sv.api_status) || !sv.order_id) {
            updatedServices.push(sv);
            continue;
        }

        if (i > 0) {
            await new Promise(r => setTimeout(r, SERVICE_GAP_SECONDS * 1000));
        }

        const statusResult = await checkOrderStatus(user.api_key, sv.order_id);
        if (!statusResult.error) {
            sv.api_status = statusResult.status;
            sv.api_remains = statusResult.remains;
            sv.last_checked = new Date().toISOString();
        }

        updatedServices.push(sv);
    }

    runData.services = updatedServices;
    auto.runs_history = JSON.stringify(runsHistory);
    auto._lastStatusCheck = now;
    await saveData('automations', automations);

    res.json({
        success: true,
        message: `Run ${runNumber} status updated!`,
        services: updatedServices.map(s => ({
            service_name: s.service_name,
            api_status: s.api_status || 'Pending',
            api_remains: s.api_remains || 0,
            order_id: s.order_id,
            quantity: s.quantity,
            placed_at: s.placed_at || null
        }))
    });
});

app.delete('/api/delete_package_automation/:id', loginRequired, async (req, res) => {
    const autoId = parseInt(req.params.id);
    const autoIndex = automations.findIndex(a =>
        a.id === autoId && a.user_id === req.session.user_id
    );

    if (autoIndex === -1) {
        return res.status(404).json({ success: false, message: 'Automation not found' });
    }

    // Mark as Stopped first so any running loop exits on its next iteration check
    automations[autoIndex].status = 'Stopped';

    // Remove immediately so UI refresh shows it gone on the first try
    automations = automations.filter(a => a.id !== autoId);
    await saveData('automations', automations);
    console.log(`🗑️ Automation ${autoId} deleted`);

    res.json({ success: true, message: 'Automation deleted!' });
});

// ============ ADMIN ROUTES ============
app.get('/admin', adminRequired, (req, res) => {
    res.render('admin', {
        users,
        registration_keys: keys,
        admin_secret: ADMIN_SECRET,
        usd_to_bdt_rate: settings.usd_to_bdt_rate,
        current_user_id: req.session.user_id
    });
});

app.post('/api/admin/force_refresh', adminRequired, async (req, res) => {
    servicesCache = [];
    await refreshServices();
    res.json({ success: true, count: servicesCache.length });
});

app.post('/api/admin/set_usd_rate', adminRequired, async (req, res) => {
    const rate = parseFloat(req.body.usd_to_bdt_rate);

    if (isNaN(rate) || rate <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid rate' });
    }

    settings.usd_to_bdt_rate = rate;
    await saveData('settings', settings);
    res.json({ success: true, message: 'Rate updated!' });
});

app.get('/api/admin/get_users', adminRequired, (req, res) => {
    res.json(users.map(u => {
        const isDefaultAdmin = (u.id === 1 && u.is_admin && u.secret_key === ADMIN_SECRET);

        return {
            id: u.id,
            username: u.username,
            secret_key: isDefaultAdmin ? '••••••••••' : (u.secret_key || ''),
            created_at: u.created_at,
            is_admin: !!u.is_admin,
            has_api_key: !!u.api_key,
            is_hidden: isDefaultAdmin
        };
    }));
});

app.get('/api/admin/get_registration_keys', adminRequired, (req, res) => {
    res.json(keys.map(k => {
        const usedByUser = k.used_by ? users.find(u => u.id === k.used_by) : null;
        return {
            id: k.id,
            secret_key: k.secret_key,
            created_at: k.created_at,
            used_by: k.used_by,
            used_by_username: usedByUser?.username || null,
            used_at: k.used_at,
            target_role: k.target_role || 'user'
        };
    }));
});

app.post('/api/admin/create_registration_key', adminRequired, async (req, res) => {
    const secretKey = req.body.secret_key || crypto.randomBytes(6).toString('hex').toUpperCase();

    if (keys.find(k => k.secret_key === secretKey && !k.used_by)) {
        return res.status(400).json({
            success: false,
            message: 'Key already exists and is unused'
        });
    }

    keys.push({
        id: getNextId(keys),
        secret_key: secretKey,
        created_at: new Date().toISOString(),
        created_by: req.session.user_id,
        used_by: null,
        used_at: null,
        target_role: req.body.target_role || 'user'
    });

    await saveData('keys', keys);
    res.json({ success: true, secret_key: secretKey });
});

app.post('/api/admin/delete_registration_key', adminRequired, async (req, res) => {
    const keyId = parseInt(req.body.key_id);
    const initialLength = keys.length;

    keys = keys.filter(k => k.id !== keyId);

    if (keys.length < initialLength) {
        await saveData('keys', keys);
        res.json({ success: true, message: 'Key deleted' });
    } else {
        res.json({ success: false, message: 'Key not found' });
    }
});

app.post('/api/admin/delete_user', adminRequired, async (req, res) => {
    const userId = parseInt(req.body.user_id);

    if (userId === req.session.user_id) {
        return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
    }

    users = users.filter(u => u.id !== userId);
    favorites = favorites.filter(f => f.user_id !== userId);
    packageServices = packageServices.filter(p => p.user_id !== userId);
    sharedPackages = sharedPackages.filter(p => p.user_id !== userId);
    automations = automations.filter(a => a.user_id !== userId);

    await saveData('users', users);
    await saveData('favorites', favorites);
    await saveData('packageServices', packageServices);
    await saveData('sharedPackages', sharedPackages);
    await saveData('automations', automations);

    res.json({ success: true, message: 'User deleted successfully' });
});

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        data: {
            users: users.length,
            services: servicesCache.length,
            automations: automations.filter(a => a.status === 'Running').length,
            total_automations: automations.length
        },
        memory: process.memoryUsage().heapUsed / 1024 / 1024
    });
});

// ============ RESUME INCOMPLETE AUTOMATIONS ============
async function resumeIncompleteAutomations() {
    if (!automations.length) return;

    console.log('\n🔄 Checking for incomplete automations...');

    automations.forEach(auto => {
        if (!auto.status || auto.status === 'Completed' || auto.status === 'Stopped') {
            return;
        }

        if (auto.current_run >= auto.total_runs) {
            auto.status = 'Completed';
            saveData('automations', automations);
            console.log(`✅ Automation ${auto.id}: Marked as completed`);
            return;
        }

        if (auto.next_run_at) {
            const remaining = new Date(auto.next_run_at).getTime() - Date.now();
            if (remaining > 0) {
                console.log(`⏰ Automation ${auto.id}: Waiting ${Math.round(remaining / 60000)}min`);
                setTimeout(() => {
                    const current = automations.find(a => a.id === auto.id);
                    if (current && current.status !== 'Stopped') {
                        runAutomation(auto.id);
                    }
                }, remaining);
                return;
            }
        }

        console.log(`📦 Resuming Automation ${auto.id}: Run ${auto.current_run + 1}/${auto.total_runs}`);
        setImmediate(() => runAutomation(auto.id));
    });
}

// ============ START SERVER ============
async function startServer() {
    await initializeApp();
    startKeepAlive();

    server.listen(PORT, () => {
        console.log('\n' + '='.repeat(55));
        console.log('  🚀 SMM Panel Server');
        console.log('='.repeat(55));
        console.log(`  📁 Data Directory : ${DATA_DIR}`);
        console.log(`  🌐 Port           : ${PORT}`);
        console.log(`  👥 Users          : ${users.length}`);
        console.log(`  📦 Services Cache : ${servicesCache.length}`);
        console.log(`  ⚙️  Automations    : ${automations.length}`);
        console.log(`  👑 Admin Key      : ${ADMIN_SECRET}`);
        console.log(`  💱 USD/BDT Rate   : ${settings.usd_to_bdt_rate}`);
        console.log('='.repeat(55) + '\n');

        setTimeout(resumeIncompleteAutomations, 5000);
    });
}

startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});

// ============ GRACEFUL SHUTDOWN ============
process.on('SIGTERM', async () => {
    console.log('\n⚠️ Shutting down gracefully...');
    await saveData('automations', automations);
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('\n⚠️ Shutting down...');
    await saveData('automations', automations);
    process.exit(0);
});
