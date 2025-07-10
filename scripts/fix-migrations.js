#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const BACKUP_DIR = path.join(process.cwd(), 'prisma', 'migration-backups');
const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma', 'migrations');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function execCommand(command, options = {}) {
  try {
    return execSync(command, { stdio: 'pipe', ...options }).toString();
  } catch (error) {
    if (options.ignoreError) {
      return error.stdout ? error.stdout.toString() : '';
    }
    throw error;
  }
}

async function checkDatabaseConnection() {
  log('\n🔍 Checking database connection...', 'cyan');
  try {
    execCommand('npx prisma db pull --force', { stdio: 'ignore' });
    log('✅ Database connection successful', 'green');
    return true;
  } catch (error) {
    log('❌ Cannot connect to database. Please check your DATABASE_URL', 'red');
    return false;
  }
}

async function backupMigrationsTable() {
  log('\n📦 Creating backup of _prisma_migrations table...', 'cyan');
  
  // Create backup directory
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `migrations-backup-${timestamp}.sql`);
  
  try {
    // Get database URL
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      log('⚠️  No DATABASE_URL found in environment', 'yellow');
      return null;
    }
    
    // Export migrations table
    const dumpCommand = dbUrl.startsWith('postgresql://') 
      ? `pg_dump "${dbUrl}" -t _prisma_migrations --data-only --column-inserts > "${backupFile}"`
      : `echo "SELECT * FROM _prisma_migrations;" | npx prisma db execute --stdin > "${backupFile}"`;
    
    execCommand(dumpCommand, { shell: true, ignoreError: true });
    
    if (fs.existsSync(backupFile) && fs.statSync(backupFile).size > 0) {
      log(`✅ Backup created: ${backupFile}`, 'green');
      return backupFile;
    } else {
      log('⚠️  No migrations table found or backup failed', 'yellow');
      return null;
    }
  } catch (error) {
    log('⚠️  Backup failed: ' + error.message, 'yellow');
    return null;
  }
}

async function backupMigrationsFolder() {
  log('\n📁 Backing up migrations folder...', 'cyan');
  
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log('⚠️  No migrations folder found', 'yellow');
    return;
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `migrations-folder-${timestamp}`);
  
  // Copy migrations folder
  fs.cpSync(MIGRATIONS_DIR, backupPath, { recursive: true });
  log(`✅ Migrations folder backed up to: ${backupPath}`, 'green');
}

async function resetAndBaseline() {
  log('\n🔄 Resetting migrations and creating baseline...', 'bright');
  
  // Remove migrations folder
  if (fs.existsSync(MIGRATIONS_DIR)) {
    fs.rmSync(MIGRATIONS_DIR, { recursive: true });
    log('✅ Removed existing migrations folder', 'green');
  }
  
  // Reset database migrations table
  try {
    execCommand('npx prisma migrate reset --force --skip-generate --skip-seed', { stdio: 'inherit' });
  } catch (error) {
    log('⚠️  Migration reset failed, continuing...', 'yellow');
  }
  
  // Create new baseline migration
  log('\n📝 Creating baseline migration...', 'cyan');
  execCommand('npx prisma migrate dev --name baseline --create-only', { stdio: 'inherit' });
  
  // Mark as applied
  execCommand('npx prisma migrate resolve --applied baseline', { stdio: 'inherit' });
  
  log('\n✅ Baseline migration created and marked as applied', 'green');
}

async function markExistingAsApplied() {
  log('\n🏷️  Marking existing migrations as applied...', 'bright');
  
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log('❌ No migrations folder found', 'red');
    return;
  }
  
  const migrations = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => fs.statSync(path.join(MIGRATIONS_DIR, f)).isDirectory())
    .sort();
  
  if (migrations.length === 0) {
    log('❌ No migrations found', 'red');
    return;
  }
  
  log(`\nFound ${migrations.length} migration(s):`, 'cyan');
  migrations.forEach(m => log(`  - ${m}`));
  
  for (const migration of migrations) {
    try {
      execCommand(`npx prisma migrate resolve --applied "${migration}"`, { stdio: 'inherit' });
      log(`✅ Marked ${migration} as applied`, 'green');
    } catch (error) {
      log(`❌ Failed to mark ${migration}: ${error.message}`, 'red');
    }
  }
}

