# Troubleshooting Guide

Common issues and their solutions for the Inventory Management System.

## Common Issues

### Authentication Issues

#### "No location selected" error
**Problem**: Getting this error when trying to adjust inventory or stock in.

**Solution**: 
1. Make sure you've selected a location from the location switcher in the sidebar
2. If no locations appear, check that your database has locations:
   ```sql
   SELECT * FROM locations;
   ```
3. If empty, insert default locations:
   ```sql
   INSERT INTO locations (id, name) VALUES 
   (1, 'Main Warehouse'),
   (2, 'Store Front'),
   (3, 'Secondary Storage'),
   (4, 'Remote Location');
   ```

#### Can't log in after signup
**Problem**: Created account but can't access the app.

**Solution**: 
- New users require admin approval
- Ask an admin to approve your account at `/admin/users`
- Check your email for approval notification

#### Google OAuth not working
**Problem**: Google sign-in button doesn't work.

**Solution**:
1. Verify Google OAuth credentials in `.env.local`:
   ```
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```
2. Ensure callback URL is configured in Google Console:
   - Development: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://yourdomain.com/api/auth/callback/google`

### Database Issues

#### "Invalid time value" error
**Problem**: Error when viewing inventory logs.

**Solution**: 
- This occurs when timestamp fields are null
- The issue has been fixed in the latest version
- Clear your browser cache and refresh

#### Prisma errors after pulling database
**Problem**: Type errors or Prisma client issues.

**Solution**:
1. Regenerate Prisma client:
   ```bash
   npm run db:generate
   ```
2. Restart the development server:
   ```bash
   npm run dev
   ```

#### Connection pool exhausted
**Problem**: Database connection errors.

**Solution**:
1. Check your connection limit in DATABASE_URL:
   ```
   ?connection_limit=20
   ```
2. Reduce concurrent connections in development:
   ```
   ?connection_limit=5
   ```

### UI/Display Issues

#### Products not updating after order completion
**Problem**: Quantities don't refresh in Workbench.

**Solution**: 
- This has been fixed in the latest version
- The page now auto-refreshes product data after order completion
- Clear browser cache if issue persists

#### Dark mode not working
**Problem**: Theme toggle doesn't change colors.

**Solution**:
1. Clear localStorage:
   ```javascript
   localStorage.removeItem('theme')
   ```
2. Refresh the page
3. Try toggling between light/dark/system modes

#### Mobile navigation not showing
**Problem**: Bottom navigation missing on mobile.

**Solution**:
- Ensure viewport width is below 768px
- Check for JavaScript errors in console
- Clear browser cache

### Performance Issues

#### Slow page loads
**Problem**: Pages take too long to load.

**Solution**:
1. Check database query performance
2. Reduce pagination size:
   - Products page: Add `?pageSize=25` to URL
3. Enable production mode locally:
   ```bash
   npm run build
   npm start
   ```

#### High memory usage
**Problem**: Browser uses too much memory.

**Solution**:
- Reduce number of products displayed
- Clear journal adjustments regularly
- Use pagination instead of loading all data

### Data Issues

#### Incorrect inventory quantities
**Problem**: Stock levels don't match reality.

**Solution**:
1. Check the inventory logs for the product:
   ```sql
   SELECT * FROM inventory_logs 
   WHERE productId = ? 
   ORDER BY changeTime DESC;
   ```
2. Verify location-specific quantities:
   ```sql
   SELECT * FROM product_locations 
   WHERE productId = ?;
   ```
3. Use Journal mode to make corrections

#### Missing products
**Problem**: Products not showing in Workbench/Journal.

**Solution**:
1. Check product exists in database
2. Verify product has entry in product_locations for selected location
3. Check filters aren't hiding products
4. Try clearing search terms

## Development Issues

### Environment Variables

#### Missing environment variables
**Problem**: App crashes with "Missing required environment variable".

**Solution**:
1. Copy example file:
   ```bash
   cp .env.example .env.local
   ```
2. Fill in all required values
3. Restart development server

### Build Errors

#### TypeScript errors
**Problem**: Type errors when building.

**Solution**:
1. Update types:
   ```bash
   npm run db:generate
   ```
2. Check for any `any` types that need fixing
3. Run type check:
   ```bash
   npx tsc --noEmit
   ```

#### Module not found errors
**Problem**: Can't find dependencies.

**Solution**:
1. Clean install:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```
2. Clear Next.js cache:
   ```bash
   rm -rf .next
   ```

## Getting Help

If you're still experiencing issues:

1. Check the browser console for errors
2. Look at server logs in the terminal
3. Search for similar issues in the project documentation
4. Contact the development team with:
   - Error message
   - Steps to reproduce
   - Browser and OS information
   - Screenshots if applicable