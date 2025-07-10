#!/bin/bash

# Prisma Database Baseline Script
# This script helps you baseline an existing database with Prisma migrations

set -e

echo "🔧 Prisma Database Baseline Script"
echo "================================="
echo ""
echo "This script will help you baseline your existing database with Prisma."
echo "It's useful when you have an existing database and want to start using Prisma migrations."
echo ""
echo "⚠️  WARNING: This will reset your migration history (but NOT your data)!"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "prisma" ]; then
    echo "❌ Error: This script must be run from the project root directory"
    echo "   (the directory containing package.json and prisma folder)"
    exit 1
fi

# Prompt for confirmation
read -p "Do you want to continue? (yes/no): " -n 3 -r
echo
if [[ ! $REPLY =~ ^yes$ ]]; then
    echo "❌ Operation cancelled"
    exit 1
fi

# Create backup directory
BACKUP_DIR="prisma/backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo ""
echo "📁 Creating backups..."

# Backup migrations if they exist
if [ -d "prisma/migrations" ]; then
    echo "   - Backing up existing migrations to $BACKUP_DIR/migrations"
    cp -r prisma/migrations "$BACKUP_DIR/"
else
    echo "   - No existing migrations found"
fi

# Backup schema
echo "   - Backing up schema.prisma to $BACKUP_DIR/schema.prisma"
cp prisma/schema.prisma "$BACKUP_DIR/"

echo ""
echo "🗑️  Removing old migrations..."
rm -rf prisma/migrations

echo ""
echo "🔍 Introspecting current database..."
echo "   This will ensure schema.prisma matches your database exactly"
npx prisma db pull

echo ""
echo "📝 Creating initial migration..."
echo "   This creates a migration file without applying it"
npx prisma migrate dev --name init --create-only

# Find the migration that was just created
MIGRATION_NAME=$(ls -1 prisma/migrations | grep init | head -n 1)

if [ -z "$MIGRATION_NAME" ]; then
    echo "❌ Error: Could not find the created migration"
    exit 1
fi

echo ""
echo "✅ Marking migration as already applied..."
echo "   This tells Prisma that the database already has these tables"
npx prisma migrate resolve --applied "$MIGRATION_NAME"

echo ""
echo "🔄 Generating Prisma Client..."
npx prisma generate

echo ""
echo "✅ Database baseline complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Test your application to ensure everything works"
echo "   2. You can now create new migrations with: npx prisma migrate dev --name your_migration_name"
echo "   3. Your old migrations are backed up in: $BACKUP_DIR"
echo ""
echo "💡 Tips:"
echo "   - Use 'npx prisma studio' to browse your data"
echo "   - Use 'npx prisma migrate status' to check migration status"
echo "   - Always test migrations in development before applying to production"