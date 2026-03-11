# Kraking

A desktop application for managing and monitoring your Kraken cryptocurrency trading account. Built with Electron, TypeScript, Python Flask, and SQLite.

## Features

- **User Authentication** - Secure login and account management with JWT tokens
- **Open Orders Monitoring** - Real-time view of your active Kraken orders with auto-refresh every 15 seconds
- **Profile Management** - Update your username, password, and Kraken API keys
- **Dark Theme UI** - Modern, responsive interface optimized for trading
- **Auto-refresh** - Orders automatically refresh without manual intervention
- **Secure API Integration** - Your Kraken API keys are stored securely and used for authenticated requests

## Tech Stack

**Frontend:**
- Electron (Desktop app framework)
- TypeScript
- HTML/CSS
- Vanilla JavaScript (no framework)

**Backend:**
- Python 3.11+
- Flask (REST API)
- SQLite (Database)
- Kraken API integration

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v18 or higher) - [Download here](https://nodejs.org/)
- **Python** (3.11 or higher) - [Download here](https://www.python.org/downloads/)
- **Git** - [Download here](https://git-scm.com/)

**Note:** SQLite is included with Python's standard library, so no separate database installation is required.

---

## Installation Guide

### 1. Clone the Repository

```bash
git clone <repository-url>
cd Kraking
```

### 2. Backend Setup (Python/Flask)

1. **Navigate to backend directory**
   ```bash
   cd src/backend
   ```

2. **Create Python Virtual Environment**
   
   **Windows:**
   ```cmd
   python -m venv venv
   venv\Scripts\activate
   ```

   **macOS/Linux:**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

3. **Install Python Dependencies**
   ```bash
   pip install -r requirements.txt
   pip install pyinstaller
   ```
   
   **Note:** PyInstaller is needed for building the distributable executable. Install it now to avoid issues later.

4. **Create `.env` File** (Optional)
   
   Create a file named `.env` in the project root directory (`Kraking/.env`) if you want to customize settings:

   ```env
   # Application
   SECRET_KEY=change-this-to-a-random-secret-key-min-32-chars
   API_PORT=5000
   
   # Database (optional - defaults to src/backend/kraking.db)
   DATABASE_PATH=kraking.db
   ```

   **Important:** Change `SECRET_KEY` to a random string (at least 32 characters)
   
   **Note:** The SQLite database file will be created automatically on first run. No manual database setup required!

5. **Test Backend**
   ```bash
   python Server.py
   ```
   
   You should see:
   ```
   [DATABASE] Tables created/verified successfully
    * Running on http://127.0.0.1:5000
   ```

6. **Keep backend running** or press `Ctrl+C` to stop when done testing

### 3. Frontend Setup (Node.js/Electron)

1. **Open a NEW terminal** and navigate to project root
   ```bash
   cd Kraking
   ```

2. **Install Node Dependencies**
   ```bash
   npm install
   ```

3. **Compile TypeScript**
   ```bash
   npm run build
   ```
   
   Or use watch mode (auto-recompiles on changes):
   ```bash
   npm run watch
   ```

---

## Running the Application

### Start Backend (Terminal 1)

```bash
cd src/backend
# Activate virtual environment first
# Windows: venv\Scripts\activate
# macOS/Linux: source venv/bin/activate
python Server.py
```

### Start Frontend (Terminal 2)

```bash
cd Kraking
npm start
```

The Electron desktop app will launch automatically.

---

## First-Time Usage

1. **Create an Account**
   - On first launch, click **"Create Account"**
   - Enter a username (min 3 characters)
   - Enter a password (min 6 characters)
   - Enter your **Kraken API Key** and **Kraken Private Key**
     - Get these from [Kraken API Settings](https://www.kraken.com/u/security/api)
     - Required permissions: Query Open Orders & Closed Orders, Query Funds
   - Click **"Create Account"**

2. **Login**
   - Enter your username and password
   - Click **"Sign In"**

3. **View Open Orders**
   - Click **"Open Orders"** in the navigation menu
   - Your active Kraken orders will load and auto-refresh every 15 seconds

4. **Update Profile**
   - Click **"Profile"** to update your username, password, or API keys

---

## Project Structure

```
Kraking/
├── src/
│   ├── index.html                 # Main HTML entry point
│   ├── app/
│   │   ├── app.ts                # Route registration
│   │   ├── router.ts             # SPA routing logic
│   │   ├── app.config.ts         # Frontend config
│   │   ├── models/               # TypeScript interfaces
│   │   ├── services/             # API data layer
│   │   │   ├── dataaccess.ts    # HTTP client
│   │   │   ├── krakendata.ts    # Kraken endpoints
│   │   │   └── controllers/     # Business logic
│   │   ├── viewmodels/           # Page controllers
│   │   ├── views/                # HTML partials
│   │   └── styles/               # CSS files
│   ├── backend/
│   │   ├── Server.py             # Flask app entry point
│   │   ├── Routes.py             # Blueprint registration
│   │   ├── controllers/          # API controllers
│   │   ├── helper/               # Utilities
│   │   │   ├── KrakenClient.py  # Kraken API client
│   │   │   └── Security.py      # JWT & bcrypt
│   │   └── models/               # Python data models
│   └── assets/                   # Images, icons
├── dist/                         # Compiled TypeScript
├── .env                          # Environment variables
├── package.json                  # Node dependencies
├── tsconfig.json                # TypeScript config
└── README.md                    # This file
```

---

## Development

### TypeScript Development

Use watch mode to auto-compile TypeScript on file changes:

```bash
npm run watch
```

### Backend Development

Flask debug mode is enabled by default in `Server.py`. The server will auto-reload on Python file changes.

---

## Building for Distribution

To package the application into a standalone Windows installer (.exe) that users can install and run without needing Python or Node.js:

### Prerequisites

The build dependencies should already be installed if you followed the initial setup:

- **PyInstaller** - Installed in `src/backend/venv` during backend setup
- **electron-builder** - Install now if not already installed:

```bash
npm install --save-dev electron-builder
```

### Building the Installer

**Manual Build Process (Recommended):**

```bash
# 1. Compile TypeScript
npm run build

# 2. Activate venv and build Python backend
cd src/backend
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Build backend executable
pyinstaller server.spec

# Deactivate and return to root
deactivate
cd ../..

# 3. Create installer
npm run dist
```

### Build Output

After building, you'll find the installer at:

```
release/Kraking Setup 1.0.0.exe
```

### What the Installer Includes

The installer is a completely self-contained package that includes:
- Electron desktop application
- Python Flask backend server (compiled as executable)
- All dependencies (no separate Python or Node.js installation needed)
- SQLite database engine (built into Python)

### How It Works for End Users

When a user installs and runs your application:

1. **Installation:** User runs `Kraking Setup 1.0.0.exe` and chooses install location (default: `C:\Program Files\Kraking`)
2. **Launch:** User opens Kraking from Start Menu or Desktop shortcut
3. **Auto-Start Backend:** Electron automatically starts the Python backend in the background
4. **Database:** SQLite database is created in user's AppData folder (`%APPDATA%\Kraking\kraking.db`)
5. **Data Storage:** All user data (accounts, API keys, automation rules) stored locally in their SQLite database
6. **Shutdown:** When user closes the app, the backend process automatically terminates

### Distribution

The `Kraking Setup 1.0.0.exe` file can be distributed to users who can then:
- Double-click to install
- No need to install Python, Node.js, or MySQL
- No manual database setup required
- Works completely offline
- All data stored locally and securely

### Optional: Code Signing

For production distribution, consider code signing your executable to avoid Windows SmartScreen warnings:

1. Obtain a code signing certificate
2. Update `package.json` build config with certificate details
3. Rebuild with signing enabled

Without code signing, users may see a "Windows protected your PC" warning on first install (they can click "More info" → "Run anyway").

---

## Troubleshooting

### Backend Issues

**Error: `ModuleNotFoundError: No module named 'flask'`**
- Activate your virtual environment
- Run `pip install -r requirements.txt`

**Error: `CORS policy` in browser console**
- Ensure backend is running on `http://127.0.0.1:5000`
- Check CSP in `index.html` allows `connect-src 'self' http://127.0.0.1:5000`

### Frontend Issues

**Error: `tsc is not recognized`**
- Run `npm install -g typescript` or use `npx tsc`

**Blank screen on launch**
- Open DevTools (View → Toggle Developer Tools)
- Check for JavaScript errors in console
- Verify all scripts in `index.html` are compiled (check `dist/` folder)

**API errors "Not authenticated"**
- Clear localStorage and re-login
- Check browser console for token errors

### Database Issues

**Database file locked or permission errors**
- Ensure only one instance of the backend is running
- Check file permissions on the `kraking.db` file
- On Windows, ensure no antivirus is blocking the database file

**Want to reset the database?**
- Stop the backend server
- Delete the `kraking.db` file in `src/backend/`
- Restart the server - a fresh database will be created automatically

---

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login

### User Management
- `GET /api/user/profile` - Get user profile
- `PUT /api/user/update-username` - Update username
- `PUT /api/user/update-password` - Update password
- `PUT /api/user/update-keys` - Update Kraken API keys
- `DELETE /api/user/delete` - Delete account

### Kraken Integration
- `GET /api/kraken/open-orders` - Fetch open orders from Kraken

---

## Security Notes

- **Kraken API keys are encrypted** using Fernet symmetric encryption (AES-128) before storage
  - The encryption key is derived from your Flask `SECRET_KEY` using SHA-256
  - Keys are automatically encrypted during registration and profile updates
  - Keys are decrypted only when making API calls to Kraken
  - **Important:** If you have existing users with unencrypted keys, they must re-enter their keys through the profile page
- JWT tokens expire after 30 days
- Passwords are hashed with bcrypt (salt rounds: 12)
- All API requests use prepared SQL statements to prevent injection
- CORS is enabled only for `http://127.0.0.1:5000`
- **Security Best Practice:** Keep your `.env` file private and never commit it to version control

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to your branch
5. Create a Pull Request

---

## License

This project is licensed under the ISC License.

---

## Support

If you find this project helpful, consider donating:

- **Bitcoin:** `32BJw5mpyQ6fuLeiR5yrAAR2H8gerB9GAD`
- **Ethereum:** `0xc0066CCD708376cF3fA34CF5a3a8eB88AF58c97A`
- **Solana:** 7vfBGpjZTEZEsKNi1ZdYYBPGq1uFzWvLuV6xRP13tSo9
- **XRP/Tag:** rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh / 204756592

---

## Disclaimer

This software is provided as-is. Use at your own risk. The developers are not responsible for any financial losses incurred through the use of this application. Always verify trades and orders directly on the Kraken platform.