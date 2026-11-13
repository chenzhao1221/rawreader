// Entry point of the detection utility process. It owns sharp and onnxruntime-node so the main
// process never decodes images or runs ONNX. Messages are validated with zod on both sides.
import { DetectRequestSchema } from './protocol'
import type { DetectResponse } from './protocol'
import { InProcessDetectService } from './service'

let service: InProcessDetectService | null = null

function reply(response: DetectResponse): void {
  process.parentPort.postMessage(response)
}

process.parentPort.on('message', (event) => {
  const parsed = DetectRequestSchema.safeParse(event.data)
  if (!parsed.success) {
    const id = typeof (event.data as { id?: unknown } | null)?.id === 'number' ? (event.data as { id: number }).id : -1
    reply({ id, ok: false, error: { code: 'INVALID_MESSAGE', message: 'Malformed detect request' } })
    return
  }
  const request = parsed.data

  switch (request.type) {
    case 'init':
      service = new InProcessDetectService(request.modelPath)
      reply({ id: request.id, ok: true, result: null })
      break
    case 'detect': {
      if (!service) {
        reply({ id: request.id, ok: false, error: { code: 'NOT_INITIALISED', message: 'Detector was not initialised' } })
        return
      }
      void service
        .detect({
          bytes: request.bytes,
          ocrPadding: request.ocrPadding,
          readingDirection: request.readingDirection,
          maxBoxImageCoverage: request.maxBoxImageCoverage,
        })
        .then((outcome) => {
          reply(outcome.ok ? { id: request.id, ok: true, result: outcome.result } : { id: request.id, ok: false, error: outcome.error })
        })
      break
    }
    case 'dispose':
      void (service?.dispose() ?? Promise.resolve()).then(() => {
        service = null
        reply({ id: request.id, ok: true, result: null })
      })
      break
  }
})
