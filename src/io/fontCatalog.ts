// Studio's font library: the same 69 typefaces, categories, styles and display sizes
// that Shaper Studio offers in its text properties. Files live in public/fonts/studio.

export type FontCategory = 'Sans-Serif' | 'Serif' | 'Non-Latin' | 'Handwriting' | 'Single Line' | 'Novelty' | 'Script' | 'Forma'

export interface FontStyleDef {
  /** Label in the style list: Regular, Bold, Black, Heavy. */
  displayStyle: string
  /** CSS font-family the style is registered under. */
  fontFamily: string
  /** File inside public/fonts/studio. */
  file: string
  /** Single-line fonts are engraving strokes: their paths stay open. */
  singleLine?: boolean
  /** Fetched from here instead of public/fonts/studio (too large to bundle). */
  remoteUrl?: string
}

export interface FontDef {
  fontDisplayName: string
  fontCategories: FontCategory[]
  fontStyles: FontStyleDef[]
  /** Pixel size of the name in the font menu (default 16). */
  fontDisplaySizeOverride?: number
}

/** Filter chips at the top of the font menu, in Studio's order. */
export const FONT_FILTERS: { category: FontCategory; label: string }[] = [
  { category: 'Single Line', label: 'single-line' },
  { category: 'Sans-Serif', label: 'sans-serif' },
  { category: 'Serif', label: 'serif' },
  { category: 'Script', label: 'script' },
  { category: 'Handwriting', label: 'handwriting' },
  { category: 'Novelty', label: 'novelty' },
  { category: 'Non-Latin', label: 'nonlatin' },
  { category: 'Forma', label: 'forma' },
]

const SS: FontCategory = 'Sans-Serif'
const SE: FontCategory = 'Serif'
const NL: FontCategory = 'Non-Latin'
const HW: FontCategory = 'Handwriting'
const SL: FontCategory = 'Single Line'
const NV: FontCategory = 'Novelty'
const SC: FontCategory = 'Script'
const FO: FontCategory = 'Forma'

const CJK = 'https://raw.githubusercontent.com/google/fonts/main/ofl'
const remote = (fontFamily: string, file: string, dir: string): FontStyleDef => ({ displayStyle: 'Regular', fontFamily, file, remoteUrl: `${CJK}/${dir}/${encodeURIComponent(file)}` })
const reg = (fontFamily: string, file: string, singleLine = false): FontStyleDef => ({ displayStyle: 'Regular', fontFamily, file, ...(singleLine ? { singleLine } : {}) })
const sty = (displayStyle: string, fontFamily: string, file: string): FontStyleDef => ({ displayStyle, fontFamily, file })
const font = (fontDisplayName: string, fontCategories: FontCategory[], fontStyles: FontStyleDef[], fontDisplaySizeOverride?: number): FontDef => ({
  fontDisplayName,
  fontCategories,
  fontStyles,
  ...(fontDisplaySizeOverride ? { fontDisplaySizeOverride } : {}),
})

export const DEFAULT_FONT = 'IBM Plex Sans'
export const DEFAULT_STYLE = 'Regular'

