#!/usr/bin/env node

/**
 * Environment Variable Checker
 * 
 * This script checks if all required environment variables are set.
 * Run this before starting the application to ensure proper configuration.
 * 
 * Usage: npm run env:check
 */

const chalk = require('chalk');

// Define required environment variables
const REQUIRED_ENV_VARS = [
  {
    name: 'DATABASE_URL',
    description: 'MySQL database connection string',
    example: 'mysql://user:password@localhost:3306/inventory_db',
    validator: (value) => value.startsWith('mysql://'),
  },
  {
    name: 'NEXTAUTH_URL',
    description: 'Application URL for NextAuth',
    example: 'http://localhost:3000',
    validator: (value) => value.startsWith('http://') || value.startsWith('https://'),
  },
  {
    name: 'NEXTAUTH_SECRET',
    description: 'Secret for JWT encryption',
    example: 'Generated with: openssl rand -base64 32',
    validator: (value) => value.length >= 32,
  },
  {
    name: 'GOOGLE_CLIENT_ID',
    description: 'Google OAuth client ID',
    example: 'your-client-id.apps.googleusercontent.com',
    validator: (value) => value.endsWith('.apps.googleusercontent.com'),
  },
  {
    name: 'GOOGLE_CLIENT_SECRET',
    description: 'Google OAuth client secret',
    example: 'your-client-secret',
    validator: (value) => value.length > 0,
  },
  {
    name: 'ENCRYPTION_KEY',
    description: 'AES-256-GCM key for encrypting integration credentials at rest (base64, 32 bytes)',
    example: 'Generated with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    validator: (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
  },
];

// Optional environment variables
// (SendGrid/CRON_SECRET/etc are not "required" here because the code
// degrades gracefully without them — see lib/email.ts and the /api/cron/*
// routes — even though they gate real functionality.)
const OPTIONAL_ENV_VARS = [
  { name: 'NODE_ENV', description: 'Environment mode', default: 'development' },
  { name: 'ALLOWED_EMAIL_DOMAINS', description: 'Comma-separated Google Workspace domains allowed to sign up/in', default: 'advancedresearchpep.com' },
  { name: 'SENDGRID_API_KEY', description: 'SendGrid API key for emails (unset = emails silently skipped)' },
  { name: 'SENDGRID_FROM_EMAIL', description: 'Sender email address for SendGrid emails', default: 'alerts@advancedresearchpep.com' },
  { name: 'TEMPLATE_ID', description: 'SendGrid dynamic template id (unset = inline HTML fallback)' },
  { name: 'CRON_SECRET', description: 'Bearer token required by /api/cron/* routes (unset = cron routes 401)' },
  { name: 'INTERNAL_SYNC_TOKEN', description: 'Shared token between app and the external-sync sidecar' },
];

// Check if we have chalk available, if not, use basic console colors
const log = {
  error: chalk ? chalk.red : console.error,
  warning: chalk ? chalk.yellow : console.warn,
  success: chalk ? chalk.green : console.log,
  info: chalk ? chalk.blue : console.log,
  dim: chalk ? chalk.gray : console.log,
};

console.log('🔍 Checking environment variables...\n');

let hasErrors = false;
let hasWarnings = false;

// Check required variables
console.log('📋 Required Environment Variables:');
console.log('─'.repeat(50));

REQUIRED_ENV_VARS.forEach(({ name, description, example, validator }) => {
  const value = process.env[name];
  
  if (!value) {
    console.log(log.error(`❌ ${name}: MISSING`));
    console.log(log.dim(`   ${description}`));
    console.log(log.dim(`   Example: ${example}`));
    hasErrors = true;
  } else if (validator && !validator(value)) {
    console.log(log.warning(`⚠️  ${name}: INVALID FORMAT`));
    console.log(log.dim(`   ${description}`));
    console.log(log.dim(`   Current: ${value.substring(0, 20)}...`));
    console.log(log.dim(`   Example: ${example}`));
    hasWarnings = true;
  } else {
    console.log(log.success(`✅ ${name}: SET`));
    if (name === 'DATABASE_URL') {
      // Parse and display database connection info (without password)
      const dbUrl = new URL(value.replace('mysql://', 'https://'));
      console.log(log.dim(`   Host: ${dbUrl.hostname}, Database: ${dbUrl.pathname.slice(1)}`));
    }
  }
});

console.log('\n📋 Optional Environment Variables:');
console.log('─'.repeat(50));

OPTIONAL_ENV_VARS.forEach(({ name, description, default: defaultValue }) => {
  const value = process.env[name];
  
  if (!value) {
    if (defaultValue) {
      console.log(log.info(`ℹ️  ${name}: NOT SET (default: ${defaultValue})`));
    } else {
      console.log(log.dim(`➖ ${name}: NOT SET`));
    }
    console.log(log.dim(`   ${description}`));
  } else {
    console.log(log.success(`✅ ${name}: ${value}`));
  }
});

// Additional checks
console.log('\n🔒 Security Checks:');
console.log('─'.repeat(50));

// Check if NEXTAUTH_SECRET looks secure
if (process.env.NEXTAUTH_SECRET && process.env.NEXTAUTH_SECRET.length < 32) {
  console.log(log.warning('⚠️  NEXTAUTH_SECRET is too short (should be at least 32 characters)'));
  hasWarnings = true;
} else if (process.env.NEXTAUTH_SECRET) {
  console.log(log.success('✅ NEXTAUTH_SECRET appears secure'));
}

// Check if using HTTPS in production
if (process.env.NODE_ENV === 'production' && process.env.NEXTAUTH_URL) {
  if (!process.env.NEXTAUTH_URL.startsWith('https://')) {
    console.log(log.error('❌ NEXTAUTH_URL must use HTTPS in production'));
    hasErrors = true;
  } else {
    console.log(log.success('✅ Using HTTPS in production'));
  }
}

// Check database SSL in production
if (process.env.NODE_ENV === 'production' && process.env.DATABASE_URL) {
  if (!process.env.DATABASE_URL.includes('ssl=')) {
    console.log(log.warning('⚠️  Consider using SSL for database connection in production'));
    hasWarnings = true;
  }
}

// Summary
console.log('\n' + '='.repeat(50));
if (hasErrors) {
  console.log(log.error('\n❌ Environment check FAILED'));
  console.log(log.error('   Please set all required environment variables'));
  process.exit(1);
} else if (hasWarnings) {
  console.log(log.warning('\n⚠️  Environment check passed with WARNINGS'));
  console.log(log.warning('   Review the warnings above for potential issues'));
} else {
  console.log(log.success('\n✅ Environment check PASSED'));
  console.log(log.success('   All required variables are properly set'));
}

// Helpful tips
console.log('\n💡 Tips:');
console.log(log.dim('- Copy .env.example to .env.local and update values'));
console.log(log.dim('- Generate NEXTAUTH_SECRET with: openssl rand -base64 32'));
console.log(log.dim('- Never commit .env.local or production secrets'));
console.log(log.dim('- Use different secrets for each environment'));