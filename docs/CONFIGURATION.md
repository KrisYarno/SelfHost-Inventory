# Inventory App Configuration Guide

This guide explains all environment variables and configuration options for the Inventory App.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Environment Files](#environment-files)
3. [Required Environment Variables](#required-environment-variables)
4. [Optional Environment Variables](#optional-environment-variables)
5. [Database Configuration](#database-configuration)
6. [Authentication Setup](#authentication-setup)
7. [Email Configuration](#email-configuration)
8. [Environment-Specific Scripts](#environment-specific-scripts)
9. [Security Best Practices](#security-best-practices)
10. [Troubleshooting](#troubleshooting)

## Quick Start

1. Copy the appropriate example file:
   ```bash
   # For local development
   cp .env.development.example .env.local
   
   # For production
   cp .env.production.example .env.production
   ```

2. Update the values in your `.env.local` file

3. Generate a secure NextAuth secret:
   ```bash
   openssl rand -base64 32
   ```

4. Run the development server:
   ```bash
   npm run dev
   ```

## Environment Files

The app uses different environment files for different purposes:

| File | Purpose | Git Ignored | Notes |
|------|---------|-------------|--------|
| `.env` | Default values | No | Basic Prisma config only |
| `.env.local` | Local development secrets | Yes | Your actual dev config |
| `.env.production` | Production secrets | Yes | Production deployment |
| `.env.development` | Dev defaults | No | Can be committed |
| `.env.test` | Test environment | No | For automated tests |

### Loading Order

Next.js loads environment variables in this order (first match wins):
1. `.env.$(NODE_ENV).local`
2. `.env.local` (not loaded when NODE_ENV=test)
3. `.env.$(NODE_ENV)`
4. `.env`

## Required Environment Variables

### DATABASE_URL

**Description**: MySQL database connection string  
**Format**: `mysql://USER:PASSWORD@HOST:PORT/DATABASE?parameters`  
**Required**: Yes

Example configurations:

```bash
# Local development
DATABASE_URL="mysql://root:password@localhost:3306/inventory_dev"

# Production with SSL
DATABASE_URL="mysql://prod_user:SecurePass123!@db.example.com:3306/inventory_prod?ssl={\"rejectUnauthorized\":true}&connection_limit=20"

# Read-only development access to live database
DATABASE_URL="mysql://readonly_user:password@prod-db.example.com:3306/inventory_prod?connection_limit=2"
```

**Connection Parameters**:
- `connection_limit`: Maximum connections in pool (default: 2, recommended: 5-20)
- `connect_timeout`: Connection timeout in seconds (default: 10)
- `pool_timeout`: Wait time for available connection (default: 10)
- `socket_timeout`: Query response timeout (default: 10)
- `ssl`: SSL/TLS configuration object

### NEXTAUTH_URL

**Description**: The canonical URL of your site  
**Format**: Full URL without trailing slash  
**Required**: Yes

Examples:
```bash
# Development
NEXTAUTH_URL="http://localhost:3000"

# Production
NEXTAUTH_URL="https://inventory.yourdomain.com"
```

### NEXTAUTH_SECRET

**Description**: Secret used to encrypt JWT tokens  
**Format**: Random string (min 32 characters)  
**Required**: Yes

Generate with:
```bash
openssl rand -base64 32
```

**Important**: Use different secrets for each environment!

### GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET

**Description**: Google OAuth 2.0 credentials  
**Required**: Yes (for Google sign-in)

Setup instructions:
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project
3. Configure OAuth consent screen and scopes (basic profile/email)
4. Create OAuth 2.0 credentials
5. Configure authorized origins and redirect URIs:
   - Authorized JavaScript origins:
     - Development: `http://localhost:3000`
     - Local staging: `https://inventorylocal.artech.tools`
     - Production: `https://inventory.yourdomain.com`
   - Authorized redirect URIs:
     - Development: `http://localhost:3000/api/auth/callback/google`
     - Local staging: `https://inventorylocal.artech.tools/api/auth/callback/google`
     - Production: `https://inventory.yourdomain.com/api/auth/callback/google`

### ALLOWED_EMAIL_DOMAINS

**Description**: Comma-separated list of allowed Google Workspace email domains  
**Required**: Yes (for Google sign-in)

Examples:
```bash
ALLOWED_EMAIL_DOMAINS=advancedresearchpep.com
ALLOWED_EMAIL_DOMAINS=advancedresearchpep.com,artech.tools
ALLOWED_EMAIL_DOMAINS=*   # allow any domain (testing only)
```

### SENDGRID_API_KEY

**Description**: SendGrid API key for sending emails  
**Required**: Yes

Get from: [SendGrid API Keys](https://app.sendgrid.com/settings/api_keys)  
Required permissions: Mail Send

### FROM_EMAIL

**Description**: Sender email address  
**Format**: Valid email address  
**Required**: Yes

Must be a verified sender in SendGrid.

## Optional Environment Variables

### Development Tools

```bash
# Enable debug logging
NEXTAUTH_DEBUG="true"              # NextAuth debug mode
LOG_API_REQUESTS="true"            # Log all API requests
PRETTY_LOGS="true"                 # Format logs for readability
SHOW_ERROR_DETAILS="true"          # Show detailed errors

# Development features
ENABLE_DEV_TOOLS="true"            # Enable dev-only features
SHOW_PERFORMANCE_METRICS="true"    # Display performance data
ENABLE_MOCK_DATA="true"            # Use mock data
AUTO_SEED_DB="false"               # Seed DB on startup
```

### Production Monitoring

```bash
# Error tracking
SENTRY_DSN="https://key@sentry.io/project"
SENTRY_ENVIRONMENT="production"
SENTRY_RELEASE="inventory-app@1.0.0"

# Analytics
GA_TRACKING_ID="G-XXXXXXXXXX"

# APM
NEW_RELIC_LICENSE_KEY="your-key"
```

### Performance & Scaling

```bash
# Caching
REDIS_URL="redis://localhost:6379"

# Rate limiting
RATE_LIMIT_PER_MINUTE="100"
RATE_LIMIT_PER_DAY="10000"

# CDN
CDN_URL="https://cdn.yourdomain.com"
```

## Database Configuration

### Connecting to Existing Database (Caution with Migrations)

When working with a live/production database:

1. **Use read-only credentials for development**:
   ```bash
   DATABASE_URL="mysql://readonly_user:password@prod-db.example.com:3306/inventory?connection_limit=2"
   ```

2. **Introspect the existing database**:
   ```bash
   npx prisma db pull
   ```

3. **Generate Prisma Client**:
   ```bash
   npx prisma generate
   ```

4. **DO NOT RUN** schema-changing commands directly on production data:
   - Avoid `prisma migrate dev`, `prisma db push` on production.
   - For fresh production databases, use `prisma migrate deploy` with a committed baseline.
   - For importing production into local/staging, use `db push` to reconcile schema safely.

### Creating a Safe Development Database

Option 1: Local MySQL with production schema:
```bash
# 1. Export schema only (no data) from production
mysqldump -h prod-db.example.com -u readonly_user -p --no-data inventory > schema.sql

# 2. Import to local MySQL
mysql -u root -p inventory_dev < schema.sql

# 3. Update .env.local
DATABASE_URL="mysql://root:password@localhost:3306/inventory_dev"
```

Option 2: Docker MySQL container:
```bash
# 1. Start MySQL container
docker run --name inventory-mysql \
  -e MYSQL_ROOT_PASSWORD=password \
  -e MYSQL_DATABASE=inventory_dev \
  -p 3306:3306 \
  -d mysql:8.0

# 2. Import production schema
docker exec -i inventory-mysql mysql -u root -ppassword inventory_dev < schema.sql
```

### Database User Permissions

For production, create a user with minimal permissions:

```sql
-- Create application user
CREATE USER 'inventory_app'@'%' IDENTIFIED BY 'strong_password';

-- Grant only necessary permissions
GRANT SELECT, INSERT, UPDATE ON inventory.* TO 'inventory_app'@'%';

-- For specific tables that need DELETE
GRANT DELETE ON inventory.sessions TO 'inventory_app'@'%';

-- Apply changes
FLUSH PRIVILEGES;
```

## Authentication Setup

### Google OAuth Configuration

1. **Create OAuth 2.0 Credentials**:
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Navigate to APIs & Services > Credentials
   - Click "Create Credentials" > "OAuth 2.0 Client ID"
   - Choose "Web application"

2. **Configure OAuth Settings**:
   ```
   Application name: Inventory App (Development/Production)
   
   Authorized JavaScript origins:
   - http://localhost:3000 (dev)
   - https://inventory.yourdomain.com (prod)
   
   Authorized redirect URIs:
   - http://localhost:3000/api/auth/callback/google (dev)
   - https://inventory.yourdomain.com/api/auth/callback/google (prod)
   ```

3. **Update Environment Variables**:
   ```bash
   GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="your-client-secret"
   ```

### Session Configuration

Sessions are configured in `lib/auth.ts`:
- Session duration: 12 hours
- JWT max age: 7 days
- Strategy: JWT (stateless)

To modify session settings, update the environment variables:
```bash
# Custom session duration (seconds)
SESSION_MAX_AGE="43200"  # 12 hours

# JWT settings
JWT_MAX_AGE="604800"     # 7 days
```

## Email Configuration

### SendGrid Setup

1. **Create SendGrid Account**: Sign up at [sendgrid.com](https://sendgrid.com)

2. **Verify Sender**:
   - Go to Settings > Sender Authentication
   - Add and verify your sender email address

3. **Create API Key**:
   - Go to Settings > API Keys
   - Click "Create API Key"
   - Select "Restricted Access"
   - Enable "Mail Send" permission only

4. **Configure Environment**:
   ```bash
   SENDGRID_API_KEY="SG.your-api-key"
   FROM_EMAIL="inventory@yourdomain.com"
   ```

### Email Templates

The app sends emails for:
- User approval notifications
- User rejection notifications
- Admin notifications for new users

Templates are located in `lib/email.ts`.

### Testing Emails Locally

Option 1: Use SendGrid Sandbox Mode:
```javascript
// In lib/email.ts
mail_settings: {
  sandbox_mode: {
    enable: process.env.NODE_ENV === 'development'
  }
}
```

Option 2: Use a mail trap service:
- [Mailtrap](https://mailtrap.io)
- [MailHog](https://github.com/mailhog/MailHog)
- [Ethereal Email](https://ethereal.email)

## Environment-Specific Scripts

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "dev:staging": "dotenv -e .env.staging next dev",
    "build": "next build",
    "build:prod": "NODE_ENV=production next build",
    "start": "next start",
    "start:prod": "NODE_ENV=production next start",
    "lint": "next lint",
    "type-check": "tsc --noEmit",
    "env:check": "node scripts/check-env.js",
    "env:generate": "node scripts/generate-env.js",
    "db:pull": "prisma db pull",
    "db:generate": "prisma generate",
    "db:studio": "prisma studio",
    "db:seed": "ts-node --compiler-options '{\"module\":\"CommonJS\"}' prisma/seed.ts"
  }
}
```

## Security Best Practices

### 1. Environment Variable Security

- **Never commit** `.env.local`, `.env.production`, or any file with real secrets
- Use **different secrets** for each environment
- **Rotate secrets** regularly (every 90 days)
- Use a **secrets manager** in production (AWS Secrets Manager, HashiCorp Vault)

### 2. Database Security

- Use **SSL/TLS** for database connections in production
- Create **read-only users** for development
- Use **connection pooling** with appropriate limits
- Enable **query logging** for audit trails
- Regular **backups** with tested restore procedures

### 3. Authentication Security

- Use **strong NextAuth secrets** (min 32 characters)
- Enable **HTTPS only** in production
- Set **secure cookie** options
- Implement **session timeout**
- Use **CSRF protection**

### 4. API Security

- Implement **rate limiting**
- Use **API keys** for external services
- Enable **CORS** with specific origins
- Log **all API access**
- Monitor for **suspicious activity**

## Troubleshooting

### Common Issues

**1. Database Connection Failed**
```
Error: Can't connect to MySQL server
```
Solution:
- Check DATABASE_URL format
- Verify database server is running
- Check firewall/security group rules
- Test connection with mysql CLI

**2. NextAuth Error**
```
[next-auth][error][CLIENT_FETCH_ERROR]
```
Solution:
- Verify NEXTAUTH_URL matches your site URL
- Check NEXTAUTH_SECRET is set
- Ensure OAuth redirect URIs are correct
- Check browser console for CORS errors

**3. Email Not Sending**
```
Error: Unauthorized - SendGrid
```
Solution:
- Verify SENDGRID_API_KEY is correct
- Check sender email is verified
- Ensure API key has Mail Send permission
- Check SendGrid account is active

### Debug Mode

Enable debug logging:
```bash
# .env.local
NODE_ENV="development"
NEXTAUTH_DEBUG="true"
LOG_LEVEL="debug"
DEBUG="*"
```

### Environment Validation

Create a validation script `scripts/check-env.js`:
```javascript
const required = [
  'DATABASE_URL',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SENDGRID_API_KEY',
  'FROM_EMAIL'
];

const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('Missing required environment variables:');
  missing.forEach(key => console.error(`- ${key}`));
  process.exit(1);
}

console.log('✅ All required environment variables are set');
```

Run before starting the app:
```bash
npm run env:check && npm run dev
```

## Support

For additional help:
1. Check the [Next.js documentation](https://nextjs.org/docs)
2. Review [NextAuth.js documentation](https://next-auth.js.org)
3. See [Prisma documentation](https://www.prisma.io/docs)
4. Contact your system administrator
