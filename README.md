# Kraking

A desktop application for managing and monitoring your Kraken cryptocurrency trading account. Built with Electron, TypeScript, Python Flask, and MySQL.

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
- MySQL (Database)
- Kraken API integration

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v18 or higher) - [Download here](https://nodejs.org/)
- **Python** (3.11 or higher) - [Download here](https://www.python.org/downloads/)
- **MySQL Server** (8.0 or higher) - See installation guide below
- **Git** - [Download here](https://git-scm.com/)

---

## Installation Guide

### 1. MySQL Server Setup

#### Windows

1. **Download MySQL Installer**
   - Go to [MySQL Community Downloads](https://dev.mysql.com/downloads/installer/)
   - Download the **MySQL Installer for Windows** (mysql-installer-web-community-X.X.X.msi)

2. **Run the Installer**
   - Double-click the downloaded `.msi` file
   - Choose **"Custom"** setup type
   - Select the following components:
     - MySQL Server 8.0.x
     - MySQL Workbench (optional, for GUI management)

3. **Configure MySQL Server**
   - Click **"Execute"** to install selected components
   - After installation, the configuration wizard will start:
     - **Config Type:** Development Computer
     - **Port:** 3306 (default)
     - **Authentication Method:** Use Strong Password Encryption
     - **Root Password:** Set a strong password (remember this!)
     - **User Accounts:** Create a user called `kraking_user` with a password (or use root)
     - Click **"Execute"** to apply configuration

4. **Verify Installation**
   - Open Command Prompt
   - Run: `mysql --version`
   - You should see the MySQL version displayed

5. **Start MySQL Service** (if not auto-started)
   ```cmd
   net start MySQL80
   ```

#### macOS

1. **Download MySQL**
   - Go to [MySQL Community Downloads](https://dev.mysql.com/downloads/mysql/)
   - Download the macOS DMG Archive

2. **Install MySQL**
   - Open the downloaded `.dmg` file
   - Run the installer package
   - Follow the installation wizard
   - **Important:** Save the temporary root password shown at the end

3. **Add MySQL to PATH**
   ```bash
   echo 'export PATH="/usr/local/mysql/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   ```

4. **Secure Installation**
   ```bash
   sudo mysql_secure_installation
   ```
   - Enter the temporary root password
   - Set a new root password
   - Answer Yes to security questions

5. **Start MySQL**
   ```bash
   sudo /usr/local/mysql/support-files/mysql.server start
   ```

#### Linux (Ubuntu/Debian)

```bash
# Update package index
sudo apt update

# Install MySQL Server
sudo apt install mysql-server

# Start MySQL service
sudo systemctl start mysql

# Enable MySQL to start on boot
sudo systemctl enable mysql

# Secure installation
sudo mysql_secure_installation
```

### 2. Create MySQL Database & User

1. **Connect to MySQL**
   ```bash
   mysql -u root -p
   ```
   Enter your root password when prompted.

2. **Create Database**
   ```sql
   CREATE DATABASE kraking_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

3. **Create User & Grant Privileges** (optional, if not done during setup)
   ```sql
   CREATE USER 'kraking_user'@'localhost' IDENTIFIED BY 'your_secure_password';
   GRANT ALL PRIVILEGES ON kraking_db.* TO 'kraking_user'@'localhost';
   FLUSH PRIVILEGES;
   EXIT;
   ```

### 3. Clone the Repository

```bash
git clone <repository-url>
cd Kraking
```

### 4. Backend Setup (Python/Flask)

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
   ```

4. **Create `.env` File**
   
   Create a file named `.env` in the project root directory (`Kraking/.env`), NOT in the backend folder:

   ```env
   # Database Configuration
   MYSQL_HOST=localhost
   MYSQL_PORT=3306
   MYSQL_USER=kraking_user
   MYSQL_PASSWORD=your_secure_password
   MYSQL_DATABASE=kraking_db

   # Application
   SECRET_KEY=change-this-to-a-random-secret-key-min-32-chars
   API_PORT=5000
   ```

   **Important:** Change `SECRET_KEY` to a random string (at least 32 characters)

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

### 5. Frontend Setup (Node.js/Electron)

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

## Troubleshooting

### Backend Issues

**Error: `mysql.connector.errors.ProgrammingError: 1045 Access denied`**
- Check your `.env` file has correct MySQL credentials
- Verify the user exists: `mysql -u kraking_user -p`
- Recreate the user (see Step 2 in MySQL setup)

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

### MySQL Issues

**Service won't start**
- Windows: `net start MySQL80`
- macOS: `sudo /usr/local/mysql/support-files/mysql.server start`
- Linux: `sudo systemctl start mysql`

**Can't connect to MySQL**
- Check MySQL is running: `mysql --version` and `mysql -u root -p`
- Verify port 3306 is not blocked by firewall
- Check `MYSQL_HOST` in `.env` is `localhost`

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
- JWT tokens expire after 24 hours
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
- **Solana:** Add your address
- **XRP:** Add your address

---

## Disclaimer

This software is provided as-is. Use at your own risk. The developers are not responsible for any financial losses incurred through the use of this application. Always verify trades and orders directly on the Kraken platform.