// Vercel Function. All routing and logic live in server/app.js.
import { handle } from '../server/app.js'

export function DELETE(request) {
  return handle(request)
}
export function OPTIONS(request) {
  return handle(request)
}
