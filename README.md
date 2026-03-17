# Cyrus

A desktop application for automating and monitoring cryptocurrency trading across multiple exchanges. Built with Electron, TypeScript, Python Flask, and SQLite.

## Features

- **User Authentication** - Secure login and account management with JWT tokens
- **Multi-Exchange Support** - Connect and manage multiple exchange accounts simultaneously
- **Open Orders Monitoring** - Real-time view of open orders with auto-refresh every 15 seconds
- **Custom Automation Rules** - Automate actions when orders fill or balance thresholds are hit
  - Withdraw crypto to a saved address
  - Convert one asset to another
  - Trigger on order filled or balance threshold
  - Configurable cooldown periods
- **Desktop Notifications** - Get notified when an automation rule executes (toggleable per user)
- **Profile Management** - Update username, password, exchange API keys, and notification preferences
- **Help Tooltips** - Inline guidance on every field in the automation form
- **Dark Theme UI** - Modern, responsive cyber-styled interface
- **Secure API Integration** - Exchange API keys are encrypted at rest

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
- CCXT (Multi-exchange API library)

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v18 or higher) - [Download here](https://nodejs.org/)
- **Python** (3.11 or higher) - [Download here](https://www.python.org/downloads/)
- **Git** - [Download here](https://git-scm.com/)

**Note:** SQLite is included with Python's standard library, so no separate database installation is required.

---
## Desktop Application Installation Guide 

### 1. To the right of this page, click Releases

### 2. Click Cyrus.Setup.X.X.X.exe

### 3. Wait for the download to finish

### 4. Complete the installation guide

## Code Installation Guide 

### 1. Clone the Repository

```bash
git clone <repository-url>
cd Cyrus
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
   
   Create a file named `.env` in the project root directory (`Cyrus/.env`) if you want to customize settings:

   ```env
   # Application
   SECRET_KEY=change-this-to-a-random-secret-key-min-32-chars
   API_PORT=5000
   
   # Database (optional - defaults to src/backend/cyrus.db)
   DATABASE_PATH=cyrus.db
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
   cd Cyrus
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
cd Cyrus
npm start
```

The Electron desktop app will launch automatically.

---

## First-Time Usage

1. **Create an Account**
   - On first launch, click **"Create Account"**
   - Enter a username (min 3 characters)
   - Enter a password (min 6 characters)
   - Click **"Create Account"**

2. **Login**
   - Enter your username and password
   - Click **"Sign In"**

3. **Add an Exchange Connection**
   - Go to **Profile** → **Exchange Connections**
   - Select your exchange, enter your API key and secret, and click **Add Connection**
   - Click **Test** to validate the connection

4. **View Open Orders**
   - Click **"Open Orders"** in the navigation menu
   - Select your exchange from the side panel
   - Orders auto-refresh every 15 seconds

5. **Create an Automation Rule**
   - Click **"Custom Commands"** in the navigation menu
   - Fill in the trigger (order filled or balance threshold) and the action (withdraw or convert)
   - Click **"Create Rule"**

6. **Update Profile**
   - Click **"Profile"** to update your username, password, API keys, or notification preferences

---

## Project Structure

```
Cyrus/
├── src/
│   ├── index.html                 # Main HTML entry point
│   ├── app/
│   │   ├── app.ts                # Route registration
│   │   ├── router.ts             # SPA routing logic
│   │   ├── app.config.ts         # Frontend config
│   │   ├── models/               # TypeScript interfaces
│   │   ├── services/             # API data layer
│   │   │   ├── dataaccess.ts    # HTTP client
│   │   │   ├── userdata.ts      # User endpoints
│   │   │   ├── exchangedata.ts  # Exchange endpoints
│   │   │   ├── automationdata.ts# Automation endpoints
│   │   │   ├── notificationservice.ts # Desktop notifications
│   │   │   └── controllers/     # Business logic
│   │   ├── viewmodels/           # Page controllers
│   │   ├── views/                # HTML partials
│   │   └── styles/               # CSS files
│   ├── backend/
│   │   ├── Server.py             # Flask app entry point
│   │   ├── Routes.py             # Blueprint registration
│   │   ├── controllers/          # API controllers + DB contexts
│   │   ├── helper/               # Utilities
│   │   │   ├── ExchangeClient.py # CCXT wrapper
│   │   │   ├── ExchangeRegistry.py # Supported exchanges
│   │   │   └── Security.py      # JWT & bcrypt
│   │   ├── automation/           # Background worker
│   │   │   └── worker.py        # Rule evaluation loop
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

**Important:** PyInstaller must be installed inside the **Cyrus venv** (not a system or other project venv) so it can find all dependencies like ccxt.

```bash
npm install --save-dev electron-builder
```

### Building the Installer

**Manual Build Process (Recommended):**

```bash
# 1. Compile TypeScript
npm run build

# 2. Activate venv and build Python backend (must be the Cyrus project venv)
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

> **Note:** Always run `pyinstaller` using the venv's own executable (`venv\Scripts\pyinstaller.exe`) to ensure it resolves packages from the correct environment.

```
release/Cyrus Setup 1.1.1.exe
```

### What the Installer Includes

The installer is a completely self-contained package that includes:
- Electron desktop application
- Python Flask backend server (compiled as executable)
- All dependencies (no separate Python or Node.js installation needed)
- SQLite database engine (built into Python)

### How It Works for End Users

When a user installs and runs your application:

1. **Installation:** User runs `Cyrus Setup 1.1.1.exe` and chooses install location (default: `C:\Program Files\Cyrus`)
2. **Launch:** User opens Cyrus from Start Menu or Desktop shortcut
3. **Auto-Start Backend:** Electron automatically starts the Python backend in the background
4. **Database:** SQLite database is created in user's AppData folder (`%APPDATA%\Cyrus\Cyrus.db`)
5. **Data Storage:** All user data (accounts, API keys, automation rules) stored locally in their SQLite database
6. **Shutdown:** When user closes the app, the backend process automatically terminates

### Distribution

The `Cyrus Setup 1.1.1.exe` file can be distributed to users who can then:
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
- Check file permissions on the `cyrus.db` file
- On Windows, ensure no antivirus is blocking the database file

**Want to reset the database?**
- Stop the backend server
- Delete the `cyrus.db` file in `src/backend/`
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
- `PUT /api/user/update-notifications` - Toggle desktop notifications
- `DELETE /api/user/delete` - Delete account

### Exchange Connections
- `GET /api/exchanges/supported` - List supported exchanges
- `GET /api/exchanges/connections` - Get user's connections
- `POST /api/exchanges/connections` - Add a new connection
- `PUT /api/exchanges/connections/<id>` - Update a connection
- `DELETE /api/exchanges/connections/<id>` - Remove a connection
- `POST /api/exchanges/connections/<id>/validate` - Validate API keys

### Exchange Data
- `GET /api/exchange/<id>/open-orders` - Fetch open orders
- `GET /api/exchange/<id>/withdrawal-addresses` - Get saved withdrawal addresses
- `GET /api/exchange/<id>/balance` - Get account balances

### Automation
- `GET /api/automation/rules` - List automation rules
- `POST /api/automation/rules` - Create a rule
- `GET /api/automation/rules/<id>` - Get a specific rule
- `PUT /api/automation/rules/<id>/toggle` - Enable/disable a rule
- `DELETE /api/automation/rules/<id>` - Delete a rule
- `GET /api/automation/withdrawal-minimums` - Get minimum withdrawal amounts
- `GET /api/automation/logs` - Get automation execution logs
- `GET /api/automation/rules/<id>/logs` - Get logs for a specific rule

---

## Security Notes

- **Exchange API keys are encrypted** using Fernet symmetric encryption (AES-128) before storage
  - The encryption key is derived from your Flask `SECRET_KEY` using SHA-256
  - Keys are automatically encrypted on save and decrypted only when making API calls
- JWT tokens expire after 30 days
- Passwords are hashed with bcrypt (salt rounds: 12)
- All API requests use prepared SQL statements to prevent injection
- CORS is restricted to `http://127.0.0.1:5000`
- **Security Best Practice:** Keep your `.env` file private and never commit it to version control
- **Database:** Stored in `%APPDATA%\Cyrus\` — never deleted by uninstall or updates

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

This software is provided as-is. Use at your own risk. The developers are not responsible for any financial losses incurred through the use of this application. Always verify trades and orders directly on the Exchange's platform.
