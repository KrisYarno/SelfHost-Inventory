#!/usr/bin/env node

/**
 * WooCommerce Migration Script
 * 
 * This script safely applies the WooCommerce integration database changes.
 * It includes checks, backup recommendations, and rollback instructions.
 * 
 * Usage: node scripts/apply-woocommerce-migration.js
 */

const mysql = require('mysql2/promise');
const chalk = require('chalk');
const readline = require('readline');
const fs = require('fs').promises;
const path = require('path');

// Import environment validation
require('dotenv').config({ path: '.env.local' });

// Color functions for output
const log = {
  error: (msg) => console.log(chalk.red(msg)),
  warning: (msg) => console.log(chalk.yellow(msg)),
  success: (msg) => console.log(chalk.green(msg)),
  info: (msg) => console.log(chalk.blue(msg)),
  dim: (msg) => console.log(chalk.gray(msg)),
};

// Create readline interface for user prompts
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Parse database URL
function parseDatabaseUrl(url) {
  const dbUrl = new URL(url.replace('mysql://', 'https://'));
  return {
    host: dbUrl.hostname,
    port: dbUrl.port || 3306,
    user: dbUrl.username,
    password: dbUrl.password,
    database: dbUrl.pathname.slice(1),
  };
}

// Check if a column exists in a table
async function columnExists(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = ? 
     AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

// Check if a table exists
async function tableExists(connection, table) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.TABLES 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = ?`,
    [table]
  );
  return rows[0].count > 0;
}

// Check if an index exists
async function indexExists(connection, table, indexName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.STATISTICS 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = ? 
     AND INDEX_NAME = ?`,
    [table, indexName]
  );
  return rows[0].count > 0;
}

