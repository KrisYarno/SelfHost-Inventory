import { PrismaClient } from '@prisma/client'
import { dbMonitor } from './db-monitoring'

const prismaClientSingleton = () => {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'info', 'warn', 'error']
      : ['error'],
  })

  // Add lightweight query monitoring in development via $on('query')
  if (process.env.NODE_ENV === 'development') {
    client.$on('query', (e: any) => {
      try {
        dbMonitor.logQuery(e.query, e.params, e.duration)
      } catch {}
    })
  }

  return client
}

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton()

export default prisma

if (process.env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma
