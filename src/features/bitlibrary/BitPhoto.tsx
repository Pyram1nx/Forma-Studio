// A bit's photo, with a three-step fallback: the copy in public/bit-images/<id>.webp (written by
// scripts/fetch-bit-images.mjs and committed), then the bit's imageUrl (Shaper's CDN, or the URL
// a user gave a custom bit), then the drawn side profile.
import { useState } from 'react'
import { IMAGES, type Bit } from '../carve3d/bits'
import { BitShape } from '../carve3d/BitGallery'

type Step = 'local' | 'remote' | 'drawn'

const base = import.meta.env.BASE_URL

export default function BitPhoto({ bit, className }: { bit: Bit; className?: string }) {
  const remote = bit.imageUrl ?? null
  // Only catalogue bits have a local copy; custom bits go straight to their own URL.
  const [step, setStep] = useState<Step>(IMAGES[bit.id] ? 'local' : remote ? 'remote' : 'drawn')

  if (step === 'drawn') return <BitShape bit={bit} className={className ? `${className} is-drawn` : undefined} />
  return (
    <img
      className={className}
      src={step === 'local' ? `${base}bit-images/${encodeURIComponent(bit.id)}.webp` : (remote ?? undefined)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setStep(step === 'local' && remote ? 'remote' : 'drawn')}
    />
  )
}
