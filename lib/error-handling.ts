// Base error class for application-specific errors
export class AppError extends Error {
  code: string;
  statusCode: number;
  
  constructor(message: string, code: string, statusCode: number = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Specific error classes
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized access') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ProductNotFoundError extends AppError {
  constructor(productId: number) {
    super(`Product with ID ${productId} not found`, 'PRODUCT_NOT_FOUND', 404);
  }
}

export class InsufficientStockError extends AppError {
  constructor(productName: string, requested: number, available: number) {
    super(
      `Insufficient stock for ${productName}. Requested: ${requested}, Available: ${available}`,
      'INSUFFICIENT_STOCK',
      400
    );
  }
}

export class InvalidQuantityError extends AppError {
  constructor(message: string = 'Invalid quantity provided') {
    super(message, 'INVALID_QUANTITY', 400);
  }
}

// Error logger utility
export const errorLogger = {
  log: (error: Error, context?: Record<string, any>) => {
    const timestamp = new Date().toISOString();
    const errorInfo = {
      timestamp,
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...context
    };
    
    if (process.env.NODE_ENV === 'development') {
      console.error('[ERROR]', errorInfo);
    } else {
      // In production, you might want to send to an error tracking service
      console.error(`[ERROR] ${timestamp} - ${error.name}: ${error.message}`);
    }
  }
};

export interface UserFriendlyError {
  title: string;
  description: string;
  action?: string;
}

export function getUserFriendlyMessage(error: Error): UserFriendlyError {
  // Check for specific error codes
  if ('code' in error) {
    switch (error.code) {
      case 'OPTIMISTIC_LOCK_ERROR':
        return {
          title: 'Inventory Conflict',
          description: 'The inventory was modified by another user. Please refresh and try again.',
          action: 'The page will refresh automatically.'
        };
      case 'NETWORK_ERROR':
        return {
          title: 'Network Error',
          description: 'Unable to connect to the server.',
          action: 'Please check your internet connection and try again.'
        };
      case 'VALIDATION_ERROR':
        return {
          title: 'Invalid Input',
          description: error.message || 'Please check your input and try again.',
        };
      default:
        break;
    }
  }

  // Generic error handling
  return {
    title: 'Something went wrong',
    description: error.message || 'An unexpected error occurred.',
    action: 'Please try again or contact support if the issue persists.'
  };
}

export interface BatchOperationResult {
  productId: number;
  success: boolean;
  error?: {
    message: string;
    code?: string;
  };
}

export function handleBatchOperationErrors(
  results: BatchOperationResult[], 
  operationName: string
) {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  const summary = failed.length === 0 
    ? `All ${results.length} ${operationName.toLowerCase()} completed successfully.`
    : `${successful.length} of ${results.length} ${operationName.toLowerCase()} completed. ${failed.length} failed.`;

  return {
    successful,
    failed,
    summary
  };
}

// Component error handling
export function handleComponentError(error: Error, errorInfo: { componentStack: string }) {
  // Log the error with component stack in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Component Error:', error);
    console.error('Component Stack:', errorInfo.componentStack);
  }

  // In production, you might want to send this to an error tracking service
  if (process.env.NODE_ENV === 'production') {
    // Example: Send to error tracking service
    // errorTracker.captureException(error, {
    //   extra: {
    //     componentStack: errorInfo.componentStack
    //   }
    // });
    
    // For now, just log to console in production as well
    console.error('Component error occurred:', error.message);
  }

  // You can also track specific types of component errors
  if (error.name === 'ChunkLoadError') {
    // Handle lazy loading errors
    console.error('Failed to load code chunk. User may need to refresh.');
  }
}