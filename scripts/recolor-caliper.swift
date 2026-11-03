// Turns a dark-line-art PNG into #5a86fa strokes: darkness becomes alpha, so white
// and near-white pixels drop out, and anti-aliasing is kept.
// Usage: swift scripts/recolor-caliper.swift <in.png> <out.png>
import AppKit
let a = CommandLine.arguments
let src = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: a[1])))!.cgImage!
let w = src.width, h = src.height
var px = [UInt8](repeating: 0, count: w * h * 4)
let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))
let (tr, tg, tb) = (0x5a, 0x86, 0xfa)
for i in 0..<(w * h) {
  let o = i * 4, al = Int(px[o + 3])
  var na = 0
  if al > 0 {
    let lum = (Int(px[o]) + Int(px[o + 1]) + Int(px[o + 2])) / 3 * 255 / al  // un-premultiplied
    na = al * min(255, (255 - lum) * 3 / 2) / 255
  }
  px[o] = UInt8(tr * na / 255); px[o + 1] = UInt8(tg * na / 255); px[o + 2] = UInt8(tb * na / 255); px[o + 3] = UInt8(na)
}
try! NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
