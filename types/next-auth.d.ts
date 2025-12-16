import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: number;
      isAdmin: boolean;
      isApproved: boolean;
      defaultLocationId: number | null;
    } & DefaultSession['user'];
  }

  interface User {
    id: number;
    username: string;
    email: string;
    isAdmin: boolean;
    isApproved: boolean;
    defaultLocationId: number | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: number;
    email: string;
    name: string;
    isAdmin: boolean;
    isApproved: boolean;
    defaultLocationId: number | null;
  }
}