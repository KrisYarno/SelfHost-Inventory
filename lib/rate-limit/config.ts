// Rate limiting configuration for different endpoint types

export interface RateLimitConfig {
  windowMs: number;  // Time window in milliseconds
  max: number;       // Maximum number of requests per window
  message?: string;  // Custom error message
  skipSuccessfulRequests?: boolean; // Don't count successful requests
  skipFailedRequests?: boolean;     // Don't count failed requests
}

export const rateLimitConfigs = {
  // Authentication endpoints - stricter limits
  auth: {
    signin: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5,
      message: 'Too many login attempts, please try again later'
    },
    signup: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 3,
      message: 'Too many account creation attempts, please try again later'
    },
    passwordReset: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 3,
      message: 'Too many password reset attempts, please try again later'
    }
  },

  // API endpoints - moderate limits
  api: {
    default: {
      windowMs: 60 * 1000, // 1 minute
      max: 60,
      message: 'Too many requests, please slow down'
    },
    inventory: {
      windowMs: 60 * 1000, // 1 minute
      max: 60, // Increased from 30 to 60 for better UX with multiple components
      message: 'Too many inventory requests, please slow down'
    },
    inventoryRead: {
      windowMs: 60 * 1000, // 1 minute
      max: 100, // More lenient for read operations
      message: 'Too many inventory requests, please slow down'
    },
    reports: {
      windowMs: 60 * 1000, // 1 minute
      max: 20,
      message: 'Too many report requests, please slow down'
    },
    heavy: {
      windowMs: 5 * 60 * 1000, // 5 minutes
      max: 10,
      message: 'Too many heavy operation requests, please wait before trying again'
    }
  },

  // Admin endpoints - separate limits
  admin: {
    default: {
      windowMs: 60 * 1000, // 1 minute
      max: 100,
      message: 'Too many admin requests, please slow down'
    },
    userManagement: {
      windowMs: 60 * 1000, // 1 minute
      max: 20,
      message: 'Too many user management requests, please slow down'
    },
    bulkOperations: {
      windowMs: 5 * 60 * 1000, // 5 minutes
      max: 5,
      message: 'Too many bulk operations, please wait before trying again'
    }
  },

  // Public endpoints - more lenient
  public: {
    default: {
      windowMs: 60 * 1000, // 1 minute
      max: 100,
      message: 'Too many requests, please slow down'
    }
  }
} as const;

// Helper to get config for a specific path
export function getConfigForPath(path: string): RateLimitConfig {
  // Authentication routes
  if (path.includes('/api/auth/signin')) return rateLimitConfigs.auth.signin;
  if (path.includes('/api/auth/signup')) return rateLimitConfigs.auth.signup;
  if (path.includes('/api/auth/reset-password')) return rateLimitConfigs.auth.passwordReset;

  // Admin routes
  if (path.startsWith('/api/admin')) {
    if (path.includes('/users') && (path.includes('bulk') || path.includes('approve') || path.includes('reject'))) {
      return rateLimitConfigs.admin.userManagement;
    }
    if (path.includes('bulk')) return rateLimitConfigs.admin.bulkOperations;
    return rateLimitConfigs.admin.default;
  }

  // API routes
  if (path.startsWith('/api')) {
    if (path.includes('/inventory')) {
      // Use more lenient limits for read operations
      if (path.includes('/current') || path.includes('/logs') || path.includes('/variants')) {
        return rateLimitConfigs.api.inventoryRead;
      }
      return rateLimitConfigs.api.inventory;
    }
    if (path.includes('/reports')) return rateLimitConfigs.api.reports;
    if (path.includes('/export') || path.includes('/import')) return rateLimitConfigs.api.heavy;
    return rateLimitConfigs.api.default;
  }

  // Default to public
  return rateLimitConfigs.public.default;
}