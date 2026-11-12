import { createServer } from 'node:net'
import { LLAMA_HOST } from '../../shared/constants'

function listenOnce(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, LLAMA_HOST, () => {
      const address = server.address()
      const assigned = typeof address === 'object' && address !== null ? address.port : port
      server.close(() => resolve(assigned))
    })
  })
}

/**
 * Returns `preferred` when it can be bound on 127.0.0.1, otherwise a free port
 * chosen by the OS. The app never attaches to a server it did not spawn.
 * (There is a small window between this check and the server binding the port.)
 */
export async function pickPort(preferred: number): Promise<number> {
  try {
    return await listenOnce(preferred)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE' || code === 'EACCES') return listenOnce(0)
    throw error
  }
}
