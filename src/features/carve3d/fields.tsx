// Small form controls shared by the 3D Carve dialog and its panels.
import { useState, type ReactNode } from 'react'

/**
 * Parse a typed length: "2", "2.5", "2,5", ".5", "1/8", "1 1/2". Returns null for anything else,
 * including negative numbers (stock, step and margin can never be negative).
 */
export function parseNumber(text: string): number | null {
  const s = text.trim().replace(/,/g, '.')
  let m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/)
  if (m) {
    const den = Number(m[3])
    return den ? Number(m[1]) + Number(m[2]) / den : null
  }
  m = s.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (m) {
    const den = Number(m[2])
    return den ? Number(m[1]) / den : null
  }
  if (/^(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s)
  return null
}

/** Text number field. Keeps partial input ("2.") while typing and accepts comma decimals and fractions. */
export function NumInput({
  value,
  onChange,
  decimals = 2,
  suffix,
  disabled,
  ariaLabel,
}: {
  /** Value in display units. */
  value: number
  onChange: (v: number) => void
  decimals?: number
  suffix?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  const [text, setText] = useState(value.toFixed(decimals))
  // Re-sync only when the value (or the units, which change decimals) changes from outside.
  // Done during render so typing "2." is never overwritten.
  const sig = `${value}|${decimals}`
  const [seenSig, setSeenSig] = useState(sig)
  if (sig !== seenSig) {
    setSeenSig(sig)
    const p = parseNumber(text)
    if (p === null || Math.abs(p - value) >= 1e-9) setText(value.toFixed(decimals))
  }
  return (
    <label className="ss-input">
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={ariaLabel}
        data-pad-unit={suffix === 'mm' || suffix === 'in' ? suffix : ''}
        data-pad-int={decimals === 0 ? '' : undefined}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const v = parseNumber(e.target.value)
          if (v !== null) onChange(v)
        }}
        onBlur={() => setText(value.toFixed(decimals))}
      />
      {suffix && <span className="ss-input__adorn">{suffix}</span>}
    </label>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ss-field">
      <span className="ss-label">{label}</span>
      {children}
    </div>
  )
}