const CATALOG: FontDef[] = [
  font('EMS Space Rocks', [SL, NV, SS], [reg('EMS SpaceRocks', 'EMSSpaceRocks.opf', true)]),
  font('Twin Sans', [SL, SS], [reg('Twin Sans', 'TwinSans.opf', true)]),
  font(DEFAULT_FONT, [SS, HW, FO], [reg('IBM Plex Sans', 'IBMPlexSans-Regular.ttf')]),
  font('Forma Studio', [FO], [reg('Forma Studio', 'FormaStudio-Regular.ttf')]),
  font('IBM Plex Sans Condensed', [FO, SS], [reg('IBM Plex Sans Condensed', 'IBMPlexSansCondensed-Regular.woff'), sty('Medium', 'IBM Plex Sans Condensed Medium', 'IBMPlexSansCondensed-Medium.woff')]),
  font('Amatic SC', [HW, NL], [reg('Amatic SC', 'AmaticSC-Regular.ttf'), sty('Bold', 'Amatic SC Bold', 'AmaticSCBold-Regular.ttf')]),
  font('Architects Daughter', [HW], [reg('Architects Daughter', 'ArchitectsDaughter-Regular.ttf')], 12),
  font('Dyer Arts and Crafts', [NV, SE], [reg('Dyer Arts and Crafts', 'Dyer_Arts_and_Crafts-Regular.ttf')]),
  font('Frank Ruhl Libre', [NL, SE], [reg('Frank Ruhl Libre', 'FrankRuhlLibre-Regular.ttf'), sty('Black', 'Frank Ruhl Libre Black', 'FrankRuhlLibre-Black.ttf')]),
  font('Relief SLF', [SS, SL], [reg('Relief SingleLine CAD', 'ReliefSingleLine-Regular.ttf', true)]),
  font('Caprasimo', [SS, NV], [reg('Caprasimo', 'Caprasimo-Regular.ttf')]),
  font('Bokor', [NL, SE], [reg('Bokor', 'Bokor-Regular.ttf')]),
  font('Pouler', [NV, HW], [reg('Pouler', 'Pouler-Regular.ttf')]),
  font('Krease Display', [NV, HW], [reg('Krease Display', 'Krease_Display-Regular.ttf')]),
  font('Dancing Script', [SC, HW], [reg('Dancing Script', 'DancingScript-Regular.ttf'), sty('Bold', 'Dancing Script Bold', 'DancingScript-Bold.otf')]),
  font('Comic Neue', [SS, NV], [reg('Comic Neue', 'ComicNeue-Regular.ttf'), sty('Bold', 'Comic Neue Bold', 'ComicNeue-Bold.ttf')]),
  font('Stick No Bills', [SS, NV], [reg('Stick No Bills', 'StickNoBills-Regular.ttf'), sty('Black', 'Stick No Bills ExtraBold', 'StickNoBills-ExtraBold.ttf')]),
  font('Caveat', [HW], [reg('Caveat', 'Caveat-Regular.ttf'), sty('Bold', 'Caveat Bold', 'CaveatBold-Regular.ttf')]),
  font('Knewave', [HW, NV], [reg('Knewave', 'Knewave-Regular.ttf')]),
  font('Komika Title', [NV], [reg('Komika Title', 'KomikaTitle.ttf')]),
  font('Meow Script', [HW, SC], [reg('Meow Script', 'MeowScript-Regular.ttf')]),
  font('Sacramento', [HW], [reg('Sacramento', 'Sacramento-Regular.ttf')]),
  font('Vibur', [HW, SC], [reg('Vibur', 'Vibur-Regular.ttf')]),
  font('Bungee', [NV, SS], [reg('Bungee', 'Bungee-Regular.ttf')]),
  font('Creepster', [NV], [reg('Creepster', 'Creepster-Regular.ttf')]),
  font('Germania One', [NV], [reg('Germania One', 'GermaniaOne-Regular.ttf')]),
  font('Limelight', [NV], [reg('Limelight', 'Limelight-Regular.ttf')]),
  font('Megrim', [NV, SS], [reg('Megrim', 'Megrim-Regular.ttf')]),
  font('Oi', [NV], [reg('Oi', 'Oi-Regular.ttf')]),
  font('Plaster', [NV], [reg('Plaster', 'Plaster-Regular.ttf')]),
  font('Sancreek', [NV], [reg('Sancreek', 'Sancreek-Regular.ttf')]),
  font('Shrikhand', [NV, SE], [reg('Shrikhand', 'Shrikhand-Regular.ttf')]),
  font('Uncial Antiqua', [NV, SE], [reg('Uncial Antiqua', 'UncialAntiqua-Regular.ttf')], 12),
  font('Bebas Neue', [SS], [reg('Bebas Neue', 'BebasNeue-Regular.ttf')]),
  font('Inter', [SS], [reg('Inter', 'Inter-Regular.ttf'), sty('Black', 'Inter Black', 'Inter-Black.ttf')]),
  font('Jost', [SS], [reg('Jost', 'Jost-Regular.ttf'), sty('Black', 'Jost Black', 'Jost-Black.ttf')]),
  font('Jura', [SS], [reg('Jura', 'Jura-Regular.ttf'), sty('Bold', 'Jura Bold', 'JuraBold-Regular.ttf')]),
  font('National Park', [SS], [reg('National Park', 'NationalPark-Regular.otf'), sty('Heavy', 'National Park Heavy', 'NationalParkHeavy-Regular.ttf')]),
  font('Nova Cut', [SS, NV], [reg('Nova Cut', 'NovaCut-Regular.ttf')]),
  font('Quicksand', [SS], [reg('Quicksand', 'Quicksand-Regular.ttf'), sty('Bold', 'Quicksand Bold', 'QuicksandBold-Regular.ttf')]),
  font('Space Mono', [SS], [reg('Space Mono', 'SpaceMono-Regular.ttf'), sty('Bold', 'Space Mono Bold', 'SpaceMonoBold-Regular.ttf')]),
  font('Swell Braille', [NL, SS], [reg('Swell Braille', 'Swell-Braille.ttf')], 14),
  font('Berkshire Swash', [SC], [reg('Berkshire Swash', 'BerkshireSwash-Regular.ttf')]),
  font('Birthstone', [SC], [reg('Birthstone', 'Birthstone-Regular.ttf')]),
  font('Grand Hotel', [SC], [reg('Grand Hotel', 'GrandHotel-Regular.ttf')]),
  font('Great Vibes', [SC, HW], [reg('Great Vibes', 'GreatVibes-Regular.ttf')]),
  font('Lobster Two', [SC], [reg('Lobster Two', 'LobsterTwo-Regular.ttf'), sty('Bold', 'Lobster Two Bold', 'LobsterTwoBold-Regular.ttf')]),
  font('Pacifico', [HW, SC], [reg('Pacifico', 'Pacifico-Regular.ttf')]),
  font('Petit Formal Script', [SC], [reg('Petit Formal Script', 'PetitFormalScript-Regular.ttf')], 12),
  font('Abril Fatface', [SE], [reg('Abril Fatface', 'AbrilFatface-Regular.ttf')]),
  font('Alegreya', [SE], [reg('Alegreya', 'Alegreya-Regular.ttf'), sty('Black', 'Alegreya Black', 'Alegreya-Black.ttf')]),
  font('Cinzel', [SE, NV], [reg('Cinzel', 'Cinzel-Regular.ttf'), sty('Black', 'Cinzel Black', 'Cinzel-Black.ttf')]),
  font('Graduate', [SE, NV], [reg('Graduate', 'Graduate-Regular.ttf')]),
  font('Playfair Display', [SE], [reg('Playfair Display', 'PlayfairDisplay-Regular.ttf'), sty('Black', 'Playfair Display Black', 'PlayfairDisplay-Black.ttf')]),
  font('Yeseva One', [SE], [reg('Yeseva One', 'YesevaOne-Regular.ttf')]),
  font('Big Tomato SLF', [SL, HW, SC], [reg('Big Tomato SLF', 'BigTomatoSLF.opf', true)], 12),
  font('Little Chic SLF', [SL, SC], [reg('Little Chic Single Line', 'LittleChicSLF-Regular.opf', true)], 12),
  font('Grand Teton SLF', [SL, SS], [reg('Grand Teton SLF', 'GrandTetonSLF.opf', true)], 12),
  font('Origin SLF', [SL, SS], [reg('Origin SLF', 'OriginSLF.opf', true)]),
  font('Noto Sans', [NL, SS], [reg('Noto Sans', 'NotoSans-VariableFont_wdth_wght.ttf')]),
  font('Noto Sans KR   한국인', [NL, SS], [remote('Noto Sans KR Thin', 'NotoSansKR[wght].ttf', 'notosanskr')], 12),
  font('Noto Sans SC  中国人', [NL, SS], [remote('Noto Sans SC Thin', 'NotoSansSC[wght].ttf', 'notosanssc')], 12),
  font('Noto Sans JP  日本語', [NL, SS], [remote('Noto Sans JP Thin', 'NotoSansJP[wght].ttf', 'notosansjp')], 12),
  font('Noto Sans Thai', [NL, SS], [reg('Noto Sans Thai', 'NotoSansThai-VariableFont_wdth_wght.ttf')]),
  font('Noto Sans AR   العربية', [NL, SS], [reg('Noto Sans Arabic', 'NotoSansArabic-VariableFont_wdth_wght.ttf')], 12),
  font('Noto Sans HE   עִברִית', [NL, SS], [reg('Noto Sans Hebrew', 'NotoSansHebrew-VariableFont_wdth_wght.ttf')], 12),
  font('Dongle 한국인', [NL, NV], [reg('Dongle', 'Dongle-Regular.ttf')], 20),
  font('Cherry Bomb One にっぽん', [NL, NV], [reg('Cherry Bomb One', 'CherryBombOne-Regular.ttf')], 12),
  font('Rozha One  देवनागरी', [NL, SE], [reg('Rozha One', 'RozhaOne-Regular.ttf')], 12),
  font('Chonburi แบบไทย', [NL, SE], [reg('Chonburi', 'Chonburi-Regular.ttf')], 12),
  font('Birthstone Bounce', [SC, HW, NV], [reg('Birthstone Bounce', 'BirthstoneBounce-Regular.ttf')]),
]

/** Studio lists fonts alphabetically by display name. */
export const FONTS: FontDef[] = [...CATALOG].sort((a, b) => (a.fontDisplayName > b.fontDisplayName ? 1 : -1))

export const findFont = (name: string): FontDef | undefined => CATALOG.find((f) => f.fontDisplayName === name)

/** The named style, or the font's first (Regular) style. */
export const findStyle = (def: FontDef, displayStyle?: string): FontStyleDef => def.fontStyles.find((s) => s.displayStyle === displayStyle) ?? def.fontStyles[0]

export const fontUrl = (style: FontStyleDef) => style.remoteUrl ?? `${import.meta.env.BASE_URL}fonts/studio/${encodeURIComponent(style.file)}`

/** The three CJK families are 10–18 MB each, fetched on demand and only when the text needs them. */
export const isHeavyFont = (def: FontDef) => /^Noto Sans (KR|SC|JP)/.test(def.fontDisplayName)