// Main migration function
async function runMigration() {
  console.log('🚀 WooCommerce Migration Script\n');
  console.log('This script will apply the following changes:');
  console.log('1. Create woocommerce_products table');
  console.log('2. Add sku and isActive columns to products table');
  console.log('3. Update audit_logs table for better entityId support\n');

  // Check environment
  if (!process.env.DATABASE_URL) {
    log.error('❌ DATABASE_URL environment variable is not set');
    log.info('Please set up your .env.local file first');
    process.exit(1);
  }

  // Parse database connection
  const dbConfig = parseDatabaseUrl(process.env.DATABASE_URL);
  
  // Show connection info
  log.info(`📍 Target Database: ${dbConfig.database} on ${dbConfig.host}`);
  
  // Backup warning
  console.log('\n' + '='.repeat(60));
  log.warning('⚠️  IMPORTANT: Database Backup Required');
  console.log('='.repeat(60));
  console.log('\nBefore proceeding, ensure you have a complete database backup.');
  console.log('\nRecommended backup command:');
  log.dim(`mysqldump -h ${dbConfig.host} -u ${dbConfig.user} -p ${dbConfig.database} > backup_$(date +%Y%m%d_%H%M%S).sql\n`);

  const proceed = await question('Have you created a backup? (yes/no): ');
  if (proceed.toLowerCase() !== 'yes') {
    log.warning('\n⚠️  Migration cancelled. Please create a backup first.');
    rl.close();
    process.exit(0);
  }

  let connection;
  
  try {
    // Connect to database
    log.info('\n🔌 Connecting to database...');
    connection = await mysql.createConnection(dbConfig);
    log.success('✅ Connected successfully');

    // Check current state
    log.info('\n🔍 Checking current database state...');
    
    const checks = {
      woocommerceTableExists: await tableExists(connection, 'woocommerce_products'),
      skuColumnExists: await columnExists(connection, 'products', 'sku'),
      isActiveColumnExists: await columnExists(connection, 'products', 'isActive'),
      metadataColumnExists: await columnExists(connection, 'audit_logs', 'metadata'),
    };

    console.log('\nCurrent state:');
    console.log(`  woocommerce_products table: ${checks.woocommerceTableExists ? '✅ exists' : '❌ missing'}`);
    console.log(`  products.sku column: ${checks.skuColumnExists ? '✅ exists' : '❌ missing'}`);
    console.log(`  products.isActive column: ${checks.isActiveColumnExists ? '✅ exists' : '❌ missing'}`);
    console.log(`  audit_logs.metadata column: ${checks.metadataColumnExists ? '✅ exists' : '❌ missing'}`);

    // Check if migration is needed
    const migrationNeeded = !checks.woocommerceTableExists || 
                          !checks.skuColumnExists || 
                          !checks.isActiveColumnExists ||
                          !checks.metadataColumnExists;

    if (!migrationNeeded) {
      log.success('\n✅ Migration has already been applied. No changes needed.');
      await connection.end();
      rl.close();
      process.exit(0);
    }

    // Confirm migration
    console.log('\n' + '='.repeat(60));
    log.warning('The migration will apply the following changes:');
    if (!checks.woocommerceTableExists) {
      console.log('  - Create woocommerce_products table');
    }
    if (!checks.skuColumnExists) {
      console.log('  - Add sku column to products table');
    }
    if (!checks.isActiveColumnExists) {
      console.log('  - Add isActive column to products table');
    }
    if (!checks.metadataColumnExists) {
      console.log('  - Add metadata column to audit_logs table');
    }
    console.log('='.repeat(60) + '\n');

    const confirm = await question('Proceed with migration? (yes/no): ');
    if (confirm.toLowerCase() !== 'yes') {
      log.warning('\n⚠️  Migration cancelled.');
      await connection.end();
      rl.close();
      process.exit(0);
    }

    // Start transaction
    log.info('\n🔄 Starting transaction...');
    await connection.beginTransaction();

    try {
      // Apply migrations
      log.info('\n📝 Applying migrations...');

      // 1. Create woocommerce_products table
      if (!checks.woocommerceTableExists) {
        log.info('  Creating woocommerce_products table...');
        await connection.execute(`
          CREATE TABLE \`woocommerce_products\` (
            \`id\` VARCHAR(191) NOT NULL,
            \`wooCommerceId\` INTEGER NOT NULL,
            \`name\` VARCHAR(255) NOT NULL,
            \`sku\` VARCHAR(255) NULL,
            \`productId\` INTEGER NULL,
            \`createdAt\` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
            \`updatedAt\` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),
            PRIMARY KEY (\`id\`),
            UNIQUE INDEX \`woocommerce_products_wooCommerceId_key\`(\`wooCommerceId\`),
            INDEX \`idx_woo_product_mapping\`(\`productId\`),
            INDEX \`idx_woo_product_name\`(\`name\`),
            INDEX \`idx_woo_product_sku\`(\`sku\`),
            CONSTRAINT \`woocommerce_products_productId_fkey\` 
              FOREIGN KEY (\`productId\`) REFERENCES \`products\`(\`id\`) 
              ON DELETE SET NULL ON UPDATE NO ACTION
          ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);
        log.success('  ✅ woocommerce_products table created');
      }

      // 2. Add sku column to products
      if (!checks.skuColumnExists) {
        log.info('  Adding sku column to products table...');
        await connection.execute(`
          ALTER TABLE \`products\` ADD COLUMN \`sku\` VARCHAR(255) NULL
        `);
        log.success('  ✅ sku column added');
      }

      // 3. Add isActive column to products
      if (!checks.isActiveColumnExists) {
        log.info('  Adding isActive column to products table...');
        await connection.execute(`
          ALTER TABLE \`products\` ADD COLUMN \`isActive\` BOOLEAN NOT NULL DEFAULT true
        `);
        log.success('  ✅ isActive column added');
      }

      // 4. Update audit_logs table
      if (!checks.metadataColumnExists) {
        log.info('  Updating audit_logs table...');
        
        // First modify entityId to allow NULL and increase size
        await connection.execute(`
          ALTER TABLE \`audit_logs\` MODIFY COLUMN \`entityId\` VARCHAR(255) NULL
        `);
        
        // Then add metadata column
        await connection.execute(`
          ALTER TABLE \`audit_logs\` ADD COLUMN \`metadata\` JSON NULL
        `);
        
        log.success('  ✅ audit_logs table updated');
      }

      // Commit transaction
      log.info('\n💾 Committing changes...');
      await connection.commit();
      log.success('✅ Migration completed successfully!');

      // Show next steps
      console.log('\n' + '='.repeat(60));
      log.success('📋 Next Steps:');
      console.log('='.repeat(60));
      console.log('\n1. Update your Prisma schema file if not already done');
      console.log('2. Run: npx prisma generate');
      console.log('3. Test the application to ensure everything works');
      console.log('\n💡 The migration is complete and your database is ready for WooCommerce integration.');

    } catch (error) {
      // Rollback on error
      log.error('\n❌ Migration failed: ' + error.message);
      log.warning('🔄 Rolling back transaction...');
      await connection.rollback();
      log.success('✅ Rollback completed');
      throw error;
    }

  } catch (error) {
    log.error('\n❌ Error: ' + error.message);
    
    // Provide rollback instructions
    console.log('\n' + '='.repeat(60));
    log.warning('🔧 Rollback Instructions:');
    console.log('='.repeat(60));
    console.log('\nIf you need to rollback this migration manually:');
    console.log('\n-- Remove woocommerce_products table:');
    log.dim('DROP TABLE IF EXISTS `woocommerce_products`;');
    console.log('\n-- Remove sku column from products:');
    log.dim('ALTER TABLE `products` DROP COLUMN `sku`;');
    console.log('\n-- Remove isActive column from products:');
    log.dim('ALTER TABLE `products` DROP COLUMN `isActive`;');
    console.log('\n-- Remove metadata column from audit_logs:');
    log.dim('ALTER TABLE `audit_logs` DROP COLUMN `metadata`;');
    console.log('\n-- Revert entityId column in audit_logs:');
    log.dim('ALTER TABLE `audit_logs` MODIFY COLUMN `entityId` INT;');
    
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
    rl.close();
  }
}

// Run the migration
runMigration().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});