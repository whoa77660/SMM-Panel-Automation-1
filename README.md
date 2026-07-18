# 🚀 SMM Panel Automation Server

A premium, social media marketing (SMM) panel automation server built with Node.js, Express, and Firebase Realtime Database. It manages orders, favorites, packages, and recurring automations with robust hybrid storage (Firebase + Local backup).

---

## 🌟 Key Features

*   **⚡ Hybrid Database Synchronization**: Primary storage on Firebase Realtime Database with automatic local JSON backups. Auto-populates Firebase if it starts empty.
*   **🤖 Multi-Run Automation Engine**: Queue, execute, and monitor recurring multi-service social media campaigns (e.g., repeating runs at custom intervals).
*   **👑 Admin Dashboard**: Generate registration keys, manage users, configure live USD/BDT exchange rates, and force API service refreshes.
*   **🔑 Secure Key Registration**: Controlled user registration using system-generated invite/registration keys.
*   **📦 Package and Settings Sharing**: Users can publish their service templates and import shared packages created by others.
*   **🎛️ Command Line Utils**: Direct database tools for manual verification, backups, restorations, and statistics.
*   **🔄 Keep-Alive Engine**: Pre-configured keep-alive intervals for cloud server deployments (like Render) to prevent idle spin-downs.

---

## 🛠️ Technology Stack

*   **Backend**: Node.js & Express
*   **Template Engine**: EJS (Embedded JavaScript)
*   **Styling**: Modern, responsive CSS with glassmorphism, gradients, and micro-animations
*   **Database**: Firebase Realtime Database (Primary) & Local JSON files (Backup fallback)
*   **APIs**: Axios client calling the [smmgen.com](https://smmgen.com) API (v2)

---

## 📁 Directory Structure

```text
SMM_Panel/
├── server.js              # Core Application Entrypoint & Middleware
├── firebaseService.js     # Firebase Admin SDK Wrapper (CRUD & collections mapping)
├── firebaseUtils.js       # CLI Tool for verification, backups, and restores
├── Service-account.json   # Google Cloud service account credentials (git-ignored)
├── .env                   # Environment configurations (git-ignored)
│
├── views/                 # EJS UI Page Templates
│   ├── index.ejs          # Authentication & Login Page
│   ├── new_order.ejs      # User Panel & Automation Dashboard
│   └── admin.ejs          # Admin Control Center
│
├── data/                  # Local JSON Database Backups (git-ignored)
│   ├── users.json
│   ├── registration_keys.json
│   ├── favorites.json
│   ├── package_services.json
│   ├── shared_packages.json
│   ├── automations.json
│   ├── services_cache.json
│   └── settings.json
│
└── package.json           # Project Metadata & Dependency manifests
```

---

## 🚀 Quick Start Guide

### 1. Installation
Install the project dependencies:
```bash
npm install
```

### 2. Environment Configuration
Create a `.env` file in the root directory (already configured locally):
```env
DATABASE=https://your-firebase-project-default-rtdb.firebaseio.com/
PORT=11958
KEEP_ALIVE_URL=http://localhost:11958/
```

### 3. Firebase Service Account credentials
Place your Google Cloud/Firebase Service Account JSON file in the root folder and name it `Service-account.json`.

### 4. Running the Server
Start the application:
```bash
node server.js
```

Upon launching:
*   The server will initialize Firebase.
*   If Firebase is empty, it will auto-upload your local `data/*.json` files to populate the database.
*   The server will listen on `http://localhost:11958`.

---

## 👑 Authentication & Admin Access

*   **Default Admin Credentials**:
    *   To access the Admin Panel, visit `http://localhost:11958/admin` or click **Admin Access** on the homepage.
    *   Enter the Secret Key: `ADMIN2025` to log in as the default administrator.
*   **Invite/Registration System**:
    *   Admins generate invite keys via the admin portal.
    *   New users click the **Register** tab on the home screen, inputting their username, the generated registration key, and their SMM API key to create an account.

---

## 🔧 Database Utilities CLI

The `firebaseUtils.js` script allows you to manage synchronization manually:

| Command | Action |
| :--- | :--- |
| `node firebaseUtils.js --verify` | Test the connection to your Firebase Realtime Database. |
| `node firebaseUtils.js --stats` | View database collection statistics (item count per table). |
| `node firebaseUtils.js --backup` | Manually download all Firebase collections to local JSON files. |
| `node firebaseUtils.js --restore` | Manually upload local JSON backup files to Firebase. |
| `node firebaseUtils.js --sync` | Run a two-way synchronization sequence (Backup followed by Restore). |

---

## 🔐 Security Recommendations

1.  **Git Ignore Checklist**: Ensure you do not commit sensitive keys. Add the following to your `.gitignore`:
    ```text
    node_modules/
    .env
    Service-account.json
    data/
    SMM_Panel.zip
    ```
2.  **Firebase Rules**: Configure your database rules to limit unauthorized access.
3.  **API Rotation**: Regularly rotate your service account keys via the Firebase Console.
