import { PrismaClient } from '@prisma/client'
import { createPrismaMiddleware } from './db-monitoring'

const prismaClientSingleton = () => {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'info', 'warn', 'error']
      : ['error'],
  })

  // Add query monitoring middleware in development
  if (process.env.NODE_ENV === 'development') {
    client.$use(createPrismaMiddleware())
  }

  return client
}

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton()

export default prisma

if (process.env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma