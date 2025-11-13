# Database Connection Guide for Live Database

This guide explains how to safely connect to your existing live database WITHOUT running any migrations or modifications.

## ⚠️ IMPORTANT: Be Careful with Migrations

When connecting to a live database, do not apply schema changes directly. For development:
1. Connect to the existing database (prefer read-only)
2. Introspect the schema
3. Generate the Prisma client
4. For fresh databases (non-production), use a committed baseline and `prisma migrate deploy`
5. For imported production snapshots in local/staging, use `prisma db push` to reconcile safely

## Connection Setup

### 1. Configure Database URL

In your `.env.local` file, set the `DATABASE_URL` to your live database:

```bash
# For direct connection (BE CAREFUL!)
DATABASE_URL="mysql://username:password@host:port/database_name?connection_limit=5"

# With SSL (recommended for remote connections)
DATABASE_URL="mysql://username:password@host:port/database_name?ssl={\"rejectUnauthorized\":true}&connection_limit=5"
```

### 2. Create a Read-Only User (Recommended)

For development safety, create a read-only database user:

```sql
-- Connect to your database as admin
CREATE USER 'inventory_readonly'@'%' IDENTIFIED BY 'strong_password_here';

-- Grant read-only permissions
GRANT SELECT ON inventory.* TO 'inventory_readonly'@'%';

-- Allow write access only to sessions table (for NextAuth)
GRANT INSERT, UPDATE, DELETE ON inventory.sessions TO 'inventory_readonly'@'%';
GRANT INSERT, UPDATE, DELETE ON inventory.accounts TO 'inventory_readonly'@'%';

-- Apply permissions
FLUSH PRIVILEGES;
```

Then use this read-only user in development:
```bash
DATABASE_URL="mysql://inventory_readonly:password@host:port/inventory?connection_limit=2"
```

### 3. Introspect the Existing Database

Pull the current database schema into your Prisma schema:

```bash
# This reads the database structure WITHOUT modifying anything
npx prisma db pull

# This will update your prisma/schema.prisma file
```

### 4. Generate Prisma Client

Generate the TypeScript client based on your schema:

```bash
# This only generates code, doesn't touch the database
npx prisma generate
```

## Safe Development Practices

### DO ✅

- **Use read-only credentials** for development when possible
- **Run `prisma db pull`** to sync schema changes from production
- **Run `prisma generate`** after schema changes
- **Use `prisma studio --readonly`** to browse data safely
- **Test with a local copy** of the database structure
- **Use transactions** for data consistency

### DON'T ❌

- **Never run `prisma migrate dev`** on the live production database
- **Avoid `prisma migrate deploy`** directly on production unless using a vetted change process with backups
- **Avoid `prisma db push`** on production data; prefer migrations for controlled changes
- **Never run `prisma migrate reset`** on any production data
- **Avoid using `force` flags** with Prisma commands
- **Don't modify schema.prisma** without coordinating with DBAs

## Connection Examples

### Local Development with Production Data

```bash
# Read-only connection to production
DATABASE_URL="mysql://readonly_user:password@prod.example.com:3306/inventory?connection_limit=2"
```

### Local MySQL with Production Schema

1. Export schema from production (structure only):
```bash
mysqldump -h prod.example.com -u readonly_user -p \
  --no-data --skip-comments inventory > prod_schema.sql
```

2. Import to local MySQL:
```bash
mysql -u root -p inventory_dev < prod_schema.sql
```

3. Use local database:
```bash
DATABASE_URL="mysql://root:password@localhost:3306/inventory_dev"
```

### Docker MySQL with Production Schema

```bash
# Start MySQL container
docker run --name inventory-mysql \
  -e MYSQL_ROOT_PASSWORD=dev_password \
  -e MYSQL_DATABASE=inventory_dev \
  -p 3306:3306 \
  -d mysql:8.0

# Import production schema
docker exec -i inventory-mysql mysql -u root -pdev_password inventory_dev < prod_schema.sql

# Connect
DATABASE_URL="mysql://root:dev_password@localhost:3306/inventory_dev"
```

## Connection String Parameters

### Essential Parameters

```
mysql://USER:PASSWORD@HOST:PORT/DATABASE?connection_limit=5
```

- `USER`: Database username
- `PASSWORD`: URL-encoded password
- `HOST`: Database server (IP or hostname)
- `PORT`: MySQL port (default: 3306)
- `DATABASE`: Database name

### Connection Pool Settings

```
?connection_limit=5&connect_timeout=10&pool_timeout=10&socket_timeout=20
```

- `connection_limit`: Max connections (default: 2, production: 10-20)
- `connect_timeout`: Connection timeout in seconds
- `pool_timeout`: Wait time for available connection
- `socket_timeout`: Query timeout in seconds

### SSL/TLS Configuration

For secure connections:
```
?ssl={"rejectUnauthorized":true,"ca":"/path/to/ca.pem"}
```

## Troubleshooting

### Connection Refused

```
Error: connect ECONNREFUSED
```

**Solutions:**
- Check if MySQL is running
- Verify host and port
- Check firewall rules
- Ensure user has connection privileges

### Access Denied

```
Error: Access denied for user 'username'@'host'
```

**Solutions:**
- Verify username and password
- Check user permissions
- Ensure user can connect from your IP
- Try connecting with mysql CLI

### SSL Connection Error

```
Error: self signed certificate in certificate chain
```

**Solutions:**
- Add `"rejectUnauthorized":false` for development only
- Provide proper CA certificate for production
- Use SSH tunnel instead of direct connection

### Too Many Connections

```
Error: Too many connections
```

**Solutions:**
- Reduce `connection_limit` parameter
- Check for connection leaks
- Increase MySQL max_connections (if you have access)

## Monitoring Connections

Check active connections:
```sql
-- See all connections
SHOW PROCESSLIST;

-- Count connections per user
SELECT user, count(*) as connections 
FROM information_schema.processlist 
GROUP BY user;

-- Kill stuck connection
KILL CONNECTION_ID;
```

## Security Checklist

- [ ] Use strong, unique passwords
- [ ] Enable SSL/TLS for remote connections
- [ ] Use read-only users when possible
- [ ] Limit connection origins (bind-address)
- [ ] Monitor failed connection attempts
- [ ] Rotate credentials regularly
- [ ] Use connection pooling appropriately
- [ ] Never expose database directly to internet
- [ ] Keep connection strings out of version control
- [ ] Use environment variables for all credentials

## Emergency Procedures

If you accidentally modify the production database:

1. **Stop the application immediately**
2. **Notify the database administrator**
3. **Document what commands were run**
4. **Check if backups are available**
5. **Review audit logs if available**

Remember: The production database is sacred. Always double-check your connection string and never run migration commands on production data!