async function clearAndStartFresh() {
  log('\n🧹 Clearing migration history and starting fresh...', 'bright');
  
  // Remove migrations folder
  if (fs.existsSync(MIGRATIONS_DIR)) {
    fs.rmSync(MIGRATIONS_DIR, { recursive: true });
    log('✅ Removed migrations folder', 'green');
  }
  
  // Reset migrations table
  try {
    execCommand('npx prisma migrate reset --force --skip-generate --skip-seed', { stdio: 'inherit' });
    log('✅ Reset migrations table', 'green');
  } catch (error) {
    log('⚠️  Could not reset migrations table', 'yellow');
  }
  
  log('\n✅ Migration history cleared. You can now run:', 'green');
  log('   npx prisma migrate dev', 'cyan');
}

async function deployPendingMigrations() {
  log('\n🚀 Deploying pending migrations...', 'bright');
  
  try {
    execCommand('npx prisma migrate deploy', { stdio: 'inherit' });
    log('\n✅ Migrations deployed successfully', 'green');
  } catch (error) {
    log('❌ Migration deployment failed', 'red');
    throw error;
  }
}

async function showStatus() {
  log('\n📊 Current migration status:', 'bright');
  
  try {
    const status = execCommand('npx prisma migrate status');
    console.log(status);
  } catch (error) {
    log('❌ Could not get migration status', 'red');
  }
}

async function main() {
  log('\n🔧 Prisma Migration Fix Tool', 'bright');
  log('================================\n', 'bright');
  
  log('⚠️  WARNING: This tool will modify your database migrations!', 'yellow');
  log('⚠️  Make sure you have a database backup before proceeding!', 'yellow');
  
  // Check database connection
  if (!await checkDatabaseConnection()) {
    process.exit(1);
  }
  
  // Create backups
  await backupMigrationsTable();
  await backupMigrationsFolder();
  
  // Show current status
  await showStatus();
  
  // Show menu
  log('\n📋 Choose an option:', 'cyan');
  log('1. Reset all migrations and create a new baseline', 'blue');
  log('2. Mark existing migration files as applied', 'blue');
  log('3. Clear migration history and start fresh', 'blue');
  log('4. Deploy pending migrations', 'blue');
  log('5. Exit without changes', 'blue');
  
  const choice = await question('\nEnter your choice (1-5): ');
  
  switch (choice.trim()) {
    case '1':
      log('\n⚠️  This will:', 'yellow');
      log('  - Delete all migration files', 'yellow');
      log('  - Reset the _prisma_migrations table', 'yellow');
      log('  - Create a new baseline migration from current schema', 'yellow');
      
      const confirm1 = await question('\nAre you sure? (yes/no): ');
      if (confirm1.toLowerCase() === 'yes') {
        await resetAndBaseline();
      } else {
        log('❌ Operation cancelled', 'red');
      }
      break;
      
    case '2':
      log('\n⚠️  This will mark all migration files in prisma/migrations as applied', 'yellow');
      log('  - Use this if your database schema matches the migrations', 'yellow');
      log('  - But the _prisma_migrations table is out of sync', 'yellow');
      
      const confirm2 = await question('\nAre you sure? (yes/no): ');
      if (confirm2.toLowerCase() === 'yes') {
        await markExistingAsApplied();
      } else {
        log('❌ Operation cancelled', 'red');
      }
      break;
      
    case '3':
      log('\n⚠️  This will:', 'yellow');
      log('  - Delete all migration files', 'yellow');
      log('  - Reset the _prisma_migrations table', 'yellow');
      log('  - You will need to create new migrations from scratch', 'yellow');
      
      const confirm3 = await question('\nAre you sure? (yes/no): ');
      if (confirm3.toLowerCase() === 'yes') {
        await clearAndStartFresh();
      } else {
        log('❌ Operation cancelled', 'red');
      }
      break;
      
    case '4':
      await deployPendingMigrations();
      break;
      
    case '5':
      log('\n👋 Exiting without changes', 'cyan');
      break;
      
    default:
      log('\n❌ Invalid choice', 'red');
  }
  
  // Show final status
  if (choice !== '5') {
    log('\n📊 Final migration status:', 'bright');
    await showStatus();
  }
  
  log('\n💡 Tips:', 'cyan');
  log('  - Always backup your database before migration changes', 'blue');
  log('  - Test migrations in a development environment first', 'blue');
  log('  - Use "npx prisma migrate dev" for development', 'blue');
  log('  - Use "npx prisma migrate deploy" for production', 'blue');
  log('  - Check backups in: prisma/migration-backups/', 'blue');
  
  rl.close();
}

// Handle errors
process.on('unhandledRejection', (error) => {
  log(`\n❌ Error: ${error.message}`, 'red');
  process.exit(1);
});

// Run the script
main().catch(error => {
  log(`\n❌ Fatal error: ${error.message}`, 'red');
  process.exit(1);
});