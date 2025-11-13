# Feature Documentation

This document describes all the features implemented in the Inventory Management System.

## Core Features

### 🔨 Workbench Mode

The main inventory interface for order fulfillment. Located at `/workbench`.

**Key Features:**
- **Product Tiles**: Clean, text-based tiles showing product names (no images)
- **Smart Search**: Filters products where any word starts with the search term
  - Example: Searching "Ex" shows products with words starting with "Ex"
- **Stock Filters**: 
  - Show in stock only (quantity > 0)
  - Show low stock only (quantity > 0 and ≤ 10)
  - Show out of stock only (quantity = 0)
- **Quick Quantity Selection**: Choose from 1-5 or enter custom amount
- **Order Management**: Build orders with multiple items before deducting
- **Real-time Updates**: Product quantities refresh after order completion
- **Location Aware**: All operations use the selected location

**Workflow:**
1. Select location from sidebar
2. Search/filter products as needed
3. Click product tiles to add to order
4. Enter order reference
5. Complete & deduct from inventory

### 📔 Journal Mode

Bulk inventory adjustment interface. Located at `/journal`.

**Key Features:**
- **Inline Adjustments**: Direct quantity editing with +/- buttons
- **Visual Feedback**: 
  - Green for increases
  - Red for decreases
  - Gray for no change
- **Batch Operations**: Adjust multiple products before submitting
- **Auto-save**: Changes persist to localStorage
- **Review Dialog**: Confirm all changes before submission
- **Mobile Gestures**: Swipe support for adjustments
- **Notes Support**: Add reasons for adjustments

**Workflow:**
1. Select location from sidebar
2. Search for products
3. Make quantity adjustments
4. Review all changes
5. Submit batch update

### 📦 Product Management

Admin-only product catalog management. Located at `/products`.

**Key Features:**
- **CRUD Operations**: Create, read, update, delete products
- **Product Structure**:
  - Name (display name)
  - Base Name (product family)
  - Variant (specific variant)
  - Unit (optional)
  - Numeric Value (for sorting)
- **Search & Filter**: Find products quickly
- **Quick Actions**: Stock-in and adjust from product cards
- **Admin Controls**: Only admins can create/edit/delete

### 📍 Multi-Location Support

Manage inventory across multiple physical locations.

**Key Features:**
- **Location Switcher**: Dropdown in sidebar
- **Location Persistence**: Selected location saved to localStorage
- **Per-Location Inventory**: Each location tracks its own stock levels
- **Location-Aware Operations**: All actions respect selected location
- **Default Location**: Users have a default location in their profile

**Database Structure:**
- `locations` table: Stores location information
- `product_locations` table: Tracks quantity per product per location
- `inventory_logs` table: Records changes with location info

### 👥 User Management

Authentication and authorization system.

**Key Features:**
- **Dual Authentication**:
  - Google OAuth
  - Email/password
- **Approval Queue**: New users require admin approval
- **Role-Based Access**:
  - USER: Can manage inventory
  - ADMIN: Can also manage products and users
- **Email Notifications**: Approval/rejection emails via SendGrid

### 📊 Reports & Analytics

Comprehensive reporting dashboard. Located at `/admin/reports` (under Admin).

**Key Features:**
- **Dashboard Metrics**:
  - Total products
  - Total inventory value
  - Low stock alerts
  - Recent activity count
- **Activity Timeline**: Chronological log of all changes
- **Product Performance**: Charts and analytics
- **User Activity**: Summary of user actions
- **Interactive Charts**: Built with Recharts

### 🌓 Theme Support

Full light and dark mode support.

**Key Features:**
- **Three Modes**: Light, Dark, System
- **Persistent Choice**: Saved to localStorage
- **Smooth Transitions**: CSS transitions for theme changes
- **Consistent Design**: All components support both themes
- **Easy Toggle**: Available in sidebar and user menu

## Technical Features

### 🔒 Security
- JWT-based authentication
- Session management with NextAuth
- API route protection
- Input validation
- SQL injection prevention via Prisma

### 📱 Mobile Optimization
- Responsive design (mobile-first)
- Touch-optimized interfaces
- Bottom navigation on mobile
- Large touch targets (44px minimum)
- Swipe gestures in Journal mode

### ⚡ Performance
- Optimistic UI updates
- Efficient database queries
- Image lazy loading
- Code splitting
- Minimal bundle size

### 🔍 Search Capabilities
- Product name search
- Smart word-matching (any word starting with term)
- Real-time filtering
- Search persistence

### 📝 Audit Trail
- Complete ledger-based system
- Every change is logged
- Immutable history
- User tracking
- Timestamp recording

## API Endpoints

### Products
- `GET /api/products` - List with filters
- `GET /api/products/[id]` - Single product
- `POST /api/products` - Create (Admin)
- `PUT /api/products/[id]` - Update (Admin)
- `DELETE /api/products/[id]` - Soft delete (Admin)

### Inventory
- `GET /api/inventory/logs` - View ledger entries
- `GET /api/inventory/current` - Current levels by location
- `POST /api/inventory/deduct-simple` - Process orders
- `POST /api/inventory/adjust` - Manual adjustments
- `POST /api/inventory/stock-in` - Add new stock

### Locations
- `GET /api/locations` - List all locations

### Reports
- `GET /api/reports/metrics` - Dashboard metrics
- `GET /api/reports/activity` - Activity timeline
- `GET /api/reports/low-stock` - Low stock alerts
- `GET /api/reports/user-activity` - User summaries

### Admin
- `GET /api/admin/users` - User list
- `POST /api/admin/users/[id]/approve` - Approve user
- `DELETE /api/admin/users/[id]/reject` - Reject user

## Keyboard Shortcuts

Currently, the app is primarily mouse/touch driven. Keyboard shortcuts are planned for future releases.

## Browser Support

- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Full support
- Mobile browsers: Full support

The app requires JavaScript to be enabled.
