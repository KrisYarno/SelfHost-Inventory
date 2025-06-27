import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      isAdmin: boolean;
      isApproved: boolean;
      defaultLocationId: number;
    } & DefaultSession['user'];
  }

  interface User {
    id: string;
    username: string;
    email: string;
    isAdmin: boolean;
    isApproved: boolean;
    defaultLocationId: number;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    isAdmin: boolean;
    isApproved: boolean;
    defaultLocationId: number;
  }
}