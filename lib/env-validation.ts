/**
 * Environment Variable Validation
 * 
 * This module validates that all required environment variables are present
 * and properly formatted. It should be imported early in the application
 * lifecycle to catch configuration issues.
 */

// Define the environment variable schema
export const envSchema = {
  // Database
  DATABASE_URL: {
    required: true,
    validator: (value: string) => value.startsWith('mysql://'),
    message: 'DATABASE_URL must be a valid MySQL connection string',
  },
  
  // Authentication
  NEXTAUTH_URL: {
    required: true,
    validator: (value: string) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    message: 'NEXTAUTH_URL must be a valid URL',
  },
  NEXTAUTH_SECRET: {
    required: true,
    validator: (value: string) => value.length >= 32,
    message: 'NEXTAUTH_SECRET must be at least 32 characters long',
  },
  
  // OAuth
  GOOGLE_CLIENT_ID: {
    required: true,
    validator: (value: string) => 
      value.endsWith('.apps.googleusercontent.com') || 
      process.env.NODE_ENV === 'development',
    message: 'GOOGLE_CLIENT_ID must be a valid Google OAuth client ID',
  },
  GOOGLE_CLIENT_SECRET: {
    required: true,
    validator: (value: string) => value.length > 0,
    message: 'GOOGLE_CLIENT_SECRET is required',
  },
  
  // Email
  SENDGRID_API_KEY: {
    required: true,
    validator: (value: string) => 
      value.startsWith('SG.') || 
      value === 'fake-key-for-local-dev' ||
      process.env.NODE_ENV === 'development',
    message: 'SENDGRID_API_KEY must be a valid SendGrid API key',
  },
  FROM_EMAIL: {
    required: true,
    validator: (value: string) => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(value);
    },
    message: 'FROM_EMAIL must be a valid email address',
  },
  
  // Optional
  NODE_ENV: {
    required: false,
    validator: (value: string) => 
      ['development', 'production', 'test'].includes(value),
    message: 'NODE_ENV must be development, production, or test',
  },
  NEXTAUTH_DEBUG: {
    required: false,
    validator: (value: string) => ['true', 'false'].includes(value),
    message: 'NEXTAUTH_DEBUG must be true or false',
  },
} as const;

export type EnvSchema = typeof envSchema;
export type RequiredEnvVars = {
  [K in keyof EnvSchema as EnvSchema[K]['required'] extends true ? K : never]: string;
};
export type OptionalEnvVars = {
  [K in keyof EnvSchema as EnvSchema[K]['required'] extends false ? K : never]?: string;
};
export type ValidatedEnv = RequiredEnvVars & OptionalEnvVars;

class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/**
 * Validates environment variables against the schema
 * @throws {EnvironmentError} if validation fails
 */
export function validateEnv(): ValidatedEnv {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check each variable in the schema
  for (const [key, config] of Object.entries(envSchema)) {
    const value = process.env[key];
    
    if (config.required && !value) {
      errors.push(`Missing required environment variable: ${key}`);
    } else if (value && config.validator && !config.validator(value)) {
      if (config.required) {
        errors.push(`Invalid ${key}: ${config.message}`);
      } else {
        warnings.push(`Invalid ${key}: ${config.message}`);
      }
    }
  }
  
  // Additional security checks
  if (process.env.NODE_ENV === 'production') {
    // Check HTTPS in production
    if (process.env.NEXTAUTH_URL && !process.env.NEXTAUTH_URL.startsWith('https://')) {
      errors.push('NEXTAUTH_URL must use HTTPS in production');
    }
    
    // Check for debug mode
    if (process.env.NEXTAUTH_DEBUG === 'true') {
      warnings.push('NEXTAUTH_DEBUG should be false in production');
    }
    
    // Check for SSL in database connection
    if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('ssl=')) {
      warnings.push('Consider using SSL for database connection in production');
    }
  }
  
  // Log warnings
  if (warnings.length > 0) {
    console.warn('⚠️  Environment validation warnings:');
    warnings.forEach(warning => console.warn(`   - ${warning}`));
  }
  
  // Throw if there are errors
  if (errors.length > 0) {
    console.error('❌ Environment validation failed:');
    errors.forEach(error => console.error(`   - ${error}`));
    throw new EnvironmentError(
      `Environment validation failed:\n${errors.join('\n')}`
    );
  }
  
  // Return validated environment
  return process.env as ValidatedEnv;
}

/**
 * Gets a typed environment variable
 * @param key - The environment variable key
 * @returns The environment variable value
 * @throws {EnvironmentError} if the variable is required but not set
 */
export function getEnv<K extends keyof EnvSchema>(key: K): string | undefined {
  const value = process.env[key];
  const config = envSchema[key];
  
  if (config.required && !value) {
    throw new EnvironmentError(`Missing required environment variable: ${key}`);
  }
  
  return value;
}

/**
 * Gets all validated environment variables
 * @returns Object containing all validated environment variables
 */
export function getValidatedEnv(): ValidatedEnv {
  return validateEnv();
}

// Validate on module load in development
if (process.env.NODE_ENV !== 'production') {
  try {
    validateEnv();
    console.log('✅ Environment variables validated successfully');
  } catch (error) {
    console.error('Environment validation failed:', error);
    // Don't exit in development, just warn
  }
}