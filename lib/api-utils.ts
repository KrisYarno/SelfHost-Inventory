import { getSession } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { AppError, errorLogger } from '@/lib/error-handling';
import { ZodError } from 'zod';

// --- Auth guard types ---

type SessionUser = {
  id: number;
  email: string;
  name: string | null;
  isAdmin: boolean;
  isApproved: boolean;
  defaultLocationId: number | null;
};

type AuthResult = { user: SessionUser };

// --- Auth guards ---
// Each throws an AppError; used inside apiHandler or standalone.

export async function requireAuth(): Promise<AuthResult> {
  const session = await getSession();
  if (!session?.user?.email) {
    throw new AppError('Authentication required', 'UNAUTHORIZED', 401);
  }
  return { user: session.user as SessionUser };
}

export async function requireApproved(): Promise<AuthResult> {
  const { user } = await requireAuth();
  if (!user.isApproved) {
    throw new AppError('Account pending approval', 'FORBIDDEN', 403);
  }
  return { user };
}

export async function requireAdmin(): Promise<AuthResult> {
  const { user } = await requireApproved();
  if (!user.isAdmin) {
    throw new AppError('Admin access required', 'FORBIDDEN', 403);
  }
  return { user };
}

// --- Standard error response builder ---

export function errorResponse(
  error: string,
  status: number = 500,
  code?: string
): NextResponse {
  return NextResponse.json({ error, ...(code && { code }) }, { status });
}

// --- Route wrapper with standard error handling ---

type RouteHandler = (req: NextRequest, ctx?: any) => Promise<NextResponse>;

export function apiHandler(handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      if (error instanceof ZodError) {
        const firstMessage = error.errors[0]?.message || 'Validation failed';
        return errorResponse(firstMessage, 400, 'VALIDATION_ERROR');
      }

      if (error instanceof AppError) {
        errorLogger.log(error);
        return errorResponse(error.message, error.statusCode, error.code);
      }

      console.error('Unhandled API error:', error);
      errorLogger.log(error as Error);
      return errorResponse('Internal server error', 500);
    }
  };
}
