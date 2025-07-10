#!/usr/bin/env node

/**
 * Prisma Migration Diagnostic Script
 * Helps identify migration issues and provides specific fixes
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔍 Prisma Migration Diagnostic Tool\n');

// Check if we're in the right directory
if (!fs.existsSync('package.json') || !fs.existsSync('prisma')) {
  console.error('❌ Error: Run this script from your project root directory');
  process.exit(1);
}

// Function to run command and capture output
function runCommand(command, options = {}) {
  try {
    return execSync(command, { encoding: 'utf8', ...options });
  } catch (error) {
    return error.stdout || error.message;
  }
}

// Check environment
console.log('1️⃣ Checking environment...');
const hasEnv = fs.existsSync('.env');
const hasEnvExample = fs.existsSync('.env.example');
console.log(`   ✓ .env file: ${hasEnv ? 'Found' : 'Not found'}`);
console.log(`   ✓ .env.example file: ${hasEnvExample ? 'Found' : 'Not found'}`);

if (!hasEnv) {
  console.log('\n   ⚠️  No .env file found. Create one from .env.example:');
  console.log('      cp .env.example .env');
  console.log('      Then update DATABASE_URL with your database credentials\n');
}

// Check database connection
console.log('\n2️⃣ Checking database connection...');
const dbUrlOutput = runCommand('npx prisma db execute --stdin --schema prisma/schema.prisma', {
  input: 'SELECT 1;'
});

if (dbUrlOutput.includes('SELECT 1')) {
  console.log('   ✓ Database connection successful');
} else {
  console.log('   ❌ Database connection failed');
  console.log('   Error:', dbUrlOutput);
  console.log('\n   Fix: Check your DATABASE_URL in .env file');
  process.exit(1);
}

// Check migration status
console.log('\n3️⃣ Checking migration status...');
const migrationStatus = runCommand('npx prisma migrate status');
console.log(migrationStatus);

// Check for migrations folder
console.log('\n4️⃣ Checking migrations folder...');
const migrationsPath = path.join('prisma', 'migrations');
const hasMigrations = fs.existsSync(migrationsPath);

if (hasMigrations) {
  const migrations = fs.readdirSync(migrationsPath).filter(f => !f.startsWith('.'));
  console.log(`   ✓ Found ${migrations.length} migration(s):`);
  migrations.forEach(m => console.log(`     - ${m}`));
} else {
  console.log('   ⚠️  No migrations folder found');
}

// Check if tables exist in database
console.log('\n5️⃣ Checking existing tables...');
const tablesQuery = `
  SELECT table_name 
  FROM information_schema.tables 
  WHERE table_schema = DATABASE() 
  AND table_type = 'BASE TABLE'
  ORDER BY table_name;
`;

const tablesOutput = runCommand(`npx prisma db execute --stdin --schema prisma/schema.prisma`, {
  input: tablesQuery
});

console.log('   Existing tables:');
const tableLines = tablesOutput.split('\n').filter(line => line.trim() && !line.includes('table_name'));
tableLines.forEach(table => {
  if (table.trim()) console.log(`     - ${table.trim()}`);
});

// Provide diagnosis and recommendations
console.log('\n📋 Diagnosis & Recommendations:');

if (migrationStatus.includes('Database schema is up to date')) {
  console.log('   ✅ Your database is in sync with migrations');
} else if (migrationStatus.includes('Following migration have not yet been applied')) {
  console.log('   ⚠️  You have pending migrations');
  console.log('   Fix: Run "npx prisma migrate deploy" to apply them');
} else if (migrationStatus.includes('failed to apply cleanly')) {
  console.log('   ❌ Migration failed to apply');
  console.log('\n   This usually means:');
  console.log('   1. A migration references a table that doesn\'t exist');
  console.log('   2. The migration order is incorrect');
  console.log('   3. The database state doesn\'t match what migrations expect');
  console.log('\n   Recommended fix:');
  console.log('   Run: npm run baseline-db');
  console.log('   Or manually: ./scripts/baseline-database.sh');
} else if (!hasMigrations && tableLines.length > 0) {
  console.log('   ⚠️  You have an existing database but no migrations');
  console.log('   This is common when starting to use Prisma with an existing database');
  console.log('\n   Recommended fix:');
  console.log('   Run: npm run baseline-db');
  console.log('   Or manually: ./scripts/baseline-database.sh');
}

// Check for shadow database issues
if (migrationStatus.includes('shadow database')) {
  console.log('\n   ⚠️  Shadow database issue detected');
  console.log('   Prisma uses a temporary shadow database for migrations');
  console.log('   Ensure your database user has CREATE DATABASE privileges');
}

console.log('\n💡 Additional commands to try:');
console.log('   - npx prisma migrate status     # Check migration status');
console.log('   - npx prisma studio            # Browse your data');
console.log('   - npx prisma db pull           # Update schema from database');
console.log('   - npx prisma migrate reset     # Reset database (WARNING: deletes data!)');

console.log('\n✅ Diagnostic complete!');