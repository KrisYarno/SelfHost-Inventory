#!/usr/bin/env node

/**
 * Environment Variable Validator
 * 
 * This script validates environment variables and creates a .env.local
 * file if it doesn't exist, with helpful prompts for each variable.
 * 
 * Usage: npm run env:validate
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const log = {
  error: (msg) => console.log(`${colors.red}${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}${msg}${colors.reset}`),
  warning: (msg) => console.log(`${colors.yellow}${msg}${colors.reset}`),
  info: (msg) => console.log(`${colors.blue}${msg}${colors.reset}`),
  dim: (msg) => console.log(`${colors.gray}${msg}${colors.reset}`),
  header: (msg) => console.log(`\n${colors.bright}${colors.cyan}${msg}${colors.reset}`),
};

// Environment variables configuration
const ENV_CONFIG = [
  {
    name: 'DATABASE_URL',
    description: 'MySQL database connection string',
    required: true,
    example: 'mysql://user:password@localhost:3306/inventory_db',
    validator: (value) => value.startsWith('mysql://'),
    prompt: 'Enter your MySQL connection string',
    help: `Format: mysql://USER:PASSWORD@HOST:PORT/DATABASE
Examples:
- Local: mysql://root:password@localhost:3306/inventory_dev
- Remote: mysql://user:pass@db.example.com:3306/inventory?ssl=true`,
  },
  {
    name: 'NEXTAUTH_URL',
    description: 'Application URL',
    required: true,
    default: 'http://localhost:3000',
    validator: (value) => value.startsWith('http://') || value.startsWith('https://'),
    prompt: 'Enter your application URL',
  },
  {
    name: 'NEXTAUTH_SECRET',
    description: 'Secret for JWT encryption',
    required: true,
    generator: () => crypto.randomBytes(32).toString('base64'),
    validator: (value) => value.length >= 32,
    prompt: 'Enter NextAuth secret (or press Enter to generate)',
  },
  {
    name: 'GOOGLE_CLIENT_ID',
    description: 'Google OAuth client ID',
    required: true,
    example: 'your-client-id.apps.googleusercontent.com',
    validator: (value) => value.endsWith('.apps.googleusercontent.com') || value === 'development-placeholder',
    prompt: 'Enter Google OAuth client ID',
    help: 'Get from https://console.cloud.google.com/apis/credentials',
  },
  {
    name: 'GOOGLE_CLIENT_SECRET',
    description: 'Google OAuth client secret',
    required: true,
    prompt: 'Enter Google OAuth client secret',
  },
  {
    name: 'SENDGRID_API_KEY',
    description: 'SendGrid API key',
    required: true,
    example: 'SG.your-api-key',
    validator: (value) => value.startsWith('SG.') || value === 'fake-key-for-local-dev',
    prompt: 'Enter SendGrid API key (or "fake-key-for-local-dev" for development)',
    help: 'Get from https://app.sendgrid.com/settings/api_keys',
  },
  {
    name: 'FROM_EMAIL',
    description: 'Sender email address',
    required: true,
    default: 'noreply@localhost',
    validator: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    prompt: 'Enter sender email address',
  },
  {
    name: 'NODE_ENV',
    description: 'Environment mode',
    required: false,
    default: 'development',
    options: ['development', 'production', 'test'],
    prompt: 'Select environment mode',
  },
];

async function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function validateAndCreateEnv() {
  log.header('🔧 Environment Configuration Validator');
  console.log('This tool will help you set up your environment variables.\n');

  const envPath = path.join(process.cwd(), '.env.local');
  let existingEnv = {};

  // Check if .env.local exists
  if (fs.existsSync(envPath)) {
    const response = await prompt('📄 .env.local already exists. Do you want to (o)verwrite, (u)pdate, or (c)ancel? ');
    
    if (response.toLowerCase() === 'c') {
      console.log('Cancelled.');
      process.exit(0);
    }
    
    if (response.toLowerCase() === 'u') {
      // Read existing values
      const content = fs.readFileSync(envPath, 'utf8');
      content.split('\n').forEach(line => {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        if (match) {
          existingEnv[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
      });
    }
  }

  const newEnv = {};

  // Process each environment variable
  for (const config of ENV_CONFIG) {
    log.header(`\n${config.name}`);
    log.dim(config.description);
    
    if (config.help) {
      log.dim(config.help);
    }

    let value = existingEnv[config.name];

    if (!value || value === config.example) {
      if (config.options) {
        // Multiple choice
        console.log('Options:');
        config.options.forEach((opt, idx) => {
          console.log(`  ${idx + 1}. ${opt}`);
        });
        
        const choice = await prompt(`${config.prompt} (1-${config.options.length}): `);
        const idx = parseInt(choice) - 1;
        value = config.options[idx] || config.default;
      } else {
        // Text input
        const input = await prompt(`${config.prompt}${config.default ? ` [${config.default}]` : ''}: `);
        
        if (!input && config.generator) {
          value = config.generator();
          log.success(`Generated: ${value}`);
        } else if (!input && config.default) {
          value = config.default;
        } else {
          value = input;
        }
      }
    } else {
      log.info(`Current value: ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`);
      const keep = await prompt('Keep this value? (Y/n): ');
      
      if (keep.toLowerCase() === 'n') {
        const input = await prompt(`${config.prompt}: `);
        value = input || value;
      }
    }

    // Validate
    if (config.validator && !config.validator(value)) {
      log.warning(`⚠️  Warning: Value doesn't match expected format`);
      if (config.example) {
        log.dim(`Example: ${config.example}`);
      }
    }

    if (config.required && !value) {
      log.error('❌ This variable is required!');
      const retry = await prompt('Try again? (y/N): ');
      if (retry.toLowerCase() === 'y') {
        // Retry this variable
        ENV_CONFIG.unshift(config);
        continue;
      }
    }

    newEnv[config.name] = value;
  }

  // Generate .env.local content
  const envContent = `# ===========================================
# INVENTORY APP - LOCAL ENVIRONMENT
# ===========================================
# Generated on: ${new Date().toISOString()}
# This file contains your local development configuration.
# DO NOT commit this file to version control.

${Object.entries(newEnv)
  .map(([key, value]) => {
    const config = ENV_CONFIG.find(c => c.name === key);
    const comment = config ? `# ${config.description}\n` : '';
    return `${comment}${key}="${value}"`;
  })
  .join('\n\n')}

# ===========================================
# Additional optional variables can be added below
# ===========================================
`;

  // Write the file
  fs.writeFileSync(envPath, envContent);
  log.success('\n✅ .env.local has been created successfully!');

  // Run the check script
  console.log('\n🔍 Running environment check...\n');
  require('./check-env.js');

  rl.close();
}

// Run the validator
validateAndCreateEnv().catch((error) => {
  log.error(`\n❌ Error: ${error.message}`);
  process.exit(1);
});