// lexicons/ の7レコードに対応する型（手書き）。
// Lexicon と同じく技術リードだけが変える。

export const NSID = {
  sticker: 'com.kosora623.pikkles.sticker',
  binderPage: 'com.kosora623.pikkles.binder.page',
  exchange: 'com.kosora623.pikkles.exchange',
  field: 'com.kosora623.pikkles.field',
  fieldMember: 'com.kosora623.pikkles.field.member',
  fieldPlacement: 'com.kosora623.pikkles.field.placement',
  want: 'com.kosora623.pikkles.want',
} as const

/** at:// URI（例：at://did:plc:xxx/com.kosora623.pikkles.sticker/3k...） */
export type AtUri = string
export type Did = string
/** ISO 8601 の日時文字列 */
export type Datetime = string

/** com.atproto.repo.strongRef */
export interface StrongRef {
  uri: AtUri
  cid: string
}

/** PDS に保存された blob の JSON 表現 */
export interface BlobRef {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

/**
 * 配置の数値。Lexicon に小数は無いので整数で持つ。
 * - x, y: 中心の位置。幅・高さを 10000 とした値。はみ出しを許して -2000〜12000
 * - scale: 1000 で等倍。100〜5000（0.1倍〜5倍）
 * - rotation: 度（時計回り）。-180〜180
 * - z: 重なり順。0 以上、大きいほど上
 */
export const PLACEMENT_LIMITS = {
  position: { min: -2000, max: 12000, full: 10000 },
  scale: { min: 100, max: 5000, unit: 1000 },
  rotation: { min: -180, max: 180 },
} as const

export interface Placement {
  sticker: StrongRef
  x: number
  y: number
  scale: number
  rotation: number
  z: number
}

/** com.kosora623.pikkles.sticker（rkey: TID） */
export interface Sticker {
  $type: typeof NSID.sticker
  /** 切り抜き済み透過PNG。最大 1MB（/cutout で長辺 1024px に縮めてある） */
  image: BlobRef
  width: number
  height: number
  source: 'photo' | 'illustration'
  /** 任意、最大100文字。ピクルス名（以前は一言） */
  caption?: string
  /** 撮影日時（イラストは保存日時） */
  createdAt: Datetime
}

/** com.kosora623.pikkles.binder.page（rkey: ページ番号） */
export interface BinderPage {
  $type: typeof NSID.binderPage
  placements: Placement[]
  updatedAt: Datetime
}

/** com.kosora623.pikkles.exchange（2人がそれぞれ自分の PDS に書く） */
export interface Exchange {
  $type: typeof NSID.exchange
  sessionId: string
  /** 任意、最大50文字。交換した場面（手入力。位置情報ではない） */
  occasion?: string
  /** 任意、最大100文字。この交換で相手に渡す一言。渡す側が自分の記録に書く */
  message?: string
  partner: Did
  /** 自分が渡したステッカー */
  gave: StrongRef
  /** 受け取ったステッカー */
  received: StrongRef
  createdAt: Datetime
}

/** com.kosora623.pikkles.field（作った人の PDS） */
export interface Field {
  $type: typeof NSID.field
  title: string
  createdAt: Datetime
}

/** com.kosora623.pikkles.field.member（参加者の PDS） */
export interface FieldMember {
  $type: typeof NSID.fieldMember
  field: StrongRef
  createdAt: Datetime
}

/** com.kosora623.pikkles.field.placement（貼った人の PDS。自分のステッカーと、成立した交換で受け取ったステッカー） */
export interface FieldPlacement extends Placement {
  $type: typeof NSID.fieldPlacement
  field: StrongRef
  createdAt: Datetime
}

/** com.kosora623.pikkles.want */
export interface Want {
  $type: typeof NSID.want
  subject: StrongRef
  createdAt: Datetime
}
